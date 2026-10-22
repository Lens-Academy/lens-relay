// How a check's request is presented to jev: what jev is shown (an isolated unit, the raw
// markdown of the whole file, or the file parsed into nested JSON) and which unit it is
// asked about. Lauren's design, 2026-10-21: objects with globally numbered keys, never arrays
// (jev is unlikely to count reliably), and keys in ascending order (measured: jev reads key
// order, AUROC 1.0 ascending vs 0.82 shuffled, docs/course-dev-set/jev-format/key_order.py).

export type Level = 'heading' | 'paragraph' | 'sentence' | 'line';
export const LEVELS: Level[] = ['heading', 'paragraph', 'sentence', 'line'];
export type Mode = 'isolated' | 'raw' | 'parsed';
export type UnitKind = 'paragraph' | 'sentence';

interface Frag { n: number; text: string } // n: 0-based line of the file
interface Sentence { idx: number; text: string; frags: Frag[] }
interface Paragraph { idx: number; text: string; lines: Frag[]; sentences: Sentence[] }
interface Heading { idx: number; title?: string; paragraphs: Paragraph[] }
export interface Doc { headings: Heading[] }
export interface Unit { kind: UnitKind; key: string; text: string; para?: number } // para: its paragraph's index

export const FORMAT_DESCRIPTION =
  'A document parsed into nested headings, paragraphs, sentences and lines. Every numbering is global across the whole document, so `paragraph_7` names one paragraph wherever it sits; line numbers are the lines of the file.';

