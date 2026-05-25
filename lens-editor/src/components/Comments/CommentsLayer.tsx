/**
 * CommentsLayer — shared container for comment cards in the margin.
 *
 * Subscribes to Y.Text, lays out cards using weighted PAV, and owns focus
 * state. Editor mounts call the imperative `focusThread` on the layer's ref
 * when an inline marker (any element with `data-comment-from`) is clicked.
 */

import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useImperativeHandle,
  forwardRef,
  type RefObject,
  type ReactElement,
} from 'react';
import * as Y from 'yjs';
import { CommentCard } from './CommentCard';
import { AddCommentForm } from './AddCommentForm';
import { useCommentsFromText } from './useCommentsFromText';
import { computeWeightedLayout, type LayoutItem } from '../../lib/weighted-pav-layout';
import {
  insertCommentInYText,
  replyInYText,
  editRangeContentInYText,
  deleteRangeInYText,
} from '../../lib/ytext-comment-ops';
import type { CommentThread } from '../../lib/criticmarkup-parser';

const CARD_GAP = 10;
const DEFAULT_CARD_HEIGHT = 100;
/** Padding between the column edges and the first/last card when clamped. */
const EDGE_PADDING = 12;
/** Scroll distance over which the at-top / at-bottom clamp fades in. */
const EDGE_TRANSITION_PX = 250;
/** Cards beyond N viewports above (and N+1 below) get weight 0 (no pull). */
const ACTIVE_WINDOW_MULTIPLIER = 2;

export interface CommentsLayerHandle {
  /** Toggles focus on the thread at `absFrom`: if already focused, clears it. */
  focusThread(absFrom: number): void;
  /** Opens the add-comment form anchored at the cursor returned by
   *  `getInsertCursorPos`. No-op if the getter is omitted or returns null. */
  openAddForm(): void;
}

export interface CommentsLayerProps {
  /** Y.Text containing the document content. */
  yText: Y.Text;
  /** Resolve a Y.Text offset to a screen y, or null if not currently rendered. */
  resolveAnchorY: (offset: number) => number | null;
  /** Current visible viewport in the same coordinate space as resolveAnchorY. */
  getViewportRect: () => { top: number; height: number };
  /** Scroll container shared with the editor; the column listens to its scroll. */
  scrollContainerRef: RefObject<HTMLElement | null>;
  /** Editor root element; the layer toggles a CSS class on matching badges when focus changes. */
  editorRootRef?: RefObject<HTMLElement | null>;
  /** Current user's display name for owner detection. */
  currentUserName: string;
  /** Called when the user opens the add-comment form (via the "+ Add" button
   *  or the `openAddForm` handle method) to determine the insertion offset.
   *  Read at click/trigger time so the result reflects the live cursor rather
   *  than a render-time snapshot. If omitted, no Add button is shown and
   *  `openAddForm` is a no-op. */
  getInsertCursorPos?: () => number | null;
}

