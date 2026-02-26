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
  /** Auto-collapse tier: lower numbers collapse first. null = never auto-collapse. */
  tier: number | null;
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

const HYSTERESIS_PX = 50;
const CONTENT_MIN_PX = 450;

// Initial collapsed state: discussion starts collapsed, everything else expanded
function buildInitialCollapsed(config: PanelConfig): Record<string, boolean> {
  const state: Record<string, boolean> = {};
  for (const id of Object.keys(config)) {
    state[id] = id === 'discussion'; // only discussion starts collapsed
  }
  return state;
}

/** Temporarily add panels-animating class for smooth transitions */
function animatePanels(groupId: string) {
  const el = document.getElementById(groupId);
  if (!el) return;
  el.classList.add('panels-animating');
  setTimeout(() => el.classList.remove('panels-animating'), 200);
}

export function usePanelManager(config: PanelConfig): PanelManager {
  const [collapsed, setCollapsed] = useState(() => buildInitialCollapsed(config));
  const panelRefs = useRef<Record<string, RefObject<PanelImperativeHandle | null>>>({});
  const groupRefs = useRef<Record<string, RefObject<GroupImperativeHandle | null>>>({});
  // Tracks which panels were auto-collapsed (not manually) for selective re-expand
  const autoCollapsedRef = useRef<Set<string>>(new Set());
  // Mutable mirror of collapsed state for use inside callbacks without stale closures
  const collapsedRef = useRef(buildInitialCollapsed(config));
  // Tracks panels whose collapsed state was set by a manager action (toggle/autoResize)
  // vs by library sync (onPanelResize). Only manager-set collapsed panels get redistribution guard.
  const managerSetRef = useRef<Set<string>>(new Set());

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
  // Panels marked collapsed → 0%, panels marked expanded → defaultSize, editor absorbs delta
  const applyGroupLayout = useCallback((groupId: string, desiredState: Record<string, boolean>) => {
    const groupRef = groupRefs.current[groupId];
    const group = groupRef?.current;
    if (!group) return;
    const layout = group.getLayout();
    if (!layout) return;

    const corrected = { ...layout };
    let delta = 0;

    // Only apply to panels in this group
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

  // Cycle 2-5: toggle
  const toggle = useCallback((id: string) => {
    const entry = config[id];
    if (!entry) return;

    const wasCollapsed = collapsedRef.current[id] ?? false;
    const newCollapsed = !wasCollapsed;

    // Update state
    collapsedRef.current[id] = newCollapsed;
    setCollapsed(prev => ({ ...prev, [id]: newCollapsed }));

    // Mark as manager-set for redistribution guard
    if (newCollapsed) {
      managerSetRef.current.add(id);
    } else {
      managerSetRef.current.delete(id);
    }

    // Clear auto-collapsed flag on manual toggle
    autoCollapsedRef.current.delete(id);

    // Dispatch collapse/expand action based on group type
    if (entry.group === 'app-outer') {
      // Cycle 5: left sidebar uses panel.collapse()/expand() directly
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
      // Cycle 4: editor-area panels use group.setLayout()
      animatePanels(entry.group);
      applyGroupLayout(entry.group, collapsedRef.current);
    }
  }, [config, applyGroupLayout]);

  // Cycle 12: expand a specific panel
  const expand = useCallback((id: string) => {
    const entry = config[id];
    if (!entry) return;
    if (!collapsedRef.current[id]) return; // already expanded, no-op

    collapsedRef.current[id] = false;
    setCollapsed(prev => ({ ...prev, [id]: false }));
    autoCollapsedRef.current.delete(id);

    if (entry.group === 'app-outer') {
      const panelRef = panelRefs.current[id];
      panelRef?.current?.expand();
    } else {
      animatePanels(entry.group);
      applyGroupLayout(entry.group, collapsedRef.current);
    }
  }, [config, applyGroupLayout]);

  // Cycles 6-9: auto-collapse/expand based on viewport width
  const autoResize = useCallback((widthPx: number) => {
    if (widthPx <= 0) return;

    // Gather tiers (unique, sorted ascending — lower tiers collapse first)
    const tiers = [...new Set(
      Object.values(config).map(e => e.tier).filter((t): t is number => t !== null)
    )].sort((a, b) => a - b);

    // For each tier, calculate threshold and decide collapse/expand
    for (const tier of tiers) {
      const tierPanels = Object.entries(config).filter(([, e]) => e.tier === tier);
      const tierMinPx = tierPanels.reduce((sum, [, e]) => sum + e.minPx, 0);

      // Include minPx of panels from OTHER tiers that aren't collapsed
      const otherMinPx = Object.entries(config)
        .filter(([id, e]) => e.tier !== null && e.tier !== tier && !collapsedRef.current[id])
        .reduce((sum, [, e]) => sum + e.minPx, 0);

      const threshold = tierMinPx + otherMinPx + CONTENT_MIN_PX;
      const isBelowThreshold = widthPx < threshold;
      const isAboveExpandThreshold = widthPx >= threshold + HYSTERESIS_PX;

      if (isBelowThreshold) {
        // Auto-collapse all panels in this tier that aren't already collapsed
        let changed = false;
        for (const [id] of tierPanels) {
          if (!collapsedRef.current[id]) {
            collapsedRef.current[id] = true;
            autoCollapsedRef.current.add(id);
            managerSetRef.current.add(id);
            changed = true;

            // For app-outer panels, use panel.collapse() directly
            const entry = config[id];
            if (entry.group === 'app-outer') {
              animatePanels(entry.group);
              const panelRef = panelRefs.current[id];
              panelRef?.current?.collapse();
            }
          }
        }
        if (changed) {
          // Apply layout for editor-area groups
          const editorAreaPanels = tierPanels.filter(([, e]) => e.group !== 'app-outer');
          if (editorAreaPanels.length > 0) {
            const groupId = editorAreaPanels[0][1].group;
            animatePanels(groupId);
            applyGroupLayout(groupId, collapsedRef.current);
          }
          setCollapsed({ ...collapsedRef.current });
        }
      } else if (isAboveExpandThreshold) {
        // Re-expand only panels that were auto-collapsed
        let changed = false;
        for (const [id] of tierPanels) {
          if (autoCollapsedRef.current.has(id)) {
            collapsedRef.current[id] = false;
            autoCollapsedRef.current.delete(id);
            managerSetRef.current.delete(id);
            changed = true;

            const entry = config[id];
            if (entry.group === 'app-outer') {
              animatePanels(entry.group);
              const panelRef = panelRefs.current[id];
              panelRef?.current?.expand();
            }
          }
        }
        if (changed) {
          const editorAreaPanels = tierPanels.filter(([, e]) => e.group !== 'app-outer');
          if (editorAreaPanels.length > 0) {
            const groupId = editorAreaPanels[0][1].group;
            animatePanels(groupId);
            applyGroupLayout(groupId, collapsedRef.current);
          }
          setCollapsed({ ...collapsedRef.current });
        }
      }
    }
  }, [config, applyGroupLayout]);

  // Cycles 10-11: sync state from library resize events
  const onPanelResize = useCallback((id: string, sizePct: number) => {
    const entry = config[id];
    if (!entry) return;

    const isNowCollapsed = sizePct === 0;
    const shouldBeCollapsed = collapsedRef.current[id] ?? false;

    // Cycle 11: Detect redistribution — panel was collapsed by manager action
    // (toggle/autoResize) but library gave it space. Correct atomically.
    if (shouldBeCollapsed && !isNowCollapsed && managerSetRef.current.has(id)) {
      applyGroupLayout(entry.group, collapsedRef.current);
      return;
    }

    // Cycle 10: Normal resize — sync our state with what the library reports
    if (collapsedRef.current[id] !== isNowCollapsed) {
      collapsedRef.current[id] = isNowCollapsed;
      managerSetRef.current.delete(id); // library now owns this state
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
