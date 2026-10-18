import { yamlQuote } from "../yaml";
import { ARTICLE_DISCUSSION_PROMPT } from "../add-article/export";
import { VIDEO_STUB } from "../add-article/stub";
import type { TimestampedWord, FormattedTimestamp } from "./types";

/** Convert seconds to M:SS.mm format (e.g., 1:03.50) */
export function formatTimestamp(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}:${secs.toFixed(2).padStart(5, "0")}`;
}

/** Convert timestamped words to final timestamps.json format */
export function generateTimestampsJson(
  words: TimestampedWord[],
): FormattedTimestamp[] {
  return words.map((w) => ({
    text: w.text,
    start: formatTimestamp(w.start),
  }));
}

interface MarkdownParams {
  title: string;
  channel: string;
  url: string;
  body: string;
  /** %% comment blocks written between the frontmatter and the transcript,
   *  where people discuss the video (ARTICLE_DISCUSSION_PROMPT for a new one). */
  discussionBlocks?: string;
  tags?: string[];
}

/** Generate markdown with YAML frontmatter */
export function generateMarkdown(params: MarkdownParams): string {
  const lines = [
    "---",
    `title: ${yamlQuote(params.title)}`,
    `channel: ${yamlQuote(params.channel)}`,
    `url: ${yamlQuote(params.url)}`,
  ];
  if (params.tags?.length) {
    lines.push("tags:", ...params.tags.map((tag) => `  - ${yamlQuote(tag)}`));
  }
  lines.push("---");
  const parts = [lines.join("\n"), params.discussionBlocks, params.body.trim()]
    .filter(Boolean);
  return parts.join("\n\n") + "\n";
}

/**
 * A video's file before (or without) its transcript: the frontmatter and a
 * discussion area. A later full import fills the transcript in under the
 * notes (parsePromotableStub with VIDEO_STUB).
 */
export function generateVideoStubMarkdown(params: {
  title: string;
  channel: string;
  url: string;
}): string {
  return generateMarkdown({
    ...params,
    body: "",
    discussionBlocks: ARTICLE_DISCUSSION_PROMPT,
    tags: [VIDEO_STUB.tag, "validator-ignore"],
  });
}

/** Generate filename base: lowercase, hyphenated, no special chars */
export function generateFilenameBase(channel: string, title: string): string {
  // Remove channel name suffix from title if present
  const channelSuffix = new RegExp(
    `\\s*[-–—]\\s*${escapeRegex(channel)}\\s*$`,
    "i",
  );
  const cleanTitle = title.replace(channelSuffix, "");

  // Combine channel and title
  let filename = `${channel}-${cleanTitle}`;

  // Remove special characters, replace spaces/underscores with hyphens
  filename = filename
    .toLowerCase()
    .replace(/[<>:"/\\|?*&]/g, "")
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return filename;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
