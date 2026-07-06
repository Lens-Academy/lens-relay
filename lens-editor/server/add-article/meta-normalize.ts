import * as fs from "node:fs/promises";
import { spawnClaude } from "../add-video/claude";
import { isValidYmd } from "./fetch";
import type { ArticleMeta } from "./types";

/**
 * ALWAYS-ON metadata normalizer — one cheap, tool-less LLM call per import.
 *
 * The 50-article blind eval showed the dominant remaining metadata defects are
 * dates printed only in the document text ("May 1980", "© 2002", a dateline
 * under the title) and publisher-as-author fallbacks on PDFs — exactly the
 * information a deterministic metadata reader can't see and the selective
 * heavyweight QC only occasionally repairs (it times out on long documents).
 * This pass reads ONLY the first/last few KB of the extracted body plus our
 * candidate metadata and returns corrections as strict JSON. It never touches
 * the body, degrades to a no-op on any failure, and its output is merged under
 * anti-fabrication rules (names must literally appear in the excerpt, dates
 * need their year in the excerpt, titles must overlap the current title).
 *
 * Cost/latency: Haiku via the shared CLI pool ≈ 1–2¢ and a few seconds.
 * Disable with ARTICLE_SKIP_META_LLM=1.
 */

export const META_LLM_TIMEOUT_MS = 90_000;

export interface MetaNormalizeInput {
  meta: ArticleMeta;
  siteName: string;
  /** Import-date used when no published date was found (the fallback value). */
  createdDate: string;
  /** True when the author field was filled with the publisher/site fallback. */
  authorIsFallback: boolean;
  /** True when no published date was discovered (fallback = createdDate). */
  dateIsFallback: boolean;
  /** True when the date came from PDF file metadata (CreationDate/ModDate) —
   *  frequently a scan/re-save timestamp years after real publication. */
  dateFromPdfInfo: boolean;
  bodyStart: string;
  bodyEnd: string;
}

export interface NormalizedMeta {
  title?: string;
  authors?: string[];
  published?: string;
}

export function buildMetaPrompt(input: MetaNormalizeInput): string {
  return `You are a metadata checker for an article importer. Below are the CURRENT metadata candidates and excerpts from the beginning and end of the imported document. Correct the metadata STRICTLY from what is visible in the excerpts. Output ONLY a JSON object — no prose, no code fences.

CURRENT METADATA:
- title: ${JSON.stringify(input.meta.title)}
- authors: ${JSON.stringify(input.meta.author)}${input.authorIsFallback ? " (this is a publisher-name fallback, not an extracted byline)" : ""}
- published: ${JSON.stringify(input.meta.published)}${input.dateIsFallback ? " (this is the import date — no real date was found)" : ""}
- site/publisher: ${JSON.stringify(input.siteName)}

RULES:
1. "authors": the real personal author name(s), copied VERBATIM from the excerpt (byline, cover page, citation line). Never invent, complete, or reorder names that are not in the excerpt. If the document genuinely shows no personal author, return [].
2. "published": the document's real publication date as "YYYY-MM-DD" ONLY if the excerpt explicitly shows a publication date (a dateline, "Published/Posted <date>", a cover date like "May 1980" → "1980-05-01", a copyright/citation year → "YYYY-01-01"). Dates of events discussed in the text and dates in reference lists do NOT count. If unsure, return "".
3. "title": the document's real title exactly as printed (fix casing/truncation/site-name suffixes). If the current title is already right, repeat it.

OUTPUT SHAPE: {"title": "...", "authors": ["..."], "published": "YYYY-MM-DD or empty"}

=== DOCUMENT START (excerpt) ===
${input.bodyStart}
=== DOCUMENT END (excerpt) ===
${input.bodyEnd}`;
}

