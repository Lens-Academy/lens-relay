/**
 * Typst maths -> TeX, for the subset the Atlas uses.
 *
 * Atlas authors write equations in Typst syntax (the site compiles them with
 * Typst): `sum_(t=0)^infinity gamma^t r_t`, `S times A -> RR`, `"text"`.
 * Lens renders maths with KaTeX, which reads TeX. Input that is already TeX
 * (has a `\command`) is returned as-is. Names it cannot translate pass through
 * and are returned in `unknown`, so the caller can report them.
 */

const GREEK = [
  "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda", "mu",
  "nu", "xi", "pi", "rho", "sigma", "tau", "upsilon", "phi", "chi", "psi", "omega",
  "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Upsilon", "Phi", "Psi", "Omega",
];

const FUNCTIONS = ["log", "ln", "exp", "sin", "cos", "tan", "max", "min", "arg", "lim", "sup", "inf", "det", "dim"];

const SYMBOLS: Record<string, string> = {
  ...Object.fromEntries(GREEK.map((g) => [g, `\\${g}`])),
  ...Object.fromEntries(FUNCTIONS.map((f) => [f, `\\${f}`])),
  times: "\\times", dot: "\\cdot", "dot.c": "\\cdot", div: "\\div", "plus.minus": "\\pm", "minus.plus": "\\mp",
  approx: "\\approx", tilde: "\\sim", "tilde.op": "\\sim", prop: "\\propto", infinity: "\\infty", oo: "\\infty",
  sum: "\\sum", product: "\\prod", integral: "\\int", partial: "\\partial", nabla: "\\nabla", ast: "\\ast", star: "\\star",
  in: "\\in", "in.not": "\\notin", subset: "\\subset", "subset.eq": "\\subseteq", supset: "\\supset",
  "supset.eq": "\\supseteq", union: "\\cup", sect: "\\cap", emptyset: "\\emptyset", forall: "\\forall", exists: "\\exists",
  "eq.not": "\\ne", "lt.eq": "\\le", "gt.eq": "\\ge", dots: "\\dots", "dots.c": "\\cdots",
  "arrow.r": "\\rightarrow", "arrow.l": "\\leftarrow", "arrow.l.r": "\\leftrightarrow", "arrow.r.bar": "\\mapsto",
  "arrow.r.double": "\\Rightarrow", "arrow.l.double": "\\Leftarrow",
  RR: "\\mathbb{R}", NN: "\\mathbb{N}", ZZ: "\\mathbb{Z}", QQ: "\\mathbb{Q}", CC: "\\mathbb{C}",
  "<=>": "\\Leftrightarrow", "<->": "\\leftrightarrow", "|->": "\\mapsto", "==>": "\\implies",
  "->": "\\to", "<-": "\\gets", "=>": "\\Rightarrow", "<=": "\\le", ">=": "\\ge", "!=": "\\ne",
  "<<": "\\ll", ">>": "\\gg", "...": "\\dots", ":=": "\\coloneqq",
  // Characters TeX reads as syntax, which Typst shows literally.
  "%": "\\%", "&": "\\&", "#": "\\#", "{": "\\{", "}": "\\}",
};

/** Typst functions of one argument. */
const ONE_ARG: Record<string, (x: string) => string> = {
  hat: (x) => `\\hat{${x}}`,
  tilde: (x) => `\\tilde{${x}}`,
  dot: (x) => `\\dot{${x}}`,
  "dot.double": (x) => `\\ddot{${x}}`,
  arrow: (x) => `\\vec{${x}}`,
  overline: (x) => `\\overline{${x}}`,
  underline: (x) => `\\underline{${x}}`,
  sqrt: (x) => `\\sqrt{${x}}`,
  bold: (x) => `\\mathbf{${x}}`,
  upright: (x) => `\\mathrm{${x}}`,
  cal: (x) => `\\mathcal{${x}}`,
  bb: (x) => `\\mathbb{${x}}`,
  abs: (x) => `\\left|${x}\\right|`,
  norm: (x) => `\\left\\Vert ${x}\\right\\Vert`,
  floor: (x) => `\\lfloor ${x}\\rfloor`,
  ceil: (x) => `\\lceil ${x}\\rceil`,
};

