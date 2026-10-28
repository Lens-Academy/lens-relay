// The jev check workbench from a terminal: the same runs, over the same sample, as the panel
// above a Lens Edu/Checks/*.md file (JevCheckPanel.tsx), and the same writes to the file.
//
//   npx tsx scripts/jev.ts list
//   npx tsx scripts/jev.ts run T2 [--live] [--n 300] [--top 15] [--json out.json]
//                                  [--context lens] [--fail-at 0.4 --pass-below 0.3]
//                                  [--true 'yes means...' --false 'no means...']
//     (these try another presentation, thresholds or criteria without writing the file)
//   npx tsx scripts/jev.ts set T7 fail_at 0.3   a draft field, as when edited in the panel
//   npx tsx scripts/jev.ts draft T6 [--context lens] [--true ...] [--false ...]   write those as the draft
//   npx tsx scripts/jev.ts fix T2 'advice'   the live check's fix, the advice agents are shown
//   npx tsx scripts/jev.ts save T2      the draft becomes the live check (the panel's Save)
//   npx tsx scripts/jev.ts discard T2   the draft is dropped (the panel's Discard)
//   npx tsx scripts/jev.ts enable T2    the live check runs on agents' edits (the panel's Enable)
//
// The editor server's /api/jev routes run in this process (server/jev/routes.ts), so a run
// shares the server's answer cache and asks the platform to build its calls. Environment:
// JEV_API_KEY, LENS_PLATFORM_URL and ADHOC_VALIDATION_SECRET as for the server;
// RELAY_URL and RELAY_SERVER_TOKEN to read and write the check files; JEV_ACTOR, the
// author the relay records for a write (default "ai:opus-5.5:unknown").
import { Hono } from 'hono';
import { readdirSync, writeFileSync } from 'node:fs';
import { createJevRoutes, loadJevConfig } from '../server/jev/routes';
import { signShareToken } from '../server/share-token';
import { EDU_FOLDER } from '../server/edit-share-auth';
import { editRelayDoc, readRelayDocAtPath, resolveRelayDocIdByPath } from '../server/add-video/relay-docs';
import { bandOf, discardDraft, parseCheckFile, platformProblems, readView, saveDraft, setCheckFields, setDraftField, setDraftPresentation, shares, wobbles } from '../src/lib/jev-check';
import { fetchCorpus, poolOf } from '../src/lib/jev-corpus';
import { askCheck } from '../src/lib/jev-run';
import { DEFAULT_PRESENTATION, describe, parsePresentation } from '../src/lib/jev-presentation';
import { registerClientMapping } from '../src/lib/provenance';
import { writeText } from '../src/lib/ytext';

const CHECKS = 'Lens Edu/Checks';
const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1]; };

