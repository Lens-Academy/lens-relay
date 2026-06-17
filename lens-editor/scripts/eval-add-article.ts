/**
 * End-to-end eval for the DETERMINISTIC add-article pipeline (post-redesign).
 *
 * Mirrors processArticle — fetch raw HTML → extractArticle (isolate + HTML→MD,
 * no LLM) → generateArticleMarkdown — WITHOUT writing to the relay, then scores
 * the result against the hand-curated gold copies referenced in testset.json.
 *
 * Usage:
 *   npx tsx scripts/eval-add-article.ts                     # full test set
 *   npx tsx scripts/eval-add-article.ts --only 3            # single entry by index
 *   npx tsx scripts/eval-add-article.ts --url <article-url> # ad-hoc url (no gold checks)
 *
 * Requirements: network access. No `claude` CLI, no API cost.
 * Outputs land in /tmp/article-eval/<index>-<slug>/ for manual inspection
 * (final.md is the document that would have been written to the relay).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fetchRawHtml } from "../server/add-article/fetch";
import { extractArticle } from "../server/add-article/extract";
import { ensureRequiredMeta } from "../server/add-article/pipeline";
import {
  generateArticleMarkdown,
  generateArticleFilenameBase,
} from "../server/add-article/export";

const OUT_BASE = "/tmp/article-eval";

interface TestExpectation {
  title?: string;
  author_surname?: string;
  published?: string;
  must_contain?: string[];
}
interface TestEntry {
  url: string;
  gold_relay_path: string;
  expect: TestExpectation;
}
interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

// Artifact patterns that should never survive extraction (forum chrome etc.).
const ARTIFACT_PATTERNS: Array<[string, RegExp]> = [
  ["soft hyphen (U+00AD)", /­/],
  ["empty link []()", /\[\]\(\)/],
  ['"Skip to content"', /skip to (main )?content/i],
  ["comment-deleted chrome", /\bcomment deleted\b/i],
  ["karma/byline chrome", /·\s*\d+\s*(mo|y|d|h)\s*ago/i],
  ['"Related posts" block', /related (posts|articles)/i],
];

function fidelityLine(md: string): string {
  const mathInline = (md.match(/(?<!\$)\$(?!\$)[^$\n]+\$/g) || []).length;
  const mathDisplay = (md.match(/\$\$[^$]+\$\$/g) || []).length;
  const fnRefs = (md.match(/\[\^\d+\]/g) || []).length;
  const fnDefs = (md.match(/^\[\^\d+\]:/gm) || []).length;
  const ol = (md.match(/^\s*\d+\.\s/gm) || []).length;
  return `math:${mathInline}i/${mathDisplay}d  fn:${fnRefs}ref/${fnDefs}def  ol:${ol}`;
}

async function runEntry(
  entry: TestEntry,
  index: number,
): Promise<{ checks: CheckResult[]; warnings: string[]; outDir: string }> {
  const slug = new URL(entry.url).hostname
    .replace(/^www\./, "")
    .replace(/\W+/g, "-");
  const outDir = path.join(OUT_BASE, `${index}-${slug}`);
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const checks: CheckResult[] = [];
  const warnings: string[] = [];

  // 1. Fetch raw HTML (mirrors pipeline.ts)
  let html: string;
  const t0 = performance.now();
  try {
    html = await fetchRawHtml(entry.url);
    checks.push({ name: "fetched", ok: true });
  } catch (err) {
    checks.push({
      name: "fetched",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
    return { checks, warnings, outDir };
  }

  // 2. Deterministic extract + convert
  const ex = await extractArticle(html, entry.url);
  const ms = Math.round(performance.now() - t0);
  const createdDate = new Date().toISOString().slice(0, 10);
  const meta = ensureRequiredMeta(ex.meta, ex.siteName, createdDate);
  const finalMd = generateArticleMarkdown(meta, ex.body, createdDate);
  await fs.writeFile(path.join(outDir, "body.md"), ex.body);
  await fs.writeFile(path.join(outDir, "final.md"), finalMd);

  checks.push({
    name: "extracted",
    ok: ex.body.length > 200,
    detail: `via ${ex.via}, ${ex.body.length} chars, ${ms}ms`,
  });
  if (ex.linkedOut) {
    warnings.push(
      "LINK-OUT detected → pipeline would reject (no stub written to relay)",
    );
  }

  // 3. Score against gold
  const e = entry.expect;
  if (e.title) {
    checks.push({
      name: "title matches gold",
      ok: meta.title.toLowerCase().includes(e.title.toLowerCase()),
      detail: meta.title,
    });
  }
  if (e.author_surname) {
    checks.push({
      name: "author matches gold",
      ok: meta.author.some((a) =>
        a.toLowerCase().includes(e.author_surname!.toLowerCase()),
      ),
      detail: meta.author.join(", ") || "(none)",
    });
  }
  if (e.published) {
    checks.push({
      name: "published matches gold",
      ok: meta.published === e.published,
      detail: meta.published || "(none)",
    });
  }
  for (const snippet of e.must_contain ?? []) {
    checks.push({
      name: `contains "${snippet}"`,
      ok: ex.body.toLowerCase().includes(snippet.toLowerCase()),
    });
  }

  for (const [name, pattern] of ARTIFACT_PATTERNS) {
    if (pattern.test(ex.body)) warnings.push(`artifact: ${name}`);
  }
  warnings.push(`fidelity: ${fidelityLine(ex.body)}`);
  const filenameBase = generateArticleFilenameBase(meta.author, meta.title);
  warnings.push(
    `would write: Lens Edu/articles/${filenameBase}.md (gold: ${entry.gold_relay_path})`,
  );

  return { checks, warnings, outDir };
}

async function main() {
  const args = process.argv.slice(2);
  const onlyIdx = args.includes("--only")
    ? parseInt(args[args.indexOf("--only") + 1], 10)
    : null;
  const adhocUrl = args.includes("--url")
    ? args[args.indexOf("--url") + 1]
    : null;

  let entries: Array<{ entry: TestEntry; index: number }>;
  if (adhocUrl) {
    entries = [
      {
        entry: { url: adhocUrl, gold_relay_path: "(ad-hoc)", expect: {} },
        index: 0,
      },
    ];
  } else {
    const testsetPath = path.join(
      import.meta.dirname,
      "../server/add-article/eval/testset.json",
    );
    const testset = JSON.parse(await fs.readFile(testsetPath, "utf-8")) as {
      articles: TestEntry[];
    };
    entries = testset.articles
      .map((entry, index) => ({ entry, index }))
      .filter(({ index }) => onlyIdx === null || index === onlyIdx);
  }

  console.log(`Running ${entries.length} eval entr${entries.length === 1 ? "y" : "ies"} (deterministic)\n`);

  let totalPass = 0;
  let totalFail = 0;
  for (const { entry, index } of entries) {
    console.log(`[${index}] ${entry.url}`);
    try {
      const { checks, warnings, outDir } = await runEntry(entry, index);
      for (const c of checks) {
        console.log(
          `  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`,
        );
        if (c.ok) totalPass++;
        else totalFail++;
      }
      for (const w of warnings) console.log(`  ·     ${w}`);
      console.log(`  out   ${outDir}\n`);
    } catch (err) {
      console.log(`  ERROR ${err instanceof Error ? err.stack : err}\n`);
      totalFail++;
    }
  }

  console.log(`\n${totalPass} checks passed, ${totalFail} failed`);
  process.exit(totalFail > 0 ? 1 : 0);
}

main();
