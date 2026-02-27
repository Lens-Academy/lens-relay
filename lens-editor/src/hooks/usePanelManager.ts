import { useState, useCallback, useRef } from 'react';

// --- Types ---

export interface PanelEntry {
  /** Which panel group this panel belongs to */
  group: string;
  /** Minimum width in pixels (used for auto-collapse threshold calculation and drag clamping) */
  minPx: number;
  /** Preferred max width in pixels (expand target, auto-resize cap) */
  maxPx?: number;
  /** Priority for auto-collapse ordering: lower numbers get lower thresholds (open first) */
  priority: number;
}

export type PanelConfig = Record<string, PanelEntry>;

export interface PanelDebugInfo {
  lastWidth: number;
  userThresholds: Map<string, number | 'infinity'>;
  widths: Record<string, number>;
}

export interface PanelManager {
  /** Whether a panel is currently collapsed */
  isCollapsed: (id: string) => boolean;
  /** Toggle a panel between collapsed and expanded */
  toggle: (id: string) => void;
  /** Expand a specific panel */
  expand: (id: string) => void;
  /** React to container width changes for auto-collapse/expand */
  autoResize: (widthPx: number) => void;
  /** Get pixel width for a panel */
  getWidth: (id: string) => number;
  /** Set pixel width for a panel (clamped to minPx) */
  setWidth: (id: string, width: number) => void;
  /** Called after user finishes dragging a resize handle — records user threshold */
  onDragEnd: (id: string) => void;
  /** Get the collapsed state map (for rendering) */
  collapsedState: Record<string, boolean>;
  /** Get debug info snapshot (viewport width, user thresholds, pixel widths) */
  getDebugInfo: () => PanelDebugInfo;
}

export const EDITOR_MIN_PX = 250;  // matches EditorArea.tsx style={{ minWidth: 250 }}
export const HANDLE_WIDTH = 9;     // matches ResizeHandle.tsx style={{ width: 9 }}

const CONTENT_MIN_PX = 450;
const OPEN_BUFFER = 150;
const CLOSE_BUFFER_FIXED = 100;
const CLOSE_BUFFER_PCT = 0.1;
const WIDE_BOUNDARY = 1500;

// Initial collapsed state: discussion starts collapsed, everything else expanded
function buildInitialCollapsed(config: PanelConfig): Record<string, boolean> {
  const state: Record<string, boolean> = {};
  for (const id of Object.keys(config)) {
    state[id] = id === 'discussion'; // only discussion starts collapsed
  }
  return state;
}

// Build initial pixel widths for ALL panels
function buildInitialWidths(config: PanelConfig): Record<string, number> {
  const widths: Record<string, number> = {};
  for (const [id, entry] of Object.entries(config)) {
    widths[id] = entry.maxPx ?? entry.minPx;
  }
  return widths;
}

/** Temporarily add sidebar-animating class for smooth width transitions. */
function animateContainer(containerId: string) {
  const el = document.getElementById(containerId);
  if (!el) return;

  el.classList.add('sidebar-animating');
  // Force reflow so browser records current widths before React updates them
  void el.offsetHeight;

  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    el.classList.remove('sidebar-animating');
    el.removeEventListener('transitionend', onEnd);
  };

  const onEnd = (e: Event) => {
    if ((e as TransitionEvent).propertyName === 'width') {
      remove();
    }
  };
  el.addEventListener('transitionend', onEnd);

  // Fallback timeout
  setTimeout(remove, 500);
}

/**
 * Compute default thresholds for each panel based on priority order.
 * Panels at 'infinity' are skipped, which lowers other panels' defaults.
 */
export function computeDefaultThresholds(
  config: PanelConfig,
  userThresholds: Map<string, number | 'infinity'>
): Map<string, number> {
  const panels = Object.entries(config)
    .filter(([id]) => userThresholds.get(id) !== 'infinity')
    .sort(([, a], [, b]) => a.priority - b.priority);

  let cumulative = CONTENT_MIN_PX;
  const defaults = new Map<string, number>();
  for (const [id, entry] of panels) {
    cumulative += entry.minPx;
    defaults.set(id, cumulative);
  }
  return defaults;
}

