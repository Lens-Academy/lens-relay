// Check workbench: shown above a Lens Edu/Checks/*.md file. The words being tuned
// (question, what yes means, what no means) are edited here and written back into the
// file's frontmatter, so the file stays the only source. Run asks jev over a stable sample
// of course paragraphs; each run is compared with the one before it.
import { useEffect, useMemo, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { histogram, parseCheck, parsePercentiles, percentileRows, setCheckFields, type JevCheck } from '../../lib/jev-check';
import { COLORMAPS, type ColormapName } from '../../lib/colormaps';

interface Para { id: string; page: string; course: string; text: string }
interface CorpusMeta { title: string; taken: string; source: string; sampling: string; courses: Record<string, { paragraphs: number; pages: number }> }

// The keys of the state jev is shown. Backticked names in a question refer to these keys.
const STATE_KEYS = ['paragraph'];
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

/** Split text into plain runs and `backticked` names, marking names that are not state keys. */
function keyRuns(text: string) {
  return text.split(/(`[^`\n]*`)/).map((t) => {
    const m = t.match(/^`([^`]*)`$/);
    return m ? { t, key: true, known: STATE_KEYS.includes(m[1]) } : { t, key: false, known: false };
  });
}

/** A field that edits locally and writes to the file when you pause or leave it. It grows
 *  with its text, and shows `backticked` names (jev reads them as keys of its input) as chips. */
function Field({ label, value, onCommit, hint }: { label: string; value: string; onCommit: (v: string) => void; hint?: string }) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => { if (!focused.current) setDraft(value); }, [value]);
  const commit = (v: string) => { window.clearTimeout(timer.current); if (v !== value) onCommit(v); };
  const box = 'col-start-1 row-start-1 whitespace-pre-wrap break-words px-3 py-2 text-[15px] leading-relaxed';
  return (
    <label className="block">
      <span className="flex items-baseline justify-between text-[11px] font-medium uppercase tracking-wide text-gray-500">
        {label}{hint && <span className="normal-case tracking-normal text-amber-700">{hint}</span>}
      </span>
      <div className="mt-1 grid rounded-md border border-gray-200 bg-white focus-within:border-gray-400">
        <div aria-hidden className={`${box} text-transparent`}>
          {keyRuns(draft).map((r, i) => r.key
            ? <span key={i} className={`rounded ${r.known ? 'bg-sky-100 ring-1 ring-sky-300' : 'bg-red-100 ring-1 ring-red-300'}`}>{r.t}</span>
            : <span key={i}>{r.t}</span>)}{' '}
        </div>
        <textarea
          value={draft}
          onFocus={() => { focused.current = true; }}
          onBlur={() => { focused.current = false; commit(draft); }}
          onChange={(e) => {
            setDraft(e.target.value);
            window.clearTimeout(timer.current);
            const v = e.target.value;
            timer.current = window.setTimeout(() => commit(v), 800);
          }}
          className={`${box} resize-none overflow-hidden bg-transparent text-gray-900 focus:outline-none`}
        />
      </div>
    </label>
  );
}

/** What the question needs to say about the state, as a hint above the field. */
function keyHint(text: string): string | undefined {
  const runs = keyRuns(text).filter((r) => r.key);
  if (!runs.some((r) => r.known)) return `jev only knows the text as \`${STATE_KEYS[0]}\`; name it in backticks`;
  if (runs.some((r) => !r.known)) return `jev's input has only ${STATE_KEYS.map((k) => '`' + k + '`').join(', ')}`;
  return undefined;
}

