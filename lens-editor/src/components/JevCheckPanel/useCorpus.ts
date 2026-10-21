// The paragraphs a run can draw from: the corpus in one fixed shuffled order, filtered by
// the chosen courses and kinds of text. The sample is the first N of that pool, so it is
// the same on every run and a larger N only adds paragraphs.
import { useEffect, useMemo, useState } from 'react';
import type { CorpusMeta, Para } from './types';
import { relayHeaders } from '../../lib/relay-api';

function fnv(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

export function useCorpus(onError: (msg: string) => void) {
  const [corpus, setCorpus] = useState<Para[] | null>(null);
  const [meta, setMeta] = useState<CorpusMeta | null>(null);
  const [courses, setCourses] = useState<Set<string>>(new Set());
  const [kinds, setKinds] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch('/api/jev/corpus', { headers: relayHeaders() }).then(async (r) => {
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      return d as { meta: CorpusMeta; rows: Para[] };
    }).then((d) => {
      setMeta(d.meta);
      setCorpus([...d.rows].sort((a, b) => fnv(a.id) - fnv(b.id)));
      setCourses(new Set(Object.entries(d.meta.courses).filter(([, c]) => c.live).map(([k]) => k)));
      setKinds(new Set(Object.keys(d.meta.kinds)));
    }).catch((e) => onError(`corpus: ${e.message}`));
  }, [onError]);

  const pool = useMemo(() => corpus?.filter((p) => kinds.has(p.kind) && p.courses.some((c) => courses.has(c))) ?? null,
    [corpus, courses, kinds]);
  return { meta, pool, courses, setCourses, kinds, setKinds };
}
