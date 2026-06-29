/**
 * CommentsLayer — shared container for comment cards in the margin.
 *
 * Accepts a pre-built ThreadView[] from the caller (via criticmarkupAdapter or
 * any other source) and owns focus state + PAV layout. No yText dependency.
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
import { CommentCard } from './CommentCard';
import { AddCommentForm } from './AddCommentForm';
import { computeWeightedLayout, type LayoutItem } from '../../lib/weighted-pav-layout';
import type { ThreadKey, ThreadView, MessageView, ScrollSource } from './types';

const CARD_GAP = 10;
const DEFAULT_CARD_HEIGHT = 100;
/** Padding between the column edges and the first/last card when clamped. */
const EDGE_PADDING = 12;
/** Scroll distance over which the at-top / at-bottom clamp fades in. */
const EDGE_TRANSITION_PX = 250;
/** Cards beyond N viewports above (and N+1 below) get weight 0 (no pull). */
const ACTIVE_WINDOW_MULTIPLIER = 2;

export interface CommentsLayerHandle {
  /** Idempotent set (not toggle). Focusing same key twice is a no-op.
   *  Use for programmatic focus (e.g. just-created comments) where unfocus is undesired. */
  focusThread(key: ThreadKey): void;
  /** Toggle focus: focuses the thread, or unfocuses if it is already focused.
   *  Use for user-driven badge clicks so they mirror sidebar-card click behaviour. */
  toggleFocus(key: ThreadKey): void;
  /** Opens the add-comment form anchored at the cursor returned by
   *  `getInsertKey`. No-op if the getter is omitted or returns null. */
  openAddForm(): void;
}

export interface CommentsLayerProps {
  threads: ThreadView[];
  /** Resolve a thread key to a screen y, or null if not currently rendered. */
  resolveAnchorY: (key: ThreadKey) => number | null;
  /** Current visible viewport in the same coordinate space as resolveAnchorY. */
  getViewportRect: () => { top: number; height: number };
  /** ScrollSource wired to the editor scroll container. */
  scrollSource: ScrollSource;
  /** Editor root element; the layer toggles data-comment-focused on matching badges. */
  editorRootRef?: RefObject<HTMLElement | null>;
  /** Called when focused thread changes (or clears). */
  onFocusChange?: (key: ThreadKey | null) => void;
  onReply: (thread: ThreadView, body: string) => void;
  onEdit: (message: MessageView, newBody: string) => void;
  onDelete: (message: MessageView) => void;
  /** Add-comment UI shown only when both provided. */
  getInsertKey?: () => ThreadKey | null;
  onAddComment?: (key: ThreadKey, body: string) => void;
}

