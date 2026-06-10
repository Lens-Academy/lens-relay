/**
 * Eval harness for the add-article import pipeline.
 *
 * Runs fetch + extraction + Claude cleanup for each test-set article WITHOUT
 * touching the relay, then scores the result against expectations derived
 * from the hand-curated gold copies in `Lens Edu/articles/`.
 *
 * Usage:
 *   npx tsx scripts/eval-add-article.ts             # full test set
 *   npx tsx scripts/eval-add-article.ts --only 3    # single entry by index
 *   npx tsx scripts/eval-add-article.ts --fetch-only # skip Claude (fast, free)
 *
 * Requirements: network access; `claude` CLI on PATH (unless --fetch-only).
 * Outputs land in /tmp/article-eval/<index>-<slug>/ for manual inspection
 * (final.md is the document that would have been written to the relay).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  fetchRawHtml,
  fetchJina,
  extractHtmlMeta,
} from "../server/add-article/fetch";
import { runArticleClaude } from "../server/add-article/claude";
import {
  generateArticleMarkdown,
  generateArticleFilenameBase,
} from "../server/add-article/export";
import type { ArticleMeta } from "../server/add-article/types";

const OUT_BASE = "/tmp/article-eval";
const CLAUDE_TIMEOUT_MS = 1_200_000;

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

// Artifact patterns that should never survive cleanup. Checked as warnings —
// some can legitimately appear inside article prose.
const ARTIFACT_PATTERNS: Array<[string, RegExp]> = [
  ["soft hyphen (U+00AD)", /­/],
  ["empty link []()", /\[\]\(\)/],
  ['"Skip to content"', /skip to (main )?content/i],
  ['"Subscribe" prompt', /subscribe (now|to (our|the|my))/i],
  ["cookie banner text", /we use cookies|cookie policy/i],
  ['"Related posts" block', /related (posts|articles)/i],
];

async function runEntry(
  entry: TestEntry,
  index: number,
  fetchOnly: boolean,
): Promise<{ checks: CheckResult[]; warnings: string[]; outDir: string }> {
  const slug = new URL(entry.url).hostname
    .replace(/^www\./, "")
    .replace(/\W+/g, "-");
  const outDir = path.join(OUT_BASE, `${index}-${slug}`);
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const checks: CheckResult[] = [];
  const warnings: string[] = [];

  // 1. Fetch (mirrors pipeline.ts)
  const [htmlResult, jinaResult] = await Promise.allSettled([
    fetchRawHtml(entry.url),
    fetchJina(entry.url),
  ]);
  const html = htmlResult.status === "fulfilled" ? htmlResult.value : null;
  const jina = jinaResult.status === "fulfilled" ? jinaResult.value : null;

  checks.push({
    name: "fetched",
    ok: Boolean(html || jina),
    detail: [
      html
        ? "html ok"
        : `html FAILED (${(htmlResult as PromiseRejectedResult).reason})`,
      jina
        ? "jina ok"
        : `jina FAILED (${(jinaResult as PromiseRejectedResult).reason})`,
    ].join(", "),
  });
  if (!html && !jina) return { checks, warnings, outDir };

  const htmlMeta = html ? extractHtmlMeta(html) : null;
  const meta: ArticleMeta = {
    title: htmlMeta?.title || jina?.title || "",
    author: htmlMeta?.author ?? [],
    source_url: entry.url,
    published: htmlMeta?.published || jina?.published || "",
    description: htmlMeta?.description ?? "",
  };

  await fs.writeFile(path.join(outDir, "extracted.md"), jina?.markdown ?? "");
  if (html) await fs.writeFile(path.join(outDir, "raw.html"), html);
  await fs.writeFile(
    path.join(outDir, "meta.json"),
    JSON.stringify(meta, null, 2),
  );

  if (fetchOnly) {
    checks.push({
      name: "seed title found",
      ok: Boolean(meta.title),
      detail: meta.title,
    });
    return { checks, warnings, outDir };
  }

  // 2. Claude cleanup
  const result = await runArticleClaude(outDir, CLAUDE_TIMEOUT_MS);
  checks.push({
    name: "claude exit 0",
    ok: result.exitCode === 0,
    detail: result.exitCode === 0 ? undefined : result.stderr.slice(0, 200),
  });
  if (result.exitCode !== 0) return { checks, warnings, outDir };

  const cleaned = (
    await fs.readFile(path.join(outDir, "cleaned.md"), "utf-8").catch(() => "")
  ).trim();
  const finalMeta: ArticleMeta = JSON.parse(
    await fs.readFile(path.join(outDir, "meta.json"), "utf-8"),
  );

  const finalMd = generateArticleMarkdown(
    finalMeta,
    cleaned,
    new Date().toISOString().slice(0, 10),
  );
  await fs.writeFile(path.join(outDir, "final.md"), finalMd);

  // 3. Score
  checks.push({
    name: "body length > 1000 chars",
    ok: cleaned.length > 1000,
    detail: `${cleaned.length} chars`,
  });

  const e = entry.expect;
  if (e.title) {
    checks.push({
      name: "title matches gold",
      ok: finalMeta.title.toLowerCase().includes(e.title.toLowerCase()),
      detail: finalMeta.title,
    });
  }
  if (e.author_surname) {
    checks.push({
      name: "author matches gold",
      ok: finalMeta.author.some((a) =>
        a.toLowerCase().includes(e.author_surname!.toLowerCase()),
      ),
      detail: finalMeta.author.join(", ") || "(none)",
    });
  }
  if (e.published) {
    checks.push({
      name: "published matches gold",
      ok: finalMeta.published === e.published,
      detail: finalMeta.published || "(none)",
    });
  }
  for (const snippet of e.must_contain ?? []) {
    checks.push({
      name: `contains "${snippet}"`,
      ok: cleaned.toLowerCase().includes(snippet.toLowerCase()),
    });
  }

  for (const [name, pattern] of ARTIFACT_PATTERNS) {
    if (pattern.test(cleaned)) warnings.push(`artifact: ${name}`);
  }
  const filenameBase = generateArticleFilenameBase(
    finalMeta.author,
    finalMeta.title,
  );
  warnings.push(
    `would write: Lens Edu/articles/${filenameBase}.md (gold: ${entry.gold_relay_path})`,
  );

  return { checks, warnings, outDir };
}

async function main() {
  const args = process.argv.slice(2);
  const fetchOnly = args.includes("--fetch-only");
  const onlyIdx = args.includes("--only")
    ? parseInt(args[args.indexOf("--only") + 1], 10)
    : null;

  const testsetPath = path.join(
    import.meta.dirname,
    "../server/add-article/eval/testset.json",
  );
  const testset = JSON.parse(await fs.readFile(testsetPath, "utf-8")) as {
    articles: TestEntry[];
  };

  const entries = testset.articles
    .map((entry, index) => ({ entry, index }))
    .filter(({ index }) => onlyIdx === null || index === onlyIdx);

  console.log(
    `Running ${entries.length} eval entr${entries.length === 1 ? "y" : "ies"}${fetchOnly ? " (fetch only)" : ""}\n`,
  );

  let totalPass = 0;
  let totalFail = 0;

  // Sequential by entry — Claude concurrency is already pooled per article,
  // and sequential output is much easier to read.
  for (const { entry, index } of entries) {
    console.log(`[${index}] ${entry.url}`);
    try {
      const { checks, warnings, outDir } = await runEntry(
        entry,
        index,
        fetchOnly,
      );
      for (const c of checks) {
        console.log(
          `  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`,
        );
        if (c.ok) totalPass++;
        else totalFail++;
      }
      for (const w of warnings) console.log(`  warn  ${w}`);
      console.log(`  out   ${outDir}\n`);
    } catch (err) {
      console.log(`  ERROR ${err instanceof Error ? err.message : err}\n`);
      totalFail++;
    }
  }

  console.log(`\n${totalPass} checks passed, ${totalFail} failed`);
  process.exit(totalFail > 0 ? 1 : 0);
}

main();
