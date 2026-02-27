import { useState, useCallback, useRef } from 'react';
import type { RefObject } from 'react';
import type { PanelImperativeHandle, GroupImperativeHandle } from 'react-resizable-panels';

// --- Types ---

export interface PanelEntry {
  /** Which panel group this panel belongs to */
  group: string;
  /** Default expanded size as a percentage of the group */
  defaultSize: number;
  /** Minimum width in pixels (used for auto-collapse threshold calculation) */
  minPx: number;
  /** Priority for auto-collapse ordering: lower numbers get lower thresholds (open first) */
  priority: number;
}

export type PanelConfig = Record<string, PanelEntry>;

export interface PanelManager {
  /** Whether a panel is currently collapsed */
  isCollapsed: (id: string) => boolean;
  /** Toggle a panel between collapsed and expanded */
  toggle: (id: string) => void;
  /** Expand a specific panel */
  expand: (id: string) => void;
  /** React to container width changes for auto-collapse/expand */
  autoResize: (widthPx: number) => void;
  /** Sync state when library reports a panel resize */
  onPanelResize: (id: string, sizePct: number) => void;
  /** Register a panel ref */
  setPanelRef: (id: string, ref: RefObject<PanelImperativeHandle | null>) => void;
  /** Register a group ref */
  setGroupRef: (groupId: string, ref: RefObject<GroupImperativeHandle | null>) => void;
  /** Get the collapsed state map (for rendering) */
  collapsedState: Record<string, boolean>;
}

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

/** Temporarily add panels-animating class for smooth transitions.
 *
 * The class enables `transition: flex-grow 200ms` on child [data-panel] elements.
 * We force a reflow after adding the class so the browser records the current
 * flex-grow values as the transition's "from" state before React asynchronously
 * updates them via setLayout()/collapse().
 *
 * Removal uses transitionend so the class stays for the full animation, with a
 * fallback timeout in case the transition is skipped (e.g. element not visible).
 */
