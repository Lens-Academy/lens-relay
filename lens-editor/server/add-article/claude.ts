import { spawnClaude } from "../add-video/claude";

/**
 * Build the cleanup prompt for Claude. The work directory contains:
 *   extracted.md — automated extraction (Jina Reader), may be empty if Jina failed
 *   raw.html     — original page HTML (may be absent if the direct fetch failed)
 *   meta.json    — metadata seed { title, author, source_url, published, description }
 * Claude writes cleaned.md (article body) and updates meta.json.
 */
export function buildArticlePrompt(workDir: string): string {
  return `You are converting a scraped web article into a clean markdown document for an educational library.

Files in ${workDir}:
- extracted.md — article content from an automated extractor. May contain site cruft (navigation, ads, related-posts lists, comment sections), broken formatting, or encoding artifacts. May be missing links or images. May be empty if extraction failed.
- raw.html — the original page HTML, if available. It can be very large, so search it selectively (Grep) rather than reading it whole. Use it to verify content, recover dropped links/images/footnotes, and find metadata. If extracted.md is empty, extract the article body from raw.html.
- meta.json — metadata seed: { "title", "author" (array), "source_url", "published" (YYYY-MM-DD), "description" }. Fields may be empty.

Your tasks:

1. Write ${workDir}/cleaned.md — the article BODY ONLY as clean markdown:
   - Remove everything that is not the article itself: navigation, site headers/footers, share buttons, subscription/cookie prompts, "related posts", comment sections, sidebar content, author bio boxes.
   - Do NOT include the article title as a heading (the title lives in metadata). Keep the article's internal section headings, normalized to start at ##.
   - Fix extraction artifacts: soft hyphens (U+00AD) and other invisible characters, words bro-ken across line breaks, mojibake/encoding errors, duplicated paragraphs or sentences, empty links like [](), stray image placeholders.
   - PRESERVE the article text exactly as written. Do not rewrite, summarize, shorten, reorder, or "improve" the prose. Keep all paragraphs, blockquotes, lists, tables, code blocks, and footnotes.
   - Keep hyperlinks as inline markdown links. Resolve relative URLs to absolute using the source_url. If the extractor dropped links that exist in raw.html, restore them.
   - Keep content images as ![alt](absolute-url) at their original positions. Drop decorative images, icons, avatars, and tracking pixels.

2. Update ${workDir}/meta.json — fill or correct title, author (array of person names), published (YYYY-MM-DD), and description (one factual sentence describing the article). Check raw.html meta tags, JSON-LD, and the article byline. Leave a field empty if it is genuinely not stated anywhere — NEVER guess or invent authors or dates.

Write only cleaned.md and meta.json. Do not create any other files.`;
}

export function buildArticleClaudeArgs(workDir: string): string[] {
  return [
    "-p",
    buildArticlePrompt(workDir),
    "--allowedTools",
    "Read,Write,Grep",
    "--max-turns",
    "40",
    "--max-budget-usd",
    "2.00",
    "--model",
    "sonnet",
    "--output-format",
    "json",
  ];
}

/** Run Claude on a fetched article. Uses the shared session pool (max 3 concurrent). */
export async function runArticleClaude(
  workDir: string,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return spawnClaude(workDir, timeoutMs, buildArticleClaudeArgs(workDir));
}
