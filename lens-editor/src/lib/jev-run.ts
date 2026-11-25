// Running a check over a sample of course text, for the workbench (JevCheckPanel.tsx) and the
// command line (scripts/jev.ts).
import type { JevCheck } from './jev-check';
import { describe, isDefault, presentationBlock, type Presentation } from './jev-presentation';
import type { Para, Run } from '../components/JevCheckPanel/types';

/** A POST to one of the editor server's /api/jev routes: its JSON, or an Error with its message. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PostJson = (url: string, body: unknown) => Promise<any>;

// jev answers the same call differently (up to 0.15 apart, 2026-10-26), so a run asks each
// request this many times and shows the mean with the spread (Lauren, 2026-10-27).
export const SAMPLES = 3;

/** One jev call: a shown text and every question asked about it. */
export interface Batch { state: Record<string, unknown>; questions: { instructions: string; criteria?: { true: string; false: string } }[] }
/** A unit asked about, the sampled row it came from, and its question: batches[batch].questions[index]. */
interface Asked { id: string; row: string; path: string; line: number; text: string; batch: number; index: number; words?: string; answer_key?: string }

/** One run of `check` over `sample`, asked the way `pres` says: the platform builds the calls
 *  (POST /api/jev/requests), unless each unit is shown alone, and the editor server asks jev
 *  (POST /api/jev/ask). `post` sends one request to those routes and returns its JSON. */
export async function askCheck(post: PostJson, check: JevCheck, sample: Para[], pres: Presentation, commit?: string): Promise<Run & { first?: Batch }> {
  const question = { instructions: check.question, ...(check.criteria ? { criteria: check.criteria } : {}) };
  // Each paragraph alone needs no reading of the files, so it is built here (as the platform
  // builds it: present.batches with no presentation); any other way, the platform builds it.
  const { batches, asked, left_out: leftOut = [] }: { batches: Batch[]; asked: Asked[]; left_out?: string[] } = isDefault(pres)
    ? { batches: sample.map((r) => ({ state: { paragraph: r.text }, questions: [question] })), asked: sample.map((r, i) => ({ ...r, row: r.id, batch: i, index: 0 })) }
    : await post('/api/jev/requests', { question, presentation: presentationBlock(pres), commit, units: sample.map(({ id, path, line, text }) => ({ id, path, line, text })) });
  const data = await post('/api/jev/ask', { model: check.model, samples: SAMPLES, requests: batches, ...(pres.long && pres.context !== pres.question ? { longContext: true } : {}) });
  // ps answers the batches' questions in order.
  const start: number[] = [];
  batches.reduce((at, b, i) => { start[i] = at; return at + b.questions.length; }, 0);
  const rows = new Map(sample.map((r) => [r.id, r]));
  // Units jev refused as too long (null) are left out of the run, and counted.
  const scored = asked.map((a) => ({ ...rows.get(a.row)!, id: a.id, line: a.line, text: a.text, words: a.words, answerKey: a.answer_key, p: data.ps[start[a.batch] + a.index] as number | null, samples: data.samples?.[start[a.batch] + a.index] as number[] | undefined }))
    .filter((u): u is typeof u & { p: number } => u.p !== null);
  return { check, samples: SAMPLES, unit: pres.question, pres: describe(pres), platform: isDefault(pres), cached: data.cached, tooLong: data.tooLong ?? 0, leftOut: leftOut.length, scored, first: batches[0] };
}

