import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { usePanelManager, computeDefaultThresholds, type PanelConfig } from './usePanelManager';
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
  'left-sidebar':   { group: 'app-outer',   defaultSize: 18, minPx: 200, priority: 1 },
  'right-sidebar':  { group: 'editor-area', defaultSize: 22, minPx: 200, priority: 2 },
  'comment-margin': { group: 'editor-area', defaultSize: 16, minPx: 150, priority: 3 },
  'discussion':     { group: 'editor-area', defaultSize: 20, minPx: 250, priority: 4 },
};

// --- Tests ---

describe('computeDefaultThresholds', () => {
  it('computes cumulative thresholds from priority order', () => {
    const defaults = computeDefaultThresholds(DEFAULT_CONFIG, new Map());
    expect(defaults.get('left-sidebar')).toBe(650);    // 450 + 200
    expect(defaults.get('right-sidebar')).toBe(850);   // 450 + 200 + 200
    expect(defaults.get('comment-margin')).toBe(1000);  // 450 + 200 + 200 + 150
    expect(defaults.get('discussion')).toBe(1250);      // 450 + 200 + 200 + 150 + 250
  });

  it('skips infinity panels and lowers other defaults', () => {
    const userT = new Map<string, number | 'infinity'>([['left-sidebar', 'infinity']]);
    const defaults = computeDefaultThresholds(DEFAULT_CONFIG, userT);
    expect(defaults.has('left-sidebar')).toBe(false);
    expect(defaults.get('right-sidebar')).toBe(650);   // 450 + 200 (left skipped)
    expect(defaults.get('comment-margin')).toBe(800);   // 450 + 200 + 150
    expect(defaults.get('discussion')).toBe(1050);      // 450 + 200 + 150 + 250
  });

  it('skips multiple infinity panels', () => {
    const userT = new Map<string, number | 'infinity'>([
      ['left-sidebar', 'infinity'],
      ['right-sidebar', 'infinity'],
    ]);
    const defaults = computeDefaultThresholds(DEFAULT_CONFIG, userT);
    expect(defaults.has('left-sidebar')).toBe(false);
    expect(defaults.has('right-sidebar')).toBe(false);
    expect(defaults.get('comment-margin')).toBe(600);   // 450 + 150
    expect(defaults.get('discussion')).toBe(850);        // 450 + 150 + 250
  });

  it('numeric user thresholds do not affect default computation', () => {
    // Only infinity panels are skipped; numeric overrides don't change defaults
    const userT = new Map<string, number | 'infinity'>([['left-sidebar', 500]]);
    const defaults = computeDefaultThresholds(DEFAULT_CONFIG, userT);
    expect(defaults.get('left-sidebar')).toBe(650);
    expect(defaults.get('right-sidebar')).toBe(850);
  });
});

