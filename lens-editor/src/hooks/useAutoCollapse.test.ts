import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useAutoCollapse } from './useAutoCollapse';
import type { PanelImperativeHandle } from 'react-resizable-panels';

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

describe('useAutoCollapse', () => {
  it('collapses all panels when width drops below threshold', () => {
    const leftRef = mockPanelRef();
    const rightRef = mockPanelRef();

    const { rerender } = renderHook(
      ({ width }) => useAutoCollapse({
        containerWidth: width,
        panelRefs: [leftRef, rightRef],
        pixelMinimums: [200, 200],
        contentMinPx: 450,
      }),
      { initialProps: { width: 1200 } },
    );

    // Shrink below threshold (200 + 200 + 450 = 850)
    rerender({ width: 800 });

    expect(leftRef.current!.collapse).toHaveBeenCalled();
    expect(rightRef.current!.collapse).toHaveBeenCalled();
  });

  it('does NOT re-collapse after already collapsed for this crossing', () => {
    const leftRef = mockPanelRef();
    const rightRef = mockPanelRef();

    const { rerender } = renderHook(
      ({ width }) => useAutoCollapse({
        containerWidth: width,
        panelRefs: [leftRef, rightRef],
        pixelMinimums: [200, 200],
        contentMinPx: 450,
      }),
      { initialProps: { width: 1200 } },
    );

    rerender({ width: 800 });
    expect(leftRef.current!.collapse).toHaveBeenCalledTimes(1);

    vi.mocked(leftRef.current!.collapse).mockClear();
    vi.mocked(rightRef.current!.collapse).mockClear();
    rerender({ width: 750 });

    expect(leftRef.current!.collapse).not.toHaveBeenCalled();
  });

  it('resets and re-collapses on next threshold crossing', () => {
    const leftRef = mockPanelRef();
    const rightRef = mockPanelRef();

    const { rerender } = renderHook(
      ({ width }) => useAutoCollapse({
        containerWidth: width,
        panelRefs: [leftRef, rightRef],
        pixelMinimums: [200, 200],
        contentMinPx: 450,
      }),
      { initialProps: { width: 1200 } },
    );

    rerender({ width: 800 });
    expect(leftRef.current!.collapse).toHaveBeenCalledTimes(1);

    // Go back above threshold
    rerender({ width: 1200 });

    vi.mocked(leftRef.current!.collapse).mockClear();
    vi.mocked(rightRef.current!.collapse).mockClear();

    // Cross threshold again
    rerender({ width: 800 });
    expect(leftRef.current!.collapse).toHaveBeenCalledTimes(1);
  });

  it('skips already-collapsed panels', () => {
    const leftRef = mockPanelRef(true);  // already collapsed
    const rightRef = mockPanelRef(false);

    renderHook(() => useAutoCollapse({
      containerWidth: 800,
      panelRefs: [leftRef, rightRef],
      pixelMinimums: [200, 200],
      contentMinPx: 450,
    }));

    expect(leftRef.current!.collapse).not.toHaveBeenCalled();
    expect(rightRef.current!.collapse).toHaveBeenCalled();
  });

  it('does nothing when width is 0 (not yet measured)', () => {
    const leftRef = mockPanelRef();

    renderHook(() => useAutoCollapse({
      containerWidth: 0,
      panelRefs: [leftRef],
      pixelMinimums: [200],
      contentMinPx: 450,
    }));

    expect(leftRef.current!.collapse).not.toHaveBeenCalled();
  });

  it('auto-expands panels when width goes back above threshold + 50px', () => {
    const leftRef = mockPanelRef();
    const rightRef = mockPanelRef();

    const { rerender } = renderHook(
      ({ width }) => useAutoCollapse({
        containerWidth: width,
        panelRefs: [leftRef, rightRef],
        pixelMinimums: [200, 200],
        contentMinPx: 450,
      }),
      { initialProps: { width: 1200 } },
    );

    // Shrink below threshold (850)
    rerender({ width: 800 });
    expect(leftRef.current!.collapse).toHaveBeenCalled();
    expect(rightRef.current!.collapse).toHaveBeenCalled();

    // Go back above threshold + 50px (900)
    rerender({ width: 910 });
    expect(leftRef.current!.expand).toHaveBeenCalled();
    expect(rightRef.current!.expand).toHaveBeenCalled();
  });

  it('does NOT expand in hysteresis zone (between threshold and threshold + 50px)', () => {
    const leftRef = mockPanelRef();
    const rightRef = mockPanelRef();

    const { rerender } = renderHook(
      ({ width }) => useAutoCollapse({
        containerWidth: width,
        panelRefs: [leftRef, rightRef],
        pixelMinimums: [200, 200],
        contentMinPx: 450,
      }),
      { initialProps: { width: 1200 } },
    );

    // Shrink below threshold
    rerender({ width: 800 });
    expect(leftRef.current!.collapse).toHaveBeenCalled();

    // Go to hysteresis zone (850 <= 870 < 900)
    rerender({ width: 870 });
    expect(leftRef.current!.expand).not.toHaveBeenCalled();
    expect(rightRef.current!.expand).not.toHaveBeenCalled();
  });

  it('only expands panels that were auto-collapsed, not already-collapsed ones', () => {
    const leftRef = mockPanelRef(true);  // already collapsed by user
    const rightRef = mockPanelRef(false); // open

    const { rerender } = renderHook(
      ({ width }) => useAutoCollapse({
        containerWidth: width,
        panelRefs: [leftRef, rightRef],
        pixelMinimums: [200, 200],
        contentMinPx: 450,
      }),
      { initialProps: { width: 1200 } },
    );

    // Shrink below threshold - only right gets auto-collapsed
    rerender({ width: 800 });
    expect(leftRef.current!.collapse).not.toHaveBeenCalled();
    expect(rightRef.current!.collapse).toHaveBeenCalled();

    // Go back above expand threshold
    rerender({ width: 910 });
    expect(leftRef.current!.expand).not.toHaveBeenCalled(); // was NOT auto-collapsed
    expect(rightRef.current!.expand).toHaveBeenCalled(); // WAS auto-collapsed
  });

  it('handles null ref gracefully (no discussion panel mounted)', () => {
    const nullRef: React.RefObject<PanelImperativeHandle> = { current: null };

    const { rerender } = renderHook(
      ({ width }) => useAutoCollapse({
        containerWidth: width,
        panelRefs: [nullRef],
        pixelMinimums: [250],
        contentMinPx: 850,
      }),
      { initialProps: { width: 1200 } },
    );

    // Should not throw when crossing below threshold with null ref
    rerender({ width: 1000 });
    // No assertion needed — just verifying no crash
  });

  it('re-collapse + re-expand cycle works correctly', () => {
    const leftRef = mockPanelRef();
    const rightRef = mockPanelRef();

    const { rerender } = renderHook(
      ({ width }) => useAutoCollapse({
        containerWidth: width,
        panelRefs: [leftRef, rightRef],
        pixelMinimums: [200, 200],
        contentMinPx: 450,
      }),
      { initialProps: { width: 1200 } },
    );

    // First collapse
    rerender({ width: 800 });
    expect(leftRef.current!.collapse).toHaveBeenCalledTimes(1);

    // First expand
    rerender({ width: 910 });
    expect(leftRef.current!.expand).toHaveBeenCalledTimes(1);

    vi.mocked(leftRef.current!.collapse).mockClear();
    vi.mocked(leftRef.current!.expand).mockClear();
    vi.mocked(rightRef.current!.collapse).mockClear();
    vi.mocked(rightRef.current!.expand).mockClear();

    // Second collapse
    rerender({ width: 800 });
    expect(leftRef.current!.collapse).toHaveBeenCalledTimes(1);
    expect(rightRef.current!.collapse).toHaveBeenCalledTimes(1);

    // Second expand
    rerender({ width: 910 });
    expect(leftRef.current!.expand).toHaveBeenCalledTimes(1);
    expect(rightRef.current!.expand).toHaveBeenCalledTimes(1);
  });
});

