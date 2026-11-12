/**
 * The concept map of the Context Accelerator (pure logic, no React)
 *
 * `Lens Edu/Context Accelerator LOs/` holds one Markdown file per idea: the
 * file name is the idea's name, the frontmatter its `id`, `priority` and
 * `courses`, the first paragraph its outcome, and `## Requires`,
 * `## Helpful first`, `## Why it matters`, `## Learn` and `## Questions` the
 * rest (all optional, matched in any case). The format is shared with the
 * Lens platform, which shows the same ideas to learners: do not change it
 * here alone.
 *
 * This file reads an idea (`parseIdea`), puts the ideas of a folder into a
 * graph with steps, cycles and what is still missing (`buildIdeaGraph`),
 * writes a new idea file (`renderIdeaFile`) and works out the line changes
 * that give a file other requirements (`requirementChanges`). Names are
 * matched whatever their case, as wikilinks resolve in the editor.
 */
import { parseSections } from '../components/SectionEditor/parseSections';
import { parse as parseCriticMarkup } from './criticmarkup-parser';
import { extractFrontmatter } from './frontmatter';
import { parseFields } from './parseFields';
import { resolvePending, type TextChange } from './segmentTime';

/** The shared folder the ideas live in. */
export const IDEAS_SHARED_FOLDER = 'Lens Edu';
/** The folder of idea files, at the top of that shared folder. */
export const IDEAS_FOLDER = 'Context Accelerator LOs';
/** What a new idea lists under `courses`. */
const IDEA_COURSE_LINK = '../courses/in-development/Context Accelerator';

