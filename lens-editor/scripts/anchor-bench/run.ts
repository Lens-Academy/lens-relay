/**
 * Anchor benchmark for HTML-page comments.
 *
 *   npx tsx scripts/anchor-bench/run.ts <dir with .html pages> [--json out.json]
 *
 * For each page: writes invisible ground-truth markers into the source (text
 * runs, including text inside htm/JS strings) and data-bench-id attributes on
 * images/SVGs/canvases/buttons, renders it in Chromium with the editor's page
 * runtime (import map, CSP), comments on every marker (a click, a short and a
 * long selection), then renders edited versions of the source and checks
 * where each comment resolves. Needs network access for the pages' CDN
 * imports.
 *
 * Outcomes per comment and scenario:
 *   correct         anchored at the right text
 *   flagged         guessed (shown as "Moved? Check the spot") at the right text
 *   flagged-wrong   guessed at the wrong text (shown as needing a check)
 *   WRONG           anchored at the wrong text: the dangerous case
 *   orphaned        not found (right when the text was deleted)
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Page } from 'playwright';
import { buildSrcDoc } from '../../src/components/HtmlEditor/runtime/page-runtime';
import type { Created, Outcome } from './in-page';

const here = dirname(fileURLToPath(import.meta.url));

type Bench = {
  createTextAnchors(): Created[];
  createPins(): Created[];
  resolveAll(created: Created[]): Outcome[];
};
declare global {
  interface Window { LensBench: Bench }
}

const ZWJ = '‍';
function marker(id: number): string {
  return ZWJ + id.toString(2).padStart(6, '0').replace(/0/g, '​').replace(/1/g, '‌') + ZWJ;
}
const MARKER_RE = /‍[​‌]{6}‍/g;

interface Target { id: number; at: number; runStart: number; runEnd: number }

/** Ranges of the source that are never page text: <style>, comments, tags' attributes. */
function blockedRanges(source: string, skipScripts: boolean): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const res = [/<style\b[\s\S]*?<\/style>/gi, /<!--[\s\S]*?-->/g, /<head\b[\s\S]*?<\/head>/gi];
  if (skipScripts) res.push(/<script\b[\s\S]*?<\/script>/gi);
  for (const re of res) {
    for (const m of source.matchAll(re)) out.push([m.index!, m.index! + m[0].length]);
  }
  return out;
}

