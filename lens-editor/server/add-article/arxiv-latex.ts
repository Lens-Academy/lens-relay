import { spawn } from "node:child_process";
import * as path from "node:path";
import zlib from "node:zlib";
import type { PdfPageImage } from "./pdf-images";

/**
 * arXiv e-print source (the LaTeX the authors uploaded) to HTML.
 *
 * arXiv's own HTML (arxiv.org/html, ar5iv) is a LaTeXML conversion that is
 * often damaged: it dies part-way and serves the fragment (Functional Decision
 * Theory stops in section 5), serves "No content available" (Compact Proofs),
 * or garbles display math. The e-print archive is the paper itself, so the
 * importer converts it here with pandoc and hands the HTML to the arXiv adapter.
 *
 * Steps: unpack the archive (gzip, tar or a single gzipped .tex); find the
 * main .tex; inline its \input/\include files, the macro definitions of the
 * packages and class shipped beside it (pandoc cannot read most .sty files)
 * and the bibliography; replace citations with their labels; then run
 * `pandoc --sandbox`, which reads only the document it is given on stdin, so
 * a hostile `\input{/etc/passwd}` reads nothing. Raster figures are returned
 * as images for the pipeline to host and PDF figures are drawn to PNG first
 * (pdftoppm); figures that cannot be drawn (EPS, TikZ) are dropped, their
 * captions stay.
 */

/** Marker the adapter recognises the converted document by. */
export const ARXIV_LATEX_MARKER = "lens-arxiv-latex";
/** `src` scheme of a figure the pipeline hosts from `images`. */
export const SOURCE_IMAGE_SCHEME = "lens-source-image:";

const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const MAX_FLAT_TEX_CHARS = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES = 200;
const PANDOC_TIMEOUT_MS = 3 * 60_000;
/** Placeholder <title> for documents without \title (pandoc -s insists on one). */
const PANDOC_PAGETITLE = "lens-untitled-arxiv-source";
/** pandoc's heap cap (its manual's advice for untrusted input): a runaway
 *  macro expansion fails fast instead of eating the server's memory. */
const PANDOC_HEAP = process.env.PANDOC_MAX_HEAP || "2048m";
const MAX_PANDOC_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface ConvertedSource {
  html: string;
  images: PdfPageImage[];
}

// --- archive -----------------------------------------------------------------

function isPdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-";
}

function isTar(bytes: Uint8Array): boolean {
  return bytes.length >= 512 && Buffer.from(bytes.subarray(257, 262)).toString("latin1") === "ustar";
}

function cString(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul < 0 ? slice.length : nul).toString("utf8");
}

/** Archive member path, normalised; null for anything outside the archive. */
function safeMemberPath(name: string): string | null {
  const clean = path.posix.normalize(name.replace(/\\/g, "/")).replace(/^(\.\/)+/, "");
  if (!clean || clean === "." || clean.startsWith("/") || clean.startsWith("../") || clean === "..") return null;
  return clean;
}

/** Regular files of a (ustar / GNU / pax) tar archive. */
export function parseTar(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const size = parseInt(cString(header, 124, 12).trim() || "0", 8) || 0;
    const type = String.fromCharCode(header[156] || 48);
    const prefix = cString(header, 345, 155);
    const baseName = cString(header, 0, 100);
    const dataStart = offset + 512;
    const data = buf.subarray(dataStart, Math.min(dataStart + size, buf.length));
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = cString(data, 0, data.length);
      continue;
    }
    if (type === "x") {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString("utf8"));
      paxPath = m ? m[1] : null;
      continue;
    }
    const name = paxPath ?? longName ?? (prefix ? `${prefix}/${baseName}` : baseName);
    longName = null;
    paxPath = null;
    if (type !== "0" && type !== "\0" && type !== "7") continue;
    const member = safeMemberPath(name);
    if (member) files.set(member, Buffer.from(data));
  }
  return files;
}

/**
 * Files of an arXiv e-print. Null when the e-print is a PDF (a PDF-only
 * submission: the caller extracts it as one). Throws for anything else that
 * is not LaTeX (old PostScript submissions), so the next candidate is tried.
 */