export const PRIORITIES = ['high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** A piece of a Learn line: words, or a link with the words it shows. */
export type LearnPart = { text: string } | { link: string; label: string };

/** A question of an idea: the type after `#### Question:` ("" when it has
 *  none) and the first line of its `content::`. */
export interface IdeaQuestion {
  type: string;
  content: string;
}

export interface ParsedIdea {
  /** The frontmatter `id` when it is a UUID, else null. */
  id: string | null;
  priority: Priority;
  /** Link targets of the frontmatter `courses`. */
  courses: string[];
  outcome: string;
  /** Names of the ideas under `## Requires`, in order, each once. */
  requires: string[];
  /** Names under `## Helpful first`. */
  helpful: string[];
  why: string;
  /** The lines under `## Learn`, without their list marker. */
  learn: LearnPart[][];
  /** Link targets under `## Learn`. */
  lenses: string[];
  /** Question segments under `## Questions`. */
  questions: number;
  /** The same segments, in order: what each asks. */
  questionList: IdeaQuestion[];
  /** Those written `#### Question` with no type (legacy: an error here). */
  bareQuestions: number;
  warnings: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FRONTMATTER = /^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/;
const COMMENT = /%%[\s\S]*?%%/g;
const WIKILINK = /\[\[([^[\]\n|]+)(?:\|([^[\]\n]*))?\]\]/g;
const QUESTION_TITLE = /^question\s*(?::\s*(.*))?$/i;
const QUESTION_TYPES = ['open', 'choice', 'fillblank', 'ranking'];
const SECTIONS = ['requires', 'helpful first', 'why it matters', 'learn', 'questions'] as const;
type SectionName = (typeof SECTIONS)[number];

/** A name as ideas are matched by: whatever its case. */
export function ideaKey(name: string): string {
  return name.trim().toLowerCase();
}

/** The file a link names: no folders, no `#anchor`, no `.md`. */
function linkName(target: string): string {
  const path = target.split('#')[0].trim();
  return (path.split('/').pop() ?? path).replace(/\.md$/i, '').trim();
}

function wikilinks(text: string): Array<{ target: string; alias: string | null; from: number; to: number }> {
  return [...text.matchAll(WIKILINK)].map((m) => ({
    target: m[1].split('#')[0].trim(),
    alias: m[2]?.trim() || null,
    from: m.index,
    to: m.index + m[0].length,
  }));
}

/** The idea names linked in `text`, in order, each once. */
function linkedNames(text: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const { target } of wikilinks(text)) {
    const name = linkName(target);
    if (!name || seen.has(ideaKey(name))) continue;
    seen.add(ideaKey(name));
    names.push(name);
  }
  return names;
}

/** Wikilink targets among frontmatter values: `"[[x]]"`, and `[[x]]` without
 *  quotes, which YAML reads as a list in a list. */
function courseLinks(value: unknown): string[] {
  if (typeof value === 'string') {
    const links = wikilinks(value).map((l) => l.target);
    return links.length > 0 ? links : value.trim() ? [value.trim()] : [];
  }
  if (!Array.isArray(value)) return [];
  if (value.length === 1 && Array.isArray(value[0]) && value[0].length === 1 && typeof value[0][0] === 'string') {
    return [value[0][0].split('|')[0].trim()];
  }
  return value.flatMap(courseLinks);
}

function learnLine(line: string): LearnPart[] {
  const parts: LearnPart[] = [];
  let at = 0;
  for (const link of wikilinks(line)) {
    if (link.from > at) parts.push({ text: line.slice(at, link.from) });
    parts.push({ link: link.target, label: link.alias ?? linkName(link.target) });
    at = link.to;
  }
  if (at < line.length) parts.push({ text: line.slice(at) });
  return parts;
}

/**
 * Read an idea file: the text learners get (pending suggestions are not in
 * it), without `%% comments %%`. Never throws; what it cannot read is left
 * empty and, where the format says so, reported in `warnings`.
 */
export function parseIdea(raw: string): ParsedIdea {
  const text = resolvePending(raw.replace(/\r\n/g, '\n'), 'reject');
  const warnings: string[] = [];

  const frontmatter = FRONTMATTER.exec(text)?.[0] ?? '';
  const attributes = frontmatter ? extractFrontmatter(text) ?? {} : {};
  const id = typeof attributes.id === 'string' && UUID.test(attributes.id.trim()) ? attributes.id.trim() : null;
  let priority: Priority = 'medium';
  const rawPriority = attributes.priority;
  if (rawPriority === undefined || rawPriority === null || rawPriority === '') {
    warnings.push('No priority: taken as medium');
  } else if ((PRIORITIES as readonly string[]).includes(String(rawPriority).trim().toLowerCase())) {
    priority = String(rawPriority).trim().toLowerCase() as Priority;
  } else {
    warnings.push(`Unknown priority "${String(rawPriority)}": taken as medium`);
  }

  const body = text.slice(frontmatter.length).replace(COMMENT, '');
  const parts = parseSections(body);
  const firstHeading = parts.find((s) => s.level === 2);
  const outcome = body.slice(0, firstHeading ? firstHeading.from : body.length).trim();

  const sections = new Map<SectionName, string>();
  const questionList: IdeaQuestion[] = [];
  let bareQuestions = 0;
  let current: SectionName | null = null;
  for (const part of parts) {
    if (part.level === 2) {
      const name = part.label.toLowerCase();
      current = (SECTIONS as readonly string[]).includes(name) ? (name as SectionName) : null;
      if (!current) warnings.push(`Unknown section "${part.label}"`);
    }
    if (!current) continue;
    // The heading line itself is not part of a section's text
    const content = part.level === 2 ? part.content.slice(part.content.indexOf('\n') + 1 || part.content.length) : part.content;
    sections.set(current, (sections.get(current) ?? '') + content);
    if (current !== 'questions' || part.level === 2) continue;
    const question = QUESTION_TITLE.exec(part.label);
    if (!question) continue;
    const type = (question[1] ?? '').trim();
    questionList.push({ type, content: (parseFields(part.content).get('content') ?? '').trim().split('\n')[0].trim() });
    if (!type) bareQuestions++;
    else if (!QUESTION_TYPES.includes(type.toLowerCase())) warnings.push(`Unknown question type "${type}"`);
  }

  const learn = (sections.get('learn') ?? '')
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim())
    .filter(Boolean)
    .map(learnLine);

  return {
    id,
    priority,
    courses: courseLinks(attributes.courses),
    outcome,
    requires: linkedNames(sections.get('requires') ?? ''),
    helpful: linkedNames(sections.get('helpful first') ?? ''),
    why: (sections.get('why it matters') ?? '').trim(),
    learn,
    lenses: learn.flatMap((line) => line.flatMap((part) => ('link' in part ? [part.link] : []))),
    questions: questionList.length,
    questionList,
    bareQuestions,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

/** A file of the folder: its name (no `.md`), its doc uuid and its text
 *  (null when it could not be read). */
export interface IdeaFile {
  name: string;
  docId: string;
  text: string | null;
}

export type ProblemKind =
  | 'no-id' | 'duplicate-id' | 'no-outcome' | 'no-questions' | 'no-lens' | 'lens-missing'
  | 'not-written' | 'cycle' | 'bare-question' | 'warning' | 'placeholder' | 'unread';

export interface Problem {
  kind: ProblemKind;
  text: string;
  /** An error breaks the idea for learners; the rest is still to do. */
  error: boolean;
}

export interface IdeaNode {
  /** `ideaKey` of the name: what edges and selections refer to. */
  key: string;
  name: string;
  /** False for a "not written yet" idea: named as a requirement, no file. */
  written: boolean;
  docId: string | null;
  /** What the file says; null for a placeholder and for a file not read. */
  idea: ParsedIdea | null;
  /** Keys of the ideas that must come first. */
  requires: string[];
  /** Keys of the ideas that help but are not needed. */
  helpful: string[];
  /** Keys of the ideas whose Requires name this one. */
  neededFor: string[];
  /** Keys of the ideas whose Helpful first name this one. */
  helpfulFor: string[];
  /** 1 for an idea with no requirements, else one more than its latest. */
  step: number;
  inCycle: boolean;
  problems: Problem[];
}

export interface IdeaGraph {
  /** Every idea and placeholder, by name. */
  nodes: IdeaNode[];
  byKey: Map<string, IdeaNode>;
  /** `steps[0]` is step 1. */
  steps: IdeaNode[][];
  /** The groups of ideas that require each other in a circle. */
  cycles: string[][];
}

export interface IdeaGraphOptions {
  /** Whether a Learn link (as written) finds a file; unknown when left out. */
  lensExists?: (link: string) => boolean;
}

const byName = (a: IdeaNode, b: IdeaNode) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });

