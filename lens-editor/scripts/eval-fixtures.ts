/**
 * Score the deterministic scraper against committed fixtures. Fully offline.
 *
 * Usage:
 *   npx tsx scripts/eval-fixtures.ts [--only <slug>]
 *   npx tsx scripts/eval-fixtures.ts --snapshot          # save scores as the baseline
 *   npx tsx scripts/eval-fixtures.ts --refreeze <slug>   # gold := current output (marks reviewed:false)
 *
 * Scoring is the x/10 scheme from eval/score.ts: dialect-blind (list-marker
 * spacing, quotes, escapes, wrapping) but content/structure-strict, with the
 * frontmatter metadata block excluded on both sides. When a baseline snapshot
 * exists, per-article deltas beyond ±0.2 are flagged so progress vs regression
 * is visible at a glance.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readFixture, makeOfflineFetchText, fixtureDir } from "../server/add-article/eval/fixture-io";
import { scoreArticle, stripFrontmatter, type ArticleScore } from "../server/add-article/eval/score";
import { atlasMarkdownUrl } from "../server/add-article/eval/atlas-md-url";
import { extractArticle } from "../server/add-article/extract";
import { extractPdfSmart } from "../server/add-article/pdf";

export interface FixtureScore {
  slug: string;
  via: string;
  viaMatch: boolean;
  reviewed: boolean;
  score: ArticleScore;
  /** Back-compat for older tests: word-shingle recall/precision. */
  body: { recall: number; precision: number };
}

const SNAPSHOT = path.join(import.meta.dirname, "../server/add-article/eval/scores.snapshot.json");

export async function scoreFixture(slug: string, root?: string, emitDiffDir?: string): Promise<FixtureScore> {
  const fx = await readFixture(slug, root);
  const fetchText = fx.bodyMarkdown != null
    ? makeOfflineFetchText(atlasMarkdownUrl(fx.meta.resolved_fetch_url), fx.bodyMarkdown)
    : async (u: string) => { throw new Error(`offline: unexpected fetch ${u}`); };
  const ex = await extractArticle(fx.html, fx.meta.resolved_fetch_url, { sourceUrl: fx.meta.source_url, fetchText });

  const score = scoreArticle(ex.body, fx.expectedMd);
  const viaMatch = fx.meta.expected_via === "generic"
    ? ["defuddle", "readability"].includes(ex.via)
    : ex.via === fx.meta.expected_via;
  if (emitDiffDir) {
    const dir = path.join(emitDiffDir, slug);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "output.md"), ex.body);
    await fs.writeFile(path.join(dir, "expected.md"), stripFrontmatter(fx.expectedMd));
  }
  return {
    slug, via: ex.via, viaMatch, reviewed: fx.meta.reviewed ?? false, score,
    body: { recall: score.recall, precision: score.precision },
  };
}

/** Re-freeze a fixture's gold to the CURRENT extractor output (after a human
 *  verified the output against the live article). Marks reviewed:false so the
 *  verification is recorded explicitly by whoever checks it. */
async function refreeze(slug: string): Promise<void> {
  const fx = await readFixture(slug);
  const fetchText = fx.bodyMarkdown != null
    ? makeOfflineFetchText(atlasMarkdownUrl(fx.meta.resolved_fetch_url), fx.bodyMarkdown)
    : async (u: string) => { throw new Error(`offline: unexpected fetch ${u}`); };
  const ex = await extractArticle(fx.html, fx.meta.resolved_fetch_url, { sourceUrl: fx.meta.source_url, fetchText });
  const dir = fixtureDir(slug);
  await fs.writeFile(path.join(dir, "expected.md"), ex.body);
  const meta = { ...fx.meta, reviewed: false, refrozen_at: new Date().toISOString().slice(0, 10) };
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 1));
  console.log(`re-froze ${slug} (gold := current output; reviewed reset to false — verify against the live article, then set reviewed:true)`);
}

/**
 * PDF fixtures (eval/fixtures-pdf/<slug>/): article.pdf + a RECORDED Datalab
 * response (datalab.json), replayed offline through the real PDF path
 * (extractPdfSmart → provider parsing → placeholders → metadata). On first
 * run, gold (expected.md) is frozen from the current output — a human then
 * verifies/edits it against the PDF and sets reviewed:true in meta.json.
 */