describe('onAutoCollapse / onAutoExpand callbacks', () => {
  it('calls onAutoCollapse before collapse() for each panel', () => {
    const leftRef = mockPanelRef();
    const rightRef = mockPanelRef();
    const onAutoCollapse = vi.fn();
    const callOrder: string[] = [];

    onAutoCollapse.mockImplementation(() => { callOrder.push('callback'); });
    vi.mocked(leftRef.current!.collapse).mockImplementation(() => callOrder.push('collapse'));
    vi.mocked(rightRef.current!.collapse).mockImplementation(() => callOrder.push('collapse'));

    const { rerender } = renderHook(
      ({ width }) => useAutoCollapse({
        containerWidth: width,
        panelRefs: [leftRef, rightRef],
        pixelMinimums: [200, 200],
        contentMinPx: 450,
        onAutoCollapse,
      }),
      { initialProps: { width: 1200 } },
    );

    rerender({ width: 800 });

    expect(onAutoCollapse).toHaveBeenCalledTimes(2);
    expect(onAutoCollapse).toHaveBeenCalledWith(leftRef);
    expect(onAutoCollapse).toHaveBeenCalledWith(rightRef);
    // callback before collapse, for each panel
    expect(callOrder).toEqual(['callback', 'collapse', 'callback', 'collapse']);
  });

  it('calls onAutoExpand before expand() for each auto-collapsed panel', () => {
    const leftRef = mockPanelRef();
    const rightRef = mockPanelRef();
    const onAutoExpand = vi.fn();
    const callOrder: string[] = [];

    onAutoExpand.mockImplementation(() => { callOrder.push('callback'); });
    vi.mocked(leftRef.current!.expand).mockImplementation(() => { callOrder.push('expand'); });
    vi.mocked(rightRef.current!.expand).mockImplementation(() => { callOrder.push('expand'); });

    const { rerender } = renderHook(
      ({ width }) => useAutoCollapse({
        containerWidth: width,
        panelRefs: [leftRef, rightRef],
        pixelMinimums: [200, 200],
        contentMinPx: 450,
        onAutoExpand,
      }),
      { initialProps: { width: 1200 } },
    );

    rerender({ width: 800 });
    rerender({ width: 910 });

    expect(onAutoExpand).toHaveBeenCalledTimes(2);
    expect(onAutoExpand).toHaveBeenCalledWith(leftRef);
    expect(onAutoExpand).toHaveBeenCalledWith(rightRef);
    expect(callOrder).toEqual(['callback', 'expand', 'callback', 'expand']);
  });

  it('works without callbacks (existing tests unaffected)', () => {
    const leftRef = mockPanelRef();

    const { rerender } = renderHook(
      ({ width }) => useAutoCollapse({
        containerWidth: width,
        panelRefs: [leftRef],
        pixelMinimums: [200],
        contentMinPx: 450,
      }),
      { initialProps: { width: 1200 } },
    );

    // Should not throw when no callbacks provided
    rerender({ width: 600 });
    expect(leftRef.current!.collapse).toHaveBeenCalled();

    rerender({ width: 710 });
    expect(leftRef.current!.expand).toHaveBeenCalled();
  });

  it('skips collapse() when onAutoCollapse returns true', () => {
    const leftRef = mockPanelRef();
    const rightRef = mockPanelRef();
    const onAutoCollapse = vi.fn().mockReturnValue(true);

    const { rerender } = renderHook(
      ({ width }) => useAutoCollapse({
        containerWidth: width,
        panelRefs: [leftRef, rightRef],
        pixelMinimums: [200, 200],
        contentMinPx: 450,
        onAutoCollapse,
      }),
      { initialProps: { width: 1200 } },
    );

    rerender({ width: 800 });

    expect(onAutoCollapse).toHaveBeenCalledTimes(2);
    expect(leftRef.current!.collapse).not.toHaveBeenCalled();
    expect(rightRef.current!.collapse).not.toHaveBeenCalled();
  });

  it('does not call onAutoExpand for panels that were manually collapsed', () => {
    const manualRef = mockPanelRef(true);  // already collapsed by user
    const autoRef = mockPanelRef(false);
    const onAutoExpand = vi.fn();

    const { rerender } = renderHook(
      ({ width }) => useAutoCollapse({
        containerWidth: width,
        panelRefs: [manualRef, autoRef],
        pixelMinimums: [200, 200],
        contentMinPx: 450,
        onAutoExpand,
      }),
      { initialProps: { width: 1200 } },
    );

    rerender({ width: 800 });
    rerender({ width: 910 });

    // Only autoRef was auto-collapsed, so only it gets onAutoExpand
    expect(onAutoExpand).toHaveBeenCalledTimes(1);
    expect(onAutoExpand).toHaveBeenCalledWith(autoRef);
  });
});

