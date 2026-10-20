// Inputs for the check's fields. Each edits locally and writes to the file when you pause or leave it.
import { useEffect, useRef, useState } from 'react';

// The keys of the state jev is shown. Backticked names in a question refer to these keys.
const STATE_KEYS = ['paragraph'];
const DEBOUNCE_MS = 800;

/** Plain runs and `backticked` names, marking names that are not state keys. */
function keyRuns(text: string) {
  return text.split(/(`[^`\n]*`)/).map((t) => {
    const m = t.match(/^`([^`]*)`$/);
    return { t, key: !!m, known: !!m && STATE_KEYS.includes(m[1]) };
  });
}

/** What the question must say about jev's input, or nothing if it already does. */
export function keyHint(text: string): string | undefined {
  const keys = keyRuns(text).filter((r) => r.key);
  if (!keys.some((r) => r.known)) return `jev only knows the text as \`${STATE_KEYS[0]}\`; name it in backticks`;
  if (keys.some((r) => !r.known)) return `jev's input has only ${STATE_KEYS.map((k) => '`' + k + '`').join(', ')}`;
}

const chip = (known: boolean) => `rounded ring-1 ${known ? 'bg-sky-100 ring-sky-300' : 'bg-red-100 ring-red-300'}`;
// The textarea and its highlight layer share one grid cell and one text style, so the chips sit under the words.
const layer = 'col-start-1 row-start-1 whitespace-pre-wrap break-words px-3 py-2 text-[15px] leading-relaxed';

/** A growing textarea that shows `backticked` names as chips. */
export function Field({ label, value, onCommit, hint }: { label: string; value: string; onCommit: (v: string) => void; hint?: string }) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => { if (!focused.current) setDraft(value); }, [value]);
  const commit = (v: string) => { window.clearTimeout(timer.current); if (v !== value) onCommit(v); };
  const change = (v: string) => {
    setDraft(v);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => commit(v), DEBOUNCE_MS);
  };
  return (
    <label className="block">
      <span className="flex items-baseline justify-between text-[11px] font-medium uppercase tracking-wide text-gray-500">
        {label}{hint && <span className="normal-case tracking-normal text-amber-700">{hint}</span>}
      </span>
      <div className="mt-1 grid rounded-md border border-gray-200 bg-white focus-within:border-gray-400">
        <div aria-hidden className={`${layer} text-transparent`}>
          {keyRuns(draft).map((r, i) => <span key={i} className={r.key ? chip(r.known) : undefined}>{r.t}</span>)}{' '}
        </div>
        <textarea value={draft} onChange={(e) => change(e.target.value)}
          onFocus={() => { focused.current = true; }} onBlur={() => { focused.current = false; commit(draft); }}
          className={`${layer} resize-none overflow-hidden bg-transparent text-gray-900 focus:outline-none`} />
      </div>
    </label>
  );
}

/** A one-line input that writes on blur or Enter. */
export function Small({ label, value, onCommit, width }: { label: string; value: string; onCommit: (v: string) => void; width: string }) {
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
