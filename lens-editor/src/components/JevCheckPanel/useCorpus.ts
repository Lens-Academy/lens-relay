// The paragraphs a run can draw from: the corpus in one fixed shuffled order, filtered by
// the chosen courses and kinds of text. The sample is the first N of that pool, so it is
// the same on every run and a larger N only adds paragraphs.
import { useCallback, useEffect, useState } from 'react';
import type { CorpusMeta, Para } from './types';
import { relayHeaders } from '../../lib/relay-api';

function fnv(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** The corpus as the course text is now, from the platform (the offline corpus when the
 *  platform has none), its rows in the fixed order. */
async function fetchCorpus(): Promise<{ meta: CorpusMeta; corpus: Para[] }> {
  const get = async (url: string) => {
    const r = await fetch(url, { headers: relayHeaders() });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    return d as { meta: CorpusMeta; rows: Para[] };
  };
  const d = await get('/api/jev/corpus?latest=1').catch(() => get('/api/jev/corpus'));
  return { meta: d.meta, corpus: [...d.rows].sort((a, b) => fnv(a.id) - fnv(b.id)) };
}

/** The corpus rows and their description; `reload` takes the corpus again, as a Run with
 *  "latest course text" does, and returns it. */
export function useCorpus(onError: (msg: string) => void) {
  const [state, setState] = useState<{ meta: CorpusMeta | null; corpus: Para[] | null }>({ meta: null, corpus: null });
  useEffect(() => {
    fetchCorpus().then(setState, (e: Error) => onError(`corpus: ${e.message}`));
  }, [onError]);
  const reload = useCallback(async () => { const d = await fetchCorpus(); setState(d); return d; }, []);
  return { ...state, reload };
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
