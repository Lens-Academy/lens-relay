import { useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { LENS_EDITOR_ORIGIN } from '../../lib/relay-api';
import { useDisplayName } from '../../contexts/DisplayNameContext';
import { HtmlSourceEditor } from './HtmlSourceEditor';
import { HtmlPreview } from './HtmlPreview';
import { OrphanedCommentsPanel } from './OrphanedCommentsPanel';
import { NewCommentCard } from '../CommentMargin/NewCommentCard';
import { addComment, parseComments } from './comment-store';
import type { Candidate, ProbeRunner } from './position-finder';

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

function makeCommentId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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
  const [pendingCandidates, setPendingCandidates] = useState<Candidate[] | null>(null);
  const [manualComposer, setManualComposer] = useState<{
    position: number;
    point: { x: number; y: number };
    source: string;
  } | null>(null);
  const pendingSourceRef = useRef<string | null>(null);
  const sourceWrapperRef = useRef<HTMLDivElement>(null);
  const activePendingCandidates = !readOnly && commentMode ? pendingCandidates : null;

  useEffect(() => {
    const syncFromSource = () => {
      const source = ytext.toString();
      const existingCommentIds = new Set(parseComments(source).map(cluster => cluster.comment.id));
      setOrphanedIds(ids => ids.filter(id => existingCommentIds.has(id)));
      if (pendingSourceRef.current !== null && pendingSourceRef.current !== source) {
        pendingSourceRef.current = null;
        setPendingCandidates(null);
        setManualComposer(null);
      }
      setManualComposer(composer => (composer && composer.source !== source ? null : composer));
    };
    syncFromSource();
    ytext.observe(syncFromSource);
    return () => ytext.unobserve(syncFromSource);
  }, [ytext]);

  useEffect(() => {
    if (commentMode && !readOnly) return;
    pendingSourceRef.current = null;
    // Must clear immediately so a rapid off/on toggle cannot cancel stale pending placement cleanup.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPendingCandidates(null);
    setManualComposer(null);
  }, [commentMode, readOnly]);

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
          <div ref={sourceWrapperRef} className="relative min-w-0 flex-1">
            <HtmlSourceEditor
              ytext={ytext}
              awareness={awareness}
              readOnly={readOnly}
              highlightRanges={activePendingCandidates?.map(candidate => ({
                from: candidate.position,
                to: Math.min(candidate.position + 10, ytext.toString().length),
              }))}
              onClickAtPosition={(position, point) => {
                if (!activePendingCandidates) return;
                const rect = sourceWrapperRef.current?.getBoundingClientRect();
                const localPoint = rect
                  ? { x: point.x - rect.left, y: point.y - rect.top }
                  : point;
                setManualComposer({ position, point: localPoint, source: ytext.toString() });
                pendingSourceRef.current = null;
                setPendingCandidates(null);
              }}
            />
            {manualComposer && !readOnly && commentMode && (
              <NewCommentCard
                onSubmit={(body) => {
                  if (readOnly || !commentMode) {
                    setManualComposer(null);
                    return;
                  }
                  if (manualComposer.source !== ytext.toString()) {
                    setManualComposer(null);
                    return;
                  }
                  addComment(ytext, LENS_EDITOR_ORIGIN, {
                    id: makeCommentId(),
                    author: currentUser,
                    ts: new Date().toISOString(),
                    body,
                    position: manualComposer.position,
                  });
                  setManualComposer(null);
                  setCommentMode(false);
                }}
                onCancel={() => {
                  setManualComposer(null);
                  setCommentMode(false);
                }}
                style={{
                  position: 'absolute',
                  top: Math.max(8, manualComposer.point.y),
                  left: Math.max(8, manualComposer.point.x),
                  width: 320,
                  zIndex: 20,
                }}
              />
            )}
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
              onManualPlacement={(candidates) => {
                if (readOnly || !commentMode) return;
                setMode('source');
                pendingSourceRef.current = ytext.toString();
                setPendingCandidates(candidates);
                setManualComposer(null);
              }}
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
