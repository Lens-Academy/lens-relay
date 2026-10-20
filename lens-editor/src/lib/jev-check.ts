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
    question: need('question'), criteria,
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
export function setCheckFields(text: string, edits: { path: string[]; value: string | number }[]): string {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) throw new Error('no frontmatter');
  const doc = parseDocument(m[1]);
  for (const { path, value } of edits) doc.setIn(path, value);
  const yaml = doc.toString().replace(/\n$/, '');
  return `---\n${yaml}\n---` + text.slice(m[0].length);
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
