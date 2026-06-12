import type { ArticleMeta } from "./types";

function yamlQuote(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/**
 * Generate article markdown with YAML frontmatter matching the existing
 * Lens Edu/articles convention (title, author list, source_url, published,
 * created, description, tags).
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
  lines.push(
    meta.description
      ? `description: ${yamlQuote(meta.description)}`
      : "description:",
  );
  lines.push("tags:", '  - "article-importer"', "---");

  return lines.join("\n") + "\n\n" + body.trim() + "\n";
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
  const base = surname ? `${surname}-${title}` : title;

  return base
    .toLowerCase()
    .replace(/[<>:"/\\|?*&]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
