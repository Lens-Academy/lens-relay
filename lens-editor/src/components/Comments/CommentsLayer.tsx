/**
 * CommentsLayer — shared container for comment cards in the margin.
 *
 * Responsibilities:
 * - Subscribe to Y.Text changes and parse comment threads.
 * - Compute weighted-PAV layout (non-overlapping positions) on scroll/resize/data change.
 * - Render CommentCard instances via Option-B wrapper divs (positioned absolutely;
 *   CommentCard receives top=0 and positions relative to its wrapper).
 * - Own focus state; toggle .cm-comment-badge--focused on the editor root.
 * - Listen for comment-badge-focus CustomEvents dispatched by the criticmarkup extension.
 * - Wire all CRUD operations through ytext-comment-ops.ts.
 */

import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
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

// ── Layout constants ─────────────────────────────────────────────────────────
const CARD_GAP = 10;
const DEFAULT_CARD_HEIGHT = 100;
/** Padding (px) between the column edges and the first/last card when clamped. */
const EDGE_PADDING = 12;
/** Distance (px) of editor scroll over which the at-top / at-bottom clamp fades in. */
const EDGE_TRANSITION_PX = 250;
/**
 * Cards within ACTIVE_WINDOW_MULTIPLIER viewports above the visible area, and
 * (ACTIVE_WINDOW_MULTIPLIER + 1) viewports below, are kept in the layout.
 * Cards outside that window receive weight = 0 (effectively hidden).
 */
const ACTIVE_WINDOW_MULTIPLIER = 2;

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
  /** Where new "Add" inserts. If omitted, no Add button is shown. */
  insertCursorPos?: number | null;
}