export function unpackArxivSource(bytes: Uint8Array): Map<string, Buffer> | null {
  if (isPdf(bytes)) return null;
  let raw = Buffer.from(bytes);
  if (raw[0] === 0x1f && raw[1] === 0x8b) {
    raw = zlib.gunzipSync(raw, { maxOutputLength: MAX_UNPACKED_BYTES });
  }
  // A gzipped PDF: the caller only sees the gzip bytes, so fail the candidate
  // and let the arxiv.org/pdf candidate bring the PDF itself.
  if (isPdf(raw)) throw new Error("arXiv e-print is a gzipped PDF");
  if (isTar(raw)) return parseTar(raw);
  const text = raw.toString("utf8");
  if (/\\documentclass|\\begin\{document\}/.test(text)) return new Map([["main.tex", raw]]);
  throw new Error("arXiv e-print is neither LaTeX nor a PDF");
}

/** The .tex file that holds `\documentclass` and the document body. */
export function findMainTex(files: Map<string, Buffer>): string | null {
  const roots = [...files.keys()].filter((name) => {
    if (!/\.tex$/i.test(name)) return false;
    const text = stripComments(files.get(name)!.toString("utf8"));
    return /\\documentclass/.test(text) && /\\begin\s*\{document\}/.test(text);
  });
  if (roots.length === 0) return null;
  const preferred = roots.find((name) => /^(?:.*\/)?(?:main|ms|paper|arxiv)\.tex$/i.test(name));
  if (preferred) return preferred;
  // Shallowest first, then the largest (the paper rather than a supplement).
  return roots.sort(
    (a, b) => a.split("/").length - b.split("/").length || files.get(b)!.length - files.get(a)!.length,
  )[0];
}

// --- LaTeX text helpers ----------------------------------------------------------

/** Where `%` is not a comment: verbatim environments and URL arguments. */
const VERBATIM_RE =
  /\\begin\s*\{(verbatim\*?|lstlisting|minted|Verbatim)\}[\s\S]*?\\end\s*\{\1\}|\\(?:url|href)\s*\{[^{}\n]*\}/g;

/** Remove `%` comments (an escaped `\%`, verbatim text and URLs stay). */
export function stripComments(tex: string): string {
  // TeX's `%` also eats the line break and the next line's indentation, so a
  // comment-only line inside a paragraph does not split it into two.
  const strip = (part: string) => part.replace(/(^|[^\\])((?:\\\\)*)%[^\n]*(?:\n[ \t]*)?/g, "$1$2");
  let out = "";
  let last = 0;
  for (const m of tex.matchAll(VERBATIM_RE)) {
    const before = tex.slice(last, m.index);
    // A `%` earlier on the same line comments the "verbatim" text out too.
    const lineStart = before.lastIndexOf("\n") + 1;
    if (/(^|[^\\])(?:\\\\)*%/.test(before.slice(lineStart))) continue;
    out += strip(before) + m[0];
    last = m.index + m[0].length;
  }
  return out + strip(tex.slice(last));
}

