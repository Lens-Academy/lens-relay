import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useContainerWidth } from './useContainerWidth';

// Mock ResizeObserver
let resizeCallback: ResizeObserverCallback;
const mockObserve = vi.fn();
const mockDisconnect = vi.fn();

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    constructor(cb: ResizeObserverCallback) { resizeCallback = cb; }
    observe = mockObserve;
    disconnect = mockDisconnect;
    unobserve = vi.fn();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function triggerResize(width: number) {
  resizeCallback(
    [{ contentRect: { width } } as ResizeObserverEntry],
    {} as ResizeObserver,
  );
}

describe('useContainerWidth', () => {
  it('returns 0 initially when ref is not attached', () => {
    const { result } = renderHook(() => useContainerWidth());
    expect(result.current.width).toBe(0);
  });

  it('updates width when ResizeObserver fires', async () => {
    const div = document.createElement('div');
    const { result } = renderHook(() => {
      const hook = useContainerWidth();
      (hook.ref as React.MutableRefObject<HTMLElement | null>).current = div;
      return hook;
    });

    await act(() => {
      triggerResize(1200);
    });
    expect(result.current.width).toBe(1200);

    await act(() => {
      triggerResize(800);
    });
    expect(result.current.width).toBe(800);
  });

  it('disconnects observer on unmount', () => {
    const div = document.createElement('div');
    const { unmount } = renderHook(() => {
      const hook = useContainerWidth();
      (hook.ref as React.MutableRefObject<HTMLElement | null>).current = div;
      return hook;
    });
    unmount();
    expect(mockDisconnect).toHaveBeenCalled();
  });
});