/** Pick text runs spread over the source and put a marker a few words in. */
function placeMarkers(source: string, max: number, skipScripts = false): { source: string; targets: Target[] } {
  const blocked = blockedRanges(source, skipScripts);
  const inBlocked = (i: number) => blocked.some(([a, b]) => i >= a && i < b);
  const runs: Array<{ start: number; end: number }> = [];
  for (const m of source.matchAll(/[A-Za-z][A-Za-z0-9 ,.'’;:()%–—-]{40,}/g)) {
    const start = m.index!;
    // Page text follows a tag or opens a string; code rarely does.
    const before = source.slice(Math.max(0, start - 1), start);
    if (!/[>"'`\s]/.test(before) || inBlocked(start)) continue;
    if (/[=;{}]/.test(m[0]) || !/\s\S+\s\S+\s/.test(m[0])) continue;
    runs.push({ start, end: start + m[0].length });
  }
  const step = Math.max(1, runs.length / max);
  const picked = Array.from({ length: Math.min(max, runs.length) }, (_, i) => runs[Math.floor(i * step)]);
  const targets: Target[] = [];
  picked.forEach((run, i) => {
    // A word boundary two or three words into the run.
    const text = source.slice(run.start, run.end);
    let at = run.start;
    let spaces = 0;
    for (let k = 0; k < text.length; k++) {
      if (text[k] === ' ' && ++spaces === 2 + (i % 2)) { at = run.start + k + 1; break; }
    }
    targets.push({ id: i + 1, at, runStart: run.start, runEnd: run.end });
  });
  let out = source;
  for (const t of [...targets].sort((a, b) => b.at - a.at)) out = out.slice(0, t.at) + marker(t.id) + out.slice(t.at);
  // Re-derive positions in the marked source.
  const shifted = targets.map(t => {
    const m = marker(t.id);
    const at = out.indexOf(m) + m.length;
    const before = targets.filter(o => o.at < t.at).length * 8;
    return { ...t, at, runStart: t.runStart + before, runEnd: t.runEnd + before + 8 };
  });
  return { source: out, targets: shifted };
}

function markPins(source: string, first: number): string {
  let id = first;
  return source.replace(/<(img|svg|canvas|button)\b(?![^>]*data-bench-id)/gi, (m, tag: string) => (
    id < first + 6 ? `<${tag} data-bench-id="${id++}"` : m
  ));
}

// ---- scenarios -------------------------------------------------------------

const ADDED_SECTION = '<section style="padding:12px"><h2>A newly added section</h2><p>This paragraph was added above the rest of the page. '
  + 'It contains several sentences of fresh prose so that every later piece of text moves down and shifts its offset.</p>'
  + '<p>A second new paragraph, with a list:</p><ul><li>First new point</li><li>Second new point</li></ul></section>';

function insertAfterBodyOpen(source: string, html: string): string {
  const m = /<body\b[^>]*>/i.exec(source);
  return m ? source.slice(0, m.index + m[0].length) + html + source.slice(m.index + m[0].length) : html + source;
}

function insertAbove(source: string): string {
  return insertAfterBodyOpen(source, ADDED_SECTION);
}

function restyle(source: string): string {
  const css = '<style>body{font-size:19px !important;line-height:1.9 !important}.bench-wrap{max-width:560px;margin:0 auto;padding:0 12px}</style>';
  let out = source.replace(/<\/head>/i, `${css}</head>`);
  const open = /<body\b[^>]*>/i.exec(out);
  if (open) {
    out = out.slice(0, open.index + open[0].length) + '<div class="bench-wrap"><div>' + out.slice(open.index + open[0].length);
    out = out.replace(/<\/body>/i, '</div></div></body>');
  }
  return out;
}

/** Swap the first and last top-level <section> (or <p>) of the static body. */
function reorder(source: string): string | null {
  for (const tag of ['section', 'article', 'p']) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi');
    const bodyStart = /<body\b[^>]*>/i.exec(source)?.index ?? 0;
    const scriptRanges = Array.from(source.matchAll(/<script\b[\s\S]*?<\/script>/gi), m => [m.index!, m.index! + m[0].length]);
    const blocks = Array.from(source.matchAll(re)).filter(m => m.index! > bodyStart
      && !scriptRanges.some(([a, b]) => m.index! >= a && m.index! < b)
      && !new RegExp(`<${tag}\\b`, 'i').test(m[0].slice(1)));
    if (blocks.length < 2) continue;
    const a = blocks[0];
    const b = blocks[blocks.length - 1];
    return source.slice(0, a.index!) + b[0] + source.slice(a.index! + a[0].length, b.index!) + a[0] + source.slice(b.index! + b[0].length);
  }
  return null;
}

/** Transpose two letters in the word after the marker. */
function typo(source: string, t: Target): string {
  const m = /[a-z]{4,}/.exec(source.slice(t.at, t.runEnd));
  if (!m) return source;
  const i = t.at + m.index + 1;
  return source.slice(0, i) + source[i + 1] + source[i] + source.slice(i + 2);
}

const FILLER = ['quartz', 'meadow', 'lantern', 'harbor', 'violet', 'engine', 'ribbon', 'summit'];
/** Rewrite most of the run's words after the marker (the marker stays). */
function reword(source: string, t: Target): string {
  let k = 0;
  const run = source.slice(t.at, t.runEnd).replace(/[A-Za-z]{3,}/g, w => (k++ % 3 === 2 ? w : FILLER[k % FILLER.length]));
  return source.slice(0, t.at) + run + source.slice(t.runEnd);
}

/** Delete the run's text around the marker. */
function remove(source: string, t: Target): string {
  const m = source.slice(t.runStart, t.runEnd).match(MARKER_RE);
  return source.slice(0, t.runStart) + (m ? m[0] : '') + source.slice(t.runEnd);
}

/** Add a verbatim copy of the run near the top of the page. */
function duplicate(source: string, t: Target): string {
  const copy = source.slice(t.runStart, t.runEnd).replace(MARKER_RE, '');
  return insertAfterBodyOpen(source, `<p>${copy}</p>`);
}

// ---- running ---------------------------------------------------------------

async function render(page: Page, source: string, bundle: string, width = 1100): Promise<string[]> {
  const errors: string[] = [];
  const onError = (e: Error) => errors.push(e.message);
  page.on('pageerror', onError);
  await page.setViewportSize({ width, height: 900 });
  await page.setContent(buildSrcDoc(source, { bridgeSource: '' }), { waitUntil: 'load', timeout: 20_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(900);
  await page.addScriptTag({ content: bundle });
  page.off('pageerror', onError);
  return errors;
}

type Category = 'correct' | 'flagged' | 'flagged-wrong' | 'WRONG' | 'orphaned';

function categorize(o: Outcome, textGone: boolean): Category {
  if (o.state === 'orphaned') return 'orphaned';
  if (textGone) return o.state === 'anchored' ? 'WRONG' : 'flagged-wrong';
  if (o.correct) return o.state === 'anchored' ? 'correct' : 'flagged';
  return o.state === 'anchored' ? 'WRONG' : 'flagged-wrong';
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
  const files = readdirSync(dir).filter(f => f.endsWith('.html')).sort();
  const bundle = (await build({
    entryPoints: [resolve(here, 'in-page.ts')],
    bundle: true, write: false, format: 'iife', globalName: 'LensBench', platform: 'browser', target: 'es2022',
  })).outputFiles[0].text;

  const browser = await chromium.launch();
  const context = await browser.newContext({ bypassCSP: true });
  const page = await context.newPage();
  const tally = new Map<string, Record<Category, number>>();
  const rows: Array<Record<string, unknown>> = [];
  const add = (scenario: string, kind: string, category: Category, file: string, id: number) => {
    const key = `${scenario}`;
    const t = tally.get(key) ?? { correct: 0, flagged: 0, 'flagged-wrong': 0, WRONG: 0, orphaned: 0 };
    t[category]++;
    tally.set(key, t);
    rows.push({ file, scenario, kind, id, category });
  };

  for (const file of files) {
    const clean = readFileSync(join(dir, file), 'utf8')
      .replace(/\[\[@comment:[^\]\s]+\]\]/g, '')
      .replace(/<!--lens-(?:comment|reply) [\s\S]*?-->/g, '');
    const baseErrors = await render(page, clean, bundle);
    let { source, targets } = placeMarkers(clean, 18);
    const markedErrors = await render(page, source, bundle);
    if (markedErrors.length > baseErrors.length) {
      // A marker landed in script code: keep to static text.
      console.log(`${file}: markers broke a script (${markedErrors[0]}); using static text only`);
      ({ source, targets } = placeMarkers(clean, 18, true));
    }
    source = markPins(source, 40);
    await render(page, source, bundle);
    const created = await page.evaluate(() => [...window.LensBench.createTextAnchors(), ...window.LensBench.createPins()]);
    const liveTargets = targets.filter(t => created.some(c => c.id === t.id));
    console.log(`${file}: ${created.filter(c => c.kind !== 'pin').length} text comments, ${created.filter(c => c.kind === 'pin').length} pins`);
    if (created.length === 0) continue;

    const measure = async (scenario: string, edited: string | null, opts: { width?: number; only?: Set<number>; gone?: Set<number> } = {}) => {
      if (edited === null) return;
      await render(page, edited, bundle, opts.width);
      const outcomes = await page.evaluate(c => window.LensBench.resolveAll(c), created);
      for (const o of outcomes) {
        if (opts.only && !opts.only.has(o.id)) {
          add(`${scenario} (others)`, o.kind, categorize(o, false), file, o.id);
          continue;
        }
        const category = categorize(o, opts.gone?.has(o.id) ?? false);
        add(scenario, o.kind, category, file, o.id);
        if ((category === 'WRONG' || (category === 'flagged-wrong' && !opts.gone?.has(o.id))) && process.env.BENCH_VERBOSE) {
          console.log(`  ${category} [${scenario}] ${o.kind} quote=${JSON.stringify(o.quote)}\n    found=${JSON.stringify(o.found)}\n    truth=${JSON.stringify(o.truth)}`);
        }
      }
    };

    await measure('unchanged', source);
    await measure('section added above', insertAbove(source));
    await measure('restyled + wrapped', restyle(source));
    await measure('phone width', source, { width: 390 });
    await measure('sections reordered', reorder(source));
    for (let r = 0; r < 3; r++) {
      const group = liveTargets.filter((_, i) => i % 3 === r);
      const only = new Set(group.map(t => t.id));
      const apply = (fn: (s: string, t: Target) => string) => {
        let out = source;
        for (const t of [...group].sort((a, b) => b.at - a.at)) out = fn(out, t);
        return out;
      };
      await measure('typo in the quote', apply(typo), { only });
      await measure('quote reworded', apply(reword), { only });
      await measure('quote deleted', apply(remove), { only, gone: only });
      await measure('quote duplicated elsewhere', apply(duplicate), { only });
    }
    await measure('heavy revision (added + restyled + reordered)', restyle(insertAbove(reorder(source) ?? source)));
  }
  await browser.close();

  const cats: Category[] = ['correct', 'flagged', 'flagged-wrong', 'WRONG', 'orphaned'];
  console.log(`\n${'scenario'.padEnd(46)}${cats.map(c => c.padStart(14)).join('')}`);
  for (const [scenario, t] of tally) {
    const total = cats.reduce((n, c) => n + t[c], 0);
    console.log(`${scenario.padEnd(46)}${cats.map(c => `${t[c]} (${Math.round((100 * t[c]) / total)}%)`.padStart(14)).join('')}`);
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
