import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { useDisplayName } from '../../contexts/DisplayNameContext';
import { useHeaderCommentsControl } from '../../contexts/HeaderActionsContext';
import { useMobile } from '../../contexts/MobileContext';
import { MobileDrawer } from '../Mobile/MobileDrawer';
import { MobileCommentsSheet, type PendingCommentAction } from '../Mobile/MobileCommentsSheet';
import { HtmlSourceEditor } from './HtmlSourceEditor';
import { HtmlPreview, type HtmlPreviewHandle } from './HtmlPreview';
import { CommentsLayer, type CommentsLayerHandle, type DraftComment } from '../Comments/CommentsLayer';
import { CommentCard } from '../Comments/CommentCard';
import type { ThreadActions, ThreadView } from '../Comments/types';
import { makeIframeScrollSource, effectiveY, type IframeScrollState } from './htmlCommentsAdapter';
import { useHtmlComments } from './comments/useHtmlComments';
import { describeAnchorTarget, type HtmlAnchor } from './anchoring/types';
import type { AnchorCapture, PageProblem, Rect } from './bridge/protocol';
import { SCRIPT_HOSTS } from './runtime/page-runtime';

type Mode = 'source' | 'preview' | 'split';
type PreviewWidth = 'desktop' | 'phone';

interface HtmlEditorProps {
  ytext: Y.Text;
  awareness: Awareness;
  currentUser?: string;
  readOnly?: boolean;
  /** Stable document id; keys the page's per-viewer localStorage. */
  storageKey?: string;
}

const SCRIPT_HOST_NAMES = SCRIPT_HOSTS.map(host => host.replace('https://', '')).join(', ');
const DRAFT_KEY = '__draft__';

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
  try {
    const raw = localStorage.getItem(COMMENTS_VISIBLE_KEY);
    return raw === null ? true : raw === 'true';
  } catch {
    return true;
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || !!target.closest('.cm-editor');
}

interface Draft {
  anchor: HtmlAnchor;
  /** Viewport rect inside the frame when captured (until the page reports one). */
  rect: Rect;
  warning?: string;
}

const segmentButton = (active: boolean) => [
  'rounded px-3 py-1 text-xs font-medium transition-colors',
  active ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700',
].join(' ');

