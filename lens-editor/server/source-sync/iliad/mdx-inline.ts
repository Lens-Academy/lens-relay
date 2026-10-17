/**
 * The running text of a built Iliad page, read the way its site reads it
 * (MDX with remark-math and remark-gfm): code spans and formulas are opaque,
 * a `<name>` is a tag, a `{...}` is an expression. `convertInline` walks one
 * paragraph and hands each construct to a rule; what a rule returns is
 * written in its place.
 */

export interface Tag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attributes: Record<string, string>;
  /** Index after the closing `>`. */
  end: number;
}

export interface InlineRules {
  /** TeX of one formula -> TeX to write between `$$`; "" removes the formula. */
  math(tex: string): string;
  /** A code span, backticks included -> what to write. */
  code(raw: string): string;
  /** A link's converted text and its destination -> the destination to write, or null to keep only the text. */
  link(text: string, url: string): string | null;
  /** An image -> the markdown to write, or null to keep it as written. */
  image(alt: string, url: string): string | null;
  /** The body of a JSX comment, without its markers -> what to write. */
  comment(body: string): string;
  /** A tag met in running text -> what to write in its place. */
  tag(tag: Tag, raw: string): string;
  /** A `{...}` expression that is not a comment -> what to write. */
  expression(raw: string): string;
  /** Plain text between the constructs above -> the text with Lens syntax escaped. */
  text(text: string): string;
  /** Called for each `[^label]` reference. The reference itself is copied as written. */
  footnote(label: string): void;
}

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;

/** Index of the blank line that ends the paragraph `from` is in, or the end of `text`. */
function paragraphEnd(text: string, from: number): number {
  const blank = /\n[ \t]*\n/g;
  blank.lastIndex = from;
  return blank.exec(text)?.index ?? text.length;
}

/** Index of a run of exactly `length` times `char` in [from, limit), or -1. */
function closingRun(text: string, from: number, char: string, length: number, limit: number): number {
  for (let i = from; i < limit; i++) {
    if (text[i] !== char) continue;
    let end = i;
    while (text[end] === char) end++;
    if (end - i === length) return i;
    i = end - 1;
  }
  return -1;
}

interface Span {
  bodyStart: number;
  bodyEnd: number;
  end: number;
}

/**
 * The code span or formula that opens at `at`, or null when its backticks or
 * dollars are plain characters. Both close at the next run of the same
 * length in the paragraph, and nothing inside is an escape.
 */
function spanAt(text: string, at: number): Span | null {
  const char = text[at];
  let bodyStart = at;
  while (text[bodyStart] === char) bodyStart++;
  const bodyEnd = closingRun(text, bodyStart, char, bodyStart - at, paragraphEnd(text, at));
  return bodyEnd < 0 ? null : { bodyStart, bodyEnd, end: bodyEnd + (bodyStart - at) };
}

/**
 * `text` with every code span and formula blanked out, same length. For
 * finding tags and comments on a line: `$a<B>c$` holds no tag.
 */
export function maskSpans(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === "\\" && ASCII_PUNCTUATION.test(text[i + 1] ?? "")) {
      out += "  ";
      i += 2;
    } else if (char === "`" || char === "$") {
      const span = spanAt(text, i);
      const end = span ? span.end : i + 1;
      out += " ".repeat(end - i);
      i = end;
    } else {
      out += char;
      i++;
    }
  }
  return out;
}

/** Index after the bracket that closes the one at `open`, skipping spans; -1 when none does. */
function bracketEnd(text: string, open: number, limit: number): number {
  const [opener, closer] = text[open] === "[" ? "[]" : "{}";
  let depth = 0;
  for (let i = open; i < limit; i++) {
    const char = text[i];
    if (char === "\\") i++;
    else if (char === "`" || char === "$") i = (spanAt(text, i)?.end ?? i + 1) - 1;
    else if (char === opener) depth++;
    else if (char === closer && --depth === 0) return i + 1;
  }
  return -1;
}

interface Destination {
  url: string;
  /** The title with the space before it, as written; "" when there is none. */
  title: string;
  end: number;
}

/** The `(url "title")` of a link, opening at `open`, or null. */
function destinationAt(text: string, open: number): Destination | null {
  const match =
    /^\(\s*(?:<([^<>\n]*)>|((?:[^\s()\\]|\\.|\([^\s()]*\))*))(\s+(?:"[^"]*"|'[^']*'))?\s*\)/.exec(text.slice(open));
  return match ? { url: match[1] ?? match[2], title: match[3] ?? "", end: open + match[0].length } : null;
}

const HTML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, dec, hex, name) =>
    dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : (HTML_ENTITIES[name] ?? whole),
  );
}

