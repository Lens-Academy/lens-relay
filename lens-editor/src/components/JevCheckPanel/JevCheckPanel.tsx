// Check workbench: shown above a Lens Edu/Checks/*.md file. The words being tuned
// (question, what yes means, what no means) are edited here and written back into the
// file's frontmatter, so the file stays the only source. Run asks jev over a stable sample
// of course paragraphs; each run is compared with the one before it.
import { useEffect, useMemo, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { histogram, parseCheck, parsePercentiles, percentileRows, setCheckFields, type JevCheck } from '../../lib/jev-check';

interface Para { id: string; page: string; text: string }
interface Scored extends Para { p: number }
interface Run { check: JevCheck; scored: Scored[]; cached: number }

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

function writeFields(ytext: Y.Text, edits: { path: string[]; value: string | number }[]) {
  const before = ytext.toString();
  const after = setCheckFields(before, edits);
  if (after === before) return;
  // Replace only the changed span, so collaborators' cursors in the body are untouched.
  let a = 0;
  while (a < before.length && before[a] === after[a]) a++;
  let b = 0;
  while (b < before.length - a && before[before.length - 1 - b] === after[after.length - 1 - b]) b++;
  ytext.doc!.transact(() => {
    ytext.delete(a, before.length - a - b);
    ytext.insert(a, after.slice(a, after.length - b));
  });
}

/** A field that edits locally and writes to the file when you pause or leave it. */
function Field({ label, value, onCommit, rows = 2, mono = false }: { label: string; value: string; onCommit: (v: string) => void; rows?: number; mono?: boolean }) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => { if (!focused.current) setDraft(value); }, [value]);
  const commit = (v: string) => { window.clearTimeout(timer.current); if (v !== value) onCommit(v); };
  return (
    <label className="block">
      <span className="block text-[11px] font-medium uppercase tracking-wide text-gray-500">{label}</span>
      <textarea
        value={draft} rows={rows}
        onFocus={() => { focused.current = true; }}
        onBlur={() => { focused.current = false; commit(draft); }}
        onChange={(e) => {
          setDraft(e.target.value);
          window.clearTimeout(timer.current);
          const v = e.target.value;
          timer.current = window.setTimeout(() => commit(v), 800);
        }}
        className={`mt-1 w-full resize-y rounded-md border border-gray-200 bg-white px-3 py-2 leading-relaxed text-gray-900 focus:border-gray-400 focus:outline-none ${mono ? 'font-mono text-xs' : 'text-[15px]'}`}
      />
    </label>
  );
}

export function JevCheckPanel({ ytext }: { ytext: Y.Text }) {
  const text = useLiveText(ytext);
  const parsed = useMemo((): { check?: JevCheck; error?: string } => {
    try { return { check: parseCheck(text) }; } catch (e: any) { return { error: e.message }; }
  }, [text]);
  const [corpus, setCorpus] = useState<Para[] | null>(null);
  const [n, setN] = useState(200);
  const [pctSpec, setPctSpec] = useState(DEFAULT_PCTS);
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState<Run[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/jev/corpus').then((r) => r.json()).then((rows: Para[]) =>
      setCorpus([...rows].sort((a, b) => fnv(a.id) - fnv(b.id))),
    ).catch((e) => setErr(`corpus: ${e.message}`));
  }, []);

  const pcts = useMemo(() => { try { return { ps: parsePercentiles(pctSpec) }; } catch (e: any) { return { error: e.message as string }; } }, [pctSpec]);

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
      setRuns((rs) => [{ check, cached: data.cached, scored: sample.map((s, i) => ({ ...s, p: data.ps[i] })) }, ...rs].slice(0, 2));
    } catch (e: any) { setErr(e.message); } finally { setRunning(false); }
  }

  const c = parsed.check;
  const set = (path: string[]) => (v: string) => writeFields(ytext, [{ path, value: v }]);
  const setNum = (path: string[]) => (v: string) => { const x = Number(v); if (Number.isFinite(x)) writeFields(ytext, [{ path, value: x }]); };
  const latest = runs[0];
  const stale = latest && c && JSON.stringify(latest.check) !== JSON.stringify(c);

  return (
    <section className="mx-6 my-4 rounded-lg border border-gray-200 bg-white text-sm shadow-sm" data-testid="jev-check-panel"
      onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); } }}>
      <header className="flex items-baseline justify-between border-b border-gray-100 px-4 py-2.5">
        <span className="text-[13px] font-semibold text-gray-800">Jev check {c ? <span className="font-normal text-gray-500">· {c.id}</span> : null}</span>
        {!c && <span className="text-red-700">{parsed.error}</span>}
      </header>
      {c && (
        <div className="space-y-3 px-4 py-3">
          <Field label="Question" value={c.question} onCommit={set(['question'])} rows={2} />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Yes means" value={c.criteria?.true ?? ''} onCommit={set(['criteria', 'true'])} rows={4} />
            <Field label="No means" value={c.criteria?.false ?? ''} onCommit={set(['criteria', 'false'])} rows={4} />
          </div>
          <div className="flex flex-wrap items-end gap-4 text-[13px] text-gray-600">
            <Small label="model" value={c.model} onCommit={set(['model'])} width="w-28" />
            <Small label="fail at" value={String(c.fail_at)} onCommit={setNum(['fail_at'])} width="w-14" />
            <Small label="pass below" value={String(c.pass_below)} onCommit={setNum(['pass_below'])} width="w-14" />
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-4 border-t border-gray-100 bg-gray-50/60 px-4 py-2.5 text-[13px] text-gray-600">
        <label>sample <input type="number" min={1} max={corpus?.length ?? 1000} value={n}
          onChange={(e) => setN(Math.max(1, parseInt(e.target.value || '1', 10)))} className="ml-1 w-20 rounded border border-gray-200 px-1.5 py-0.5" />
          {corpus && <span className="text-gray-400"> / {corpus.length}</span>}</label>
        <label className="min-w-[240px] flex-1">percentiles
          <input value={pctSpec} onChange={(e) => setPctSpec(e.target.value)} title='a list like [0, 0.5, 1], or "9 even"'
            className={`ml-1 w-[calc(100%-5.5rem)] rounded border px-1.5 py-0.5 font-mono text-xs ${pcts.error ? 'border-red-400' : 'border-gray-200'}`} /></label>
        <button onClick={run} disabled={running || !c || !corpus || !!pcts.error} title="Ctrl/Cmd+Enter"
          className="rounded-md bg-gray-900 px-4 py-1.5 font-medium text-white hover:bg-gray-700 disabled:opacity-40">{running ? 'Asking jev…' : 'Run'}</button>
      </div>
      {err && <div className="px-4 py-2 text-red-700">{err}</div>}
      {latest && (
        <div className="px-4 pb-4 pt-3">
          {stale && <div className="mb-2 rounded bg-amber-50 px-2 py-1 text-amber-800">The check changed since this run. Run again to see the new phrasing.</div>}
          <Summary run={latest} prev={runs[1]} />
          <Histogram run={latest} />
          <Percentiles run={latest} pcts={pcts.ps ?? []} />
        </div>
      )}
    </section>
  );
}

