/**
 * Pure planning and text transforms for scripts/migrate-topics-to-concepts.ts.
 *
 * Nothing here touches the network or the file system: the CLI builds a
 * `Snapshot` (from a relay or from a directory), `planMigration` turns it into
 * moves, frontmatter edits and problems, and the transforms map one file's
 * text to its migrated text. Paths are in-folder paths ("/Concepts/X.md").
 */

import YAML from 'yaml';
import { resolvePageName } from '../../src/lib/document-resolver';

type FolderMetadata = Parameters<typeof resolvePageName>[1];

export const DOMAINS_DIR = '/Domains and Topics/';
export const LO_DIR = '/Learning Outcomes/';
export const CONCEPTS_DIR = '/Concepts/';
export const TEMPLATE_PATH = '/AI Guide/Writing (Learning) Outcomes 2.md';
export const PLACEHOLDER_TAG = 'skill-tree-placeholder';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A file that does not have the shape the migration expects. */
export class TransformError extends Error {}

// ---------------------------------------------------------------------------
// Frontmatter line model
// ---------------------------------------------------------------------------

/**
 * Lines of a document split on "\n"; a CRLF line keeps its "\r", so joining
 * with "\n" gives back the exact original text.
 */
function splitRaw(content: string): string[] {
  return content.split('\n');
}

const strip = (line: string) => (line.endsWith('\r') ? line.slice(0, -1) : line);

interface Field {
  key: string;
  /** Index (in all lines) of the `key:` line. */
  start: number;
  /** Exclusive end index: the key line plus its continuation lines. */
  end: number;
  /** Text after `key:` on the key line, trimmed. */
  inline: string;
  /** Block list items (`- value`), unquoted-trimmed raw values, in order. */
  items: { index: number; raw: string }[];
}

interface Frontmatter {
  lines: string[];
  /** Index of the opening `---` (always 0) and of the closing `---`. */
  open: number;
  close: number;
  /** "\r" when the frontmatter uses CRLF line endings, else "". */
  cr: string;
  fields: Field[];
}

function parseFrontmatter(content: string): Frontmatter | null {
  const lines = splitRaw(content);
  if (lines.length === 0 || strip(lines[0]).trim() !== '---') return null;
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (strip(lines[i]).trim() === '---') { close = i; break; }
  }
  if (close === -1) return null;
  const cr = lines[0].endsWith('\r') ? '\r' : '';
  const fields: Field[] = [];
  for (let i = 1; i < close; i++) {
    const t = strip(lines[i]);
    const m = t.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (!m) {
      if (t.trim() === '' || t.trimStart().startsWith('#')) continue;
      // Continuation of the previous field (indented or block-list line).
      if (fields.length && (/^\s/.test(t) || t.startsWith('-'))) continue;
      throw new TransformError(`unexpected frontmatter line ${i + 1}: ${JSON.stringify(t)}`);
    }
    let end = i + 1;
    while (end < close) {
      const n = strip(lines[end]);
      if (/^\s/.test(n) || n.startsWith('-')) end++;
      else break;
    }
    const items: Field['items'] = [];
    for (let j = i + 1; j < end; j++) {
      const im = strip(lines[j]).match(/^\s*-\s*(.*)$/);
      if (im) items.push({ index: j, raw: im[1].trim() });
    }
    fields.push({ key: m[1], start: i, end, inline: m[2].trim(), items });
  }
  return { lines, open: 0, close, cr, fields };
}

function field(fm: Frontmatter, key: string): Field | undefined {
  return fm.fields.find((f) => f.key === key);
}

