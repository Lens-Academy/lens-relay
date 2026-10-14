/**
 * A built Iliad worksheet (MDX, as iliad-intensive.org publishes it) ->
 * Atoms of Lens markdown.
 *
 * The page is copied line for line (a run of empty lines as one). Only what
 * Lens reads differently is changed, the way the hand import of 8 Oct 2026
 * changed it:
 *
 *   - `<Exercise>`, `<Solution>`, `<Hint>`, `<Definition>`, `<Theorem>`,
 *     `<Callout>` and `<LearningOutcomes>` become `:::callout` boxes;
 *   - `$x$` becomes `$$x$$`, and the page's macros are expanded
 *     (mdx-macros.ts), because Lens draws each formula alone;
 *   - a heading is escaped (`\## Title`): a bare `#` line is structure in a
 *     lens file. So is whatever else Lens would read as its own syntax
 *     (convert-escape.ts);
 *   - a link to another place on the page keeps only its words, and a link
 *     to another page of the site is made absolute;
 *   - `<Figure>` becomes an image that Lens hosts, `<YouTube>` a video part;
 *   - what is written for the teacher goes in a `%% ... %%` block, which
 *     Lens does not publish: a JSX comment, a `<TeachingNote>`, and the
 *     day's timetable (convert-logistics.ts);
 *   - a footnote definition moves from the foot of the page to the text that
 *     refers to it, because each lens is a document of its own.
 *
 * An Atom starts at each H2, H3 and H4 heading, and at each exercise with an
 * id; neither counts when it stands inside a box.
 *
 * A component this file does not know loses its box and keeps its content,
 * with a warning. Nothing is fetched and nothing depends on the clock: the
 * same page always gives the same text.
 */

import { PermanentImageError } from "../types";
import { headingAnchor, uniqueAnchors } from "./anchor";
import { escapeLineStart, escapeText, guardMath, guardMathLine, lensMarkupIn } from "./convert-escape";
import { HIDDEN_OPEN, isLogistics, onlyTimetable } from "./convert-logistics";
import { convertInline, maskSpans, tagAt, type InlineRules, type Tag } from "./mdx-inline";
import { expandMacros, redefinitionsAsDef, takeDefinitions, type Macros } from "./mdx-macros";
import type { Atom, AtomPart, ConvertWorksheet, Worksheet } from "./types";

interface Box {
  title: string;
  tone: "neutral" | "blue" | "green" | "amber";
  /** Starts folded: the reader opens it. */
  closed?: boolean;
}

const BOXES: Record<string, Box> = {
  Exercise: { title: "Exercise", tone: "amber" },
  Solution: { title: "Solution", tone: "neutral", closed: true },
  Hint: { title: "Hint", tone: "neutral", closed: true },
  Definition: { title: "Definition", tone: "blue" },
  Theorem: { title: "Theorem", tone: "green" },
  LearningOutcomes: { title: "What you'll learn", tone: "neutral" },
};

/** `<Callout type="...">`. */
const CALLOUTS: Record<string, Box> = {
  note: { title: "Note", tone: "blue" },
  tip: { title: "Tip", tone: "green" },
  warning: { title: "Warning", tone: "amber" },
};

/** HTML that Lens renders in running text. */
const INLINE_HTML = new Set(["sup", "sub", "br", "a"]);

/** `<div id="...">` and `<span id="...">` are what a link on the page points at. Lens has no such links. */
const isAnchor = (tag: Tag): boolean => (tag.name === "div" || tag.name === "span") && Object.keys(tag.attributes).every((name) => name === "id");

const UNKNOWN = "is a component this sync does not know: its box is left out and what it encloses is kept";

/** Stands in the text for figure number n until its hosted URL is known. A private-use character: no page has it. */
const MARK = String.fromCharCode(0xe000);
const FIGURE = new RegExp(`${MARK}(\\d+)${MARK}`, "g");

