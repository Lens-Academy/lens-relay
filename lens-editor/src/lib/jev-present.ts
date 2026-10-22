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
export interface Unit { kind: UnitKind; key: string; text: string }

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
export function docJson(doc: Doc, levels: Level[] = LEVELS): Record<string, Json> {
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

function paragraphAt(doc: Doc, line: number): Paragraph | undefined {
  const n = line - 1;
  return doc.headings.flatMap((h) => h.paragraphs).find((x) => x.lines.some((f) => f.n === n));
}

/** The paragraph a corpus row starts on (`line`: 1-based, as the platform's splitter gives it). */
export function unitOf(doc: Doc, kind: 'paragraph', line: number): Unit | null {
  const x = paragraphAt(doc, line);
  return x ? { kind, key: `paragraph_${x.idx}`, text: x.text } : null;
}

/** The sentences of the paragraph a corpus row starts on. */
export function sentencesAt(doc: Doc, line: number): Unit[] {
  return (paragraphAt(doc, line)?.sentences ?? []).map((x) => ({ kind: 'sentence', key: `sentence_${x.idx}`, text: x.text }));
}

/** The check's question, its `paragraph` pointed at the key jev is shown the unit under. */
export function templateQuestion(question: string, key: string): string {
  return question.replace(/`paragraph`/g, '`' + key + '`');
}

/** The key the unit sits under in the state jev is shown. */
export function questionKey(mode: Mode, unit: Unit): string {
  return mode === 'parsed' ? unit.key : unit.kind;
}

export function presentState(mode: Mode, doc: Doc, raw: string, unit: Unit, levels: Level[] = LEVELS): Record<string, unknown> {
  if (mode === 'isolated') return { [unit.kind]: unit.text };
  if (mode === 'raw') return { document: raw, [unit.kind]: unit.text };
  return { __format_description: FORMAT_DESCRIPTION, document: docJson(doc, levels) };
}