describe('tiered auto-collapse (two independent hook instances)', () => {
  // Simulates the App.tsx pattern: two useAutoCollapse calls with different thresholds.
  // Tier 1 (discussion): threshold = 250 + 850 = 1100, expand at 1150
  // Tier 2 (sidebars):   threshold = 200 + 200 + 450 = 850, expand at 900

  function renderTiered(initialWidth: number) {
    const discussionRef = mockPanelRef();
    const leftRef = mockPanelRef();
    const rightRef = mockPanelRef();

    const { rerender } = renderHook(
      ({ width }) => {
        // Tier 1: Discussion collapses first
        useAutoCollapse({
          containerWidth: width,
          panelRefs: [discussionRef],
          pixelMinimums: [250],
          contentMinPx: 850, // content + left + right sidebar minimums
        });
        // Tier 2: Sidebars collapse second
        useAutoCollapse({
          containerWidth: width,
          panelRefs: [leftRef, rightRef],
          pixelMinimums: [200, 200],
          contentMinPx: 450,
        });
      },
      { initialProps: { width: initialWidth } },
    );

    return { discussionRef, leftRef, rightRef, rerender };
  }

  it('discussion collapses first at higher threshold, sidebars stay open', () => {
    const { discussionRef, leftRef, rightRef, rerender } = renderTiered(1200);

    // Narrow to 1050 — below discussion threshold (1100) but above sidebar threshold (850)
    rerender({ width: 1050 });

    expect(discussionRef.current!.collapse).toHaveBeenCalled();
    expect(leftRef.current!.collapse).not.toHaveBeenCalled();
    expect(rightRef.current!.collapse).not.toHaveBeenCalled();
  });

  it('sidebars collapse at lower threshold independently', () => {
    const { discussionRef, leftRef, rightRef, rerender } = renderTiered(1200);

    // Narrow below both thresholds
    rerender({ width: 800 });

    expect(discussionRef.current!.collapse).toHaveBeenCalled();
    expect(leftRef.current!.collapse).toHaveBeenCalled();
    expect(rightRef.current!.collapse).toHaveBeenCalled();
  });

  it('sidebars expand first, discussion expands at higher threshold', () => {
    const { discussionRef, leftRef, rightRef, rerender } = renderTiered(1200);

    // Collapse everything
    rerender({ width: 800 });

    // Widen to 910 — above sidebar expand threshold (900) but below discussion expand (1150)
    rerender({ width: 910 });

    expect(leftRef.current!.expand).toHaveBeenCalled();
    expect(rightRef.current!.expand).toHaveBeenCalled();
    expect(discussionRef.current!.expand).not.toHaveBeenCalled();
  });

  it('discussion expands when above its expand threshold', () => {
    const { discussionRef, leftRef, rightRef, rerender } = renderTiered(1200);

    // Collapse everything
    rerender({ width: 800 });

    // Widen past both expand thresholds
    rerender({ width: 1160 });

    expect(leftRef.current!.expand).toHaveBeenCalled();
    expect(rightRef.current!.expand).toHaveBeenCalled();
    expect(discussionRef.current!.expand).toHaveBeenCalled();
  });

  it('full cycle: narrow → discussion collapses → sidebars collapse → widen → sidebars expand → discussion expands', () => {
    const { discussionRef, leftRef, rightRef, rerender } = renderTiered(1200);

    // Step 1: Discussion collapses
    rerender({ width: 1050 });
    expect(discussionRef.current!.collapse).toHaveBeenCalledTimes(1);
    expect(leftRef.current!.collapse).not.toHaveBeenCalled();

    // Step 2: Sidebars collapse
    rerender({ width: 800 });
    expect(leftRef.current!.collapse).toHaveBeenCalledTimes(1);
    expect(rightRef.current!.collapse).toHaveBeenCalledTimes(1);

    // Step 3: Sidebars expand (above 900, below 1150)
    rerender({ width: 910 });
    expect(leftRef.current!.expand).toHaveBeenCalledTimes(1);
    expect(rightRef.current!.expand).toHaveBeenCalledTimes(1);
    expect(discussionRef.current!.expand).not.toHaveBeenCalled();

    // Step 4: Discussion expands (above 1150)
    rerender({ width: 1160 });
    expect(discussionRef.current!.expand).toHaveBeenCalledTimes(1);
  });
});
