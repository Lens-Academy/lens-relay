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
});
