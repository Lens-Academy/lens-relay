import { renderHook, act } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { usePanelManager, computeDefaultThresholds, EDITOR_MIN_PX, HANDLE_WIDTH, type PanelConfig } from './usePanelManager';

// --- Test helpers ---

const DEFAULT_CONFIG: PanelConfig = {
  'left-sidebar':   { group: 'app-outer',   minPx: 200, maxPx: 250, priority: 1 },
  'comment-margin': { group: 'editor-area', minPx: 150, maxPx: 250, priority: 3 },
  'right-sidebar':  { group: 'editor-area', minPx: 200, maxPx: 250, priority: 2 },
  'discussion':     { group: 'editor-area', minPx: 250, maxPx: 270, priority: 4 },
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

  describe('initial pixel widths', () => {
    it('all panels initialize to maxPx', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      expect(result.current.getWidth('left-sidebar')).toBe(250);
      expect(result.current.getWidth('comment-margin')).toBe(250);
      expect(result.current.getWidth('right-sidebar')).toBe(250);
      expect(result.current.getWidth('discussion')).toBe(270);
    });
  });

  describe('getWidth/setWidth pixel management', () => {
    it('setWidth updates the width', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => result.current.setWidth('right-sidebar', 300));
      expect(result.current.getWidth('right-sidebar')).toBe(300);
    });

    it('setWidth clamps to minPx', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => result.current.setWidth('right-sidebar', 50));
      expect(result.current.getWidth('right-sidebar')).toBe(200); // minPx
    });

    it('setWidth allows exceeding maxPx (soft limit)', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => result.current.setWidth('right-sidebar', 400));
      expect(result.current.getWidth('right-sidebar')).toBe(400);
    });

    it('setWidth is no-op for unknown panels', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => result.current.setWidth('nonexistent', 300));
      expect(result.current.getWidth('nonexistent')).toBe(0);
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

  describe('all panels use pixel widths on toggle', () => {
    it('toggle right-sidebar expand sets width to maxPx', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      // Collapse first
      act(() => result.current.toggle('right-sidebar'));
      expect(result.current.isCollapsed('right-sidebar')).toBe(true);

      // Expand — should set width to maxPx (250)
      act(() => result.current.toggle('right-sidebar'));
      expect(result.current.isCollapsed('right-sidebar')).toBe(false);
      expect(result.current.getWidth('right-sidebar')).toBe(250);
    });

    it('toggle discussion expand sets width to maxPx', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      // Discussion starts collapsed
      act(() => result.current.toggle('discussion'));
      expect(result.current.isCollapsed('discussion')).toBe(false);
      expect(result.current.getWidth('discussion')).toBe(270);
    });

    it('toggle left-sidebar expand sets width to maxPx', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      act(() => result.current.toggle('left-sidebar'));
      expect(result.current.isCollapsed('left-sidebar')).toBe(true);

      act(() => result.current.toggle('left-sidebar'));
      expect(result.current.isCollapsed('left-sidebar')).toBe(false);
      expect(result.current.getWidth('left-sidebar')).toBe(250);
    });
  });

  describe('autoResize with per-panel thresholds (default behavior)', () => {
    it('all panels open at 1300px', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));

      act(() => result.current.autoResize(1300));

      expect(result.current.isCollapsed('left-sidebar')).toBe(false);
      expect(result.current.isCollapsed('right-sidebar')).toBe(false);
      expect(result.current.isCollapsed('comment-margin')).toBe(false);
      // discussion starts collapsed and has threshold 1250, 1300 >= 1250 so it opens
      expect(result.current.isCollapsed('discussion')).toBe(false);
    });

    it('discussion closed at 1200px (below 1250 threshold)', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));

      act(() => result.current.autoResize(1200));

      expect(result.current.isCollapsed('left-sidebar')).toBe(false);
      expect(result.current.isCollapsed('right-sidebar')).toBe(false);
      expect(result.current.isCollapsed('comment-margin')).toBe(false);
      expect(result.current.isCollapsed('discussion')).toBe(true);
    });

    it('comment + discussion closed at 900px', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));

      act(() => result.current.autoResize(900));

      expect(result.current.isCollapsed('left-sidebar')).toBe(false);
      expect(result.current.isCollapsed('right-sidebar')).toBe(false);
      expect(result.current.isCollapsed('comment-margin')).toBe(true);
      expect(result.current.isCollapsed('discussion')).toBe(true);
    });

    it('only left-sidebar at 700px', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));

      act(() => result.current.autoResize(700));

      expect(result.current.isCollapsed('left-sidebar')).toBe(false);
      expect(result.current.isCollapsed('right-sidebar')).toBe(true);
      expect(result.current.isCollapsed('comment-margin')).toBe(true);
      expect(result.current.isCollapsed('discussion')).toBe(true);
    });

    it('all closed at 600px', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));

      act(() => result.current.autoResize(600));

      expect(result.current.isCollapsed('left-sidebar')).toBe(true);
      expect(result.current.isCollapsed('right-sidebar')).toBe(true);
      expect(result.current.isCollapsed('comment-margin')).toBe(true);
      expect(result.current.isCollapsed('discussion')).toBe(true);
    });

    it('panels open one-by-one as viewport grows', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));

      // Start small
      act(() => result.current.autoResize(600));
      expect(result.current.isCollapsed('left-sidebar')).toBe(true);

      // Grow to 650 — left-sidebar opens (threshold 650)
      act(() => result.current.autoResize(650));
      expect(result.current.isCollapsed('left-sidebar')).toBe(false);
      expect(result.current.isCollapsed('right-sidebar')).toBe(true);

      // Grow to 850 — right-sidebar opens (threshold 850)
      act(() => result.current.autoResize(850));
      expect(result.current.isCollapsed('right-sidebar')).toBe(false);
      expect(result.current.isCollapsed('comment-margin')).toBe(true);

      // Grow to 1000 — comment-margin opens (threshold 1000)
      act(() => result.current.autoResize(1000));
      expect(result.current.isCollapsed('comment-margin')).toBe(false);
      expect(result.current.isCollapsed('discussion')).toBe(true);

      // Grow to 1250 — discussion opens (threshold 1250)
      act(() => result.current.autoResize(1250));
      expect(result.current.isCollapsed('discussion')).toBe(false);
    });
  });

  describe('setUserThreshold on open', () => {
    it('opening at narrow lowers threshold by OPEN_BUFFER', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));

      // Auto-collapse at 900px (comment-margin threshold is 1000)
      act(() => result.current.autoResize(900));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);

      // User opens comment-margin at 900px -> threshold = 900 - 150 = 750
      act(() => result.current.toggle('comment-margin'));
      expect(result.current.isCollapsed('comment-margin')).toBe(false);

      // Stays open at 800px (above user threshold 750)
      act(() => result.current.autoResize(800));
      expect(result.current.isCollapsed('comment-margin')).toBe(false);

      // Closes at 700px (below user threshold 750)
      act(() => result.current.autoResize(700));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);
    });

    it('opening at wide restores default (no user override)', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));

      // Start at wide width
      act(() => result.current.autoResize(1300));

      // Close comment-margin at 1300px (sets threshold above current width)
      act(() => result.current.toggle('comment-margin'));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);

      // Reopen at wide width (1300 - 150 = 1150 >= default 1000) -> restores default
      act(() => result.current.toggle('comment-margin'));
      expect(result.current.isCollapsed('comment-margin')).toBe(false);

      // Default threshold (1000) applies: closes below 1000
      act(() => result.current.autoResize(950));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);
    });

    it('lowered threshold wins space conflict over higher-threshold panel', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));

      // Auto-collapse at 900px (both right and comment closed: thresholds 850, 1000)
      act(() => result.current.autoResize(900));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);
      // right is open at 900 (threshold 850)
      expect(result.current.isCollapsed('right-sidebar')).toBe(false);

      // Collapse right too
      act(() => result.current.autoResize(800));
      expect(result.current.isCollapsed('right-sidebar')).toBe(true);

      // User opens comment-margin at 800px -> threshold = 800 - 150 = 650
      act(() => result.current.toggle('comment-margin'));

      // At 860px: comment has threshold 650 (user-lowered), right has threshold 850 (default)
      // Greedy: usedSpace=450. left(650): 450+200=650 <= 860 -> open. comment(650): 650+150=800 <= 860 -> open.
      // right(850): 800+200=1000 > 860 -> closed (can't fit).
      act(() => result.current.autoResize(860));
      expect(result.current.isCollapsed('comment-margin')).toBe(false);
      expect(result.current.isCollapsed('right-sidebar')).toBe(true);  // can't fit
    });
  });

  describe('setUserThreshold on close', () => {
    it('close at 1100px sets threshold to 1310', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));

      // Start at 1100px where comment is open
      act(() => result.current.autoResize(1100));
      expect(result.current.isCollapsed('comment-margin')).toBe(false);

      // User closes comment-margin at 1100px -> threshold = 1100 + 100 + 110 = 1310
      act(() => result.current.toggle('comment-margin'));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);

      // Still closed at 1300 (below 1310 threshold)
      act(() => result.current.autoResize(1300));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);

      // Opens at 1310 (at threshold)
      act(() => result.current.autoResize(1310));
      expect(result.current.isCollapsed('comment-margin')).toBe(false);
    });

    it('close at 1000px sets threshold to 1200', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));

      act(() => result.current.autoResize(1000));
      expect(result.current.isCollapsed('comment-margin')).toBe(false);

      // Close comment-margin at 1000px -> threshold = 1000 + 100 + 100 = 1200
      act(() => result.current.toggle('comment-margin'));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);

      // Still closed at 1199
      act(() => result.current.autoResize(1199));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);

      // Opens at 1200
      act(() => result.current.autoResize(1200));
      expect(result.current.isCollapsed('comment-margin')).toBe(false);
    });

    it('close at 1500px+ sets infinity', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));

      act(() => result.current.autoResize(1600));
      expect(result.current.isCollapsed('right-sidebar')).toBe(false);

      // Close right-sidebar at 1600px -> infinity
      act(() => result.current.toggle('right-sidebar'));
      expect(result.current.isCollapsed('right-sidebar')).toBe(true);

      // Never auto-opens, even at huge viewport
      act(() => result.current.autoResize(3000));
      expect(result.current.isCollapsed('right-sidebar')).toBe(true);
    });

    it('infinity panel never auto-opens', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));

      act(() => result.current.autoResize(1600));

      // Close at wide -> infinity
      act(() => result.current.toggle('comment-margin'));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);

      // Resize to very wide — stays closed
      act(() => result.current.autoResize(2000));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);
      act(() => result.current.autoResize(5000));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);
    });

    it('reopen after infinity restores default', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));

      act(() => result.current.autoResize(1600));

      // Close at wide -> infinity
      act(() => result.current.toggle('comment-margin'));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);

      // Reopen — should restore default threshold (1000)
      act(() => result.current.toggle('comment-margin'));
      expect(result.current.isCollapsed('comment-margin')).toBe(false);

      // Default threshold 1000 applies: closes below 1000
      act(() => result.current.autoResize(950));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);
    });
  });

  describe('dynamic defaults when panel is infinity', () => {
    it('closing left to infinity lowers right default from 850 to 650', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));

      // Close left-sidebar at wide -> infinity
      act(() => result.current.autoResize(1600));
      act(() => result.current.toggle('left-sidebar'));
      expect(result.current.isCollapsed('left-sidebar')).toBe(true);

      // Now right-sidebar default drops from 850 to 650 (left's 200px no longer counted)
      // At 700px, right should be open (650 <= 700)
      act(() => result.current.autoResize(700));
      expect(result.current.isCollapsed('right-sidebar')).toBe(false);
    });

    it('at 700px with left=infinity, right opens (was impossible before)', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));

      // Without infinity: at 700px, left is open (650), right is closed (850 > 700)
      act(() => result.current.autoResize(700));
      expect(result.current.isCollapsed('left-sidebar')).toBe(false);
      expect(result.current.isCollapsed('right-sidebar')).toBe(true);

      // Now set left to infinity (close at wide first)
      act(() => result.current.autoResize(1600));
      act(() => result.current.toggle('left-sidebar'));

      // At 700px with left=infinity: right's default is 650, which fits
      act(() => result.current.autoResize(700));
      expect(result.current.isCollapsed('left-sidebar')).toBe(true); // infinity
      expect(result.current.isCollapsed('right-sidebar')).toBe(false); // now opens
    });

    it('reopening left raises right default back to 850', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));

      // Close left at wide -> infinity
      act(() => result.current.autoResize(1600));
      act(() => result.current.toggle('left-sidebar'));

      // Reopen left (restores default)
      act(() => result.current.toggle('left-sidebar'));

      // At 700px: left opens (650), right is closed again (850 > 700)
      act(() => result.current.autoResize(700));
      expect(result.current.isCollapsed('left-sidebar')).toBe(false);
      expect(result.current.isCollapsed('right-sidebar')).toBe(true);
    });
  });

  describe('toggle and expand use setUserThreshold', () => {
    it('toggle sets user threshold on close', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));

      // Set viewport
      act(() => result.current.autoResize(1100));

      // Toggle close comment-margin at 1100 -> threshold = 1100 + 100 + 110 = 1310
      act(() => result.current.toggle('comment-margin'));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);

      // Panel doesn't reopen until 1310
      act(() => result.current.autoResize(1300));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);
    });

    it('expand calls setUserThreshold', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));

      // Collapse at narrow
      act(() => result.current.autoResize(900));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);

      // expand() at 900px -> threshold = 900 - 150 = 750 (same as toggle-open)
      act(() => result.current.expand('comment-margin'));
      expect(result.current.isCollapsed('comment-margin')).toBe(false);

      // Stays open at 800 (above 750)
      act(() => result.current.autoResize(800));
      expect(result.current.isCollapsed('comment-margin')).toBe(false);
    });

    it('header button toggle still works', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));

      act(() => result.current.autoResize(1100));

      // Toggle close and open works
      act(() => result.current.toggle('right-sidebar'));
      expect(result.current.isCollapsed('right-sidebar')).toBe(true);

      act(() => result.current.toggle('right-sidebar'));
      expect(result.current.isCollapsed('right-sidebar')).toBe(false);
    });
  });

  describe('expand(id) expands a specific panel', () => {
    it('expand comment-margin expands it', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));

      act(() => result.current.toggle('comment-margin'));
      expect(result.current.isCollapsed('comment-margin')).toBe(true);

      act(() => result.current.expand('comment-margin'));
      expect(result.current.isCollapsed('comment-margin')).toBe(false);
      expect(result.current.getWidth('comment-margin')).toBe(250); // maxPx
    });

    it('expand on already expanded panel is a no-op', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));

      act(() => result.current.expand('right-sidebar'));
      expect(result.current.isCollapsed('right-sidebar')).toBe(false);
    });
  });

  describe('autoResize animates containers', () => {
    it('adds sidebar-animating class to app-outer on auto-collapse', () => {
      const appOuterEl = document.createElement('div');
      appOuterEl.id = 'app-outer';
      document.body.appendChild(appOuterEl);

      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));

      act(() => result.current.autoResize(600));

      expect(appOuterEl.classList.contains('sidebar-animating')).toBe(true);

      document.body.removeChild(appOuterEl);
    });

    it('adds sidebar-animating class to app-outer on auto-expand', () => {
      const appOuterEl = document.createElement('div');
      appOuterEl.id = 'app-outer';
      document.body.appendChild(appOuterEl);

      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));

      act(() => result.current.autoResize(600));
      appOuterEl.classList.remove('sidebar-animating');

      act(() => result.current.autoResize(1300));

      expect(appOuterEl.classList.contains('sidebar-animating')).toBe(true);

      document.body.removeChild(appOuterEl);
    });

    it('adds sidebar-animating class to editor-area on auto-collapse', () => {
      const editorAreaEl = document.createElement('div');
      editorAreaEl.id = 'editor-area';
      document.body.appendChild(editorAreaEl);

      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));

      act(() => result.current.autoResize(600));

      expect(editorAreaEl.classList.contains('sidebar-animating')).toBe(true);

      document.body.removeChild(editorAreaEl);
    });
  });

  describe('autoResize sets pixel widths for newly opened panels', () => {
    it('opening right-sidebar via autoResize sets width up to maxPx', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));

      // Start collapsed
      act(() => result.current.autoResize(600));
      expect(result.current.isCollapsed('right-sidebar')).toBe(true);

      // Grow to open right-sidebar
      act(() => result.current.autoResize(900));
      expect(result.current.isCollapsed('right-sidebar')).toBe(false);
      // Width should be set to maxPx (250) since there's room
      expect(result.current.getWidth('right-sidebar')).toBe(250);
    });
  });

  describe('setWidth clamps at available space', () => {
    it('clamps editor-area panel to prevent overflow', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));

      // autoResize sets container width and opens panels with known widths
      // left-sidebar=250, right-sidebar=250, comment-margin=250, discussion=collapsed
      act(() => result.current.autoResize(1200));

      // Try to set comment-margin to 800 (way more than available)
      // leftSpace = 250 + 9 = 259, editorArea = 1200 - 259 = 941
      // otherEditorArea (right-sidebar) = 250 + 9 = 259
      // max = 941 - 250 - 259 - 9 = 423
      act(() => result.current.setWidth('comment-margin', 800));
      expect(result.current.getWidth('comment-margin')).toBe(423);
    });

    it('clamps left-sidebar to prevent overflow', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));

      act(() => result.current.autoResize(1200));

      // Try to set left-sidebar to 900
      // editorAreaSpace = (250+9) + (250+9) = 518 (comment + right visible)
      // max = 1200 - 250 - 518 - 9 = 423
      act(() => result.current.setWidth('left-sidebar', 900));
      expect(result.current.getWidth('left-sidebar')).toBe(423);
    });

    it('allows growth within available space', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));

      act(() => result.current.autoResize(1200));

      // 300 < max(373) — should be accepted as-is
      act(() => result.current.setWidth('comment-margin', 300));
      expect(result.current.getWidth('comment-margin')).toBe(300);
    });

    it('collapsed neighbors free up space', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));

      act(() => result.current.autoResize(1200));

      // Collapse right-sidebar — frees its 250 + 9 = 259px
      act(() => result.current.toggle('right-sidebar'));

      // Now max for comment-margin = 941 - 250 - 0 - 9 = 682
      // 500 < 682 — accepted
      act(() => result.current.setWidth('comment-margin', 500));
      expect(result.current.getWidth('comment-margin')).toBe(500);
    });
  });

  describe('getDebugInfo', () => {
    it('includes pixel widths for all panels', () => {
      const { result } = renderHook(() => usePanelManager(DEFAULT_CONFIG));
      const info = result.current.getDebugInfo();
      expect(info.widths['left-sidebar']).toBe(250);
      expect(info.widths['right-sidebar']).toBe(250);
      expect(info.widths['comment-margin']).toBe(250);
      expect(info.widths['discussion']).toBe(270);
    });
  });
});