/**
 * The groups of nodes that reach each other through `next` (Tarjan), in an
 * order where a group comes after every group it points to.
 */
function stronglyConnected(keys: readonly string[], next: (key: string) => readonly string[]): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const groups: string[][] = [];
  let counter = 0;

  // Iterative: 150 ideas in a chain must not overflow the call stack.
  for (const root of keys) {
    if (index.has(root)) continue;
    const work: Array<{ key: string; edge: number }> = [{ key: root, edge: 0 }];
    index.set(root, counter);
    low.set(root, counter++);
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const targets = next(frame.key);
      if (frame.edge < targets.length) {
        const target = targets[frame.edge++];
        if (!index.has(target)) {
          index.set(target, counter);
          low.set(target, counter++);
          stack.push(target);
          onStack.add(target);
          work.push({ key: target, edge: 0 });
        } else if (onStack.has(target)) {
          low.set(frame.key, Math.min(low.get(frame.key)!, index.get(target)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.key, Math.min(low.get(parent.key)!, low.get(frame.key)!));
      if (low.get(frame.key) !== index.get(frame.key)) continue;
      const group: string[] = [];
      for (;;) {
        const member = stack.pop()!;
        onStack.delete(member);
        group.push(member);
        if (member === frame.key) break;
      }
      groups.push(group);
    }
  }
  return groups;
}

/**
 * The ideas of a folder as a graph. Files whose name starts with `_` are not
 * ideas. A requirement with no file becomes a "not written yet" node. A
 * cycle of requirements is marked on its ideas, which then share a step.
 */
export function buildIdeaGraph(files: readonly IdeaFile[], options: IdeaGraphOptions = {}): IdeaGraph {
  const byKey = new Map<string, IdeaNode>();
  const node = (name: string): IdeaNode => {
    const key = ideaKey(name);
    let found = byKey.get(key);
    if (!found) {
      found = {
        key, name, written: false, docId: null, idea: null,
        requires: [], helpful: [], neededFor: [], helpfulFor: [], step: 1, inCycle: false, problems: [],
      };
      byKey.set(key, found);
    }
    return found;
  };

  const ideas = files.filter((f) => !f.name.startsWith('_'));
  for (const file of ideas) {
    const n = node(file.name);
    // Two files whose names differ only in case: the first one is the idea
    if (n.written) continue;
    Object.assign(n, {
      name: file.name, written: true, docId: file.docId, idea: file.text === null ? null : parseIdea(file.text),
    });
  }
  for (const n of [...byKey.values()]) {
    if (!n.idea) continue;
    n.requires = n.idea.requires.map((name) => node(name).key);
    n.helpful = n.idea.helpful.map((name) => node(name).key).filter((key) => !n.requires.includes(key));
  }
  const nodes = [...byKey.values()].sort(byName);
  for (const n of nodes) {
    for (const key of n.requires) byKey.get(key)!.neededFor.push(n.key);
    for (const key of n.helpful) byKey.get(key)!.helpfulFor.push(n.key);
  }

  // Steps and cycles: groups come out requirements first.
  const cycles: string[][] = [];
  for (const group of stronglyConnected(nodes.map((n) => n.key), (key) => byKey.get(key)!.requires)) {
    const members = new Set(group);
    const inCycle = group.length > 1 || byKey.get(group[0])!.requires.includes(group[0]);
    let step = 1;
    for (const key of group) {
      for (const required of byKey.get(key)!.requires) {
        if (!members.has(required)) step = Math.max(step, byKey.get(required)!.step + 1);
      }
    }
    for (const key of group) Object.assign(byKey.get(key)!, { step, inCycle });
    if (inCycle) cycles.push([...group].sort());
  }
  cycles.sort((a, b) => a[0].localeCompare(b[0]));

  const steps: IdeaNode[][] = [];
  for (const n of nodes) (steps[n.step - 1] ??= []).push(n);

  const sameId = new Map<string, IdeaNode[]>();
  for (const n of nodes) {
    if (n.idea?.id) sameId.set(n.idea.id.toLowerCase(), [...(sameId.get(n.idea.id.toLowerCase()) ?? []), n]);
  }
  for (const n of nodes) n.problems = problemsOf(n, byKey, cycles, sameId, options);

  return { nodes, byKey, steps: Array.from(steps, (s) => s ?? []), cycles };
}

function problemsOf(
  n: IdeaNode,
  byKey: Map<string, IdeaNode>,
  cycles: string[][],
  sameId: Map<string, IdeaNode[]>,
  { lensExists }: IdeaGraphOptions,
): Problem[] {
  if (!n.written) return [{ kind: 'placeholder', text: 'Not written yet', error: false }];
  if (!n.idea) return [{ kind: 'unread', text: 'Could not read this file', error: true }];
  const idea = n.idea;
  const problems: Problem[] = [];
  const add = (kind: ProblemKind, text: string, error = false) => problems.push({ kind, text, error });
  const names = (keys: string[]) => keys.map((key) => byKey.get(key)!.name).join(', ');

  if (!idea.id) add('no-id', 'No id (a UUID) in the frontmatter', true);
  const twins = idea.id ? sameId.get(idea.id.toLowerCase())!.filter((other) => other !== n) : [];
  if (twins.length > 0) add('duplicate-id', `Same id as ${twins.map((t) => t.name).join(', ')}`, true);
  if (!idea.outcome) add('no-outcome', 'No outcome');
  if (idea.questions === 0) add('no-questions', 'No questions');
  if (idea.lenses.length === 0) add('no-lens', 'No lens under Learn');
  if (lensExists) {
    for (const link of idea.lenses) {
      if (!lensExists(link)) add('lens-missing', `Lens not found: ${linkName(link)}`, true);
    }
  }
  const unwritten = n.requires.filter((key) => !byKey.get(key)!.written);
  if (unwritten.length > 0) add('not-written', `Requirement not written yet: ${names(unwritten)}`);
  if (n.inCycle) {
    const others = cycles.find((c) => c.includes(n.key))!.filter((key) => key !== n.key);
    add('cycle', others.length > 0 ? `Requires itself, through ${names(others)}` : 'Requires itself', true);
  }
  if (idea.bareQuestions > 0) {
    add('bare-question', `${idea.bareQuestions} question${idea.bareQuestions === 1 ? '' : 's'} without a type ("#### Question: Open")`, true);
  }
  for (const warning of idea.warnings) add('warning', warning);
  return problems;
}

export type IdeaSortColumn = 'name' | 'priority' | 'step' | 'requires' | 'neededFor' | 'lenses' | 'questions' | 'problems';

/** The rows of the table, sorted by a column (ties by name). A new list. */
export function sortIdeas(nodes: readonly IdeaNode[], column: IdeaSortColumn, descending = false): IdeaNode[] {
  const value = (n: IdeaNode): number => {
    switch (column) {
      case 'priority': return n.idea ? PRIORITIES.indexOf(n.idea.priority) : PRIORITIES.length;
      case 'step': return n.step;
      case 'requires': return n.requires.length;
      case 'neededFor': return n.neededFor.length;
      case 'lenses': return n.idea?.lenses.length ?? 0;
      case 'questions': return n.idea?.questions ?? 0;
      case 'problems': return n.problems.length;
      default: return 0;
    }
  };
  const sign = descending ? -1 : 1;
  return [...nodes].sort((a, b) => {
    if (column === 'name') return sign * byName(a, b);
    return sign * (value(a) - value(b)) || byName(a, b);
  });
}

/**
 * The map's columns, left to right, each a list of keys from top to bottom.
 * An idea stands one column right of the latest idea it requires or finds
 * helpful first, so every arrow points to the right; the ideas of a circle
 * share a column. Within a column, ideas are ordered by where their
 * neighbours stand (a few barycentre sweeps), so fewer lines cross.
 */
export function mapColumns(graph: IdeaGraph): string[][] {
  const before = new Map(graph.nodes.map((n) => [n.key, [...n.requires, ...n.helpful]]));
  const after = new Map(graph.nodes.map((n) => [n.key, [...n.neededFor, ...n.helpfulFor]]));
  const column = new Map<string, number>();
  for (const group of stronglyConnected(graph.nodes.map((n) => n.key), (key) => before.get(key)!)) {
    const members = new Set(group);
    let at = 0;
    for (const key of group) {
      for (const first of before.get(key)!) {
        if (!members.has(first)) at = Math.max(at, column.get(first)! + 1);
      }
    }
    for (const key of group) column.set(key, at);
  }
  const columns: string[][] = [];
  for (const n of graph.nodes) (columns[column.get(n.key)!] ??= []).push(n.key);

  // Where an idea stands in its column, from 0 (top) to 1 (bottom): columns
  // are centred on each other, whatever their length.
  const place = new Map<string, number>();
  const settle = (keys: string[]) => keys.forEach((key, i) => place.set(key, (i + 0.5) / keys.length));
  columns.forEach(settle);
  const sweep = (index: number, neighbours: Map<string, string[]>) => {
    const keys = columns[index];
    const wish = new Map(keys.map((key) => {
      const others = neighbours.get(key)!.filter((other) => column.get(other) !== index);
      const sum = others.reduce((total, other) => total + place.get(other)!, 0);
      return [key, others.length > 0 ? sum / others.length : place.get(key)!];
    }));
    keys.sort((a, b) => wish.get(a)! - wish.get(b)!);
    settle(keys);
  };
  for (let round = 0; round < 4; round++) {
    for (let i = 1; i < columns.length; i++) sweep(i, before);
    for (let i = columns.length - 2; i >= 0; i--) sweep(i, after);
  }
  return columns;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface NewIdea {
  id: string;
  priority: Priority;
  outcome: string;
  why: string;
  /** Names of the ideas that must come first. */
  requires: readonly string[];
  helpful: readonly string[];
}

/** Typed text as one paragraph: a line break could start a heading. */
const oneParagraph = (text: string) => text.trim().split(/\s*\n\s*/).filter(Boolean).join(' ');
const linkLines = (names: readonly string[]) => names.map((name) => `- [[${name}]]\n`).join('');

/** The text of a new idea file, with empty `## Learn` and `## Questions`. */
export function renderIdeaFile({ id, priority, outcome, why, requires, helpful }: NewIdea): string {
  const whyText = oneParagraph(why);
  return [
    `---\nid: ${id}\npriority: ${priority}\ncourses:\n  - "[[${IDEA_COURSE_LINK}]]"\n---\n${oneParagraph(outcome)}\n`,
    `## Requires\n${linkLines(requires)}`,
    `## Helpful first\n${linkLines(helpful)}`,
    `## Why it matters\n${whyText ? `${whyText}\n` : ''}`,
    '## Learn\n',
    '## Questions\n',
  ].join('\n');
}

const NAME_FORBIDDEN = /[\\/:*?"<>|[\]#^]/;
const MAX_IDEA_NAME = 120;

/**
 * Why `name` cannot be the name of a new idea (it becomes the file name and
 * is linked as `[[name]]`), or null. `existing` are the names of the files in
 * the folder, skipped ones included.
 */
export function ideaNameProblem(name: string, existing: Iterable<string>): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Give the concept a name.';
  const forbidden = NAME_FORBIDDEN.exec(trimmed);
  if (forbidden) return `A name cannot contain ${forbidden[0]}`;
  if (/^[_.]/.test(trimmed)) return 'A name cannot start with _ or a dot.';
  if (/\.md$/i.test(trimmed)) return 'Leave out ".md": the name becomes the file name.';
  if (trimmed.length > MAX_IDEA_NAME) return 'This name is too long.';
  const key = ideaKey(trimmed);
  for (const other of existing) {
    if (ideaKey(other) === key) return 'A file with this name already exists.';
  }
  return null;
}

/** The ideas picked as requirements of one idea, by name. */
export interface Picks {
  requires: string[];
  helpful: string[];
}

/** Toggle `name` in one list; an idea is never in both. */
export function togglePick(picks: Picks, name: string, list: keyof Picks): Picks {
  const key = ideaKey(name);
  const without = (names: string[]) => names.filter((n) => ideaKey(n) !== key);
  const other = list === 'requires' ? 'helpful' : 'requires';
  const had = picks[list].some((n) => ideaKey(n) === key);
  return {
    ...picks,
    [other]: without(picks[other]),
    [list]: had ? without(picks[list]) : [...picks[list], name],
  } as Picks;
}

/**
 * The lists a file should get when the form changed `before` into `after`
 * while the file itself says `live` (someone may have edited it meanwhile):
 * only what was added or removed in the form is added or removed.
 */
export function mergePicks(live: Picks, before: Picks, after: Picks): Picks {
  const keys = (names: readonly string[]) => new Set(names.map(ideaKey));
  const merge = (list: keyof Picks) => {
    const had = keys(before[list]);
    const has = keys(after[list]);
    const kept = live[list].filter((n) => has.has(ideaKey(n)) || !had.has(ideaKey(n)));
    const present = keys(kept);
    return [...kept, ...after[list].filter((n) => !had.has(ideaKey(n)) && !present.has(ideaKey(n)))];
  };
  const requires = merge('requires');
  const required = keys(requires);
  return { requires, helpful: merge('helpful').filter((n) => !required.has(ideaKey(n))) };
}

/**
 * The circle that giving the idea `name` the requirements `requires` would
 * make, as names from the idea back to itself, or null: a requirement that
 * already needs the idea, directly or through others.
 */
export function requirementCircle(graph: IdeaGraph, name: string, requires: readonly string[]): string[] | null {
  const target = graph.byKey.get(ideaKey(name));
  if (!target) return null;
  for (const start of requires.map(ideaKey)) {
    // Breadth first, so the circle shown is a shortest one
    const cameFrom = new Map<string, string | null>([[start, null]]);
    const queue = [start];
    for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
      if (key === target.key) {
        const path: string[] = [];
        for (let at: string | null = key; at !== null; at = cameFrom.get(at) ?? null) path.unshift(at);
        return [target.name, ...path.map((k) => graph.byKey.get(k)?.name ?? k)];
      }
      for (const next of graph.byKey.get(key)?.requires ?? []) {
        if (!cameFrom.has(next)) {
          cameFrom.set(next, key);
          queue.push(next);
        }
      }
    }
  }
  return null;
}

export const PENDING_REQUIREMENTS_ERROR =
  'The requirements of this file have pending suggestions. Open the file and accept or reject them first.';

interface Line {
  from: number;
  /** After the line break (or the end of the text). */
  to: number;
  text: string;
}

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let from = 0;
  while (from < text.length) {
    const end = text.indexOf('\n', from);
    const to = end === -1 ? text.length : end + 1;
    lines.push({ from, to, text: text.slice(from, end === -1 ? text.length : end).replace(/\r$/, '') });
    from = to;
  }
  return lines;
}

