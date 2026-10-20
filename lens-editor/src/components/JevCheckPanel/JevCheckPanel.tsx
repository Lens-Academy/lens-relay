// Check workbench, first slice: shown above a Lens Edu/Checks/*.md file. Reads the check
// from the live text (so an unsaved phrasing is what runs), asks jev over a stable sample of
// course paragraphs, and shows the histogram and the paragraph at each chosen percentile.
import { useEffect, useMemo, useState } from 'react';
import type * as Y from 'yjs';
import { histogram, parseCheck, parsePercentiles, percentileRows, type JevCheck } from '../../lib/jev-check';
import { COLORMAPS, type ColormapName } from '../../lib/colormaps';

interface Para { id: string; page: string; text: string }
interface Scored extends Para { p: number }

const DEFAULT_PCTS = '[0, 0.01, 0.03, 0.1, 0.3, 0.5, 0.7, 0.9, 0.97, 0.99, 1]';

// Stable, nested sample: order by a hash of the id, take the first N.
function fnv(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

function useLiveText(ytext: Y.Text) {
  const [text, setText] = useState(() => ytext.toString());
  useEffect(() => {
    const f = () => setText(ytext.toString());
    ytext.observe(f);
    return () => ytext.unobserve(f);
  }, [ytext]);
  return text;
}

export function JevCheckPanel({ ytext }: { ytext: Y.Text }) {
  const text = useLiveText(ytext);
  const parsed = useMemo((): { check?: JevCheck; error?: string } => {
    try { return { check: parseCheck(text) }; } catch (e: any) { return { error: e.message }; }
  }, [text]);
  const [corpus, setCorpus] = useState<Para[] | null>(null);
  const [n, setN] = useState(200);
  const [pctSpec, setPctSpec] = useState(DEFAULT_PCTS);
  const [cmap, setCmap] = useState<ColormapName>('inferno');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ check: JevCheck; scored: Scored[]; cached: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/jev/corpus').then((r) => r.json()).then((rows: Para[]) =>
      setCorpus([...rows].sort((a, b) => fnv(a.id) - fnv(b.id))),
    ).catch((e) => setErr(`corpus: ${e.message}`));
  }, []);

  const pcts = useMemo(() => { try { return { ps: parsePercentiles(pctSpec) }; } catch (e: any) { return { error: e.message }; } }, [pctSpec]);

  async function run() {
    if (!parsed.check || !corpus) return;
    const check = parsed.check;
    const sample = corpus.slice(0, n);
    setRunning(true); setErr(null);
    try {
      const res = await fetch('/api/jev/ask', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: check.model, question: { instructions: check.question, criteria: check.criteria }, texts: sample.map((s) => s.text) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setResult({ check, cached: data.cached, scored: sample.map((s, i) => ({ ...s, p: data.ps[i] })) });
    } catch (e: any) { setErr(e.message); } finally { setRunning(false); }
  }

  const color = COLORMAPS[cmap];
  const stale = result && parsed.check && JSON.stringify(result.check) !== JSON.stringify(parsed.check);

  return (
    <div className="mx-6 my-3 rounded border border-gray-200 bg-gray-50 p-3 text-sm" data-testid="jev-check-panel">
      <div className="flex flex-wrap items-center gap-3">
        <strong>Jev check workbench</strong>
        {parsed.check
          ? <span className="text-gray-600">{parsed.check.id} · {parsed.check.model} · fail ≥ {parsed.check.fail_at}, pass &lt; {parsed.check.pass_below}</span>
          : <span className="text-red-700">{parsed.error}</span>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <label>sample <input type="number" min={1} max={corpus?.length ?? 1000} value={n}
          onChange={(e) => setN(Math.max(1, parseInt(e.target.value || '1', 10)))} className="w-20 rounded border px-1" />
          {corpus && <span className="text-gray-500"> of {corpus.length}</span>}</label>
        <label className="flex-1 min-w-[260px]">percentiles <input value={pctSpec} onChange={(e) => setPctSpec(e.target.value)}
          className={`w-full rounded border px-1 font-mono text-xs ${pcts.error ? 'border-red-500' : ''}`} title='a list like [0, 0.5, 1], or "9 even"' /></label>
        <label>colours <select value={cmap} onChange={(e) => setCmap(e.target.value as ColormapName)} className="rounded border">
          {Object.keys(COLORMAPS).map((k) => <option key={k}>{k}</option>)}</select></label>
        <button onClick={run} disabled={running || !parsed.check || !corpus}
          className="rounded bg-gray-800 px-3 py-1 text-white disabled:opacity-40">{running ? 'asking jev…' : 'Run'}</button>
      </div>
      {err && <div className="mt-2 text-red-700">{err}</div>}
      {result && <Results result={result} color={color} pcts={pcts.ps ?? []} stale={!!stale} />}
    </div>
  );
}

function Results({ result, color, pcts, stale }: { result: { check: JevCheck; scored: Scored[]; cached: number }; color: (p: number) => string; pcts: number[]; stale: boolean }) {
  const { check, scored, cached } = result;
  const bins = histogram(scored.map((s) => s.p), 10);
  const max = Math.max(...bins, 1);
  const fail = scored.filter((s) => s.p >= check.fail_at).length;
  const pass = scored.filter((s) => s.p < check.pass_below).length;
  const rows = percentileRows(scored, pcts);
  const pct = (k: number) => `${Math.round((100 * k) / scored.length)}%`;
  return (
    <div className="mt-3">
      {stale && <div className="mb-2 text-amber-700">The check text changed since this run. Run again to see the new phrasing.</div>}
      <div className="text-gray-700">{scored.length} paragraphs ({cached} from cache): fail {fail} ({pct(fail)}), unsure {scored.length - fail - pass} ({pct(scored.length - fail - pass)}), pass {pass} ({pct(pass)})</div>
      <div className="mt-2 flex h-24 items-end gap-1" aria-label="histogram of p(yes)">
        {bins.map((b, i) => (
          <div key={i} className="flex flex-1 flex-col items-center justify-end h-full">
            <span className="text-[10px] text-gray-500">{b}</span>
            <div style={{ height: `${(80 * b) / max}%`, background: color((i + 0.5) / 10) }} className="w-full rounded-t" />
            <span className="text-[10px] text-gray-500">{(i / 10).toFixed(1)}</span>
          </div>
        ))}
      </div>
      <table className="mt-3 w-full border-collapse text-xs">
        <thead><tr className="text-left text-gray-500"><th className="w-14">pctile</th><th className="w-12">p</th><th>paragraph</th></tr></thead>
        <tbody>
          {rows.map(({ at, item }) => (
            <tr key={`${at}-${item.id}`} className="border-t border-gray-200 align-top">
              <td className="py-1 font-mono">{at}</td>
              <td className="py-1 font-mono"><span className="rounded px-1" style={{ background: color(item.p), color: item.p > 0.55 ? 'black' : 'white' }}>{item.p.toFixed(2)}</span></td>
              <td className="py-1"><Para text={item.text} page={item.page} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Para({ text, page }: { text: string; page: string }) {
  const [open, setOpen] = useState(false);
  const short = text.length > 260 && !open ? text.slice(0, 260) + '…' : text;
  return (
    <div>
      <div className="whitespace-pre-wrap cursor-pointer" onClick={() => setOpen(!open)}>{short}</div>
      <div className="text-[10px] text-gray-400">{page}</div>
    </div>
  );
}
