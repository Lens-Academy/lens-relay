/**
 * An Iliad lens file: reading one back, and composing one.
 *
 * A lens is frontmatter, then segments. The sync writes two kinds: a Text
 * segment (`content::` and Lens markdown) and a Video segment (`source::` and
 * a link to the video's transcript). Two things in a lens do not come from
 * the source and are carried from the old file into the new one:
 *
 *   - reading cards (`::card[[lens|title]]`, alone or inside a
 *     `:::require_x_optional_lenses{x=1}` list), which a person adds below
 *     the text that names the readings;
 *   - which transcript a video belongs to.
 */

import { yamlQuote } from "../../yaml";
import { SYNC_MARKER_KEY } from "../../../shared/source-sync";
import { inert, linkTo, plainTitle, sourceLink } from "./layout";
import { setFrontmatter, splitFrontmatter } from "./module-file";
import type { Atom, AtomPart } from "./types";

/** The `synced_from.source` of every file this sync writes. */
export const ILIAD_SOURCE = "iliad";

// ------------------------------------------------------------------ reading

/**
 * Where a card stands: below the lines `after`, the `nth` time those lines
 * occur under its heading (0 for the first). `after` is the last line of
 * text before the card with the container fences (`:::`) that follow it:
 * a fence alone repeats too often to say where the card was. Empty lines
 * do not count. Null when the card opens a segment.
 */
export interface CardPlace {
  after: string[] | null;
  nth: number;
}

/** A card block as it stands in a lens. */
export interface FoundCard extends CardPlace {
  /** Index in `headings` of the heading it follows; -1 when it stands before the lens's first heading. */
  heading: number;
  /** The card line(s), or the whole `:::require_x_optional_lenses` list, as written. */
  block: string;
}

export interface LensBody {
  /**
   * What the lens shows, in order: the markdown of each Text segment with
   * the cards taken out, and the `source::` target of each Video segment as
   * written.
   */
  parts: ({ text: string } | { video: string })[];
  /** The text of each heading, in order: `\##`, `\###` and `\####` lines. */
  headings: string[];
  cards: FoundCard[];
  /** Segment types the sync does not write (a hand-added Chat, say). A rewrite drops them. */
  others: string[];
}