/** Index just past the brace group opening at `open` (`tex[open] === "{"`). */
export function groupEnd(tex: string, open: number): number {
  let depth = 0;
  for (let i = open; i < tex.length; i += 1) {
    const ch = tex[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return tex.length;
}

function skipSpace(tex: string, i: number): number {
  while (i < tex.length && /\s/.test(tex[i])) i += 1;
  return i;
}

/** Optional `[…]` argument at `i` (nesting-aware); returns [content, end]. */
function optionalArg(tex: string, i: number): [string | null, number] {
  const j = skipSpace(tex, i);
  if (tex[j] !== "[") return [null, i];
  let depth = 0;
  for (let k = j; k < tex.length; k += 1) {
    if (tex[k] === "{") k = groupEnd(tex, k) - 1;
    else if (tex[k] === "[") depth += 1;
    else if (tex[k] === "]") {
      depth -= 1;
      if (depth === 0) return [tex.slice(j + 1, k), k + 1];
    }
  }
  return [null, i];
}

/** Mandatory `{…}` argument at `i`; returns [content, end] or null. */
function braceArg(tex: string, i: number): [string, number] | null {
  const j = skipSpace(tex, i);
  if (tex[j] !== "{") return null;
  const end = groupEnd(tex, j);
  return [tex.slice(j + 1, end - 1), end];
}

/** Layout and TeX-programming tokens: a definition using one is typesetting
 *  machinery (title pages, fonts, page furniture), not notation. */
const MACHINERY_RE =
  /\\(?:[gex]?def|let|if[a-zA-Z@]*|fi|else|expandafter|csname|noexpand|[vh]box|[vh]skip|[vh]space|[vh]fil+|kern|par\b|selectfont|fontsize|setcounter|addtocounter|setlength|insert|begingroup|endgroup|bgroup|egroup|relax|makeatletter|makeatother|Begin[A-Za-z]+|End[A-Za-z]+|begin\s*\{(?:tabular|minipage|center)|newpage|clearpage|pagestyle|thispagestyle|titlebox|@)/;

/** Commands pandoc itself handles; a package redefining one only breaks it. */
const RESERVED_NAMES = new Set([
  "maketitle", "title", "author", "date", "thanks", "and", "section", "subsection", "subsubsection",
  "paragraph", "footnote", "footnotesize", "small", "large", "Large", "normalsize", "caption", "label",
  "ref", "cite", "emph", "textbf", "textit", "item", "url", "href", "include", "input", "abstract",
]);

/**
 * Notation macros defined in a package or class file shipped with the paper:
 * `\newcommand`, `\providecommand`, `\DeclareMathOperator` and simple `\def`s.
 * pandoc cannot load most real packages, so these are inlined where the
 * document loads the file and pandoc expands them like the document's own.
 * Typesetting machinery (anything using TeX internals, boxes, fonts, `@`
 * names) and redefinitions of standard commands are left out: they serve the
 * page, and handed to pandoc they derail its parse.
 */
export function harvestMacroDefinitions(sty: string): string {
  const tex = stripComments(sty);
  const out: string[] = [];
  const re = /\\(?:newcommand|providecommand|DeclareRobustCommand|DeclareMathOperator)\*?|\\def(?=\\)/g;
  for (let m = re.exec(tex); m; m = re.exec(tex)) {
    const start = m.index;
    let i = m.index + m[0].length;
    let name = "";
    let def = "";
    if (m[0] === "\\def") {
      const head = /^\\([A-Za-z]+)((?:#\d)*)\s*(?=\{)/.exec(tex.slice(i));
      if (!head) continue;
      name = head[1];
      i += head[0].length;
      def = tex.slice(start, groupEnd(tex, i));
    } else {
      // \newcommand{\name}[n][default]{body} or \newcommand\name...
      i = skipSpace(tex, i);
      const braced = /^\{\s*\\([A-Za-z@]+)\s*\}/.exec(tex.slice(i));
      const bare = /^\\([A-Za-z@]+)/.exec(tex.slice(i));
      const found = braced ?? bare;
      if (!found) continue;
      name = found[1];
      i += found[0].length;
      for (let k = 0; k < 2; k += 1) i = optionalArg(tex, i)[1];
      const body = braceArg(tex, i);
      if (!body) continue;
      def = tex.slice(start, body[1]);
    }
    re.lastIndex = start + def.length;
    if (!/^[A-Za-z]+$/.test(name) || RESERVED_NAMES.has(name)) continue;
    const bodyText = def.slice(def.indexOf(name) + name.length);
    if (MACHINERY_RE.test(bodyText)) continue;
    out.push(def.replace(/^\\def\\([A-Za-z]+)(?!#)/, "\\providecommand{\\$1}"));
  }
  return out.join("\n");
}

/** Commands KaTeX or pandoc lack that papers load from packages, mapped to ones they have. */
const MACRO_SHIMS = [
  "\\providecommand{\\mleft}{\\left}",
  "\\providecommand{\\mright}{\\right}",
  "\\providecommand{\\mathds}[1]{\\mathbb{#1}}",
  "\\providecommand{\\bm}[1]{\\boldsymbol{#1}}",
  "\\providecommand{\\xspace}{}",  // see keepXspaceSpaces
  // Cross-reference commands pandoc drops whole ("as shown in ()"); \cref and
  // \ref it resolves to the number.
  "\\providecommand{\\Cref}[1]{\\cref{#1}}",
  "\\providecommand{\\Autoref}[1]{\\autoref{#1}}",
  "\\providecommand{\\nameref}[1]{\\ref{#1}}",
  "\\providecommand{\\vref}[1]{\\ref{#1}}",
  "\\providecommand{\\cpageref}[1]{\\ref{#1}}",
  "\\providecommand{\\Cpageref}[1]{\\ref{#1}}",
  // Conference-style title blocks: pandoc splits authors only on \and, and
  // sees the title only through \title.
  "\\providecommand{\\And}{\\and}",
  "\\providecommand{\\AND}{\\and}",
  "\\providecommand{\\icmltitle}[1]{\\title{#1}}",
].join("\n");

// --- flattening ------------------------------------------------------------------

function resolveMember(
  files: Map<string, Buffer>,
  dir: string,
  name: string,
  exts: string[],
  searchDirs: string[] = [],
): string | null {
  const clean = name.trim().replace(/^"|"$/g, "");
  for (const ext of ["", ...exts]) {
    const bases = [path.posix.join(dir, clean + ext), clean + ext];
    for (const extra of searchDirs) bases.push(path.posix.join(dir, extra, clean + ext), path.posix.join(extra, clean + ext));
    for (const base of bases) {
      const member = safeMemberPath(base);
      if (member && files.has(member)) return member;
    }
  }
  return null;
}

const INPUT_RE = /\\(input|include|subfile)\s*\{([^{}]+)\}|\\input\s+([^\s{}\\]+)/g;

function inlineInputs(files: Map<string, Buffer>, tex: string, dir: string, depth: number, seen: Set<string>): string {
  if (depth > 20) return tex;
  return tex.replace(INPUT_RE, (whole, _cmd: string, braced: string | undefined, bare: string | undefined) => {
    const member = resolveMember(files, dir, braced ?? bare ?? "", [".tex"]);
    if (!member || !/\.tex$/i.test(member) || seen.has(member)) return "";
    seen.add(member);
    const inner = stripComments(files.get(member)!.toString("utf8"));
    // `\subfile`d documents carry their own preamble; keep only the body.
    const body = /\\begin\s*\{document\}([\s\S]*)\\end\s*\{document\}/.exec(inner)?.[1] ?? inner;
    const out = inlineInputs(files, body, dir, depth + 1, seen);
    seen.delete(member);
    return `\n${out}\n`;
  });
}

/**
 * `\xspace` ends a macro so that `\Act is` keeps its space; pandoc has no
 * xspace and TeX eats the space after a control word. Give each such macro
 * an empty group where it is followed by a word, which keeps the space.
 */
export function keepXspaceSpaces(tex: string): string {
  const names = new Set<string>();
  const def = /\\(?:re)?newcommand\*?\s*\{?\\([A-Za-z]+)\}?(?:\s*\[\d\])?\s*\{([^\n]*)\}/g;
  for (let m = def.exec(tex); m; m = def.exec(tex)) {
    if (/\\xspace\s*$/.test(m[2])) names.add(m[1]);
  }
  if (names.size === 0) return tex;
  return tex.replace(/\\([A-Za-z]+)(\s+)(?=[A-Za-z0-9(])/g, (whole, name: string, space: string) =>
    names.has(name) ? `\\${name}{}${space}` : whole,
  );
}

/**
 * thm-restate: `\begin{restatable}[name]{theorem}{label}…\end{restatable}` is
 * a theorem whose statement `\label*` (or `\label`) repeats later. pandoc
 * knows neither, and prints the arguments as prose; rewrite both into the
 * plain theorem environment.
 */
export function expandRestatable(tex: string): string {
  const bodies = new Map<string, string>();
  const re = /\\begin\s*\{restatable\*?\}\s*(\[[^\]]*\])?\s*\{([A-Za-z*]+)\}\s*\{([A-Za-z]+)\}([\s\S]*?)\\end\s*\{restatable\*?\}/g;
  const out = tex.replace(re, (_whole, opt: string | undefined, env: string, name: string, body: string) => {
    const block = `\\begin{${env}}${opt ?? ""}${body}\\end{${env}}`;
    bodies.set(name, block);
    return block;
  });
  if (bodies.size === 0) return out;
  return out.replace(/\\([A-Za-z]+)\*?(?![A-Za-z])/g, (whole, name: string) => bodies.get(name) ?? whole);
}

/** Replace `\usepackage{local}` (and the local class) with their macro definitions. */
function inlineLocalPackages(files: Map<string, Buffer>, tex: string, dir: string): string {
  let out = tex.replace(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}/g, (whole, names: string) => {
    const keep: string[] = [];
    const defs: string[] = [];
    for (const name of names.split(",").map((n) => n.trim()).filter(Boolean)) {
      const member = resolveMember(files, dir, name, [".sty"]);
      if (member && /\.sty$/i.test(member)) defs.push(harvestMacroDefinitions(files.get(member)!.toString("utf8")));
      else keep.push(name);
    }
    if (defs.length === 0) return whole;
    return `${keep.length ? `\\usepackage{${keep.join(",")}}\n` : ""}${defs.join("\n")}\n`;
  });
  const cls = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}/.exec(out);
  const clsMember = cls && resolveMember(files, dir, cls[1], [".cls"]);
  const classDefs = clsMember && /\.cls$/i.test(clsMember)
    ? harvestMacroDefinitions(files.get(clsMember)!.toString("utf8"))
    : "";
  if (cls) {
    const at = cls.index + cls[0].length;
    out = `${out.slice(0, at)}\n${MACRO_SHIMS}\n${classDefs}\n${out.slice(at)}`;
  }
  return out;
}

// --- bibliography and citations --------------------------------------------------

export interface BibEntry {
  key: string;
  /** Short in-text author form: "Gibbard and Harper", "Garrabrant et al.". */
  authors: string;
  year: string;
  /** Full reference, LaTeX. */
  reference: string;
}

function detex(s: string): string {
  return s
    .replace(/\\bibnamedelim[a-z]|\\bibinitperiod|\\bibinitdelim|~/g, " ")
    .replace(/\\(?:emph|textit|textbf|textsc|mkbibemph)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\protect\b|\\newblock\b|\\[a-zA-Z@]+\*?(?=\s*\{)/g, "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function shortAuthors(families: string[]): string {
  if (families.length === 0) return "";
  if (families.length === 1) return families[0];
  if (families.length === 2) return `${families[0]} and ${families[1]}`;
  return `${families[0]} et al.`;
}

/** Entries of a biblatex `.bbl` (`\entry{key}…\endentry`). */
export function parseBiblatexBbl(bbl: string): BibEntry[] {
  const entries: BibEntry[] = [];
  const re = /\\entry\{([^}]*)\}\{([^}]*)\}\{[^}]*\}([\s\S]*?)\\endentry/g;
  for (let m = re.exec(bbl); m; m = re.exec(bbl)) {
    const [, key, , body] = m;
    const field = (name: string) => {
      const f = new RegExp(`\\\\field\\{${name}\\}\\{`).exec(body);
      if (!f) return "";
      const open = f.index + f[0].length - 1;
      return detex(body.slice(open + 1, groupEnd(body, open) - 1));
    };
    const names = (role: string) => {
      const n = new RegExp(`\\\\name\\{${role}\\}\\{\\d+\\}\\{[^}]*\\}\\{`).exec(body);
      if (!n) return [] as { family: string; given: string }[];
      const open = n.index + n[0].length - 1;
      const list = body.slice(open, groupEnd(body, open));
      const people: { family: string; given: string }[] = [];
      const person = /family=\{((?:[^{}]|\{[^{}]*\})*)\}(?:[\s\S]*?given=\{((?:[^{}]|\{[^{}]*\})*)\})?/g;
      for (let p = person.exec(list); p; p = person.exec(list)) {
        people.push({ family: detex(p[1]), given: detex(p[2] || "") });
      }
      return people;
    };
    const authors = names("author").length ? names("author") : names("editor");
    const label = /\\list\{organization\}\{\d+\}\{%?\s*\{%?\s*([^}]*)\}/.exec(body)?.[1];
    const year = field("year") || field("labelyear") || (/\\field\{(?:date|urlyear)\}\{(\d{4})/.exec(body)?.[1] ?? "");
    const families = authors.map((a) => a.family).filter(Boolean);
    const title = field("title");
    const container = field("journaltitle") || field("booktitle") || field("series");
    const who = authors.map((a) => (a.given ? `${a.family}, ${a.given}` : a.family)).join("; ") || detex(label || "");
    const reference = [who, year, title ? `\\emph{${title}}` : "", container]
      .map((part) => part.replace(/\.+$/, "").trim())
      .filter(Boolean)
      .join(". ");
    entries.push({ key, authors: shortAuthors(families) || detex(label || key), year, reference: `${reference}.` });
  }
  return entries;
}

/** Entries of a BibTeX/natbib `.bbl` (`\begin{thebibliography}` with `\bibitem`). */
export function parseBibitemBbl(bbl: string): BibEntry[] {
  const entries: BibEntry[] = [];
  const parts = bbl.split(/\\bibitem\b/).slice(1);
  for (const part of parts) {
    let i = 0;
    const [label, afterLabel] = optionalArg(part, i);
    i = afterLabel;
    const key = braceArg(part, i);
    if (!key) continue;
    const text = part.slice(key[1]).replace(/\\end\s*\{thebibliography\}[\s\S]*$/, "").trim();
    let authors = "";
    let year = "";
    if (label) {
      // natbib: [{Gibbard and Harper}(1978)], or \citeauthoryear{short}{long}{year}
      const cay = /\\citeauthoryear\s*\{([^}]*)\}\s*(?:\{[^}]*\}\s*)?\{([^}]*)\}/.exec(label);
      const nat = /^([\s\S]*?)\(([^()]*)\)\s*([\s\S]*)$/.exec(label);
      if (cay) {
        authors = detex(cay[1]);
        year = detex(cay[2]);
      } else if (nat) {
        authors = detex(nat[1]);
        year = detex(nat[2]);
      } else authors = detex(label);
    }
    entries.push({ key: key[0].trim(), authors, year, reference: text });
  }
  return entries;
}

type CiteStyle = "author-year" | "numeric";

function citeStyle(tex: string, bblKind: "biblatex" | "bibitem", entries: BibEntry[]): CiteStyle {
  if (bblKind === "bibitem") return entries.some((e) => e.authors && e.year) ? "author-year" : "numeric";
  const opts = /\\usepackage\s*\[([^\]]*)\]\s*\{biblatex(?:-chicago)?\}/.exec(tex)?.[1] ?? "";
  const cls = /\\documentclass\s*\[([^\]]*)\]/.exec(tex)?.[1] ?? "";
  if (/style\s*=\s*(?:numeric|ieee|alphabetic|nature)/.test(opts)) return "numeric";
  if (/authoryear|authordate|apa|chicago/.test(opts + cls) || /biblatex-chicago/.test(tex)) return "author-year";
  return "numeric";
}

/**
 * Replace every citation command with its label text, so pandoc (which has no
 * bibliography database) never prints an empty citation.
 */
export function replaceCitations(tex: string, entries: BibEntry[], style: CiteStyle): string {
  const byKey = new Map(entries.map((e, i) => [e.key, { ...e, n: i + 1 }]));
  const re = /\\(cite[a-zA-Z]*|[pP]arencite|[tT]extcite|[aA]utocite|footcite|smartcite|nocite)\*?(?=\s*[[{])/g;
  let out = "";
  let last = 0;
  for (let m = re.exec(tex); m; m = re.exec(tex)) {
    let i = m.index + m[0].length;
    const [opt1, a1] = optionalArg(tex, i);
    const [opt2, a2] = optionalArg(tex, a1);
    i = a2;
    const keysArg = braceArg(tex, i);
    if (!keysArg) continue;
    const cmd = m[1].toLowerCase();
    const keys = keysArg[0].split(",").map((k) => k.trim()).filter(Boolean);
    const pre = opt2 !== null ? opt1 : null;
    const post = opt2 !== null ? opt2 : opt1;
    let text: string;
    const items = keys.map((k) => byKey.get(k));
    const names = (e: (typeof items)[number], k: string) => e?.authors || k;
    if (cmd === "nocite") text = "";
    else if (cmd === "citeauthor") text = keys.map((k, j) => names(items[j], k)).join("; ");
    else if (cmd === "citeyear" || cmd === "citeyearpar") {
      const years = keys.map((k, j) => items[j]?.year || k).join("; ");
      text = cmd === "citeyearpar" ? `(${years})` : years;
    } else if (style === "numeric") {
      const nums = keys.map((k, j) => (items[j] ? String(items[j]!.n) : k)).join(", ");
      const body = [pre, nums, post].filter(Boolean).join(" ");
      text = cmd === "citet" || cmd === "textcite"
        ? `${keys.map((k, j) => names(items[j], k)).join("; ")} [${[nums, post].filter(Boolean).join(", ")}]`
        : `[${body}]`;
    } else if (cmd === "citet" || cmd === "textcite" || cmd === "citealt") {
      text = keys
        .map((k, j) => (items[j]?.year ? `${names(items[j], k)} (${items[j]!.year}${post && j === keys.length - 1 ? `, ${post}` : ""})` : names(items[j], k)))
        .join("; ");
    } else {
      const list = keys.map((k, j) => [names(items[j], k), items[j]?.year].filter(Boolean).join(" ")).join("; ");
      const body = [pre, list].filter(Boolean).join(" ") + (post ? `, ${post}` : "");
      text = cmd === "citealp" ? body : `(${body})`;
    }
    out += tex.slice(last, m.index) + text;
    last = keysArg[1];
    re.lastIndex = keysArg[1];
  }
  return out + tex.slice(last);
}

function referencesSection(entries: BibEntry[], style: CiteStyle): string {
  if (entries.length === 0) return "";
  // `{}` first: a `[n]` right after \item is its optional label, which pandoc drops.
  const items = entries.map((e, i) => `\\item {}${style === "numeric" ? `[${i + 1}] ` : ""}${e.reference}`).join("\n");
  return `\n\\section*{References}\n\\begin{itemize}\n${items}\n\\end{itemize}\n`;
}

// --- the whole document ------------------------------------------------------------

/** One self-contained LaTeX document pandoc can convert on its own. */
export function flattenArxivSource(files: Map<string, Buffer>, main: string): string {
  const dir = path.posix.dirname(main) === "." ? "" : path.posix.dirname(main);
  let tex = stripComments(files.get(main)!.toString("utf8"));
  tex = inlineInputs(files, tex, dir, 0, new Set([main]));
  tex = tex.replace(/\\begin\s*\{comment\}[\s\S]*?\\end\s*\{comment\}/g, "");
  tex = expandRestatable(tex);
  tex = keepXspaceSpaces(tex);
  // amsmath's \text works in prose too (papers define `\Var{x}` as
  // `\text{\textsc{x}}` and use it in both), but pandoc drops it outside math.
  // \textnormal means the same in both modes to pandoc and to KaTeX.
  tex = tex.replace(/\\text(?![A-Za-z])/g, "\\textnormal");
  tex = inlineLocalPackages(files, tex, dir);

  // The .bbl beside the main file (or named by \bibliography) holds the
  // resolved references; pandoc has no BibTeX, so labels are spliced in.
  const bibName = /\\bibliography\s*\{([^}]*)\}/.exec(tex)?.[1]?.split(",")[0];
  const bblMember =
    resolveMember(files, dir, main.replace(/\.tex$/i, "").split("/").pop()!, [".bbl"]) ||
    (bibName ? resolveMember(files, dir, bibName, [".bbl"]) : null) ||
    [...files.keys()].find((name) => /\.bbl$/i.test(name)) ||
    null;
  const bbl = bblMember ? files.get(bblMember)!.toString("utf8") : "";
  const kind = /\\entry\{/.test(bbl) ? "biblatex" : "bibitem";
  const entries = kind === "biblatex" ? parseBiblatexBbl(bbl) : parseBibitemBbl(bbl);
  const style = citeStyle(tex, kind, entries);
  tex = replaceCitations(tex, entries, style);
  const refs = referencesSection(entries, style);
  let placed = false;
  tex = tex.replace(/\\bibliography\s*\{[^}]*\}|\\printbibliography\b(?:\s*\[[^\]]*\])?/g, () => {
    if (placed) return "";
    placed = true;
    return refs;
  });
  tex = tex.replace(/\\(?:bibliographystyle|addbibresource)\s*(?:\[[^\]]*\])?\s*\{[^}]*\}/g, "");
  if (!placed && refs) tex = tex.replace(/\\end\s*\{document\}/, `${refs}\n\\end{document}`);
  if (tex.length > MAX_FLAT_TEX_CHARS) throw new Error(`arXiv source too large (${tex.length} chars)`);
  return tex;
}

