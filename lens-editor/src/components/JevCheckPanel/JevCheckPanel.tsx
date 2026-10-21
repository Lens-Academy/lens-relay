// Check workbench, shown above a Lens Edu/Checks/*.md file. Read top-down:
//   the check's words (Field.tsx) are edited as a `draft:` block in the file's frontmatter
//   (checkFile.ts, lib/jev-check.ts); Save makes the draft live, Discard drops it;
//   the run bar picks a sample (useCorpus.ts, InputPicker.tsx) and asks jev via /api/jev/ask (server/jev-dev.ts);
//   results (Results.tsx) compare the draft with the live check, or a run with the one before it.
import { useMemo, useState } from 'react';
import type * as Y from 'yjs';
import { discardDraft, parseCheckFile, parsePercentiles, saveDraft, setCheckFields, setDraftField, type Band, type JevCheck } from '../../lib/jev-check';
import { COLORMAPS, type ColormapName } from '../../lib/colormaps';
import { useLiveText, writeText } from './checkFile';
import { useCorpus } from './useCorpus';
import { Field, Small, keyHint } from './Field';
import { InputPicker } from './InputPicker';
import { NewCheckButton } from './NewCheckButton';
import { BandList, Histogram, Percentiles, Summary } from './Results';
import type { Para, Run } from './types';

const DEFAULT_PCTS = '[0, 0.01, 0.03, 0.1, 0.3, 0.5, 0.7, 0.9, 0.97, 0.99, 1]';

function attempt<T>(f: () => T): { ok?: T; error?: string } {
  try { return { ok: f() }; } catch (e: any) { return { error: e.message }; }
}

async function ask(check: JevCheck, sample: Para[]): Promise<Run> {
  const res = await fetch('/api/jev/ask', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: check.model, question: { instructions: check.question, criteria: check.criteria }, texts: sample.map((s) => s.text) }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return { check, cached: data.cached, scored: sample.map((s, i) => ({ ...s, p: data.ps[i] })) };
}

