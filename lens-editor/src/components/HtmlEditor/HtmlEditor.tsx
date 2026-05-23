import { useEffect, useState } from 'react';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { LENS_EDITOR_ORIGIN } from '../../lib/relay-api';
import { useDisplayName } from '../../contexts/DisplayNameContext';
import { HtmlSourceEditor } from './HtmlSourceEditor';
import { HtmlPreview } from './HtmlPreview';
import { OrphanedCommentsPanel } from './OrphanedCommentsPanel';
import { parseComments } from './comment-store';
import type { ProbeRunner } from './position-finder';

type Mode = 'source' | 'preview' | 'split';

interface HtmlEditorProps {
  ytext: Y.Text;
  awareness: Awareness;
  currentUser?: string;
  readOnly?: boolean;
  probeRunner?: ProbeRunner;
}

const modes: Array<{ id: Mode; label: string }> = [
  { id: 'source', label: 'Source' },
  { id: 'preview', label: 'Preview' },
  { id: 'split', label: 'Split' },
];

export function HtmlEditor({
  ytext,
  awareness,
  currentUser: currentUserProp,
  readOnly = false,
  probeRunner,
}: HtmlEditorProps) {
  const { displayName } = useDisplayName();
  const currentUser = currentUserProp ?? displayName ?? 'Anonymous';
  const [mode, setMode] = useState<Mode>('preview');
  const [commentMode, setCommentMode] = useState(false);
  const [orphanedIds, setOrphanedIds] = useState<string[]>([]);

  useEffect(() => {
    const pruneOrphans = () => {
      const existingCommentIds = new Set(parseComments(ytext.toString()).map(cluster => cluster.comment.id));
      setOrphanedIds(ids => ids.filter(id => existingCommentIds.has(id)));
    };
    pruneOrphans();
    ytext.observe(pruneOrphans);
    return () => ytext.unobserve(pruneOrphans);
  }, [ytext]);

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
        {!readOnly && (
          <button
            type="button"
            aria-label="Comment mode"
            aria-pressed={commentMode}
            onClick={() => setCommentMode(active => !active)}
            className={[
              'ml-2 rounded px-3 py-1.5 text-sm font-medium transition-colors',
              commentMode
                ? 'bg-amber-500 text-white'
                : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900',
            ].join(' ')}
          >
            Comment
          </button>
        )}
        {orphanedIds.length > 0 && (
          <span className="ml-2 rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
            {orphanedIds.length} orphan{orphanedIds.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {mode !== 'preview' && (
          <div className="min-w-0 flex-1">
            <HtmlSourceEditor ytext={ytext} awareness={awareness} readOnly={readOnly} />
          </div>
        )}
        {mode !== 'source' && (
          <div className={mode === 'split' ? 'min-w-0 flex-1 border-l border-gray-200' : 'min-w-0 flex-1'}>
            <HtmlPreview
              ytext={ytext}
              currentUser={currentUser}
              origin={LENS_EDITOR_ORIGIN}
              isCommentMode={commentMode && !readOnly}
              onOrphanedChange={setOrphanedIds}
              onPlaceComplete={() => setCommentMode(false)}
              probeRunner={probeRunner}
              readOnly={readOnly}
            />
          </div>
        )}
        <OrphanedCommentsPanel
          ytext={ytext}
          orphanedIds={orphanedIds}
          onJumpToSource={() => setMode('source')}
        />
      </div>
    </div>
  );
}
