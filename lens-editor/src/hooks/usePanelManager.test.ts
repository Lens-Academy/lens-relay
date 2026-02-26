import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { usePanelManager, type PanelConfig } from './usePanelManager';
import type { PanelImperativeHandle, GroupImperativeHandle } from 'react-resizable-panels';

// --- Test helpers ---

function mockPanelRef(collapsed = false): React.RefObject<PanelImperativeHandle> {
  return {
    current: {
      collapse: vi.fn(),
      expand: vi.fn(),
      isCollapsed: () => collapsed,
      isExpanded: () => !collapsed,
      getSize: () => collapsed ? 0 : 20,
      resize: vi.fn(),
    } as unknown as PanelImperativeHandle,
  };
}

function mockGroupRef(layout: Record<string, number> = {}): React.RefObject<GroupImperativeHandle> {
  return {
    current: {
      getLayout: vi.fn(() => ({ ...layout })),
      setLayout: vi.fn(),
      getId: vi.fn(() => 'test-group'),
    } as unknown as GroupImperativeHandle,

  };
}

const DEFAULT_CONFIG: PanelConfig = {
  'left-sidebar':   { group: 'app-outer',   defaultSize: 18, minPx: 200, tier: 2 },
  'right-sidebar':  { group: 'editor-area', defaultSize: 22, minPx: 200, tier: 2 },
  'comment-margin': { group: 'editor-area', defaultSize: 16, minPx: 0,   tier: null },
  'discussion':     { group: 'editor-area', defaultSize: 20, minPx: 250, tier: 1 },
};

// --- Tests ---

