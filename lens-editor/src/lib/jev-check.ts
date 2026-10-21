// A jev check file (Lens Edu/Checks/*.md) and the arithmetic the check workbench shows.
// The frontmatter fields mirror lens-platform core/course_checks/checks.py `Check`.
import { parse as parseYaml, parseDocument } from 'yaml';

export interface JevCheck {
  id: string;
  name: string;
  model: string;
  fail_at: number;
  pass_below: number;
  question: string;
  criteria: { true: string; false: string } | null;
  enabled: boolean;  // false while a new check is being written; the platform skips it
}

const CHECKS_DIR = '/Lens Edu/Checks/';
export const DEFAULT_MODEL = 'jev-1.14.0';

export function isCheckPath(path: string | undefined): boolean {
  return !!path && path.startsWith(CHECKS_DIR) && path.endsWith('.md') && !path.slice(CHECKS_DIR.length).includes('/');
}

export function parseCheck(text: string): JevCheck {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) throw new Error('no frontmatter: a check file starts with --- ... ---');
  const fm = (parseYaml(m[1]) ?? {}) as Record<string, unknown>;
  const need = (k: string) => {
    if (typeof fm[k] !== 'string' || !(fm[k] as string).trim()) throw new Error(`frontmatter needs a "${k}"`);
    return fm[k] as string;
  };
  const num = (k: string, d: number) => {
    if (fm[k] === undefined) return d;
    if (typeof fm[k] !== 'number') throw new Error(`"${k}" must be a number`);
    return fm[k] as number;
  };
  const c = fm.criteria as Record<string, unknown> | undefined;
  let criteria: JevCheck['criteria'] = null;
  if (c !== undefined) {
    const t = c?.['true'], f = c?.['false'];
    if (typeof t !== 'string' || typeof f !== 'string') throw new Error('criteria needs "true" and "false" strings');
    criteria = { true: t, false: f };
  }
  return {
    id: need('id'), name: typeof fm.name === 'string' ? fm.name : '',
    model: typeof fm.model === 'string' ? fm.model : DEFAULT_MODEL,
    fail_at: num('fail_at', 0.8), pass_below: num('pass_below', 0.5),
    question: need('question'), criteria, enabled: fm.enabled !== false,
  };
}

/** "[0, 0.01, 1]" or "9 even" (both ends included). */
export function parsePercentiles(spec: string): number[] {
  const s = spec.trim();
  const even = s.match(/^(\d+)\s+even$/);
  if (even) {
    const n = parseInt(even[1], 10);
    if (n < 2) throw new Error('"N even" needs N >= 2');
    return Array.from({ length: n }, (_, i) => i / (n - 1));
  }
  let xs: unknown;
  try { xs = JSON.parse(s); } catch { throw new Error('use a list like [0, 0.5, 1] or "9 even"'); }
  if (!Array.isArray(xs) || !xs.every((x) => typeof x === 'number' && x >= 0 && x <= 1)) {
    throw new Error('percentiles are numbers from 0 to 1');
  }
  return xs as number[];
}

export function percentileRows<T extends { p: number }>(items: T[], ps: number[]): { at: number; item: T }[] {
  const sorted = [...items].sort((a, b) => a.p - b.p);
  if (!sorted.length) return [];
  return ps.map((at) => ({ at, item: sorted[Math.round(at * (sorted.length - 1))] }));
}

export function histogram(ps: number[], bins: number): number[] {
  const out = new Array(bins).fill(0);
  for (const p of ps) out[Math.min(bins - 1, Math.floor(p * bins))]++;
  return out;
}

/** P(score of a bad item > score of a good item); null without both kinds. */
export function auroc(bad: number[], good: number[]): number | null {
  if (!bad.length || !good.length) return null;
  let s = 0;
  for (const b of bad) for (const g of good) s += b > g ? 1 : b === g ? 0.5 : 0;
  return s / (bad.length * good.length);
}

/** Set fields in a check file's frontmatter, keeping the body and the YAML's other
 *  keys and comments. `path` is a key or a nested key path such as ['criteria', 'true']. */
export function setCheckFields(text: string, edits: { path: string[]; value: string | number | boolean }[]): string {
  return editFrontmatter(text, (doc) => { for (const { path, value } of edits) doc.setIn(path, value); });
}