/** A backslash before punctuation is markdown's escape; this takes it off. */
const unescaped = (text: string): string => text.replace(/\\([!-/:-@[-`{-~])/g, "$1");

const words = (text: string): number => text.split(/\s+/).filter(Boolean).length;

const trimBlankLines = (text: string): string => text.replace(/^(?:[ \t]*\n)+/, "").trimEnd();

/** A heading's Lens markdown as plain words; a formula stays as it is. */
function plainText(markdown: string): string {
  return markdown
    .split(/(\$\$[^$]*\$\$)/)
    .map((part, i) => (i % 2 ? part : unescaped(part.replace(/!?\[((?:[^\][]|\[[^\][]*\])*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1").replace(/\*\*|__|[*`]/g, ""))))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

interface Figure {
  sitePath: string;
  alt: string;
}

interface Link {
  text: string;
  url: string;
}

interface TextPiece {
  kind: "text";
  lines: string[];
  /** Labels of the footnotes it refers to, in order. */
  notes: string[];
}

type Piece = TextPiece | { kind: "video"; youtubeId: string; title: string | null };

/** An Atom while it is being read. */
interface Section {
  level: Atom["level"];
  /** Index of the heading it starts at among all headings of the page; -1 when it starts at none. */
  heading: number;
  /** The id of the exercise it starts at; null when it starts at none. */
  exercise: string | null;
  title: string;
  /** All of it is for the teacher. */
  hidden: boolean;
  /** Its first line of the page. */
  from: number;
  pieces: Piece[];
  links: Link[];
}

interface Footnote {
  markdown: string;
  links: Link[];
  words: number;
  /** The section it was written in: where it stays when nothing refers to it. */
  home: Section;
}

/** A component that is open, and what its closing tag does. */
interface Open {
  name: string;
  indent: string;
  /** Its `:::callout` fence without the colons; "" for a component that is no box. */
  fence: string;
  /** The line of that fence in the text: it gets its colons when the box closes. */
  fenceAt: number;
  /** Depth of the boxes inside it. A fence needs more colons than any fence inside. */
  inner: number;
  /** It opened a hidden block, which its closing tag ends. */
  hides: boolean;
}

class Conversion {
  readonly warnings: string[] = [];
  private readonly page: Worksheet;
  private readonly lines: string[];
  private readonly macros: Macros = new Map();
  private readonly figures: Figure[] = [];
  private readonly footnotes = new Map<string, Footnote>();
  /** Lines of the page that define footnotes: they count as words where the footnote is referred to. */
  private readonly noteLines = new Set<number>();
  /** Every heading of the page in order: the site numbers repeats across all of them. */
  private readonly headings: string[] = [];
  private readonly sections: Section[] = [];
  /**
   * Anchors an exercise may not start an Atom under: those of the page's
   * headings, then the id of each exercise that did. Null while the page is
   * read for its headings, when no exercise starts one.
   */
  private readonly taken: Set<string> | null;

  private section: Section;
  private text: TextPiece;
  private links: Link[];
  /** Above 0 inside a block Lens will not publish: nothing there needs escaping, and its links are no reading. */
  private hidden = 0;
  /** Level of the heading that opened the logistics section, while one is open. */
  private logistics: number | null = null;
  /** A bold line opened a hidden block, which the next heading or bold line ends. */
  private runInLogistics = false;
  private inTable = false;
  /** Line of the page being read, for warnings. */
  private at = 1;

