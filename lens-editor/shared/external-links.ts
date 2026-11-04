/**
 * External link rules v1: which links a Markdown page holds, and which pages
 * get the import-and-link offer. The relay has the same scanner
 * (crates/y-sweet-core/src/external_links.rs). Both run
 * shared/external-link-cases.json, and the numbers below are the rules in
 * docs/plans/2026-11-02-import-and-link-sources.md.
 */

export type ExternalLinkForm = "inline" | "autolink" | "bare";

export interface ExternalLink {
  url: string;
  /** The link text of an inline link; null for an autolink or bare URL. */
  label: string | null;
  form: ExternalLinkForm;
  /** Offsets of the whole link in the text. */
  start: number;
  end: number;
  inTable: boolean;
  /** Whether it can become a wikilink without losing anything. */
  swappable: boolean;
}

const SCHEME_RE = /^https?:\/\//i;
const AUTOLINK_RE = /^<(https?:\/\/[^\s<>]+)>/i;
const HTML_TAG_RE = /^<\/?[a-zA-Z][^<>]*>/;
const RAW_TEXT_OPEN_RE = /^<(?:pre|code|script|style)[ \t\r\n>]/i;
const RAW_TEXT_CLOSE_RE = /<\/(?:pre|code|script|style)[ \t\r\n]*>/gi;
const INDENTED_RE = /^(?: {4}| {0,3}\t)/;
const LIST_ITEM_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]/;
const FENCE_RE = /^[ \t>]*(`{3,}|~{3,})(.*)$/;
const REFERENCE_RE = /^ {0,3}\[[^\]\n]+\]:\s/;
const CRITIC_CLOSERS: Record<string, string> = {
  "{++": "++}",
  "{--": "--}",
  "{~~": "~~}",
  "{==": "==}",
  "{>>": "<<}",
};

/** A GFM delimiter row (`--- | ---`, `|:--|--:|`), in a quote or not. */
function isDelimiterRow(line: string): boolean {
  const row = line.replace(/^[ \t>]*/, "");
  return row.includes("|") && row.includes("-") && /^[|\-: \t]*$/.test(row);
}

/** What the line-by-line pass found: the skipped regions, by where they start
 *  (rule 3), and the starts of table lines, outer pipes or not (rule 8). A
 *  fence may be indented any amount and sit in a quote or callout. */
function blockRegions(text: string): { regions: Map<number, number>; tableLines: Set<number> } {
  const regions = new Map<number, number>();
  const tableLines = new Set<number>();
  let inTable = false;
  let pipeLine: number | null = null;
  let offset = 0;

  if (/^---\r?\n/.test(text)) {
    const close = /\n---[ \t]*(?:\r?\n|$)/.exec(text.slice(3));
    if (close) {
      offset = 3 + close.index + close[0].length;
      regions.set(0, offset);
    }
  }

  let fence: { char: string; length: number; from: number } | null = null;
  let indented: number | null = null;
  let afterBlank = true;
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    const end = newline === -1 ? text.length : newline + 1;
    const line = text.slice(offset, end).replace(/\r?\n$/, "");
    const blank = !line.trim();
    if (indented !== null && !blank && !INDENTED_RE.test(line)) {
      regions.set(indented, offset);
      indented = null;
    }
    const match = FENCE_RE.exec(line);
    if (indented !== null) {
      // Still in the indented block.
    } else if (fence) {
      if (match && match[1][0] === fence.char && match[1].length >= fence.length && !match[2].trim()) {
        regions.set(fence.from, end);
        fence = null;
      }
    } else if (match && !(match[1][0] === "`" && match[2].includes("`"))) {
      fence = { char: match[1][0], length: match[1].length, from: offset };
    } else if (REFERENCE_RE.test(line)) {
      regions.set(offset, end);
    } else if (afterBlank && !blank && INDENTED_RE.test(line) && !LIST_ITEM_RE.test(line)) {
      indented = offset;
    } else {
      const hasPipe = line.includes("|");
      if (inTable && (blank || !hasPipe)) inTable = false;
      if (inTable) {
        tableLines.add(offset);
      } else if (isDelimiterRow(line) && pipeLine !== null) {
        tableLines.add(pipeLine);
        tableLines.add(offset);
        inTable = true;
      }
      pipeLine = !blank && hasPipe ? offset : null;
      afterBlank = blank;
      offset = end;
      continue;
    }
    inTable = false;
    pipeLine = null;
    afterBlank = blank;
    offset = end;
  }
  if (fence) regions.set(fence.from, text.length);
  if (indented !== null) regions.set(indented, text.length);
  return { regions, tableLines };
}

/** Index just past a `[…]` label that starts at `open`, on one line, or -1. */
function labelEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\n") return -1;
    if (char === "\\") i += 1;
    else if (char === "[") depth += 1;
    else if (char === "]" && --depth === 0) return i + 1;
  }
  return -1;
}

/** The URL of the `(…)` at `open`, the index past it, and whether it has a
 *  title (rule 4). */
function destination(text: string, open: number): { url: string; end: number; titled: boolean } | null {
  let i = open + 1;
  while (text[i] === " " || text[i] === "\t") i += 1;
  let url = "";
  if (text[i] === "<") {
    const close = text.indexOf(">", i);
    if (close === -1) return null;
    url = text.slice(i + 1, close);
    i = close + 1;
  } else {
    const from = i;
    let depth = 0;
    for (; i < text.length; i += 1) {
      const char = text[i];
      if (/\s/.test(char)) break;
      if (char === "\\") i += 1;
      else if (char === "(") depth += 1;
      else if (char === ")") {
        if (depth === 0) break;
        depth -= 1;
      }
    }
    url = text.slice(from, i);
  }
  while (text[i] === " " || text[i] === "\t") i += 1;
  const quote = text[i];
  const titled = quote === '"' || quote === "'" || quote === "(";
  if (titled) {
    const close = text.indexOf(quote === "(" ? ")" : quote, i + 1);
    if (close === -1) return null;
    i = close + 1;
    while (text[i] === " " || text[i] === "\t") i += 1;
  }
  return text[i] === ")" ? { url, end: i + 1, titled } : null;
}

/** A bare URL's end after rule 5's stops and trims. */
function bareEnd(text: string, start: number): number {
  let end = start;
  while (end < text.length && !/[\s<>"`|[\]{}“”‘’«»。，、—–]/.test(text[end])) end += 1;
  for (;;) {
    const last = text[end - 1];
    if (".,;:!?'*_~".includes(last)) end -= 1;
    else if (last === ")") {
      const body = text.slice(start, end);
      if (body.split(")").length <= body.split("(").length) break;
      end -= 1;
    } else break;
  }
  return end;
}