const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;
// A sentence ends at . ! or ?, perhaps followed by closing quotes or brackets.
const ENDS = /[.!?]["'”’)\]]*$/;
const SPLIT = /(?<=[.!?]["'”’)\]]*)\s+(?=\S)/;

export function parseDoc(markdown: string): Doc {
  const lines = markdown.split(/\r?\n/);
  let start = 0;
  if (lines[0] === '---') { const end = lines.indexOf('---', 1); if (end > 0) start = end + 1; }
  const headings: Heading[] = [{ idx: 0, paragraphs: [] }];
  let para: Frag[] = [];
  let p = 0, s = 0;
  const close = () => {
    if (!para.length) return;
    const sentences: Sentence[] = [];
    let cur: Frag[] = [];
    const end = () => { if (cur.length) sentences.push({ idx: s++, text: cur.map((f) => f.text).join(' '), frags: cur }); cur = []; };
    for (const line of para) for (const piece of line.text.split(SPLIT)) { cur.push({ n: line.n, text: piece }); if (ENDS.test(piece)) end(); }
    end();
    headings[headings.length - 1].paragraphs.push({ idx: p++, text: sentences.map((x) => x.text).join(' '), lines: para, sentences });
    para = [];
  };
  // What a learner never sees: %% comments %% (Obsidian), possibly across lines.
  let inComment = false;
  const visible = (line: string) => {
    let out = '';
    for (const [i, part] of line.split('%%').entries()) { if (i > 0) inComment = !inComment; if (!inComment) out += part; }
    return out;
  };
  for (let n = start; n < lines.length; n++) {
    // Lens field names ("content::") are syntax, not words; their values are.
    const text = visible(lines[n]).trim().replace(/^[\w-]+::\s*/, '');
    const h = text.match(HEADING);
    if (h) { close(); headings.push({ idx: headings.length, title: h[1], paragraphs: [] }); }
    else if (!text) close();
    else para.push({ n, text });
  }
  close();
  // A document that opens with a heading has no implicit heading before it.
  if (!headings[0].paragraphs.length && headings.length > 1) { headings.shift(); headings.forEach((h, i) => { h.idx = i; }); }
  return { headings };
}

type Json = string | { [k: string]: Json };

/** The document as nested objects, keeping only `levels`; the deepest level kept holds text. */
export function docJson(doc: Doc, levels: Level[] = LEVELS, only?: (p: Paragraph) => boolean): Record<string, Json> {
  if (only) doc = { headings: doc.headings.map((h) => ({ ...h, paragraphs: h.paragraphs.filter(only) })).filter((h) => h.paragraphs.length) };
  const has = (l: Level) => levels.includes(l);
  const merge = (parts: Record<string, Json>[]) => Object.assign({}, ...parts) as Record<string, Json>;
  const sent = (x: Sentence): Json => has('line') ? Object.fromEntries(x.frags.map((f) => [`line_${f.n}`, f.text])) : x.text;
  const paraInner = (x: Paragraph): Record<string, Json> | null =>
    has('sentence') ? Object.fromEntries(x.sentences.map((y) => [`sentence_${y.idx}`, sent(y)]))
      : has('line') ? Object.fromEntries(x.lines.map((f) => [`line_${f.n}`, f.text])) : null;
  const headInner = (h: Heading): Record<string, Json> =>
    has('paragraph') ? Object.fromEntries(h.paragraphs.map((x) => [`paragraph_${x.idx}`, paraInner(x) ?? x.text]))
      : merge(h.paragraphs.map((x) => paraInner(x) ?? {}));
  if (!has('heading')) return merge(doc.headings.map(headInner));
  return Object.fromEntries(doc.headings.map((h) => {
    const inner = headInner(h);
    const body: Json = Object.keys(inner).length ? inner : h.paragraphs.map((x) => x.text).join('\n\n');
    return [`heading_${h.idx}`, h.title !== undefined && typeof body === 'object' ? { heading: h.title, ...body } : body];
  }));
}

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The paragraph of a corpus row (`line`: 1-based, as the platform's splitter gives it; `text`:
 *  its words). The file may have changed since the corpus was taken, so the words decide, and
 *  the line only picks the nearest of several matches. Without `text`, the line alone. */
function paragraphOf(doc: Doc, line: number, text?: string): Paragraph | undefined {
  const all = doc.headings.flatMap((h) => h.paragraphs);
  if (text === undefined) return all.find((x) => x.lines.some((f) => f.n === line - 1));
  const near = (xs: Paragraph[]) => xs.sort((a, b) => Math.abs(a.lines[0].n - (line - 1)) - Math.abs(b.lines[0].n - (line - 1)))[0];
  // Markdown the splitter strips (a link's URL) can split the words, so a shorter start, and
  // then the line, are tried before giving up.
  for (const len of [60, 25]) {
    const head = words(text).slice(0, len);
    const hit = near(all.filter((x) => words(x.text).includes(head)));
    if (hit) return hit;
  }
  return all.find((x) => x.lines.some((f) => f.n === line - 1));
}

export function unitOf(doc: Doc, kind: 'paragraph', line: number, text?: string): Unit | null {
  const x = paragraphOf(doc, line, text);
  return x ? { kind, key: `paragraph_${x.idx}`, text: x.text, para: x.idx } : null;
}

/** The sentences of a corpus row's paragraph. */
export function sentencesAt(doc: Doc, line: number, text?: string): Unit[] {
  const p = paragraphOf(doc, line, text);
  return (p?.sentences ?? []).map((x) => ({ kind: 'sentence', key: `sentence_${x.idx}`, text: x.text, para: p!.idx }));
}

/** The check's question, its `paragraph` pointed at the key jev is shown the unit under. */
export function templateQuestion(question: string, key: string): string {
  return question.replace(/`paragraph`/g, '`' + key + '`');
}

/** The key the unit sits under in the state jev is shown. */
export function questionKey(mode: Mode, unit: Unit): string {
  return mode === 'parsed' ? unit.key : unit.kind;
}

/** The file cut into consecutive paragraph ranges whose parsed JSON is at most `max` characters
 *  each (a single paragraph over `max` is a range of its own), cutting at a heading once a
 *  range is half full. jev refuses a state plus question over 32k tokens. */
const chunkCache = new WeakMap<Doc, Map<string, [number, number][]>>();
/** The default chunk budget: jev answers a state plus one question of up to 32k tokens, and its
 *  parsed-document JSON measures about 2.65 characters a token (75,734 characters were 28,153
 *  tokens; 99,243 were refused), so 72,000 characters leave room for the question. */
export const DEFAULT_MAX_CHARS = 72_000;

export function chunks(doc: Doc, levels: Level[], max: number): [number, number][] {
  const key = `${levels.join()}|${max}`;
  const m = chunkCache.get(doc) ?? new Map<string, [number, number][]>();
  chunkCache.set(doc, m);
  if (!m.has(key)) m.set(key, chunksOf(doc, levels, max));
  return m.get(key)!;
}

function chunksOf(doc: Doc, levels: Level[], max: number): [number, number][] {
  const paras = doc.headings.flatMap((h) => h.paragraphs.map((p, i) => ({ p, opensHeading: i === 0 })));
  const size = (from: number, to: number) => JSON.stringify(docJson(doc, levels, (p) => p.idx >= from && p.idx <= to)).length;
  const out: [number, number][] = [];
  let start = 0;
  for (let k = 1; k <= paras.length; k++) {
    const next = paras[k];
    const over = next && size(paras[start].p.idx, next.p.idx) > max;
    const headingCut = next?.opensHeading && size(paras[start].p.idx, paras[k - 1].p.idx) > max / 2;
    if (!next || over || headingCut) { out.push([paras[start].p.idx, paras[k - 1].p.idx]); start = k; }
  }
  return out;
}

export function presentState(mode: Mode, doc: Doc, raw: string, unit: Unit, levels: Level[] = LEVELS, maxChars: number | null = null): Record<string, unknown> {
  if (mode === 'isolated') return { [unit.kind]: unit.text };
  const all = doc.headings.flatMap((h) => h.paragraphs);
  const cs = maxChars === null || unit.para === undefined ? [] : chunks(doc, levels, maxChars);
  const at = cs.findIndex(([a, b]) => unit.para! >= a && unit.para! <= b);
  if (cs.length <= 1 || at < 0) {
    if (mode === 'raw') return { document: raw, [unit.kind]: unit.text };
    return { __format_description: FORMAT_DESCRIPTION, document: docJson(doc, levels) };
  }
  const [from, to] = cs[at];
  const excerpt = `paragraphs ${from} to ${to} of 0 to ${all.length - 1} (part ${at + 1} of ${cs.length})`;
  if (mode === 'raw') {
    const lines = raw.split(/\r?\n/);
    const first = all[from].lines[0].n, last = all[to].lines[all[to].lines.length - 1].n;
    return { __excerpt: excerpt, document: lines.slice(first, last + 1).join('\n'), [unit.kind]: unit.text };
  }
  return { __format_description: FORMAT_DESCRIPTION, __excerpt: excerpt, document: docJson(doc, levels, (p) => p.idx >= from && p.idx <= to) };
}
