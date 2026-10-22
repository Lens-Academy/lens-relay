// How a Run presents the check to jev (lib/jev-present.ts does the parsing): which units of the
// sample are asked about, and the question and state each request carries.
import type { JevCheck } from '../../lib/jev-check';
import { parseDoc, presentState, questionKey, sentencesAt, templateQuestion, unitOf, type Doc, type Level, type Mode, type Unit, type UnitKind } from '../../lib/jev-present';
import type { Para } from './types';

export interface Presentation { mode: Mode; unit: UnitKind; levels: Level[] }
export const DEFAULT_PRESENTATION: Presentation = { mode: 'isolated', unit: 'paragraph', levels: ['heading', 'paragraph', 'sentence', 'line'] };
export const isDefault = (p: Presentation) => p.mode === 'isolated' && p.unit === 'paragraph';

export function describe(p: Presentation): string {
  const sees = p.mode === 'isolated' ? `the ${p.unit} alone` : p.mode === 'raw' ? `the file's markdown, plus the ${p.unit}` : `the file parsed (${p.levels.join(', ')})`;
  return `jev sees ${sees}; asked about each ${p.unit}`;
}

export interface Request { question: { instructions: string; criteria?: { true: string; false: string } | null }; state: Record<string, unknown> }

/** The units a sample expands to under `p`, each with its request. Paragraph units in isolation
 *  keep the platform splitter's text (what the live check asks about); everything else comes from
 *  parsing the file, whose paragraphs keep Markdown the splitter strips. */
const fail = (msg: string): never => { throw new Error(msg); };

export function buildRequests(check: JevCheck, sample: Para[], p: Presentation, files: Record<string, string>): { units: Para[]; requests: Request[] } {
  const levels = [...new Set<Level>([...p.levels, p.unit])];
  const docs = new Map<string, Doc>();
  const raw = (path: string) => {
    if (isDefault(p)) return '';
    const t = files[path];
    if (t === undefined) throw new Error(`${path} could not be read from the relay`);
    return t;
  };
  const doc = (path: string) => { if (!docs.has(path)) docs.set(path, parseDoc(raw(path))); return docs.get(path)!; };
  const units: Para[] = [];
  const requests: Request[] = [];
  for (const row of sample) {
    const d = doc(row.path);
    const found: Unit[] = p.unit === 'sentence' ? sentencesAt(d, row.line, row.text)
      : isDefault(p) ? [{ kind: 'paragraph', key: 'paragraph', text: row.text }]
      : [unitOf(d, 'paragraph', row.line, row.text) ?? fail(`no paragraph like "${row.text.slice(0, 40)}…" in ${row.path} now (edited since the corpus was taken?)`)];
    for (const u of found) {
      const key = questionKey(p.mode, u);
      const t = (s: string) => templateQuestion(s, key);
      units.push(p.unit === 'sentence' ? { ...row, id: `${row.id}#${u.key}`, text: u.text } : row);
      requests.push({
        question: { instructions: t(check.question), criteria: check.criteria ? { true: t(check.criteria.true), false: t(check.criteria.false) } : null },
        state: presentState(p.mode, d, raw(row.path), u, levels),
      });
    }
  }
  return { units, requests };
}