/** Run pandoc on a LaTeX document; resolves to standalone HTML. */
export function runPandoc(tex: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const child = spawn(
      process.env.PANDOC_PATH || "pandoc",
      ["+RTS", `-M${PANDOC_HEAP}`, "-RTS", "--sandbox", "-f", "latex", "-t", "html5", "-s", "--mathjax", "--wrap=none", "--metadata", `pagetitle=${PANDOC_PAGETITLE}`],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(() => reject(signal?.reason ?? new Error("aborted")));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`pandoc timed out after ${PANDOC_TIMEOUT_MS / 1000}s`)));
    }, PANDOC_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PANDOC_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(() => reject(new Error("pandoc output too large")));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => finish(() => reject(new Error(`pandoc unavailable: ${err.message}`))));
    child.on("close", (code) => {
      if (code === 0) finish(() => resolve(Buffer.concat(chunks).toString("utf8")));
      else finish(() => reject(new Error(`pandoc exited ${code}: ${stderr.split("\n").filter((l) => !/^\[WARNING\]|^\s/.test(l)).join(" ").slice(0, 500)}`)));
    });
    child.stdin.on("error", () => {
      /* reported through close */
    });
    child.stdin.end(tex);
  });
}

const RASTER_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
};

const PDFTOPPM_TIMEOUT_MS = 30_000;