function isInTable(text: string, tableLines: Set<number>, offset: number): boolean {
  const lineStart = offset === 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1;
  return tableLines.has(lineStart) || /^[\s>]*\|/.test(text.slice(lineStart, offset));
}

/** A label a wikilink alias would show as typed (rule 7). */
const LABEL_MARKUP_RE = /[[\]|*`_~$<>]|==/;

/** Whether `offset` is where a link's destination starts: the end of a label
 *  that ran over a line, so the scanner never saw it as a label (rule 6). */
function followsLabel(text: string, offset: number): boolean {
  let i = offset;
  while (text[i - 1] === " " || text[i - 1] === "\t") i -= 1;
  return text.slice(Math.max(0, i - 2), i) === "](";
}

/** Past a code span whose opening run of `run` backticks starts at `open`, or
 *  past the run alone when nothing closes it before a blank line. */
function codeSpanEnd(text: string, open: number, run: number): number {
  const blank = text.indexOf("\n\n", open);
  const limit = blank === -1 ? text.length : blank;
  for (let i = open + run; i < limit; ) {
    if (text[i] !== "`") {
      i += 1;
      continue;
    }
    let close = i;
    while (text[close] === "`") close += 1;
    if (close - i === run) return close;
    i = close;
  }
  return open + run;
}

