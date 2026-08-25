import { createHash } from "node:crypto";
import type { ArticleMeta } from "./types";

export const ARTICLE_DISCUSSION_PROMPT =
  "%%\nAdd discussion note here:\n\n...\n\n%%";

export interface ArticleReviewProvenance {
  reviewed: string;
  version: string;
  model: string;
  digest: string;
  sourceDigest: string;
  sourceFetched: string;
  sourceKind: "live" | "archive" | "fixture";
}

function yamlQuote(s: string): string {
  // Collapse control whitespace too — a raw newline inside a double-quoted YAML
  // scalar (e.g. a title with an embedded line break) breaks frontmatter parsing.
  return (
    '"' +
    s
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/[\r\n\t]+/g, " ") +
    '"'
  );
}

/**
 * Generate article markdown with YAML frontmatter matching the existing
 * Lens Edu/articles convention (title, author list, source_url, published,
 * created, description, tags), plus `accessed` — the date we fetched the
 * original. Lens never edits imported articles, but sources change after
 * import (e.g. Wikipedia), so the access date records which version we hold.
 */
export function generateArticleMarkdown(
  meta: ArticleMeta,
  body: string,
  createdDate: string,
  options: {
    discussionBlocks?: string;
    extraTags?: string[];
    review?: ArticleReviewProvenance;
  } = {},
): string {
  const lines = ["---", `title: ${yamlQuote(meta.title)}`];

  if (meta.author.length > 0) {
    lines.push("author:");
    for (const a of meta.author) {
      lines.push(`  - ${yamlQuote(a)}`);
    }
  } else {
    lines.push("author:");
  }

  lines.push(`source_url: ${yamlQuote(meta.source_url)}`);
  lines.push(meta.published ? `published: ${meta.published}` : "published:");
  lines.push(`created: ${createdDate}`);
  lines.push(`accessed: ${createdDate}`);
  if (options.review) {
    lines.push("llm-review:");
    lines.push(`  content-sha: ${yamlQuote(options.review.digest)}`);
    lines.push(`  date: ${options.review.reviewed}`);
    lines.push(`  model: ${yamlQuote(options.review.model)}`);
    lines.push(`  version: ${yamlQuote(options.review.version)}`);
    lines.push("  source:");
    lines.push(`    content-sha: ${yamlQuote(options.review.sourceDigest)}`);
    lines.push(`    fetched: ${options.review.sourceFetched}`);
    lines.push(`    kind: ${yamlQuote(options.review.sourceKind)}`);
  }
  lines.push(
    meta.description
      ? `description: ${yamlQuote(meta.description)}`
      : "description:",
  );
  lines.push("tags:", '  - "article-importer"');
  for (const tag of options.extraTags ?? []) {
    if (tag !== "article-importer") lines.push(`  - ${yamlQuote(tag)}`);
  }
  lines.push("---");

  return (
    lines.join("\n") +
    "\n\n" +
    (options.discussionBlocks || ARTICLE_DISCUSSION_PROMPT) +
    "\n\n" +
    body.trim() +
    "\n"
  );
}

/** Generate a discussion-ready article record without storing the article body. */
export function generateArticleStubMarkdown(
  meta: ArticleMeta,
  createdDate: string,
): string {
  const full = generateArticleMarkdown(meta, "", createdDate);
  return full
    .replace('  - "article-importer"', '  - "article-stub"\n  - "validator-ignore"')
    .trimEnd() + "\n";
}

/** Lowercase + hyphenate a string to the `[a-z0-9-]` filename charset used by
 *  the Lens Edu/articles naming convention. */
function slugifyFilename(s: string): string {
  return s
    .toLowerCase()
    .replace(/[<>:"/\\|?*&]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// Trailing words that mark an organization name rather than a person — taking
// their "surname" produces junk prefixes ("Epoch AI" → "ai-…", "Open
// Philanthropy" → "philanthropy-…"). Org authors use their full name instead.
const ORG_TAIL_RE =
  /^(ai|institute|institut|lab|labs|research|forum|foundation|philanthropy|center|centre|org|organization|organisation|team|project|initiative|group|collective|academy|university|college|society|association|journal|magazine|review|report|news|media|blog|press|fund|trust|council|commission|agency|office|department)$/i;

/**
 * Generate filename base following the existing articles convention:
 * "{author-surname}-{title}" lowercased and hyphenated, e.g.
 * "alexander-meditations-on-moloch". Organization authors keep their full name
 * ("Epoch AI" → "epoch-ai-…"), since an org has no surname. Falls back to
 * title only.
 */
export function generateArticleFilenameBase(
  authors: string[],
  title: string,
): string {
  const first = authors[0]?.trim() ?? "";
  const words = first.split(/\s+/).filter(Boolean);
  const surname = words[words.length - 1] ?? "";
  const prefix = words.length > 1 && ORG_TAIL_RE.test(surname) ? first : surname;
  const slug = slugifyFilename(prefix ? `${prefix}-${title}` : title);
  if (slug) return slug;
  // Fully non-Latin titles/authors (CJK, Cyrillic, Arabic, …) slugify to ""
  // under the [a-z0-9-] charset — previously those articles were UNIMPORTABLE
  // ("Could not derive filename"). Fall back to a stable content hash so every
  // article gets a deterministic, non-empty name.
  const digest = createHash("sha1")
    .update(`${first}|${title}`)
    .digest("hex")
    .slice(0, 12);
  return `article-${digest}`;
}

/**
 * Candidate filenames for an article, most-preferred first. The base
 * (surname-title) can collide across DISTINCT pages — e.g. every AI Safety Atlas
 * chapter has an "Introduction", all reducing to `grey-introduction` — so we
 * disambiguate DETERMINISTICALLY from the source URL's path. The caller writes to
 * the first candidate that doesn't already exist, so two different pages get two
 * different, stable names instead of the second being rejected as a duplicate.
 * The same URL always yields the same candidate list.
 *
 * Interim fix for the false-positive "Document already exists" rejection. True
 * dedup by `source_url` (so the SAME url can't be imported twice under a new
 * name) needs a relay-side frontmatter lookup and is a separate change.
 */
export function articleFilenameCandidates(
  base: string,
  sourceUrl: string,
): string[] {
  const candidates = [base];
  let segments: string[] = [];
  try {
    segments = new URL(sourceUrl).pathname
      .split("/")
      .map((s) => slugifyFilename(decodeURIComponent(s)))
      .filter((s) => s && s !== "md");
  } catch {
    return candidates;
  }
  // The trailing segment usually mirrors the title; preceding segments are the
  // distinguishing context (the Atlas chapter section: "risks", "governance", …).
  // Cap depth and suffix length so a deep URL can't grow a filename past the
  // ~255-char filesystem/git component limit.
  const context = segments.slice(0, -1);
  const maxLevels = Math.min(context.length, 3);
  for (let take = 1; take <= maxLevels; take += 1) {
    const suffix = context.slice(context.length - take).join("-");
    if (suffix && suffix.length <= 60) candidates.push(`${base}-${suffix}`);
  }
  return candidates;
}
