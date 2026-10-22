// What jev is shown and what it is asked about (presentation.ts), plus a switch to show the
// first request exactly as sent.
import { LEVELS, type Level, type Mode, type UnitKind } from '../../lib/jev-present';
import type { Presentation } from './presentation';

const MODES: [Mode, string][] = [['isolated', 'the unit alone'], ['raw', 'whole file, markdown'], ['parsed', 'whole file, parsed JSON']];

export function PresentationPicker({ value, onChange, showSent, onShowSent }: {
  value: Presentation; onChange: (p: Presentation) => void; showSent: boolean; onShowSent: (b: boolean) => void;
}) {
  const toggle = (l: Level) => onChange({ ...value, levels: value.levels.includes(l) ? value.levels.filter((x) => x !== l) : LEVELS.filter((x) => x === l || value.levels.includes(x)) });
  return (
    <span className="flex flex-wrap items-end gap-3">
      <label>jev sees <select value={value.mode} onChange={(e) => onChange({ ...value, mode: e.target.value as Mode })} className="ml-1 rounded border border-gray-200">
        {MODES.map(([m, label]) => <option key={m} value={m}>{label}</option>)}</select></label>
      <label>asked about each <select value={value.unit} onChange={(e) => onChange({ ...value, unit: e.target.value as UnitKind })} className="ml-1 rounded border border-gray-200">
        <option value="paragraph">paragraph</option><option value="sentence">sentence</option></select></label>
      {value.mode === 'parsed' && (
        <span title="levels kept in the parsed document; the asked-about level is always kept">
          {LEVELS.map((l) => (
            <label key={l} className="mr-2"><input type="checkbox" checked={value.levels.includes(l) || l === value.unit} disabled={l === value.unit}
              onChange={() => toggle(l)} className="mr-0.5" />{l}</label>
          ))}
        </span>
      )}
      {value.mode !== 'isolated' && (
        <label title="Shows jev the whole file in one request (up to ~262k tokens) instead of in chunks. TypeSafe: slower and less accurate.">
          <input type="checkbox" checked={!!value.long} onChange={(e) => onChange({ ...value, long: e.target.checked })} className="mr-1" />long context (uncertified)</label>
      )}
      <label><input type="checkbox" checked={showSent} onChange={(e) => onShowSent(e.target.checked)} className="mr-1" />show what jev gets</label>
    </span>
  );
}
