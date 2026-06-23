import type { ArticleMeta } from "./types";

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
  lines.push(
    meta.description
      ? `description: ${yamlQuote(meta.description)}`
      : "description:",
  );
  lines.push("tags:", '  - "article-importer"', "---");

  return lines.join("\n") + "\n\n" + body.trim() + "\n";
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

/**
 * Generate filename base following the existing articles convention:
 * "{author-surname}-{title}" lowercased and hyphenated, e.g.
 * "alexander-meditations-on-moloch". Falls back to title only.
 */
export function generateArticleFilenameBase(
  authors: string[],
  title: string,
): string {
  const surname = authors[0]?.trim().split(/\s+/).pop() ?? "";
  return slugifyFilename(surname ? `${surname}-${title}` : title);
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
  const context = segments.slice(0, -1);
  for (let take = 1; take <= context.length; take += 1) {
    const suffix = context.slice(context.length - take).join("-");
    if (suffix) candidates.push(`${base}-${suffix}`);
  }
  return candidates;
}
