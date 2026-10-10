import { retypeFootnotes } from "./footnote-typing";
import { applyHeadingAnchors } from "./heading-anchors";
import { normalizeTables } from "./table-repair";

export interface NormalizationSample {
  before: string;
  after: string;
}

export interface NormalizationChange {
  code: string;
  count: number;
  samples: NormalizationSample[];
}

const MAX_SAMPLES_PER_CHANGE = 5;
const MAX_SAMPLE_CHARS = 512;

function boundedSample(value: string): string {
  return value.length <= MAX_SAMPLE_CHARS
    ? value
    : `${value.slice(0, MAX_SAMPLE_CHARS - 1)}…`;
}

interface Segment {
  text: string;
  eligible: boolean;
}

function closingFenceEnd(source: string, start: number, marker: string): number {
  const openingEnd = source.indexOf("\n", start);
  if (openingEnd < 0) return source.length;
  const close = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[^\\r\\n]*(?:\\r?\\n|$)`, "gm");
  close.lastIndex = openingEnd + 1;
  const match = close.exec(source);
  return match ? match.index + match[0].length : source.length;
}

/** Split Markdown into ranges where conservative textual repairs are safe.
 * Fenced/inline code, paired Obsidian comments, CriticMarkup, and math are
 * opaque. Delimiter matching is intentionally conservative: an unclosed
 * construct protects the rest of the source instead of risking a rewrite. */
function sourceSegments(source: string): Segment[] {
  const segments: Segment[] = [];
  const push = (text: string, eligible: boolean) => {
    if (!text) return;
    const previous = segments.at(-1);
    if (previous?.eligible === eligible) previous.text += text;
    else segments.push({ text, eligible });
  };
  let plainStart = 0;
  let index = 0;
  const protect = (end: number) => {
    push(source.slice(plainStart, index), true);
    push(source.slice(index, end), false);
    index = end;
    plainStart = end;
  };

  while (index < source.length) {
    const lineStart = index === 0 || source[index - 1] === "\n";
    if (lineStart) {
      const fence = source.slice(index).match(/^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/);
      if (fence) {
        protect(closingFenceEnd(source, index, fence[1]));
        continue;
      }
    }

    if (source.startsWith("%%", index)) {
      const close = source.indexOf("%%", index + 2);
      protect(close < 0 ? source.length : close + 2);
      continue;
    }

    const critic = ([
      ["{++", "++}"],
      ["{--", "--}"],
      ["{==", "==}"],
      ["{>>", "<<}"],
      ["{~~", "~~}"],
    ] as const).find(([open]) => source.startsWith(open, index));
    if (critic) {
      const close = source.indexOf(critic[1], index + critic[0].length);
      protect(close < 0 ? source.length : close + critic[1].length);
      continue;
    }

    if (source[index] === "`") {
      const run = source.slice(index).match(/^`+/)![0];
      const close = source.indexOf(run, index + run.length);
      protect(close < 0 ? source.length : close + run.length);
      continue;
    }

    const escapedMath = source.startsWith("\\(", index)
      ? "\\)"
      : source.startsWith("\\[", index)
        ? "\\]"
        : undefined;
    if (escapedMath) {
      const close = source.indexOf(escapedMath, index + 2);
      protect(close < 0 ? source.length : close + 2);
      continue;
    }

    // `\$$x$` is a literal dollar followed by inline math, not a display opener.
    if (source.startsWith("$$", index) && source[index - 1] !== "\\") {
      const close = source.indexOf("$$", index + 2);
      protect(close < 0 ? source.length : close + 2);
      continue;
    }
    if (source[index] === "$" && source[index - 1] !== "\\") {
      let close = index + 1;
      while ((close = source.indexOf("$", close)) >= 0 && source[close - 1] === "\\") close += 1;
      if (close >= 0) {
        protect(close + 1);
        continue;
      }
    }
    index += 1;
  }
  push(source.slice(plainStart), true);
  return segments;
}

const LIST_ITEM_LINE = /^( {0,3}(?:[-*+]|\d{1,9}[.)]) +)(?!\*)(\S[^\r\n]*?)(?=\r?$)/gm;
const BOLD_RUN = /(?<![\\*])\*\*(?!\*)/g;

/**
 * Datalab's PDF Markdown sometimes drops the `**` that opens a list item
 * (`- 2** IAEA Safeguards`, `- Prover Side:**`). A first `**` that sits after
 * text and before a space or the line end can only close, so it renders as
 * literal asterisks. Restore the opener at the start of the item (up to three
 * spaces of indent, so indented code is never touched). Datalab PDF bodies
 * only (HTML goes through turndown, which never drops one), and only when the
 * run count is odd and the text before the orphan is plain (no other
 * emphasis, code or link), so the guess cannot over-bold marked-up text.
 */
function repairListItemBoldOpener(marker: string, rest: string): string {
  const runs = [...rest.matchAll(BOLD_RUN)];
  if (runs.length % 2 === 0) return marker + rest;
  const first = runs[0].index!;
  const before = rest[first - 1];
  const after = rest[first + 2];
  if (!before || /\s/.test(before) || (after !== undefined && !/\s/.test(after))) return marker + rest;
  if (/[*_`~[\]]/.test(rest.slice(0, first))) return marker + rest;
  return `${marker}**${rest}`;
}

