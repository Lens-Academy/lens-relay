// One paragraph: its score, its text (click to edit it in its source file), its kind and a link to that file.
import { SourceParagraph } from './SourceParagraph';
import { useNavigation } from '../../contexts/NavigationContext';
import { urlForDoc } from '../../lib/url-utils';
import { RELAY_ID } from '../../App';
import type { Colormap, Para } from './types';

export function ScoreChip({ p, color }: { p: number; color: Colormap }) {
  return (
    <span className="self-start rounded px-1.5 py-0.5 text-center font-mono text-xs tabular-nums"
      style={{ background: color(p), color: p > 0.6 ? '#111' : '#fff' }}>{p.toFixed(2)}</span>
  );
}

/** The lowest and highest of jev's answers to one request; amber when they fall in different
 *  bands, so the verdict is down to chance. */
export function Spread({ samples, wobbly }: { samples?: number[]; wobbly: boolean }) {
  if (!samples || samples.length < 2) return null;
  const lo = Math.min(...samples), hi = Math.max(...samples);
  return (
    <span title={`jev's ${samples.length} answers: ${samples.map((x) => x.toFixed(2)).join(', ')}${wobbly ? ', in different bands' : ''}`}
      className={`font-mono text-[10px] tabular-nums ${wobbly ? 'text-amber-600' : 'text-gray-400'}`}>{lo.toFixed(2)}–{hi.toFixed(2)}</span>
  );
}

function SourceLink({ para }: { para: Para }) {
  const { metadata } = useNavigation();
  const id = metadata?.['/' + para.path]?.id;
  const label = `${para.title ? para.title + ' · ' : ''}${para.path.replace(/^Lens Edu\//, '')}:${para.line}`;
  if (!id) return <span>{label}</span>;
  return <a href={urlForDoc(`${RELAY_ID}-${id}`, metadata)} target="_blank" rel="noreferrer"
    className="hover:text-gray-700 hover:underline">{label}</a>;
}

export function ParaText({ para }: { para: Para }) {
  return (
    <div className="min-w-0">
      <SourceParagraph para={para} />
      <div className="mt-0.5 truncate text-[10px] text-gray-400">
        <span className="mr-1 rounded bg-gray-100 px-1">{para.kind}</span><SourceLink para={para} />
      </div>
    </div>
  );
}