/** Clamp a value to [0, 1]. */
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export const CommentsLayer = forwardRef<CommentsLayerHandle, CommentsLayerProps>(function CommentsLayer(props, handleRef): ReactElement {
  const {
    threads,
    resolveAnchorY,
    getViewportRect,
    scrollSource,
    editorRootRef,
    onFocusChange,
    onReply,
    onEdit,
    onDelete,
    getInsertKey,
    onAddComment,
  } = props;

  // getInsertKey identity may change every render (callers commonly pass
  // an inline arrow). Mirror through a ref so handle methods and click handlers
  // always see the latest function without threading it into deps.
  const getInsertKeyRef = useRef(getInsertKey);
  getInsertKeyRef.current = getInsertKey;

  const layerRef = useRef<HTMLDivElement | null>(null);

  const [focusedThreadKey, setFocusedThreadKey] = useState<ThreadKey | null>(null);

  // Helper: set focus and fire callback.
  const applyFocus = (key: ThreadKey | null) => {
    setFocusedThreadKey(key);
    onFocusChange?.(key);
  };

  // The handle closes over the current render's focusedThreadKey so toggle
  // logic uses fresh state.
  useImperativeHandle(handleRef, () => ({
    focusThread(key: ThreadKey) {
      // Idempotent set — focusing same key twice is a no-op.
      if (key !== focusedThreadKey) {
        applyFocus(key);
      }
    },
    toggleFocus(key: ThreadKey) {
      applyFocus(focusedThreadKey === key ? null : key);
    },
    openAddForm() {
      const key = getInsertKeyRef.current?.();
      if (key == null) return;
      setPendingInsertKey(key);
      setShowAddForm(true);
    },
  }), [focusedThreadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Toggle the data-comment-focused attribute on matching badges in the editor.
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
  }, [focusedThreadKey, editorRootRef]);

  const [showAddForm, setShowAddForm] = useState(false);
  // Captured at the moment the form opens, so a cursor move while typing
  // doesn't relocate the insertion target.
  const [pendingInsertKey, setPendingInsertKey] = useState<ThreadKey | null>(null);

  const handleAddSubmit = (content: string) => {
    const key = pendingInsertKey;
    if (key == null || !onAddComment) return;
    onAddComment(key, content);
    setShowAddForm(false);
    setPendingInsertKey(null);
    applyFocus(key);
  };

  const cardHeightsRef = useRef(new Map<ThreadKey, number>());
  const [layoutTick, setLayoutTick] = useState(0);

  const observersRef = useRef(new Map<ThreadKey, ResizeObserver>());

  const attachObserver = (el: HTMLDivElement | null, key: ThreadKey) => {
    const existing = observersRef.current.get(key);
    if (existing) {
      existing.disconnect();
      observersRef.current.delete(key);
    }
    if (!el) return;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = entry.contentRect.height;
        const prev = cardHeightsRef.current.get(key);
        if (prev !== h) {
          cardHeightsRef.current.set(key, h);
          setLayoutTick((t) => t + 1);
        }
      }
    });
    ro.observe(el);
    observersRef.current.set(key, ro);
  };

  useEffect(() => {
    return () => {
      observersRef.current.forEach((ro) => ro.disconnect());
      observersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    let rafId: number | null = null;
    const bump = () => {
      if (rafId != null) return; // already queued
      rafId = requestAnimationFrame(() => {
        rafId = null;
        setLayoutTick((t) => t + 1);
      });
    };
    const unsub = scrollSource.subscribe(bump);
    return () => { unsub(); if (rafId != null) cancelAnimationFrame(rafId); };
  }, [scrollSource]);

  const [layoutMap, setLayoutMap] = useState<Map<ThreadKey, number>>(new Map());

  // Stable dep for the layout effect — changes only when the thread set changes.
  const threadKeys = threads.map((t) => t.key).join(',');

  // Resolve a thread's screen-y. Orphans (anchor not currently rendered) pin
  // synthetically to the top of the visible editor area, so they appear at
  // the top of the sidebar and PAV stacks any subsequent ones below them.
  const anchorYFor = (thread: ThreadView, viewport: { top: number; height: number }): number | null => {
    if (thread.orphan) return viewport.top;
    return resolveAnchorY(thread.key);
  };

  useLayoutEffect(() => {
    const viewport = getViewportRect();
    const mid = viewport.height / 2;

    const items: LayoutItem<ThreadKey>[] = [];
    let anyPositiveWeight = false;
    for (const thread of threads) {
      const anchorY = anchorYFor(thread, viewport);
      if (anchorY == null) continue; // anchor unresolvable AND not orphan-pinned — skip

      // Skip threads far outside the active window entirely. They render at
      // their natural anchorY (off-screen) via the layoutMap.get(...) ?? anchorY
      // fallback. Including them with weight=0 would corrupt the PAV layout —
      // when *all* items have weight 0, the merge logic stacks them all at the
      // topmost anchorY, which can push early cards into the visible area when
      // the viewport sits in a gap between comments.
      const windowAbove = ACTIVE_WINDOW_MULTIPLIER * viewport.height;
      const windowBelow = (ACTIVE_WINDOW_MULTIPLIER + 1) * viewport.height;
      if (anchorY < viewport.top - windowAbove || anchorY > viewport.top + windowBelow) {
        continue;
      }

      // Distance-based weight inside the active window.
      const vy = anchorY - viewport.top;
      let weight = clamp01(1 - Math.abs(vy - mid) / (mid === 0 ? 1 : mid));

      // Focused thread is a hard pin.
      if (thread.key === focusedThreadKey) {
        weight = Number.POSITIVE_INFINITY;
      }

      if (weight > 0) anyPositiveWeight = true;

      items.push({
        key: thread.key,
        anchorY,
        height: cardHeightsRef.current.get(thread.key) ?? DEFAULT_CARD_HEIGHT,
        weight,
      });
    }

    // If no item is in the viewport and no focused thread is pinned, every
    // weight is 0. computeWeightedLayout's all-zero merge branch collapses
    // every overlapping card onto the topmost anchorY and stacks the rest
    // downward — which, with cards 1-25 anchored ~2000px above the viewport,
    // drags the deep end of the stack visibly into the sidebar. Side-effect:
    // as you scroll through a gap between comments, the badges visible in the
    // sidebar slowly drift through the whole pre-gap range (1 → 25) until the
    // next comment enters the viewport and PAV gets a real pull again.
    // Bypass the layout entirely in this case — every card stays at its
    // natural off-viewport anchorY, where it isn't visible to the user.
    const result = anyPositiveWeight
      ? computeWeightedLayout({ items, gap: CARD_GAP })
      : new Map(items.map((it) => [it.key, it.anchorY]));

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

      const scrollTop = scrollSource.getScrollTop();
      const scrollMax = Math.max(0, scrollSource.getScrollHeight() - scrollSource.getClientHeight());
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

  const handleFocus = (key: ThreadKey) => {
    // Toggle on click: clicking the focused thread unfocuses it.
    const next = focusedThreadKey === key ? null : key;
    applyFocus(next);
  };

  const showAddButton = getInsertKey != null && onAddComment != null && !showAddForm;

  const currentViewport = getViewportRect();

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
        isolation: 'isolate',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          applyFocus(null);
        }
      }}
    >
      {showAddButton && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            const key = getInsertKeyRef.current?.();
            if (key == null) return;
            setPendingInsertKey(key);
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

      {showAddForm && pendingInsertKey != null && (
        <div
          style={{ pointerEvents: 'auto', padding: '0 8px 8px', position: 'relative', zIndex: 2 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ border: '1px solid #d1d5db', borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
            <AddCommentForm
              onSubmit={handleAddSubmit}
              onCancel={() => { setShowAddForm(false); setPendingInsertKey(null); }}
              placeholder="Add a comment..."
              submitLabel="Add"
              autoFocus
            />
          </div>
        </div>
      )}

      {threads.length === 0 && (
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

      {/* Cards. Orphans use a synthetic anchor at viewport.top so they cluster
       *  at the top of the sidebar; anchored cards track their text via PAV. */}
      {threads.map((thread) => {
        const anchorY = anchorYFor(thread, currentViewport);
        if (anchorY == null) return null;

        const layoutY = layoutMap.get(thread.key) ?? anchorY;
        const layerTop = layerRef.current?.getBoundingClientRect().top ?? 0;
        const top = layoutY - layerTop;

        return (
          <div
            key={thread.key}
            data-comment-thread={thread.key}
            ref={(el) => attachObserver(el, thread.key)}
            style={{
              position: 'absolute',
              top,
              left: 4,
              right: 4,
              pointerEvents: 'auto',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <CommentCard
              thread={thread}
              number={thread.order}
              focused={focusedThreadKey === thread.key}
              onFocus={handleFocus}
              onReply={(t, body) => onReply(t, body)}
              onEdit={(msg, body) => onEdit(msg, body)}
              onDelete={(msg) => onDelete(msg)}
            />
          </div>
        );
      })}
    </div>
  );
});
