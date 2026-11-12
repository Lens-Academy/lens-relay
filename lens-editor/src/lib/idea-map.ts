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
 * that give a file other requirements (`requirementChanges`), other values
 * (`ideaEditChanges`), another name for an idea it links (`renameLinkChanges`)
 * or no link to it (`removeLinkChanges`), and that add, change or remove a
 * question (`questionChanges`, `questionEditChanges`, `questionDeleteChanges`).
 * Every change leaves the rest of the file as it is, byte for byte. Names are
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
export const IDEA_COURSE_LINK = '../courses/in-development/Context Accelerator';

export const PRIORITIES = ['high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** A piece of a Learn line: words, or a link with the words it shows. */
export type LearnPart = { text: string } | { link: string; label: string };

/** A `name:: value` field of a question, as written. */
export interface QuestionField {
  name: string;
  value: string;
}

/**
 * A question of an idea: the type after `#### Question:` ("" when it has
 * none) and its values as written in the file, line breaks kept. A value is
 * null when its field is not there; `options` also when the list cannot be
 * read as options. A plain `- text` option and `- [ ] text` are both not a
 * right answer. `other` holds every field not named here, in order
 * (`max-words`, `shuffle`, `multi`, `force-feedback`, unknown ones).
 */
export interface IdeaQuestion {
  type: string;
  content: string;
  id: string | null;
  /** `assessment-instructions::` */
  assessment: string | null;
  /** `feedback-instructions::` */
  feedback: string | null;
  options: { text: string; correct: boolean }[] | null;
  explanation: string | null;
  other: QuestionField[];
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
  /** The text under `## Learn`, as written. */
  learnText: string;
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

const FIELD_LINE = /^(\w[\w-]*)::(?:\s(.*))?$/;

/** A `name:: value` field of a segment: the lines it takes (`end` is past its
 *  last line that says something) and its value as lib/parseFields reads it. */
interface SegmentField {
  name: string;
  start: number;
  end: number;
  value: string;
}

/** The fields among `lines`, the lines of a segment after its heading. */
function fieldsOf(lines: readonly string[]): SegmentField[] {
  const starts = lines.flatMap((line, start) => {
    const name = FIELD_LINE.exec(line)?.[1];
    return name ? [{ name, start }] : [];
  });
  return starts.map(({ name, start }, n) => {
    let end = n + 1 < starts.length ? starts[n + 1].start : lines.length;
    while (end > start + 1 && lines[end - 1].trim() === '') end--;
    return { name, start, end, value: parseFields(lines.slice(start, end).join('\n')).get(name) ?? '' };
  });
}

/** The fields an `IdeaQuestion` holds by name; the rest is its `other`. */
const NAMED_FIELDS = ['id', 'content', 'assessment-instructions', 'feedback-instructions', 'options', 'explanation'];

/** The options of an `options::` list, as the platform reads them; null when
 *  a line is no option (or is a survey's `- freeform::`). */
function readOptions(value: string): { text: string; correct: boolean }[] | null {
  const options: { text: string; correct: boolean }[] = [];
  for (const line of value.split('\n')) {
    const item = line.trim();
    if (!item) continue;
    const box = /^-\s*\[([xX]|\s?)\]\s*(.*)$/.exec(item);
    const plain = box || /^-\s*freeform::/.test(item) ? null : /^-\s+(.+)$/.exec(item);
    if (!box && !plain) return null;
    options.push({ text: (box ? box[2] : plain![1]).trim(), correct: !!box && box[1].toLowerCase() === 'x' });
  }
  return options;
}

/** A question from the lines of its segment after the heading. Of a field
 *  written twice the last one counts, as for the platform. */
function readQuestion(type: string, lines: readonly string[]): IdeaQuestion {
  const fields = fieldsOf(lines);
  const values = new Map(fields.map((field) => [field.name, field.value]));
  const options = values.get('options');
  return {
    type,
    content: values.get('content') ?? '',
    id: values.get('id')?.trim() || null,
    assessment: values.get('assessment-instructions') ?? null,
    feedback: values.get('feedback-instructions') ?? null,
    options: options === undefined ? null : readOptions(options),
    explanation: values.get('explanation') ?? null,
    other: fields.filter((field) => !NAMED_FIELDS.includes(field.name)).map(({ name, value }) => ({ name, value })),
  };
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
    questionList.push(readQuestion(type, part.content.split('\n').slice(1)));
    if (!type) bareQuestions++;
    else if (!QUESTION_TYPES.includes(type.toLowerCase())) warnings.push(`Unknown question type "${type}"`);
  }

  const learnText = (sections.get('learn') ?? '').trim();
  const learn = learnText
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
    learnText,
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
  /** Link targets for `courses`; the Context Accelerator when left out. */
  courses?: readonly string[];
  /** The text under `## Learn`: a line per lens. */
  learn?: string;
}

/** Typed text as one paragraph: a line break could start a heading. */
const oneParagraph = (text: string) => text.trim().split(/\s*\n\s*/).filter(Boolean).join(' ');
const linkLines = (names: readonly string[]) => names.map((name) => `- [[${name}]]\n`).join('');

/** Course links as typed: without `[[ ]]` around them, empty ones dropped. */
const cleanCourses = (courses: readonly string[]) =>
  courses.map((course) => course.trim().replace(/^\[\[/, '').replace(/\]\]$/, '').trim()).filter(Boolean);
const courseLines = (courses: readonly string[]) => ['courses:', ...courses.map((course) => `  - "[[${course}]]"`)];

/** The text of a new idea file, with an empty `## Questions`. */
export function renderIdeaFile({ id, priority, outcome, why, requires, helpful, courses, learn }: NewIdea): string {
  const whyText = oneParagraph(why);
  const learnText = cleanValue(learn);
  const courseList = cleanCourses(courses ?? [IDEA_COURSE_LINK]);
  const front = [`id: ${id}`, `priority: ${priority}`, ...(courseList.length > 0 ? courseLines(courseList) : [])];
  return [
    `---\n${front.join('\n')}\n---\n${oneParagraph(outcome)}\n`,
    `## Requires\n${linkLines(requires)}`,
    `## Helpful first\n${linkLines(helpful)}`,
    `## Why it matters\n${whyText ? `${whyText}\n` : ''}`,
    `## Learn\n${learnText ? `${learnText}\n` : ''}`,
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

/** A row of the list under a requirements box: an idea of the map, or the
 *  typed name as an idea that has no file yet. */
export type PickOption =
  | { kind: 'idea'; key: string; name: string; written: boolean }
  | { kind: 'new'; name: string };

export interface PickChoices {
  /** Best match first; a `new` row is always the last one. */
  options: PickOption[];
  /** Why the typed text itself cannot be added, to show under the box; null
   *  when it can, or when nothing is typed. */
  problem: string | null;
}

/** How well a name matches typed text: the whole name, its start, the start
 *  of one of its words, anywhere; -1 when it does not. */
function matchRank(key: string, wanted: string): number {
  if (key === wanted) return 0;
  const at = key.indexOf(wanted);
  if (at < 0) return -1;
  if (at === 0) return 1;
  for (let i = at; i >= 0; i = key.indexOf(wanted, i + 1)) {
    if (/[^\p{L}\p{N}]/u.test(key[i - 1])) return 2;
  }
  return 3;
}

/**
 * What a requirements box offers for `typed`: the ideas of the map whose name
 * holds it (not the idea itself, `ownNames`: the name of its file and the one
 * typed for it, and not what is in one of the two lists already), best match first, and, when no idea has exactly this name,
 * the name itself as a new idea: a link to it makes a "not written yet" idea
 * on the map. The name follows the rules of a file name (ideaNameProblem).
 * With nothing typed: every idea that can still be picked.
 */
export function pickChoices(typed: string, nodes: readonly IdeaNode[], picks: Picks, ownNames: readonly string[], limit = 50): PickChoices {
  const wanted = ideaKey(typed);
  const own = new Set(ownNames.map(ideaKey).filter(Boolean));
  const inList = (list: keyof Picks, key: string) => picks[list].some((name) => ideaKey(name) === key);
  const free = nodes.filter((node) => !own.has(node.key) && !inList('requires', node.key) && !inList('helpful', node.key));
  const option = (node: IdeaNode): PickOption => ({ kind: 'idea', key: node.key, name: node.name, written: node.written });
  if (!wanted) return { options: free.slice(0, limit).map(option), problem: null };

  const options = free
    .map((node) => ({ node, rank: matchRank(node.key, wanted) }))
    .filter((found) => found.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map((found) => option(found.node));
  if (own.has(wanted)) return { options, problem: 'A concept cannot be its own requirement.' };
  if (inList('requires', wanted)) return { options, problem: 'This concept is under Requires already.' };
  if (inList('helpful', wanted)) return { options, problem: 'This concept is under Helpful first already.' };
  if (nodes.some((node) => node.key === wanted)) return { options, problem: null };
  // A link to a file that exists is fine, so no name counts as taken here
  const problem = ideaNameProblem(typed, []);
  if (problem) return { options, problem };
  return { options: [...options, { kind: 'new', name: typed.trim() }], problem: null };
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
  /** A suggestion, a remark or a `%% comment %%` touches `from`..`to`. */
  const markedIn = (from: number, to: number) => [...markup, ...hidden].some((r) => r.from < to && r.to > from);
  /** The first `## ` heading of the file, or null. */
  const firstHeading = headings[0] ? lines[headings[0].index] : null;
  return { lines, frontmatterEnd, firstHeading, isHidden, sectionOf, headingAt, pendingIn, markedIn };
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
  const edits = requirementEdits(text, scanFile(text), requires, helpful);
  if ('error' in edits) return edits;
  return { changes: mergeChanges([...edits.changes, ...sectionInserts(text, edits.newSections)]) };
}

/** New sections by the position they go to (several may go to the same). */
type NewSections = Map<number, string[]>;

/** The changes that put new sections (each ending in a line break) in. */
function sectionInserts(text: string, newSections: NewSections): TextChange[] {
  return [...newSections].map(([pos, blocks]) => (pos === text.length
    // At the end of the file: a blank line before, none after
    ? { from: pos, to: pos, insert: gapAtEnd(text) + blocks.join('\n') }
    : { from: pos, to: pos, insert: blocks.map((b) => `${b}\n`).join('') }));
}

/** `requirementChanges`: the changes inside the two sections, and the
 *  sections to add. */
function requirementEdits(
  text: string,
  { isHidden, sectionOf, headingAt, pendingIn }: ReturnType<typeof scanFile>,
  requires: readonly string[],
  helpful: readonly string[],
): { changes: TextChange[]; newSections: NewSections } | { error: string } {
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
  const newSections: NewSections = new Map();

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

  return { changes, newSections };
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

/** A question to add to an idea, as the form holds it. `other` are its
 *  further fields (`max-words`, `multi`, `force-feedback`, …); left out, a
 *  new choice question gets `shuffle:: true`. */
export type NewQuestion =
  | { type: 'Open'; content: string; assessment?: string; feedback?: string; other?: QuestionField[] }
  | { type: 'Choice'; content: string; options: { text: string; correct: boolean }[]; explanation?: string; other?: QuestionField[] };

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 6;

/** Further fields the platform knows, to offer in the form (any name can be typed). */
export const QUESTION_SETTINGS: Record<NewQuestion['type'], ReadonlyArray<{ name: string; hint: string }>> = {
  Open: [
    { name: 'max-words', hint: 'Longest answer, in words' },
    { name: 'force-feedback', hint: 'When the tutor answers unasked: true, first, or below 60' },
    { name: 'example-answer', hint: 'Shown after the learner answered' },
    { name: 'placeholder', hint: 'Grey text in the empty answer box' },
    { name: 'optional', hint: 'true: may be skipped' },
    { name: 'enforce-voice', hint: 'true: answered by voice' },
  ],
  Choice: [
    { name: 'multi', hint: 'true: several options may be ticked' },
    { name: 'shuffle', hint: 'true: options in a mixed order' },
    { name: 'max-select', hint: 'Most options a learner may tick' },
    { name: 'feedback-instructions', hint: 'How the tutor should respond' },
    { name: 'force-feedback', hint: 'When the tutor answers unasked: true or first' },
    { name: 'optional', hint: 'true: may be skipped' },
  ],
};

export const PENDING_QUESTIONS_ERROR =
  'The questions of this file have pending suggestions. Open the file and accept or reject them first.';
export const PENDING_QUESTION_ERROR =
  'This question has a pending suggestion or a comment in it. Open the file and accept, reject or remove it first.';
export const QUESTION_MOVED_ERROR =
  'This question was changed in the file meanwhile. Close this form and open it again.';
const FILE_ONLY_QUESTION_ERROR = 'This kind of question is edited in the file.';

/** A line that would start a heading or a field of its own inside a value. */
const BREAKS_VALUE = /^\s*(?:#|\w[\w-]*::)/m;

/** A value as it is written: line breaks kept, no blank lines around it, no
 *  spaces at line ends. */
const cleanValue = (value: string | null | undefined) =>
  (value ?? '').replace(/\r\n?/g, '\n').split('\n').map((line) => line.trimEnd()).join('\n').trim();

const valueProblem = (label: string, value: string) =>
  (BREAKS_VALUE.test(value) ? `${label} cannot have a line that starts with # or with a field name like "name::".` : null);

function optionsProblem(options: readonly { text: string; correct: boolean }[]): string | null {
  for (const option of options) {
    const problem = valueProblem('An option', option.text);
    if (problem) return problem;
  }
  if (options.length < MIN_OPTIONS) return `A choice question needs at least ${MIN_OPTIONS} options.`;
  if (options.length > MAX_OPTIONS) return `A choice question has at most ${MAX_OPTIONS} options.`;
  if (options.some((option) => !option.text.trim())) return 'Fill in every option, or remove the empty ones.';
  if (!options.some((option) => option.correct)) return 'Tick at least one right answer.';
  return null;
}

/** The text fields the form holds besides the question itself, in the order
 *  they are written, with what an error calls them. */
function textFields(question: NewQuestion): Array<{ name: string; label: string; value: string }> {
  return question.type === 'Open'
    ? [
      { name: 'assessment-instructions', label: 'The grading text', value: cleanValue(question.assessment) },
      { name: 'feedback-instructions', label: 'The tutor text', value: cleanValue(question.feedback) },
    ]
    : [{ name: 'explanation', label: 'The explanation', value: cleanValue(question.explanation) }];
}

/** The names the form has its own boxes for (and the id, which never changes). */
const boxNames = (question: NewQuestion) =>
  ['id', 'content', ...(question.type === 'Choice' ? ['options'] : []), ...textFields(question).map((field) => field.name)];

/**
 * The further fields of a question as they are written. A choice question
 * with several right answers needs `multi:: true` (the platform refuses it
 * otherwise): `several` adds it.
 */
function otherFields(question: NewQuestion, several = false): QuestionField[] {
  const fields = (question.other ?? (question.type === 'Choice' ? [{ name: 'shuffle', value: 'true' }] : []))
    .map(({ name, value }) => ({ name: name.trim(), value: cleanValue(value) }));
  if (!several || question.type !== 'Choice' || question.options.filter((option) => option.correct).length < 2) return fields;
  const multi = fields.find((field) => field.name === 'multi');
  if (!multi) return [...fields, { name: 'multi', value: 'true' }];
  return fields.map((field) => (field === multi ? { ...field, value: 'true' } : field));
}

/** Why these further fields cannot be written, or null. `known` are the
 *  names the question already has among them. */
function otherProblem(question: NewQuestion, fields: readonly QuestionField[], known: readonly string[] = []): string | null {
  const seen = new Set<string>();
  for (const { name, value } of fields) {
    if (seen.has(name)) return `The setting "${name}" is there twice.`;
    seen.add(name);
    if (!known.includes(name)) {
      if (!/^\w[\w-]*$/.test(name)) return name ? `"${name}" cannot be the name of a setting: letters, digits and - only.` : 'Give the new setting a name.';
      if (boxNames(question).includes(name)) return `"${name}" has its own box in this form.`;
    }
    const problem = valueProblem(`The setting "${name}"`, value);
    if (problem) return problem;
  }
  return null;
}

/**
 * Why `question` cannot be added, or null. A value may have several lines,
 * but none that starts a heading or another field.
 */
export function newQuestionProblem(question: NewQuestion): string | null {
  if (!question.content.trim()) return 'Write the question.';
  const values = [{ label: 'The question', value: question.content }, ...textFields(question)];
  for (const { label, value } of values) {
    const problem = valueProblem(label, value);
    if (problem) return problem;
  }
  const problem = question.type === 'Choice' ? optionsProblem(question.options) : null;
  return problem ?? otherProblem(question, otherFields(question));
}

/** The lines of a field: a value of one line beside its name, one of several
 *  lines under it (as is one in quotes, which would lose them beside it). */
function fieldLines(name: string, value: string): string[] {
  const inline = !value.includes('\n') && !(value.startsWith('"') && value.endsWith('"'));
  return inline ? [`${name}:: ${value}`] : [`${name}::`, ...value.split('\n')];
}

/** Right answers ticked, the others plain: the platform refuses `- [ ]`. */
const optionLines = (options: readonly { text: string; correct: boolean }[]) =>
  ['options::', ...options.map((option) => `- ${option.correct ? '[x] ' : ''}${oneParagraph(option.text)}`)];

/**
 * The text of a question segment (standard Lens syntax, always typed), ending
 * in a line break. Fields that are empty are left out.
 */
export function renderQuestion(question: NewQuestion & { id: string }): string {
  const lines = [`#### Question: ${question.type}`, `id:: ${question.id}`, ...fieldLines('content', cleanValue(question.content))];
  if (question.type === 'Choice') lines.push(...optionLines(question.options));
  for (const { name, value } of [...otherFields(question, true), ...textFields(question)]) {
    if (value) lines.push(...fieldLines(name, value));
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

/**
 * A question as the form holds it, to edit it there; null for one the form
 * cannot edit: any type but Open and Choice, and a Choice whose options the
 * form cannot show. Every field of the question but its `id` is in it: the
 * ones without a box of their own under `other`.
 */
export function questionAsNew(question: IdeaQuestion): NewQuestion | null {
  const type = question.type.toLowerCase();
  const field = (name: string, value: string | null) => (value === null ? [] : [{ name, value }]);
  const others = question.other.map((other) => ({ ...other }));
  if (type === 'open') {
    return {
      type: 'Open',
      content: question.content,
      assessment: question.assessment ?? '',
      feedback: question.feedback ?? '',
      other: [...field('explanation', question.explanation), ...others],
    };
  }
  if (type === 'choice' && question.options && question.options.length >= MIN_OPTIONS) {
    return {
      type: 'Choice',
      content: question.content,
      options: question.options.map((option) => ({ ...option })),
      explanation: question.explanation ?? '',
      other: [
        ...field('assessment-instructions', question.assessment),
        ...field('feedback-instructions', question.feedback),
        ...others,
      ],
    };
  }
  return null;
}

type Options = readonly { text: string; correct: boolean }[] | null;
const sameOptions = (a: Options, b: Options) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((option, i) => option.text.trim() === b[i].text.trim() && option.correct === b[i].correct));
const sameQuestion = (a: IdeaQuestion, b: IdeaQuestion) =>
  a.type === b.type && a.id === b.id && a.content === b.content && a.assessment === b.assessment
  && a.feedback === b.feedback && a.explanation === b.explanation && sameOptions(a.options, b.options)
  && a.other.length === b.other.length && a.other.every((field, i) => field.name === b.other[i].name && field.value === b.other[i].value);

const SEGMENT_HEADING = /^#{1,4}\s+(.+)$/;

/** The question segments among the lines under `## Questions`, in order:
 *  each with its heading line and the lines up to the next heading. */
function questionSegments(body: readonly Line[], isHidden: (pos: number) => boolean) {
  const segments: Array<{ type: string; heading: Line; lines: Line[] }> = [];
  let current: (typeof segments)[number] | null = null;
  for (const line of body) {
    const title = isHidden(line.from) ? undefined : SEGMENT_HEADING.exec(line.text)?.[1];
    if (title === undefined) {
      current?.lines.push(line);
      continue;
    }
    const question = QUESTION_TITLE.exec(title.trim().replace(/:$/, '').trim());
    current = question ? { type: (question[1] ?? '').trim(), heading: line, lines: [] } : null;
    if (current) segments.push(current);
  }
  return segments;
}

/** Where a line's text ends, before its line break. */
const lineEnd = (line: Line) => line.from + line.text.length;

/**
 * The question at place `index` of `text`, when it still is `before` (the
 * question a form or a confirm step was opened with) and holds no pending
 * suggestion and no comment; else the error to show.
 */
function findQuestion(text: string, index: number, before: IdeaQuestion) {
  const { isHidden, sectionOf, pendingIn, markedIn } = scanFile(text);
  const section = sectionOf('questions');
  // A suggestion can hide which question is meant: a suggested heading is not one yet
  const moved = { error: section && pendingIn(section.from, section.to) ? PENDING_QUESTIONS_ERROR : QUESTION_MOVED_ERROR };
  const segments = section ? questionSegments(section.body, isHidden) : [];
  const segment = segments[index];
  if (!section || !segment) return moved;

  // Blank lines and a comment after the question are not part of it
  const lines = [...segment.lines];
  while (lines.length > 0 && (lines[lines.length - 1].text.trim() === '' || isHidden(lines[lines.length - 1].from))) lines.pop();
  if (markedIn(segment.heading.from, (lines.at(-1) ?? segment.heading).to)) return { error: PENDING_QUESTION_ERROR };

  const texts = lines.map((line) => line.text);
  const live = readQuestion(segment.type, texts);
  if (!sameQuestion(live, before)) return moved;
  return { section, segment, lines, live, fields: fieldsOf(texts), last: index === segments.length - 1 };
}

/**
 * The changes that make the question at place `index` of `text` (a file as
 * stored) say what the form says (`after`), given the question the form was
 * opened with (`before`). Only the fields the user changed are written: a
 * changed one in its place, an emptied or removed one loses its lines, a new
 * one goes after the last field of its kind (the form's own boxes: `content`,
 * `assessment-instructions` and `feedback-instructions` for Open, `options`
 * and `explanation` for Choice; then the further ones, at the end). The
 * heading, the `id::`, every unchanged field and the rest of the file are
 * never touched, and an unchanged field is not held to the rules for new text.
 *
 * Refuses when the question at that place is no longer `before` (someone
 * edited meanwhile), and while it holds a pending suggestion or a comment.
 */
export function questionEditChanges(text: string, index: number, before: IdeaQuestion, after: NewQuestion): Changes {
  const found = findQuestion(text, index, before);
  if ('error' in found) return found;
  const { segment, lines, live, fields } = found;
  const form = questionAsNew(live);
  if (!form || form.type !== after.type) return { error: FILE_ONLY_QUESTION_ERROR };

  const boxes = boxNames(after).slice(1);
  const liveOther = otherFields(form);
  const optionsChanged = after.type === 'Choice' && !sameOptions(live.options, after.options);
  const wantedOther = otherFields(after, optionsChanged);
  const known = liveOther.map((field) => field.name);
  const twice = [...boxes, ...known].find((name) => fields.filter((field) => field.name === name).length > 1);
  if (twice) return { error: `This question has "${twice}::" twice. Edit it in the file.` };
  const taken = wantedOther.find(({ name }) => !known.includes(name) && fields.some((field) => field.name === name));
  if (taken) return { error: `This question has "${taken.name}::" already. Edit it in the file.` };

  const place = (name: string) => fields.findIndex((field) => field.name === name);
  /** What becomes of a field of the file: new lines, or null when it goes. */
  const rewritten = new Map<number, string[] | null>();
  /** Lines to add after a field of the file (-1: after the heading). */
  const added = new Map<number, string[]>();
  const boxAnchor = Math.max(-1, ...boxes.map(place), ...(boxes.some((name) => place(name) !== -1) ? [] : [fields.map((field) => field.name).lastIndexOf('id')]));
  const set = (name: string, newLines: string[] | null, anchor: number) => {
    const at = place(name);
    if (at !== -1) rewritten.set(at, newLines);
    else if (newLines) added.set(anchor, [...(added.get(anchor) ?? []), ...newLines]);
  };

  const content = cleanValue(after.content);
  if (content !== cleanValue(live.content)) {
    const problem = content ? valueProblem('The question', content) : 'Write the question.';
    if (problem) return { error: problem };
    set('content', fieldLines('content', content), boxAnchor);
  }
  if (after.type === 'Choice' && optionsChanged) {
    const problem = optionsProblem(after.options);
    if (problem) return { error: problem };
    set('options', optionLines(after.options), boxAnchor);
  }
  for (const { name, label, value } of textFields(after)) {
    if (value === cleanValue(fields[place(name)]?.value)) continue;
    const problem = valueProblem(label, value);
    if (problem) return { error: problem };
    set(name, value ? fieldLines(name, value) : null, boxAnchor);
  }

  const changedOther = wantedOther.filter(({ name, value }) => value !== liveOther.find((field) => field.name === name)?.value);
  const problem = otherProblem(after, changedOther, known)
    ?? otherProblem(after, wantedOther.map(({ name }) => ({ name, value: '' })), known);
  if (problem) return { error: problem };
  for (const { name } of liveOther) {
    if (!wantedOther.some((field) => field.name === name)) set(name, null, -1);
  }
  for (const { name, value } of changedOther) set(name, value ? fieldLines(name, value) : null, fields.length - 1);

  const changes: TextChange[] = [];
  for (const [anchor, newLines] of added) {
    if (rewritten.has(anchor)) {
      // In the place of a field that goes, or straight after its new lines
      rewritten.set(anchor, [...(rewritten.get(anchor) ?? []), ...newLines]);
      continue;
    }
    const at = lineEnd(anchor === -1 ? segment.heading : lines[fields[anchor].end - 1]);
    changes.push({ from: at, to: at, insert: `\n${newLines.join('\n')}` });
  }
  for (const [at, newLines] of rewritten) {
    const from = lines[fields[at].start].from;
    const last = lines[fields[at].end - 1];
    changes.push(newLines ? { from, to: lineEnd(last), insert: newLines.join('\n') } : { from, to: last.to, insert: '' });
  }
  return { changes: mergeChanges(changes) };
}

/**
 * The change that takes the question at place `index` out of `text` (a file
 * as stored), with the blank line that set it apart; `before` is the question
 * the user was shown. Same refusals as `questionEditChanges`.
 */
export function questionDeleteChanges(text: string, index: number, before: IdeaQuestion): Changes {
  const found = findQuestion(text, index, before);
  if ('error' in found) return found;
  const { section, segment, lines } = found;
  let from = segment.heading.from;
  let to = (lines.at(-1) ?? segment.heading).to;
  const rest = segment.lines.slice(lines.length);
  const blank = rest.findIndex((line) => line.text.trim() !== '');
  if (blank !== -1 || !found.last) {
    // Something follows in the section: the blank lines after the question go with it
    for (const line of blank === -1 ? rest : rest.slice(0, blank)) to = line.to;
  } else {
    // The last one: the blank lines before it go, those before the next section stay
    for (let at = section.body.indexOf(segment.heading) - 1; at >= 0 && section.body[at].text.trim() === ''; at--) from = section.body[at].from;
  }
  return { changes: [{ from, to, insert: '' }] };
}

// ---------------------------------------------------------------------------
// Editing, renaming and deleting an idea
// ---------------------------------------------------------------------------

/** Everything of an idea the form holds (its questions have their own form). */
export interface IdeaEdit {
  name: string;
  priority: Priority;
  /** Link targets of the frontmatter `courses`. */
  courses: string[];
  outcome: string;
  why: string;
  /** The text under `## Learn`, as written: a line per lens. */
  learn: string;
  /** Names of the ideas that must come first. */
  requires: string[];
  helpful: string[];
}

export const IDEA_MOVED_ERROR =
  'This concept was changed in the file meanwhile. Close this form and open it again.';
const UNSAFE_IDEA_ERROR = 'This file is written in a way the form cannot change safely. Edit it in the file.';
const pendingPartError = (part: string) =>
  `${part} of this file has a pending suggestion or a comment in it. Open the file and accept, reject or remove it first.`;

/** An idea as the form holds it. */
export function ideaAsEdit(name: string, idea: ParsedIdea): IdeaEdit {
  const required = new Set(idea.requires.map(ideaKey));
  return {
    name,
    priority: idea.priority,
    courses: [...idea.courses],
    outcome: idea.outcome,
    why: idea.why,
    learn: idea.learnText,
    requires: [...idea.requires],
    helpful: idea.helpful.filter((other) => !required.has(ideaKey(other))),
  };
}

/** Why these values cannot be written to an idea file, or null (the name has
 *  its own check, `ideaNameProblem`). */
export function ideaEditProblem(edit: Partial<Pick<IdeaEdit, 'courses' | 'outcome' | 'why' | 'learn'>>): string | null {
  const texts = [['The outcome', edit.outcome], ['Why it matters', edit.why], ['Learn', edit.learn]] as const;
  for (const [label, value] of texts) {
    if (/^#{1,2}(?!#)/m.test(cleanValue(value))) return `${label} cannot have a line that starts with # or ##: that starts a new part of the file.`;
  }
  if (cleanCourses(edit.courses ?? []).some((course) => /["[\]|\n]/.test(course))) return 'A course link cannot contain " [ ] or |.';
  return null;
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, i) => value === b[i]);
const sameIdeas = (a: readonly string[], b: readonly string[]) => sameList(a.map(ideaKey), b.map(ideaKey));

/**
 * The changes that make `text` (an idea file as stored) say what the form
 * says (`after`), given what the form was opened with (`before`). Only the
 * parts the user changed are written: the frontmatter `priority` and
 * `courses`, the outcome paragraph, the text under `## Why it matters` and
 * `## Learn`, and the link lines of `## Requires` and `## Helpful first` (as
 * `requirementChanges` does). A part that was not there is added in the
 * format's order; an emptied section keeps its heading (an empty section is
 * fine in the format), emptied `courses` lose their key. The `id`, the
 * questions, unknown sections and all the rest stay byte for byte. The name
 * is not in the text: a new one is a rename of the file.
 *
 * Refuses when the file no longer says `before` (someone edited meanwhile),
 * while a part to change holds a pending suggestion or a comment, and when
 * the file would not read back as the form says.
 */
export function ideaEditChanges(text: string, before: IdeaEdit, after: IdeaEdit): Changes {
  const scan = scanFile(text);
  const { lines, frontmatterEnd, firstHeading } = scan;
  const live = ideaAsEdit('', parseIdea(text));
  if (
    live.priority !== before.priority || !sameList(live.courses, before.courses) || live.outcome !== before.outcome
    || live.why !== before.why || live.learn !== before.learn
    || !sameIdeas(live.requires, before.requires) || !sameIdeas(live.helpful, before.helpful)
  ) return { error: IDEA_MOVED_ERROR };

  const want = {
    priority: after.priority,
    courses: cleanCourses(after.courses),
    outcome: cleanValue(after.outcome),
    why: cleanValue(after.why),
    learn: cleanValue(after.learn),
  };
  const changed = {
    priority: want.priority !== live.priority,
    courses: !sameList(want.courses, live.courses),
    outcome: want.outcome !== cleanValue(live.outcome),
    why: want.why !== cleanValue(live.why),
    learn: want.learn !== cleanValue(live.learn),
    picks: !sameIdeas(after.requires, live.requires) || !sameIdeas(after.helpful, live.helpful),
  };
  const problem = ideaEditProblem({
    ...(changed.courses ? { courses: want.courses } : {}),
    ...(changed.outcome ? { outcome: want.outcome } : {}),
    ...(changed.why ? { why: want.why } : {}),
    ...(changed.learn ? { learn: want.learn } : {}),
  });
  if (problem) return { error: problem };

  const changes: TextChange[] = [];
  /** A line break first, for what goes after a last line that has none. */
  const lead = (pos: number) => (pos === text.length && text.length > 0 && !text.endsWith('\n') ? '\n' : '');

  // The frontmatter: one key each, with the lines of its list
  const front = lines.filter((line) => line.from < frontmatterEnd);
  const keys = front.slice(1, -1);
  const keyLines = (key: string) => {
    const at = keys.findIndex((line) => new RegExp(`^${key}\\s*:`).test(line.text));
    if (at === -1) return null;
    let end = at + 1;
    while (end < keys.length && /^(?:\s+\S|-(?:\s|$))/.test(keys[end].text)) end++;
    return { first: keys[at], last: keys[end - 1] };
  };
  const frontChanges: Array<{ key: string; newLines: string[]; at: () => number }> = [];
  if (changed.priority) {
    frontChanges.push({ key: 'priority', newLines: [`priority: ${want.priority}`], at: () => (keyLines('id')?.last ?? front[0]).to });
  }
  if (changed.courses) {
    frontChanges.push({ key: 'courses', newLines: want.courses.length > 0 ? courseLines(want.courses) : [], at: () => front[front.length - 1].from });
  }
  if (front.length === 0) {
    const block = frontChanges.flatMap(({ newLines }) => newLines);
    if (block.length > 0) changes.push({ from: 0, to: 0, insert: `---\n${block.join('\n')}\n---\n` });
  } else {
    for (const { key, newLines, at } of frontChanges) {
      const found = keyLines(key);
      if (found && scan.markedIn(found.first.from, found.last.to)) return { error: pendingPartError('The frontmatter') };
      if (found) {
        changes.push(newLines.length > 0
          ? { from: found.first.from, to: lineEnd(found.last), insert: newLines.join('\n') }
          : { from: found.first.from, to: found.last.to, insert: '' });
      } else if (newLines.length > 0) {
        changes.push({ from: at(), to: at(), insert: `${newLines.join('\n')}\n` });
      }
    }
  }

  /** Make the lines of `body` that say something read `wanted`; with none,
   *  it goes to `pos`. The blank lines and comments around them stay. */
  const setText = (body: readonly Line[], pos: number, wanted: string, part: string): string | null => {
    const skip = (line: Line) => line.text.trim() === '' || scan.isHidden(line.from);
    let start = 0;
    let end = body.length;
    while (start < end && skip(body[start])) start++;
    while (end > start && skip(body[end - 1])) end--;
    if (start === end) {
      // A blank line before what follows
      const next = lines.find((line) => line.from >= pos);
      if (wanted) changes.push({ from: pos, to: pos, insert: `${lead(pos)}${wanted}\n${next && next.text.trim() !== '' ? '\n' : ''}` });
      return null;
    }
    const first = body[start];
    const last = body[end - 1];
    if (scan.markedIn(first.from, last.to)) return pendingPartError(part);
    changes.push(wanted ? { from: first.from, to: lineEnd(last), insert: wanted } : { from: first.from, to: last.to, insert: '' });
    return null;
  };

  if (changed.outcome) {
    const body = lines.filter((line) => line.from >= frontmatterEnd && (!firstHeading || line.from < firstHeading.from));
    const failed = setText(body, frontmatterEnd, want.outcome, 'The outcome');
    if (failed) return { error: failed };
  }

  let newSections: NewSections = new Map();
  if (changed.picks) {
    const edits = requirementEdits(text, scan, after.requires, after.helpful);
    if ('error' in edits) return edits;
    changes.push(...edits.changes);
    newSections = edits.newSections;
  }
  const sections = [
    { name: 'why it matters' as const, title: 'Why it matters', wanted: want.why, isChanged: changed.why, later: SECTIONS.slice(3) },
    { name: 'learn' as const, title: 'Learn', wanted: want.learn, isChanged: changed.learn, later: SECTIONS.slice(4) },
  ];
  for (const { name, title, wanted, isChanged, later } of sections) {
    if (!isChanged) continue;
    const section = scan.sectionOf(name);
    if (section) {
      const failed = setText(section.body, section.heading.to, wanted, `"${title}"`);
      if (failed) return { error: failed };
    } else if (wanted) {
      const pos = scan.headingAt(later) ?? text.length;
      newSections.set(pos, [...(newSections.get(pos) ?? []), `## ${title}\n${wanted}\n`]);
    }
  }
  changes.push(...sectionInserts(text, newSections));

  const merged = mergeChanges(changes);
  if (merged.length === 0) return { changes: [] };
  // Read it back: a file written in an unusual way must not be damaged
  const result = ideaAsEdit('', parseIdea(applyChanges(text, merged)));
  const keySet = (names: readonly string[]) => [...new Set(names.map(ideaKey))].sort();
  const required = new Set(after.requires.map(ideaKey));
  const reads = result.priority === want.priority && sameList(result.courses, want.courses)
    && cleanValue(result.outcome) === want.outcome && cleanValue(result.why) === want.why && cleanValue(result.learn) === want.learn
    && sameList(keySet(result.requires), keySet(after.requires))
    && sameList(keySet(result.helpful), keySet(after.helpful.filter((name) => !required.has(ideaKey(name)))));
  return reads ? { changes: merged } : { error: UNSAFE_IDEA_ERROR };
}

/** The links to the idea `name` under `## Requires` and `## Helpful first`
 *  of a scanned file, comments left out. */
function requirementLinks(scan: ReturnType<typeof scanFile>, name: string) {
  const key = ideaKey(name);
  return (['requires', 'helpful first'] as const).flatMap((section) => (scan.sectionOf(section)?.body ?? []).flatMap((line) =>
    [...line.text.matchAll(WIKILINK)]
      .map((match) => ({ from: line.from + match.index, to: line.from + match.index + match[0].length, target: match[1].split('#')[0] }))
      .filter((link) => !scan.isHidden(link.from) && ideaKey(linkName(link.target)) === key)));
}

/**
 * The changes that make `text` (another idea's file, as stored) link to
 * `newName` wherever its `## Requires` and `## Helpful first` link to
 * `oldName`: only the name inside the link changes (a path before it, a
 * `#heading` and the words shown stay). No link, no changes. Refuses while
 * such a link is inside a pending suggestion.
 */
export function renameLinkChanges(text: string, oldName: string, newName: string): Changes {
  const scan = scanFile(text);
  const changes: TextChange[] = [];
  for (const link of requirementLinks(scan, oldName)) {
    if (scan.pendingIn(link.from, link.to)) return { error: PENDING_REQUIREMENTS_ERROR };
    const file = link.target.slice(link.target.lastIndexOf('/') + 1);
    const [, space, name] = /^(\s*)(.*?)(?:\.md)?\s*$/i.exec(file)!;
    const from = link.from + 2 + (link.target.length - file.length) + space.length;
    changes.push({ from, to: from + name.length, insert: newName.trim() });
  }
  return { changes };
}

/**
 * The changes that take every link to the ideas `names` out of the
 * `## Requires` and `## Helpful first` of `text` (another idea's file, as
 * stored), for when those ideas are deleted: a line goes, or just the link on
 * a line that says more. No link, no changes. Refuses while one of the two
 * sections it changes holds a pending suggestion.
 */
export function removeLinksChanges(text: string, names: readonly string[]): Changes {
  const scan = scanFile(text);
  if (!names.some((name) => requirementLinks(scan, name).length > 0)) return { changes: [] };
  const gone = new Set(names.map(ideaKey));
  const live = parseIdea(text);
  const others = (list: readonly string[]) => list.filter((other) => !gone.has(ideaKey(other)));
  return requirementChanges(text, others(live.requires), others(live.helpful));
}

/** `removeLinksChanges` for one idea. */
export function removeLinkChanges(text: string, name: string): Changes {
  return removeLinksChanges(text, [name]);
}

/** What deleting a set of ideas does to the map. */
export interface DeletePlan {
  /** The ideas of the set that have a file: their files go. */
  files: IdeaNode[];
  /** The ideas of the set that are "not written yet": only the links to them go. */
  unwritten: IdeaNode[];
  /**
   * The files that stay and lose links: every idea outside the set that
   * names one of the set under Requires or Helpful first, with the names it
   * loses. A link between two ideas of the set needs no change: the file
   * that holds it goes.
   */
  losing: Array<{ node: IdeaNode; names: string[] }>;
  /** How many questions the files that go hold. */
  questions: number;
  /** "Not written yet" ideas outside the set that only files of the set
   *  name: they leave the map with them. */
  orphaned: IdeaNode[];
}

/** What deleting the ideas `keys` does (keys the graph does not have are left out). */
export function deletePlan(graph: IdeaGraph, keys: readonly string[]): DeletePlan {
  const set = new Set(keys.map(ideaKey).filter((key) => graph.byKey.has(key)));
  const chosen = graph.nodes.filter((node) => set.has(node.key));
  const files = chosen.filter((node) => node.docId !== null);
  const going = new Set(files.map((node) => node.key));
  const losing = graph.nodes
    .filter((node) => node.docId !== null && !set.has(node.key))
    .map((node) => ({ node, names: [...new Set([...node.requires, ...node.helpful])].filter((key) => set.has(key)).map((key) => graph.byKey.get(key)!.name) }))
    .filter((entry) => entry.names.length > 0);
  const orphaned = graph.nodes.filter((node) => {
    if (node.docId !== null || set.has(node.key)) return false;
    const namedBy = [...node.neededFor, ...node.helpfulFor];
    return namedBy.length > 0 && namedBy.every((key) => going.has(key));
  });
  return {
    files,
    unwritten: chosen.filter((node) => node.docId === null),
    losing,
    questions: files.reduce((sum, node) => sum + (node.idea?.questionList.length ?? 0), 0),
    orphaned,
  };
}

/**
 * The changes a `DeletePlan` makes to the files that stay, worked out from
 * their texts (`textOf`; a file with no text at hand is left out and checked
 * when it is written). An error names the file that cannot be changed
 * safely: then nothing should be deleted.
 */
export function deletePlanChanges(
  plan: DeletePlan,
  textOf: (node: IdeaNode) => string | null | undefined,
): { edits: Array<{ node: IdeaNode; changes: TextChange[] }> } | { error: string } {
  const edits: Array<{ node: IdeaNode; changes: TextChange[] }> = [];
  for (const { node, names } of plan.losing) {
    const text = textOf(node);
    if (text == null) continue;
    const result = removeLinksChanges(text, names);
    if ('error' in result) return { error: `In "${node.name}": ${result.error}` };
    if (result.changes.length > 0) edits.push({ node, changes: result.changes });
  }
  return { edits };
}

const PROFILE_FORBIDDEN = /[\\/:*?"<>|]/;
const MAX_PROFILE_NAME = 60;

/**
 * Why `name` cannot be the name of a profile (a separate set of concepts),
 * or null. `existing` are the names of the other profiles.
 */
export function profileNameProblem(name: string, existing: Iterable<string>): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Give the profile a name.';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return 'A name cannot contain control characters.';
  const forbidden = PROFILE_FORBIDDEN.exec(trimmed);
  if (forbidden) return `A name cannot contain ${forbidden[0]}`;
  if (/^[_.]/.test(trimmed)) return 'A name cannot start with _ or a dot.';
  if (trimmed.length > MAX_PROFILE_NAME) return `A name can be ${MAX_PROFILE_NAME} characters at most.`;
  const key = trimmed.toLowerCase();
  for (const other of existing) {
    if (other.trim().toLowerCase() === key) return 'A profile with this name already exists.';
  }
  return null;
}
