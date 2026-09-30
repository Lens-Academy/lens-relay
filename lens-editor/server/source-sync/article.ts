import { yamlQuote } from "../yaml";
import { SYNC_MARKER_KEY } from "../../shared/source-sync";
import type { SourceContent, SyncBinding } from "./types";

/** The tag every synced file carries, so they can be found as a set. */
export const SYNC_TAG = "source-sync";

/** Title for a file whose source names none: the target's file name. */
function fileTitle(target: string): string {
  return target.slice(target.lastIndexOf("/") + 1).replace(/\.md$/, "");
}

/**
 * A synced Lens article: the fields Lens Edu requires of an article (title,
 * author, source_url, published), then the sync marker the editor reads to
 * warn that edits here will be overwritten.
 */
export function composeArticle(kind: string, content: SourceContent, binding: SyncBinding, published: string): string {
  const lines = ["---", `title: ${yamlQuote(binding.title ?? content.title ?? fileTitle(binding.target))}`, "author:"];
  for (const name of binding.author) lines.push(`  - ${yamlQuote(name)}`);
  lines.push(`source_url: ${yamlQuote(binding.sourceUrl ?? content.editUrl)}`);
  lines.push(`published: ${published}`);
  if (content.description) lines.push(`description: ${yamlQuote(content.description)}`);
  lines.push("tags:", `  - ${yamlQuote(SYNC_TAG)}`);
  lines.push(`${SYNC_MARKER_KEY}:`, `  source: ${yamlQuote(kind)}`, `  url: ${yamlQuote(content.editUrl)}`);
  lines.push("---");
  return `${lines.join("\n")}\n\n${content.body.trim()}\n`;
}

/** The `published` date already in a file's frontmatter, so re-syncs keep it. */
export function publishedOf(markdown: string | null): string | null {
  const frontmatter = markdown?.match(/^---\n([\s\S]*?)\n---/)?.[1];
  return frontmatter?.match(/^published:\s*["']?(\d{4}-\d{2}-\d{2})/m)?.[1] ?? null;
}