function Small({ label, value, onCommit, width }: { label: string; value: string; onCommit: (v: string) => void; width: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label>{label}
      <input value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => draft !== value && onCommit(draft)}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        className={`ml-1.5 ${width} rounded border border-gray-200 px-1.5 py-0.5 font-mono text-xs`} />
    </label>
  );
}

function shares(run: Run) {
  const { check, scored } = run;
  const fail = scored.filter((s) => s.p >= check.fail_at).length;
  const pass = scored.filter((s) => s.p < check.pass_below).length;
  const k = scored.length;
  return { fail: fail / k, unsure: (k - fail - pass) / k, pass: pass / k };
}

function Summary({ run, prev }: { run: Run; prev?: Run }) {
  const now = shares(run);
  const before = prev && prev.scored.length === run.scored.length ? shares(prev) : null;
  const cell = (name: 'fail' | 'unsure' | 'pass', tone: string) => (
    <div className="flex-1 rounded-md border border-gray-100 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-gray-500">{name}</div>
      <div className={`text-lg font-semibold tabular-nums ${tone}`}>{Math.round(100 * now[name])}%</div>
      {before && <div className="text-[11px] tabular-nums text-gray-400">was {Math.round(100 * before[name])}%</div>}
    </div>
  );
  return (
    <div>
      <div className="flex gap-2">{cell('fail', 'text-gray-900')}{cell('unsure', 'text-gray-600')}{cell('pass', 'text-gray-400')}</div>
      <div className="mt-1 text-[11px] text-gray-400">{run.scored.length} paragraphs, {run.cached} from cache</div>
    </div>
  );
}

function Histogram({ run }: { run: Run }) {
  const bins = histogram(run.scored.map((s) => s.p), 20);
  const max = Math.max(...bins, 1);
  const { pass_below: lo, fail_at: hi } = run.check;
  return (
    <div className="relative mt-4 h-28" aria-label="histogram of p(yes)">
      <div className="absolute inset-y-0 border-l border-dashed border-gray-300" style={{ left: `${lo * 100}%` }} />
      <div className="absolute inset-y-0 border-l border-dashed border-gray-400" style={{ left: `${hi * 100}%` }} />
      <div className="absolute inset-y-0 bg-gray-100/70" style={{ left: `${lo * 100}%`, width: `${(hi - lo) * 100}%` }} />
      <div className="relative flex h-24 items-end gap-px">
        {bins.map((b, i) => (
          <div key={i} title={`${(i / 20).toFixed(2)}–${((i + 1) / 20).toFixed(2)}: ${b}`} className="flex-1 rounded-t-sm bg-gray-700" style={{ height: `${(100 * b) / max}%`, opacity: b ? 1 : 0 }} />
        ))}
      </div>
      <div className="relative mt-1 h-4 text-[10px] text-gray-400">
        <span className="absolute left-0">0</span>
        <span className="absolute -translate-x-1/2" style={{ left: `${lo * 100}%` }}>pass &lt; {lo}</span>
        <span className="absolute -translate-x-1/2" style={{ left: `${hi * 100}%` }}>fail ≥ {hi}</span>
        <span className="absolute right-0">1</span>
      </div>
    </div>
  );
}

function Percentiles({ run, pcts }: { run: Run; pcts: number[] }) {
  return (
    <ol className="mt-4 divide-y divide-gray-100 border-t border-gray-100">
      {percentileRows(run.scored, pcts).map(({ at, item }) => (
        <li key={`${at}-${item.id}`} className="grid grid-cols-[3.5rem_3.5rem_1fr] gap-3 py-2">
          <span className="font-mono text-[11px] text-gray-400">{at}</span>
          <span className="flex items-start gap-1.5 font-mono text-xs tabular-nums text-gray-800">
            {item.p.toFixed(2)}
          </span>
          <ParaText text={item.text} page={item.page} />
        </li>
      ))}
    </ol>
  );
}

function ParaText({ text, page }: { text: string; page: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 280;
  return (
    <div className="min-w-0">
      <div className={`whitespace-pre-wrap text-[13px] leading-relaxed text-gray-800 ${long ? 'cursor-pointer' : ''}`} onClick={() => long && setOpen(!open)}>
        {long && !open ? text.slice(0, 280) + '…' : text}
      </div>
      <div className="mt-0.5 truncate text-[10px] text-gray-400">{page}</div>
    </div>
  );
}