const SECTION_HEADING = /^##(?!#)\s*(.*?)\s*$/;

type Changes = { changes: TextChange[] } | { error: string };

/** A file as stored (suggestions and all), cut into lines and `## ` sections. */
function scanFile(text: string) {
  const markup = parseCriticMarkup(text);
  const hidden: Array<{ from: number; to: number }> = [
    ...[...text.matchAll(COMMENT)].map((m) => ({ from: m.index, to: m.index + m[0].length })),
    ...markup.filter((r) => r.type === 'comment'),
  ];
  const frontmatterEnd = /^---[ \t]*\r?\n[\s\S]*?\n---[ \t]*(?:\r?\n|$)/.exec(text)?.[0].length ?? 0;
  const isHidden = (pos: number) => pos < frontmatterEnd || hidden.some((r) => pos >= r.from && pos < r.to);

  const lines = linesOf(text);
  const headings = lines.flatMap((line, index) => {
    const title = isHidden(line.from) ? null : SECTION_HEADING.exec(line.text)?.[1];
    return title === undefined || title === null ? [] : [{ index, name: title.toLowerCase() }];
  });
  const sectionOf = (name: SectionName) => {
    const at = headings.findIndex((h) => h.name === name);
    if (at === -1) return null;
    const next = headings[at + 1];
    const heading = lines[headings[at].index];
    const body = lines.slice(headings[at].index + 1, next ? next.index : lines.length);
    return { heading, body, from: heading.from, to: (body.at(-1) ?? heading).to };
  };
  /** Where the first of the sections `names` starts, or null. */
  const headingAt = (names: readonly string[]) => {
    const found = headings.find((h) => names.includes(h.name));
    return found ? lines[found.index].from : null;
  };
  /** A suggestion nobody accepted or rejected yet touches `from`..`to`. */
  const pendingIn = (from: number, to: number) =>
    markup.some((r) => r.type !== 'comment' && r.type !== 'highlight' && r.from < to && r.to > from);
  return { isHidden, sectionOf, headingAt, pendingIn };
}

