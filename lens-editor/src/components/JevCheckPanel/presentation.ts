// How a Run presents the check to jev (lib/jev-present.ts parses the file): the three choices,
// which units of the sample are asked about, and one batch per shown text with all its questions.
import type { JevCheck } from '../../lib/jev-check';
import { around, atomLevel, chunks, DEFAULT_MAX_CHARS, keepOnly, keyOf, LEVELS, paragraphOf, parseDoc, rank, stateFor, within, type Level, type Node } from '../../lib/jev-present';
import { fillRefs } from '../../lib/jev-keys';
import type { Para } from './types';

/** context: how much jev sees; question: what each question is about (at most as coarse as
 *  context); nest: levels in between that add a layer of keys; long: jev's uncertified long
 *  context, so the context is never cut into chunks. */
export interface Presentation { context: Level; question: Level; nest: Level[]; long?: boolean }
export const DEFAULT_PRESENTATION: Presentation = { context: 'paragraph', question: 'paragraph', nest: [...LEVELS] };
/** The platform's own way: each paragraph alone, as its splitter gives it. */
export const isDefault = (p: Presentation) => p.context === 'paragraph' && p.question === 'paragraph';
export const between = (p: Presentation) => LEVELS.filter((l) => rank(l) > rank(p.context) && rank(l) < rank(p.question));

export function describe(p: Presentation): string {
  if (p.context === p.question) return `jev sees each ${p.question} alone`;
  const nest = between(p).filter((l) => p.nest.includes(l));
  return `jev sees each ${p.context}${p.long ? ' (long context)' : ', in chunks that fit'}, nested by ${[...nest, p.question].join(', ')}; asked about each ${p.question}`;
}

export interface Question { instructions: string; criteria?: { true: string; false: string } | null }
/** One shown text and every question asked about it; jev answers them together. */
export interface Batch { state: Record<string, unknown>; questions: Question[] }

const fail = (msg: string): never => { throw new Error(msg); };
const short = (s: string) => (s.length > 600 ? s.slice(0, 600) + '…' : s);

/** The sample's units at the question level (a paragraph's sentences, or the section around it),
 *  each with the batch that asks about it; `units` follows the batches' questions in order. */
export function buildRequests(check: JevCheck, sample: Para[], p: Presentation, files: Record<string, string>): { units: Para[]; batches: Batch[] } {
  // References to units (`sentence`, `paragraph`) become the numbered keys jev is shown.
  const ask = (unit?: Node): Question => {
    const t = (s: string) => (unit ? fillRefs(s, unit, p) : s);
    return { instructions: t(check.question), criteria: check.criteria ? { true: t(check.criteria.true), false: t(check.criteria.false) } : null };
  };
  if (isDefault(p)) return { units: sample, batches: sample.map((row) => ({ state: { paragraph: row.text }, questions: [ask()] })) };

  const docs = new Map<string, Node>();
  const doc = (path: string) => {
    if (!docs.has(path)) docs.set(path, parseDoc(files[path] ?? fail(`${path} could not be read from the relay`)));
    return docs.get(path)!;
  };
  // Each unit once, however many sampled paragraphs lead to it.
  const units = new Map<string, { row: Para; node: Node }>();
  for (const row of sample) {
    const para = paragraphOf(doc(row.path), row.line, row.text) ?? fail(`no paragraph like "${row.text.slice(0, 40)}…" in ${row.path} now (edited since the corpus was taken?)`);
    const found = rank(p.question) > rank('paragraph') ? within(para, p.question) : [around(para, p.question)];
    for (const node of found) {
      const id = p.question === 'paragraph' ? row.id : `${row.path}#${keyOf(node)}`;
      if (!units.has(id)) units.set(id, { row: { ...row, id, line: node.first + 1, text: short(node.text) }, node });
    }
  }
  // Units sharing a context (and chunk) share one batch.
  const groups = new Map<string, Batch & { units: Para[] }>();
  for (const { row, node } of units.values()) {
    const ctx = around(node, p.context);
    const raw = files[row.path];
    let group = `${row.path}|${keyOf(ctx)}`, state: () => Record<string, unknown>;
    if (ctx === node || p.long) state = () => stateFor(ctx, p.question, p.nest, raw);
    else {
      const runs = chunks(ctx, p.question, p.nest, DEFAULT_MAX_CHARS);
      const k = runs.findIndex((r) => r.includes(around(node, atomLevel(p.question))));
      const run = runs[k], lvl = atomLevel(p.question), all = within(ctx, lvl);
      group += `|${k}`;
      state = () => runs.length === 1 ? stateFor(ctx, p.question, p.nest, raw)
        : stateFor(ctx, p.question, p.nest, raw, keepOnly(run), `${lvl}s ${run[0].idx} to ${run[run.length - 1].idx} of ${all[0].idx} to ${all[all.length - 1].idx} (part ${k + 1} of ${runs.length})`);
    }
    if (!groups.has(group)) groups.set(group, { state: state(), questions: [], units: [] });
    const g = groups.get(group)!;
    g.questions.push(ask(node));
    g.units.push(row);
  }
  const batches = [...groups.values()];
  return { units: batches.flatMap((b) => b.units), batches: batches.map(({ state, questions }) => ({ state, questions })) };
}
