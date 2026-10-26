// The runs of this visit as a row of chips: click one to show it. A run over a different sample
// of paragraphs than the one shown is marked, since its numbers do not compare.
import type { Run } from './types';
import type { RunEntry } from './runs';

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
/** What jev saw, short: "paragraph alone", or "document › paragraph" (shown › asked about). */
const seen = (r: Run) => { const ctx = r.pres?.match(/jev sees each (\w+)/)?.[1]; return !ctx || ctx === r.unit ? `${r.unit ?? 'paragraph'} alone` : `${ctx} › ${r.unit}`; };

export function RunChips({ runs, shown, onShow }: { runs: RunEntry[]; shown: number; onShow: (i: number) => void }) {
  if (runs.length < 2) return null;
  const sample = runs[shown].run.sample;
  return (
    <div className="mb-2 flex flex-wrap gap-1.5" aria-label="runs">
      {runs.map((e, i) => {
        const other = e.run.sample !== sample;
        return (
          <button key={i} onClick={() => onShow(i)} aria-pressed={i === shown}
            title={`${e.draft ? 'draft' : 'live check'}: ${e.run.check.question}\n${e.run.pres ?? ''}${other ? '\nanother sample: its numbers do not compare with the run shown' : ''}`}
            className={`max-w-[16rem] truncate rounded border px-2 py-0.5 text-left text-[11px] ${i === shown ? 'border-gray-800 bg-gray-800 text-white' : 'border-gray-200 text-gray-600 hover:border-gray-400'} ${other ? 'border-dashed' : ''}`}>
            <span className="font-mono">#{i + 1}</span> {e.draft ? 'draft' : 'live'} · {seen(e.run)} · {clip(e.run.check.question, 32)}
            {other && <span className="text-amber-600"> · other sample</span>}
          </button>
        );
      })}
    </div>
  );
}