/** What separates a new last section from a text that ends as `text` does: a blank line. */
const gapAtEnd = (text: string) => (text.length === 0 || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n');

/**
 * The changes that make `text` (a file as stored, suggestions and all) list
 * `requires` under `## Requires` and `helpful` under `## Helpful first`.
 * Only link lines of those two sections change: a dropped idea loses its
 * line (or just its link, on a line that says more), a new one gets a
 * `- [[Name]]` line after the section's last line, and a heading is added
 * only for a list that needs one. Nothing else in the file is touched.
 * Refuses while one of the two sections holds a pending suggestion.
 */
export function requirementChanges(text: string, requires: readonly string[], helpful: readonly string[]): Changes {
  const { isHidden, sectionOf, headingAt, pendingIn } = scanFile(text);

  const changes: TextChange[] = [];
  /** Lines to put at `pos`, the start of a line or the end of the text. */
  const insertLines = (pos: number, block: string) => {
    const needsBreak = pos === text.length && text.length > 0 && !text.endsWith('\n');
    changes.push({ from: pos, to: pos, insert: (needsBreak ? '\n' : '') + block });
  };

  const requiresSection = sectionOf('requires');
  const lists = [
    { name: 'requires' as const, title: 'Requires', wanted: requires, section: requiresSection },
    { name: 'helpful first' as const, title: 'Helpful first', wanted: helpful, section: sectionOf('helpful first') },
  ];
  /** New sections, by the position they go to (both may go to the same). */
  const newSections = new Map<number, string[]>();

  for (const { name, title, wanted, section } of lists) {
    const wantedKeys = new Set(wanted.map(ideaKey));
    if (!section) {
      if (wanted.length === 0) continue;
      let pos: number | null;
      if (name === 'requires') {
        pos = headingAt(SECTIONS.slice(1));
      } else if (requiresSection) {
        const after = requiresSection.body.at(-1) ?? requiresSection.heading;
        pos = after.to;
      } else {
        pos = headingAt(SECTIONS.slice(2));
      }
      pos ??= text.length;
      newSections.set(pos, [...(newSections.get(pos) ?? []), `## ${title}\n${linkLines(wanted)}`]);
      continue;
    }

    const present = new Set<string>();
    /** Where new lines go: after the last line that says something. */
    let insertAt = section.heading.to;
    const edits: TextChange[] = [];
    for (const line of section.body) {
      const links = wikilinks(line.text)
        .filter((l) => !isHidden(line.from + l.from))
        .map((l) => ({ ...l, key: ideaKey(linkName(l.target)) }));
      const dropped = links.filter((l) => {
        if (!l.key) return false;
        if (!wantedKeys.has(l.key) || present.has(l.key)) return true;
        present.add(l.key);
        return false;
      });
      let rest = line.text;
      for (const l of [...dropped].reverse()) rest = rest.slice(0, l.from) + rest.slice(l.to);
      if (dropped.length > 0 && /^\s*(?:[-*+]|\d+[.)])?\s*$/.test(rest)) {
        edits.push({ from: line.from, to: line.to, insert: '' });
        continue;
      }
      for (const l of dropped) edits.push({ from: line.from + l.from, to: line.from + l.to, insert: '' });
      if (line.text.trim()) insertAt = line.to;
    }
    const added = wanted.filter((n) => !present.has(ideaKey(n)));
    if (edits.length === 0 && added.length === 0) continue;
    if (pendingIn(section.from, section.to)) return { error: PENDING_REQUIREMENTS_ERROR };
    changes.push(...edits);
    if (added.length > 0) insertLines(insertAt, linkLines(added));
  }

  for (const [pos, blocks] of newSections) {
    if (pos === text.length) {
      // At the end of the file: a blank line before, none after
      changes.push({ from: pos, to: pos, insert: gapAtEnd(text) + blocks.join('\n') });
    } else {
      changes.push({ from: pos, to: pos, insert: blocks.map((b) => `${b}\n`).join('') });
    }
  }

  return { changes: mergeChanges(changes) };
}