export function usePanelManager(config: PanelConfig): PanelManager {
  const [collapsed, setCollapsed] = useState(() => buildInitialCollapsed(config));
  const [widths, setWidths] = useState(() => buildInitialWidths(config));
  // Mutable mirror of collapsed state for use inside callbacks without stale closures
  const collapsedRef = useRef(buildInitialCollapsed(config));
  // Per-panel user threshold overrides
  const userThresholdRef = useRef<Map<string, number | 'infinity'>>(new Map());
  // Last known viewport width, updated at start of autoResize()
  const lastWidthRef = useRef(0);

  const isCollapsed = useCallback((id: string): boolean => {
    return collapsed[id] ?? false;
  }, [collapsed]);

  // --- Pixel width management ---

  const getWidth = useCallback((id: string): number => {
    return widths[id] ?? 0;
  }, [widths]);

  const setWidth = useCallback((id: string, width: number): void => {
    const entry = config[id];
    if (!entry) return;

    setWidths(prev => {
      const containerWidth = lastWidthRef.current;
      let maxWidth = Infinity;

      if (containerWidth > 0) {
        if (entry.group === 'app-outer') {
          // Left sidebar: max = container - editor min - visible editor-area panels - own handle
          let editorAreaSpace = 0;
          for (const [otherId, otherEntry] of Object.entries(config)) {
            if (otherEntry.group === 'editor-area' && !collapsedRef.current[otherId]) {
              editorAreaSpace += (prev[otherId] ?? 0) + HANDLE_WIDTH;
            }
          }
          maxWidth = containerWidth - EDITOR_MIN_PX - editorAreaSpace - HANDLE_WIDTH;
        } else {
          // Editor-area panel: max = editorAreaWidth - editor min - other visible panels - own handle
          let leftSpace = 0;
          for (const [otherId, otherEntry] of Object.entries(config)) {
            if (otherEntry.group === 'app-outer' && !collapsedRef.current[otherId]) {
              leftSpace += (prev[otherId] ?? 0) + HANDLE_WIDTH;
            }
          }
          const editorAreaWidth = containerWidth - leftSpace;

          let otherEditorSpace = 0;
          for (const [otherId, otherEntry] of Object.entries(config)) {
            if (otherId !== id && otherEntry.group === 'editor-area' && !collapsedRef.current[otherId]) {
              otherEditorSpace += (prev[otherId] ?? 0) + HANDLE_WIDTH;
            }
          }
          maxWidth = editorAreaWidth - EDITOR_MIN_PX - otherEditorSpace - HANDLE_WIDTH;
        }
      }

      const clamped = Math.max(entry.minPx, Math.min(width, maxWidth));
      return { ...prev, [id]: clamped };
    });
  }, [config]);

  const onDragEnd = useCallback((id: string): void => {
    // After user drag, set threshold so auto-resize respects the user's manual choice
    const W = lastWidthRef.current;
    if (W >= WIDE_BOUNDARY) {
      // At wide viewport, don't set threshold — user drag doesn't imply auto-resize preference
      return;
    }
    // Set a close buffer so auto-resize won't immediately collapse what user just sized
    userThresholdRef.current.set(id, W + CLOSE_BUFFER_FIXED + W * CLOSE_BUFFER_PCT);
  }, []);

  // Set user threshold when user opens or closes a panel
  const setUserThreshold = useCallback((id: string, opening: boolean) => {
    const W = lastWidthRef.current;

    if (opening) {
      // When reopening from infinity, clear the override first so default computation
      // includes this panel, then decide whether to set a lowered threshold.
      const wasInfinity = userThresholdRef.current.get(id) === 'infinity';
      if (wasInfinity) {
        userThresholdRef.current.delete(id);
      }

      const defaults = computeDefaultThresholds(config, userThresholdRef.current);
      const defaultT = defaults.get(id) ?? Infinity;
      const buffered = W - OPEN_BUFFER;
      if (buffered < defaultT) {
        userThresholdRef.current.set(id, buffered);
      } else {
        userThresholdRef.current.delete(id); // restore default
      }
    } else {
      if (W >= WIDE_BOUNDARY) {
        userThresholdRef.current.set(id, 'infinity');
      } else {
        userThresholdRef.current.set(id, W + CLOSE_BUFFER_FIXED + W * CLOSE_BUFFER_PCT);
      }
    }
  }, [config]);

  const toggle = useCallback((id: string) => {
    const entry = config[id];
    if (!entry) return;

    const wasCollapsed = collapsedRef.current[id] ?? false;
    const newCollapsed = !wasCollapsed;

    // Set user threshold before state change
    setUserThreshold(id, !newCollapsed);

    // Update state
    collapsedRef.current[id] = newCollapsed;
    setCollapsed(prev => ({ ...prev, [id]: newCollapsed }));

    // Animate width transition
    animateContainer(entry.group);
    if (!newCollapsed) {
      // Expanding — set width to maxPx (preferred size)
      setWidths(prev => ({ ...prev, [id]: entry.maxPx ?? entry.minPx }));
    }
  }, [config, setUserThreshold]);

  const expand = useCallback((id: string) => {
    const entry = config[id];
    if (!entry) return;
    if (!collapsedRef.current[id]) return; // already expanded, no-op

    // Set user threshold (same as toggle-open)
    setUserThreshold(id, true);

    collapsedRef.current[id] = false;
    setCollapsed(prev => ({ ...prev, [id]: false }));

    // Animate and set pixel width
    animateContainer(entry.group);
    setWidths(prev => ({ ...prev, [id]: entry.maxPx ?? entry.minPx }));
  }, [config, setUserThreshold]);

  // Auto-collapse/expand based on viewport width using greedy fill
  const autoResize = useCallback((widthPx: number) => {
    if (widthPx <= 0) return;
    lastWidthRef.current = widthPx;

    const defaults = computeDefaultThresholds(config, userThresholdRef.current);

    // Build sorted panel list with effective thresholds
    const panels = Object.entries(config)
      .map(([id, entry]) => {
        const userT = userThresholdRef.current.get(id);
        const effectiveT = userT === 'infinity' ? Infinity
          : userT ?? defaults.get(id) ?? Infinity;
        return { id, entry, threshold: effectiveT };
      })
      .sort((a, b) => a.threshold - b.threshold);

    // Greedy fill
    let usedSpace = CONTENT_MIN_PX;
    const shouldBeOpen: Record<string, boolean> = {};
    const newWidths: Record<string, number> = {};
    for (const { id, entry, threshold } of panels) {
      const wantsOpen = widthPx >= threshold && threshold !== Infinity;
      const canFit = usedSpace + entry.minPx <= widthPx;
      shouldBeOpen[id] = wantsOpen && canFit;
      if (shouldBeOpen[id]) {
        // Allocate pixel width up to maxPx
        const targetWidth = Math.min(entry.maxPx ?? entry.minPx, widthPx - usedSpace);
        newWidths[id] = Math.max(targetWidth, entry.minPx);
        usedSpace += entry.minPx;
      }
    }

    // Apply changes
    let changed = false;
    const animatedGroups = new Set<string>();

    for (const [id, entry] of Object.entries(config)) {
      const want = shouldBeOpen[id] ?? false;
      const isCurrentlyOpen = !collapsedRef.current[id];
      if (want !== isCurrentlyOpen) {
        collapsedRef.current[id] = !want;
        changed = true;
        animatedGroups.add(entry.group);
      }
    }

    if (changed) {
      // Animate all affected container groups
      for (const group of animatedGroups) {
        animateContainer(group);
      }
      // Update widths for newly opened panels
      setWidths(prev => {
        const updated = { ...prev };
        for (const [id, w] of Object.entries(newWidths)) {
          updated[id] = w;
        }
        return updated;
      });
      setCollapsed({ ...collapsedRef.current });
    }
  }, [config]);

  const getDebugInfo = useCallback((): PanelDebugInfo => ({
    lastWidth: lastWidthRef.current,
    userThresholds: new Map(userThresholdRef.current),
    widths: { ...widths },
  }), [widths]);

  return {
    isCollapsed,
    toggle,
    expand,
    autoResize,
    getWidth,
    setWidth,
    onDragEnd,
    collapsedState: collapsed,
    getDebugInfo,
  };
}
