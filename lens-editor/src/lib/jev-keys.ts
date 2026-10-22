// `backticked` names in a check's words. A level name is a reference (Lauren, 2026-10-22): the
// question level's name is the unit asked about; a coarser one is the unit around it. Each is
// replaced by that unit's numbered key in what jev is sent, if jev's input has that layer; the
// rest are flagged, with why.
import { around, keyOf, layerAround, LEVELS, rank, type Level, type Node } from './jev-present';

/** What jev sees and is asked about (the presentation, without its chunking). */
export interface Shape { context: Level; question: Level; nest: Level[] }
export const PLATFORM_SHAPE: Shape = { context: 'paragraph', question: 'paragraph', nest: [] };

const isLevel = (s: string): s is Level => (LEVELS as string[]).includes(s);
const NUMBERED = new RegExp(`^(${LEVELS.join('|')})_\\S*$`);

/** Why `name` cannot be resolved under `s`, or null when it can. */
export function refProblem(name: string, s: Shape): string | null {
  const num = name.match(NUMBERED);
  if (num) return `write \`${num[1]}\`: its number is filled in for each unit`;
  if (!isLevel(name)) return `not a unit: use ${refNames(s).map((l) => '`' + l + '`').join(' or ')}`;
  if (name === s.question || name === s.context) return null;
  if (rank(name) > rank(s.question)) return `finer than the ${s.question} asked about, so no one ${name}`;
  if (rank(name) < rank(s.context)) return `jev sees only one ${s.context}, not the ${name} around it`;
  return s.nest.includes(name) ? null : `nesting by ${name} is off, so jev's input has no ${name} keys`;
}

/** The `backticked` names in `text` that name units (a level, or a level with a number). */
export const unitNames = (text: string) => [...text.matchAll(/`([^`\n]*)`/g)].map((m) => m[1]).filter((n) => isLevel(n) || NUMBERED.test(n));

/** The names that resolve under `s`, the unit asked about first. */
export const refNames = (s: Shape): Level[] =>
  [s.question, ...LEVELS.filter((l) => l !== s.question && rank(l) <= rank(s.question) && rank(l) >= rank(s.context) && refProblem(l, s) === null).reverse()];

/** Plain runs and `backticked` names, each name with its problem (or null). */
export function keyRuns(text: string, s: Shape) {
  return text.split(/(`[^`\n]*`)/).map((t) => {
    const m = t.match(/^`([^`]*)`$/);
    return { t, key: !!m, problem: m ? refProblem(m[1], s) : null };
  });
}

/** What the question must change, or nothing. */
export function keyHint(text: string, s: Shape): string | undefined {
  const keys = keyRuns(text, s).filter((r) => r.key);
  if (!keys.some((r) => r.t === '`' + s.question + '`')) return `name the ${s.question} asked about as \`${s.question}\``;
}

/** The syntax, as shown under the fields. */
export function refSyntax(s: Shape): string {
  const [q, ...up] = refNames(s);
  if (s.context === s.question) return `\`${q}\` is the ${q} asked about; jev is shown it alone, under that name.`;
  return `\`${q}\` is the ${q} asked about${up.length ? `; ${up.map((l) => '`' + l + '`').join(', ')} the one${up.length > 1 ? 's' : ''} around it` : ''}. jev is sent each as its numbered key, such as \`${q}_12\`.`;
}

/** `text` with each resolvable name replaced by the key of `unit` (or the unit around it). */
export function fillRefs(text: string, unit: Node, s: Shape): string {
  const ctx = around(unit, s.context);
  return text.replace(/`([^`\n]*)`/g, (whole, name: string) => {
    if (refProblem(name, s) !== null || ctx === unit || name === s.context) return whole;
    // A unit with no key of its own (a lens file's only lens) is the one around it that has one.
    const x = layerAround(around(unit, name as Level), ctx, s.question, s.nest);
    return '`' + (x === ctx ? ctx.level : keyOf(x)) + '`';
  });
}

/** `text` with references to level `from` renamed to `to`. */
export const renameRef = (text: string, from: Level, to: Level) => text.replaceAll('`' + from + '`', '`' + to + '`');