/** In text order, with changes that touch joined into one. */
function mergeChanges(changes: TextChange[]): TextChange[] {
  const sorted = changes
    .map((change, order) => ({ change, order }))
    .sort((a, b) => a.change.from - b.change.from || a.change.to - b.change.to || a.order - b.order)
    .map(({ change }) => change);
  const merged: TextChange[] = [];
  for (const change of sorted) {
    const last = merged[merged.length - 1];
    if (last && change.from <= last.to) {
      last.to = Math.max(last.to, change.to);
      last.insert += change.insert;
    } else {
      merged.push({ ...change });
    }
  }
  return merged;
}

/** `text` with `changes` made (they are in text order and do not overlap). */
export function applyChanges(text: string, changes: readonly TextChange[]): string {
  let out = text;
  for (const change of [...changes].reverse()) {
    out = out.slice(0, change.from) + change.insert + out.slice(change.to);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/** A question to add to an idea, as the form holds it. */
export type NewQuestion =
  | { type: 'Open'; content: string; assessment?: string; feedback?: string }
  | { type: 'Choice'; content: string; options: { text: string; correct: boolean }[]; explanation?: string };

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 6;

export const PENDING_QUESTIONS_ERROR =
  'The questions of this file have pending suggestions. Open the file and accept or reject them first.';

/** A line that would start a heading or a field of its own inside a value. */
const BREAKS_VALUE = /^\s*(?:#|\w[\w-]*::)/m;

/**
 * Why `question` cannot be added, or null. Every value becomes one
 * paragraph of a `name:: value` field, so none may hold a line that starts a
 * heading or another field.
 */
export function newQuestionProblem(question: NewQuestion): string | null {
  if (!question.content.trim()) return 'Write the question.';
  const values: Array<[string, string | undefined]> = question.type === 'Open'
    ? [['The question', question.content], ['The grading text', question.assessment], ['The tutor text', question.feedback]]
    : [
      ['The question', question.content],
      ...question.options.map((option): [string, string] => ['An option', option.text]),
      ['The explanation', question.explanation],
    ];
  for (const [label, value] of values) {
    if (value && BREAKS_VALUE.test(value)) return `${label} cannot have a line that starts with # or with a field name like "name::".`;
  }
  if (question.type === 'Choice') {
    if (question.options.length < MIN_OPTIONS) return `A choice question needs at least ${MIN_OPTIONS} options.`;
    if (question.options.length > MAX_OPTIONS) return `A choice question has at most ${MAX_OPTIONS} options.`;
    if (question.options.some((option) => !option.text.trim())) return 'Fill in every option, or remove the empty ones.';
    if (!question.options.some((option) => option.correct)) return 'Tick at least one right answer.';
  }
  return null;
}

/**
 * The text of a question segment (standard Lens syntax, always typed), ending
 * in a line break. Optional fields that are empty are left out.
 */
export function renderQuestion(question: NewQuestion & { id: string }): string {
  const lines = [`#### Question: ${question.type}`, `id:: ${question.id}`, `content:: ${oneParagraph(question.content)}`];
  const field = (name: string, value: string | undefined) => {
    const text = oneParagraph(value ?? '');
    if (text) lines.push(`${name}:: ${text}`);
  };
  if (question.type === 'Open') {
    field('assessment-instructions', question.assessment);
    field('feedback-instructions', question.feedback);
  } else {
    lines.push('options::');
    for (const option of question.options) lines.push(`- [${option.correct ? 'x' : ' '}] ${oneParagraph(option.text)}`);
    lines.push('shuffle:: true');
    field('explanation', question.explanation);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The change that puts `segment` (a rendered question) at the end of the
 * `## Questions` section of `text` (a file as stored), a blank line after the
 * question before it; the heading is added at the end of the file when it is
 * missing. Nothing else in the file is touched. Refuses while the section
 * holds a pending suggestion.
 */
export function questionChanges(text: string, segment: string): Changes {
  const { sectionOf, pendingIn } = scanFile(text);
  const block = segment.endsWith('\n') ? segment : `${segment}\n`;
  const section = sectionOf('questions');
  if (!section) {
    return { changes: [{ from: text.length, to: text.length, insert: `${gapAtEnd(text)}## Questions\n${block}` }] };
  }
  if (pendingIn(section.from, section.to)) return { error: PENDING_QUESTIONS_ERROR };
  const last = section.body.filter((line) => line.text.trim() !== '').at(-1);
  const pos = (last ?? section.heading).to;
  const unfinishedLine = pos === text.length && !text.endsWith('\n');
  // Straight before the next section: keep a blank line between them
  const before = (unfinishedLine ? '\n' : '') + (last ? '\n' : '');
  const after = pos < text.length && pos === section.to ? '\n' : '';
  return { changes: [{ from: pos, to: pos, insert: before + block + after }] };
}
