import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { LENS_EDITOR_ORIGIN } from '../../lib/relay-api';
import { useDisplayName } from '../../contexts/DisplayNameContext';
import { useHeaderCommentsControl } from '../../contexts/HeaderActionsContext';
import { useMobile } from '../../contexts/MobileContext';
import { MobileDrawer } from '../Mobile/MobileDrawer';
import { MobileCommentsSheet, type PendingCommentAction } from '../Mobile/MobileCommentsSheet';
import { HtmlSourceEditor } from './HtmlSourceEditor';
import { HtmlPreview } from './HtmlPreview';
import { NewCommentCard } from './NewCommentCard';
import { addComment, parseComments } from './comment-store';
import { CommentsLayer, type CommentsLayerHandle } from '../Comments/CommentsLayer';
import {
  useThreadsFromHtmlYText,
  makeIframeScrollSource,
  effectiveY,
  type AnchorState,
  type IframeScrollState,
} from './htmlCommentsAdapter';
import type { Candidate, ProbeRunner } from './position-finder';
import type { PageProblem } from './bridge/protocol';
import { SCRIPT_HOSTS } from './runtime/page-runtime';

type Mode = 'source' | 'preview' | 'split';
type PreviewWidth = 'desktop' | 'phone';

interface HtmlEditorProps {
  ytext: Y.Text;
  awareness: Awareness;
  currentUser?: string;
  readOnly?: boolean;
  probeRunner?: ProbeRunner;
  /** Stable document id; keys the page's per-viewer localStorage. */
  storageKey?: string;
}

const SCRIPT_HOST_NAMES = SCRIPT_HOSTS.map(host => host.replace('https://', '')).join(', ');

/** `?view=source` opens the document in Source mode: the way back in when a
 *  page hangs the preview. */
function initialMode(): Mode {
  if (typeof window === 'undefined') return 'preview';
  return new URLSearchParams(window.location.search).get('view') === 'source' ? 'source' : 'preview';
}

const modes: Array<{ id: Mode; label: string }> = [
  { id: 'source', label: 'Source' },
  { id: 'preview', label: 'Preview' },
  { id: 'split', label: 'Split' },
];

const COMMENTS_VISIBLE_KEY = 'lens-html-editor-comments-visible';
const PREVIEW_WIDTH_KEY = 'lens-html-editor-preview-width';
/** Width of the phone preview: a common phone viewport in CSS pixels. */
const PHONE_PREVIEW_WIDTH = 390;

const widths: Array<{ id: PreviewWidth; label: string; title: string }> = [
  { id: 'desktop', label: 'Desktop', title: 'Preview at full width' },
  { id: 'phone', label: 'Phone', title: `Preview at phone width (${PHONE_PREVIEW_WIDTH}px)` },
];

function readPreviewWidth(): PreviewWidth {
  try {
    return localStorage.getItem(PREVIEW_WIDTH_KEY) === 'phone' ? 'phone' : 'desktop';
  } catch {
    return 'desktop';
  }
}

const PROBLEM_LABELS: Record<PageProblem['kind'], string> = {
  error: 'Error',
  blocked: 'Blocked',
  'load-failed': 'Not loaded',
  overflow: 'Too wide',
};

function describeProblem(problem: PageProblem): string {
  const count = problem.count > 1 ? ` (×${problem.count})` : '';
  return `${problem.message}${problem.source ? ` — ${problem.source}` : ''}${count}`;
}

