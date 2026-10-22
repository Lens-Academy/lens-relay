// Inputs for the check's fields. Each edits locally and writes to the file when you pause or leave it.
import { useState } from 'react';
import { keyRuns, type Shape } from '../../lib/jev-keys';

const DEBOUNCE_MS = 800;

const chip = (ok: boolean) => `rounded ring-1 ${ok ? 'bg-sky-100 ring-sky-300' : 'bg-amber-100 ring-amber-400'}`;
// The textarea and its highlight layer share one grid cell and one text style, so the chips sit under the words.
const layer = 'col-start-1 row-start-1 whitespace-pre-wrap break-words px-3 py-2 text-[15px] leading-relaxed';

/** A growing textarea that shows `backticked` names as chips, amber with the reason listed
 *  below when jev's input (`shape`) cannot resolve them. `live`, when given and different, is
 *  the live check's text, shown under the field. */
export function Field({ label, value, live, onCommit, hint, shape }: { label: string; value: string; live?: string; onCommit: (v: string) => void; hint?: string; shape: Shape }) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const [seen, setSeen] = useState(value);
  const [timer, setTimer] = useState<number | undefined>(undefined);
  // Follow the file's value while not being edited here (React's "adjust state on a prop change").
  if (value !== seen) { setSeen(value); if (!focused) setDraft(value); }
  const commit = (v: string) => { window.clearTimeout(timer); if (v !== value) onCommit(v); };
  const runs = keyRuns(draft, shape);
  const problems = [...new Map(runs.filter((r) => r.problem).map((r) => [r.t, r.problem!])).entries()];
  const change = (v: string) => {
    setDraft(v);
    window.clearTimeout(timer);
    setTimer(window.setTimeout(() => commit(v), DEBOUNCE_MS));
  };
  return (
    <label className="block">
      <span className="flex items-baseline justify-between text-[11px] font-medium uppercase tracking-wide text-gray-500">
        <span>{label}{live !== undefined && live !== value && <span className="ml-2 rounded bg-amber-100 px-1 normal-case tracking-normal text-amber-800">draft</span>}</span>
        {/* Problems sit in this one line (full text on hover), so typing never moves the page. */}
        {(problems.length > 0 || hint) && (
          <span className="ml-3 min-w-0 truncate normal-case tracking-normal text-amber-700" title={[...problems.map(([t, why]) => `${t}: ${why}`), ...(hint ? [hint] : [])].join('\n')}>
            {problems.length ? `${problems[0][0]} ${problems[0][1]}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ''}` : hint}</span>
        )}
      </span>
      <div className="mt-1 grid rounded-md border border-gray-200 bg-white focus-within:border-gray-400">
        <div aria-hidden className={`${layer} text-transparent`}>
          {runs.map((r, i) => <span key={i} className={r.key ? chip(!r.problem) : undefined}>{r.t}</span>)}{' '}
        </div>
        <textarea value={draft} onChange={(e) => change(e.target.value)}
          onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); commit(draft); }}
          className={`${layer} resize-none overflow-hidden bg-transparent text-gray-900 focus:outline-none`} />
      </div>
      {live !== undefined && live !== value && <div className="mt-1 px-3 text-[12px] leading-relaxed text-gray-400 line-through decoration-gray-300">{live}</div>}
    </label>
  );
}

/** A one-line input that writes on blur or Enter. */
export function Small({ label, value, live, onCommit, width }: { label: string; value: string; live?: string; onCommit: (v: string) => void; width: string }) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) { setSeen(value); setDraft(value); }
  return (
    <label>{label}
      <input value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => draft !== value && onCommit(draft)}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        className={`ml-1.5 ${width} rounded border px-1.5 py-0.5 font-mono text-xs ${live !== undefined && live !== value ? 'border-amber-400 bg-amber-50' : 'border-gray-200'}`}
        title={live !== undefined && live !== value ? `live: ${live}` : undefined} />
    </label>
  );
}