/** Typst functions of several comma-separated arguments. */
const MULTI_ARG: Record<string, (args: string[]) => string> = {
  frac: ([a = "", b = ""]) => `\\frac{${a}}{${b}}`,
  binom: ([a = "", b = ""]) => `\\binom{${a}}{${b}}`,
  // A Typst vec is a column vector (the arrow accent is `arrow`).
  vec: (args) => `\\begin{pmatrix}${args.join(" \\cr ")}\\end{pmatrix}`,
};

// Multi-character operators first, longest before their prefixes.
const TOKEN_RE =
  /"[^"]*"|[A-Za-z]+(?:\.[A-Za-z]+)*|\d+(?:\.\d+)?|<=>|<->|\|->|==>|->|<-|=>|<=|>=|!=|<<|>>|\.\.\.|:=|\s+|./g;

/** Index of the `)` closing the `(` at `open`, or -1. */
function closeParen(tokens: string[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i] === "(") depth++;
    else if (tokens[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Split tokens at top-level commas. */
function splitArgs(tokens: string[]): string[][] {
  const args: string[][] = [[]];
  let depth = 0;
  for (const t of tokens) {
    if (t === "(") depth++;
    if (t === ")") depth--;
    if (t === "," && depth === 0) args.push([]);
    else args[args.length - 1].push(t);
  }
  return args;
}

/** A Typst string as TeX text: characters TeX would read as syntax are escaped. */
function text(s: string): string {
  return `\\text{${s.replace(/[\\%&#_{}$]/g, (c) => (c === "\\" ? "\\textbackslash " : `\\${c}`))}}`;
}

function translate(tokens: string[], unknown: Set<string>): string {
  let out = "";
  // "\pi" then "r" must not fuse into "\pir".
  const emit = (s: string) => {
    out += (/\\[A-Za-z]+$/.test(out) && /^[A-Za-z]/.test(s) ? " " : "") + s;
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const next = tokens[i + 1];

    if (tok === "_" || tok === "^") {
      if (next === "(") {
        const end = closeParen(tokens, i + 1);
        if (end !== -1) {
          emit(`${tok}{${translate(tokens.slice(i + 2, end), unknown)}}`);
          i = end;
          continue;
        }
      }
      // A script needs an argument; `w^)` (a typo) gets an empty one.
      if (next === undefined || /^[\s),]/.test(next)) {
        emit(`${tok}{}`);
        continue;
      }
      emit(`${tok}{${translate([next], unknown)}}`);
      i++;
      continue;
    }

    if (next === "(" && (ONE_ARG[tok] || MULTI_ARG[tok])) {
      const end = closeParen(tokens, i + 1);
      if (end !== -1) {
        const args = splitArgs(tokens.slice(i + 2, end)).map((a) => translate(a, unknown).trim());
        emit(ONE_ARG[tok] ? ONE_ARG[tok](args.join(", ")) : MULTI_ARG[tok](args));
        i = end;
        continue;
      }
    }

    // A spaced bar reads as "given" (`E(R | s)`); `|x|` stays an absolute value.
    if (tok === "|" && /^\s/.test(tokens[i - 1] ?? "") && /^\s/.test(next ?? "")) emit("\\mid");
    else if (tok.startsWith('"')) emit(text(tok.slice(1, -1)));
    else if (SYMBOLS[tok]) emit(SYMBOLS[tok]);
    else {
      // Typst reads a word of two or more letters as a name; one it does not know here is reported.
      if (/^[A-Za-z]{2,}(\.[A-Za-z]+)*$/.test(tok)) unknown.add(tok);
      emit(tok);
    }
  }
  return out;
}

export function typstMathToTex(math: string): { tex: string; unknown: string[] } {
  if (/\\[A-Za-z]/.test(math)) return { tex: math, unknown: [] };
  const unknown = new Set<string>();
  return { tex: translate(math.match(TOKEN_RE) ?? [], unknown), unknown: [...unknown] };
}
