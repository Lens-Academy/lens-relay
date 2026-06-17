import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawnClaude } from "../add-video/claude";
import type { ArticleMeta } from "./types";

/**
 * Claude Sonnet QUALITY-CONTROL step for the add-article pipeline.
 *
 * This is NOT the old "regenerate the whole article body with Claude" step
 * (that caused the list/indent corruption and was removed). The body is
 * produced deterministically by the extractor; Claude only:
 *   1. classifies the extraction (ok / paywalled / blocked / truncated / not_article),
 *   2. repairs metadata (author/title/date — fixes e.g. publisher-as-author),
 *   3. judges formatting and, ONLY when structure is genuinely broken, writes a
 *      corrected body (text preserved verbatim).
 *
 * Runs via the `claude` CLI through the shared 3-session pool. Far lighter than
 * the old extraction step (small input, low budget/turns).
 */

export const VERIFY_TIMEOUT_MS = 420_000; // 7 min (the CLI is an agentic loop)

export type VerifyStatus =
  | "ok"
  | "paywalled"
  | "blocked"
  | "truncated"
  | "not_article";

export interface ArticleVerdict {
  status: VerifyStatus;
  title?: string;
  author?: string[];
  published?: string; // YYYY-MM-DD or ""
  formatting_ok?: boolean;
  issues?: string[];
  note?: string;
}

export function buildVerifyPrompt(workDir: string): string {
  return `You are the QUALITY-CONTROL step of an automated article importer. A deterministic extractor has already fetched a web page, isolated the main article, and converted it to Markdown. Your job is to VERIFY and lightly REFINE that output — do NOT rewrite or summarize the article.

The file ${workDir}/article.md holds the extracted article: a YAML frontmatter block (title, author, source_url, published, …) followed by the article body in Markdown.

First read ${workDir}/article.md, then WebFetch the source_url from its frontmatter to use the live page as ground truth (if the fetch fails — paywall, bot-block, JS-only — judge from the file alone). Then write ${workDir}/verdict.json:

1. STATUS — classify the extraction as one of:
   - "ok": a complete, readable article.
   - "paywalled": the body is a short teaser that cuts off at a subscribe / "keep reading" gate.
   - "blocked": the body is a bot-verification, "enable JavaScript", or access-denied interstitial — not an article.
   - "truncated": clearly cut off mid-article for a non-paywall reason (large sections missing).
   - "not_article": a homepage, list/index page, error page, or otherwise not a single article.

2. METADATA — give the CORRECT values, inferred from the article content (fix obvious errors; never fabricate):
   - title: the real article title, with any trailing site-name suffix removed.
   - author: array of the real author name(s) in natural "First Last" order. If the current value is a publication/site name (e.g. "Harvard Business Review", "Brookings", "United Nations") but a personal byline appears in the content, use the real name(s). If there is genuinely no personal author, keep the publication name. Never invent a name.
   - published: the real publication date as YYYY-MM-DD if it appears anywhere in the content; otherwise "".

3. FORMATTING — judge whether the Markdown body's STRUCTURE is faithful (headings, nested lists, tables, code blocks, math, footnotes, blockquotes). Set "formatting_ok": true if structure is fine. ONLY if structure is genuinely broken do you set "formatting_ok": false AND write the corrected body to ${workDir}/corrected.md — preserving the wording EXACTLY, fixing only structural Markdown. Never paraphrase, shorten, or reorder.

4. Write ${workDir}/verdict.json as exactly this shape:
   {"status":"ok|paywalled|blocked|truncated|not_article","title":"…","author":["…"],"published":"YYYY-MM-DD or empty","formatting_ok":true,"issues":["short notes"],"note":"one sentence"}

Write only verdict.json (and corrected.md only when formatting_ok is false). Do not create any other files.`;
}

export function buildVerifyArgs(workDir: string): string[] {
  return [
    "-p",
    buildVerifyPrompt(workDir),
    "--allowedTools",
    "Read,Write,WebFetch,Edit",
    // Headless server runs: never block on an interactive permission prompt
    // (e.g. when fetching the source page).
    "--dangerously-skip-permissions",
    "--max-turns",
    "15",
    "--max-budget-usd",
    "0.75",
    "--model",
    "sonnet",
    "--output-format",
    "json",
  ];
}

/** Run the verify/refine step. Uses the shared session pool (max 3 concurrent). */
export async function runArticleVerify(
  workDir: string,
  timeoutMs: number = VERIFY_TIMEOUT_MS,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return spawnClaude(workDir, timeoutMs, buildVerifyArgs(workDir));
}

/** Apply Claude's metadata, accepting only well-formed values (else keep deterministic). */
export function applyVerdictMeta(meta: ArticleMeta, v: ArticleVerdict): ArticleMeta {
  const title =
    typeof v.title === "string" && v.title.trim() ? v.title.trim() : meta.title;
  const author =
    Array.isArray(v.author) && v.author.some((a) => typeof a === "string" && a.trim())
      ? v.author
          .filter((a): a is string => typeof a === "string" && !!a.trim())
          .map((a) => a.trim())
      : meta.author;
  const published =
    typeof v.published === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.published)
      ? v.published
      : meta.published;
  return { ...meta, title, author, published };
}

export interface VerifyOutcome {
  /** Null when the verify step was unavailable/failed — caller keeps deterministic output. */
  verdict: ArticleVerdict | null;
  meta: ArticleMeta;
  body: string;
}

/**
 * Write the deterministic article to a work dir, run the Claude verify/refine
 * step, and return the (possibly metadata-repaired / format-corrected) result.
 * Degrades gracefully: if the CLI is unavailable or errors, returns the input
 * unchanged with verdict=null. The caller decides how to act on verdict.status
 * (the pipeline throws on paywalled/blocked; the test harness records it).
 */
export async function verifyAndRefine(
  workDir: string,
  articleMd: string,
  meta: ArticleMeta,
  body: string,
): Promise<VerifyOutcome> {
  try {
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(path.join(workDir, "article.md"), articleMd);
    const res = await runArticleVerify(workDir);
    if (res.exitCode !== 0) return { verdict: null, meta, body };
    const verdict = JSON.parse(
      await fs.readFile(path.join(workDir, "verdict.json"), "utf-8"),
    ) as ArticleVerdict;
    const newMeta = applyVerdictMeta(meta, verdict);
    let newBody = body;
    if (verdict.formatting_ok === false) {
      const corrected = await fs
        .readFile(path.join(workDir, "corrected.md"), "utf-8")
        .catch(() => "");
      if (corrected.trim().length >= 200) newBody = corrected.trim();
    }
    return { verdict, meta: newMeta, body: newBody };
  } catch {
    return { verdict: null, meta, body };
  } finally {
    await fs.rm(workDir, { recursive: true }).catch(() => {});
  }
}