/** Clamp a value to [0, 1]. */
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function CommentsLayer(props: CommentsLayerProps): ReactElement {
  const {
    yText,
    resolveAnchorY,
    getViewportRect,
    scrollContainerRef,
    editorRootRef,
    currentUserName,
    insertCursorPos,
  } = props;

  // Layer DOM ref — used to translate viewport-y coords (returned by resolveAnchorY)
  // into layer-relative-y (what wrapper.style.top expects).
  const layerRef = useRef<HTMLDivElement | null>(null);

  // ── Y.Text subscription ──────────────────────────────────────────────────
  // Force a re-render whenever the Y.Text content changes.
  // `textRevision` is also used as a dep in the class-toggle effect below so
  // that the focused badge class re-attaches after decoration rebuilds.
  const [textRevision, setTextRevision] = useState(0);
  useEffect(() => {
    const handler = () => setTextRevision((v) => v + 1);
    yText.observe(handler);
    return () => yText.unobserve(handler);
  }, [yText]);

  // Clear focus when yText reference changes (e.g. navigating to a new doc).
  useEffect(() => {
    setFocusedThreadKey(null);
  }, [yText]);

  // ── Thread parsing ────────────────────────────────────────────────────────
  // useCommentsFromText is a plain function (not a hook), so calling it here
  // with the current Y.Text snapshot is safe and idiomatic.
  const allThreads: CommentThread[] = useCommentsFromText(yText.toString()).filter(
    (t) => t.comments[0]?.type === 'comment',
  );

  // ── Focus state ───────────────────────────────────────────────────────────
  const [focusedThreadKey, setFocusedThreadKey] = useState<number | null>(null);

  // Toggle .cm-comment-badge--focused class on matching badges in the editor root.
  useEffect(() => {
    const root = editorRootRef?.current;
    if (!root) return;
    root
      .querySelectorAll('.cm-comment-badge--focused')
      .forEach((el) => el.classList.remove('cm-comment-badge--focused'));
    if (focusedThreadKey != null) {
      root
        .querySelectorAll(`.cm-comment-badge[data-thread-from="${focusedThreadKey}"]`)
        .forEach((el) => el.classList.add('cm-comment-badge--focused'));
    }
  }, [focusedThreadKey, editorRootRef, textRevision]);

  // Listens for `comment-badge-focus` events dispatched by the criticmarkup
  // extension's badge widget click handler. The extension was updated in Task 6
  // of the unified-comments work to dispatch on `document` with
  // `detail: { threadFrom }`; this listener will silently no-op until that
  // change is in place.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ threadFrom: number }>).detail;
      setFocusedThreadKey(detail.threadFrom);
    };
    document.addEventListener('comment-badge-focus', handler);
    return () => document.removeEventListener('comment-badge-focus', handler);
  }, []);

  // No filter strip — all comments for the open doc are shown in document order.
  const filteredThreads = allThreads;

  // ── Add-comment form ──────────────────────────────────────────────────────
  const [showAddForm, setShowAddForm] = useState(false);

  const handleAddSubmit = (content: string) => {
    if (insertCursorPos == null) return;
    insertCommentInYText(yText, content, insertCursorPos);
    setShowAddForm(false);
    // Focus the newly inserted comment (its from offset = insertCursorPos).
    setFocusedThreadKey(insertCursorPos);
  };

  // ── Card height tracking ──────────────────────────────────────────────────
  const cardHeightsRef = useRef(new Map<number, number>());
  const [layoutTick, setLayoutTick] = useState(0);

  // ResizeObserver map: threadFrom → observer (for cleanup).
  const observersRef = useRef(new Map<number, ResizeObserver>());

  const attachObserver = (el: HTMLDivElement | null, threadFrom: number) => {
    // Clean up any existing observer for this thread.
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

  // Clean up all observers on unmount.
  useEffect(() => {
    return () => {
      observersRef.current.forEach((ro) => ro.disconnect());
      observersRef.current.clear();
    };
  }, []);

  // ── Scroll / viewport resize triggers ────────────────────────────────────
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

  // ── Layout computation ────────────────────────────────────────────────────
  const [layoutMap, setLayoutMap] = useState<Map<number, number>>(new Map());

  // Stable keys for layout dependency — only changes when thread set or filter changes.
  const filteredThreadKeys = filteredThreads.map((t) => t.from).join(',');

  useLayoutEffect(() => {
    const viewport = getViewportRect();
    const mid = viewport.height / 2;

    const items: LayoutItem[] = [];
    for (const thread of filteredThreads) {
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

    // Edge clamping with a smooth scroll-position gradient.
    //
    // Conceptually there are three regimes:
    //   - near the top of the editor scroll  → pin the first in-viewport card to minTop
    //   - near the bottom                    → pin the last in-viewport card to maxBottom
    //   - in the middle                      → no edge clamp; cards sit at PAV positions
    //
    // To avoid a discontinuity when crossing a threshold, both corrections are
    // applied with a weight that fades linearly across EDGE_TRANSITION_PX. At
    // scrollTop=0, topness=1 (full top correction); after EDGE_TRANSITION_PX,
    // topness=0 (no top correction). Symmetric at the bottom.
    const minTop = viewport.top + EDGE_PADDING;
    const maxBottom = viewport.top + viewport.height - EDGE_PADDING;

    const inViewport = items
      .filter((it) => {
        const vy = it.anchorY - viewport.top;
        return vy >= 0 && vy <= viewport.height;
      })
      .sort((a, b) => a.anchorY - b.anchorY);

    if (inViewport.length > 0) {
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

      // Blended shift: positive (down) near the top, negative (up) near the bottom,
      // zero in the middle. If both apply (very short doc), they partially cancel.
      const shift = topShift * topness + botShift * botness;

      if (shift !== 0) {
        for (const k of result.keys()) {
          result.set(k, result.get(k)! + shift);
        }
      }
    }

    setLayoutMap(result);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredThreadKeys, focusedThreadKey, layoutTick]);

  // ── Badge numbering ───────────────────────────────────────────────────────
  // 1-indexed by document order (matches the inline criticmarkup badge numbers).
  const threadNumbers = new Map<number, number>();
  allThreads.forEach((t, i) => threadNumbers.set(t.from, i + 1));

  // ── CRUD callbacks ────────────────────────────────────────────────────────
  const handleFocus = (threadFrom: number) => setFocusedThreadKey(threadFrom);

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

  // ── Render ────────────────────────────────────────────────────────────────
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
      {/* Floating Add button — pinned to the top-right of the column, above all cards. */}
      {insertCursorPos != null && !showAddForm && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setShowAddForm(true); }}
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

      {/* ── Add form (floating at top of column) ───────────────────────── */}
      {showAddForm && insertCursorPos != null && (
        <div
          style={{ pointerEvents: 'auto', padding: '0 8px 8px' }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ border: '1px solid #d1d5db', borderRadius: 8, overflow: 'hidden' }}>
            <AddCommentForm
              onSubmit={handleAddSubmit}
              onCancel={() => setShowAddForm(false)}
              placeholder="Add a comment..."
              submitLabel="Add"
              autoFocus
            />
          </div>
        </div>
      )}

      {/* ── Empty state ────────────────────────────────────────────────── */}
      {filteredThreads.length === 0 && (
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

      {/* ── Cards area ─────────────────────────────────────────────────── */}
      {/* Relative container fills the layer so absolute wrappers are positioned
          in the layer's coord space. We subtract the layer's viewport-y from
          each card's computed y (which is in viewport-y from resolveAnchorY)
          so wrapper.style.top is in the right frame of reference. */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        {filteredThreads.map((thread) => {
          const anchorY = resolveAnchorY(thread.from);
          if (anchorY == null) return null; // hidden (not in rendered range)

          const layoutY = layoutMap.get(thread.from) ?? anchorY;
          // Translate viewport-y → layer-relative-y.
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
                left: 0,
                right: 0,
                pointerEvents: 'auto',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <CommentCard
                thread={thread}
                top={0}
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
}
