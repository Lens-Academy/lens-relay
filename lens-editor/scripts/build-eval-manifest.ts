/**
 * Resolve the Navigating Superintelligence course → article pool → stratified
 * manifest. Reads the course graph + article frontmatter from the local
 * lens-edu-relay checkout ($LENS_EDU_REPO). Read-only; never writes to it.
 * Usage: npx tsx scripts/build-eval-manifest.ts [--target 50]
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveCourseArticles } from "../server/add-article/eval/resolve-course";
import { readEduDoc, splitFrontmatter } from "../server/add-article/eval/edu-repo";
import { classifyVia, stratifiedSelect, type ManifestEntry } from "../server/add-article/eval/manifest";
import { adapterContext, resolveFetchUrls } from "../server/add-article/adapters";

const COURSE = "courses/Navigating Superintelligence.md";
const OUT = path.join(import.meta.dirname, "../server/add-article/eval/fixtures.manifest.json");

function slugFor(relayPath: string): string {
  return path.posix.basename(relayPath).replace(/\.md$/i, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function main() {
  const target = Number(process.argv[process.argv.indexOf("--target") + 1]) || 50;
  const { articles, report } = await resolveCourseArticles(COURSE, (p) => readEduDoc(p));
  console.log(`Resolved ${articles.length} course articles.`);
  for (const m of report.perModule) console.log(`  ${m.module}: ${m.articleCount}`);

  const entries: ManifestEntry[] = [];
  for (const relay_path of articles) {
    const { frontmatter } = splitFrontmatter(await readEduDoc(relay_path));
    const source_url = frontmatter.source_url;
    if (!source_url) { console.warn(`no source_url: ${relay_path}`); continue; }
    const via = classifyVia(source_url);
    const resolved = resolveFetchUrls(adapterContext(source_url, ""));
    entries.push({
      slug: slugFor(relay_path), relay_path, source_url,
      resolved_fetch_url: resolved[0] ?? source_url,
      host: new URL(source_url).hostname, expected_via: via,
      needs_body_markdown: via === "ai-safety-atlas", status: "ok",
    });
  }
  const picked = stratifiedSelect(entries, target);
  await fs.writeFile(OUT, JSON.stringify(picked, null, 2) + "\n");
  console.log(`Wrote ${picked.length} entries → ${OUT}`);
}
main();
