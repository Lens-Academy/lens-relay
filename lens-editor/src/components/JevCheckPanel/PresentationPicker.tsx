// The three presentation choices (lib/jev-presentation.ts): how much jev sees, what each question is
// about, and which levels in between nest the JSON; plus a switch to show the first request sent.
import { between, LEVELS, rank, type Level, type Presentation } from '../../lib/jev-presentation';

const select = 'ml-1 rounded border border-gray-200';

export function PresentationPicker({ value, onChange, showSent, onShowSent }: {
  value: Presentation; onChange: (p: Presentation) => void; showSent: boolean; onShowSent: (b: boolean) => void;
}) {
  const setContext = (context: Level) => onChange({ ...value, context, question: rank(value.question) < rank(context) ? context : value.question });
  const toggle = (l: Level) => onChange({ ...value, nest: value.nest.includes(l) ? value.nest.filter((x) => x !== l) : LEVELS.filter((x) => x === l || value.nest.includes(x)) });
  return (
    <span className="flex flex-wrap items-end gap-3">
      <label>jev sees each <select aria-label="jev sees" value={value.context} onChange={(e) => setContext(e.target.value as Level)} className={select}>
        {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}</select></label>
      <label>asked about each <select aria-label="asked about each" value={value.question} onChange={(e) => onChange({ ...value, question: e.target.value as Level })} className={select}>
        {LEVELS.filter((l) => rank(l) >= rank(value.context)).map((l) => <option key={l} value={l}>{l}</option>)}</select></label>
      {between(value).length > 0 && (
        <span title="levels between the two that nest the JSON jev is shown; off levels add no layer of keys">
          nested by {between(value).map((l) => (
            <label key={l} className="mr-2"><input type="checkbox" checked={value.nest.includes(l)} onChange={() => toggle(l)} className="mr-0.5" />{l}</label>
          ))}
        </span>
      )}
      {value.context !== value.question && (
        <label title="Shows jev each context whole (up to ~262k tokens) instead of in chunks that fit. TypeSafe: slower and less accurate.">
          <input type="checkbox" checked={!!value.long} onChange={(e) => onChange({ ...value, long: e.target.checked })} className="mr-1" />long context (uncertified)</label>
      )}
      <label><input type="checkbox" checked={showSent} onChange={(e) => onShowSent(e.target.checked)} className="mr-1" />show what jev gets</label>
    </span>
  );
}