/**
 * First page of a PDF figure as a PNG (poppler's pdftoppm, stdin to stdout),
 * or null when it cannot be drawn. Papers ship most plots as PDFs.
 */
export function rasterizePdfFigure(pdf: Buffer, signal?: AbortSignal): Promise<Buffer | null> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(null);
      return;
    }
    const child = spawn(
      process.env.PDFTOPPM_PATH || "pdftoppm",
      ["-png", "-r", "150", "-f", "1", "-l", "1", "-singlefile", "-"],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: Buffer | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(null);
    };
    const timer = setTimeout(onAbort, PDFTOPPM_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_IMAGE_BYTES) onAbort();
      else chunks.push(chunk);
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      const png = Buffer.concat(chunks);
      finish(code === 0 && png.subarray(1, 4).toString("latin1") === "PNG" ? png : null);
    });
    child.stdin.on("error", () => {
      /* reported through close */
    });
    child.stdin.end(pdf);
  });
}

/**
 * Point figures at the images the pipeline hosts (pandoc writes `<img>`, or
 * `<embed>` for a PDF): raster files as they are,
 * PDF figures drawn to PNG. Figures that cannot be shown (EPS, a PDF that
 * will not draw, an image over the limits) are dropped; captions stay.
 */
export async function attachFigures(
  html: string,
  files: Map<string, Buffer>,
  dir: string,
  rasterize: (pdf: Buffer, signal?: AbortSignal) => Promise<Buffer | null> = rasterizePdfFigure,
  signal?: AbortSignal,
  graphicsDirs: string[] = [],
): Promise<ConvertedSource> {
  const images: PdfPageImage[] = [];
  const byMember = new Map<string, number | null>();
  const tags = [...html.matchAll(/<(?:img|embed)\b[^>]*?\bsrc="([^"]*)"[^>]*>/g)];
  const replacements = new Map<string, string>();
  for (const [tag, src] of tags) {
    if (replacements.has(tag)) continue;
    let name = src;
    try {
      name = decodeURIComponent(src);
    } catch {
      /* keep */
    }
    const member = resolveMember(files, dir, name, [".png", ".jpg", ".jpeg", ".gif", ".pdf"], graphicsDirs);
    let index: number | null | undefined = member ? byMember.get(member) : null;
    if (member && index === undefined) {
      index = null;
      const ext = path.posix.extname(member).toLowerCase();
      const bytes = files.get(member)!;
      let png: Buffer | null = null;
      let mime = RASTER_MIME[ext];
      if (mime) png = bytes;
      else if (ext === ".pdf" && images.length < MAX_IMAGES) {
        png = await rasterize(bytes, signal);
        mime = "image/png";
      }
      if (png && png.length <= MAX_IMAGE_BYTES && images.length < MAX_IMAGES) {
        index = images.length;
        images.push({ png, mime, yTop: 0, width: 0, height: 0 });
      }
      byMember.set(member, index);
    }
    const alt = /\balt="([^"]*)"/.exec(tag)?.[1] ?? "";
    replacements.set(tag, index === null || index === undefined ? "" : `<img src="${SOURCE_IMAGE_SCHEME}${index}" alt="${alt}">`);
  }
  return { html: html.replace(/<(?:img|embed)\b[^>]*?\bsrc="([^"]*)"[^>]*>/g, (tag) => replacements.get(tag) ?? ""), images };
}

