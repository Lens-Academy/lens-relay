import type { TimestampedWord, FormattedTimestamp } from './types';

/** Convert seconds to M:SS.mm format (e.g., 1:03.50) */
export function formatTimestamp(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}:${secs.toFixed(2).padStart(5, '0')}`;
}

/** Convert timestamped words to final timestamps.json format */
export function generateTimestampsJson(
  words: TimestampedWord[]
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
  video_id: string;
  body: string;
}

function yamlQuote(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** Generate markdown with YAML frontmatter */
export function generateMarkdown(params: MarkdownParams): string {
  const frontmatter = [
    '---',
    `title: ${yamlQuote(params.title)}`,
    `channel: ${yamlQuote(params.channel)}`,
    `url: ${yamlQuote(params.url)}`,
    `video_id: ${yamlQuote(params.video_id)}`,
    '---',
  ].join('\n');

  return frontmatter + '\n\n' + params.body + '\n';
}

/** Generate filename base: lowercase, hyphenated, no special chars, with video_id for uniqueness */
export function generateFilenameBase(
  channel: string,
  title: string,
  videoId?: string
): string {
  // Remove channel name suffix from title if present
  const channelSuffix = new RegExp(
    `\\s*[-–—]\\s*${escapeRegex(channel)}\\s*$`,
    'i'
  );
  let cleanTitle = title.replace(channelSuffix, '');

  // Combine channel and title
  let filename = `${channel}-${cleanTitle}`;

  // Remove special characters, replace spaces/underscores with hyphens
  filename = filename
    .toLowerCase()
    .replace(/[<>:"/\\|?*&]/g, '')
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  // Append video_id for uniqueness (handles non-ASCII title collisions)
  if (videoId) {
    filename = `${filename}-${videoId}`;
  }

  return filename;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