function animatePanels(groupId: string) {
  const el = document.getElementById(groupId);
  if (!el) return;

  el.classList.add('panels-animating');
  // Force reflow — establishes "before" computed styles for the CSS transition
  void el.offsetHeight;

  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    el.classList.remove('panels-animating');
    el.removeEventListener('transitionend', onEnd);
  };

  const onEnd = (e: Event) => {
    // Only react to flex-grow transitions on direct child panels
    if ((e as TransitionEvent).propertyName === 'flex-grow') {
      remove();
    }
  };
  el.addEventListener('transitionend', onEnd);

  // Fallback: remove class after generous timeout if transitionend never fires
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
  const panelRefs = useRef<Record<string, RefObject<PanelImperativeHandle | null>>>({});
  const groupRefs = useRef<Record<string, RefObject<GroupImperativeHandle | null>>>({});
  // Mutable mirror of collapsed state for use inside callbacks without stale closures
  const collapsedRef = useRef(buildInitialCollapsed(config));
  // Tracks panels whose collapsed state was set by a manager action (toggle/autoResize)
  // vs by library sync (onPanelResize). Only manager-set collapsed panels get redistribution guard.
  const managerSetRef = useRef<Set<string>>(new Set());
  // Per-panel user threshold overrides
  const userThresholdRef = useRef<Map<string, number | 'infinity'>>(new Map());
  // Last known viewport width, updated at start of autoResize()
  const lastWidthRef = useRef(0);

  const isCollapsed = useCallback((id: string): boolean => {
    return collapsed[id] ?? false;
  }, [collapsed]);

  const setPanelRef = useCallback((id: string, ref: RefObject<PanelImperativeHandle | null>) => {
    panelRefs.current[id] = ref;
  }, []);

  const setGroupRef = useCallback((groupId: string, ref: RefObject<GroupImperativeHandle | null>) => {
    groupRefs.current[groupId] = ref;
  }, []);

  // Apply the desired collapsed state to a group layout via setLayout()
  const applyGroupLayout = useCallback((groupId: string, desiredState: Record<string, boolean>) => {
    const groupRef = groupRefs.current[groupId];
    const group = groupRef?.current;
    if (!group) return;
    const layout = group.getLayout();
    if (!layout) return;

    const corrected = { ...layout };
    let delta = 0;

    for (const [id, entry] of Object.entries(config)) {
      if (entry.group !== groupId) continue;
      const shouldBeCollapsed = desiredState[id] ?? false;
      if (shouldBeCollapsed && (corrected[id] ?? 0) > 0) {
        delta += corrected[id];
        corrected[id] = 0;
      } else if (!shouldBeCollapsed && (corrected[id] ?? 0) === 0) {
        const targetSize = entry.defaultSize;
        corrected[id] = targetSize;
        delta -= targetSize;
      }
    }

    if (delta !== 0) {
      corrected['editor'] = Math.max((corrected['editor'] ?? 0) + delta, 30);
      group.setLayout(corrected);
    }
  }, [config]);

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

    // Mark as manager-set for redistribution guard
    if (newCollapsed) {
      managerSetRef.current.add(id);
    } else {
      managerSetRef.current.delete(id);
    }

    // Dispatch collapse/expand action based on group type
    if (entry.group === 'app-outer') {
      const panelRef = panelRefs.current[id];
      const panel = panelRef?.current;
      if (panel) {
        animatePanels('app-outer');
        if (newCollapsed) {
          panel.collapse();
        } else {
          panel.expand();
        }
      }
    } else {
      animatePanels(entry.group);
      applyGroupLayout(entry.group, collapsedRef.current);
    }
  }, [config, applyGroupLayout, setUserThreshold]);

  const expand = useCallback((id: string) => {
    const entry = config[id];
    if (!entry) return;
    if (!collapsedRef.current[id]) return; // already expanded, no-op

    // Set user threshold (same as toggle-open)
    setUserThreshold(id, true);

    collapsedRef.current[id] = false;
    setCollapsed(prev => ({ ...prev, [id]: false }));

    if (entry.group === 'app-outer') {
      const panelRef = panelRefs.current[id];
      panelRef?.current?.expand();
    } else {
      animatePanels(entry.group);
      applyGroupLayout(entry.group, collapsedRef.current);
    }
  }, [config, applyGroupLayout, setUserThreshold]);

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
    for (const { id, entry, threshold } of panels) {
      const wantsOpen = widthPx >= threshold && threshold !== Infinity;
      const canFit = usedSpace + entry.minPx <= widthPx;
      shouldBeOpen[id] = wantsOpen && canFit;
      if (shouldBeOpen[id]) usedSpace += entry.minPx;
    }

    // Apply changes — track which groups changed
    let changed = false;
    const changedGroups = new Set<string>();

    for (const [id, entry] of Object.entries(config)) {
      const want = shouldBeOpen[id] ?? false;
      const isCurrentlyOpen = !collapsedRef.current[id];
      if (want !== isCurrentlyOpen) {
        collapsedRef.current[id] = !want;
        if (!want) managerSetRef.current.add(id);
        else managerSetRef.current.delete(id);
        changed = true;
        changedGroups.add(entry.group);

        // For app-outer panels, use panel.collapse()/expand() directly
        if (entry.group === 'app-outer') {
          animatePanels(entry.group);
          const panelRef = panelRefs.current[id];
          if (!want) {
            panelRef?.current?.collapse();
          } else {
            panelRef?.current?.expand();
          }
        }
      }
    }

    if (changed) {
      // Apply layout for editor-area groups that changed
      for (const groupId of changedGroups) {
        if (groupId !== 'app-outer') {
          animatePanels(groupId);
          applyGroupLayout(groupId, collapsedRef.current);
        }
      }
      setCollapsed({ ...collapsedRef.current });
    }
  }, [config, applyGroupLayout]);

  // Sync state from library resize events
  const onPanelResize = useCallback((id: string, sizePct: number) => {
    const entry = config[id];
    if (!entry) return;

    const isNowCollapsed = sizePct === 0;
    const shouldBeCollapsed = collapsedRef.current[id] ?? false;

    // Detect redistribution — panel was collapsed by manager action
    // but library gave it space. Correct atomically.
    if (shouldBeCollapsed && !isNowCollapsed && managerSetRef.current.has(id)) {
      applyGroupLayout(entry.group, collapsedRef.current);
      return;
    }

    // Normal resize — sync our state with what the library reports
    if (collapsedRef.current[id] !== isNowCollapsed) {
      collapsedRef.current[id] = isNowCollapsed;
      managerSetRef.current.delete(id);
      setCollapsed(prev => ({ ...prev, [id]: isNowCollapsed }));
    }
  }, [config, applyGroupLayout]);

  return {
    isCollapsed,
    toggle,
    expand,
    autoResize,
    onPanelResize,
    setPanelRef,
    setGroupRef,
    collapsedState: collapsed,
  };
}
