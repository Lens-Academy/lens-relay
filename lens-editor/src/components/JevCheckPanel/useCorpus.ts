// The workbench's corpus (lib/jev-corpus.ts): loaded once, and again on each Run with the
// latest course text.
import { useEffect, useState } from 'react';
import type { CorpusMeta, Para } from './types';
import { relayHeaders } from '../../lib/relay-api';
import { fetchCorpus as fetchWith } from '../../lib/jev-corpus';

export { chosen, poolOf } from '../../lib/jev-corpus';

const get = async (url: string) => {
  const r = await fetch(url, { headers: relayHeaders() });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error);
  return d;
};
const fetchCorpus = (held?: { meta: CorpusMeta; corpus: Para[] }) => fetchWith(get, held);

/** The corpus rows and their description; `reload` takes the corpus again, as a Run with
 *  "latest course text" does, and returns it. */
export function useCorpus(onError: (msg: string) => void) {
  const [state, setState] = useState<{ meta: CorpusMeta | null; corpus: Para[] | null }>({ meta: null, corpus: null });
  useEffect(() => {
    fetchCorpus().then(setState, (e: Error) => onError(`corpus: ${e.message}`));
  }, [onError]);
  const held = state.meta && state.corpus ? { meta: state.meta, corpus: state.corpus } : undefined;
  const reload = async () => { const d = await fetchCorpus(held); setState(d); return d; };
  return { ...state, reload };
}