/** Every external link in a page, in document order. */
export function scanExternalLinks(text: string): ExternalLink[] {
  const { regions, tableLines } = blockRegions(text);
  const links: ExternalLink[] = [];
  // A link to a part of a page would lose the part (rule 7).
  const add = (url: string, label: string | null, form: ExternalLinkForm, start: number, end: number, swappable: boolean) =>
    links.push({ url, label, form, start, end, inTable: isInTable(text, tableLines, start), swappable: swappable && !url.includes("#") });

  let i = 0;
  while (i < text.length) {
    const region = regions.get(i);
    if (region !== undefined) {
      i = region;
      continue;
    }
    const char = text[i];
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (char === "`") {
      let run = i;
      while (text[run] === "`") run += 1;
      i = codeSpanEnd(text, i, run - i);
      continue;
    }
    if (text.startsWith("%%", i)) {
      const close = text.indexOf("%%", i + 2);
      i = close === -1 ? text.length : close + 2;
      continue;
    }
    const closer = CRITIC_CLOSERS[text.slice(i, i + 3)];
    if (closer) {
      const close = text.indexOf(closer, i + 3);
      i = close === -1 ? i + 3 : close + 3;
      continue;
    }
    if (text.startsWith("<!--", i)) {
      const close = text.indexOf("-->", i + 4);
      i = close === -1 ? text.length : close + 3;
      continue;
    }
    if (text.startsWith("[[", i)) {
      const close = text.indexOf("]]", i + 2);
      const newline = text.indexOf("\n", i);
      if (close !== -1 && (newline === -1 || close < newline)) {
        i = close + 2;
        continue;
      }
    }
    if (char === "!" && text[i + 1] === "[") {
      const after = labelEnd(text, i + 1);
      const dest = after !== -1 && text[after] === "(" ? destination(text, after) : null;
      i = dest ? dest.end : i + 2;
      continue;
    }
    if (char === "<") {
      const rest = text.slice(i, i + 2048);
      const autolink = AUTOLINK_RE.exec(rest);
      if (autolink) {
        add(autolink[1], null, "autolink", i, i + autolink[0].length, !followsLabel(text, i));
        i += autolink[0].length;
        continue;
      }
      if (RAW_TEXT_OPEN_RE.test(rest)) {
        RAW_TEXT_CLOSE_RE.lastIndex = i;
        i = RAW_TEXT_CLOSE_RE.test(text) ? RAW_TEXT_CLOSE_RE.lastIndex : text.length;
        continue;
      }
      const tag = HTML_TAG_RE.exec(rest);
      i += tag ? tag[0].length : 1;
      continue;
    }
    if (char === "[") {
      const after = labelEnd(text, i);
      const dest = after !== -1 && text[after] === "(" ? destination(text, after) : null;
      if (dest) {
        if (SCHEME_RE.test(dest.url)) {
          const label = text.slice(i + 1, after - 1);
          add(dest.url, label, "inline", i, dest.end, !dest.titled && !LABEL_MARKUP_RE.test(label));
        }
        i = dest.end;
        continue;
      }
      i += 1;
      continue;
    }
    if ((char === "h" || char === "H") && SCHEME_RE.test(text.slice(i, i + 8)) && !/[\p{L}\p{N}]/u.test(text[i - 1] ?? "")) {
      const end = bareEnd(text, i);
      add(text.slice(i, end), null, "bare", i, end, !followsLabel(text, i));
      i = end;
      continue;
    }
    i += 1;
  }
  return links;
}

/** One change to a text: replace `[from, to)` with `insert`. */
export interface LinkEdit {
  from: number;
  to: number;
  insert: string;
}

/** `title` as a wikilink alias, or the file stem at the end of `rel`. */
function aliasFrom(title: string | undefined, rel: string): string {
  // Braces go because every CriticMarkup delimiter has one, and a run of `%`
  // becomes one so it can't open a comment: the title comes from the source.
  const clean = (text: string) => text.replace(/[[\]|{}\r\n]/g, "").replace(/%+/g, "%").trim();
  return clean(title ?? "") || clean(rel.slice(rel.lastIndexOf("/") + 1));
}

const urlKey = (url: string) => url.replace(/\/$/, "");

/**
 * The smallest edits that turn every link to `urls` into a wikilink to `rel`,
 * front to back. A label stays put, so it keeps its author and the undo history
 * stays whole. The relay's `swap_links` is the same rule.
 */
export function swapLinkEdits(text: string, urls: string[], rel: string, title?: string): LinkEdit[] {
  const wanted = new Set(urls.map(urlKey));
  const edits: LinkEdit[] = [];
  for (const link of scanExternalLinks(text)) {
    if (!link.swappable || !wanted.has(urlKey(link.url))) continue;
    const open = `[[${rel}${link.inTable ? "\\|" : "|"}`;
    if (link.label?.trim()) {
      const labelEnd = link.start + 1 + link.label.length;
      edits.push({ from: link.start, to: link.start + 1, insert: open });
      edits.push({ from: labelEnd, to: link.end, insert: "]]" });
    } else {
      edits.push({ from: link.start, to: link.end, insert: `${open}${aliasFrom(title, rel)}]]` });
    }
  }
  return edits;
}

/** The distinct URLs of the links on a page that can become wikilinks, in
 *  document order. A link that can't is not offered: it would be imported and
 *  stay as it is. */
export function externalLinkUrls(text: string): string[] {
  return [...new Set(scanExternalLinks(text).filter((link) => link.swappable).map((link) => link.url))];
}

/** The page's leading frontmatter block, or "". */
function frontmatterOf(text: string): string {
  if (!/^---\r?\n/.test(text)) return "";
  const close = /\n---[ \t]*(?:\r?\n|$)/.exec(text.slice(3));
  return close ? text.slice(0, 3 + close.index) : "";
}

/**
 * Whether a page gets the import-and-link offer. `path` is the full relay path
 * ("Lens/Notes/a.md"). Course pages are out: the platform leaves a wikilink to
 * an article as literal text, so a swap there would break the link.
 */
export function pageOffersSourceLinks(path: string, text: string): boolean {
  if (!path.toLowerCase().endsWith(".md")) return false;
  if (path.startsWith("Lens Edu/") || path.includes("/_trash/")) return false;
  return !/^(?:source_url|synced_from):/m.test(frontmatterOf(text));
}
