import { useRef, useEffect } from 'react';
import type { RefObject } from 'react';
import type { PanelImperativeHandle } from 'react-resizable-panels';

interface UseAutoCollapseOptions {
  /** Current container width in pixels (from useContainerWidth) */
  containerWidth: number;
  /** Refs to all collapsible panels */
  panelRefs: RefObject<PanelImperativeHandle | null>[];
  /** Pixel minimums for each panel (same order as panelRefs) */
  pixelMinimums: number[];
  /** Minimum content area width in pixels */
  contentMinPx: number;
}

/**
 * Auto-collapses all panels when the container is too narrow for content.
 * One-time trigger per threshold crossing — resets when going back above.
 */
export function useAutoCollapse({
  containerWidth,
  panelRefs,
  pixelMinimums,
  contentMinPx,
}: UseAutoCollapseOptions) {
  const hasCollapsedRef = useRef(false);

  const threshold = pixelMinimums.reduce((sum, px) => sum + px, 0) + contentMinPx;
  const isBelowThreshold = containerWidth > 0 && containerWidth < threshold;

  useEffect(() => {
    if (isBelowThreshold && !hasCollapsedRef.current) {
      for (const ref of panelRefs) {
        const panel = ref.current;
        if (panel && !panel.isCollapsed()) {
          panel.collapse();
        }
      }
      hasCollapsedRef.current = true;
    } else if (!isBelowThreshold) {
      hasCollapsedRef.current = false;
    }
  }, [isBelowThreshold, panelRefs]);
}