/** The directories `\graphicspath{{figures/}{img/}}` adds to figure lookup. */
export function graphicsPathDirs(tex: string): string[] {
  const arg = /\\graphicspath\s*\{((?:\{[^{}]*\}\s*)*)\}/.exec(tex)?.[1] ?? "";
  return [...arg.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1].trim()).filter(Boolean);
}

/**
 * Convert an arXiv e-print to an HTML document for the arXiv adapter. Null
 * when the e-print is not LaTeX (a PDF-only submission: the caller extracts
 * the PDF instead). Throws when the source cannot be converted.
 */
export async function arxivSourceToHtml(bytes: Uint8Array, signal?: AbortSignal): Promise<ConvertedSource | null> {
  const files = unpackArxivSource(bytes);
  if (!files) return null;
  const main = findMainTex(files);
  if (!main) throw new Error("arXiv source has no main .tex file");
  const tex = flattenArxivSource(files, main);
  const html = await runPandoc(tex, signal);
  const dir = path.posix.dirname(main) === "." ? "" : path.posix.dirname(main);
  const converted = await attachFigures(html, files, dir, rasterizePdfFigure, signal, graphicsPathDirs(tex));
  converted.html = converted.html
    // pandoc's <title> is only the --metadata placeholder when it found no
    // \title; an empty one lets the abstract page's title win instead.
    .replace(/<title>[^<]*<\/title>/i, (t) => (t === `<title>${PANDOC_PAGETITLE}</title>` ? "<title></title>" : t))
    .replace(/<head>/i, `<head>\n<meta name="generator" content="${ARXIV_LATEX_MARKER}">`);
  return converted;
}