// A `#### <Type>` line outside a code block starts a segment. The sync
// writes every heading of the text escaped (`\####`), so it needs no list
// of Lens's segment types to tell the two apart.
const SEGMENT = /^####\s+([^:\n]+?)(?::.*)?\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^[\\!]?#{2,4}\s+(\S.*?)\s*$/;
const CARD = /^::card\[\[/;
const CARD_LIST = /^:{3,}\s*require_x_optional_lenses\b/;
const CONTAINER_OPEN = /^:{3,}\s*[\w-]/;
const CONTAINER_CLOSE = /^:{3,}\s*$/;

/** Marks the lines of `lines` that are code: a fence line or a line inside one (the CommonMark rule Lens uses). */
function codeLines(lines: string[]): boolean[] {
  let open: string | null = null;
  return lines.map((line) => {
    const marker = line.match(FENCE)?.[1];
    if (!marker) return open !== null;
    if (!open) open = marker;
    else if (marker[0] === open[0] && marker.length >= open.length && line.trim() === marker) open = null;
    return true;
  });
}

interface Segment {
  type: string;
  lines: string[];
}

function segmentsOf(body: string): Segment[] {
  const lines = body.split("\n");
  const code = codeLines(lines);
  const segments: Segment[] = [];
  lines.forEach((line, i) => {
    const type = code[i] ? undefined : line.match(SEGMENT)?.[1].trim().toLowerCase();
    if (type) segments.push({ type, lines: [] });
    else segments[segments.length - 1]?.lines.push(line);
  });
  return segments;
}

/** The lines of a Text segment's `content::` field. */
function contentLines(segment: Segment): string[] {
  const at = segment.lines.findIndex((line) => /^content::/.test(line));
  if (at === -1) return [];
  const inline = segment.lines[at].replace(/^content::\s*/, "");
  return [...(inline ? [inline] : []), ...segment.lines.slice(at + 1)];
}

/** Without the empty lines around it. Spaces that end its last line stay: the text is a copy. */
const trimBlankLines = (text: string): string => text.replace(/^(?:[ \t]*\n)+/, "").replace(/(?:\n[ \t]*)+$/, "");

const FENCE_LINE = /^\s*:{3,}/;

/** The lines a card that follows `lines` is placed below: the last line of text and the fences after it. */
function contextOf(lines: string[]): string[] | null {
  const context: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trimEnd();
    if (!line) continue;
    context.unshift(line);
    if (!FENCE_LINE.test(line)) break;
  }
  return context.length ? context : null;
}

/** The indexes in `lines` of each last line of `context` where the whole of it stands, empty lines between allowed. */
function occurrences(lines: string[], context: string[]): number[] {
  const ends: number[] = [];
  for (let end = 0; end < lines.length; end++) {
    let j = end;
    let k = context.length - 1;
    for (; k >= 0; k--, j--) {
      while (j >= 0 && !lines[j].trim() && k < context.length - 1) j--;
      if (j < 0 || lines[j].trimEnd() !== context[k]) break;
    }
    if (k < 0) ends.push(end);
  }
  return ends;
}

/** Read the body of a lens file (the part after its frontmatter). */
export function readLensBody(body: string): LensBody {
  const parts: LensBody["parts"] = [];
  const headings: string[] = [];
  const cards: FoundCard[] = [];
  const others: string[] = [];
  /** The text under the current heading so far, without cards. */
  let section: string[] = [];

  for (const segment of segmentsOf(body)) {
    if (segment.type === "video") {
      const source = sourceLink(segment.lines.join("\n"));
      if (source) parts.push({ video: source });
      continue;
    }
    if (segment.type !== "text") {
      others.push(segment.type);
      continue;
    }

    const lines = contentLines(segment);
    const code = codeLines(lines);
    const kept: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const heading = code[i] ? null : line.match(HEADING);
      if (heading) {
        headings.push(heading[1]);
        section = [];
      }

      let end = -1; // last line of the card block that starts here
      if (!code[i] && CARD_LIST.test(line)) {
        for (let j = i, depth = 0; j < lines.length; j++) {
          if (CONTAINER_OPEN.test(lines[j])) depth++;
          else if (CONTAINER_CLOSE.test(lines[j]) && --depth === 0) end = j;
          if (end !== -1) break;
        }
      } else if (!code[i] && CARD.test(line)) {
        end = i;
        for (let j = i + 1; j < lines.length && (CARD.test(lines[j]) || !lines[j].trim()); j++) {
          if (CARD.test(lines[j])) end = j;
        }
      }
      if (end === -1) {
        kept.push(line);
        section.push(line);
        continue;
      }
      const after = contextOf(kept);
      const nth = after ? occurrences(section, after).length - 1 : 0;
      cards.push({ heading: headings.length - 1, after, nth, block: lines.slice(i, end + 1).join("\n") });
      i = end;
      while (i + 1 < lines.length && !lines[i + 1].trim()) i++; // and the empty lines that set it apart
    }
    const text = trimBlankLines(kept.join("\n"));
    if (text) parts.push({ text });
  }
  return { parts, headings, cards, others };
}

// ---------------------------------------------------------------- composing

/** A card block and where it goes. */
export interface Card extends CardPlace {
  /** Anchor of the heading it follows; "" for text before the first heading. */
  anchor: string;
  block: string;
}

