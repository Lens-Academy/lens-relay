// The paragraphs a run can draw from: the corpus in one fixed shuffled order, filtered by
// the chosen courses and kinds of text. The sample is the first N of that pool, so it is
// the same on every run and a larger N only adds paragraphs.
import { useEffect, useState } from 'react';
import type { CorpusMeta, Para } from './types';
import { relayHeaders } from '../../lib/relay-api';

function fnv(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** The corpus rows, in that fixed order, and its description. */
export function useCorpus(onError: (msg: string) => void) {
  const [corpus, setCorpus] = useState<Para[] | null>(null);
  const [meta, setMeta] = useState<CorpusMeta | null>(null);
  useEffect(() => {
    fetch('/api/jev/corpus', { headers: relayHeaders() }).then(async (r) => {
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      return d as { meta: CorpusMeta; rows: Para[] };
    }).then((d) => {
      setMeta(d.meta);
      setCorpus([...d.rows].sort((a, b) => fnv(a.id) - fnv(b.id)));
    }).catch((e) => onError(`corpus: ${e.message}`));
  }, [onError]);
  return { meta, corpus };
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
