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
 */
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

    const onStart = (e: TouchEvent) => {
      fired = false;
      tracking = false;
      const target = e.target as Element | null;
      if (target?.closest('#mobile-nav-bar, #mobile-edit-toolbar, [role="dialog"]')) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      tracking = true;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    };

    const onMove = (e: TouchEvent) => {
      if (!tracking || fired) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (Math.abs(dx) < threshold || Math.abs(dx) < 2.5 * Math.abs(dy)) return;
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
