// A course file as one tree of globally numbered units, and what jev is shown of it.
// Design: docs/course-dev-set/live-checks/jev-presentation-design.plain.md (Lauren, 2026-10-21/22):
// three choices, the context level (how much jev sees), the question level (what each question is
// about) and which levels in between nest the JSON. Objects with numbered keys, never arrays (jev is
// unlikely to count reliably); keys ascending (measured: jev reads key order, AUROC 1.0 vs 0.82
// shuffled, docs/course-dev-set/jev-format/key_order.py).

export type Level = 'document' | 'submodule' | 'lens' | 'section' | 'paragraph' | 'sentence' | 'line';
export const LEVELS: Level[] = ['document', 'submodule', 'lens', 'section', 'paragraph', 'sentence', 'line'];
export const rank = (l: Level) => LEVELS.indexOf(l);

// `idx` counts units of the level across the whole file (for a line, its 0-based file line);
// `first`/`last` are file lines; `implicit` units wrap text no header opened.
export interface Node { level: Level; idx: number; title?: string; implicit: boolean; text: string; first: number; last: number; children: Node[]; parent?: Node }

const SUBMODULE = /^#\s+Submodule:\s*(.*?)\s*$/i;
const LENS = /^##\s+Lens:\s*(.*?)\s*$/i;
const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;
// A sentence ends at . ! or ?, perhaps followed by closing quotes or brackets.
const ENDS = /[.!?]["'”’)\]]*$/;
const SPLIT = /(?<=[.!?]["'”’)\]]*)\s+(?=\S)/;

export function parseDoc(markdown: string): Node {
  const lines = markdown.split(/\r?\n/);
  let start = 0;
  if (lines[0] === '---') { const end = lines.indexOf('---', 1); if (end > 0) start = end + 1; }
  const mk = (level: Level, parent: Node | undefined, at: number, title?: string, implicit = false): Node => {
    const n: Node = { level, idx: 0, title: title || undefined, implicit, text: '', first: at, last: at, children: [], parent };
    parent?.children.push(n);
    return n;
  };
  const doc = mk('document', undefined, 0);
  let sub: Node | undefined, lens: Node | undefined, sec: Node | undefined;
  const ensureSec = (n: number) => (sec ??= mk('section', lens ??= mk('lens', sub ??= mk('submodule', doc, n, undefined, true), n, undefined, true), n, undefined, true));
  let para: { n: number; text: string }[] = [];
  const close = () => {
    if (!para.length) return;
    const p = mk('paragraph', ensureSec(para[0].n), para[0].n);
    let s: Node | undefined;
    for (const line of para) for (const piece of line.text.split(SPLIT)) {
      s ??= mk('sentence', p, line.n);
      s.children.push({ level: 'line', idx: line.n, implicit: false, text: piece, first: line.n, last: line.n, children: [], parent: s });
      if (ENDS.test(piece)) s = undefined;
    }
    para = [];
  };
  // What a learner never sees: %% comments %% (Obsidian), possibly across lines.
  let inComment = false;
  const visible = (line: string) => line.split('%%').filter((_, i) => (i > 0 && (inComment = !inComment), !inComment)).join('');
  for (let n = start; n < lines.length; n++) {
    // Lens field names ("content::") are syntax, not words; their values are.
    const text = visible(lines[n]).trim().replace(/^[\w-]+::\s*/, '');
    let m: RegExpMatchArray | null;
    if ((m = text.match(SUBMODULE))) { close(); sub = mk('submodule', doc, n, m[1]); lens = sec = undefined; }
    else if ((m = text.match(LENS))) { close(); lens = mk('lens', sub ??= mk('submodule', doc, n, undefined, true), n, m[1]); sec = undefined; }
    else if ((m = text.match(HEADING))) { close(); sec = mk('section', lens ??= mk('lens', sub ??= mk('submodule', doc, n, undefined, true), n, undefined, true), n, m[1]); }
    else if (!text) close();
    else para.push({ n, text });
  }
  close();
  finish(doc);
  return doc;
}

// Drop units with no text (a `#### End` header), then join texts, spans and numbering.
function finish(doc: Node) {
  const prune = (n: Node): boolean => (n.level === 'line' || (n.children = n.children.filter(prune)).length > 0);
  prune(doc);
  const count: Partial<Record<Level, number>> = {};
  const walk = (n: Node) => {
    if (n.level === 'line') return;
    if (n.level !== 'document') n.idx = (count[n.level] = (count[n.level] ?? -1) + 1);
    n.children.forEach(walk);
    n.text = n.children.map((c) => c.text).join(rank(n.level) >= rank('paragraph') ? ' ' : '\n\n');
    n.first = Math.min(n.first, ...n.children.map((c) => c.first));
    n.last = Math.max(...n.children.map((c) => c.last));
  };
  walk(doc);
}

/** The units of `level` inside `n` (or `n` itself), in file order. */
export const within = (n: Node, level: Level): Node[] =>
  n.level === level ? [n] : rank(n.level) > rank(level) ? [] : n.children.flatMap((c) => within(c, level));
/** The unit of `level` that holds `n` (or `n` itself). */
export const around = (n: Node, level: Level): Node => {
  for (let x: Node | undefined = n; x; x = x.parent) if (x.level === level) return x;
  throw new Error(`no ${level} around ${n.level}_${n.idx}`);
};
export const keyOf = (n: Node) => `${n.level}_${n.idx}`;

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The paragraph of a corpus row (`line`: 1-based, as the platform's splitter gives it; `text`:
 *  its words). The file may have changed since the corpus was taken, so the words decide, and
 *  the line only picks the nearest of several matches; Markdown the splitter strips (a link's
 *  URL) can split the words, so a shorter start, then the line, are tried before giving up. */
export function paragraphOf(doc: Node, line: number, text?: string): Node | undefined {
  const all = within(doc, 'paragraph');
  const atLine = () => all.find((x) => within(x, 'line').some((f) => f.idx === line - 1));
  if (text === undefined) return atLine();
  for (const len of [60, 25]) {
    const head = words(text).slice(0, len);
    const hits = all.filter((x) => words(x.text).includes(head));
    if (hits.length) return hits.sort((a, b) => Math.abs(a.first - (line - 1)) - Math.abs(b.first - (line - 1)))[0];
  }
  return atLine();
}


type Json = string | { [k: string]: Json };

/** `ctx` as JSON down to `question`, one layer of keys per level in `nest` (between the two).
 *  An implicit unit that is its parent's only child is the parent's own text, so adds no layer;
 *  `keep` leaves out units (a chunk). */
/** Whether `n` gets its own key in the JSON (it is the question level, or a nested level and
 *  not an implicit only child, which is its parent's own text). */
export const isLayer = (n: Node, question: Level, nest: Level[]) =>
  n.level === question || (nest.includes(n.level) && !(n.implicit && n.parent!.children.length === 1));
/** The unit whose key stands for `n` in the JSON of `ctx`: `n`, or the nearest unit around it
 *  that has a key; `ctx` itself when none does. */
export function layerAround(n: Node, ctx: Node, question: Level, nest: Level[]): Node {
  let x = n;
  while (x !== ctx && !isLayer(x, question, nest)) x = x.parent!;
  return x;
}

export function render(ctx: Node, question: Level, nest: Level[], keep: (n: Node) => boolean = () => true): Json {
  if (ctx.level === question) return ctx.text;
  const shown = (c: Node) => isLayer(c, question, nest);
  const layer = (n: Node): Node[] => n.children.filter(keep).flatMap((c) => (shown(c) ? [c] : layer(c)));
  const out: Record<string, Json> = ctx.title ? { title: ctx.title } : {};
  for (const c of layer(ctx)) out[keyOf(c)] = render(c, question, nest, keep);
  return out;
}

const formatDescription = (ctx: Level, question: Level, nest: Level[]) =>
  `A ${ctx} of a course file, parsed into nested ${LEVELS.filter((l) => rank(l) > rank(ctx) && (l === question || (rank(l) < rank(question) && nest.includes(l)))).map((l) => l + 's').join(', ')}. Every number counts across the whole file, so \`${question}_7\` names one ${question} wherever it sits; \`line_N\` is line N of the file. A \`title\` is the heading that opens its unit.`;

/** What jev is shown for the context unit `ctx`: the unit as text when it is also the question
 *  level (a file's own markdown for a document, lens or section), else parsed JSON, perhaps only
 *  the `keep`-ed chunk of it, described by `excerpt`. */
export function stateFor(ctx: Node, question: Level, nest: Level[], raw: string, keep?: (n: Node) => boolean, excerpt?: string): Record<string, unknown> {
  if (ctx.level === question) {
    const text = ctx.level === 'document' ? raw : rank(ctx.level) < rank('paragraph') ? raw.split(/\r?\n/).slice(ctx.first, ctx.last + 1).join('\n') : ctx.text;
    return { [question]: text };
  }
  return { __format_description: formatDescription(ctx.level, question, nest), ...(excerpt ? { __excerpt: excerpt } : {}), [ctx.level]: render(ctx, question, nest, keep) };
}

/** The default chunk budget: jev answers a state plus one question of up to 32k tokens, and its
 *  parsed JSON measures about 2.65 characters a token (75,734 characters were 28,153 tokens;
 *  99,243 were refused), so 72,000 characters leave room for the question. */
export const DEFAULT_MAX_CHARS = 72_000;

/** The level chunks are cut at: whole questions, never a paragraph split. */
export const atomLevel = (question: Level): Level => (rank(question) < rank('paragraph') ? question : 'paragraph');
export const keepOnly = (atoms: Node[]) => {
  const kept = new Set<Node>();
  for (const a of atoms) for (let x: Node | undefined = a; x; x = x.parent) kept.add(x);
  const lvl = atoms[0].level;
  return (n: Node) => rank(n.level) > rank(lvl) || kept.has(n);
};

const chunkCache = new WeakMap<Node, Map<string, Node[][]>>();
/** `ctx`'s question atoms cut into consecutive runs whose JSON is at most `max` characters (one
 *  atom over `max` is a run of its own), cutting where a new parent opens once a run is half full. */
export function chunks(ctx: Node, question: Level, nest: Level[], max: number): Node[][] {
  const key = `${question}|${nest.join()}|${max}`;
  const m = chunkCache.get(ctx) ?? new Map<string, Node[][]>();
  chunkCache.set(ctx, m);
  if (m.has(key)) return m.get(key)!;
  const atoms = within(ctx, atomLevel(question));
  const size = (run: Node[]) => JSON.stringify(render(ctx, question, nest, keepOnly(run))).length;
  const out: Node[][] = [];
  if (atoms.length && size(atoms) <= max) out.push(atoms); // (no text: no runs)
  else {
    let run: Node[] = [];
    for (const a of atoms) {
      const cut = run.length && (size([...run, a]) > max || (a.parent !== run[run.length - 1].parent && size(run) > max / 2));
      if (cut) { out.push(run); run = []; }
      run.push(a);
    }
    if (run.length) out.push(run);
  }
  m.set(key, out);
  return out;
}
