/**
 * TeX macros of an Iliad page, expanded in place.
 *
 * iliad-intensive.org renders a page's formulas with one shared macro table:
 * its build writes every `\newcommand` of the LaTeX source as a `\gdef` in a
 * formula at the top of the page. Lens draws each formula alone, with no
 * table, so a formula must not use a macro: `\cM` becomes `{\mathcal{M}}`.
 */

export interface Macro {
  /** How many arguments it takes: `\gdef\dv#1#2{...}` takes 2. */
  params: number;
  body: string;
}

/** The macros defined so far on a page, by name without the backslash. */
export type Macros = Map<string, Macro>;

// A macro can use a macro. Deeper than this is a macro that uses itself.
const MAX_DEPTH = 16;

/** Index after the `}` that closes the `{` at `open`, or -1. */
export function groupEnd(tex: string, open: number): number {
  let depth = 0;
  for (let i = open; i < tex.length; i++) {
    if (tex[i] === "\\") i++;
    else if (tex[i] === "{") depth++;
    else if (tex[i] === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/** The control sequence at `at` (`\alpha`, `\,`), or null. */
function controlSequence(tex: string, at: number): string | null {
  if (tex[at] !== "\\" || at + 1 >= tex.length) return null;
  const word = /^[A-Za-z@]+/.exec(tex.slice(at + 1, at + 64));
  return word ? `\\${word[0]}` : tex.slice(at, at + 2);
}

/**
 * Join two pieces of TeX. A space goes between a control word and a letter
 * that would otherwise read as part of its name (`\beta` + `S` is not
 * `\betaS`). TeX ignores a space after a control word.
 */
function glue(left: string, right: string): string {
  return /\\[A-Za-z@]+$/.test(left) && /^[A-Za-z@]/.test(right) ? `${left} ${right}` : left + right;
}

/**
 * Take the `\gdef` definitions out of a formula and add them to `macros`.
 * `\gdef` is the one definition that outlives its formula on the site.
 */
export function takeDefinitions(tex: string, macros: Macros): string {
  let rest = "";
  let i = 0;
  for (;;) {
    const at = tex.indexOf("\\gdef", i);
    if (at < 0) return rest + tex.slice(i);
    const found = definitionAt(tex, at);
    rest += tex.slice(i, found ? at : at + 5);
    i = found ? found.end : at + 5;
    if (found) macros.set(found.name, found.macro);
  }
}

/** The `\gdef\name#1#2{body}` that starts at `at`, or null. */
function definitionAt(tex: string, at: number): { name: string; macro: Macro; end: number } | null {
  if (controlSequence(tex, at) !== "\\gdef") return null;
  let cursor = skipSpaces(tex, at + 5);
  const name = controlSequence(tex, cursor);
  if (!name) return null;
  cursor += name.length;
  let params = 0;
  while (tex[cursor] === "#" && tex[cursor + 1] === String(params + 1)) {
    params++;
    cursor += 2;
  }
  const end = tex[cursor] === "{" ? groupEnd(tex, cursor) : -1;
  return end < 0 ? null : { name: name.slice(1), macro: { params, body: tex.slice(cursor + 1, end - 1) }, end };
}

/**
 * `\renewcommand{\x}{...}` inside a formula only works where `\x` is already
 * defined, which it no longer is once the page's table is gone. `\def` says
 * the same and needs nothing.
 */
export function redefinitionsAsDef(tex: string): string {
  return tex.replace(/\\renewcommand\s*(?:\{\s*(\\[A-Za-z@]+)\s*\}|(\\[A-Za-z@]+))(?:\[(\d)\])?/g, (_, braced, bare, n) => {
    const params = Array.from({ length: Number(n ?? 0) }, (_, k) => `#${k + 1}`).join("");
    return `\\def${braced ?? bare}${params}`;
  });
}

function skipSpaces(tex: string, at: number): number {
  while (/\s/.test(tex[at] ?? "")) at++;
  return at;
}

/** One undelimited TeX argument at `at`: a `{group}` without its braces, or one token. */
function argument(tex: string, at: number): { value: string; end: number } | null {
  at = skipSpaces(tex, at);
  if (at >= tex.length) return null;
  if (tex[at] === "{") {
    const end = groupEnd(tex, at);
    return end < 0 ? null : { value: tex.slice(at + 1, end - 1), end };
  }
  const token = controlSequence(tex, at) ?? String.fromCodePoint(tex.codePointAt(at)!);
  return { value: token, end: at + token.length };
}

/**
 * Bodies that go in bare, because braces make whatever they hold an ordinary
 * symbol: one symbol (`\succ` would lose the space a relation gets), and one
 * that opens with a command naming its kind (`\operatorname*{arg\,max}`
 * would lose its limits, `\mathrel{...}` its space). The hand import braced
 * the second kind.
 */
const BARE = /^\s*(?:(?:\\[A-Za-z@]+|\\?.)\s*$|\\(?:operatorname|mathop|mathrel|mathbin|mathpunct)(?![A-Za-z@]))/su;

// These name the macro they define, so the name after them is not a use of it.
const DEFINERS = new Set(["\\def", "\\gdef", "\\let", "\\newcommand", "\\renewcommand", "\\providecommand"]);

export interface ExpandOptions {
  /** The formula stands in a table row, where `|` ends the cell. */
  inTable?: boolean;
  /** Called with a reason when a macro cannot be expanded; it is then left as written. */
  onProblem?: (reason: string) => void;
}

/**
 * Replace every use of a macro in `tex` with its body, as TeX would.
 *
 * A macro without arguments is put in braces, as the hand import of the
 * course did: `\cM` gives `{\mathcal{M}}`. One with arguments gives its body
 * bare (`\dv{x}{t}` gives `\frac{d x}{d t}`), and so does one whose body
 * braces would change (see BARE).
 */
export function expandMacros(tex: string, macros: Macros, options: ExpandOptions = {}, depth = 0): string {
  if (macros.size === 0) return tex;
  let out = "";
  let i = 0;
  while (i < tex.length) {
    const token = controlSequence(tex, i);
    if (!token) {
      out += tex[i++];
      continue;
    }
    i += token.length;
    if (DEFINERS.has(token)) {
      // `\def\R{...}` and `\renewcommand{\R}{...}`: copy the name being defined.
      const start = skipSpaces(tex, i);
      const named = controlSequence(tex, tex[start] === "{" ? start + 1 : start);
      const end = named ? (tex[start] === "{" ? start + 1 : start) + named.length : i;
      out += token + tex.slice(i, end);
      i = end;
      continue;
    }
    const macro = macros.get(token.slice(1));
    if (!macro) {
      out += token;
      continue;
    }
    if (depth >= MAX_DEPTH) {
      options.onProblem?.(`macro ${token} uses itself`);
      out += token;
      continue;
    }
    // `|` ends a table cell wherever it stands, and `\|` is how a cell writes one.
    let body = options.inTable ? macro.body.replace(/\\\|/g, "\\Vert ").replace(/\|/g, "\\vert ") : macro.body;
    if (macro.params > 0) {
      const values: string[] = [];
      let cursor = i;
      for (let n = 0; n < macro.params; n++) {
        const found = argument(tex, cursor);
        if (!found) break;
        values.push(found.value);
        cursor = found.end;
      }
      if (values.length < macro.params) {
        options.onProblem?.(`macro ${token} takes ${macro.params} argument(s), and ${values.length} follow it`);
        out += token;
        continue;
      }
      i = cursor;
      body = substitute(body, values);
    }
    const expanded = expandMacros(body, macros, options, depth + 1);
    if (macro.params === 0 && !BARE.test(macro.body)) out += `{${expanded}}`;
    else {
      out = glue(out, expanded);
      if (/\\[A-Za-z@]+$/.test(expanded) && /[A-Za-z@]/.test(tex[i] ?? "")) out += " ";
    }
  }
  return out;
}

/** `body` with `#1`, `#2`, ... replaced by `values`; `##` is a literal `#`. */
function substitute(body: string, values: string[]): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const next = body[i + 1] ?? "";
    if (body[i] === "\\") out += body[i] + (body[++i] ?? "");
    else if (body[i] === "#" && next === "#") out += body[i++];
    else if (body[i] === "#" && values[Number(next) - 1] !== undefined) out = glue(out, values[Number(body[++i]) - 1]);
    else out += body[i];
  }
  return out;
}
