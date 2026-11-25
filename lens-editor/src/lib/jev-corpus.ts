// The paragraphs a run can draw from: the corpus in one fixed shuffled order, filtered by
// the chosen courses and kinds of text. The sample is the first N of that pool, so it is
// the same on every run and a larger N only adds paragraphs. Shared by the workbench
// (JevCheckPanel/useCorpus.ts) and the command line (scripts/jev.ts).
import type { CorpusMeta, Para } from '../components/JevCheckPanel/types';

/** A GET of one of the editor server's /api/jev routes: its JSON, or an Error with its message. */
export type GetJson = (url: string) => Promise<unknown>;

function fnv(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** The corpus as the course text is now, from the platform (the offline corpus when the
 *  platform has none), its rows in the fixed order. */
export async function fetchCorpus(get: GetJson, held?: { meta: CorpusMeta; corpus: Para[] }): Promise<{ meta: CorpusMeta; corpus: Para[] }> {
  const have = held ? `&have=${encodeURIComponent(held.meta.commit)}` : '';
  const d = (await get(`/api/jev/corpus?latest=1${have}`).catch(() => get('/api/jev/corpus'))) as { meta: CorpusMeta; rows: Para[]; unchanged?: boolean };
  if (d.unchanged && held) return held;
  return { meta: d.meta, corpus: [...d.rows].sort((a, b) => fnv(a.id) - fnv(b.id)) };
}

/** The rows of the chosen courses and kinds of text; by default the courses with a running
 *  cohort and every kind. */
export function chosen(meta: CorpusMeta, courses?: string[], kinds?: string[]) {
  return {
    courses: new Set(courses ?? Object.entries(meta.courses).filter(([, c]) => c.live).map(([k]) => k)),
    kinds: new Set(kinds ?? Object.keys(meta.kinds)),
  };
}
export function poolOf(corpus: Para[] | null, meta: CorpusMeta | null, courses?: string[], kinds?: string[]): Para[] | null {
  if (!corpus || !meta) return null;
  const c = chosen(meta, courses, kinds);
  return corpus.filter((p) => c.kinds.has(p.kind) && p.courses.some((x) => c.courses.has(x)));
}
