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

const HYSTERESIS_PX = 50;

/**
 * Auto-collapses panels when the container is too narrow, and auto-expands
 * them when it grows back. Uses hysteresis to prevent flickering.
 *
 * Only panels that were auto-collapsed get auto-expanded — panels the user
 * manually collapsed are left alone.
 */
export function useAutoCollapse({
  containerWidth,
  panelRefs,
  pixelMinimums,
  contentMinPx,
}: UseAutoCollapseOptions) {
  const autoCollapsedRef = useRef<Set<RefObject<PanelImperativeHandle | null>>>(new Set());

  const threshold = pixelMinimums.reduce((sum, px) => sum + px, 0) + contentMinPx;
  const isBelowThreshold = containerWidth > 0 && containerWidth < threshold;
  const isAboveExpandThreshold = containerWidth >= threshold + HYSTERESIS_PX;

  useEffect(() => {
    if (isBelowThreshold && autoCollapsedRef.current.size === 0) {
      for (const ref of panelRefs) {
        const panel = ref.current;
        if (panel && !panel.isCollapsed()) {
          panel.collapse();
          autoCollapsedRef.current.add(ref);
        }
      }
    } else if (isAboveExpandThreshold && autoCollapsedRef.current.size > 0) {
      for (const ref of autoCollapsedRef.current) {
        ref.current?.expand();
      }
      autoCollapsedRef.current.clear();
    }
  }, [isBelowThreshold, isAboveExpandThreshold, panelRefs]);
}