function readCommentsVisible(): boolean {
  if (typeof localStorage === 'undefined') return true;
  const raw = localStorage.getItem(COMMENTS_VISIBLE_KEY);
  if (raw === null) return true;
  return raw === 'true';
}

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
  storageKey,
}: HtmlEditorProps) {
  const { displayName } = useDisplayName();
  const currentUser = currentUserProp ?? displayName ?? 'Anonymous';
  const [mode, setMode] = useState<Mode>(initialMode);
  const [commentMode, setCommentMode] = useState(false);
  const [commentsVisible, setCommentsVisible] = useState(readCommentsVisible);
  const [previewWidth, setPreviewWidthState] = useState<PreviewWidth>(readPreviewWidth);
  const [pageProblems, setPageProblems] = useState<PageProblem[]>([]);
  const [problemsOpen, setProblemsOpen] = useState(false);

  const setPreviewWidth = useCallback((next: PreviewWidth) => {
    setPreviewWidthState(next);
    try {
      localStorage.setItem(PREVIEW_WIDTH_KEY, next);
    } catch {
      // Not persisted; the choice still applies for this session.
    }
  }, []);

  const handleToggleComments = useCallback(() => {
    setCommentsVisible(prev => {
      const next = !prev;
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(COMMENTS_VISIBLE_KEY, String(next));
      }
      return next;
    });
  }, []);

  // On a phone the desktop comment margin would leave the page a sliver of the
  // screen; comments open in a bottom sheet instead, as in the Markdown editor.
  const { isMobile, activeDrawer, openDrawer, closeDrawer, toggleDrawer } = useMobile();
  const [pendingCommentAction, setPendingCommentAction] = useState<PendingCommentAction>(null);
  const toggleCommentsSheet = useCallback(() => toggleDrawer('comments'), [toggleDrawer]);
  const commentsSheetOpen = activeDrawer === 'comments';
  // Remount the sheet for each dot tap so a tap during its close animation
  // (sheet still mounted) is not swallowed.
  const [commentsSheetEpoch, setCommentsSheetEpoch] = useState(0);
  // The width toggle is hidden on a phone, where the preview already is phone width.
  const phonePreview = previewWidth === 'phone' && !isMobile;

  const commentsControl = useMemo(() => (isMobile
    ? {
      isOpen: commentsSheetOpen,
      onToggle: toggleCommentsSheet,
      title: commentsSheetOpen ? 'Hide comments' : 'Show comments',
    }
    : {
      isOpen: commentsVisible,
      onToggle: handleToggleComments,
      title: commentsVisible ? 'Hide comments' : 'Show comments',
    }), [commentsSheetOpen, commentsVisible, handleToggleComments, isMobile, toggleCommentsSheet]);

  useHeaderCommentsControl(commentsControl);
  const [pendingCandidates, setPendingCandidates] = useState<Candidate[] | null>(null);
  const [manualComposer, setManualComposer] = useState<{
    position: number;
    point: { x: number; y: number };
    source: string;
  } | null>(null);
  const pendingSourceRef = useRef<string | null>(null);
  const sourceWrapperRef = useRef<HTMLDivElement>(null);
  const activePendingCandidates = !readOnly && commentMode ? pendingCandidates : null;

  // --- CommentsLayer integration ---
  const commentsLayerRef = useRef<CommentsLayerHandle>(null);
  const previewWrapperRef = useRef<HTMLDivElement>(null);

  const [anchorState, setAnchorState] = useState<AnchorState>(() => new Map());
  const baselineScrollYRef = useRef(0);
  const currentScrollYRef = useRef(0);
  const layoutVersionRef = useRef(0);

  const iframeScrollStateRef = useRef<IframeScrollState>({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 });
  const scrollSource = useMemo(() => makeIframeScrollSource(() => iframeScrollStateRef.current), []);

  const [focusedCommentId, setFocusedCommentId] = useState<string | null>(null);

  const { threads, callbacks } = useThreadsFromHtmlYText(ytext, anchorState, currentUser);

  const resolveAnchorY = (key: string): number | null => {
    const r = anchorState.get(key);
    if (!r) return null;
    const iframeTop = previewWrapperRef.current?.getBoundingClientRect().top ?? 0;
    return effectiveY(r, baselineScrollYRef.current, currentScrollYRef.current, iframeTop);
  };

  const getViewportRect = () => {
    const r = previewWrapperRef.current?.getBoundingClientRect();
    return { top: r?.top ?? 0, height: r?.height ?? 0 };
  };

  // Derive orphan count from threads for the toolbar badge
  const orphanCount = threads.filter(t => t.orphan).length;

  useEffect(() => {
    const syncFromSource = () => {
      const source = ytext.toString();
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

  const portalTarget = typeof document === 'undefined'
    ? null
    : document.getElementById('header-controls');

  const headerControls = (
    <div className="flex items-center gap-3">
      <div
        role="group"
        aria-label="HTML view mode"
        className="inline-flex items-center rounded bg-gray-200 p-0.5"
      >
        {modes.filter(({ id }) => !(isMobile && id === 'split')).map(({ id, label }) => {
          const active = mode === id;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={active}
              onClick={() => setMode(id)}
              className={[
                'rounded px-3 py-1 text-xs font-medium transition-colors',
                active
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700',
              ].join(' ')}
            >
              {label}
            </button>
          );
        })}
      </div>
      {mode !== 'source' && (
        <div
          role="group"
          aria-label="Preview width"
          className="hidden items-center rounded bg-gray-200 p-0.5 sm:inline-flex"
        >
          {widths.map(({ id, label, title }) => {
            const active = previewWidth === id;
            return (
              <button
                key={id}
                type="button"
                title={title}
                aria-pressed={active}
                onClick={() => setPreviewWidth(id)}
                className={[
                  'rounded px-3 py-1 text-xs font-medium transition-colors',
                  active
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700',
                ].join(' ')}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
      {mode !== 'source' && pageProblems.length > 0 && (
        <button
          type="button"
          aria-expanded={problemsOpen}
          aria-controls="html-page-problems"
          onClick={() => setProblemsOpen(open => !open)}
          className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-200"
        >
          {pageProblems.length} page problem{pageProblems.length === 1 ? '' : 's'}
        </button>
      )}
      {orphanCount > 0 && (
        <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
          {orphanCount} orphan{orphanCount === 1 ? '' : 's'}
        </span>
      )}
    </div>
  );

  return (
    <div className="flex h-full w-full flex-col bg-white">
      {portalTarget && createPortal(headerControls, portalTarget)}

      <div className="flex min-h-0 flex-1 overflow-hidden">
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
          <div
            ref={previewWrapperRef}
            className={[
              'relative min-w-0 flex-1',
              mode === 'split' ? 'border-l border-gray-200' : '',
              phonePreview ? 'flex justify-center overflow-x-auto bg-gray-100' : '',
            ].join(' ')}
          >
            {problemsOpen && pageProblems.length > 0 && (
              <div
                id="html-page-problems"
                role="region"
                aria-label="Page problems"
                className="absolute right-3 top-3 z-30 max-h-[50%] w-[min(28rem,calc(100%-1.5rem))] overflow-y-auto rounded border border-amber-200 bg-white p-3 text-xs shadow-lg"
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="font-semibold text-gray-900">Reported by the page</span>
                  <button
                    type="button"
                    onClick={() => setProblemsOpen(false)}
                    className="rounded px-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-800"
                  >
                    Close
                  </button>
                </div>
                <ul className="flex flex-col gap-1.5">
                  {pageProblems.map((problem, index) => (
                    <li key={index} className="break-words text-gray-700">
                      <span className="mr-1 font-medium text-amber-800">
                        {PROBLEM_LABELS[problem.kind]}
                      </span>
                      {describeProblem(problem)}
                    </li>
                  ))}
                </ul>
                {pageProblems.some(problem => problem.kind === 'blocked') && (
                  <p className="mt-2 text-gray-500">
                    Pages can load scripts only from {SCRIPT_HOST_NAMES}. See Lens/AI Guide/HTML Pages.
                  </p>
                )}
              </div>
            )}
            <div
              className={phonePreview
                ? 'box-content h-full flex-shrink-0 border-x border-gray-300 bg-white shadow-sm'
                : 'h-full w-full'}
              style={phonePreview ? { width: PHONE_PREVIEW_WIDTH } : undefined}
              data-preview-width={phonePreview ? 'phone' : 'desktop'}
            >
            <HtmlPreview
              ytext={ytext}
              currentUser={currentUser}
              origin={LENS_EDITOR_ORIGIN}
              isCommentMode={commentMode && !readOnly}
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
              onDotClicked={(id) => {
                if (isMobile) {
                  setPendingCommentAction({ type: 'focus', key: id });
                  setCommentsSheetEpoch(epoch => epoch + 1);
                  openDrawer('comments');
                  return;
                }
                setFocusedCommentId(prev => (prev === id ? null : id));
                commentsLayerRef.current?.toggleFocus(id);
              }}
              onCommentAdded={(id) => {
                setFocusedCommentId(id);
                commentsLayerRef.current?.focusThread(id);
              }}
              onCommentsRendered={(payload) => {
                const newState = new Map<string, { y: number; x: number; w: number; h: number }>();
                for (const r of payload.rects) newState.set(r.id, { y: r.y, x: r.x, w: r.w, h: r.h });
                setAnchorState(newState);
                baselineScrollYRef.current = payload.baselineScrollY;
                layoutVersionRef.current = payload.layoutVersion;
                scrollSource.notify();
              }}
              onScrollState={(payload) => {
                if (payload.layoutVersion !== layoutVersionRef.current) return;
                currentScrollYRef.current = payload.y;
                iframeScrollStateRef.current = {
                  scrollTop: payload.y,
                  scrollHeight: payload.scrollHeight,
                  clientHeight: payload.clientHeight,
                };
                scrollSource.notify();
              }}
              focusedCommentId={focusedCommentId}
              storageKey={storageKey}
              onPageProblems={setPageProblems}
            />
            </div>
          </div>
        )}
        {mode !== 'source' && commentsVisible && !isMobile && (
          <div className="w-80 flex-shrink-0 border-l border-gray-200 bg-gray-50/50 relative overflow-hidden">
            <CommentsLayer
              ref={commentsLayerRef}
              threads={threads}
              resolveAnchorY={resolveAnchorY}
              getViewportRect={getViewportRect}
              scrollSource={scrollSource}
              onFocusChange={(key) => setFocusedCommentId(key)}
              onReply={callbacks.onReply}
              onEdit={callbacks.onEdit}
              onDelete={callbacks.onDelete}
            />
          </div>
        )}
      </div>
      {isMobile && (
        <MobileDrawer open={commentsSheetOpen} onClose={closeDrawer} side="bottom" label="Comments">
          <MobileCommentsSheet
            key={commentsSheetEpoch}
            threads={threads}
            pendingAction={pendingCommentAction}
            onPendingActionConsumed={() => setPendingCommentAction(null)}
            onReply={callbacks.onReply}
            onEdit={callbacks.onEdit}
            onDelete={callbacks.onDelete}
          />
        </MobileDrawer>
      )}
    </div>
  );
}