export function JevCheckPanel({ ytext }: { ytext: Y.Text }) {
  const text = useLiveText(ytext);
  const parsed = useMemo(() => attempt(() => parseCheckFile(text)), [text]);
  const [err, setErr] = useState<string | null>(null);
  const corpus = useCorpus(setErr);
  const [n, setN] = useState(200);
  const [pctSpec, setPctSpec] = useState(DEFAULT_PCTS);
  const pcts = useMemo(() => attempt(() => parsePercentiles(pctSpec)), [pctSpec]);
  const [cmap, setCmap] = useState<ColormapName>('inferno');
  const [running, setRunning] = useState(false);
  // The newest run, the run to compare it with, and what that comparison is called.
  const [result, setResult] = useState<{ run: Run; base?: { label: string; run: Run } } | null>(null);
  const [band, setBand] = useState<Band | null>(null);

  const live = parsed.ok?.live;
  const draft = parsed.ok?.draft ?? null;
  const c = draft ?? live;  // what the fields show and Run tests
  const pool = corpus.pool;
  async function run() {
    if (!c || !live || !pool) return;
    setRunning(true); setErr(null);
    try {
      const sample = pool.slice(0, n);
      const [r, l] = await Promise.all([ask(c, sample), draft ? ask(live, sample) : null]);
      setResult((old) => ({ run: r, base: l ? { label: 'live', run: l } : old ? { label: 'was', run: old.run } : undefined }));
    } catch (e: any) { setErr(e.message); } finally { setRunning(false); }
  }

  const set = (path: string[]) => (v: string) => writeText(ytext, (t) => setDraftField(t, path, v));
  const setNum = (path: string[]) => (v: string) => { const x = Number(v); if (Number.isFinite(x)) writeText(ytext, (t) => setDraftField(t, path, x)); };
  const latest = result?.run;
  const stale = latest && c && JSON.stringify(latest.check) !== JSON.stringify(c);
  const color = COLORMAPS[cmap];

  return (
    <section className="mx-6 my-4 rounded-lg border border-gray-200 bg-white text-sm shadow-sm" data-testid="jev-check-panel"
      onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); } }}>
      <header className="flex items-baseline justify-between border-b border-gray-100 px-4 py-2.5">
        <span className="text-[13px] font-semibold text-gray-800">Jev check {c && <span className="font-normal text-gray-500">· {c.id}</span>}</span>
        <span className="flex items-baseline gap-3">
          {!c && <span className="text-red-700">{parsed.error}</span>}
          {live && !live.enabled && (
            <span className="text-[12px] font-normal text-amber-800">not live yet
              <button onClick={() => writeText(ytext, (t) => setCheckFields(t, [{ path: ['enabled'], value: true }]))}
                className="ml-2 rounded bg-amber-700 px-2 py-0.5 text-white hover:bg-amber-800">Enable</button></span>
          )}
          <NewCheckButton />
        </span>
      </header>

      {c && live && (
        <div className="space-y-3 px-4 py-3">
          {draft ? <DraftBar onSave={() => writeText(ytext, saveDraft)} onDiscard={() => writeText(ytext, discardDraft)} />
            : <div className="text-[12px] text-gray-400">Edits here make a draft beside the live check; the live check changes only when you Save.</div>}
          <Field label="Question" value={c.question} live={live.question} onCommit={set(['question'])} hint={keyHint(c.question)} />
          <Field label="Yes means" value={c.criteria?.true ?? ''} live={live.criteria?.true ?? ''} onCommit={set(['criteria', 'true'])} />
          <Field label="No means" value={c.criteria?.false ?? ''} live={live.criteria?.false ?? ''} onCommit={set(['criteria', 'false'])} />
          <div className="flex flex-wrap items-end gap-4 text-[13px] text-gray-600">
            <Small label="model" value={c.model} live={live.model} onCommit={set(['model'])} width="w-28" />
            <Small label="fail at" value={String(c.fail_at)} live={String(live.fail_at)} onCommit={setNum(['fail_at'])} width="w-14" />
            <Small label="pass below" value={String(c.pass_below)} live={String(live.pass_below)} onCommit={setNum(['pass_below'])} width="w-14" />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-4 border-t border-gray-100 bg-gray-50/60 px-4 py-2.5 text-[13px] text-gray-600">
        <label>sample <input type="number" min={1} max={pool?.length ?? 1000} value={n}
          onChange={(e) => setN(Math.max(1, parseInt(e.target.value || '1', 10)))} className="ml-1 w-20 rounded border border-gray-200 px-1.5 py-0.5" />
          {pool && <span className="text-gray-400"> / {pool.length}</span>}</label>
        <label className="min-w-[240px] flex-1">percentiles
          <input value={pctSpec} onChange={(e) => setPctSpec(e.target.value)} title='a list like [0, 0.5, 1], or "9 even"'
            className={`ml-1 w-[calc(100%-5.5rem)] rounded border px-1.5 py-0.5 font-mono text-xs ${pcts.error ? 'border-red-400' : 'border-gray-200'}`} /></label>
        <button onClick={run} disabled={running || !c || !pool?.length || !!pcts.error} title="Ctrl/Cmd+Enter"
          className="rounded-md bg-gray-900 px-4 py-1.5 font-medium text-white hover:bg-gray-700 disabled:opacity-40">{running ? 'Asking jev…' : 'Run'}</button>
        <label>colours <select value={cmap} onChange={(e) => setCmap(e.target.value as ColormapName)} className="ml-1 rounded border border-gray-200">
          {Object.keys(COLORMAPS).map((k) => <option key={k}>{k}</option>)}</select></label>
        {corpus.meta && pool && (
          <InputPicker meta={corpus.meta} pool={pool} n={n} courses={corpus.courses} kinds={corpus.kinds}
            onCourses={corpus.setCourses} onKinds={corpus.setKinds} />
        )}
      </div>

      {err && <div className="px-4 py-2 text-red-700">{err}</div>}
      {latest && (
        <div className="px-4 pb-4 pt-3">
          {stale && <div className="mb-2 rounded bg-amber-50 px-2 py-1 text-amber-800">The check changed since this run. Run again to see the new phrasing.</div>}
          <Summary run={latest} base={result?.base} band={band} onBand={(b) => setBand(band === b ? null : b)} />
          <Histogram run={latest} color={color} />
          {band
            ? <BandList run={latest} band={band} color={color} onClear={() => setBand(null)} />
            : <Percentiles run={latest} pcts={pcts.ok ?? []} color={color} />}
        </div>
      )}
    </section>
  );
}

function DraftBar({ onSave, onDiscard }: { onSave: () => void; onDiscard: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
      <span className="flex-1">This file has a draft. Run tests it beside the live check; nothing else uses it until you Save.</span>
      <button onClick={onDiscard} className="rounded border border-amber-300 px-3 py-1 hover:bg-amber-100">Discard draft</button>
      <button onClick={onSave} className="rounded bg-amber-700 px-3 py-1 font-medium text-white hover:bg-amber-800">Save as live</button>
    </div>
  );
}
