// How a check is put to jev: its file's `presentation:` block (lens-platform
// core/course_checks/present.py builds the requests; these are the same rules, for the editor).
// Three choices (Lauren, 2026-10-22): how much jev sees (context), what each question is about
// (question, that level or finer), and the levels between that nest the JSON (nest).

export type Level = 'document' | 'submodule' | 'lens' | 'section' | 'paragraph' | 'sentence' | 'line';
export const LEVELS: Level[] = ['document', 'submodule', 'lens', 'section', 'paragraph', 'sentence', 'line'];
export const rank = (l: Level) => LEVELS.indexOf(l);
const isLevel = (s: unknown): s is Level => (LEVELS as unknown[]).includes(s);

/** long: TypeSafe's long context (uncertified), so the context is never cut into chunks. */
export interface Presentation { context: Level; question: Level; nest: Level[]; long?: boolean }
/** Each paragraph alone: what a check with no block asks. */
export const DEFAULT_PRESENTATION: Presentation = { context: 'paragraph', question: 'paragraph', nest: [...LEVELS] };
export const isDefault = (p: Presentation) => p.context === 'paragraph' && p.question === 'paragraph';
export const between = (p: Presentation) => LEVELS.filter((l) => rank(l) > rank(p.context) && rank(l) < rank(p.question));

/** A `presentation:` block, checked as the platform checks it (present.parse_presentation). */
export function parsePresentation(block: unknown): Presentation {
  if (block === undefined || block === null) return DEFAULT_PRESENTATION;
  if (typeof block !== 'object' || Array.isArray(block) || Object.keys(block).some((k) => !['context', 'question', 'nest', 'long'].includes(k))) {
    throw new Error('presentation takes context, question, nest and long');
  }
  const b = block as Record<string, unknown>;
  const context = b.context ?? 'paragraph', question = b.question ?? 'paragraph', nest = b.nest ?? [...LEVELS];
  if (!isLevel(context) || !isLevel(question)) throw new Error(`presentation levels are ${LEVELS.join(', ')}`);
  if (rank(question) < rank(context)) throw new Error('the question level must be the context level or finer');
  if (!Array.isArray(nest) || !nest.every(isLevel)) throw new Error('presentation nest is a list of levels');
  if (b.long !== undefined && typeof b.long !== 'boolean') throw new Error('presentation long is true or false');
  return { context, question, nest: LEVELS.filter((l) => nest.includes(l)), ...(b.long ? { long: true } : {}) };
}

/** The block for `p`, or null for the default (no block). */
export const presentationBlock = (p: Presentation): Record<string, unknown> | null =>
  isDefault(p) ? null : { context: p.context, question: p.question, nest: p.nest, ...(p.long ? { long: true } : {}) };

export function describe(p: Presentation): string {
  if (p.context === p.question) return `jev sees each ${p.question} alone`;
  const nest = between(p).filter((l) => p.nest.includes(l));
  return `jev sees each ${p.context}${p.long ? ' (long context)' : ', in chunks that fit'}, nested by ${[...nest, p.question].join(', ')}; asked about each ${p.question}`;
}