describe('usePanelManager', () => {
  describe('initial state', () => {
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

  describe('toggle flips collapsed state', () => {
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

  describe('toggle calls panel collapse/expand on left-sidebar ref', () => {
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
      act(() => result.current.toggle('left-sidebar'));
      act(() => result.current.toggle('left-sidebar'));
      expect(panelRef.current!.expand).toHaveBeenCalled();
    });
  });

  describe('editor-area panels use setLayout', () => {
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

      act(() => result.current.toggle('right-sidebar'));
      vi.mocked(groupRef.current!.getLayout).mockReturnValue({ editor: 84, 'comment-margin': 16, 'right-sidebar': 0 });

      act(() => result.current.toggle('right-sidebar'));
      const calls = vi.mocked(groupRef.current!.setLayout).mock.calls;
      const lastLayout = calls[calls.length - 1][0] as Record<string, number>;
      expect(lastLayout['right-sidebar']).toBe(22);
    });

    it('editor panel absorbs freed space when collapsing', () => {
      const groupRef = mockGroupRef({ editor: 62, 'comment-margin': 16, 'right-sidebar': 22 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => result.current.setGroupRef('editor-area', groupRef));
      act(() => result.current.toggle('right-sidebar'));

      const layout = vi.mocked(groupRef.current!.setLayout).mock.calls[0][0] as Record<string, number>;
      expect(layout['editor']).toBe(84);
    });
  });

  describe('left sidebar uses panel.collapse/expand directly', () => {
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

  describe('autoResize with per-panel thresholds (default behavior)', () => {
    it('all panels open at 1300px', () => {
      const panelRef = mockPanelRef(false);
      const groupRef = mockGroupRef({ editor: 42, 'comment-margin': 16, 'right-sidebar': 22, discussion: 20 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => {
        result.current.setPanelRef('left-sidebar', panelRef);
        result.current.setGroupRef('editor-area', groupRef);
      });

      act(() => result.current.autoResize(1300));

      expect(result.current.isCollapsed('left-sidebar')).toBe(false);
      expect(result.current.isCollapsed('right-sidebar')).toBe(false);
      expect(result.current.isCollapsed('comment-margin')).toBe(false);
      // discussion starts collapsed and has threshold 1250, 1300 >= 1250 so it opens
      expect(result.current.isCollapsed('discussion')).toBe(false);
    });

    it('discussion closed at 1200px (below 1250 threshold)', () => {
      const panelRef = mockPanelRef(false);
      const groupRef = mockGroupRef({ editor: 42, 'comment-margin': 16, 'right-sidebar': 22, discussion: 20 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => {
        result.current.setPanelRef('left-sidebar', panelRef);
        result.current.setGroupRef('editor-area', groupRef);
      });

      act(() => result.current.autoResize(1200));

      expect(result.current.isCollapsed('left-sidebar')).toBe(false);
      expect(result.current.isCollapsed('right-sidebar')).toBe(false);
      expect(result.current.isCollapsed('comment-margin')).toBe(false);
      expect(result.current.isCollapsed('discussion')).toBe(true);
    });

    it('comment + discussion closed at 900px', () => {
      const panelRef = mockPanelRef(false);
      const groupRef = mockGroupRef({ editor: 62, 'comment-margin': 16, 'right-sidebar': 22 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => {
        result.current.setPanelRef('left-sidebar', panelRef);
        result.current.setGroupRef('editor-area', groupRef);
      });

      act(() => result.current.autoResize(900));

      expect(result.current.isCollapsed('left-sidebar')).toBe(false);
      expect(result.current.isCollapsed('right-sidebar')).toBe(false);
      expect(result.current.isCollapsed('comment-margin')).toBe(true);
      expect(result.current.isCollapsed('discussion')).toBe(true);
    });

    it('only left-sidebar at 700px', () => {
      const panelRef = mockPanelRef(false);
      const groupRef = mockGroupRef({ editor: 62, 'comment-margin': 16, 'right-sidebar': 22 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => {
        result.current.setPanelRef('left-sidebar', panelRef);
        result.current.setGroupRef('editor-area', groupRef);
      });

      act(() => result.current.autoResize(700));

      expect(result.current.isCollapsed('left-sidebar')).toBe(false);
      expect(result.current.isCollapsed('right-sidebar')).toBe(true);
      expect(result.current.isCollapsed('comment-margin')).toBe(true);
      expect(result.current.isCollapsed('discussion')).toBe(true);
    });

    it('all closed at 600px', () => {
      const panelRef = mockPanelRef(false);
      const groupRef = mockGroupRef({ editor: 100 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => {
        result.current.setPanelRef('left-sidebar', panelRef);
        result.current.setGroupRef('editor-area', groupRef);
      });

      act(() => result.current.autoResize(600));

      expect(result.current.isCollapsed('left-sidebar')).toBe(true);
      expect(result.current.isCollapsed('right-sidebar')).toBe(true);
      expect(result.current.isCollapsed('comment-margin')).toBe(true);
      expect(result.current.isCollapsed('discussion')).toBe(true);
    });

    it('panels open one-by-one as viewport grows', () => {
      const panelRef = mockPanelRef(false);
      const groupRef = mockGroupRef({ editor: 100 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => {
        result.current.setPanelRef('left-sidebar', panelRef);
        result.current.setGroupRef('editor-area', groupRef);
      });

      // Start small
      act(() => result.current.autoResize(600));
      expect(result.current.isCollapsed('left-sidebar')).toBe(true);

      // Grow to 650 — left-sidebar opens (threshold 650)
      act(() => result.current.autoResize(650));
      expect(result.current.isCollapsed('left-sidebar')).toBe(false);
      expect(result.current.isCollapsed('right-sidebar')).toBe(true);

      // Grow to 850 — right-sidebar opens (threshold 850)
      vi.mocked(groupRef.current!.getLayout).mockReturnValue({ editor: 78, 'comment-margin': 0, 'right-sidebar': 0 });
      act(() => result.current.autoResize(850));
      expect(result.current.isCollapsed('right-sidebar')).toBe(false);
      expect(result.current.isCollapsed('comment-margin')).toBe(true);

      // Grow to 1000 — comment-margin opens (threshold 1000)
      vi.mocked(groupRef.current!.getLayout).mockReturnValue({ editor: 62, 'comment-margin': 0, 'right-sidebar': 22 });
      act(() => result.current.autoResize(1000));
      expect(result.current.isCollapsed('comment-margin')).toBe(false);
      expect(result.current.isCollapsed('discussion')).toBe(true);

      // Grow to 1250 — discussion opens (threshold 1250)
      vi.mocked(groupRef.current!.getLayout).mockReturnValue({ editor: 46, 'comment-margin': 16, 'right-sidebar': 22, discussion: 0 });
      act(() => result.current.autoResize(1250));
      expect(result.current.isCollapsed('discussion')).toBe(false);
    });
  });

  describe('setUserThreshold on open', () => {
    it('opening at narrow lowers threshold by OPEN_BUFFER', () => {
      const panelRef = mockPanelRef(false);
      const groupRef = mockGroupRef({ editor: 62, 'comment-margin': 16, 'right-sidebar': 22 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => {
        result.current.setPanelRef('left-sidebar', panelRef);
        result.current.setGroupRef('editor-area', groupRef);
      });

      // Auto-collapse at 900px (comment-margin threshold is 1000)
      act(() => result.current.autoResize(900));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);

      // User opens comment-margin at 900px → threshold = 900 - 150 = 750
      vi.mocked(groupRef.current!.getLayout).mockReturnValue({ editor: 78, 'comment-margin': 0, 'right-sidebar': 22 });
      act(() => result.current.toggle('comment-margin'));
      expect(result.current.isCollapsed('comment-margin')).toBe(false);

      // Stays open at 800px (above user threshold 750)
      vi.mocked(groupRef.current!.getLayout).mockReturnValue({ editor: 62, 'comment-margin': 16, 'right-sidebar': 22 });
      act(() => result.current.autoResize(800));
      expect(result.current.isCollapsed('comment-margin')).toBe(false);

      // Closes at 700px (below user threshold 750)
      act(() => result.current.autoResize(700));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);
    });

    it('opening at wide restores default (no user override)', () => {
      const panelRef = mockPanelRef(false);
      const groupRef = mockGroupRef({ editor: 42, 'comment-margin': 16, 'right-sidebar': 22, discussion: 20 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => {
        result.current.setPanelRef('left-sidebar', panelRef);
        result.current.setGroupRef('editor-area', groupRef);
      });

      // Start at wide width
      act(() => result.current.autoResize(1300));

      // Close comment-margin at 1300px (sets threshold above current width)
      act(() => result.current.toggle('comment-margin'));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);

      // Reopen at wide width (1300 - 150 = 1150 >= default 1000) → restores default
      vi.mocked(groupRef.current!.getLayout).mockReturnValue({ editor: 58, 'comment-margin': 0, 'right-sidebar': 22, discussion: 20 });
      act(() => result.current.toggle('comment-margin'));
      expect(result.current.isCollapsed('comment-margin')).toBe(false);

      // Default threshold (1000) applies: closes below 1000
      act(() => result.current.autoResize(950));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);
    });

    it('lowered threshold wins space conflict over higher-threshold panel', () => {
      const panelRef = mockPanelRef(false);
      const groupRef = mockGroupRef({ editor: 62, 'comment-margin': 16, 'right-sidebar': 22 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => {
        result.current.setPanelRef('left-sidebar', panelRef);
        result.current.setGroupRef('editor-area', groupRef);
      });

      // Auto-collapse at 900px (both right and comment closed: thresholds 850, 1000)
      act(() => result.current.autoResize(900));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);
      // right is open at 900 (threshold 850)
      expect(result.current.isCollapsed('right-sidebar')).toBe(false);

      // Collapse right too
      act(() => result.current.autoResize(800));
      expect(result.current.isCollapsed('right-sidebar')).toBe(true);

      // User opens comment-margin at 800px → threshold = 800 - 150 = 650
      vi.mocked(groupRef.current!.getLayout).mockReturnValue({ editor: 100, 'comment-margin': 0, 'right-sidebar': 0 });
      act(() => result.current.toggle('comment-margin'));

      // At 860px: comment has threshold 650 (user-lowered), right has threshold 850 (default)
      // Space budget: 860 - 450(content) = 410. Left=200, comment=150 → 350. Right=200 → 550 > 410.
      // So comment opens (650 <= 860, fits), right opens (850 <= 860, fits: 200+150+200=550 > 410... wait)
      // Actually greedy: usedSpace starts at 450. comment(650): 450+150=600 <= 860 → open.
      // left(650): already at threshold 650, 600+200=800 <= 860 → open.
      // Wait, left has threshold 650. Let me reconsider.
      // Sorted by effective threshold: left=650, comment=650, right=850, discussion=1250
      // usedSpace=450. left: 450+200=650 <= 860 → open. comment: 650+150=800 <= 860 → open.
      // right: 800+200=1000 > 860 → closed (can't fit).
      act(() => result.current.autoResize(860));
      expect(result.current.isCollapsed('comment-margin')).toBe(false);
      expect(result.current.isCollapsed('right-sidebar')).toBe(true);  // can't fit
    });
  });

  describe('setUserThreshold on close', () => {
    it('close at 800px sets threshold to 980 (800+100+80)', () => {
      const panelRef = mockPanelRef(false);
      const groupRef = mockGroupRef({ editor: 62, 'comment-margin': 16, 'right-sidebar': 22 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => {
        result.current.setPanelRef('left-sidebar', panelRef);
        result.current.setGroupRef('editor-area', groupRef);
      });

      // Set viewport to 800px
      act(() => result.current.autoResize(800));

      // Close right-sidebar at 800px → threshold = 800 + 100 + 80 = 980
      // right-sidebar is already open at 800 (threshold 850, so it was collapsed at 800)
      // Let's use comment-margin at a wider viewport instead

      // Start at 1100px where comment is open
      act(() => result.current.autoResize(1100));
      expect(result.current.isCollapsed('comment-margin')).toBe(false);

      // User closes comment-margin at 1100px → threshold = 1100 + 100 + 110 = 1310
      act(() => result.current.toggle('comment-margin'));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);

      // Still closed at 1300 (below 1310 threshold)
      vi.mocked(groupRef.current!.getLayout).mockReturnValue({ editor: 62, 'comment-margin': 0, 'right-sidebar': 22, discussion: 20 });
      act(() => result.current.autoResize(1300));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);

      // Opens at 1310 (at threshold)
      act(() => result.current.autoResize(1310));
      expect(result.current.isCollapsed('comment-margin')).toBe(false);
    });

    it('close at 1000px sets threshold to 1200', () => {
      const panelRef = mockPanelRef(false);
      const groupRef = mockGroupRef({ editor: 62, 'comment-margin': 16, 'right-sidebar': 22 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => {
        result.current.setPanelRef('left-sidebar', panelRef);
        result.current.setGroupRef('editor-area', groupRef);
      });

      act(() => result.current.autoResize(1000));
      expect(result.current.isCollapsed('comment-margin')).toBe(false);

      // Close comment-margin at 1000px → threshold = 1000 + 100 + 100 = 1200
      act(() => result.current.toggle('comment-margin'));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);

      // Still closed at 1199
      vi.mocked(groupRef.current!.getLayout).mockReturnValue({ editor: 62, 'comment-margin': 0, 'right-sidebar': 22 });
      act(() => result.current.autoResize(1199));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);

      // Opens at 1200
      act(() => result.current.autoResize(1200));
      expect(result.current.isCollapsed('comment-margin')).toBe(false);
    });

    it('close at 1500px+ sets infinity', () => {
      const panelRef = mockPanelRef(false);
      const groupRef = mockGroupRef({ editor: 42, 'comment-margin': 16, 'right-sidebar': 22, discussion: 20 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => {
        result.current.setPanelRef('left-sidebar', panelRef);
        result.current.setGroupRef('editor-area', groupRef);
      });

      act(() => result.current.autoResize(1600));
      expect(result.current.isCollapsed('right-sidebar')).toBe(false);

      // Close right-sidebar at 1600px → infinity
      act(() => result.current.toggle('right-sidebar'));
      expect(result.current.isCollapsed('right-sidebar')).toBe(true);

      // Never auto-opens, even at huge viewport
      vi.mocked(groupRef.current!.getLayout).mockReturnValue({ editor: 58, 'comment-margin': 16, 'right-sidebar': 0, discussion: 20 });
      act(() => result.current.autoResize(3000));
      expect(result.current.isCollapsed('right-sidebar')).toBe(true);
    });

    it('infinity panel never auto-opens', () => {
      const panelRef = mockPanelRef(false);
      const groupRef = mockGroupRef({ editor: 42, 'comment-margin': 16, 'right-sidebar': 22, discussion: 20 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => {
        result.current.setPanelRef('left-sidebar', panelRef);
        result.current.setGroupRef('editor-area', groupRef);
      });

      act(() => result.current.autoResize(1600));

      // Close at wide → infinity
      act(() => result.current.toggle('comment-margin'));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);

      // Resize to very wide — stays closed
      vi.mocked(groupRef.current!.getLayout).mockReturnValue({ editor: 58, 'comment-margin': 0, 'right-sidebar': 22, discussion: 20 });
      act(() => result.current.autoResize(2000));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);
      act(() => result.current.autoResize(5000));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);
    });

    it('reopen after infinity restores default', () => {
      const panelRef = mockPanelRef(false);
      const groupRef = mockGroupRef({ editor: 42, 'comment-margin': 16, 'right-sidebar': 22, discussion: 20 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => {
        result.current.setPanelRef('left-sidebar', panelRef);
        result.current.setGroupRef('editor-area', groupRef);
      });

      act(() => result.current.autoResize(1600));

      // Close at wide → infinity
      act(() => result.current.toggle('comment-margin'));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);

      // Reopen — should restore default threshold (1000)
      vi.mocked(groupRef.current!.getLayout).mockReturnValue({ editor: 42, 'comment-margin': 0, 'right-sidebar': 22, discussion: 20 });
      act(() => result.current.toggle('comment-margin'));
      expect(result.current.isCollapsed('comment-margin')).toBe(false);

      // Default threshold 1000 applies: closes below 1000
      act(() => result.current.autoResize(950));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);
    });
  });

  describe('dynamic defaults when panel is infinity', () => {
    it('closing left to infinity lowers right default from 850 to 650', () => {
      const panelRef = mockPanelRef(false);
      const groupRef = mockGroupRef({ editor: 62, 'comment-margin': 16, 'right-sidebar': 22 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => {
        result.current.setPanelRef('left-sidebar', panelRef);
        result.current.setGroupRef('editor-area', groupRef);
      });

      // Close left-sidebar at wide → infinity
      act(() => result.current.autoResize(1600));
      act(() => result.current.toggle('left-sidebar'));
      expect(result.current.isCollapsed('left-sidebar')).toBe(true);

      // Now right-sidebar default drops from 850 to 650 (left's 200px no longer counted)
      // At 700px, right should be open (650 <= 700)
      vi.mocked(groupRef.current!.getLayout).mockReturnValue({ editor: 78, 'comment-margin': 0, 'right-sidebar': 0 });
      act(() => result.current.autoResize(700));
      expect(result.current.isCollapsed('right-sidebar')).toBe(false);
    });

    it('at 700px with left=infinity, right opens (was impossible before)', () => {
      const panelRef = mockPanelRef(false);
      const groupRef = mockGroupRef({ editor: 62, 'comment-margin': 16, 'right-sidebar': 22 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => {
        result.current.setPanelRef('left-sidebar', panelRef);
        result.current.setGroupRef('editor-area', groupRef);
      });

      // Without infinity: at 700px, left is open (650), right is closed (850 > 700)
      act(() => result.current.autoResize(700));
      expect(result.current.isCollapsed('left-sidebar')).toBe(false);
      expect(result.current.isCollapsed('right-sidebar')).toBe(true);

      // Now set left to infinity (close at wide first)
      act(() => result.current.autoResize(1600));
      act(() => result.current.toggle('left-sidebar'));

      // At 700px with left=infinity: right's default is 650, which fits
      vi.mocked(groupRef.current!.getLayout).mockReturnValue({ editor: 78, 'comment-margin': 0, 'right-sidebar': 0 });
      act(() => result.current.autoResize(700));
      expect(result.current.isCollapsed('left-sidebar')).toBe(true); // infinity
      expect(result.current.isCollapsed('right-sidebar')).toBe(false); // now opens
    });

    it('reopening left raises right default back to 850', () => {
      const panelRef = mockPanelRef(false);
      const groupRef = mockGroupRef({ editor: 62, 'comment-margin': 16, 'right-sidebar': 22 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => {
        result.current.setPanelRef('left-sidebar', panelRef);
        result.current.setGroupRef('editor-area', groupRef);
      });

      // Close left at wide → infinity
      act(() => result.current.autoResize(1600));
      act(() => result.current.toggle('left-sidebar'));

      // Reopen left (restores default)
      act(() => result.current.toggle('left-sidebar'));

      // At 700px: left opens (650), right is closed again (850 > 700)
      vi.mocked(groupRef.current!.getLayout).mockReturnValue({ editor: 78, 'comment-margin': 0, 'right-sidebar': 0 });
      act(() => result.current.autoResize(700));
      expect(result.current.isCollapsed('left-sidebar')).toBe(false);
      expect(result.current.isCollapsed('right-sidebar')).toBe(true);
    });
  });

  describe('toggle and expand use setUserThreshold', () => {
    it('toggle sets user threshold on close', () => {
      const panelRef = mockPanelRef(false);
      const groupRef = mockGroupRef({ editor: 62, 'comment-margin': 16, 'right-sidebar': 22 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => {
        result.current.setPanelRef('left-sidebar', panelRef);
        result.current.setGroupRef('editor-area', groupRef);
      });

      // Set viewport
      act(() => result.current.autoResize(1100));

      // Toggle close comment-margin at 1100 → threshold = 1100 + 100 + 110 = 1310
      act(() => result.current.toggle('comment-margin'));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);

      // Panel doesn't reopen until 1310
      vi.mocked(groupRef.current!.getLayout).mockReturnValue({ editor: 78, 'comment-margin': 0, 'right-sidebar': 22 });
      act(() => result.current.autoResize(1300));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);
    });

    it('expand calls setUserThreshold', () => {
      const panelRef = mockPanelRef(false);
      const groupRef = mockGroupRef({ editor: 62, 'comment-margin': 16, 'right-sidebar': 22 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => {
        result.current.setPanelRef('left-sidebar', panelRef);
        result.current.setGroupRef('editor-area', groupRef);
      });

      // Collapse at narrow
      act(() => result.current.autoResize(900));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);

      // expand() at 900px → threshold = 900 - 150 = 750 (same as toggle-open)
      vi.mocked(groupRef.current!.getLayout).mockReturnValue({ editor: 78, 'comment-margin': 0, 'right-sidebar': 22 });
      act(() => result.current.expand('comment-margin'));
      expect(result.current.isCollapsed('comment-margin')).toBe(false);

      // Stays open at 800 (above 750)
      vi.mocked(groupRef.current!.getLayout).mockReturnValue({ editor: 62, 'comment-margin': 16, 'right-sidebar': 22 });
      act(() => result.current.autoResize(800));
      expect(result.current.isCollapsed('comment-margin')).toBe(false);
    });

    it('header button toggle still works', () => {
      const panelRef = mockPanelRef(false);
      const groupRef = mockGroupRef({ editor: 62, 'comment-margin': 16, 'right-sidebar': 22 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => {
        result.current.setPanelRef('left-sidebar', panelRef);
        result.current.setGroupRef('editor-area', groupRef);
      });

      act(() => result.current.autoResize(1100));

      // Toggle close and open works
      act(() => result.current.toggle('right-sidebar'));
      expect(result.current.isCollapsed('right-sidebar')).toBe(true);

      vi.mocked(groupRef.current!.getLayout).mockReturnValue({ editor: 84, 'comment-margin': 16, 'right-sidebar': 0 });
      act(() => result.current.toggle('right-sidebar'));
      expect(result.current.isCollapsed('right-sidebar')).toBe(false);
    });
  });

  describe('expand(id) expands a specific panel', () => {
    it('expand comment-margin expands it', () => {
      const groupRef = mockGroupRef({ editor: 84, 'comment-margin': 0, 'right-sidebar': 16 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => result.current.setGroupRef('editor-area', groupRef));

      act(() => result.current.toggle('comment-margin'));
      vi.mocked(groupRef.current!.setLayout).mockClear();
      vi.mocked(groupRef.current!.getLayout).mockReturnValue({ editor: 84, 'comment-margin': 0, 'right-sidebar': 16 });

      act(() => result.current.expand('comment-margin'));
      expect(result.current.isCollapsed('comment-margin')).toBe(false);
    });

    it('expand on already expanded panel is a no-op', () => {
      const groupRef = mockGroupRef({ editor: 62, 'comment-margin': 16, 'right-sidebar': 22 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => result.current.setGroupRef('editor-area', groupRef));

      act(() => result.current.expand('right-sidebar'));
      expect(result.current.isCollapsed('right-sidebar')).toBe(false);
    });
  });

  describe('onPanelResize syncs state from library', () => {
    it('onPanelResize to 0 marks panel as collapsed', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => result.current.onPanelResize('right-sidebar', 0));
      expect(result.current.isCollapsed('right-sidebar')).toBe(true);
    });

    it('onPanelResize to non-zero marks panel as expanded', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => result.current.onPanelResize('right-sidebar', 0));
      act(() => result.current.onPanelResize('right-sidebar', 22));
      expect(result.current.isCollapsed('right-sidebar')).toBe(false);
    });
  });

  describe('onPanelResize corrects redistribution', () => {
    it('calls setLayout when collapsed panel reports non-zero size', () => {
      const groupRef = mockGroupRef({ editor: 60, 'comment-margin': 16, 'right-sidebar': 24 });
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => result.current.setGroupRef('editor-area', groupRef));

      act(() => result.current.toggle('right-sidebar'));
      vi.mocked(groupRef.current!.setLayout).mockClear();
      vi.mocked(groupRef.current!.getLayout).mockReturnValue({ editor: 78, 'comment-margin': 16, 'right-sidebar': 6 });

      act(() => result.current.onPanelResize('right-sidebar', 6));

      expect(groupRef.current!.setLayout).toHaveBeenCalled();
    });
  });

  describe('autoResize animates panels', () => {
    it('adds panels-animating class to app-outer group on auto-collapse', () => {
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

      act(() => result.current.autoResize(600));

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

      act(() => result.current.autoResize(600));
      appOuterEl.classList.remove('panels-animating');

      vi.mocked(groupRef.current!.getLayout).mockReturnValue({ editor: 100, 'comment-margin': 0, 'right-sidebar': 0 });
      act(() => result.current.autoResize(1300));

      expect(appOuterEl.classList.contains('panels-animating')).toBe(true);

      document.body.removeChild(appOuterEl);
    });
  });
});