describe('usePanelManager', () => {
  describe('Cycle 1: isCollapsed returns initial state', () => {
    it('discussion starts collapsed', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      expect(result.current.isCollapsed('discussion')).toBe(true);
    });

    it('right-sidebar starts expanded', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      expect(result.current.isCollapsed('right-sidebar')).toBe(false);
    });

    it('left-sidebar starts expanded', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      expect(result.current.isCollapsed('left-sidebar')).toBe(false);
    });

    it('comment-margin starts expanded', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      expect(result.current.isCollapsed('comment-margin')).toBe(false);
    });
  });

  describe('Cycle 2: toggle flips collapsed state', () => {
    it('toggling right-sidebar collapses it', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => result.current.toggle('right-sidebar'));
      expect(result.current.isCollapsed('right-sidebar')).toBe(true);
    });

    it('toggling right-sidebar twice restores it', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => result.current.toggle('right-sidebar'));
      act(() => result.current.toggle('right-sidebar'));
      expect(result.current.isCollapsed('right-sidebar')).toBe(false);
    });

    it('toggling discussion expands it (starts collapsed)', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => result.current.toggle('discussion'));
      expect(result.current.isCollapsed('discussion')).toBe(false);
    });
  });

  describe('Cycle 3: toggle calls panel collapse/expand on left-sidebar ref', () => {
    it('toggle left-sidebar calls panel.collapse() when expanded', () => {
      const panelRef = mockPanelRef(false);
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => result.current.setPanelRef('left-sidebar', panelRef));
      act(() => result.current.toggle('left-sidebar'));
      expect(panelRef.current!.collapse).toHaveBeenCalled();
    });

    it('toggle left-sidebar calls panel.expand() when collapsed', () => {
      const panelRef = mockPanelRef(true);
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => result.current.setPanelRef('left-sidebar', panelRef));
      // Left sidebar starts expanded in state, so first toggle collapses
      act(() => result.current.toggle('left-sidebar'));
      // Now toggle back
      act(() => result.current.toggle('left-sidebar'));
      expect(panelRef.current!.expand).toHaveBeenCalled();
    });
  });

  describe('Cycle 4: editor-area panels use setLayout', () => {
    it('toggle right-sidebar calls group.setLayout with right-sidebar at 0%', () => {
      const groupRef = mockGroupRef({ editor: 62, 'comment-margin': 16, 'right-sidebar': 22 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => result.current.setGroupRef('editor-area', groupRef));
      act(() => result.current.toggle('right-sidebar'));

      expect(groupRef.current!.setLayout).toHaveBeenCalled();
      const layout = vi.mocked(groupRef.current!.setLayout).mock.calls[0][0] as Record<string, number>;
      expect(layout['right-sidebar']).toBe(0);
    });

    it('toggle right-sidebar again calls setLayout with right-sidebar at defaultSize', () => {
      const groupRef = mockGroupRef({ editor: 62, 'comment-margin': 16, 'right-sidebar': 22 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => result.current.setGroupRef('editor-area', groupRef));

      // Collapse
      act(() => result.current.toggle('right-sidebar'));
      // Update mock layout to reflect collapsed state
      vi.mocked(groupRef.current!.getLayout).mockReturnValue({ editor: 84, 'comment-margin': 16, 'right-sidebar': 0 });

      // Expand
      act(() => result.current.toggle('right-sidebar'));
      const calls = vi.mocked(groupRef.current!.setLayout).mock.calls;
      const lastLayout = calls[calls.length - 1][0] as Record<string, number>;
      expect(lastLayout['right-sidebar']).toBe(22); // defaultSize
    });

    it('editor panel absorbs freed space when collapsing', () => {
      const groupRef = mockGroupRef({ editor: 62, 'comment-margin': 16, 'right-sidebar': 22 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => result.current.setGroupRef('editor-area', groupRef));
      act(() => result.current.toggle('right-sidebar'));

      const layout = vi.mocked(groupRef.current!.setLayout).mock.calls[0][0] as Record<string, number>;
      expect(layout['editor']).toBe(84); // 62 + 22
    });
  });

  describe('Cycle 5: left sidebar uses panel.collapse/expand directly (not setLayout)', () => {
    it('toggle left-sidebar does NOT call any group setLayout', () => {
      const panelRef = mockPanelRef(false);
      const groupRef = mockGroupRef({ sidebar: 18, 'main-content': 82 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => {
        result.current.setPanelRef('left-sidebar', panelRef);
        result.current.setGroupRef('app-outer', groupRef);
      });
      act(() => result.current.toggle('left-sidebar'));

      expect(panelRef.current!.collapse).toHaveBeenCalled();
      expect(groupRef.current!.setLayout).not.toHaveBeenCalled();
    });
  });

  describe('Cycle 6: autoResize collapses tier 1 panels below threshold', () => {
    it('auto-collapses discussion when width < tier 1 threshold', () => {
      const groupRef = mockGroupRef({ editor: 42, 'comment-margin': 16, 'right-sidebar': 22, discussion: 20 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => result.current.setGroupRef('editor-area', groupRef));
      // Expand discussion first
      act(() => result.current.toggle('discussion'));
      vi.mocked(groupRef.current!.setLayout).mockClear();
      vi.mocked(groupRef.current!.getLayout).mockReturnValue({ editor: 42, 'comment-margin': 16, 'right-sidebar': 22, discussion: 20 });

      // Tier 1 threshold: 250 (discussion) + 200 (right) + 200 (left) + 450 (content) = 1100
      act(() => result.current.autoResize(1000));

      expect(result.current.isCollapsed('discussion')).toBe(true);
    });

    it('does not collapse tier 2 panels when only below tier 1 threshold', () => {
      const groupRef = mockGroupRef({ editor: 42, 'comment-margin': 16, 'right-sidebar': 22, discussion: 20 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => result.current.setGroupRef('editor-area', groupRef));
      // Expand discussion first
      act(() => result.current.toggle('discussion'));
      vi.mocked(groupRef.current!.setLayout).mockClear();

      act(() => result.current.autoResize(1000));

      expect(result.current.isCollapsed('left-sidebar')).toBe(false);
      expect(result.current.isCollapsed('right-sidebar')).toBe(false);
    });
  });

  describe('Cycle 7: autoResize collapses tier 2 panels below threshold', () => {
    it('auto-collapses left and right sidebars when width < tier 2 threshold', () => {
      const panelRef = mockPanelRef(false);
      const groupRef = mockGroupRef({ editor: 62, 'comment-margin': 16, 'right-sidebar': 22 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => {
        result.current.setPanelRef('left-sidebar', panelRef);
        result.current.setGroupRef('editor-area', groupRef);
      });

      // Tier 2 threshold: 200 (left) + 200 (right) + 450 (content) = 850
      act(() => result.current.autoResize(800));

      expect(result.current.isCollapsed('left-sidebar')).toBe(true);
      expect(result.current.isCollapsed('right-sidebar')).toBe(true);
    });
  });

  describe('Cycle 8: autoResize re-expands with hysteresis', () => {
    it('stays collapsed within hysteresis zone', () => {
      const panelRef = mockPanelRef(false);
      const groupRef = mockGroupRef({ editor: 62, 'comment-margin': 16, 'right-sidebar': 22 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => {
        result.current.setPanelRef('left-sidebar', panelRef);
        result.current.setGroupRef('editor-area', groupRef);
      });

      // Collapse at 800 (below 850 threshold)
      act(() => result.current.autoResize(800));
      expect(result.current.isCollapsed('right-sidebar')).toBe(true);

      // 870 is within hysteresis (850 + 50 = 900)
      act(() => result.current.autoResize(870));
      expect(result.current.isCollapsed('right-sidebar')).toBe(true);
    });

    it('re-expands above threshold + hysteresis', () => {
      const panelRef = mockPanelRef(false);
      const groupRef = mockGroupRef({ editor: 62, 'comment-margin': 16, 'right-sidebar': 22 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => {
        result.current.setPanelRef('left-sidebar', panelRef);
        result.current.setGroupRef('editor-area', groupRef);
      });

      act(() => result.current.autoResize(800));
      expect(result.current.isCollapsed('right-sidebar')).toBe(true);

      // 901 is above hysteresis (850 + 50 = 900)
      vi.mocked(groupRef.current!.getLayout).mockReturnValue({ editor: 100, 'comment-margin': 0, 'right-sidebar': 0 });
      act(() => result.current.autoResize(901));
      expect(result.current.isCollapsed('right-sidebar')).toBe(false);
      expect(result.current.isCollapsed('left-sidebar')).toBe(false);
    });
  });

  describe('Cycle 9: autoResize only re-expands panels it auto-collapsed', () => {
    it('manually collapsed panel stays collapsed after auto-cycle', () => {
      const panelRef = mockPanelRef(false);
      const groupRef = mockGroupRef({ editor: 62, 'comment-margin': 16, 'right-sidebar': 22 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => {
        result.current.setPanelRef('left-sidebar', panelRef);
        result.current.setGroupRef('editor-area', groupRef);
      });

      // Manually collapse right-sidebar
      act(() => result.current.toggle('right-sidebar'));
      vi.mocked(groupRef.current!.getLayout).mockReturnValue({ editor: 84, 'comment-margin': 16, 'right-sidebar': 0 });
      vi.mocked(groupRef.current!.setLayout).mockClear();

      // Auto-collapse (drops below threshold)
      act(() => result.current.autoResize(800));
      expect(result.current.isCollapsed('left-sidebar')).toBe(true);

      // Auto-expand
      vi.mocked(groupRef.current!.getLayout).mockReturnValue({ editor: 100, 'comment-margin': 0, 'right-sidebar': 0 });
      act(() => result.current.autoResize(901));

      // Left sidebar should re-expand (was auto-collapsed)
      expect(result.current.isCollapsed('left-sidebar')).toBe(false);
      // Right sidebar should stay collapsed (was manually collapsed before auto-collapse)
      expect(result.current.isCollapsed('right-sidebar')).toBe(true);
    });
  });

  describe('Cycle 10: onPanelResize syncs state from library', () => {
    it('onPanelResize to 0 marks panel as collapsed', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => result.current.onPanelResize('right-sidebar', 0));
      expect(result.current.isCollapsed('right-sidebar')).toBe(true);
    });

    it('onPanelResize to non-zero marks panel as expanded', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      // First collapse
      act(() => result.current.onPanelResize('right-sidebar', 0));
      // Then resize to non-zero
      act(() => result.current.onPanelResize('right-sidebar', 22));
      expect(result.current.isCollapsed('right-sidebar')).toBe(false);
    });
  });

  describe('Cycle 11: onPanelResize corrects redistribution', () => {
    it('calls setLayout when collapsed panel reports non-zero size', () => {
      const groupRef = mockGroupRef({ editor: 60, 'comment-margin': 16, 'right-sidebar': 24 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => result.current.setGroupRef('editor-area', groupRef));

      // Collapse right-sidebar
      act(() => result.current.toggle('right-sidebar'));
      vi.mocked(groupRef.current!.setLayout).mockClear();
      vi.mocked(groupRef.current!.getLayout).mockReturnValue({ editor: 78, 'comment-margin': 16, 'right-sidebar': 6 });

      // Library reports redistribution: collapsed panel has size > 0
      act(() => result.current.onPanelResize('right-sidebar', 6));

      // Should have corrected by calling setLayout
      expect(groupRef.current!.setLayout).toHaveBeenCalled();
    });
  });

  describe('Cycle 12: expand(id) expands a specific panel', () => {
    it('expand comment-margin expands it', () => {
      const groupRef = mockGroupRef({ editor: 84, 'comment-margin': 0, 'right-sidebar': 16 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => result.current.setGroupRef('editor-area', groupRef));

      // Collapse comment-margin first
      act(() => result.current.toggle('comment-margin'));
      vi.mocked(groupRef.current!.setLayout).mockClear();
      vi.mocked(groupRef.current!.getLayout).mockReturnValue({ editor: 84, 'comment-margin': 0, 'right-sidebar': 16 });

      // Expand it
      act(() => result.current.expand('comment-margin'));
      expect(result.current.isCollapsed('comment-margin')).toBe(false);
    });

    it('expand on already expanded panel is a no-op', () => {
      const groupRef = mockGroupRef({ editor: 62, 'comment-margin': 16, 'right-sidebar': 22 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => result.current.setGroupRef('editor-area', groupRef));

      act(() => result.current.expand('right-sidebar'));
      // Should not crash, state should remain expanded
      expect(result.current.isCollapsed('right-sidebar')).toBe(false);
    });
  });

  describe('Cycle 13: autoResize animates app-outer panels', () => {
    it('adds panels-animating class to app-outer group on auto-collapse', () => {
      // Create a real DOM element for getElementById to find
      const appOuterEl = document.createElement('div');
      appOuterEl.id = 'app-outer';
      document.body.appendChild(appOuterEl);

      const panelRef = mockPanelRef(false);
      const groupRef = mockGroupRef({ editor: 62, 'comment-margin': 16, 'right-sidebar': 22 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => {
        result.current.setPanelRef('left-sidebar', panelRef);
        result.current.setGroupRef('editor-area', groupRef);
      });

      // Auto-collapse tier 2 (below 850 threshold)
      act(() => result.current.autoResize(800));

      expect(appOuterEl.classList.contains('panels-animating')).toBe(true);

      document.body.removeChild(appOuterEl);
    });

    it('adds panels-animating class to app-outer group on auto-expand', () => {
      const appOuterEl = document.createElement('div');
      appOuterEl.id = 'app-outer';
      document.body.appendChild(appOuterEl);

      const panelRef = mockPanelRef(false);
      const groupRef = mockGroupRef({ editor: 62, 'comment-margin': 16, 'right-sidebar': 22 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => {
        result.current.setPanelRef('left-sidebar', panelRef);
        result.current.setGroupRef('editor-area', groupRef);
      });

      // Auto-collapse
      act(() => result.current.autoResize(800));
      appOuterEl.classList.remove('panels-animating');

      // Auto-expand (above 850 + 50 hysteresis = 900)
      vi.mocked(groupRef.current!.getLayout).mockReturnValue({ editor: 100, 'comment-margin': 0, 'right-sidebar': 0 });
      act(() => result.current.autoResize(901));

      expect(appOuterEl.classList.contains('panels-animating')).toBe(true);

      document.body.removeChild(appOuterEl);
    });
  });
});