const app = new Hono().route('/api/jev', createJevRoutes(loadJevConfig()));
const token = signShareToken({ purpose: 'share', role: 'edit', folder: EDU_FOLDER, expiry: Math.floor(Date.now() / 1000) + 3600 });
async function call(url: string, init: RequestInit = {}) {
  const res = await app.request(url, { ...init, headers: { 'Content-Type': 'application/json', 'X-Share-Token': token } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}
const get = (url: string) => call(url);
const post = (url: string, body: unknown) => call(url, { method: 'POST', body: JSON.stringify(body) });

/** The check files' paths, from a checkout of the Lens Edu folder (JEV_FILES_DIR), whose
 *  texts are then read from the relay, which is always current. */
function checkPaths(): string[] {
  const dir = process.env.JEV_FILES_DIR;
  if (!dir) throw new Error('set JEV_FILES_DIR to a checkout of lens-edu-staging, to list Checks/');
  return readdirSync(`${dir}/Checks`).filter((f) => f.endsWith('.md')).map((f) => `${CHECKS}/${f}`);
}
async function checkFile(id: string): Promise<{ path: string; text: string }> {
  for (const path of checkPaths().filter((p) => p.split('/').pop()!.startsWith(`${id} `))) {
    const text = await readRelayDocAtPath(path);
    if (text !== null) return { path, text };
  }
  throw new Error(`no check file for ${id} in ${CHECKS}`);
}

/** Change a check file in the relay as the panel would, recorded as written by JEV_ACTOR. */
async function write(path: string, change: (text: string) => string) {
  // As the panel's Save does, refuse a change that gives the check a problem it did not have
  // (one already there, such as a placeholder the change is drafting a fix for, does not stop it).
  const now = (await readRelayDocAtPath(path))!;
  const had = new Set(platformProblems(now));
  const next = change(now);
  const problems = platformProblems(next).filter((p) => !had.has(p));
  // And the editor must still read it, or the workbench cannot open the file (2026-10-28: a
  // draft holding `fix`, which the platform ignores, made four check files unreadable there).
  try { parseCheckFile(next); } catch (e) { problems.push(`the workbench could not read it: ${(e as Error).message}`); }
  if (problems.length) throw new Error(`not written: ${problems.join('; ')}`);
  const id = await resolveRelayDocIdByPath(path);
  if (!id) throw new Error(`${path} is not in the relay`);
  const actor = process.env.JEV_ACTOR || 'ai:opus-5.5:unknown';
  const sent = await editRelayDoc(id, (doc) => {
    // Decided on the text as it is now: an unchanged file gets no update and no author entry.
    const text = doc.getText('contents');
    if (change(text.toString()) === text.toString()) return false;
    registerClientMapping(doc, actor, Date.now());
    writeText(text, change);
  });
  const after = (await readRelayDocAtPath(path))!;
  console.log(sent ? `wrote ${path} as ${actor}` : `${path}: nothing to change`);
  const left = platformProblems(after);
  if (left.length) console.log(`  ${path} still has: ${left.join('; ')}`);
  return after;
}

async function list() {
  for (const path of checkPaths()) {
    const text = await readRelayDocAtPath(path);
    if (text === null) continue;
    try {
      const { live, draft } = parseCheckFile(text);
      console.log(`${live.id}\t${live.enabled ? 'live' : 'off '}\t${draft ? 'draft' : '     '}\t${describe(live.presentation ?? DEFAULT_PRESENTATION)}\t${path.split('/').pop()}`);
    } catch (e) { console.log(`??\tunreadable: ${(e as Error).message}\t${path}`); }
  }
}

async function run(id: string) {
  const { text } = await checkFile(id);
  const { live, draft } = parseCheckFile(text);
  let check = args.includes('--live') || !draft ? live : draft;
  const view = readView(text);
  const n = Number(flag('n') ?? view.sample ?? 200);
  const top = Number(flag('top') ?? 15);
  const { meta, corpus } = await fetchCorpus(get);
  const sample = (poolOf(corpus, meta, view.courses, view.kinds) ?? []).slice(0, n);
  const ctx = flag('context');
  const base = check.presentation ?? DEFAULT_PRESENTATION;
  const pres = ctx ? parsePresentation({ context: ctx, question: base.question, nest: base.nest }) : base;
  for (const [k, key] of [['fail-at', 'fail_at'], ['pass-below', 'pass_below']] as const) if (flag(k)) check = { ...check, [key]: Number(flag(k)) };
  if (flag('true') || flag('false')) check = { ...check, criteria: { true: flag('true') ?? check.criteria?.true ?? '', false: flag('false') ?? check.criteria?.false ?? '' } };
  console.log(`${check.id} (${args.includes('--live') || !draft ? 'live' : 'draft'}${ctx ? `, context ${ctx}` : ''}): ${describe(pres)}; ${sample.length} paragraphs sampled at rev ${meta.commit}`);
  const r = await askCheck(post, check, sample, pres, meta.commit);
  const s = shares(check, r.scored.map((u) => u.p));
  const wob = r.scored.filter((u) => u.samples && wobbles(check, u.samples)).length;
  const pct = (x: number) => `${Math.round(100 * x)}%`;
  console.log(`${r.scored.length} ${pres.question}s, ${r.cached} from cache; fail ${pct(s.fail)} (p ≥ ${check.fail_at}), unsure ${pct(s.unsure)}, pass ${pct(s.pass)} (p < ${check.pass_below}); ${wob} with answers in different bands${r.tooLong ? `; ${r.tooLong} too long for jev` : ''}\n`);
  const ranked = [...r.scored].sort((a, b) => b.p - a.p);
  for (const u of ranked.slice(0, top)) {
    const spread = u.samples ? ` [${Math.min(...u.samples).toFixed(2)}–${Math.max(...u.samples).toFixed(2)}]` : '';
    console.log(`${u.p.toFixed(2)}${spread} ${bandOf(check, u.p)}  ${u.path.replace(/^Lens Edu\//, '')}:${u.line}\n    ${(u.words ?? u.text).replace(/\s+/g, ' ').slice(0, 400)}\n`);
  }
  const out = flag('json');
  if (out) writeFileSync(out, JSON.stringify({ check, presentation: pres, commit: meta.commit, shares: s, scored: ranked }, null, 1));
}

async function main() {
  const [cmd, id] = args;
  if (cmd === 'list') return list();
  if (!id) throw new Error('usage: jev.ts list | run <id> | set <id> <field> <number> | draft <id> [--context --true --false] | save <id> | enable <id>');
  if (cmd === 'run') return run(id);
  const { path, text } = await checkFile(id);
  if (cmd === 'save') {
    if (!parseCheckFile(text).draft) throw new Error(`${id} has no draft to save`);
    return void (await write(path, saveDraft));
  }
  if (cmd === 'set') {
    const [, , key, value] = args;
    if (!['fail_at', 'pass_below'].includes(key) || !Number.isFinite(Number(value))) throw new Error('usage: set <id> fail_at|pass_below <number>');
    return void (await write(path, (t) => setDraftField(t, [key], Number(value))));
  }
  if (cmd === 'draft') {
    const live = parseCheckFile(text).live;
    const ctx = flag('context');
    return void (await write(path, (t) => {
      let out = ctx ? setDraftPresentation(t, parsePresentation({ ...(live.presentation ?? DEFAULT_PRESENTATION), context: ctx })) : t;
      for (const side of ['true', 'false'] as const) if (flag(side)) out = setDraftField(out, ['criteria', side], flag(side)!);
      return out;
    }));
  }
  if (cmd === 'discard') return void (await write(path, discardDraft));
  if (cmd === 'fix') {
    const advice = args[2];
    if (!advice?.trim()) throw new Error('usage: fix <id> <advice>');
    return void (await write(path, (t) => setCheckFields(t, [{ path: ['fix'], value: advice }])));
  }
  if (cmd === 'enable') {
    // As the panel's Enable: a check goes live only with no problems at all, placeholders included.
    const problems = platformProblems(text);
    if (problems.length) throw new Error(`not enabled: ${problems.join('; ')}`);
    return void (await write(path, (t) => setCheckFields(t, [{ path: ['enabled'], value: true }])));
  }
  throw new Error(`unknown command ${cmd}`);
}

main().catch((e) => { console.error((e as Error).message); process.exit(1); });