  private readonly rules: InlineRules = {
    math: (tex) => this.math(tex),
    // `%%` would end a hidden block early; nothing else in one is ever read.
    text: (text) => (this.hidden ? text.replace(/%%/g, "\\%\\%") : escapeText(text)),
    code: (raw) => this.code(raw),
    footnote: (label) => void this.text.notes.push(label),
    comment: (body) => this.asComment(body.trim()),
    link: (text, written) => {
      const url = unescaped(written);
      if (url.startsWith("#")) return null;
      if (/^https?:\/\//i.test(url)) {
        if (!this.hidden) this.links.push({ text, url });
        return written;
      }
      return /^[a-z][a-z0-9+.-]*:/i.test(url) ? written : new URL(url, this.page.pageUrl).href;
    },
    image: (alt, url) => (/^[a-z][a-z0-9+.-]*:/i.test(url) ? null : this.figure(url, alt)),
    tag: (tag, raw) => {
      if (INLINE_HTML.has(tag.name)) return raw;
      if (!tag.closing && !isAnchor(tag)) this.warn(`${raw} ${UNKNOWN}`);
      return "";
    },
    expression: (raw) => {
      const literal = /^\{\s*(["'`])([^"'`]*)\1\s*\}$/.exec(raw);
      if (!literal) this.warn(`expression ${raw} is copied as written: it cannot be worked out`);
      return literal ? this.rules.text(literal[2]) : raw;
    },
  };

  constructor(page: Worksheet, taken: Set<string> | null) {
    this.page = page;
    this.taken = taken;
    this.lines = page.mdx.replace(/\r\n?/g, "\n").replaceAll(MARK, "").split("\n");
    this.section = { level: 0, heading: -1, exercise: null, title: "", hidden: false, from: 0, pieces: [], links: [] };
    this.sections.push(this.section);
    this.links = this.section.links;
    this.text = this.newText();
    this.walk(this.lines, true);
  }

  /** The anchor the site gives each heading of the page, in order. */
  get headingAnchors(): string[] {
    return uniqueAnchors(this.headings);
  }

  private warn(message: string): void {
    this.warnings.push(`${this.page.slug}: line ${this.at}: ${message}`);
  }

  // ------------------------------------------------------------- writing

  private start(section: Pick<Section, "level" | "heading" | "exercise" | "hidden" | "from">): void {
    this.section = { ...section, title: "", pieces: [], links: [] };
    this.sections.push(this.section);
    this.links = this.section.links;
    this.newText();
  }

  private newText(): TextPiece {
    this.text = { kind: "text", lines: [], notes: [] };
    this.section.pieces.push(this.text);
    return this.text;
  }

  private emit(line: string): void {
    this.text.lines.push(line);
  }

  /**
   * An empty line of the page. Two in a row are written as one, as in the
   * hand import: a line that is left out between two empty lines leaves one.
   */
  private blank(): void {
    if (this.text.lines[this.text.lines.length - 1]?.trim()) this.emit("");
  }

  /** Close a hidden block that `HIDDEN_OPEN` opened in the text. */
  private endHidden(): void {
    while (this.text.lines.length > 0 && !this.text.lines[this.text.lines.length - 1].trim()) this.text.lines.pop();
    this.emit("%%");
  }

  private endLogistics(): void {
    if (!this.runInLogistics) return;
    this.runInLogistics = false;
    this.hidden--;
    this.endHidden();
    this.blank();
  }

  /** Text of a comment as Lens writes one; inside a hidden block it is hidden already. */
  private asComment(text: string): string {
    return this.hidden ? text : `%% ${text.replace(/%%/g, "% %")} %%`;
  }

  /** Run `read` with its text going to a list of its own; gives that text. */
  private aside(read: () => void, links: Link[] = []): string[] {
    const { text, links: outer } = this;
    const piece: TextPiece = { kind: "text", lines: [], notes: [] };
    this.text = piece;
    this.links = links;
    read();
    this.text = text;
    this.links = outer;
    return piece.lines;
  }

  // ------------------------------------------------------------- reading

  /**
   * Read `lines`. `top` is the page itself; a comment's body is read the
   * same way, but its headings start no Atom and are not on the site.
   */
  private walk(lines: string[], top: boolean): void {
    const open: Open[] = [];
    // Both are set inside `step`, which the compiler does not follow: hence `as`.
    let fence = null as string | null;
    let display = null as { opener: string; body: string[] } | null;
    let paragraph: string[] = [];
    let paragraphAt = this.at;

    const flush = () => {
      if (paragraph.length === 0) return;
      const now = this.at;
      this.at = paragraphAt;
      this.inTable = paragraph.some((line) => /^\s*\|/.test(line));
      const converted = convertInline(paragraph.join("\n"), this.rules).split("\n");
      this.inTable = false;
      converted.forEach((line, k) => {
        // A line that held nothing but macro definitions is left out.
        if (line.trim() || !paragraph[k]?.trim()) this.emit(this.hidden ? line : escapeLineStart(line));
      });
      this.at = now;
      paragraph = [];
    };

    const step = (line: string, n: number): void => {
      if (fence) {
        this.code(line);
        this.emit(line);
        if (line.trim().startsWith(fence) && /^([`~])\1*$/.test(line.trim())) fence = null;
        return;
      }
      if (display) {
        if (line.trim() !== "$$") return void display.body.push(line);
        const tex = this.math(display.body.join("\n"));
        if (tex.trim()) [display.opener, ...tex.split("\n").map(guardMathLine), line].forEach((l) => this.emit(l));
        display = null;
        return;
      }
      const fenceOpens = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fenceOpens) {
        flush();
        fence = fenceOpens[1];
        return this.emit(line);
      }
      if (line.trim() === "$$") {
        flush();
        display = { opener: line, body: [] };
        return;
      }
      if (!line.trim()) {
        flush();
        return this.blank();
      }
      const heading = /^(#{1,6})[ \t]+(.*?)[ \t]*$/.exec(line);
      if (heading) {
        flush();
        if (!top || open.length > 0) return this.heading(heading[1].length, heading[2], top, null);
        const next = lines.findIndex((l, m) => m > n && /^#{1,6}[ \t]/.test(l));
        return this.heading(heading[1].length, heading[2], top, { from: n, body: lines.slice(n + 1, next < 0 ? lines.length : next) });
      }
      const pieces = splitAtTags(line);
      if (pieces.length > 1) return pieces.forEach((piece) => step(piece, n));
      const tag = blockTag(line);
      if (tag) {
        flush();
        return this.component(tag, line, open, top && open.length === 0 ? n : null);
      }
      // A `\paragraph{}` of the LaTeX source: a bold line that heads the text below it.
      const runIn = top && open.length === 0 ? /^\*\*([^*]+)\.\*\*/.exec(line) : null;
      if (runIn) {
        flush();
        this.endLogistics();
        if (!this.hidden && isLogistics(runIn[1])) {
          this.emit(HIDDEN_OPEN);
          this.hidden++;
          this.runInLogistics = true;
        }
      }
      if (paragraph.length === 0) paragraphAt = this.at;
      paragraph.push(line);
    };

    for (let n = 0; n < lines.length; n++) {
      const line = lines[n];
      if (top) this.at = n + 1;
      if (!fence && !display) {
        // `##` with its title on the next line: the site shows an empty heading and a paragraph.
        const bare = /^(#{1,6})[ \t]*$/.exec(line);
        if (bare && /^[\p{L}\p{N}"'(]/u.test(lines[n + 1] ?? "")) {
          this.warn(`a heading has no text; the line below it ("${lines[n + 1].trim()}") is taken as its text`);
          lines.splice(n, 2, `${bare[1]} ${lines[n + 1].trim()}`);
          n--;
          continue;
        }
        // A comment that runs over several lines can hold whole components.
        const start = maskSpans(line).indexOf("{/*");
        const end = start < 0 || line.includes("*/}", start) ? -1 : lines.findIndex((l, m) => m > n && l.includes("*/}"));
        if (end > 0) {
          const last = lines[end];
          const closes = last.indexOf("*/}");
          if (line.slice(0, start).trim()) step(line.slice(0, start), n);
          flush();
          this.comment([line.slice(start + 3), ...lines.slice(n + 1, end), last.slice(0, closes)]);
          if (last.slice(closes + 3).trim()) step(last.slice(closes + 3), n);
          n = end;
          continue;
        }
        const note = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/.exec(line);
        if (note) {
          flush();
          let until = n + 1;
          while (until < lines.length && lines[until].trim() && !/^\[\^[^\]\s]+\]:/.test(lines[until])) until++;
          this.footnote(note[1], [note[2], ...lines.slice(n + 1, until)].join("\n"));
          if (top) for (let m = n; m < until; m++) this.noteLines.add(m);
          n = until - 1;
          continue;
        }
      }
      step(line, n);
    }

    flush();
    if (display) {
      this.warn("a displayed formula is never closed; it is copied as written");
      for (const line of [display.opener, ...display.body]) this.emit(line);
    }
    if (top) this.endLogistics();
    if (fence) this.warn("a code fence is never closed");
    for (const left of open.reverse()) {
      this.warn(`<${left.name}> is never closed`);
      this.close(left, []);
    }
  }

  /** `own` is given for a heading that stands outside every box: where it is on the page, and the lines up to the next heading. */
  private heading(level: number, text: string, onSite: boolean, own: { from: number; body: string[] } | null): void {
    if (onSite) this.headings.push(text);
    // "" is the anchor of the text before the first heading, and the site gives it to a heading without words.
    const named = headingAnchor(text) !== "";
    if (!named && own) this.warn(`heading "${text}" has no words for an anchor, so no section starts at it`);
    const starts = own !== null && level >= 2 && level <= 4 && named;
    if (starts) {
      this.endLogistics();
      if (this.logistics !== null && level <= this.logistics) this.logistics = null;
      const logistics = isLogistics(plainText(text.replace(/\$[^$]*\$/g, "")));
      if (this.logistics === null && logistics) this.logistics = level;
      const hidden = logistics || (this.logistics !== null && onlyTimetable(own.body));
      this.start({ level: level as Atom["level"], heading: this.headings.length - 1, exercise: null, hidden, from: own.from });
      this.hidden = hidden ? 1 : 0;
    }
    const converted = convertInline(text, this.rules);
    if (starts) this.section.title = plainText(converted);
    this.emit(`\\${"#".repeat(level)} ${converted}`);
  }

  private math(tex: string): string {
    const own = takeDefinitions(tex, this.macros);
    if (!own.trim()) return "";
    return guardMath(
      expandMacros(redefinitionsAsDef(own), this.macros, { inTable: this.inTable, onProblem: (reason) => this.warn(reason) }),
    );
  }

  private code(raw: string): string {
    const markup = this.hidden ? null : lensMarkupIn(raw);
    if (markup) this.warn(`code holds "${markup}", which Lens reads as its own markup: ${raw.trim().slice(0, 80)}`);
    return raw;
  }

  /** A comment of several lines. Its body is read like the page, so a box in it is still a box if the comment is taken off. */
  private comment(body: string[]): void {
    this.hidden++;
    const text = trimBlankLines(this.aside(() => this.walk(body, false)).join("\n")).trimStart();
    this.hidden--;
    if (text) for (const line of this.asComment(text).split("\n")) this.emit(line);
  }

  private footnote(label: string, body: string): void {
    const links: Link[] = [];
    const hidden = this.hidden;
    this.hidden = 0;
    const markdown = this.aside(() => this.emit(convertInline(body, this.rules)), links).join("\n");
    this.hidden = hidden;
    if (this.footnotes.has(label)) this.warn(`footnote [^${label}] is defined twice; the first definition is kept`);
    else this.footnotes.set(label, { markdown: `[^${label}]: ${markdown}`, links, words: words(body) + 1, home: this.section });
  }

  /** A figure of the site, as the mark that `atoms` replaces with its image. One from elsewhere is linked where it is. */
  private figure(src: string, alt: string): string {
    const url = new URL(unescaped(src), this.page.pageUrl);
    const shown = this.rules.text(alt).replace(/[[\]]/g, "\\$&");
    if (url.origin !== new URL(this.page.pageUrl).origin) return `![${shown}](${url.href})`;
    return `${MARK}${this.figures.push({ sitePath: url.pathname + url.search, alt: shown }) - 1}${MARK}`;
  }

  // ---------------------------------------------------------- components

  /** A line that is one component tag. `at` is its line of the page when it stands outside every box, else null. */
  private component(tag: Tag, line: string, open: Open[], at: number | null): void {
    const raw = line.trim();
    if (tag.closing) {
      const at = open.map((o) => o.name).lastIndexOf(tag.name);
      if (at < 0) return this.warn(`${raw} closes nothing and is left out`);
      for (const left of open.splice(at + 1).reverse()) {
        this.warn(`<${left.name}> is closed by ${raw}`);
        this.close(left, open);
      }
      return this.close(open.pop()!, open);
    }

    const entry: Open = { name: tag.name, indent: /^\s*/.exec(line)![0], fence: "", fenceAt: -1, inner: 0, hides: false };
    const { title } = tag.attributes;
    const box = tag.name === "Callout" ? (CALLOUTS[tag.attributes.type ?? "note"] ?? null) : (BOXES[tag.name] ?? null);

    if (tag.name === "Figure" && tag.attributes.src) {
      this.emit(entry.indent + this.figure(tag.attributes.src, tag.attributes.alt ?? ""));
    } else if (tag.name === "YouTube" && tag.attributes.id) {
      this.video(tag.attributes.id, title || null, at !== null);
    } else if (tag.name === "TeachingNote") {
      entry.hides = this.hidden === 0;
      if (entry.hides) this.emit(HIDDEN_OPEN);
      this.hidden++;
      this.emit(`**${title || "Teaching note"}**`);
    } else if (box || tag.name === "Callout") {
      if (tag.name === "Exercise" && tag.attributes.id && at !== null) this.exercise(tag.attributes.id, at);
      if (!box) this.warn(`${raw} has a type this sync does not know; it is shown as a note`);
      const { tone, closed } = box ?? CALLOUTS.note;
      // An attribute value ends at the first `"`, and the attributes at the first `}`.
      const shown = (title || (box ?? CALLOUTS.note).title).replace(/"/g, "'").replace(/[{}]/g, "");
      if (title && shown !== title) this.warn(`the title of ${raw} is written as "${shown}"`);
      entry.fence = `callout {title="${shown}" tone="${tone}"${closed ? ' collapse="closed"' : ""}}`;
      entry.fenceAt = this.text.lines.length;
      this.emit(`${entry.indent}:::${entry.fence}`);
    } else if (!isAnchor(tag)) {
      this.warn(`${raw} ${UNKNOWN}`);
    }

    if (tag.selfClosing) this.close(entry, open);
    else open.push(entry);
  }

  /**
   * Start an Atom at an exercise, under the exercise's id. The hand import
   * cut five long sections at one. Nothing starts inside a hidden block, or
   * under an id that a heading or an earlier exercise has.
   */
  private exercise(id: string, from: number): void {
    if (!this.taken || this.hidden) return;
    if (this.taken.has(id)) return this.warn(`exercise id "${id}" is also the anchor of a heading or the id of an earlier exercise, so no section starts at it`);
    this.taken.add(id);
    this.start({ level: 5, heading: -1, exercise: id, hidden: false, from });
  }

  private close(entry: Open, open: Open[]): void {
    if (entry.fence) {
      const colons = entry.indent + ":".repeat(3 + entry.inner);
      this.text.lines[entry.fenceAt] = colons + entry.fence;
      this.emit(colons);
      const outer = open[open.length - 1];
      if (outer) outer.inner = Math.max(outer.inner, entry.inner + 1);
    } else if (entry.name === "TeachingNote") {
      this.hidden--;
      if (entry.hides) this.endHidden();
    }
  }

  private video(youtubeId: string, title: string | null, ownPart: boolean): void {
    // A video is a segment of its own in a lens, which a box or a hidden block cannot hold.
    if (!ownPart || this.hidden) {
      if (!this.hidden) this.warn(`video ${youtubeId} stands inside a box, so the text links to it`);
      return this.emit(`[${this.rules.text(title ?? "Video")}](https://www.youtube.com/watch?v=${youtubeId})`);
    }
    this.section.pieces.push({ kind: "video", youtubeId, title });
    this.newText();
  }

  // --------------------------------------------------------------- result

  async atoms(hostImage: (sitePath: string) => Promise<string>): Promise<Atom[]> {
    // A figure that can never be hosted is reported and linked; any other failure fails the run.
    const hosted = new Map<string, string | null>();
    for (const { sitePath } of this.figures) {
      if (hosted.has(sitePath)) continue;
      try {
        hosted.set(sitePath, await hostImage(sitePath));
      } catch (err) {
        if (!(err instanceof PermanentImageError)) throw err;
        hosted.set(sitePath, null);
        this.warnings.push(`${this.page.slug}: figure ${sitePath} cannot be hosted (${err.message}); the text links to it`);
      }
    }
    const image = (_: string, n: string): string => {
      const { sitePath, alt } = this.figures[Number(n)];
      const url = hosted.get(sitePath);
      if (!url) return `[${alt || "Figure"}](${new URL(sitePath, this.page.pageUrl).href})`;
      return `![${alt}](${/[\s()<>]/.test(url) ? `<${url}>` : url})`;
    };

    const anchors = this.headingAnchors;
    const referred = new Set(this.sections.flatMap((section) => section.pieces.flatMap((piece) => (piece.kind === "text" ? piece.notes : []))));
    for (const label of this.footnotes.keys()) {
      if (!referred.has(label)) this.warnings.push(`${this.page.slug}: footnote [^${label}] is defined and nothing refers to it`);
    }

    const atoms = this.sections.map((section, k): Atom => {
      const until = this.sections[k + 1]?.from ?? this.lines.length;
      let count = words(this.lines.filter((_, n) => n >= section.from && n < until && !this.noteLines.has(n)).join("\n"));
      const links = [...section.links];
      const parts: AtomPart[] = [];
      const lastText = section.pieces.findLast((piece) => piece.kind === "text");
      for (const piece of section.pieces) {
        if (piece.kind === "video") {
          parts.push(piece);
          continue;
        }
        // A footnote goes below the text that refers to it. One nothing refers to stays in the section it was written in.
        const labels = [...new Set(piece.notes)].filter((label) => this.footnotes.has(label));
        if (piece === lastText) {
          for (const [label, note] of this.footnotes) if (note.home === section && !referred.has(label)) labels.push(label);
        }
        const notes = labels.map((label) => this.footnotes.get(label)!);
        for (const note of notes) {
          count += note.words;
          links.push(...note.links);
        }
        let markdown = [trimBlankLines(piece.lines.join("\n")), notes.map((note) => note.markdown).join("\n")].filter(Boolean).join("\n\n");
        if (!markdown) continue;
        if (section.hidden) markdown = `${HIDDEN_OPEN}\n${markdown}\n%%`;
        parts.push({ kind: "text", markdown: markdown.replace(FIGURE, image) });
      }
      // Lens publishes nothing of a `%% ... %%` block. An atom that is only that must never be a lens of its own.
      const seen = parts.some((part) => part.kind === "video" || part.markdown.replace(/%%.*?%%/gs, "").trim() !== "");
      return {
        anchor: section.exercise ?? (section.heading < 0 ? "" : anchors[section.heading]),
        level: section.level,
        title: section.title,
        words: seen ? count : 0,
        parts,
        links,
      };
    });
    return atoms.filter((atom) => atom.parts.length > 0);
  }
}

/** The component tag `line` consists of: `<Exercise id="x">`, `</div>`, `<Figure ... />`. Null for text and for inline HTML. */
function blockTag(line: string): Tag | null {
  const trimmed = line.trim();
  const tag = trimmed.startsWith("<") ? tagAt(trimmed, 0) : null;
  return tag && tag.end === trimmed.length && (/^[A-Z]/.test(tag.name) || tag.name === "div") ? tag : null;
}

/** Components that are a block of the lens wherever the page writes them. */
const BLOCKS = new Set([...Object.keys(BOXES), "Callout", "TeachingNote", "Figure", "YouTube"]);

/**
 * `line` cut so that each tag of a known component stands alone, as the
 * site's build writes them: `<Hint>Try n = 2.</Hint>` gives three pieces.
 * One piece when there is nothing to cut.
 */
function splitAtTags(line: string): string[] {
  const masked = maskSpans(line);
  const pieces: string[] = [];
  let from = 0;
  for (const match of masked.matchAll(/<\/?[A-Z]/g)) {
    if (match.index < from) continue;
    const tag = tagAt(line, match.index);
    if (!tag || !BLOCKS.has(tag.name)) continue;
    pieces.push(line.slice(from, match.index), line.slice(match.index, tag.end));
    from = tag.end;
  }
  pieces.push(line.slice(from));
  const kept = pieces.filter((piece) => piece.trim());
  return kept.length > 1 ? kept : [line];
}

export const convertWorksheet: ConvertWorksheet = async (worksheet, hostImage) => {
  // An exercise starts an Atom under its id only when no heading has that anchor, and a heading further down
  // the page counts too. So the page is read twice: once for its headings, then for the Atoms.
  const taken = new Set(new Conversion(worksheet, null).headingAnchors);
  const conversion = new Conversion(worksheet, taken);
  const atoms = await conversion.atoms(hostImage);
  return { atoms, warnings: conversion.warnings };
};
