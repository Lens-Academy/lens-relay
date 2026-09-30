/**
 * Google Docs JSON (one tab) -> Lens article markdown.
 *
 * Plain Docs structure maps directly: HEADING_n -> `#`*n, lists (nested by
 * nestingLevel), bold/italic/strikethrough, superscript/subscript, links,
 * native footnotes -> `[^note-n]`, inline images, horizontal rules, other
 * tables -> GFM tables. TITLE and SUBTITLE become the article's title and
 * description, not body text.
 *
 * On top of that it reads the AI Safety Atlas authoring conventions
 * (github.com/markov-root/atlas, src/textbook-loader/transformer.ts, MIT):
 *   - `$x$` is inline maths, `$ x $` (spaces inside) display maths, `\$` a
 *     dollar; the maths is Typst, translated to TeX (typst-math.ts);
 *   - a two-column table with a `type` row naming a component is that
 *     component, its other rows attributes: figure, video, iframe, quote,
 *     definition, noteBox, callout, section-description.
 * Components map onto what Lens articles already render: images with an
 * italic "Figure N.M: caption" line, `:::callout` boxes, blockquotes and
 * `**Definition: term**` paragraphs, matching the Atlas's earlier import.
 * Anything with no Lens form is reported in `warnings`, never dropped silently.
 */

import type {
  DocumentTab,
  Paragraph,
  ParagraphElement,
  StructuralElement,
  Table,
  TextStyle,
} from "./docs-types";
import { typstMathToTex } from "./typst-math";

export interface ConvertOptions {
  /** URL to embed for an inline object (image), or null if it has none. */
  imageUrl(inlineObjectId: string): string | null;
}

export interface ConvertedDoc {
  /** The TITLE paragraph's text, when the tab has one. */
  title: string | null;
  /** The SUBTITLE paragraph's text, when the tab has one. */
  description: string | null;
  body: string;
  warnings: string[];
}

interface Style {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  script: "sup" | "sub" | null;
}

type Text = { kind: "text"; text: string; style: Style; link: string | null };
type Piece = Text | { kind: "raw"; md: string } | { kind: "display"; tex: string };

const PLAIN: Style = { bold: false, italic: false, strike: false, script: null };

// Control characters Docs leaks into text, except \v (a manual line break).
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_RE = /[\x00-\x08\x0C\x0E-\x1F\x7F]/g;
const LINE_BREAK = "\u000b";

const ORDERED_GLYPHS = new Set(["DECIMAL", "ZERO_DECIMAL", "ALPHA", "UPPER_ALPHA", "ROMAN", "UPPER_ROMAN"]);

const COMPONENT_TYPES = new Set(["figure", "video", "iframe", "quote", "definition", "notebox", "callout", "section-description"]);

/** Attribute rows only components have, for spotting one that lost its `type` row. */
const COMPONENT_ATTRIBUTES = new Set(["content", "caption", "src", "still_image", "speaker", "term", "flavor", "source-url"]);

const CALLOUT_TONES: Record<string, string> = {
  warning: "amber",
  caution: "amber",
  danger: "red",
  info: "blue",
  note: "blue",
  tip: "green",
  success: "green",
};

/** Escape characters markdown would read as syntax inside running text. */
export function escapeInline(text: string): string {
  // An autolink written out (`<https://…>`) is left as the link it already is.
  return text
    .split(/(<(?:https?|mailto):[^\s<>]+>)/)
    .map((part, i) => (i % 2 ? part : escapeText(part)))
    .join("");
}

