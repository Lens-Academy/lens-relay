import { useCallback, useEffect, useState } from 'react';
import { relayHeaders } from '../../lib/relay-api';
import type { Label } from '../../lib/jev-labels';

/** The labels of check `checkId`, kept by the platform (GET/POST /api/jev/judgements), and a way
 *  to add one. A label shows at once and stays if the platform keeps it; `error` says why not. */
export function useLabels(checkId: string | undefined) {
  const [labels, setLabels] = useState<Label[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!checkId) return;
    let live = true;
    fetch(`/api/jev/judgements?check_id=${encodeURIComponent(checkId)}`, { headers: relayHeaders({}) })
      .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error); return d.judgements as Label[]; })
      // Keep labels added before the list arrived (they have no id yet) (Assay, #195).
      .then((js) => { if (live) { setLabels((ls) => [...js, ...ls.filter((l) => l.id === undefined)]); setError(null); } }, (e: Error) => live && setError(`labels: ${e.message}`));
    return () => { live = false; };
  }, [checkId]);
  const add = useCallback(async (l: Label) => {
    setLabels((ls) => [...ls, l]);
    try {
      const r = await fetch('/api/jev/judgements', { method: 'POST', headers: relayHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(l) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setLabels((ls) => ls.map((x) => (x === l ? (d as Label) : x)));
      setError(null);
    } catch (e) {
      setLabels((ls) => ls.filter((x) => x !== l));
      setError(`the label was not kept: ${(e as Error).message}`);
    }
  }, []);
  return { labels, add, error };
}
