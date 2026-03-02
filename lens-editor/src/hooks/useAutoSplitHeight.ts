import { useState, useEffect, useCallback, type RefObject } from 'react';
import { computeSplitHeight } from '../lib/split-height';

interface UseAutoSplitHeightOptions {
  containerRef: RefObject<HTMLElement | null>;
  topRef: RefObject<HTMLElement | null>;
  bottomRef: RefObject<HTMLElement | null>;
  handleHeight: number;
  minHeight: number;
  userOverride: number | null;
}

interface UseAutoSplitHeightResult {
  topHeight: number;
  bottomHeight: number;
}

export function useAutoSplitHeight({
  containerRef,
  topRef,
  bottomRef,
  handleHeight,
  minHeight,
  userOverride,
}: UseAutoSplitHeightOptions): UseAutoSplitHeightResult {
  const [heights, setHeights] = useState<UseAutoSplitHeightResult>({
    topHeight: 200,
    bottomHeight: 200,
  });

  const recalculate = useCallback(() => {
    const container = containerRef.current;
    const topEl = topRef.current;
    const bottomEl = bottomRef.current;
    if (!container || !topEl || !bottomEl) return;

    const available = container.clientHeight - handleHeight;
    if (available <= 0) return;

    if (userOverride !== null) {
      const clamped = Math.max(minHeight, Math.min(userOverride, available - minHeight));
      setHeights({ topHeight: clamped, bottomHeight: available - clamped });
      return;
    }

    const result = computeSplitHeight({
      topContent: topEl.scrollHeight,
      bottomContent: bottomEl.scrollHeight,
      available,
      minHeight,
    });
    setHeights(result);
  }, [containerRef, topRef, bottomRef, handleHeight, minHeight, userOverride]);

  useEffect(() => {
    const container = containerRef.current;
    const topEl = topRef.current;
    const bottomEl = bottomRef.current;
    if (!container || !topEl || !bottomEl) return;

    // Initial calculation
    recalculate();

    // ResizeObserver on container (fires when sidebar height changes)
    const resizeObserver = new ResizeObserver(recalculate);
    resizeObserver.observe(container);

    // MutationObserver on both scroll containers (fires when content changes)
    const mutationObserver = new MutationObserver(recalculate);
    mutationObserver.observe(topEl, { childList: true, subtree: true });
    mutationObserver.observe(bottomEl, { childList: true, subtree: true });

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [containerRef, topRef, bottomRef, recalculate]);

  return heights;
}