/** Extract the first {...} JSON object from CLI output; null if unparseable. */
export function parseMetaResponse(cliStdout: string): NormalizedMeta | null {
  try {
    const outer = JSON.parse(cliStdout) as { result?: unknown };
    const text = typeof outer.result === "string" ? outer.result : cliStdout;
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]) as Record<string, unknown>;
    const out: NormalizedMeta = {};
    if (typeof obj.title === "string") out.title = obj.title.trim();
    if (Array.isArray(obj.authors)) {
      out.authors = obj.authors
        .filter((a): a is string => typeof a === "string" && !!a.trim())
        .map((a) => a.trim());
    }
    if (typeof obj.published === "string") out.published = obj.published.trim();
    return out;
  } catch {
    return null;
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Every word of `name` appears in the excerpt (order-insensitive; initials
 *  may drop periods). Anti-fabrication: we only accept names literally there. */
function nameInText(name: string, text: string): boolean {
  const hay = ` ${norm(text)} `;
  const words = norm(name).split(" ").filter(Boolean);
  return words.length > 0 && words.every((w) => hay.includes(` ${w} `));
}

function wordOverlap(a: string, b: string): number {
  const wa = new Set(norm(a).split(" ").filter(Boolean));
  const wb = new Set(norm(b).split(" ").filter(Boolean));
  if (wa.size === 0 || wb.size === 0) return 0;
  let hit = 0;
  for (const w of wa) if (wb.has(w)) hit++;
  return hit / Math.max(wa.size, wb.size);
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Merge the model's answer into the metadata under conservative guards.
 * Every acceptance condition is deliberately narrow — a wrong "no change" is
 * cheaper than a fabricated field.
 */
export function applyNormalizedMeta(
  input: MetaNormalizeInput,
  parsed: NormalizedMeta,
): { meta: ArticleMeta; changed: string[] } {
  const excerpt = `${input.bodyStart}\n${input.bodyEnd}`;
  const meta = { ...input.meta };
  const changed: string[] = [];

  // AUTHORS — only replace a fallback/empty author, and only with names that
  // are literally present in the excerpt.
  if (
    parsed.authors &&
    parsed.authors.length > 0 &&
    parsed.authors.length <= 12 &&
    (input.authorIsFallback || meta.author.length === 0) &&
    parsed.authors.every((a) => nameInText(a, excerpt))
  ) {
    meta.author = parsed.authors;
    changed.push("author");
  }

  // PUBLISHED — fill a fallback date, or override a PDF-file-metadata date
  // when the document itself shows a different year. Calendar-validate, not
  // just shape-validate: a hallucinated "2024-13-45" would land UNQUOTED in
  // YAML frontmatter and corrupt the document.
  if (
    parsed.published &&
    YMD_RE.test(parsed.published) &&
    isValidYmd(
      parsed.published.slice(0, 4),
      parsed.published.slice(5, 7),
      parsed.published.slice(8, 10),
    )
  ) {
    const year = parsed.published.slice(0, 4);
    const yearInExcerpt = excerpt.includes(year);
    const currentYear = meta.published.slice(0, 4);
    const overridePdfDate =
      input.dateFromPdfInfo && !input.dateIsFallback && year !== currentYear;
    if (yearInExcerpt && (input.dateIsFallback || overridePdfDate)) {
      meta.published = parsed.published;
      changed.push("published");
    }
  }

  // TITLE — casing/truncation/suffix repairs only: must share most words with
  // the current title (or the current one is empty), AND any words it ADDS
  // must appear in the excerpt. The second condition closes an exfiltration
  // channel: a prompt-injected model could otherwise smuggle an arbitrary
  // token by appending it to the existing title (overlap stays ≥ 0.5).
  if (
    parsed.title &&
    parsed.title.length >= 3 &&
    parsed.title.length <= 300 &&
    parsed.title !== meta.title &&
    (meta.title === "" || wordOverlap(parsed.title, meta.title) >= 0.5)
  ) {
    const currentWords = new Set(norm(meta.title).split(" ").filter(Boolean));
    const excerptHay = ` ${norm(excerpt)} `;
    const addedWords = norm(parsed.title)
      .split(" ")
      .filter(Boolean)
      .filter((w) => !currentWords.has(w));
    if (addedWords.every((w) => excerptHay.includes(` ${w} `))) {
      meta.title = parsed.title;
      changed.push("title");
    }
  }

  return { meta, changed };
}

export type MetaLlmRunner = (prompt: string) => Promise<string>;

async function defaultRunner(prompt: string): Promise<string> {
  const workDir = `/tmp/articles/meta-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await fs.mkdir(workDir, { recursive: true });
  try {
    // --max-turns 1 is the tool lockout: the model must answer in its first
    // turn, so a (prompt-injected) tool call consumes the only turn and the
    // run ends with unparseable output → safe no-op. Do not raise this.
    const res = await spawnClaude(workDir, META_LLM_TIMEOUT_MS, [
      "-p",
      prompt,
      "--max-turns",
      "1",
      "--max-budget-usd",
      "0.10",
      "--model",
      process.env.ARTICLE_META_MODEL || "haiku",
      "--output-format",
      "json",
    ]);
    if (res.exitCode !== 0) throw new Error(`meta LLM exit ${res.exitCode}`);
    return res.stdout;
  } finally {
    await fs.rm(workDir, { recursive: true }).catch(() => {});
  }
}

/**
 * Run the normalizer; on ANY failure returns the input meta unchanged.
 * `runner` is injectable for tests.
 */
export async function normalizeMetaWithLlm(
  input: MetaNormalizeInput,
  runner: MetaLlmRunner = defaultRunner,
): Promise<ArticleMeta> {
  try {
    const stdout = await runner(buildMetaPrompt(input));
    const parsed = parseMetaResponse(stdout);
    if (!parsed) return input.meta;
    const { meta, changed } = applyNormalizedMeta(input, parsed);
    if (changed.length > 0) {
      console.log(`[add-article] meta-normalize adjusted: ${changed.join(", ")}`);
    }
    return meta;
  } catch (err) {
    console.warn(`[add-article] meta-normalize skipped (${err})`);
    return input.meta;
  }
}
