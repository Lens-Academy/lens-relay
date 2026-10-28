/**
 * Module and course files as the sync sees them: frontmatter, then blocks,
 * one per heading. A block's text is kept as written, so everything the sync
 * does not understand (meetings, fields, learning outcomes, blank lines)
 * comes back out unchanged. The sync adds blocks, removes blocks, and
 * rewrites the links of files that moved.
 */

import { parse as parseYaml } from "yaml";
import { linkTarget, sourceLink } from "./layout";

export interface MarkdownFile {
  /** The frontmatter with its two fences, as written; "" when there is none. */
  head: string;
  data: Record<string, unknown>;
  body: string;
}

/** Split a file at its frontmatter. Throws on frontmatter that is not a YAML mapping. */
export function splitFrontmatter(content: string): MarkdownFile {
  const text = content.replace(/\r\n/g, "\n");
  const match = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) return { head: "", data: {}, body: text };
  const data: unknown = parseYaml(match[1]) ?? {};
  if (typeof data !== "object" || Array.isArray(data)) throw new Error("frontmatter is not a list of fields");
  return { head: match[0], data: data as Record<string, unknown>, body: text.slice(match[0].length) };
}

const TOP_LEVEL_KEY = /^(?:"([^"]+)"|'([^']+)'|([^\s:#"'-][^:]*?))\s*:(?:\s|$)/;

/**
 * `head` with the fields in `fields` set, and every other field left as
 * written, where it stands. A value is the field's whole text: "key: value",
 * or several lines for a list. A field that is there is replaced in its
 * place; one that is not is added last, in the order given; null takes a
 * field out.
 */
export function setFrontmatter(head: string, fields: Record<string, string | null>): string {
  const written = head.match(/^---\n([\s\S]*?)\n---(\n?)$/);
  // Each field with the lines under it (a list, a comment); `key` is null for lines before the first field.
  const entries: { key: string | null; lines: string[] }[] = [];
  for (const line of written ? written[1].split("\n") : []) {
    const match = line.match(TOP_LEVEL_KEY);
    if (match) entries.push({ key: match[1] ?? match[2] ?? match[3], lines: [line] });
    else if (entries.length) entries[entries.length - 1].lines.push(line);
    else entries.push({ key: null, lines: [line] });
  }
  const set = new Set<string>();
  const lines = entries.flatMap(({ key, lines: own }) => {
    if (key === null || !(key in fields)) return own;
    if (set.has(key)) return []; // a field written twice: once is enough
    set.add(key);
    return fields[key] ?? [];
  });
  for (const [key, text] of Object.entries(fields)) if (text !== null && !set.has(key)) lines.push(text);
  return `---\n${lines.join("\n")}\n---${written ? written[2] : "\n"}`;
}

/** A frontmatter string field, or null. */
export function field(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === "string" && value.trim() ? value : null;
}

export interface Block {
  /** The heading's type in lower case ("lens", "submodule", "module", "meeting"); "" for text before the first heading. */
  type: string;
  title: string;
  /** The block as written: its heading line, then everything up to the next heading. */
  raw: string;
}

const HEADING = /^#{1,6}\s+([^:\n]+?)(?::[ \t]*(.*?))?\s*$/;

export function parseBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  for (const line of body.split(/(?<=\n)/)) {
    const heading = line.match(HEADING);
    if (heading) blocks.push({ type: heading[1].trim().toLowerCase(), title: (heading[2] ?? "").trim(), raw: line });
    else if (blocks.length) blocks[blocks.length - 1].raw += line;
    else blocks.push({ type: "", title: "", raw: line });
  }
  return blocks;
}

const TITLE_LINK = /^!?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/;

/**
 * Full path of the file a block of `file` brings in: the `source::` of a
 * module's `# Lens:`, the link in the title of a course's `# Module:`. Null
 * for every other block, and for a lens written into the module itself.
 */
export function blockFile(block: Block, file: string): string | null {
  const link = block.type === "lens" ? sourceLink(block.raw) : block.type === "module" ? block.title.match(TITLE_LINK)?.[1] : null;
  return link ? linkTarget(file, link) : null;
}

/** The number of `#` of a block's heading; 1 for a block that has none. */
export const headingLevel = (raw: string): number => raw.match(/^(#{1,6})\s/)?.[1].length ?? 1;

/** `raw` with its heading at `level`. */
export const atLevel = (raw: string, level: number): string => raw.replace(/^#{1,6}(?=\s)/, "#".repeat(level));

// Pending CriticMarkup suggestions, each with the text it has while nobody
// has accepted it: an addition is not there yet, a deletion is, a
// substitution has its old text. Comments and highlights are not changes and
// stay. The forms and their metadata prefix (`{"author":..}@@`) are those of
// lens-platform's publisher (content_processor criticmarkup-forms.ts); the
// editor's parser (src/lib/criticmarkup-parser.ts) reads the same forms, but
// the server does not ship the editor's code. An addition ends at its first
// "++}", so its prefix may not end in "++".
const SUGGESTIONS: [RegExp, string][] = [
  [/\{\+\+(?:\{[^}]*(?<!\+\+)\}@@)?.*?\+\+\}/gs, ""],
  [/\{--(?:\{[^}]*\}@@)?(.*?)--\}/gs, "$1"],
  [/\{~~(?:\{[^}]*\}@@)?(.*?)~>(.*?)~~\}/gs, "$1"],
];

/**
 * A file as Lens publishes it: every pending suggestion rejected. The sync
 * reads its files this way, because that is what learners see; a file it
 * rewrites loses its pending suggestions.
 */
export const withoutSuggestions = (text: string): string => SUGGESTIONS.reduce((out, [re, kept]) => out.replace(re, kept), text);

/** `raw` ending in an empty line, so that a new block can follow it. */
export function spaced(raw: string): string {
  return raw.endsWith("\n\n") ? raw : `${raw.replace(/\n+$/, "")}\n\n`;
}

export const lensEntry = (title: string, link: string): string => `# Lens: ${title}\nsource:: [[${link}]]\n\n`;
export const submoduleHeading = (title: string): string => `# Submodule: ${title}\n\n`;
export const moduleLine = (title: string, link: string): string => `# Module: [[${link}|${title}]]\n`;