export type Band = 'fail' | 'unsure' | 'pass';
export const BANDS: Band[] = ['fail', 'unsure', 'pass'];

export function bandOf(check: JevCheck, p: number): Band {
  return p >= check.fail_at ? 'fail' : p < check.pass_below ? 'pass' : 'unsure';
}

export function bandRule(check: JevCheck, b: Band): string {
  return b === 'fail' ? `p ≥ ${check.fail_at}` : b === 'pass' ? `p < ${check.pass_below}` : `${check.pass_below} ≤ p < ${check.fail_at}`;
}

/** The share of scores in each band. */
export function shares(check: JevCheck, ps: number[]): Record<Band, number> {
  const out = { fail: 0, unsure: 0, pass: 0 };
  for (const p of ps) out[bandOf(check, p)] += 1 / ps.length;
  return out;
}

// Drafts. A check file may carry a `draft:` block in its frontmatter holding only the fields
// being tried; the draft check is the live one with those fields overlaid. The block lives in
// the file, so it survives a closed tab and reaches git like every other edit.
const DRAFTABLE = ['question', 'criteria', 'model', 'fail_at', 'pass_below'];

/** Edit the frontmatter as a YAML document; `f` returning false means no change, and the text comes back untouched. */
function editFrontmatter(text: string, f: (doc: ReturnType<typeof parseDocument>) => boolean | void): string {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) throw new Error('no frontmatter');
  const doc = parseDocument(m[1]);
  if (f(doc) === false) return text;
  return `---\n${doc.toString({ lineWidth: 0 }).replace(/\n$/, '')}\n---` + text.slice(m[0].length);
}

export function parseCheckFile(text: string): { live: JevCheck; draft: JevCheck | null } {
  const live = parseCheck(text);
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)!;
  const fm = (parseYaml(m[1]) ?? {}) as Record<string, unknown>;
  const d = fm.draft as Record<string, unknown> | undefined;
  if (!d) return { live, draft: null };
  const bad = Object.keys(d).filter((k) => !DRAFTABLE.includes(k));
  if (bad.length) throw new Error(`draft has fields a check does not: ${bad.join(', ')}`);
  const merged: Record<string, unknown> = { ...fm, ...d, criteria: d.criteria ? { ...(fm.criteria as object), ...(d.criteria as object) } : fm.criteria };
  delete merged.draft;
  const head = Object.entries(merged).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
  return { live, draft: parseCheck(`---\n${head}\n---\n`) };
}

/** Set one draft field; a field equal to the live one leaves the draft, and an empty draft goes. */
export function setDraftField(text: string, path: string[], value: string | number): string {
  return editFrontmatter(text, (doc) => {
    const dpath = ['draft', ...path];
    if (doc.getIn(path) !== value) doc.setIn(dpath, value);
    else if (doc.hasIn(dpath)) doc.deleteIn(dpath);
    else return false;
    for (let i = dpath.length - 1; i > 0; i--) {
      const node = doc.getIn(dpath.slice(0, i)) as { items?: unknown[] } | undefined;
      if (node && node.items?.length === 0) doc.deleteIn(dpath.slice(0, i));
    }
  });
}

export function saveDraft(text: string): string {
  return editFrontmatter(text, (doc) => {
    const d = (doc.toJS().draft ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(d)) {
      if (k === 'criteria') for (const [ck, cv] of Object.entries(v as object)) doc.setIn(['criteria', ck], cv);
      else doc.setIn([k], v);
    }
    doc.deleteIn(['draft']);
  });
}

export function discardDraft(text: string): string {
  return editFrontmatter(text, (doc) => doc.deleteIn(['draft']));
}

/** A new check file: the fields the platform reads, ready to fill in from the workbench. */
export function newCheckText(id: string, name: string): string {
  if (!/^[A-Za-z][\w-]*$/.test(id)) throw new Error('an id is letters, digits, - or _, starting with a letter');
  if (!name.trim() || /[\n/]/.test(name)) throw new Error('a name is one line without /');
  return `---
id: ${id}
enabled: false
name: ${JSON.stringify(name.trim())}
model: ${DEFAULT_MODEL}
fail_at: 0.8
pass_below: 0.5
question: "Does \`paragraph\` …?"
criteria:
  "true": "\`paragraph\` …"
  "false": "\`paragraph\` …"
fix: "…"
---

Why this check exists, and examples of what it should and should not catch.
`;
}