export function JevCheckPanel({ ytext }: { ytext: Y.Text }) {
  const text = useLiveText(ytext);
  const parsed = useMemo((): { check?: JevCheck; error?: string } => {
    try { return { check: parseCheck(text) }; } catch (e: any) { return { error: e.message }; }
  }, [text]);
  const [corpus, setCorpus] = useState<Para[] | null>(null);
  const [meta, setMeta] = useState<CorpusMeta | null>(null);
  const [cmap, setCmap] = useState<ColormapName>('inferno');
  const [n, setN] = useState(200);
  const [pctSpec, setPctSpec] = useState(DEFAULT_PCTS);
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState<Run[]>([]);
  const [band, setBand] = useState<Band | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/jev/corpus').then((r) => r.json()).then((d: { meta: CorpusMeta; rows: Para[] }) => {
      setMeta(d.meta);
      setCorpus([...d.rows].sort((a, b) => fnv(a.id) - fnv(b.id)));
    }).catch((e) => setErr(`corpus: ${e.message}`));
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
          <Field label="Question" value={c.question} onCommit={set(['question'])} hint={keyHint(c.question)} />
          <Field label="Yes means" value={c.criteria?.true ?? ''} onCommit={set(['criteria', 'true'])} />
          <Field label="No means" value={c.criteria?.false ?? ''} onCommit={set(['criteria', 'false'])} />
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
        <label>colours <select value={cmap} onChange={(e) => setCmap(e.target.value as ColormapName)} className="ml-1 rounded border border-gray-200">
          {Object.keys(COLORMAPS).map((k) => <option key={k}>{k}</option>)}</select></label>
        {meta && corpus && <CorpusInfo meta={meta} corpus={corpus} n={n} />}
      </div>
      {err && <div className="px-4 py-2 text-red-700">{err}</div>}
      {latest && (
        <div className="px-4 pb-4 pt-3">
          {stale && <div className="mb-2 rounded bg-amber-50 px-2 py-1 text-amber-800">The check changed since this run. Run again to see the new phrasing.</div>}
          <Summary run={latest} prev={runs[1]} band={band} onBand={(b) => setBand(band === b ? null : b)} />
          <Histogram run={latest} color={COLORMAPS[cmap]} />
          {band
            ? <BandList run={latest} band={band} color={COLORMAPS[cmap]} onClear={() => setBand(null)} />
            : <Percentiles run={latest} pcts={pcts.ps ?? []} color={COLORMAPS[cmap]} />}
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

type Band = 'fail' | 'unsure' | 'pass';

function bandOf(check: JevCheck, p: number): Band {
  return p >= check.fail_at ? 'fail' : p < check.pass_below ? 'pass' : 'unsure';
}

function bandRule(check: JevCheck, b: Band) {
  return b === 'fail' ? `p ≥ ${check.fail_at}` : b === 'pass' ? `p < ${check.pass_below}` : `${check.pass_below} ≤ p < ${check.fail_at}`;
}

function shares(run: Run) {
  const k = run.scored.length;
  const out = { fail: 0, unsure: 0, pass: 0 };
  for (const s of run.scored) out[bandOf(run.check, s.p)] += 1 / k;
  return out;
}

function Summary({ run, prev, band, onBand }: { run: Run; prev?: Run; band: Band | null; onBand: (b: Band) => void }) {
  const now = shares(run);
  const before = prev && prev.scored.length === run.scored.length ? shares(prev) : null;
  const cell = (name: Band, tone: string) => (
    <button onClick={() => onBand(name)} title={band === name ? 'show percentiles again' : `list the ${name} paragraphs`}
      className={`flex-1 rounded-md border px-3 py-2 text-left transition-colors ${band === name ? 'border-gray-500 bg-gray-50' : 'border-gray-100 hover:border-gray-300'}`}>
      <div className="flex items-baseline justify-between text-[11px] uppercase tracking-wide text-gray-500">
        {name}<span className="font-mono normal-case tracking-normal text-gray-300">{bandRule(run.check, name)}</span>
      </div>
      <div className={`text-lg font-semibold tabular-nums ${tone}`}>{Math.round(100 * now[name])}%</div>
      {before && <div className="text-[11px] tabular-nums text-gray-400">was {Math.round(100 * before[name])}%</div>}
    </button>
  );
  return (
    <div>
      <div className="flex gap-2">{cell('fail', 'text-gray-900')}{cell('unsure', 'text-gray-600')}{cell('pass', 'text-gray-400')}</div>
      <div className="mt-1 text-[11px] text-gray-400">{run.scored.length} paragraphs, {run.cached} from cache</div>
    </div>
  );
}

function BandList({ run, band, color, onClear }: { run: Run; band: Band; color: (p: number) => string; onClear: () => void }) {
  const items = run.scored.filter((s) => bandOf(run.check, s.p) === band).sort((a, b) => b.p - a.p);
  return (
    <div className="mt-4 border-t border-gray-100">
      <div className="flex items-baseline justify-between py-2 text-[12px] text-gray-500">
        <span>{items.length} {band} paragraphs ({bandRule(run.check, band)}), highest first</span>
        <button onClick={onClear} className="text-gray-400 hover:text-gray-700">show percentiles</button>
      </div>
      <ol className="divide-y divide-gray-100">
        {items.map((item) => (
          <li key={item.id} className="grid grid-cols-[3.5rem_1fr] gap-3 py-2">
            <span className="self-start rounded px-1.5 py-0.5 text-center font-mono text-xs tabular-nums" style={{ background: color(item.p), color: item.p > 0.6 ? '#111' : '#fff' }}>{item.p.toFixed(2)}</span>
            <ParaText text={item.text} page={item.page} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function Histogram({ run, color }: { run: Run; color: (p: number) => string }) {
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
          <div key={i} title={`${(i / 20).toFixed(2)}–${((i + 1) / 20).toFixed(2)}: ${b}`} className="flex-1 rounded-t-sm" style={{ height: `${(100 * b) / max}%`, opacity: b ? 1 : 0, background: color((i + 0.5) / 20) }} />
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

function Percentiles({ run, pcts, color }: { run: Run; pcts: number[]; color: (p: number) => string }) {
  return (
    <ol className="mt-4 divide-y divide-gray-100 border-t border-gray-100">
      {percentileRows(run.scored, pcts).map(({ at, item }) => (
        <li key={`${at}-${item.id}`} className="grid grid-cols-[3.5rem_3.5rem_1fr] gap-3 py-2">
          <span className="font-mono text-[11px] text-gray-400">{at}</span>
          <span className="self-start rounded px-1.5 py-0.5 text-center font-mono text-xs tabular-nums" style={{ background: color(item.p), color: item.p > 0.6 ? '#111' : '#fff' }}>
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

/** What the sample is, so it can be understood without knowing how it was made. */
function CorpusInfo({ meta, corpus, n }: { meta: CorpusMeta; corpus: Para[]; n: number }) {
  const inSample: Record<string, number> = {};
  for (const p of corpus.slice(0, n)) inSample[p.course] = (inSample[p.course] ?? 0) + 1;
  return (
    <details className="w-full text-[12px] text-gray-600">
      <summary className="cursor-pointer text-gray-500">
        {Math.min(n, corpus.length)} of {corpus.length} paragraphs from a {meta.taken} snapshot of {Object.keys(meta.courses).length} live courses: what is this?
      </summary>
      <div className="mt-2 space-y-1.5 leading-relaxed">
        <p>{meta.source} {meta.sampling}</p>
        <p>The paragraphs are in one fixed shuffled order, so the first N are the same on every run, and a larger N only adds paragraphs.</p>
        <table className="text-[12px]"><tbody>
          {Object.entries(meta.courses).map(([course, c]) => (
            <tr key={course}><td className="pr-4">{course}</td><td className="pr-4 tabular-nums">{inSample[course] ?? 0} in this sample</td>
              <td className="tabular-nums text-gray-400">{c.paragraphs} paragraphs from {c.pages} pages</td></tr>
          ))}
        </tbody></table>
      </div>
    </details>
  );
}