/** A protected segment that starts with inline math (`$x$`, not `$$`). */
function startsWithInlineMath(segment: Segment | undefined): boolean {
  return !!segment && !segment.eligible && /^\$(?!\$)/.test(segment.text);
}

/** A protected segment that ends with inline math (`$x$`, not `$$` or `\$`). */
function endsWithInlineMath(segment: Segment | undefined): boolean {
  return !!segment && !segment.eligible && /(?<![$\\])\$$/.test(segment.text);
}

/**
 * Datalab's PDF Markdown pads inline math with spaces: "Let  $M$  be",
 * "Max-of- $K$ , validation". The doubled spaces collapse in HTML, but a space
 * glued to a hyphen, an opening bracket or closing punctuation shows ("Max-of-
 * K , validation"). Trim the padding where the PDF had none, for the text on
 * each side of an inline formula. Prose spacing elsewhere is untouched, and a
 * single space between words and math stays.
 */
function trimInlineMathPadding(
  text: string,
  mathBefore: boolean,
  mathAfter: boolean,
): string {
  let out = text;
  if (mathBefore) {
    // "$K$ , x" -> "$K$, x"; "$K$  be" -> "$K$ be".
    // Not before an image (`![`), and not `$0$ .5` or `$1$ ,000`, where the
    // space may be all that keeps a number from reading differently.
    out = out.replace(/^ +(?=[;:?)\]]|[.,](?!\d)|!(?!\[))/, "").replace(/^ {2,}(?=\S)/, " ");
  }
  if (mathAfter) {
    // "Max-of- $K$" -> "Max-of-$K$"; "( $x$" -> "($x$"; "Let  $M$" -> "Let $M$".
    out = out
      .replace(/(?<=\w-) +$/, "")
      .replace(/(?<=[([]) +$/, "")
      .replace(/(?<=\S) {2,}$/, " ");
  }
  // Only spaces between two formulas: "$a$  $b$" -> "$a$ $b$".
  if (mathBefore && mathAfter && /^ {2,}$/.test(text)) out = " ";
  return out;
}

/** What may precede a block on its line: indentation and blockquote markers. */
const BLOCK_PREFIX = /^(?:[ \t]*>)*[ \t]*$/;

/**
 * Lens wants an article's display math fenced, `$$` alone on the lines above
 * and below the TeX (platform validator: article.math-display-delimiter-placement).
 * The HTML converter writes `$$tex$$` on one line, so a paper with hundreds of
 * equations reached the reviewer with hundreds of errors to fix by hand.
 * Rewrites a `$$…$$` math segment only when it is a block of its own (nothing
 * but indentation or `>` before it on its line, nothing after it), keeping the
 * prefix on the new lines. Display math inside a paragraph or a table row is
 * left alone: moving it would change the text around it.
 */
function fenceDisplayMath(math: string, before: string | undefined, after: string | undefined): string {
  const m = /^\$\$([\s\S]*)\$\$$/.exec(math);
  if (!m) return math;
  // Already fenced (`$$` alone on its lines): leave it, prefixes and all.
  if (/^[ \t]*\r?\n[\s\S]*\n[ \t>]*$/.test(m[1])) return math;
  const tex = m[1].trim();
  // Adjacent opaque ranges are merged into one segment; never split those.
  if (!tex || tex.includes("$$")) return math;
  const lines = (before ?? "").split("\n");
  const prefix = lines[lines.length - 1];
  if (!BLOCK_PREFIX.test(prefix)) return math;
  // A block of its own: a blank line (or the document edge) on both sides,
  // so the rewrite never pulls an equation out of a paragraph.
  if (lines.length > 1 && !BLOCK_PREFIX.test(lines[lines.length - 2])) return math;
  if (after !== undefined && !/^[ \t]*(?:\r?\n(?:[ \t>]*(?:\r?\n|$))|$)/.test(after)) return math;
  // Inside a blockquote or list, continuation lines of multi-line TeX already
  // carry the container prefix (the converter indents every line); only the
  // first line needs it. If any continuation line lacks it, leave the math be.
  const [first, ...rest] = tex.split("\n");
  // An indentation-only prefix (a list item) must be there whole; a quote
  // prefix may lose its trailing space ("> " vs ">").
  const need = /^[ \t]+$/.test(prefix) ? prefix : prefix.replace(/[ \t]+$/, "");
  if (prefix && rest.some((line) => !line.startsWith(need))) return math;
  return `$$\n${prefix}${first}${rest.length ? `\n${rest.join("\n")}` : ""}\n${prefix}$$`;
}

/** Idempotent, syntax-aware, semantics-preserving repairs only. */
export function normalizeArticleBody(
  body: string,
  sourceUrl: string,
  opts: { pdf?: boolean } = {},
): {
  body: string;
  changes: NormalizationChange[];
} {
  const changes = new Map<string, NormalizationChange>();
  const record = (code: string, before: string, after: string) => {
    const change = changes.get(code) ?? { code, count: 0, samples: [] };
    change.count += 1;
    if (change.samples.length < MAX_SAMPLES_PER_CHANGE) {
      change.samples.push({ before: boundedSample(before), after: boundedSample(after) });
    }
    changes.set(code, change);
  };

  const segments = sourceSegments(body);
  // Offsets into `body`, so a segment's surroundings can be read whole (an
  // inline-math segment right before a display segment must count as text).
  const starts: number[] = [];
  segments.reduce((offset, segment) => {
    starts.push(offset);
    return offset + segment.text.length;
  }, 0);
  const transformed = segments.map((segment, i) => {
    if (!segment.eligible) {
      // Empty escaped inline math is the one math construct known to be pure
      // conversion residue. It is handled here, after code/comments won.
      if (/^\\\(\s*\\\)$/.test(segment.text)) {
        record("normalize.empty-inline-math", segment.text, "");
        return "";
      }
      const start = starts[i];
      const end = start + segment.text.length;
      const fenced = fenceDisplayMath(
        segment.text,
        i > 0 ? body.slice(Math.max(0, start - 2_000), start) : undefined,
        i < segments.length - 1 ? body.slice(end, end + 2_000) : undefined,
      );
      if (fenced !== segment.text) record("normalize.display-math-fences", segment.text, fenced);
      return fenced;
    }
    let out = segment.text;
    if (opts.pdf) {
      // Indented code is not protected by sourceSegments; leave its lines alone,
      // also behind blockquote and list markers ("-     a = f( $x$ )").
      const indented = (offset: number) =>
        /^(?:[ \t]*>)*(?:[ \t]*(?:[-*+]|\d{1,9}[.)]))?(?: {4}|\t)/.test(
          body.slice(body.lastIndexOf("\n", offset - 1) + 1),
        );
      const end = starts[i] + out.length;
      const trimmed = trimInlineMathPadding(
        out,
        endsWithInlineMath(segments[i - 1]) && !indented(starts[i]),
        startsWithInlineMath(segments[i + 1]) && !indented(end),
      );
      if (trimmed !== out) {
        record("normalize.pdf-inline-math-padding", out, trimmed);
        out = trimmed;
      }
    }
    out = out.replace(
      /(!?\[[^\]\r\n]*\]\()\/(?!\/)([^)\s]+)(\))/g,
      (whole, open: string, destination: string, close: string) => {
        try {
          const replacement = `${open}${new URL(`/${destination}`, sourceUrl).href}${close}`;
          record("normalize.root-relative-destination", whole, replacement);
          return replacement;
        } catch {
          return whole;
        }
      },
    );
    out = out.replace(/^Posted in:[ \t]*(?:,[ \t]*)*(?=\r?$)/gm, (whole) => {
      record("normalize.empty-posted-in", whole, "");
      return "";
    });
    // `^` also matches where a protected range (code, math) ended mid-line.
    const atLineStart = i === 0 || segments[i - 1].text.endsWith("\n");
    out = out.replace(LIST_ITEM_LINE, (whole: string, marker: string, rest: string, offset: number) => {
      if (!opts.pdf || (offset === 0 && !atLineStart)) return whole;
      // A line that runs on into a protected range (code, math) is not seen whole.
      if (offset + whole.length === out.length && i < segments.length - 1) return whole;
      const replacement = repairListItemBoldOpener(marker, rest);
      if (replacement === whole) return whole;
      record("normalize.list-item-bold-opener", whole, replacement);
      return replacement;
    });
    return out;
  });

  // Footnote id typing runs as a second whole-document pass: renaming a
  // reference+definition group needs cross-line pairing that the segment
  // transforms above cannot express.
  const typed = retypeFootnotes(transformed.join(""));
  // Heading block IDs are a third whole-document pass for the same reason: a
  // link is rewritten against headings that may be defined anywhere in the
  // document, so every heading must be seen before any link is resolved.
  const anchored = applyHeadingAnchors(typed.body);
  // Table repairs are line-based and must see whole rows, including the maths
  // inside them that the segment pass above treats as opaque.
  const tables = normalizeTables(anchored.body);
  return {
    body: tables.body,
    changes: [...changes.values(), ...typed.changes, ...anchored.changes, ...tables.changes],
  };
}