export function unquote(raw: string): string {
  const v = raw.trim();
  const m = v.match(/^(["'])(.*)\1$/);
  return m ? m[2] : v;
}

const CRITIC_RE = /\{(\+\+|--|~~|==|>>)/;

function assertNoCriticMarkup(fm: Frontmatter) {
  const text = fm.lines.slice(fm.open, fm.close + 1).join('\n');
  if (CRITIC_RE.test(text)) {
    throw new TransformError('frontmatter contains a pending CriticMarkup suggestion or comment; resolve it first');
  }
}

/** Values of a scalar-or-list field: inline scalar, inline flow list, or block list. */
function fieldValues(f: Field): string[] {
  if (f.inline === '' || f.inline === '|' || f.inline === '>') return f.items.map((i) => i.raw);
  const flow = f.inline.match(/^\[(.*)\]$/);
  // `[[x]]` unquoted is a wikilink, not a flow list.
  if (flow && !/^\[\[.*\]\]$/.test(f.inline)) {
    return flow[1].split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [f.inline];
}

/** Wikilink targets (page part, no alias/anchor) in a value, e.g. `"[[../A/B|x]]"` -> `../A/B`. */
export function wikilinkTargets(value: string): string[] {
  const out: string[] = [];
  for (const m of value.matchAll(/\[\[([^\]]+)\]\]/g)) {
    let c = m[1];
    const p = c.indexOf('|');
    if (p !== -1) c = c.slice(0, p);
    const h = c.indexOf('#');
    if (h !== -1) c = c.slice(0, h);
    c = c.trim();
    if (c) out.push(c);
  }
  return out;
}

/** Parsed `topic:` (or `concept:`/`parent:`) value: 'none', a list of raw values, or null when absent. */
export function linkField(content: string, key: string): 'none' | string[] | null {
  const fm = parseFrontmatter(content);
  if (!fm) return null;
  const f = field(fm, key);
  if (!f) return null;
  const values = fieldValues(f);
  if (values.length === 1 && unquote(values[0]) === 'none') return 'none';
  return values;
}

function tagValues(fm: Frontmatter): string[] {
  const f = field(fm, 'tags');
  if (!f) return [];
  return fieldValues(f).map(unquote);
}

/** Replace lines [start, end) with `replacement` lines (raw, without trailing "\r"). */
function splice(lines: string[], start: number, end: number, replacement: string[], cr: string): string[] {
  return [...lines.slice(0, start), ...replacement.map((l) => l + cr), ...lines.slice(end)];
}

/** Body text after the closing `---` line. */
function bodyOf(content: string): string {
  const fm = parseFrontmatter(content);
  if (!fm) return content;
  return fm.lines.slice(fm.close + 1).join('\n');
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

export function hasTest(content: string): boolean {
  return /^#{1,6}[ \t]*Test\b/m.test(bodyOf(content));
}

export function hasLenses(content: string): boolean {
  const body = bodyOf(content);
  return /Suggested Lenses/i.test(body) || /\[\[[^\]]*\bLenses\//.test(body);
}

export function isPlaceholderTagged(content: string): boolean {
  const fm = parseFrontmatter(content);
  return !!fm && tagValues(fm).includes(PLACEHOLDER_TAG);
}

// ---------------------------------------------------------------------------
// Boilerplate comments that no longer say anything true after the move
// ---------------------------------------------------------------------------

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const BOILERPLATE: RegExp[] = [
  /^%% Skill-tree topic\. Learning outcomes link here via `topic:` in their frontmatter; the backlinks list shows which ones\. %%$/,
  /^%% This file is intentionally empty\. It exists only to be linked to as a skill-tree domain\. The list of backlinks will show you the LOs that are currently part of this domain\. %%$/,
  /^%% This file holds the metadata for the "[^"]*" skill-tree domain\. Topics in this folder are the domain's topics; learning outcomes link to a topic via `topic:` in their frontmatter\. %%$/,
];

/** Drop the body when it is exactly one of the old skill-tree boilerplate comments. */
function dropBoilerplateBody(lines: string[], close: number): { lines: string[]; dropped: boolean } {
  const body = lines.slice(close + 1).join('\n');
  if (body.trim() && BOILERPLATE.some((re) => re.test(norm(body)))) {
    return { lines: [...lines.slice(0, close + 1), ''], dropped: true };
  }
  return { lines, dropped: false };
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

export interface TransformResult { content: string; notes: string[] }

function ensureFrontmatter(content: string): string {
  return parseFrontmatter(content) ? content : `---\n---\n${content}`;
}

/** Index after which new fields go: after `id:` if present, else right after the opening `---`. */
function insertionPoint(fm: Frontmatter): number {
  const id = field(fm, 'id');
  return id ? id.end : fm.open + 1;
}

/**
 * `_domain_metadata.md` -> `Concepts/<Domain>.md` frontmatter: `skill-tree: domain`,
 * `order: <N>`, no `domain-number:`; every other field and the body kept (the old
 * boilerplate comment is dropped).
 */
export function transformDomain(content: string, order: number): TransformResult {
  const notes: string[] = [];
  const fm0 = parseFrontmatter(ensureFrontmatter(content))!;
  if (!parseFrontmatter(content)) notes.push('added frontmatter');
  assertNoCriticMarkup(fm0);
  let fm = fm0;
  let lines = fm.lines;

  const st = field(fm, 'skill-tree');
  if (st && unquote(st.inline) !== 'domain') throw new TransformError(`skill-tree: is ${JSON.stringify(st.inline)}, expected domain`);
  const ord = field(fm, 'order');
  if (ord && Number(unquote(ord.inline)) !== order) throw new TransformError(`order: is ${ord.inline}, folder number is ${order}`);
  if (field(fm, 'parent')) throw new TransformError('a domain file already has parent:');

  const dn = field(fm, 'domain-number');
  if (dn) {
    if (Number(unquote(dn.inline)) !== order) notes.push(`domain-number ${dn.inline} differed from folder number ${order}`);
    lines = splice(lines, dn.start, dn.end, [], fm.cr);
    fm = parseFrontmatter(lines.join('\n'))!;
  }
  const add: string[] = [];
  if (!field(fm, 'skill-tree')) add.push('skill-tree: domain');
  if (!field(fm, 'order')) add.push(`order: ${order}`);
  if (add.length) {
    const at = insertionPoint(fm);
    lines = splice(fm.lines, at, at, add, fm.cr);
    fm = parseFrontmatter(lines.join('\n'))!;
  }
  const b = dropBoilerplateBody(fm.lines, fm.close);
  if (b.dropped) notes.push('dropped boilerplate comment');
  return { content: b.lines.join('\n'), notes };
}

/** Wikilink value for a sibling concept file: `"[[Name]]"`. */
export function conceptLink(name: string): string {
  return `"[[${name}]]"`;
}

/**
 * Topic file -> `Concepts/<Topic>.md` frontmatter: `skill-tree: topic` and
 * `parent:` = the domain; `id`, `order`, other fields and the body kept.
 */
export function transformTopic(content: string, domainName: string): TransformResult {
  const notes: string[] = [];
  const fm0 = parseFrontmatter(ensureFrontmatter(content))!;
  if (!parseFrontmatter(content)) notes.push('added frontmatter');
  assertNoCriticMarkup(fm0);
  let fm = fm0;
  const st = field(fm, 'skill-tree');
  if (st && unquote(st.inline) !== 'topic') throw new TransformError(`skill-tree: is ${JSON.stringify(st.inline)}, expected topic`);
  const parent = field(fm, 'parent');
  if (parent) {
    const vals = fieldValues(parent).map((v) => wikilinkTargets(v)[0]);
    if (vals.length !== 1 || vals[0] !== domainName) {
      throw new TransformError(`parent: is already set to something other than [[${domainName}]]`);
    }
  }
  if (!field(fm, 'id')) notes.push('topic has no id:');
  const add: string[] = [];
  if (!st) add.push('skill-tree: topic');
  if (!parent) add.push('parent:', `  - ${conceptLink(domainName)}`);
  let lines = fm.lines;
  if (add.length) {
    const at = insertionPoint(fm);
    lines = splice(fm.lines, at, at, add, fm.cr);
    fm = parseFrontmatter(lines.join('\n'))!;
  }
  const b = dropBoilerplateBody(fm.lines, fm.close);
  if (b.dropped) notes.push('dropped boilerplate comment');
  return { content: b.lines.join('\n'), notes };
}

/**
 * Placeholder learning outcome -> concept frontmatter: `topic:` becomes `parent:`
 * (same links, same order; `topic: none` -> no parent), and `learning-outcome:`,
 * `stage:` and the `skill-tree-placeholder` tag go. `id`, other tags/fields and
 * the body are kept. A file already in that shape is returned unchanged.
 */
export function transformPlaceholder(content: string): TransformResult {
  const notes: string[] = [];
  const fm = parseFrontmatter(content);
  if (!fm) throw new TransformError('no frontmatter');
  assertNoCriticMarkup(fm);
  let lines = fm.lines;

  const topic = field(fm, 'topic');
  if (topic && field(fm, 'parent')) throw new TransformError('has both topic: and parent:');
  if (field(fm, 'concept')) throw new TransformError('placeholder has a concept: field');

  // Work bottom-up so earlier indices stay valid: collect replacements first.
  const edits: { start: number; end: number; repl: string[] }[] = [];
  if (topic) {
    const values = fieldValues(topic);
    if (values.length === 0) throw new TransformError('empty topic:');
    if (values.length === 1 && unquote(values[0]) === 'none') {
      edits.push({ start: topic.start, end: topic.end, repl: [] });
      notes.push('topic: none -> no parent');
    } else {
      for (const v of values) {
        if (wikilinkTargets(v).length !== 1) throw new TransformError(`topic: value is not one wikilink: ${v}`);
      }
      if (topic.inline === '') {
        // Block list: rename the key, keep the items exactly.
        edits.push({ start: topic.start, end: topic.start + 1, repl: ['parent:'] });
      } else {
        edits.push({ start: topic.start, end: topic.end, repl: ['parent:', ...values.map((v) => `  - ${v}`)] });
      }
    }
  }
  const lo = field(fm, 'learning-outcome');
  if (lo) {
    if (unquote(lo.inline) !== '' || lo.end - lo.start > 1) notes.push(`dropped learning-outcome: ${lo.inline}`);
    edits.push({ start: lo.start, end: lo.end, repl: [] });
  }
  const stage = field(fm, 'stage');
  if (stage) edits.push({ start: stage.start, end: stage.end, repl: [] });

  const tags = field(fm, 'tags');
  if (tags) {
    const values = fieldValues(tags).map(unquote);
    if (values.includes(PLACEHOLDER_TAG)) {
      const rest = values.filter((v) => v !== PLACEHOLDER_TAG);
      if (rest.length === 0) {
        edits.push({ start: tags.start, end: tags.end, repl: [] });
      } else if (tags.inline === '') {
        for (const it of tags.items) {
          if (unquote(it.raw) === PLACEHOLDER_TAG) edits.push({ start: it.index, end: it.index + 1, repl: [] });
        }
      } else {
        edits.push({ start: tags.start, end: tags.end, repl: [`tags: [${rest.join(', ')}]`] });
      }
    }
  }
  edits.sort((a, b) => b.start - a.start);
  for (const e of edits) lines = splice(lines, e.start, e.end, e.repl, fm.cr);
  return { content: lines.join('\n'), notes };
}

/**
 * Existing concept file that absorbs a same-named placeholder: `id:` added when
 * it has none, `parent:` set to the placeholder's parents (bare names; both live
 * in Concepts/). Refuses a different existing `parent:` or `id:`.
 */
export function mergeIntoConcept(content: string, id: string | null, parentNames: string[]): TransformResult {
  const notes: string[] = [];
  const fm0 = parseFrontmatter(ensureFrontmatter(content))!;
  if (!parseFrontmatter(content)) notes.push('added frontmatter');
  assertNoCriticMarkup(fm0);
  let fm = fm0;
  const existingId = field(fm, 'id');
  if (existingId && id && unquote(existingId.inline) !== id) {
    throw new TransformError(`concept already has a different id: (${existingId.inline}); placeholder id ${id}`);
  }
  const parent = field(fm, 'parent');
  if (parent) {
    const have = fieldValues(parent).map((v) => wikilinkTargets(v)[0]);
    if (have.join('|') !== parentNames.join('|')) {
      throw new TransformError(`concept already has parent: ${have.join(', ')}; placeholder parents: ${parentNames.join(', ')}`);
    }
  }
  let lines = fm.lines;
  if (!existingId && id) {
    lines = splice(lines, fm.open + 1, fm.open + 1, [`id: ${id}`], fm.cr);
    fm = parseFrontmatter(lines.join('\n'))!;
    notes.push('id taken from the placeholder');
  }
  if (!parent && parentNames.length) {
    const at = insertionPoint(fm);
    lines = splice(fm.lines, at, at, ['parent:', ...parentNames.map((n) => `  - ${conceptLink(n)}`)], fm.cr);
  }
  return { content: lines.join('\n'), notes };
}

/** Real learning outcome: `topic:` -> `concept:` (links kept); `topic: none` -> field removed. */
export function transformLearningOutcome(content: string): TransformResult {
  const fm = parseFrontmatter(content);
  if (!fm) return { content, notes: [] };
  const topic = field(fm, 'topic');
  if (!topic) return { content, notes: [] };
  assertNoCriticMarkup(fm);
  if (field(fm, 'concept')) throw new TransformError('has both topic: and concept:');
  const values = fieldValues(topic);
  if (values.length === 0) throw new TransformError('empty topic:');
  if (values.length === 1 && unquote(values[0]) === 'none') {
    return { content: splice(fm.lines, topic.start, topic.end, [], fm.cr).join('\n'), notes: ['topic: none -> removed'] };
  }
  for (const v of values) {
    if (wikilinkTargets(v).length !== 1) throw new TransformError(`topic: value is not one wikilink: ${v}`);
  }
  const keyLine = strip(fm.lines[topic.start]).replace(/^topic:/, 'concept:');
  return { content: splice(fm.lines, topic.start, topic.start + 1, [keyLine], fm.cr).join('\n'), notes: [] };
}

/** The LO authoring template in AI Guide: `topic:` -> `concept:` with a Concepts/ link. */
export function transformTemplate(content: string): TransformResult {
  const lines = splitRaw(content);
  let changed = 0;
  const out = lines.map((raw) => {
    const cr = raw.endsWith('\r') ? '\r' : '';
    const t = strip(raw);
    let n = t;
    if (/^\s*topic:\s*"\[\[\.\.\/Domains[^"]*\]\]"\s*$/.test(t)) {
      n = t.replace(/topic:\s*"\[\[\.\.\/Domains[^"]*\]\]"/, 'concept: "[[../Concepts/<Concept>]]"');
    } else if (t.includes('`topic:`')) {
      n = t.replaceAll('`topic:`', '`concept:`');
    }
    if (n !== t) changed++;
    return n + cr;
  });
  return { content: out.join('\n'), notes: changed ? [`${changed} line(s)`] : [] };
}

/** Parse the result's frontmatter as YAML (throws TransformError if it doesn't parse). */
export function parseYamlFrontmatter(content: string): Record<string, unknown> {
  const fm = parseFrontmatter(content);
  if (!fm) return {};
  const text = fm.lines.slice(fm.open + 1, fm.close).map(strip).join('\n');
  try {
    const v = YAML.parse(text);
    return (v && typeof v === 'object') ? v as Record<string, unknown> : {};
  } catch (err) {
    throw new TransformError(`frontmatter is not valid YAML: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Minimal edit + diff
// ---------------------------------------------------------------------------

/** The single replace that turns `a` into `b`: common prefix/suffix trimmed. */
export function minimalEdit(a: string, b: string): { index: number; deleteCount: number; insert: string } | null {
  if (a === b) return null;
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  return { index: p, deleteCount: a.length - p - s, insert: b.slice(p, b.length - s) };
}

/** A small unified-style line diff (LCS), enough for frontmatter-sized changes. */
export function lineDiff(path: string, a: string, b: string, context = 1): string {
  const A = a.split('\n').map(strip);
  const B = b.split('\n').map(strip);
  const n = A.length, m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const ops: { t: ' ' | '-' | '+'; s: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push({ t: ' ', s: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ t: '-', s: A[i++] });
    else ops.push({ t: '+', s: B[j++] });
  }
  while (i < n) ops.push({ t: '-', s: A[i++] });
  while (j < m) ops.push({ t: '+', s: B[j++] });
  const keep = ops.map((o, k) => o.t !== ' ' || ops.slice(Math.max(0, k - context), k + context + 1).some((x) => x.t !== ' '));
  const out = [`--- ${path}`, `+++ ${path}`];
  let gap = false;
  ops.forEach((o, k) => {
    if (keep[k]) { out.push(`${o.t}${o.s}`); gap = false; }
    else if (!gap) { out.push('  ...'); gap = true; }
  });
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface VaultEntry { path: string; id: string; type: string }

export interface Snapshot {
  /** Every filemeta entry of the folder (or every file of the directory). */
  entries: VaultEntry[];
  /** Text of the files the plan reads: Domains and Topics/**, Learning Outcomes/**, Concepts/*, the template. */
  contents: Map<string, string>;
}

export type ItemKind = 'domain' | 'topic' | 'placeholder' | 'drop-placeholder' | 'merge-placeholder' | 'lo' | 'template';

export interface Item {
  kind: ItemKind;
  path: string;
  id: string;
  /** Move destination (domain/topic/placeholder), undefined when the file stays. */
  target?: string;
  before: string;
  after: string;
  notes: string[];
  /** Resolved parents (in-folder paths, after migration) for placeholders/topics. */
  parents?: string[];
  /**
   * merge-placeholder: the existing concept file that receives the placeholder's
   * `id` and parents (`before`/`after` are that file's text); the placeholder is
   * trashed afterwards.
   */
  merge?: { conceptPath: string; conceptId: string; id: string | null; parentNames: string[] };
}

export interface Problem { path: string; reason: string }

export interface PlanOptions {
  /**
   * A placeholder whose name is taken by a domain/topic is trashed instead of
   * moved, when its only parent is that same-named file and it has no body
   * (the relay refuses to trash it while anything links to it).
   */
  dropRedundantPlaceholders?: boolean;
  /**
   * A placeholder whose name is taken by an existing file in Concepts/ is merged
   * into it: the concept gets the placeholder's `id` (if it has none) and its
   * parents as `parent:`, then the placeholder is trashed. Only when the
   * placeholder has no body and the concept has no conflicting `parent:`.
   */
  mergeIntoExistingConcepts?: boolean;
}

export interface Plan {
  items: Item[];
  problems: Problem[];
  warnings: Problem[];
  counts: {
    domains: number; topics: number; placeholders: number; dropPlaceholders: number;
    multiParentPlaceholders: number; noParentPlaceholders: number; droppedLoText: number;
    mergePlaceholders: number; los: number; losNone: number; losMulti: number; template: number;
    loNoTopic: number; loAlreadyConcept: number; taggedButReal: number;
  };
}

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const stem = (p: string) => basename(p).replace(/\.md$/i, '');

export function phaseOf(kind: ItemKind): number {
  return { domain: 1, topic: 2, placeholder: 3, 'drop-placeholder': 3, 'merge-placeholder': 3, lo: 4, template: 5 }[kind];
}

export function planMigration(snap: Snapshot, opts: PlanOptions = {}): Plan {
  const problems: Problem[] = [];
  const warnings: Problem[] = [];
  const items: Item[] = [];
  const counts: Plan['counts'] = {
    domains: 0, topics: 0, placeholders: 0, dropPlaceholders: 0, multiParentPlaceholders: 0,
    noParentPlaceholders: 0, droppedLoText: 0, mergePlaceholders: 0, los: 0, losNone: 0, losMulti: 0, template: 0,
    loNoTopic: 0, loAlreadyConcept: 0, taggedButReal: 0,
  };
  const meta: FolderMetadata = {};
  for (const e of snap.entries) meta[e.path] = { id: e.id, type: e.type as any, version: 0 };
  const byPath = new Map(snap.entries.map((e) => [e.path, e]));
  const text = (p: string) => snap.contents.get(p);

  const tryTransform = (path: string, fn: () => TransformResult): TransformResult | null => {
    try {
      const r = fn();
      parseYamlFrontmatter(r.content);
      return r;
    } catch (err) {
      if (err instanceof TransformError) { problems.push({ path, reason: err.message }); return null; }
      throw err;
    }
  };

  // --- Domains and topics -------------------------------------------------
  const domainFolders = new Map<string, { number: number; name: string; hasMeta: boolean }>();
  /** Source path -> its path after the migration (for link resolution checks). */
  const destOf = new Map<string, string>();
  for (const e of snap.entries) {
    if (!e.path.startsWith(DOMAINS_DIR)) continue;
    const rest = e.path.slice(DOMAINS_DIR.length);
    const parts = rest.split('/');
    if (e.type === 'folder') {
      if (parts.length > 1) problems.push({ path: e.path, reason: 'nested folder inside a domain folder' });
      continue;
    }
    if (parts.length !== 2) { problems.push({ path: e.path, reason: 'expected Domains and Topics/<N> <Domain>/<file>.md' }); continue; }
    const fm = parts[0].match(/^(\d+) (.+)$/);
    if (!fm) { problems.push({ path: e.path, reason: `domain folder name ${JSON.stringify(parts[0])} is not "<N> <Domain>"` }); continue; }
    if (!/\.md$/i.test(parts[1]) || e.type !== 'markdown') { problems.push({ path: e.path, reason: 'not a markdown file' }); continue; }
    const folder = domainFolders.get(parts[0]) ?? { number: Number(fm[1]), name: fm[2], hasMeta: false };
    domainFolders.set(parts[0], folder);
    const content = text(e.path);
    if (content === undefined) { problems.push({ path: e.path, reason: 'content not loaded' }); continue; }
    if (parts[1] === '_domain_metadata.md') {
      folder.hasMeta = true;
      const target = `${CONCEPTS_DIR}${folder.name}.md`;
      destOf.set(e.path, target);
      const r = tryTransform(e.path, () => transformDomain(content, folder.number));
      if (r) items.push({ kind: 'domain', path: e.path, id: e.id, target, before: content, after: r.content, notes: r.notes });
      counts.domains++;
    } else {
      const target = `${CONCEPTS_DIR}${parts[1]}`;
      destOf.set(e.path, target);
      const r = tryTransform(e.path, () => transformTopic(content, folder.name));
      if (r) {
        items.push({
          kind: 'topic', path: e.path, id: e.id, target, before: content, after: r.content, notes: r.notes,
          parents: [`${CONCEPTS_DIR}${folder.name}.md`],
        });
      }
      counts.topics++;
      // The new parent link must not resolve to anything from where the topic
      // is now, or the move would "fix" it to point at that file.
      const pre = resolvePageName(folder.name, meta, e.path);
      if (pre) problems.push({ path: e.path, reason: `[[${folder.name}]] already resolves to ${pre.path} from the topic's current folder` });
    }
  }
  for (const [folderName, f] of domainFolders) {
    if (!f.hasMeta) problems.push({ path: `${DOMAINS_DIR}${folderName}/`, reason: 'domain folder has no _domain_metadata.md' });
  }
  const domainNumbers = new Map<number, string>();
  for (const [folderName, f] of domainFolders) {
    if (domainNumbers.has(f.number)) problems.push({ path: `${DOMAINS_DIR}${folderName}/`, reason: `domain number ${f.number} also used by ${domainNumbers.get(f.number)}` });
    domainNumbers.set(f.number, folderName);
  }

  // --- Learning outcomes ----------------------------------------------------
  interface PlaceholderCand { entry: VaultEntry; content: string; r: TransformResult | null; linkVals: string[] | 'none' }
  const placeholders: PlaceholderCand[] = [];
  const realLOs: { entry: VaultEntry; content: string }[] = [];
  for (const e of snap.entries) {
    if (!e.path.startsWith(LO_DIR) || e.type !== 'markdown') continue;
    const content = text(e.path);
    if (content === undefined) { problems.push({ path: e.path, reason: 'content not loaded' }); continue; }
    let fmOk = true;
    let tagged = false, hasParent = false, hasTopic = false, hasConcept = false, hasLO = false;
    try {
      const fm = parseFrontmatter(content);
      if (fm) {
        tagged = tagValues(fm).includes(PLACEHOLDER_TAG);
        hasParent = !!field(fm, 'parent');
        hasTopic = !!field(fm, 'topic');
        hasConcept = !!field(fm, 'concept');
        hasLO = !!field(fm, 'learning-outcome');
      }
    } catch (err) {
      if (!(err instanceof TransformError)) throw err;
      fmOk = false;
      if (/topic:|skill-tree-placeholder/.test(content)) problems.push({ path: e.path, reason: err.message });
    }
    if (!fmOk) continue;
    const real = hasTest(content) || hasLenses(content);
    // Placeholder, or a placeholder already rewritten but not yet moved (a re-run after a partial apply).
    const pendingMove = !tagged && hasParent && !hasTopic && !hasConcept && !hasLO;
    if ((tagged && !real) || pendingMove) {
      const r = tryTransform(e.path, () => transformPlaceholder(content));
      const lf = linkField(content, hasTopic ? 'topic' : 'parent');
      placeholders.push({ entry: e, content, r, linkVals: lf ?? 'none' });
      destOf.set(e.path, `${CONCEPTS_DIR}${basename(e.path)}`);
    } else {
      if (tagged) { counts.taggedButReal++; warnings.push({ path: e.path, reason: 'tagged skill-tree-placeholder but has a test or lenses: treated as a real learning outcome (tag kept)' }); }
      if (hasTopic) realLOs.push({ entry: e, content });
      else if (hasConcept) counts.loAlreadyConcept++;
      else counts.loNoTopic++;
    }
  }

  // Existing Concepts/ files (not part of this migration).
  for (const e of snap.entries) {
    if (e.path.startsWith(CONCEPTS_DIR) && e.type === 'markdown') destOf.set(e.path, e.path);
  }
  /** Where a link resolves to now, and where that file will be after the migration. */
  const resolveToDest = (link: string, from: string): { now: string; dest?: string } | null => {
    const res = resolvePageName(link, meta, from);
    if (!res) return null;
    return { now: res.path, dest: destOf.get(res.path) };
  };

  // --- Collisions -------------------------------------------------------------
  const sourcesByTarget = new Map<string, string[]>();
  const addTarget = (target: string, source: string) => {
    const k = target.toLowerCase();
    sourcesByTarget.set(k, [...(sourcesByTarget.get(k) ?? []), source]);
  };
  for (const it of items) if (it.target) addTarget(it.target, it.path);
  for (const p of placeholders) addTarget(`${CONCEPTS_DIR}${basename(p.entry.path)}`, p.entry.path);
  const existingConcepts = new Map<string, string>();
  for (const e of snap.entries) {
    if (e.path.startsWith(CONCEPTS_DIR)) existingConcepts.set(e.path.toLowerCase(), e.path);
    // An HTML twin would make [[X]] ambiguous too.
    if (e.path.startsWith(CONCEPTS_DIR) && /\.html$/i.test(e.path)) existingConcepts.set(e.path.replace(/\.html$/i, '.md').toLowerCase(), e.path);
  }

  const dropped = new Set<string>();
  const merged = new Map<string, string>(); // placeholder path -> existing concept path
  for (const [k, sources] of sourcesByTarget) {
    const existing = existingConcepts.get(k);
    if (sources.length === 1 && !existing) continue;
    if (opts.mergeIntoExistingConcepts && existing && sources.length === 1 && /\.md$/i.test(existing)) {
      const p = placeholders.find((x) => x.entry.path === sources[0]);
      if (p && bodyOf(p.content).trim() === '') { merged.set(sources[0], existing); continue; }
    }
    // Optional resolution: a same-named placeholder under its own namesake topic is redundant.
    if (opts.dropRedundantPlaceholders && !existing) {
      const phs = sources.filter((s) => placeholders.some((p) => p.entry.path === s));
      const others = sources.filter((s) => !phs.includes(s));
      if (others.length === 1 && phs.length >= 1) {
        let allRedundant = true;
        for (const s of phs) {
          const p = placeholders.find((x) => x.entry.path === s)!;
          const vals = p.linkVals;
          const r = vals !== 'none' && vals.length === 1 ? resolveToDest(wikilinkTargets(vals[0])[0] ?? '', s) : null;
          const ok = !!r && r.now === others[0] && bodyOf(p.content).trim() === '';
          if (!ok) allRedundant = false;
        }
        if (allRedundant) { phs.forEach((s) => dropped.add(s)); continue; }
      }
    }
    const desc = sources.map((s) => s.slice(1)).join(', ');
    problems.push({
      path: existing ?? `${CONCEPTS_DIR}${basename(sources[0])}`,
      reason: existing
        ? `name collision: ${existing.slice(1)} already exists; would be the target of ${desc}`
        : `name collision: ${sources.length} files would move to the same name: ${desc}`,
    });
  }

  // --- Placeholders: parents must resolve to concept files ---------------------
  for (const p of placeholders) {
    const path = p.entry.path;
    const mergeInto = merged.get(path);
    if (mergeInto) {
      const names: string[] = [];
      let ok = true;
      if (p.linkVals !== 'none') {
        for (const v of p.linkVals) {
          const target = wikilinkTargets(v)[0];
          const r = target ? resolveToDest(target, path) : null;
          if (!r || !r.dest || !r.dest.startsWith(CONCEPTS_DIR) || r.dest === mergeInto) {
            problems.push({ path, reason: `topic link ${v} does not resolve to another concept (merge into ${mergeInto.slice(1)})` });
            ok = false;
            continue;
          }
          names.push(stem(r.dest));
        }
      }
      const conceptText = text(mergeInto);
      const conceptEntry = byPath.get(mergeInto)!;
      if (!ok || conceptText === undefined) {
        if (conceptText === undefined) problems.push({ path: mergeInto, reason: 'content not loaded' });
        continue;
      }
      const fm = parseFrontmatter(p.content);
      const idField = fm ? field(fm, 'id') : undefined;
      const id = idField ? unquote(idField.inline) : null;
      const r = tryTransform(mergeInto, () => mergeIntoConcept(conceptText, id, names));
      if (!r) continue;
      counts.mergePlaceholders++;
      items.push({
        kind: 'merge-placeholder', path, id: p.entry.id, before: conceptText, after: r.content,
        notes: [`merged into existing ${mergeInto.slice(1)}, then trashed`, ...r.notes],
        parents: names.map((n) => `${CONCEPTS_DIR}${n}.md`),
        merge: { conceptPath: mergeInto, conceptId: conceptEntry.id, id, parentNames: names },
      });
      continue;
    }
    if (dropped.has(path)) {
      items.push({ kind: 'drop-placeholder', path, id: p.entry.id, before: p.content, after: p.content, notes: ['same name as its parent topic/domain; trashed instead of moved'] });
      counts.dropPlaceholders++;
      continue;
    }
    const parents: string[] = [];
    if (p.linkVals !== 'none') {
      for (const v of p.linkVals) {
        const target = wikilinkTargets(v)[0];
        const r = target ? resolveToDest(target, path) : null;
        if (!r) { problems.push({ path, reason: `topic link ${v} does not resolve` }); continue; }
        if (!r.dest || !r.dest.startsWith(CONCEPTS_DIR)) { problems.push({ path, reason: `topic link ${v} resolves to ${r.now}, which is not a domain/topic/concept` }); continue; }
        if (r.dest === destOf.get(path)) { problems.push({ path, reason: `topic link ${v} would make the concept its own parent` }); continue; }
        parents.push(r.dest);
      }
    }
    if (!p.r) continue;
    counts.placeholders++;
    if (parents.length > 1) counts.multiParentPlaceholders++;
    if (p.linkVals === 'none') counts.noParentPlaceholders++;
    if (p.r.notes.some((n) => n.startsWith('dropped learning-outcome'))) counts.droppedLoText++;
    items.push({ kind: 'placeholder', path, id: p.entry.id, target: destOf.get(path), before: p.content, after: p.r.content, notes: p.r.notes, parents });
  }

  // --- Real learning outcomes ----------------------------------------------------
  for (const { entry, content } of realLOs) {
    const vals = linkField(content, 'topic');
    if (vals && vals !== 'none') {
      let bad = false;
      for (const v of vals) {
        const t = wikilinkTargets(v);
        if (t.length !== 1) continue; // transform reports it
        const r = resolveToDest(t[0], entry.path);
        if (!r) { problems.push({ path: entry.path, reason: `topic link ${v} does not resolve` }); bad = true; }
        else if (!r.dest || !r.dest.startsWith(CONCEPTS_DIR)) { problems.push({ path: entry.path, reason: `topic link ${v} resolves to ${r.now}, which is not a domain/topic/concept` }); bad = true; }
        else if (dropped.has(r.now) || merged.has(r.now)) { problems.push({ path: entry.path, reason: `topic link ${v} points at a placeholder that would be trashed` }); bad = true; }
      }
      if (bad) continue;
    }
    const r = tryTransform(entry.path, () => transformLearningOutcome(content));
    if (!r) continue;
    counts.los++;
    if (vals === 'none') counts.losNone++;
    else if (vals && vals.length > 1) counts.losMulti++;
    items.push({ kind: 'lo', path: entry.path, id: entry.id, before: content, after: r.content, notes: r.notes });
  }
  // --- Template -------------------------------------------------------------------
  const tpl = byPath.get(TEMPLATE_PATH);
  const tplText = text(TEMPLATE_PATH);
  if (tpl && tplText !== undefined) {
    const r = transformTemplate(tplText);
    if (r.content !== tplText) {
      counts.template++;
      items.push({ kind: 'template', path: TEMPLATE_PATH, id: tpl.id, before: tplText, after: r.content, notes: r.notes });
    }
  }

  // Already-done files fall out here: no move and no text change.
  const pending = items.filter((it) => it.kind === 'drop-placeholder' || it.kind === 'merge-placeholder' || it.before !== it.after || (it.target && it.target !== it.path));
  pending.sort((a, b) => phaseOf(a.kind) - phaseOf(b.kind) || a.path.localeCompare(b.path));
  return { items: pending, problems, warnings, counts };
}

/**
 * Checks on a migrated tree: nothing left in Domains and Topics/, no placeholder
 * or `topic:` left in Learning Outcomes/, every Concepts/ `parent:` and every
 * learning outcome `concept:` link resolves to a file in Concepts/.
 */
export function verifyMigrated(snap: Snapshot): { problems: Problem[]; stats: Record<string, number> } {
  const problems: Problem[] = [];
  const stats = { concepts: 0, domains: 0, topics: 0, parentLinks: 0, loConceptLinks: 0 };
  const meta: FolderMetadata = {};
  for (const e of snap.entries) meta[e.path] = { id: e.id, type: e.type as any, version: 0 };
  const checkLinks = (path: string, key: string, values: string[]) => {
    for (const v of values) {
      const t = wikilinkTargets(v);
      if (t.length !== 1) { problems.push({ path, reason: `${key}: value is not one wikilink: ${v}` }); continue; }
      const r = resolvePageName(t[0], meta, path);
      if (!r) problems.push({ path, reason: `${key}: ${v} does not resolve` });
      else if (!r.path.startsWith(CONCEPTS_DIR)) problems.push({ path, reason: `${key}: ${v} resolves outside Concepts/ (${r.path})` });
    }
  };
  for (const e of snap.entries) {
    if (e.path.startsWith(DOMAINS_DIR) && e.type !== 'folder') problems.push({ path: e.path, reason: 'still in Domains and Topics/' });
    const content = snap.contents.get(e.path);
    if (content === undefined || e.type !== 'markdown') continue;
    try {
      if (e.path.startsWith(CONCEPTS_DIR)) {
        stats.concepts++;
        const fm = parseYamlFrontmatter(content);
        if (fm['skill-tree'] === 'domain') stats.domains++;
        if (fm['skill-tree'] === 'topic') stats.topics++;
        if ('topic' in fm || 'learning-outcome' in fm) problems.push({ path: e.path, reason: 'concept file still has topic:/learning-outcome:' });
        if (isPlaceholderTagged(content)) problems.push({ path: e.path, reason: 'concept file still tagged skill-tree-placeholder' });
        const p = linkField(content, 'parent');
        if (p && p !== 'none') { stats.parentLinks += p.length; checkLinks(e.path, 'parent', p); }
      } else if (e.path.startsWith(LO_DIR)) {
        if (linkField(content, 'topic') !== null) problems.push({ path: e.path, reason: 'learning outcome still has topic:' });
        if (isPlaceholderTagged(content) && !hasTest(content) && !hasLenses(content)) problems.push({ path: e.path, reason: 'placeholder still in Learning Outcomes/' });
        const c = linkField(content, 'concept');
        if (c && c !== 'none') { stats.loConceptLinks += c.length; checkLinks(e.path, 'concept', c); }
      }
    } catch (err) {
      if (!(err instanceof TransformError)) throw err;
      problems.push({ path: e.path, reason: err.message });
    }
  }
  return { problems, stats };
}

/** The in-folder paths whose text a plan needs (for snapshot builders). */
export function needsContent(path: string): boolean {
  return (
    (path.startsWith(DOMAINS_DIR) || path.startsWith(LO_DIR) || path.startsWith(CONCEPTS_DIR)) && /\.md$/i.test(path)
  ) || path === TEMPLATE_PATH;
}

/** Non-wikilink mentions of the old layout in other files (for the doc-edit list). */
export function findTextReferences(path: string, content: string): string[] {
  if (path.startsWith(DOMAINS_DIR) || path.startsWith(LO_DIR) || path.startsWith(CONCEPTS_DIR)) return [];
  const hits: string[] = [];
  const lines = content.split('\n');
  const patterns = [/Domains and Topics/, /_domain_metadata/, /skill-tree-placeholder/, /`topic:`/, /^\s*topic:\s*"\[\[/, /`domain:`/, /\bDomains\//];
  lines.forEach((raw, i) => {
    const t = strip(raw);
    // A wikilink into the moved folders is rewritten by the move itself.
    const withoutLinks = t.replace(/\[\[[^\]]*\]\]/g, '');
    if (patterns.some((re) => re.test(withoutLinks))) hits.push(`${i + 1}: ${t.length > 160 ? t.slice(0, 157) + '...' : t}`);
  });
  return hits;
}

export { stem as stemOf };
