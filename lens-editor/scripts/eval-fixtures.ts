/**
 * Score the deterministic scraper against committed fixtures. Fully offline.
 * Usage: npx tsx scripts/eval-fixtures.ts [--only <slug>]
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readFixture, makeOfflineFetchText, fixtureDir } from "../server/add-article/eval/fixture-io";
import { scoreBody, structureCounts } from "../server/add-article/eval/score";
import { atlasMarkdownUrl } from "../server/add-article/eval/atlas-md-url";
import { extractArticle } from "../server/add-article/extract";

export interface FixtureScore {
  slug: string;
  via: string;
  viaMatch: boolean;
  reviewed: boolean;
  body: { recall: number; precision: number; jaccard: number };
  structureDelta: Record<string, number>;
}

export async function scoreFixture(slug: string, root?: string, emitDiffDir?: string): Promise<FixtureScore> {
  const fx = await readFixture(slug, root);
  const fetchText = fx.bodyMarkdown != null
    ? makeOfflineFetchText(atlasMarkdownUrl(fx.meta.resolved_fetch_url), fx.bodyMarkdown)
    : async (u: string) => { throw new Error(`offline: unexpected fetch ${u}`); };
  const ex = await extractArticle(fx.html, fx.meta.resolved_fetch_url, { sourceUrl: fx.meta.source_url, fetchText });

  const body = scoreBody(ex.body, fx.expectedMd);
  const og = structureCounts(ex.body), gd = structureCounts(fx.expectedMd);
  const structureDelta: Record<string, number> = {};
  for (const k of Object.keys(og) as (keyof typeof og)[]) structureDelta[k] = og[k] - gd[k];
  const viaMatch = fx.meta.expected_via === "generic"
    ? ["defuddle", "readability"].includes(ex.via)
    : ex.via === fx.meta.expected_via;
  // Emit gold + output side-by-side so a human can diff and decide which is
  // right (the review workflow); skipped when emitDiffDir is unset (e2e test).
  if (emitDiffDir) {
    const dir = path.join(emitDiffDir, slug);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "output.md"), ex.body);
    await fs.writeFile(path.join(dir, "expected.md"), fx.expectedMd);
  }
  return { slug, via: ex.via, viaMatch, reviewed: fx.meta.reviewed ?? false, body, structureDelta };
}

async function main() {
  const root = path.join(import.meta.dirname, "../server/add-article/eval/fixtures");
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
  const slugs = (await fs.readdir(root, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && (!only || d.name === only)).map((d) => d.name);
  const scores: FixtureScore[] = [];
  const diffRoot = "/tmp/article-eval";
  for (const slug of slugs) {
    try { scores.push(await scoreFixture(slug, undefined, diffRoot)); }
    catch (err) { console.error(`✗ ${slug}: ${err}`); }
  }
  scores.sort((a, b) => a.body.recall - b.body.recall);
  for (const s of scores) {
    const tag = s.reviewed ? "reviewed" : "UNREVIEWED";
    console.log(`${s.body.recall.toFixed(2)} recall ${s.body.precision.toFixed(2)} prec  ${s.viaMatch ? "via✓" : `via✗(${s.via})`}  [${tag}]  ${s.slug}`);
  }
  const mean = (f: (s: FixtureScore) => number) => scores.reduce((a, s) => a + f(s), 0) / (scores.length || 1);
  const unreviewed = scores.filter((s) => !s.reviewed);
  console.log(`\nmean recall ${mean((s) => s.body.recall).toFixed(3)}  mean precision ${mean((s) => s.body.precision).toFixed(3)}  routing mismatches ${scores.filter((s) => !s.viaMatch).length}  unreviewed ${unreviewed.length}/${scores.length}`);
  if (unreviewed.length) {
    console.log(`\n⚠ ${unreviewed.length} fixture(s) not yet manually reviewed — for these a low score may mean the GOLD is wrong, not the scraper. Diff gold vs output in ${diffRoot}/<slug>/ and set reviewed:true in meta.json (re-freeze gold first if the scraper was right).`);
  }
  void fixtureDir;
}
if (process.argv[1]?.endsWith("eval-fixtures.ts")) main();
