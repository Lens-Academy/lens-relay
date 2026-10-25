import { useEffect } from 'react';

interface SwipeOptions {
  enabled: boolean;
  /** Horizontal distance required to trigger (px). */
  threshold?: number;
  /** Swipe rightward anywhere → open left drawer. */
  onSwipeRight?: () => void;
  /** Swipe leftward anywhere → open right drawer. */
  onSwipeLeft?: () => void;
}

/**
 * Obsidian-style horizontal swipes to open the drawers. Accepts swipes
 * anywhere on the content (not just the screen edge — Android's system
 * back gesture owns the edges in Chrome, so edge-anchored zones are
 * unreliable on the web). Guards:
 * - strongly horizontal movement only (|dx| > 2.5|dy|), so scrolling wins
 * - ignored while text is selected (selection-handle drags stay intact)
 * - ignored when starting on the nav bar, edit toolbar, or an open dialog
 * - ignored when the touch starts inside something that can still scroll sideways in the swipe's
 *   direction (a wide table, a code block): that scroll wins (Lauren, 2026-10-25)
 */
/** Whether `el` or an ancestor can scroll horizontally in the direction a finger moving `dx` drags. */
export function scrollsSideways(el: Element | null, dx: number): boolean {
  for (let x = el; x && x !== document.documentElement; x = x.parentElement) {
    const ox = getComputedStyle(x).overflowX;
    if ((ox !== 'auto' && ox !== 'scroll') || x.scrollWidth <= x.clientWidth + 1) continue;
    // A finger moving left (dx < 0) reveals the right: room left to scroll right?
    if (dx < 0 ? x.scrollLeft + x.clientWidth < x.scrollWidth - 1 : x.scrollLeft > 0) return true;
  }
  return false;
}

export function useEdgeSwipe({
  enabled,
  threshold = 60,
  onSwipeRight,
  onSwipeLeft,
}: SwipeOptions): void {
  useEffect(() => {
    if (!enabled) return;

    let tracking = false;
    let startX = 0;
    let startY = 0;
    let fired = false;
    let startTarget: Element | null = null;

    const onStart = (e: TouchEvent) => {
      fired = false;
      tracking = false;
      const target = e.target as Element | null;
      if (target?.closest('#mobile-nav-bar, #mobile-edit-toolbar, [role="dialog"]')) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      tracking = true;
      startTarget = target;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    };

    const onMove = (e: TouchEvent) => {
      if (!tracking || fired) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (Math.abs(dx) < threshold || Math.abs(dx) < 2.5 * Math.abs(dy)) return;
      // Decided once per gesture: a swipe that began as a sideways scroll stays one, even after
      // the scroller reaches its end mid-gesture (Assay, #195).
      if (scrollsSideways(startTarget, dx)) { tracking = false; return; }
      fired = true;
      if (dx > 0) onSwipeRight?.();
      else onSwipeLeft?.();
    };

    const onEnd = () => {
      tracking = false;
    };

    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: true });
    document.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
    };
  }, [enabled, threshold, onSwipeRight, onSwipeLeft]);
}