/** Clamp a value to [0, 1]. */
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export const CommentsLayer = forwardRef<CommentsLayerHandle, CommentsLayerProps>(function CommentsLayer(props, handleRef): ReactElement {
  const {
    yText,
    resolveAnchorY,
    getViewportRect,
    scrollContainerRef,
    editorRootRef,
    currentUserName,
    getInsertCursorPos,
  } = props;

  // getInsertCursorPos identity may change every render (callers commonly pass
  // an inline arrow). Mirror through a ref so handle methods and click handlers
  // always see the latest function without us having to thread it into
  // useImperativeHandle deps.
  const getInsertCursorPosRef = useRef(getInsertCursorPos);
  getInsertCursorPosRef.current = getInsertCursorPos;

  const layerRef = useRef<HTMLDivElement | null>(null);

  // Bump on every Y.Text mutation; also a dep of the class-toggle effect so the
  // focused class re-attaches after CM decoration rebuilds.
  const [textRevision, setTextRevision] = useState(0);
  useEffect(() => {
    const handler = () => setTextRevision((v) => v + 1);
    yText.observe(handler);
    return () => yText.unobserve(handler);
  }, [yText]);

  // Clear focus when navigating to a different doc.
  useEffect(() => {
    setFocusedThreadKey(null);
  }, [yText]);

  const allThreads: CommentThread[] = useCommentsFromText(yText.toString()).filter(
    (t) => t.comments[0]?.type === 'comment',
  );

  const [focusedThreadKey, setFocusedThreadKey] = useState<number | null>(null);

  // The handle closes over the current render's focusedThreadKey, so each
  // toggle decision uses fresh state without a functional updater (which
  // StrictMode would double-invoke).
  useImperativeHandle(handleRef, () => ({
    focusThread(absFrom: number) {
      setFocusedThreadKey(focusedThreadKey === absFrom ? null : absFrom);
    },
    openAddForm() {
      const pos = getInsertCursorPosRef.current?.();
      if (pos == null) return;
      setPendingInsertPos(pos);
      setShowAddForm(true);
    },
  }), [focusedThreadKey]);

  useEffect(() => {
    const root = editorRootRef?.current;
    if (!root) return;
    root.querySelectorAll('[data-comment-focused]').forEach((el) => {
      delete (el as HTMLElement).dataset.commentFocused;
    });
    if (focusedThreadKey != null) {
      root
        .querySelectorAll(`[data-comment-from="${focusedThreadKey}"]`)
        .forEach((el) => { (el as HTMLElement).dataset.commentFocused = ''; });
    }
  }, [focusedThreadKey, editorRootRef, textRevision]);

  const [showAddForm, setShowAddForm] = useState(false);
  // Captured at the moment the form opens, so a cursor move while typing
  // doesn't relocate the insertion target.
  const [pendingInsertPos, setPendingInsertPos] = useState<number | null>(null);

  const handleAddSubmit = (content: string) => {
    const pos = pendingInsertPos;
    if (pos == null) return;
    insertCommentInYText(yText, content, pos);
    setShowAddForm(false);
    setPendingInsertPos(null);
    setFocusedThreadKey(pos);
  };

  const cardHeightsRef = useRef(new Map<number, number>());
  const [layoutTick, setLayoutTick] = useState(0);

  const observersRef = useRef(new Map<number, ResizeObserver>());

  const attachObserver = (el: HTMLDivElement | null, threadFrom: number) => {
    const existing = observersRef.current.get(threadFrom);
    if (existing) {
      existing.disconnect();
      observersRef.current.delete(threadFrom);
    }
    if (!el) return;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = entry.contentRect.height;
        const prev = cardHeightsRef.current.get(threadFrom);
        if (prev !== h) {
          cardHeightsRef.current.set(threadFrom, h);
          setLayoutTick((t) => t + 1);
        }
      }
    });
    ro.observe(el);
    observersRef.current.set(threadFrom, ro);
  };

  useEffect(() => {
    return () => {
      observersRef.current.forEach((ro) => ro.disconnect());
      observersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    let rafId: number | null = null;
    const bump = () => {
      if (rafId != null) return; // already queued
      rafId = requestAnimationFrame(() => {
        rafId = null;
        setLayoutTick((t) => t + 1);
      });
    };

    container.addEventListener('scroll', bump, { passive: true });
    const ro = new ResizeObserver(bump);
    ro.observe(container);

    return () => {
      container.removeEventListener('scroll', bump);
      ro.disconnect();
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, [scrollContainerRef]);

  const [layoutMap, setLayoutMap] = useState<Map<number, number>>(new Map());

  // Stable dep for the layout effect — changes only when the thread set changes.
  const threadKeys = allThreads.map((t) => t.from).join(',');

  useLayoutEffect(() => {
    const viewport = getViewportRect();
    const mid = viewport.height / 2;

    const items: LayoutItem[] = [];
    for (const thread of allThreads) {
      const anchorY = resolveAnchorY(thread.from);
      if (anchorY == null) continue; // not currently rendered — skip

      // Distance-based weight.
      const vy = anchorY - viewport.top;
      let weight = clamp01(1 - Math.abs(vy - mid) / (mid === 0 ? 1 : mid));

      // Zero out weight for threads far outside the active window.
      const windowAbove = ACTIVE_WINDOW_MULTIPLIER * viewport.height;
      const windowBelow = (ACTIVE_WINDOW_MULTIPLIER + 1) * viewport.height;
      if (anchorY < viewport.top - windowAbove || anchorY > viewport.top + windowBelow) {
        weight = 0;
      }

      // Focused thread is a hard pin.
      if (thread.from === focusedThreadKey) {
        weight = Number.POSITIVE_INFINITY;
      }

      items.push({
        key: thread.from,
        anchorY,
        height: cardHeightsRef.current.get(thread.from) ?? DEFAULT_CARD_HEIGHT,
        weight,
      });
    }

    const result = computeWeightedLayout({ items, gap: CARD_GAP });

    // Edge clamp: near the top/bottom of the doc, shift all cards so the
    // first/last in-viewport card doesn't go off screen. Blended linearly over
    // EDGE_TRANSITION_PX (no discontinuity). Skipped when a thread is focused
    // in the viewport — its hard pin to its anchor takes precedence.
    const minTop = viewport.top + EDGE_PADDING;
    const maxBottom = viewport.top + viewport.height - EDGE_PADDING;

    const inViewport = items
      .filter((it) => {
        const vy = it.anchorY - viewport.top;
        return vy >= 0 && vy <= viewport.height;
      })
      .sort((a, b) => a.anchorY - b.anchorY);

    const focusedInViewport =
      focusedThreadKey != null && inViewport.some((it) => it.key === focusedThreadKey);

    if (inViewport.length > 0 && !focusedInViewport) {
      const first = inViewport[0];
      const last = inViewport[inViewport.length - 1];
      const firstPos = result.get(first.key);
      const lastBot = (result.get(last.key) ?? 0) + last.height;

      const sc = scrollContainerRef.current;
      const scrollTop = sc?.scrollTop ?? 0;
      const scrollMax = sc ? Math.max(0, sc.scrollHeight - sc.clientHeight) : 0;
      const topness = clamp01((EDGE_TRANSITION_PX - scrollTop) / EDGE_TRANSITION_PX);
      const botness = clamp01(
        (scrollTop - (scrollMax - EDGE_TRANSITION_PX)) / EDGE_TRANSITION_PX,
      );

      const topShift = firstPos != null && firstPos < minTop ? minTop - firstPos : 0;
      const botShift = lastBot > maxBottom ? maxBottom - lastBot : 0;
      const shift = topShift * topness + botShift * botness;

      if (shift !== 0) {
        for (const k of result.keys()) {
          result.set(k, result.get(k)! + shift);
        }
      }
    }

    setLayoutMap(result);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadKeys, focusedThreadKey, layoutTick]);

  // 1-indexed by document order — matches the inline badge numbers.
  const threadNumbers = new Map<number, number>();
  allThreads.forEach((t, i) => threadNumbers.set(t.from, i + 1));

  const handleFocus = (threadFrom: number) => {
    // Direct read is safe here (handler is recreated each render); avoids the
    // StrictMode-double-invoke bug that breaks the functional-updater form.
    setFocusedThreadKey(focusedThreadKey === threadFrom ? null : threadFrom);
  };

  const handleReply = (threadEndPos: number, content: string) => {
    replyInYText(yText, content, threadEndPos);
  };

  const handleEdit = (thread: CommentThread) => (rangeIndex: number, newContent: string) => {
    const range = thread.comments[rangeIndex];
    if (!range) return;
    editRangeContentInYText(yText, range, newContent);
  };

  const handleDelete = (thread: CommentThread) => (rangeIndex: number) => {
    const range = thread.comments[rangeIndex];
    if (!range) return;
    deleteRangeInYText(yText, range);
  };

  return (
    <div
      ref={layerRef}
      className="comments-layer"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        pointerEvents: 'none',
        // Establish stacking context so children can use z-index if needed.
        isolation: 'isolate',
      }}
      onClick={(e) => {
        // Click on the layer background (not a card) clears focus.
        if (e.target === e.currentTarget) {
          setFocusedThreadKey(null);
        }
      }}
    >
      {getInsertCursorPos != null && !showAddForm && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            const pos = getInsertCursorPosRef.current?.();
            if (pos == null) return;
            setPendingInsertPos(pos);
            setShowAddForm(true);
          }}
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            zIndex: 2,
            pointerEvents: 'auto',
            fontSize: 12,
            padding: '2px 10px',
            background: '#3b82f6',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            fontWeight: 600,
            boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
          }}
        >
          + Add
        </button>
      )}

      {showAddForm && pendingInsertPos != null && (
        <div
          style={{ pointerEvents: 'auto', padding: '0 8px 8px', position: 'relative', zIndex: 2 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ border: '1px solid #d1d5db', borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
            <AddCommentForm
              onSubmit={handleAddSubmit}
              onCancel={() => { setShowAddForm(false); setPendingInsertPos(null); }}
              placeholder="Add a comment..."
              submitLabel="Add"
              autoFocus
            />
          </div>
        </div>
      )}

      {allThreads.length === 0 && (
        <div
          style={{
            pointerEvents: 'none',
            padding: '40px 16px',
            textAlign: 'center',
            color: '#9ca3af',
            fontSize: 13,
          }}
        >
          No comments yet. Select text and click Add.
        </div>
      )}

      {/* layoutY is in viewport-y (from resolveAnchorY); subtract layer's
          viewport top to get the layer-relative position the wrapper needs. */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        {allThreads.map((thread) => {
          const anchorY = resolveAnchorY(thread.from);
          if (anchorY == null) return null;

          const layoutY = layoutMap.get(thread.from) ?? anchorY;
          const layerTop = layerRef.current?.getBoundingClientRect().top ?? 0;
          const top = layoutY - layerTop;

          return (
            <div
              key={thread.from}
              data-comment-thread={thread.from}
              ref={(el) => attachObserver(el, thread.from)}
              style={{
                position: 'absolute',
                top,
                // Inset so a focused card's outline isn't clipped by the column.
                left: 4,
                right: 4,
                pointerEvents: 'auto',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <CommentCard
                thread={thread}
                number={threadNumbers.get(thread.from)}
                focused={focusedThreadKey === thread.from}
                currentUserName={currentUserName}
                onFocus={handleFocus}
                onReply={handleReply}
                onEdit={handleEdit(thread)}
                onDelete={handleDelete(thread)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
});