async function scorePdfFixture(slug: string, rootPdf: string, emitDiffDir?: string): Promise<FixtureScore> {
  const dir = path.join(rootPdf, slug);
  const pdf = await fs.readFile(path.join(dir, "article.pdf"));
  const dl = await fs.readFile(path.join(dir, "datalab.json"), "utf8");
  const meta = JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8"));

  const realFetch = globalThis.fetch;
  const prevKey = process.env.DATALAB_API_KEY;
  process.env.DATALAB_API_KEY = "fixture-replay";
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("replay.local")) return new Response(dl, { status: 200 });
    if (u.includes("datalab"))
      return new Response(
        JSON.stringify({ success: true, request_check_url: "https://replay.local/poll" }),
        { status: 200 },
      );
    throw new Error(`offline: unexpected fetch ${u}`);
  }) as typeof fetch;
  let ex;
  try {
    const bytes = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer;
    ex = await extractPdfSmart(bytes, meta.source_url);
  } finally {
    globalThis.fetch = realFetch;
    if (prevKey === undefined) delete process.env.DATALAB_API_KEY; else process.env.DATALAB_API_KEY = prevKey;
  }
  if (!ex.via.startsWith("pdf-datalab")) throw new Error(`replay did not use datalab (via=${ex.via})`);

  const expectedPath = path.join(dir, "expected.md");
  let expectedMd: string;
  try {
    expectedMd = await fs.readFile(expectedPath, "utf8");
  } catch {
    await fs.writeFile(expectedPath, ex.body);
    expectedMd = ex.body;
    console.log(`  (froze initial gold for pdf fixture ${slug} — review it, then set reviewed:true)`);
  }
  const score = scoreArticle(ex.body, expectedMd);
  if (emitDiffDir) {
    const d = path.join(emitDiffDir, `pdf-${slug}`);
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(d, "output.md"), ex.body);
    await fs.writeFile(path.join(d, "expected.md"), stripFrontmatter(expectedMd));
  }
  return {
    slug: `pdf:${slug}`, via: ex.via, viaMatch: true, reviewed: meta.reviewed ?? false, score,
    body: { recall: score.recall, precision: score.precision },
  };
}

async function main() {
  const argv = process.argv;
  if (argv.includes("--refreeze")) {
    await refreeze(argv[argv.indexOf("--refreeze") + 1]);
    return;
  }
  const root = path.join(import.meta.dirname, "../server/add-article/eval/fixtures");
  const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
  const slugs = (await fs.readdir(root, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && (!only || d.name === only)).map((d) => d.name);

  let baseline: Record<string, number> = {};
  try { baseline = JSON.parse(await fs.readFile(SNAPSHOT, "utf8")); } catch { /* none yet */ }

  const scores: FixtureScore[] = [];
  const diffRoot = "/tmp/article-eval";
  for (const slug of slugs) {
    try { scores.push(await scoreFixture(slug, undefined, diffRoot)); }
    catch (err) { console.error(`✗ ${slug}: ${err}`); }
  }
  const rootPdf = path.join(import.meta.dirname, "../server/add-article/eval/fixtures-pdf");
  let pdfSlugs: string[] = [];
  try {
    pdfSlugs = (await fs.readdir(rootPdf, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && (!only || d.name === only)).map((d) => d.name);
  } catch { /* no pdf fixtures yet */ }
  for (const slug of pdfSlugs) {
    try { scores.push(await scorePdfFixture(slug, rootPdf, diffRoot)); }
    catch (err) { console.error(`✗ pdf:${slug}: ${err}`); }
  }
  scores.sort((a, b) => a.score.score10 - b.score.score10);
  let regressions = 0;
  for (const s of scores) {
    const b = baseline[s.slug];
    let delta = "";
    if (b !== undefined) {
      const d = Math.round((s.score.score10 - b) * 10) / 10;
      if (d <= -0.2) { delta = `  ▼ REGRESSION ${d} (was ${b})`; regressions++; }
      else if (d >= 0.2) delta = `  ▲ +${d}`;
    }
    const sub = `content ${s.score.content.toFixed(2)} · structure ${s.score.structure.toFixed(2)} · complete ${s.score.completeness.toFixed(2)}`;
    console.log(`${s.score.score10.toFixed(1).padStart(4)}/10  ${s.viaMatch ? "via✓" : `via✗(${s.via})`}  [${s.reviewed ? "reviewed" : "UNREVIEWED"}]  ${s.slug}  (${sub})${delta}`);
  }
  const mean = scores.reduce((a, s) => a + s.score.score10, 0) / (scores.length || 1);
  const unreviewed = scores.filter((s) => !s.reviewed).length;
  console.log(`\nMEAN ${mean.toFixed(2)}/10 over ${scores.length} fixtures · routing mismatches ${scores.filter((s) => !s.viaMatch).length} · unreviewed golds ${unreviewed}/${scores.length}${regressions ? ` · ▼ ${regressions} regression(s) vs snapshot` : ""}`);
  if (argv.includes("--snapshot")) {
    const snap = Object.fromEntries(scores.map((s) => [s.slug, s.score.score10]));
    await fs.writeFile(SNAPSHOT, JSON.stringify(snap, null, 1));
    console.log(`snapshot saved → ${SNAPSHOT} (commit it; future runs flag ±0.2 moves)`);
  }
  if (unreviewed) {
    console.log(`\n⚠ ${unreviewed} gold(s) unreviewed — a low score there may mean the GOLD is wrong (hand-curated), not the scraper. Diff ${diffRoot}/<slug>/, and when OUR output is the faithful one run: npx tsx scripts/eval-fixtures.ts --refreeze <slug>`);
  }
}
if (process.argv[1]?.endsWith("eval-fixtures.ts")) main();