export function HtmlEditor({
  ytext,
  awareness,
  currentUser: currentUserProp,
  readOnly = false,
  storageKey,
}: HtmlEditorProps) {
  const { displayName } = useDisplayName();
  const currentUser = currentUserProp ?? displayName ?? 'Anonymous';
  const [mode, setMode] = useState<Mode>(initialMode);
  const [commentsVisible, setCommentsVisible] = useState(readCommentsVisible);
  const [previewWidth, setPreviewWidthState] = useState<PreviewWidth>(readPreviewWidth);
  const [pageProblems, setPageProblems] = useState<PageProblem[]>([]);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [showResolved, setShowResolved] = useState(false);

  // Comment mode: the next click or selection in the page picks a target.
  // `reattachId` makes it pick a new target for an existing thread instead.
  const [commentMode, setCommentMode] = useState(false);
  const [reattachId, setReattachId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  // Text typed into a composer that was cancelled, per target, so reopening
  // the same spot brings it back.
  const [unsent, setUnsent] = useState<Record<string, string>>({});
  const [unplacedOpen, setUnplacedOpen] = useState(false);
  // The "Comment" chip over a text selection, in preview-wrapper coordinates.
  const [selectionChip, setSelectionChip] = useState<{ left: number; top: number } | null>(null);
  const [focusedThreadId, setFocusedThreadId] = useState<string | null>(null);
  const canComment = !readOnly;

  const previewRef = useRef<HtmlPreviewHandle>(null);
  const describeLegacy = useCallback((ids: string[]) => previewRef.current?.describeLegacy(ids), []);
  const comments = useHtmlComments({ ytext, currentUser, canWrite: canComment, showResolved, describeLegacy });
  const { placements } = comments;

  const setPreviewWidth = useCallback((next: PreviewWidth) => {
    setPreviewWidthState(next);
    try {
      localStorage.setItem(PREVIEW_WIDTH_KEY, next);
    } catch {
      // Not persisted; the choice still applies for this session.
    }
  }, []);

  const setCommentsShown = useCallback((next: boolean) => {
    setCommentsVisible(next);
    try {
      localStorage.setItem(COMMENTS_VISIBLE_KEY, String(next));
    } catch {
      // Not persisted.
    }
  }, []);
  const handleToggleComments = useCallback(() => setCommentsShown(!commentsVisible), [commentsVisible, setCommentsShown]);

  // On a phone the desktop comment margin would leave the page a sliver of the
  // screen; comments open in a bottom sheet instead, as in the Markdown editor.
  const { isMobile, activeDrawer, openDrawer, closeDrawer, toggleDrawer } = useMobile();
  const [pendingCommentAction, setPendingCommentAction] = useState<PendingCommentAction>(null);
  const toggleCommentsSheet = useCallback(() => toggleDrawer('comments'), [toggleDrawer]);
  const commentsSheetOpen = activeDrawer === 'comments';
  // Remount the sheet for each request so a tap during its close animation
  // (sheet still mounted) is not swallowed.
  const [commentsSheetEpoch, setCommentsSheetEpoch] = useState(0);
  const openSheet = useCallback((action: PendingCommentAction) => {
    setPendingCommentAction(action);
    setCommentsSheetEpoch(epoch => epoch + 1);
    openDrawer('comments');
  }, [openDrawer]);
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

  // --- sidebar positioning -------------------------------------------
  const commentsLayerRef = useRef<CommentsLayerHandle>(null);
  const previewWrapperRef = useRef<HTMLDivElement>(null);
  const currentScrollYRef = useRef(0);
  const iframeScrollStateRef = useRef<IframeScrollState>({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 });
  const scrollSource = useMemo(() => makeIframeScrollSource(() => iframeScrollStateRef.current), []);
  useEffect(() => { scrollSource.notify(); }, [placements, scrollSource]);

  const frameTop = () => previewRef.current?.frameElement()?.getBoundingClientRect().top
    ?? previewWrapperRef.current?.getBoundingClientRect().top ?? 0;

  const resolveAnchorY = (key: string): number | null => {
    const top = frameTop();
    if (key === DRAFT_KEY) {
      const rect = placements.draft?.rect;
      if (rect) return effectiveY(rect, placements.baselineScrollY, currentScrollYRef.current, top);
      return draft ? top + draft.rect.y : null;
    }
    const rect = placements.byId.get(key)?.rect;
    if (!rect) return null;
    return effectiveY(rect, placements.baselineScrollY, currentScrollYRef.current, top);
  };

  const getViewportRect = () => {
    const r = previewWrapperRef.current?.getBoundingClientRect();
    return { top: r?.top ?? 0, height: r?.height ?? 0 };
  };

  // --- comment mode & drafts -------------------------------------------
  const exitCommentMode = useCallback(() => {
    setCommentMode(false);
    setReattachId(null);
  }, []);

  const startCommentMode = useCallback((forThread: string | null = null) => {
    if (!canComment) return;
    if (mode === 'source') setMode('preview');
    setReattachId(forThread);
    setCommentMode(true);
    setSelectionChip(null);
    if (isMobile) closeDrawer();
  }, [canComment, closeDrawer, isMobile, mode]);

  const handleAnchorCaptured = useCallback((capture: AnchorCapture) => {
    if (!canComment) return;
    setSelectionChip(null);
    if (reattachId) {
      comments.reanchor(reattachId, capture.anchor);
      setFocusedThreadId(reattachId);
      commentsLayerRef.current?.focusThread(reattachId);
      exitCommentMode();
      return;
    }
    setCommentMode(false);
    setDraft({ anchor: capture.anchor, rect: capture.rect, ...(capture.warning ? { warning: capture.warning } : {}) });
    if (isMobile) openSheet({ type: 'add', key: DRAFT_KEY });
    else if (!commentsVisible) setCommentsShown(true);
  }, [canComment, comments, commentsVisible, exitCommentMode, isMobile, openSheet, reattachId, setCommentsShown]);

  const submitDraft = useCallback((body: string) => {
    if (!draft) return;
    const key = JSON.stringify(draft.anchor);
    setUnsent(current => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    const id = comments.create(draft.anchor, body);
    setDraft(null);
    setFocusedThreadId(id);
    // The card mounts on the next render; focus it then.
    requestAnimationFrame(() => commentsLayerRef.current?.focusThread(id));
  }, [comments, draft]);

  const cancelDraft = useCallback((unsent?: string) => {
    if (draft && unsent?.trim()) {
      const key = JSON.stringify(draft.anchor);
      setUnsent(current => ({ ...current, [key]: unsent }));
    }
    setDraft(null);
  }, [draft]);

  // Leaving the preview (or losing write access) ends commenting.
  useEffect(() => {
    if (mode === 'source' || readOnly) {
      exitCommentMode();
      setDraft(null);
    }
  }, [exitCommentMode, mode, readOnly]);

  // `C` toggles Comment mode, Escape leaves it (when typing elsewhere, never).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      if (event.key === 'Escape' && commentMode) {
        exitCommentMode();
        return;
      }
      if ((event.key === 'c' || event.key === 'C') && canComment && mode !== 'source') {
        event.preventDefault();
        if (commentMode) exitCommentMode();
        else startCommentMode();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canComment, commentMode, exitCommentMode, mode, startCommentMode]);

  const focusThread = useCallback((id: string) => {
    if (isMobile) {
      openSheet({ type: 'focus', key: id });
      return;
    }
    const layer = commentsLayerRef.current;
    if (layer) {
      layer.toggleFocus(id);
      return;
    }
    // The margin is hidden: show it, then focus once it has mounted.
    setCommentsShown(true);
    setFocusedThreadId(id);
    requestAnimationFrame(() => commentsLayerRef.current?.focusThread(id));
  }, [isMobile, openSheet, setCommentsShown]);

  const actions = useMemo<ThreadActions | undefined>(() => (canComment ? {
    onResolve: (thread: ThreadView) => {
      comments.setStatus(thread.key, 'resolved');
      setFocusedThreadId(prev => (prev === thread.key ? null : prev));
    },
    onReopen: (thread: ThreadView) => comments.setStatus(thread.key, 'open'),
    onConfirmAnchor: (thread: ThreadView) => previewRef.current?.describeCurrent(thread.key),
    onReattach: (thread: ThreadView) => startCommentMode(thread.key),
  } : undefined), [canComment, comments, startCommentMode]);

  const onCurrentDescribed = useCallback((id: string, anchor: HtmlAnchor | null) => {
    if (anchor && canComment) comments.reanchor(id, anchor);
  }, [canComment, comments]);

  const onSelectionChanged = useCallback((rect: Rect | null) => {
    const frame = previewRef.current?.frameElement()?.getBoundingClientRect();
    const wrapper = previewWrapperRef.current?.getBoundingClientRect();
    if (!rect || !frame || !wrapper) {
      setSelectionChip(null);
      return;
    }
    const left = frame.left - wrapper.left + rect.x + rect.w / 2;
    const top = frame.top - wrapper.top + rect.y;
    setSelectionChip({ left: Math.max(40, Math.min(wrapper.width - 40, left)), top: Math.max(4, top - 34) });
  }, []);
  const showSelectionChip = selectionChip && canComment && !commentMode && !draft && mode !== 'source';

  const reattachOrder = reattachId ? comments.views.find(v => v.key === reattachId)?.order : undefined;
  const draftComment: DraftComment | null = draft ? {
    key: DRAFT_KEY,
    target: describeAnchorTarget(draft.anchor),
    ...(draft.warning ? { warning: draft.warning } : {}),
    initialText: unsent[JSON.stringify(draft.anchor)],
    onSubmit: submitDraft,
    onCancel: cancelDraft,
  } : null;

  const { counts } = comments;
  // Status chips belong with the page and its margin: not in Source mode,
  // and not in a phone's narrow header (the comments sheet shows them).
  const showCounts = mode !== 'source' && !isMobile;
  const placedViews = comments.views.filter(v => v.anchor?.state !== 'orphaned' && v.anchor?.state !== 'locating');
  const unplacedViews = comments.views.filter(v => v.anchor?.state === 'orphaned');
  const portalTarget = typeof document === 'undefined' ? null : document.getElementById('header-controls');

  const headerControls = (
    <div className="flex items-center gap-3">
      <div role="group" aria-label="HTML view mode" className="inline-flex items-center rounded bg-gray-200 p-0.5">
        {modes.filter(({ id }) => !(isMobile && id === 'split')).map(({ id, label }) => (
          <button key={id} type="button" aria-pressed={mode === id} onClick={() => setMode(id)} className={segmentButton(mode === id)}>
            {label}
          </button>
        ))}
      </div>
      {mode !== 'source' && (
        <div role="group" aria-label="Preview width" className="hidden items-center rounded bg-gray-200 p-0.5 sm:inline-flex">
          {widths.map(({ id, label, title }) => (
            <button
              key={id}
              type="button"
              title={title}
              aria-pressed={previewWidth === id}
              onClick={() => setPreviewWidth(id)}
              className={segmentButton(previewWidth === id)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {mode !== 'source' && canComment && (
        <button
          type="button"
          aria-pressed={commentMode}
          title={commentMode ? 'Stop commenting (Esc)' : 'Comment on the page: click text or an element, or select text (C)'}
          onClick={() => (commentMode ? exitCommentMode() : startCommentMode())}
          className={[
            'rounded px-2.5 py-1 text-xs font-medium transition-colors',
            commentMode ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-gray-200 text-gray-700 hover:bg-gray-300',
          ].join(' ')}
        >
          {commentMode ? 'Commenting…' : 'Comment'}
        </button>
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
      {showCounts && counts.orphaned > 0 && (
        <button
          type="button"
          aria-expanded={unplacedOpen}
          onClick={() => {
            if (!commentsVisible) setCommentsShown(true);
            setUnplacedOpen(open => !open);
          }}
          className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 hover:bg-red-200"
          title="Comments whose text is no longer on the page"
        >
          {counts.orphaned} not found
        </button>
      )}
      {showCounts && counts.guessed > 0 && (
        <span className="rounded bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-800" title="Comments that may have moved: check their spot">
          {counts.guessed} to check
        </span>
      )}
      {showCounts && counts.resolved > 0 && (
        <button
          type="button"
          aria-pressed={showResolved}
          onClick={() => setShowResolved(v => !v)}
          className="rounded px-2 py-0.5 text-xs font-medium text-gray-600 hover:bg-gray-100"
        >
          {showResolved ? 'Hide' : 'Show'} resolved ({counts.resolved})
        </button>
      )}
    </div>
  );

  const emptyHint = canComment
    ? 'No comments yet. Click Comment (or press C), then click text or an element in the page.'
    : 'No comments yet.';

  return (
    <div className="flex h-full w-full flex-col bg-white">
      {portalTarget && createPortal(headerControls, portalTarget)}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {mode !== 'preview' && (
          <div className="relative min-w-0 flex-1">
            <HtmlSourceEditor ytext={ytext} awareness={awareness} readOnly={readOnly} />
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
                      <span className="mr-1 font-medium text-amber-800">{PROBLEM_LABELS[problem.kind]}</span>
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
            {commentMode && (
              <div
                role="status"
                className="pointer-events-none absolute left-1/2 top-2 z-30 -translate-x-1/2 rounded-full bg-blue-600 px-3 py-1 text-xs font-medium text-white shadow"
              >
                {reattachId
                  ? `Pick the new spot for comment ${reattachOrder ?? ''} · ${isMobile ? 'tap Comment to cancel' : 'Esc to cancel'}`
                  : isMobile
                    ? 'Tap text or an element to comment'
                    : 'Click text or an element to comment, or select text · Esc to cancel'}
              </div>
            )}
            {showSelectionChip && (
              <button
                type="button"
                className="absolute z-30 -translate-x-1/2 rounded-md bg-gray-900 px-2.5 py-1 text-xs font-medium text-white shadow-lg hover:bg-gray-700"
                style={{ left: selectionChip.left, top: selectionChip.top }}
                onMouseDown={e => e.preventDefault()}
                onClick={() => previewRef.current?.captureSelection()}
              >
                Comment
              </button>
            )}
            <div
              className={phonePreview
                ? 'box-content h-full flex-shrink-0 border-x border-gray-300 bg-white shadow-sm'
                : 'h-full w-full'}
              style={phonePreview ? { width: PHONE_PREVIEW_WIDTH } : undefined}
              data-preview-width={phonePreview ? 'phone' : 'desktop'}
            >
              <HtmlPreview
                ref={previewRef}
                ytext={ytext}
                threads={comments.marks}
                draft={draft?.anchor ?? null}
                focusedThreadId={focusedThreadId}
                commentMode={commentMode && canComment}
                onThreadsResolved={comments.onThreadsResolved}
                onScrollState={(payload) => {
                  if (payload.layoutVersion !== placements.layoutVersion) return;
                  currentScrollYRef.current = payload.y;
                  iframeScrollStateRef.current = {
                    scrollTop: payload.y,
                    scrollHeight: payload.scrollHeight,
                    clientHeight: payload.clientHeight,
                  };
                  scrollSource.notify();
                }}
                onThreadClicked={focusThread}
                onAnchorCaptured={handleAnchorCaptured}
                onCommentModeExit={exitCommentMode}
                onShortcut={() => {
                  if (!canComment) return;
                  if (commentMode) exitCommentMode();
                  else startCommentMode();
                }}
                onSelectionChanged={onSelectionChanged}
                onLegacyDescribed={comments.onLegacyDescribed}
                onCurrentDescribed={onCurrentDescribed}
                storageKey={storageKey}
                onPageProblems={setPageProblems}
              />
            </div>
          </div>
        )}
        {mode !== 'source' && commentsVisible && !isMobile && (
          <div className="flex w-80 flex-shrink-0 flex-col border-l border-gray-200 bg-gray-50/50">
            <div className="relative min-h-0 flex-1 overflow-hidden">
            <CommentsLayer
              ref={commentsLayerRef}
              threads={placedViews}
              resolveAnchorY={resolveAnchorY}
              getViewportRect={getViewportRect}
              scrollSource={scrollSource}
              onFocusChange={(key) => {
                setFocusedThreadId(key);
                if (key) previewRef.current?.revealThread(key);
              }}
              onReply={comments.callbacks.onReply}
              onEdit={comments.callbacks.onEdit}
              onDelete={comments.callbacks.onDelete}
              actions={actions}
              draft={draftComment}
              emptyHint={unplacedViews.length > 0 ? '' : emptyHint}
            />
            </div>
            {unplacedViews.length > 0 && (
              // Comments whose text is gone have no place in the margin:
              // they wait here, out of the way, until re-attached or resolved.
              <div className="border-t border-gray-200 bg-white">
                <button
                  type="button"
                  aria-expanded={unplacedOpen}
                  onClick={() => setUnplacedOpen(open => !open)}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-semibold text-red-700 hover:bg-red-50"
                >
                  <span>{unplacedViews.length} not found on the page</span>
                  <span aria-hidden="true">{unplacedOpen ? '▾' : '▸'}</span>
                </button>
                {unplacedOpen && (
                  <div className="flex max-h-[45vh] flex-col gap-2 overflow-y-auto px-2 pb-2">
                    {unplacedViews.map(thread => (
                      <div key={thread.key} className="flex-shrink-0">
                      <CommentCard
                        thread={thread}
                        number={thread.order}
                        focused={focusedThreadId === thread.key}
                        onFocus={key => setFocusedThreadId(prev => (prev === key ? null : key))}
                        onReply={comments.callbacks.onReply}
                        onEdit={comments.callbacks.onEdit}
                        onDelete={comments.callbacks.onDelete}
                        actions={actions}
                      />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {isMobile && (
        <MobileDrawer open={commentsSheetOpen} onClose={closeDrawer} side="bottom" label="Comments">
          <MobileCommentsSheet
            key={commentsSheetEpoch}
            threads={comments.views}
            pendingAction={pendingCommentAction}
            onPendingActionConsumed={() => setPendingCommentAction(null)}
            onReply={comments.callbacks.onReply}
            onEdit={comments.callbacks.onEdit}
            onDelete={comments.callbacks.onDelete}
            actions={actions}
            emptyHint={emptyHint}
            {...(draft ? {
              getInsertKey: () => DRAFT_KEY,
              onAddComment: (_key: string, body: string) => {
                submitDraft(body);
                closeDrawer();
              },
              onAddCancel: cancelDraft,
              addTarget: describeAnchorTarget(draft.anchor),
            } : {})}
          />
        </MobileDrawer>
      )}
    </div>
  );
}
