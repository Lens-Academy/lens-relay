// One paragraph: its score, its text (click to expand), its kind and a link to its source file.
import { useState } from 'react';
import { useNavigation } from '../../contexts/NavigationContext';
import { urlForDoc } from '../../lib/url-utils';
import { RELAY_ID } from '../../App';
import type { Colormap, Para } from './types';

const CUT = 280;

export function ScoreChip({ p, color }: { p: number; color: Colormap }) {
  return (
    <span className="self-start rounded px-1.5 py-0.5 text-center font-mono text-xs tabular-nums"
      style={{ background: color(p), color: p > 0.6 ? '#111' : '#fff' }}>{p.toFixed(2)}</span>
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
  const [open, setOpen] = useState(false);
  const long = para.text.length > CUT;
  return (
    <div className="min-w-0">
      <div className={`whitespace-pre-wrap text-[13px] leading-relaxed text-gray-800 ${long ? 'cursor-pointer' : ''}`}
        onClick={() => long && setOpen(!open)}>
        {long && !open ? para.text.slice(0, CUT) + '…' : para.text}
      </div>
      <div className="mt-0.5 truncate text-[10px] text-gray-400">
        <span className="mr-1 rounded bg-gray-100 px-1">{para.kind}</span><SourceLink para={para} />
      </div>
    </div>
  );
}
