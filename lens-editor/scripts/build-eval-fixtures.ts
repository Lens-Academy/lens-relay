/**
 * Freeze each manifest entry into a hermetic fixture. Live network + relay
 * cache. Usage: npx tsx scripts/build-eval-fixtures.ts [--only <slug>] [--force]
 *
 * By default an existing fixture is SKIPPED (so hand-curated gold is never
 * clobbered by a rebuild). Pass --force to regenerate fixtures that exist.
 */
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { readEduDoc, splitFrontmatter, parseFrontmatterAuthor } from "../server/add-article/eval/edu-repo";
import { writeFixture, readFixture, fixtureDir } from "../server/add-article/eval/fixture-io";
import { hasCriticMarkup } from "../server/add-article/eval/criticmarkup";
import { atlasMarkdownUrl } from "../server/add-article/eval/atlas-md-url";
import { fetchFirstHtml, fetchRenderedHtml, fetchRawHtml } from "../server/add-article/fetch";
import { resolveFetchUrls, adapterContext } from "../server/add-article/adapters";
import type { ManifestEntry } from "../server/add-article/eval/manifest";

const MANIFEST = path.join(import.meta.dirname, "../server/add-article/eval/fixtures.manifest.json");

async function build(entry: ManifestEntry) {
  const { frontmatter, body } = splitFrontmatter(await readEduDoc(entry.relay_path));
  // Gold = relay body verbatim (no stripping — the scorer compares as-is). We
  // only flag dirty gold (leftover editorial markup) so it gets curated during
  // review, not silently trusted.
  const expectedMd = body;
  const dirtyGold = hasCriticMarkup(expectedMd);
  // Mirror pipeline fetch: resolve redirects, then take the first that works.
  const urls = resolveFetchUrls(adapterContext(entry.source_url, ""));
  let html: string, used: string;
  try {
    ({ html, url: used } = await fetchFirstHtml(urls));
  } catch {
    html = await fetchRenderedHtml(entry.source_url); used = entry.source_url;
  }
  let bodyMarkdown: string | undefined;
  if (entry.needs_body_markdown) {
    bodyMarkdown = await fetchRawHtml(atlasMarkdownUrl(used)); // .md export
  }
  // Preserve a prior human review unless the gold body actually changed.
  let reviewed = false;
  try {
    const prev = await readFixture(entry.slug);
    if (prev.expectedMd === expectedMd) reviewed = prev.meta.reviewed ?? false;
  } catch { /* new fixture — stays unreviewed */ }
  await writeFixture(entry.slug, {
    renderedSourceHtml: html, expectedMd, bodyMarkdown,
    meta: {
      ...entry, resolved_fetch_url: used,
      title: frontmatter.title ?? "",
      author: parseFrontmatterAuthor(frontmatter.author),
      published: frontmatter.published ?? "",
      reviewed,
      ...(dirtyGold ? { reviewed_note: "gold contains editorial markup — clean to website-identical" } : {}),
    },
  });
  console.log(`✓ ${entry.slug} (${html.length} bytes${bodyMarkdown ? " + md" : ""})${reviewed ? " [reviewed]" : dirtyGold ? " [dirty-gold]" : ""}`);
}

async function fixtureExists(slug: string): Promise<boolean> {
  try { await fs.stat(fixtureDir(slug)); return true; } catch { return false; }
}

async function main() {
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
  const force = process.argv.includes("--force");
  const manifest: ManifestEntry[] = JSON.parse(await fs.readFile(MANIFEST, "utf-8"));
  for (const e of manifest.filter((x) => x.status === "ok" && (!only || x.slug === only))) {
    if (!force && (await fixtureExists(e.slug))) {
      console.log(`• skip ${e.slug} (fixture exists — pass --force to overwrite)`);
      continue;
    }
    try { await build(e); }
    catch (err) { console.error(`✗ ${e.slug}: ${err}`); }
  }
}
main();
