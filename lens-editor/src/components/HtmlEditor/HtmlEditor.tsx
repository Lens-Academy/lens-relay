import { useState } from 'react';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { HtmlSourceEditor } from './HtmlSourceEditor';
import { HtmlPreview } from './HtmlPreview';

type Mode = 'source' | 'preview' | 'split';

interface HtmlEditorProps {
  ytext: Y.Text;
  awareness: Awareness;
}

const modes: Array<{ id: Mode; label: string }> = [
  { id: 'source', label: 'Source' },
  { id: 'preview', label: 'Preview' },
  { id: 'split', label: 'Split' },
];

export function HtmlEditor({ ytext, awareness }: HtmlEditorProps) {
  const [mode, setMode] = useState<Mode>('preview');

  return (
    <div className="flex h-full w-full flex-col bg-white">
      <div className="flex items-center gap-1 border-b border-gray-200 px-3 py-2">
        {modes.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-pressed={mode === id}
            onClick={() => setMode(id)}
            className={[
              'rounded px-3 py-1.5 text-sm font-medium transition-colors',
              mode === id
                ? 'bg-gray-900 text-white'
                : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900',
            ].join(' ')}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1">
        {mode !== 'preview' && (
          <div className="min-w-0 flex-1">
            <HtmlSourceEditor ytext={ytext} awareness={awareness} />
          </div>
        )}
        {mode !== 'source' && (
          <div className={mode === 'split' ? 'min-w-0 flex-1 border-l border-gray-200' : 'min-w-0 flex-1'}>
            <HtmlPreview ytext={ytext} />
          </div>
        )}
      </div>
    </div>
  );
}
