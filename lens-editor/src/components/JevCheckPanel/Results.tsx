// A run's results: the band cards, the histogram, and either the percentile rows or one band's list.
import { BANDS, bandOf, bandRule, histogram, percentileRows, shares, type Band } from '../../lib/jev-check';
import { ParaText, ScoreChip } from './ParaText';

const unitsOf = (run: Run) => (run.pres?.endsWith('sentence') ? 'sentences' : 'paragraphs');
import type { Colormap, Run } from './types';

const BINS = 20;
const TONE: Record<Band, string> = { fail: 'text-gray-900', unsure: 'text-gray-600', pass: 'text-gray-400' };
const pct = (x: number) => `${Math.round(100 * x)}%`;

/** fail / unsure / pass as cards: this run's share, the rule, and the share in `base` (the live check
 *  when a draft ran, else the previous run). Click a card to list that band. */
export function Summary({ run, base, band, onBand }: { run: Run; base?: { label: string; run: Run }; band: Band | null; onBand: (b: Band) => void }) {
  const now = shares(run.check, run.scored.map((s) => s.p));
  const before = base && base.run.scored.length === run.scored.length ? shares(base.run.check, base.run.scored.map((s) => s.p)) : null;
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {BANDS.map((b) => (
          <button key={b} onClick={() => onBand(b)} title={band === b ? 'show percentiles again' : `list the ${b} ${unitsOf(run)}`}
            className={`min-w-[6.5rem] flex-1 rounded-md border px-2.5 py-2 text-left ${band === b ? 'border-gray-500 bg-gray-50' : 'border-gray-100 hover:border-gray-300'}`}>
            <div className="whitespace-nowrap text-[11px] uppercase tracking-wide text-gray-500">{b}</div>
            <div className="whitespace-nowrap font-mono text-[10px] text-gray-400">{bandRule(run.check, b)}</div>
            <div className={`text-lg font-semibold tabular-nums ${TONE[b]}`}>{pct(now[b])}</div>
            {before && <div className="text-[11px] tabular-nums text-gray-400">{base!.label} {pct(before[b])}</div>}
          </button>
        ))}
      </div>
      <div className="mt-1 text-[11px] text-gray-400">{run.scored.length} {unitsOf(run)}, {run.cached} from cache</div>
    </div>
  );
}

/** Scores in 20 bins, coloured by the colour map, with the unsure band shaded between its thresholds. */
export function Histogram({ run, color }: { run: Run; color: Colormap }) {
  const bins = histogram(run.scored.map((s) => s.p), BINS);
  const max = Math.max(...bins, 1);
  const { pass_below: lo, fail_at: hi } = run.check;
  const at = (x: number) => ({ left: `${x * 100}%` });
  return (
    <div className="relative mt-4 h-28" aria-label="histogram of p(yes)">
      <div className="absolute inset-y-0 bg-gray-100/70" style={{ ...at(lo), width: `${(hi - lo) * 100}%` }} />
      <div className="absolute inset-y-0 border-l border-dashed border-gray-300" style={at(lo)} />
      <div className="absolute inset-y-0 border-l border-dashed border-gray-400" style={at(hi)} />
      <div className="relative flex h-24 items-end gap-px">
        {bins.map((b, i) => (
          <div key={i} title={`${(i / BINS).toFixed(2)}–${((i + 1) / BINS).toFixed(2)}: ${b}`} className="flex-1 rounded-t-sm"
            style={{ height: `${(100 * b) / max}%`, opacity: b ? 1 : 0, background: color((i + 0.5) / BINS) }} />
        ))}
      </div>
      <div className="relative mt-1 h-4 text-[10px] text-gray-400">
        <span className="absolute left-0">0</span>
        <span className="absolute -translate-x-1/2" style={at(lo)}>pass &lt; {lo}</span>
        <span className="absolute -translate-x-1/2" style={at(hi)}>fail ≥ {hi}</span>
        <span className="absolute right-0">1</span>
      </div>
    </div>
  );
}

/** The paragraph at each chosen percentile of the scores. */
export function Percentiles({ run, pcts, color }: { run: Run; pcts: number[]; color: Colormap }) {
  return (
    <ol className="mt-4 divide-y divide-gray-100 border-t border-gray-100">
      {percentileRows(run.scored, pcts).map(({ at, item }) => (
        <li key={`${at}-${item.id}`} className="grid grid-cols-[3.5rem_3.5rem_1fr] gap-3 py-2">
          <span className="font-mono text-[11px] text-gray-400">{at}</span>
          <ScoreChip p={item.p} color={color} />
          <ParaText para={item} />
        </li>
      ))}
    </ol>
  );
}

/** Every paragraph in one band, highest score first. */
export function BandList({ run, band, color, onClear }: { run: Run; band: Band; color: Colormap; onClear: () => void }) {
  const items = run.scored.filter((s) => bandOf(run.check, s.p) === band).sort((a, b) => b.p - a.p);
  return (
    <div className="mt-4 border-t border-gray-100">
      <div className="flex items-baseline justify-between py-2 text-[12px] text-gray-500">
        <span>{items.length} {band} {unitsOf(run)} ({bandRule(run.check, band)}), highest first</span>
        <button onClick={onClear} className="text-gray-400 hover:text-gray-700">show percentiles</button>
      </div>
      <ol className="divide-y divide-gray-100">
        {items.map((item) => (
          <li key={item.id} className="grid grid-cols-[3.5rem_1fr] gap-3 py-2">
            <ScoreChip p={item.p} color={color} />
            <ParaText para={item} />
          </li>
        ))}
      </ol>
    </div>
  );
}
