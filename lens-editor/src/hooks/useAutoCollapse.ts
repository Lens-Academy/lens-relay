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
  /** Called synchronously before each panel is auto-collapsed */
  onAutoCollapse?: (ref: RefObject<PanelImperativeHandle | null>) => void;
  /** Called synchronously before each panel is auto-expanded.
   *  Return true to skip the default panel.expand() call (caller handled it). */
  onAutoExpand?: (ref: RefObject<PanelImperativeHandle | null>) => boolean | void;
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
  onAutoCollapse,
  onAutoExpand,
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
          onAutoCollapse?.(ref);
          panel.collapse();
          autoCollapsedRef.current.add(ref);
        }
      }
    } else if (isAboveExpandThreshold && autoCollapsedRef.current.size > 0) {
      for (const ref of autoCollapsedRef.current) {
        const handled = onAutoExpand?.(ref);
        if (!handled) ref.current?.expand();
      }
      autoCollapsedRef.current.clear();
    }
  }, [isBelowThreshold, isAboveExpandThreshold, panelRefs]);
}