export interface LensFile {
  /** Where the file lives: its links are relative to this. */
  path: string;
  /** The file as it is now, for a lens that exists: its frontmatter keeps every field the sync does not own. */
  was: string | null;
  id: string;
  title: string;
  tldr: string | null;
  summaryForTutor: string | null;
  authors: string[];
  /** The worksheet's page. */
  sourceUrl: string;
  /** "<slug>#<anchor>": what the lens is pinned to. */
  key: string;
  fingerprint: string;
  /** The source commit of the run that last changed this file. */
  commit: string;
  atoms: Atom[];
  cards: Card[];
  /** YouTube id to the full path of the video's transcript, for the videos the course plays. */
  transcripts: ReadonlyMap<string, string>;
}

type Part = { text: string } | { video: Extract<AtomPart, { kind: "video" }> };

/** A YAML scalar as the hand import wrote names: bare when that is plainly safe, else double-quoted. */
function yamlName(value: string): string {
  return /^\p{L}[\p{L}\p{N} .,()'’&/-]*$/u.test(value) && !value.endsWith(" ") ? value : yamlQuote(value);
}

/**
 * The frontmatter of a lens file. The sync owns these fields and no others:
 *
 *   id, title, tldr, summary_for_tutor, authors, source_url, upstream_key,
 *   upstream_fingerprint, upstream_commit, synced_from,
 *   provenance_recorded_at (the hand import's date; the commit replaces it)
 *
 * Every other field of the file as it was (tags, duration_minutes,
 * sidebar_author: what a person or another tool put there) stays as
 * written, where it stands. What the sync writes comes from the source
 * site, so each value is made inert first (layout.ts).
 */
function frontmatter(lens: LensFile): string {
  const quoted = (value: string) => yamlQuote(inert(value));
  const url = inert(lens.sourceUrl);
  const anchor = lens.atoms[0]?.anchor;
  const authors = lens.authors.map(plainTitle).filter(Boolean);
  return setFrontmatter(lens.was === null ? "" : splitFrontmatter(lens.was).head, {
    id: `id: '${lens.id}'`,
    title: `title: ${quoted(lens.title)}`,
    tldr: lens.tldr ? `tldr: ${quoted(lens.tldr)}` : null,
    summary_for_tutor: lens.summaryForTutor ? `summary_for_tutor: ${quoted(lens.summaryForTutor)}` : null,
    authors: authors.length ? ["authors:", ...authors.map((name) => `  - ${yamlName(name)}`)].join("\n") : null,
    source_url: `source_url: ${/^[\w.:/~+-]+$/.test(url) ? url : yamlQuote(url)}`,
    upstream_key: `upstream_key: ${quoted(lens.key)}`,
    upstream_fingerprint: `upstream_fingerprint: ${quoted(lens.fingerprint)}`,
    upstream_commit: `upstream_commit: '${lens.commit}'`,
    [SYNC_MARKER_KEY]: [`${SYNC_MARKER_KEY}:`, `  source: ${yamlQuote(ILIAD_SOURCE)}`, `  url: ${quoted(anchor ? `${url}#${anchor}` : url)}`].join("\n"),
    provenance_recorded_at: null,
  }).replace(/\n?$/, "\n");
}

/** Put `card` back below the line it followed; false when that line is not in `parts`. */
/**
 * Put `card` back below its lines: their nth occurrence in `parts`, or the
 * last when the text has fewer now. False when they are not in `parts`.
 */
function placeAfterLines(parts: Part[], card: Card): boolean {
  if (card.after === null) return false;
  const found = parts.flatMap((part) => ("text" in part ? occurrences(part.text.split("\n"), card.after!).map((at) => ({ part, at })) : []));
  const where = found[Math.min(card.nth, found.length - 1)];
  if (!where) return false;
  const lines = where.part.text.split("\n");
  const next = lines[where.at + 1];
  lines.splice(where.at + 1, 0, "", ...card.block.split("\n"), ...(next?.trim() ? [""] : []));
  where.part.text = lines.join("\n");
  return true;
}

function placeAtEnd(parts: Part[], card: Card): void {
  const last = [...parts].reverse().find((part): part is { text: string } => "text" in part);
  if (last) last.text = `${trimBlankLines(last.text)}\n\n${card.block}`;
  else parts.push({ text: card.block });
}

/** The titles of the cards in a card block, for a person to recognise it: "CEV", "Corrigibility". */
export function cardNames(block: string): string {
  return [...block.matchAll(/^::card\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/gm)].map((m) => `"${(m[2] ?? m[1]).trim()}"`).join(", ");
}

/**
 * The lens file for `lens`. Text parts that follow each other become one
 * Text segment; a video becomes a Video segment when its transcript is
 * known. A card goes back under its heading, below the lines it followed;
 * when the lines are gone, below the card it followed there, or else at the
 * end of that heading's text; when the heading is gone too, the same within
 * the whole lens.
 *
 * Two things can be missing and still give a file Lens accepts:
 *   - No transcript for a video: Lens can only play a video through its
 *     transcript, and the sync knows the transcripts of the videos the
 *     course's lenses already play. For any other video the lens gets a
 *     link to YouTube in the text, and the run a warning that says how a
 *     person makes it play.
 *   - No tldr or summary: the field is left out. Lens warns "missing a
 *     tldr", which is true and is how the gap gets noticed; an invented
 *     summary would hide it.
 */
export function composeLens(lens: LensFile): { content: string; warnings: string[] } {
  const warnings: string[] = [];
  const sections = lens.atoms.map((atom) => ({
    anchor: atom.anchor,
    parts: atom.parts.map((part): Part => (part.kind === "text" ? { text: part.markdown } : { video: part })),
  }));
  const all = (): Part[] => sections.flatMap((section) => section.parts);

  let previous: Card | undefined;
  for (const card of lens.cards) {
    const home = sections.find((section) => section.anchor === card.anchor) ?? sections[sections.length - 1];
    if (!home) continue;
    const underHeading = home.anchor === card.anchor;
    const before = previous;
    previous = card;
    if (placeAfterLines(underHeading ? home.parts : all(), card)) continue;
    // Its lines are gone, but the card before it stood under the same heading: it stays in that group.
    const group = before?.anchor === card.anchor ? before.block.split("\n").map((line) => line.trimEnd()).filter(Boolean) : null;
    if (group && placeAfterLines(home.parts, { ...card, after: group, nth: 0 })) continue;
    placeAtEnd(home.parts, card);
    warnings.push(
      `The lens "${lens.title}" (${lens.path}) has a card whose place is gone from the text: the source changed the lines it stood below. It now stands at the end of its section: ${cardNames(card.block)}. To do: check that it is in the right place, and move it by hand if not; the sync keeps it where it is put.`,
    );
  }

  const segments: string[] = [];
  let text: string[] = [];
  const endText = () => {
    if (text.length) segments.push(`#### Text\ncontent::\n${text.join("\n\n")}\n`);
    text = [];
  };
  for (const part of all()) {
    if ("text" in part) {
      const markdown = trimBlankLines(part.text);
      if (markdown) text.push(markdown);
      continue;
    }
    const transcript = lens.transcripts.get(part.video.youtubeId);
    const url = `https://www.youtube.com/watch?v=${part.video.youtubeId.replace(/[^\w-]/g, "")}`; // an id is letters, digits, "-" and "_"
    if (transcript) {
      endText();
      segments.push(`#### Video\nsource:: [[${linkTo(lens.path, transcript)}]]\n`);
    } else {
      text.push(`[Video: ${plainTitle(part.video.title ?? "") || "watch on YouTube"}](${url})`);
      warnings.push(
        `The lens "${lens.title}" (${lens.path}) links to the video ${url} and does not play it, because no lens of the course uses a transcript of that video yet. ` +
          `To make it play: import the video into Lens Edu, then add a "#### Video" segment with "source:: [[<its transcript>]]" at the end of this lens. The next run puts the video in its place.`,
      );
    }
  }
  endText();

  return { content: `${frontmatter(lens)}\n${segments.join("\n")}`, warnings };
}