/** The JSX or HTML tag that starts at `at`: `<Exercise id="x">`, `</div>`, `<Figure src="..." />`. */
export function tagAt(text: string, at: number): Tag | null {
  const head = /^<(\/?)([A-Za-z][\w.-]*)/.exec(text.slice(at, at + 80));
  if (!head) return null;
  const attributes: Record<string, string> = {};
  let i = at + head[0].length;
  for (;;) {
    const space = /^\s*/.exec(text.slice(i, i + 200))![0].length;
    i += space;
    const close = /^(\/?)>/.exec(text.slice(i, i + 2));
    if (close) return { name: head[2], closing: head[1] === "/", selfClosing: close[1] === "/", attributes, end: i + close[0].length };
    const name = space > 0 ? /^[A-Za-z_:][\w:.-]*/.exec(text.slice(i, i + 80))?.[0] : undefined;
    if (!name) return null;
    i += name.length;
    if (text[i] !== "=") {
      attributes[name] = "";
      continue;
    }
    const quote = text[i + 1];
    const end = quote === '"' || quote === "'" ? text.indexOf(quote, i + 2) + 1 : quote === "{" ? bracketEnd(text, i + 1, text.length) : 0;
    if (end <= 0) return null;
    const value = text.slice(i + 2, end - 1);
    // `title={"..."}` is the one expression form whose value is known without running it.
    attributes[name] = quote === "{" ? value.replace(/^\s*(["'`])([\s\S]*)\1\s*$/, "$2") : decodeEntities(value);
    i = end;
  }
}

/** What would start a list, a heading or a quote if it opened a line. */
function escapeBlockStart(text: string): string {
  return text
    .replace(/^(\d+)([.)])(?=\s|$)/, "$1\\$2")
    .replace(/^([-+*>]|#{1,6})(?=\s|$)/, "\\$1");
}

/** True when `written` ends where a block can start: at the head of a line, after list and quote markers only. */
function atBlockStart(written: string): boolean {
  const line = written.slice(written.lastIndexOf("\n") + 1);
  return /^[\s>]*(?:(?:[-+*]|\d+[.)])\s+)*$/.test(line);
}

/** Convert the running text of one or more paragraphs. Line breaks are kept as they are. */
export function convertInline(source: string, rules: InlineRules): string {
  let out = "";
  let plain = "";
  const flush = () => {
    if (plain) out += rules.text(plain);
    plain = "";
  };
  const write = (converted: string) => {
    flush();
    out += converted;
  };

  let i = 0;
  while (i < source.length) {
    const char = source[i];

    if (char === "\\" && ASCII_PUNCTUATION.test(source[i + 1] ?? "")) {
      write(source.slice(i, i + 2));
      i += 2;
      continue;
    }

    if (char === "`" || char === "$") {
      const span = spanAt(source, i);
      if (!span) {
        let end = i;
        while (source[end] === char) end++;
        write(source.slice(i, end));
        i = end;
        continue;
      }
      if (char === "`") write(rules.code(source.slice(i, span.end)));
      else {
        // Lens reads `$$...$$` as a formula wherever it stands, and a single `$` as a dollar.
        const tex = rules.math(source.slice(span.bodyStart, span.bodyEnd));
        if (tex) write(`$$${tex}$$`);
      }
      i = span.end;
      continue;
    }

    if (char === "[" || (char === "!" && source[i + 1] === "[")) {
      const open = char === "!" ? i + 1 : i;
      const footnote = char === "[" ? /^\[\^([^\]\s]+)\]/.exec(source.slice(i, i + 200)) : null;
      if (footnote) {
        rules.footnote(footnote[1]);
        write(footnote[0]);
        i += footnote[0].length;
        continue;
      }
      const labelEnd = bracketEnd(source, open, paragraphEnd(source, i));
      const destination = labelEnd > 0 && source[labelEnd] === "(" ? destinationAt(source, labelEnd) : null;
      if (destination) {
        const label = source.slice(open + 1, labelEnd - 1);
        const asWritten = source.slice(labelEnd, destination.end);
        if (char === "!") {
          write(rules.image(label, destination.url) ?? `![${convertInline(label, rules)}]${asWritten}`);
        } else {
          const text = convertInline(label, rules);
          const url = rules.link(text, destination.url);
          flush();
          if (url === null) out += atBlockStart(out) ? escapeBlockStart(text) : text;
          else out += `[${text}]${url === destination.url ? asWritten : `(${url}${destination.title})`}`;
        }
        i = destination.end;
        continue;
      }
    }

    if (char === "<") {
      const autolink = /^<(?:https?:\/\/|mailto:)[^\s<>]*>/i.exec(source.slice(i, i + 2000));
      const tag = autolink ? null : tagAt(source, i);
      if (autolink) {
        const url = autolink[0].slice(1, -1);
        rules.link(url, url);
        write(autolink[0]);
        i += autolink[0].length;
        continue;
      }
      if (tag) {
        write(rules.tag(tag, source.slice(i, tag.end)));
        i = tag.end;
        continue;
      }
    }

    if (char === "{") {
      const commentEnd = source.startsWith("{/*", i) ? source.indexOf("*/}", i + 3) : -1;
      const end = commentEnd >= 0 ? commentEnd + 3 : bracketEnd(source, i, source.length);
      if (end > 0) {
        write(commentEnd >= 0 ? rules.comment(source.slice(i + 3, commentEnd)) : rules.expression(source.slice(i, end)));
        i = end;
        continue;
      }
    }

    plain += char;
    i++;
  }
  flush();
  return out;
}