function escapeText(text: string): string {
  return (
    text
      // `^` after `[`: "[^x]" typed as text must not read as a footnote.
      .replace(/[\\`*[\]~$<>]|(?<=\[)\^/g, "\\$&")
      .replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, "\\_")
      // `:name` is a remark-directive; "Note:important" would lose its second word.
      .replace(/:(?=[A-Za-z])/g, "\\:")
      .replace(/&(?=#?\w+;)/g, "\\&")
      // CriticMarkup ({++ ++}, {-- --}, {== ==}): the editor and publishing act on it.
      .replace(/\{(?=\+\+|--|==)/g, "\\{")
      .replace(/%%/g, "\\%\\%")
  );
}

/** Escape what would make a line start a heading, list, quote, rule, setext underline or directive. */
function escapeLineStart(line: string): string {
  return line
    .replace(/^(\s*)([#>+])/, "$1\\$2")
    .replace(/^(\s*)([-*])(\s|$)/, "$1\\$2$3")
    .replace(/^(\s*\d+)([.)])(\s|$)/, "$1\\$2$3")
    .replace(/^(\s*)([-=])(?=[-=\s]*$)/, "$1\\$2")
    .replace(/^(\s*):/, "$1\\:");
}

/** TeX escapes markdown would consume, and command names that draw the same. */
const MATH_ESCAPES: Record<string, string> = {
  "{": "\\lbrace ", "}": "\\rbrace ", ",": "\\thinspace ", ";": "\\thickspace ", ":": "\\medspace ",
  "!": "\\negthinspace ", "|": "\\Vert ", "_": "\\char95 ", "%": "\\char37 ", "&": "\\char38 ",
  "#": "\\char35 ", $: "\\char36 ",
};

/**
 * Inline maths as markdown. Lens finds `$…$` only after markdown has run, so
 * anything markdown acts on is swapped for TeX that draws the same thing:
 * backslash escapes for command names, `*` `<` `>` for `\ast` `\lt` `\gt`, and a
 * space after `_` (TeX ignores it; markdown never opens emphasis there).
 */
function inlineMath(tex: string): string {
  const newline = tex.includes("\\begin{") ? "\\cr " : "\\newline ";
  return tex
    .replace(/\\([{},;:!|_%&#$\\])/g, (_, c: string) => (c === "\\" ? newline : MATH_ESCAPES[c]))
    .replace(/\*/g, "\\ast ")
    .replace(/</g, "\\lt ")
    .replace(/>/g, "\\gt ")
    .replace(/\]\(/g, "\\rbrack (")
    .replace(/`/g, "\\char96 ")
    .replace(/~/g, "\\nobreakspace ")
    .replace(/_(?! )/g, "_ ")
    // Lens reads `$…$` as maths only with no space just inside the dollars.
    .trim();
}

/** A URL as a link destination: brackets and spaces would end it early. */
function destination(url: string): string {
  return url.replace(/[()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

function sameStyle(a: Style, b: Style): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.strike === b.strike && a.script === b.script;
}

type Mark = "bold" | "italic" | "strike";
const MARKS: Record<Mark, string> = { bold: "**", italic: "*", strike: "~~" };
const LETTER_END = /[\p{L}\p{N}]$/u;
const LETTER_START = /^[\p{L}\p{N}]/u;

/**
 * Render consecutive styled segments (already escaped) with emphasis that
 * opens and closes only where a style changes, so neighbouring runs nest
 * (`*"**a**. b"*`) instead of fusing into delimiter runs like `****`.
 * Markers hug text: edge whitespace stays outside, and so does edge
 * punctuation that touches a letter outside (`**safe**.If`, not `**safe.**If`).
 * `prev`/`next` are the characters just outside the run.
 */
function styledRun(segments: { text: string; style: Style }[], prev: string, next: string): string {
  let out = "";
  let markEnd = 0; // end of the last marker written: characters before it are not text
  const open: { key: Mark; mark: string; at: number }[] = [];

  const closeFrom = (n: number, following: string) => {
    if (open.length <= n) return;
    let tail = /\s*$/.exec(out)![0];
    out = out.slice(0, out.length - tail.length);
    // (A closing </sup> or </sub> tag is not punctuation to move.)
    if (!tail && LETTER_START.test(following) && !/<\/su[pb]>$/.test(out)) {
      tail = /[\p{P}\p{S}]+$/u.exec(out.slice(markEnd))?.[0] ?? "";
      out = out.slice(0, out.length - tail.length);
    }
    while (open.length > n) {
      const { mark, at } = open.pop()!;
      // Nothing left inside: drop the opener rather than write an empty pair.
      out = out.length === at ? out.slice(0, at - mark.length) : out + mark;
    }
    markEnd = out.length;
    out += tail;
  };

  segments.forEach((seg, k) => {
    const wanted = (Object.keys(MARKS) as Mark[]).filter((key) => seg.style[key]);
    let keep = 0;
    while (keep < open.length && wanted.includes(open[keep].key)) keep++;
    closeFrom(keep, seg.text);

    // Open the styles that last longest first, so they close last.
    const lasting = (key: Mark) => {
      let n = k;
      while (n < segments.length && segments[n].style[key]) n++;
      return n;
    };
    const toOpen = wanted.filter((key) => !open.some((o) => o.key === key)).sort((a, b) => lasting(b) - lasting(a));
    let text = seg.text;
    if (toOpen.length) {
      const lead = /^\s*/.exec(text)![0];
      out += lead;
      text = text.slice(lead.length);
      if (LETTER_END.test(out || prev) && !text.startsWith("<su")) {
        const punct = /^[\p{P}\p{S}]+/u.exec(text)?.[0] ?? "";
        out += punct;
        text = text.slice(punct.length);
      }
      if (text.trim()) {
        for (const key of toOpen) {
          // Straight after a `*` closer, another `*` would fuse with it; `_` is a separate run.
          const mark = out.length === markEnd && out.endsWith("*") ? MARKS[key].replace(/\*/g, "_") : MARKS[key];
          out += mark;
          open.push({ key, mark, at: out.length });
        }
        markEnd = out.length;
      }
    }
    out += text;
  });
  closeFrom(0, next);
  return out;
}

/**
 * Split `$…$` / `$ … $` maths out of one text run, following the Atlas
 * loader's rules: a `$` followed by a space opens display maths closed by
 * ` $`; otherwise inline maths closes at the next `$` not preceded by a
 * space; `\$` is a literal dollar; an unclosed `$` is literal (and reported
 * when it looks like maths).
 */
function splitMath(text: string): {
  parts: ({ text: string } | { inline: string } | { display: string })[];
  unclosed: boolean;
} {
  const parts: ({ text: string } | { inline: string } | { display: string })[] = [];
  let unclosed = false;
  let buf = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && text[i + 1] === "$") {
      buf += "$";
      i += 2;
      continue;
    }
    if (ch === "$") {
      let close = -1;
      let display = false;
      if (text[i + 1] === " ") {
        close = text.indexOf(" $", i + 2);
        display = close !== -1;
      }
      if (close === -1) {
        for (let j = i + 1; j < text.length; j++) {
          if (text[j] === "$" && text[j - 1] !== " ") {
            close = j;
            break;
          }
        }
      }
      if (close !== -1) {
        if (buf) parts.push({ text: buf });
        buf = "";
        if (display) {
          parts.push({ display: text.slice(i + 2, close).trim() });
          i = close + 2;
        } else {
          parts.push({ inline: text.slice(i + 1, close).trim() });
          i = close + 1;
        }
        continue;
      }
      // "$500" is money; "$x" with no partner is maths the formatting split.
      if (/[A-Za-z\\({]/.test(text[i + 1] ?? "")) unclosed = true;
    }
    buf += ch;
    i++;
  }
  if (buf) parts.push({ text: buf });
  return { parts, unclosed };
}

/** All text in these elements, styles and structure dropped, trimmed. */
function plainText(elements: StructuralElement[] | undefined): string {
  let text = "";
  for (const el of elements ?? []) {
    for (const pe of el.paragraph?.elements ?? []) text += pe.textRun?.content ?? "";
  }
  return text.replace(CONTROL_RE, "").replace(/\s+/g, " ").trim();
}

function cellKey(elements: StructuralElement[] | undefined): string {
  return plainText(elements).toLowerCase();
}

function paragraphs(elements: StructuralElement[] | undefined): Paragraph[] {
  return (elements ?? []).flatMap((el) => (el.paragraph ? [el.paragraph] : []));
}

/** The URL a cell's text links to, if any. */
function cellLink(elements: StructuralElement[] | undefined): string | null {
  for (const p of paragraphs(elements)) {
    for (const el of p.elements ?? []) {
      const url = el.textRun?.textStyle?.link?.url;
      if (url) return url;
    }
  }
  return null;
}

/** Double quotes and braces would end a directive attribute early. */
function attrValue(text: string): string {
  return text.replace(/"/g, "'").replace(/[{}]/g, "");
}

/** Prefix every line of a block (for blockquotes and list continuations). */
function prefixLines(block: string, first: string, rest: string): string {
  return block
    .split("\n")
    .map((line, i) => (i === 0 ? first : rest) + line)
    .join("\n");
}

class Converter {
  private title: string | null = null;
  private description: string | null = null;
  private readonly warnings: string[] = [];
  private readonly chapter: string | null;
  private readonly counters = new Map<string, number>();
  /** footnote id -> number shown, in the order first referenced. */
  private readonly footnotes = new Map<string, string>();
  /** Ordered-list numbers per `listId:level`, kept across interruptions as Docs numbers them. */
  private readonly listNumbers = new Map<string, number>();
  private readonly unknownMath = new Set<string>();
  private internalLinks = 0;

  constructor(
    private readonly tab: DocumentTab,
    private readonly opts: ConvertOptions,
  ) {
    const title = paragraphs(tab.body?.content).find((p) => p.paragraphStyle?.namedStyleType === "TITLE");
    // "Chapter 3 - …", and the same in other languages ("Chapitre 3 - …").
    const m = title && /^\p{L}+\s+(\d+)\s*[-–—:]/u.exec(plainText([{ paragraph: title }]));
    this.chapter = m ? m[1] : null;
  }

  private warn(message: string): void {
    this.warnings.push(message);
  }

  /** "Figure 1.3": numbered within the chapter when the TITLE names one. */
  private label(kind: string): string {
    const n = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, n);
    return `${kind} ${this.chapter ? `${this.chapter}.` : ""}${n}`;
  }

  private math(typst: string): string {
    const { tex, unknown } = typstMathToTex(typst);
    for (const name of unknown) this.unknownMath.add(name);
    return tex;
  }

  convert(): ConvertedDoc {
    const blocks = this.blocks(this.tab.body?.content ?? [], true);
    const notes = [...this.footnotes.entries()]
      .sort(([, a], [, b]) => Number(a) - Number(b))
      .map(([id, number]) => {
        const text = paragraphs(this.tab.footnotes?.[id]?.content)
          .map((p) => this.inline(p))
          .filter(Boolean)
          .join(" ");
        return `[^note-${number}]: ${text}`;
      });
    if (notes.length) blocks.push(notes.join("\n"));
    if (this.internalLinks) {
      this.warn(`${this.internalLinks} link(s) to headings, bookmarks or tabs inside the doc were kept as plain text`);
    }
    if (this.unknownMath.size) {
      this.warn(`maths uses Typst names the sync does not translate: ${[...this.unknownMath].join(", ")}`);
    }
    return {
      title: this.title,
      description: this.description,
      body: blocks.join("\n\n") + "\n",
      warnings: this.warnings,
    };
  }

  /** Convert a run of structural elements into markdown blocks. */
  private blocks(elements: StructuralElement[], topLevel = false): string[] {
    const out: string[] = [];
    let list: string[] = [];
    let depth = -1;
    const flushList = () => {
      if (list.length) out.push(list.join("\n"));
      list = [];
      depth = -1;
    };

    for (const el of elements) {
      const p = el.paragraph;
      if (p?.bullet) {
        // Markdown cannot skip a nesting level; an item two levels in joins the one above.
        depth = Math.min(p.bullet.nestingLevel ?? 0, depth + 1);
        list.push(this.listItem(p, depth));
        continue;
      }
      flushList();
      if (el.table) {
        out.push(...this.table(el.table));
      } else if (p) {
        out.push(...this.paragraph(p, topLevel));
      }
    }
    flushList();
    return out.filter((b) => b.trim() !== "");
  }

  private paragraph(p: Paragraph, topLevel: boolean): string[] {
    const style = p.paragraphStyle?.namedStyleType ?? "NORMAL_TEXT";
    const text = plainText([{ paragraph: p }]);
    if (p.positionedObjectIds?.length) {
      this.warn(`${p.positionedObjectIds.length} positioned ("wrap text") image(s) were left out; make them inline images`);
    }

    if (topLevel && (style === "TITLE" || style === "SUBTITLE")) {
      if (p.elements?.some((e) => e.footnoteReference)) this.warn(`a footnote in the ${style.toLowerCase()} was left out`);
      if (style === "TITLE" && this.title === null) {
        this.title = text || null;
        return [];
      }
      if (style === "SUBTITLE" && this.description === null) {
        this.description = text || null;
        return [];
      }
    }
    const heading = /^HEADING_([1-6])$/.exec(style);
    if (heading && text) {
      // A trailing " #" would read as the heading's closing sequence.
      const inner = this.inline(p, { noBold: true }).replace(/\n+/g, " ").replace(/(\s)(#+)\s*$/, "$1\\$2");
      return [`${"#".repeat(Number(heading[1]))} ${inner}`];
    }

    // TeX written as plain text (no $…$) is still meant as maths.
    if (/^\\begin\{([a-z]+\*?)\}[\s\S]*\\end\{\1\}$/.test(text)) {
      this.warn(`a paragraph of TeX outside $…$ was treated as display maths: ${text.slice(0, 60)}`);
      return [`$$\n${text}\n$$`];
    }
    const typedFootnote = /\[\^[^\]\s]+\]/.exec(text)?.[0];
    if (typedFootnote) {
      this.warn(`text contains a markdown footnote marker, not a Docs footnote: ${typedFootnote}`);
    }

    // Display maths breaks the paragraph into blocks around it.
    const out: string[] = [];
    let run: Piece[] = [];
    const flush = () => {
      const md = this.render(run).trim();
      if (md) out.push(md);
      run = [];
    };
    for (const piece of this.pieces(p.elements ?? [])) {
      if (piece.kind !== "display") run.push(piece);
      else {
        flush();
        out.push(`$$\n${piece.tex}\n$$`);
      }
    }
    flush();
    if (p.elements?.some((e) => e.horizontalRule)) out.push("---");
    return out;
  }

  private listItem(p: Paragraph, level: number): string {
    const listId = p.bullet?.listId ?? "";
    const glyph = this.tab.lists?.[listId]?.listProperties?.nestingLevels?.[level];
    const ordered = !glyph?.glyphSymbol && ORDERED_GLYPHS.has(glyph?.glyphType ?? "");

    // A shallower item of the same list restarts the numbering of its deeper levels.
    for (const key of [...this.listNumbers.keys()]) {
      const [id, lvl] = key.split(":");
      if (id === listId && Number(lvl) > level) this.listNumbers.delete(key);
    }
    const key = `${listId}:${level}`;
    const n = (this.listNumbers.get(key) ?? 0) + 1;
    this.listNumbers.set(key, n);

    const indent = "    ".repeat(level);
    const marker = ordered ? `${n}.` : "-";
    return prefixLines(this.inline(p), `${indent}${marker} `, `${indent}${" ".repeat(marker.length + 1)}`);
  }

  /** A paragraph as inline markdown (list items, captions, cells, quotes, footnotes, headings). */
  private inline(p: Paragraph, opts: { noBold?: boolean; noItalic?: boolean } = {}): string {
    return this.render(this.pieces(p.elements ?? []), opts).trim();
  }

  private pieces(elements: ParagraphElement[]): Piece[] {
    const pieces: Piece[] = [];
    for (const el of elements) {
      if (el.textRun) {
        const content = (el.textRun.content ?? "").replace(CONTROL_RE, "").replace(/\n$/, "");
        if (!content) continue;
        const ts: TextStyle = el.textRun.textStyle ?? {};
        const style: Style = {
          bold: !!ts.bold,
          italic: !!ts.italic,
          strike: !!ts.strikethrough,
          script: ts.baselineOffset === "SUPERSCRIPT" ? "sup" : ts.baselineOffset === "SUBSCRIPT" ? "sub" : null,
        };
        let link = ts.link?.url ?? null;
        if (!link && ts.link) this.internalLinks++;
        // Docs often links the space before a link's text; leave it plain.
        if (link && !content.trim()) link = null;
        if (link) {
          if (content.includes("$")) this.warn(`maths in link text is shown as written: ${content.trim().slice(0, 40)}`);
          pieces.push({ kind: "text", text: content, style, link });
          continue;
        }
        const { parts, unclosed } = splitMath(content);
        if (unclosed) {
          this.warn(`a "$" has no partner within the same formatting, so it is shown as text: ${content.trim().slice(0, 40)}`);
        }
        for (const part of parts) {
          if ("text" in part) pieces.push({ kind: "text", text: part.text, style, link: null });
          else if ("inline" in part) pieces.push({ kind: "raw", md: `$${inlineMath(this.math(part.inline))}$` });
          else pieces.push({ kind: "display", tex: this.math(part.display) });
        }
      } else if (el.footnoteReference?.footnoteId) {
        const { footnoteId, footnoteNumber } = el.footnoteReference;
        if (!this.footnotes.has(footnoteId)) {
          this.footnotes.set(footnoteId, footnoteNumber || String(this.footnotes.size + 1));
        }
        // Lens footnote ids are typed: `note-` explains, `cite-` cites.
        pieces.push({ kind: "raw", md: `[^note-${this.footnotes.get(footnoteId)}]` });
      } else if (el.inlineObjectElement?.inlineObjectId) {
        const image = this.image(el.inlineObjectElement.inlineObjectId, "");
        if (image) pieces.push({ kind: "raw", md: image });
      } else if (el.richLink?.richLinkProperties?.uri) {
        const { title, uri } = el.richLink.richLinkProperties;
        pieces.push({ kind: "text", text: title || uri, style: PLAIN, link: uri });
      } else if (el.person?.personProperties) {
        const { name, email } = el.person.personProperties;
        pieces.push({ kind: "text", text: name || email || "", style: PLAIN, link: null });
      } else if (el.dateElement) {
        const shown = el.dateElement.dateElementProperties?.displayText;
        if (shown) pieces.push({ kind: "text", text: shown, style: PLAIN, link: null });
        else this.warn("a date chip was left out");
      } else if (el.equation) {
        this.warn("a native Docs equation was dropped (write maths as $…$ instead)");
      }
    }
    return pieces;
  }

  /** Render inline pieces: merge equal neighbours, then escape and mark up. */
  private render(pieces: Piece[], opts: { noBold?: boolean; noItalic?: boolean } = {}): string {
    const merged: Piece[] = [];
    for (const piece of pieces) {
      const prev = merged[merged.length - 1];
      if (piece.kind === "text") {
        const style = { ...piece.style, bold: piece.style.bold && !opts.noBold, italic: piece.style.italic && !opts.noItalic };
        if (prev?.kind === "text" && prev.link === piece.link && sameStyle(prev.style, style)) {
          prev.text += piece.text;
          continue;
        }
        merged.push({ ...piece, style });
      } else {
        merged.push(piece);
      }
    }

    const segment = (t: Text) => {
      const text = escapeInline(t.text);
      return { text: t.style.script ? `<${t.style.script}>${text}</${t.style.script}>` : text, style: t.style };
    };
    const firstChar = (p: Piece | undefined) =>
      !p ? "" : p.kind === "raw" ? p.md[0] : p.kind === "display" ? "$" : p.link ? "[" : p.text[0];

    let out = "";
    for (let i = 0; i < merged.length; ) {
      const piece = merged[i];
      if (piece.kind === "text") {
        // Consecutive text with the same link (or none) renders as one styled run.
        let j = i;
        while (j < merged.length && merged[j].kind === "text" && (merged[j] as Text).link === piece.link) j++;
        const run = (merged.slice(i, j) as Text[]).map(segment);
        if (piece.link) {
          const inner = styledRun(run, "", "");
          const lead = /^\s*/.exec(inner)![0];
          const trail = /\s*$/.exec(inner)![0];
          out += `${lead}[${inner.trim()}](${destination(piece.link)})${trail}`;
        } else {
          out += styledRun(run, out.slice(-1), firstChar(merged[j]));
        }
        i = j;
      } else if (piece.kind === "raw") {
        out += piece.md;
        i++;
      } else {
        // Display maths inside a list item, caption, quote or cell has no block to stand in.
        this.warn(`display maths inside a list, caption, quote, footnote or table cell is shown inline: ${piece.tex.slice(0, 40)}`);
        out += `$${inlineMath(piece.tex)}$`;
        i++;
      }
    }
    return out.split(LINE_BREAK).map(escapeLineStart).join("\n");
  }

  private image(objectId: string, alt: string): string | null {
    const url = this.opts.imageUrl(objectId);
    if (!url) {
      this.warn(`an image (${objectId}) could not be hosted and was left out`);
      return null;
    }
    const props = this.tab.inlineObjects?.[objectId]?.inlineObjectProperties?.embeddedObject;
    const text = (alt || props?.title || props?.description || "").replace(/\s+/g, " ").trim();
    return `![${escapeInline(text)}](${url})`;
  }

  /** The first image in a component cell; any more are reported. */
  private cellImage(cell: StructuralElement[] | undefined, alt: string): string | null {
    const ids = paragraphs(cell).flatMap((p) =>
      (p.elements ?? []).flatMap((el) => (el.inlineObjectElement?.inlineObjectId ? [el.inlineObjectElement.inlineObjectId] : [])),
    );
    if (ids.length > 1) this.warn(`${alt}: only the first of ${ids.length} images is kept`);
    return ids.length ? this.image(ids[0], alt) : null;
  }

  /** A component cell as one line of inline markdown (paragraphs joined). */
  private cellInline(cell: StructuralElement[] | undefined, opts: { noItalic?: boolean } = {}): string {
    if (cell?.some((el) => el.table)) this.warn("a table inside a table cell or component field was left out");
    return paragraphs(cell)
      .map((p) => this.inline(p, opts))
      .filter(Boolean)
      .join(" ");
  }

  private table(table: Table): string[] {
    const cells = (table.tableRows ?? []).map((row) => (row.tableCells ?? []).map((c) => c.content ?? []));
    const attrs = new Map<string, StructuralElement[]>();
    if (table.columns === 2) for (const [key, value] of cells) attrs.set(cellKey(key), value ?? []);
    const type = plainText(attrs.get("type")).toLowerCase();

    // Only a known component type makes a component: a data table may well have a "Type" row.
    if (!COMPONENT_TYPES.has(type)) {
      if (attrs.has("type")) this.warn(`a two-column table with a "type" row of "${type}" is shown as a plain table`);
      else if ([...attrs.keys()].some((k) => COMPONENT_ATTRIBUTES.has(k))) {
        this.warn(`a table looks like a component but has no "type" row, so it is shown as a plain table`);
      }
      return cells.length ? [this.gfmTable(cells)] : [];
    }
    const component = {
      figure: this.figure,
      video: this.video,
      iframe: this.iframe,
      quote: this.quote,
      definition: this.definition,
      notebox: this.noteBox,
      callout: this.callout,
      "section-description": this.sectionDescription,
    }[type]!;
    return component.call(this, attrs);
  }

  /** The section's lead paragraph, set off by a rule as in the Atlas's earlier import. */
  private sectionDescription(attrs: Map<string, StructuralElement[]>): string[] {
    const text = this.cellInline(attrs.get("content"));
    return text ? [text, "---"] : [];
  }

  private caption(label: string, cell: StructuralElement[] | undefined, extra = ""): string {
    const caption = this.cellInline(cell, { noItalic: true });
    if (paragraphs(cell).filter((p) => plainText([{ paragraph: p }])).length > 1) {
      this.warn(`${label}: a caption with several paragraphs was joined into one line`);
    }
    return `*${label}${caption ? `: ${caption}` : ""}*${extra}`;
  }

  private figure(attrs: Map<string, StructuralElement[]>): string[] {
    const label = this.label("Figure");
    // A few Atlas figures carry the image in a `source` row instead of `content`.
    const image = this.cellImage(attrs.get("content"), label) ?? this.cellImage(attrs.get("source"), label);
    if (!image) this.warn(`${label} has no image`);
    if (plainText(attrs.get("content"))) this.warn(`${label}: text beside the image was left out`);
    return [...(image ? [image] : []), this.caption(label, attrs.get("caption"))];
  }

  private video(attrs: Map<string, StructuralElement[]>): string[] {
    const label = this.label("Video");
    const url = cellLink(attrs.get("source")) ?? plainText(attrs.get("source"));
    if (!url) this.warn(`${label} has no source URL`);
    return [this.caption(label, attrs.get("caption"), url ? ` ([Watch the video](${destination(url)}))` : "")];
  }

  private iframe(attrs: Map<string, StructuralElement[]>): string[] {
    const label = this.label("Interactive figure");
    const srcCell = attrs.get("src") ?? attrs.get("source");
    const src = cellLink(srcCell) ?? plainText(srcCell);
    const still = this.cellImage(attrs.get("still_image"), label);
    if (!still) this.warn(`${label} has no still image, so only its caption and link are shown`);
    const link = src ? ` ([Open the interactive version](${destination(src)}))` : "";
    return [...(still ? [still] : []), this.caption(label, attrs.get("caption"), link)];
  }

  private quote(attrs: Map<string, StructuralElement[]>): string[] {
    const content = paragraphs(attrs.get("content")).map((p) => this.inline(p)).filter(Boolean);
    if (!content.length) {
      this.warn("a quote has no content");
      return [];
    }
    const speaker = plainText(attrs.get("speaker"));
    const position = plainText(attrs.get("position"));
    const date = plainText(attrs.get("date"));
    // "— Speaker, Position (Date) (source)"; a bare-URL source links the speaker instead.
    const sourceText = plainText(attrs.get("source-url"));
    const bareUrl = speaker && /^https?:\/\/\S+$/.test(sourceText);
    const who = bareUrl ? `[${escapeInline(speaker)}](${destination(sourceText)})` : escapeInline(speaker);
    const source = bareUrl ? "" : this.cellInline(attrs.get("source-url"));
    const attribution = [
      [who, escapeInline(position)].filter(Boolean).join(", "),
      date ? `(${escapeInline(date)})` : "",
      source,
    ].filter(Boolean).join(" ");
    const body = content.join("\n\n") + (attribution ? `\n— ${attribution}` : "");
    return [prefixLines(body, "> ", "> ").replace(/^> $/gm, ">")];
  }

  private definition(attrs: Map<string, StructuralElement[]>): string[] {
    const term = escapeInline(plainText(attrs.get("term")));
    if (!term) this.warn("a definition has no term");
    const [first = "", ...rest] = this.blocks(attrs.get("content") ?? []);
    const source = this.cellInline(attrs.get("source"));
    // Only running text can follow the term on its line; a list or box starts below it.
    const blocksFirst = /^([-*>|#]|\d+\.|:{3}|!\[|\$\$)/.test(first);
    const lead = `**Definition${term ? `: ${term}` : ""}**` + (first && !blocksFirst ? ` — ${first}` : "");
    const body = first && blocksFirst ? [first, ...rest] : rest;
    if (!body.length) return [source ? `${lead} ${source}` : lead];
    return [lead, ...body, ...(source ? [source] : [])];
  }

  private noteBox(attrs: Map<string, StructuralElement[]>): string[] {
    const title = plainText(attrs.get("title"));
    const collapsed = !/^(false|no)$/i.test(plainText(attrs.get("collapsed")));
    return this.box(this.blocks(attrs.get("content") ?? []), title || "Note", "neutral", collapsed);
  }

  private callout(attrs: Map<string, StructuralElement[]>): string[] {
    const flavor = plainText(attrs.get("flavor")).toLowerCase();
    const title = flavor ? flavor[0].toUpperCase() + flavor.slice(1) : "Note";
    return this.box(this.blocks(attrs.get("content") ?? []), title, CALLOUT_TONES[flavor] ?? "neutral", false);
  }

  /** A `:::callout` container; its fence outgrows any fence nested inside. */
  private box(inner: string[], title: string, tone: string, collapsed: boolean): string[] {
    const nested = Math.max(2, ...inner.flatMap((b) => [...b.matchAll(/^(:{3,})/gm)].map((m) => m[1].length)));
    const fence = ":".repeat(nested + 1);
    const collapse = collapsed ? ` collapse="closed"` : "";
    return [`${fence}callout{title="${attrValue(title)}" tone="${tone}"${collapse}}`, ...inner, fence];
  }

  private gfmTable(cells: StructuralElement[][][]): string {
    const width = Math.max(...cells.map((r) => r.length));
    const row = (r: StructuralElement[][]) =>
      `| ${Array.from({ length: width }, (_, i) =>
        this.cellInline(r[i]).replace(/\n+/g, " ").replace(/\|/g, "\\|"),
      ).join(" | ")} |`;
    const [head, ...body] = cells;
    return [row(head), `|${" --- |".repeat(width)}`, ...body.map(row)].join("\n");
  }
}

export function convertDocumentTab(tab: DocumentTab, opts: ConvertOptions): ConvertedDoc {
  return new Converter(tab, opts).convert();
}
