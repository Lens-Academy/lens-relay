/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useScrollSource } from './useScrollSource';

describe('useScrollSource', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads scrollTop/scrollHeight/clientHeight from the element', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollTop', { get: () => 42, configurable: true });
    Object.defineProperty(el, 'scrollHeight', { get: () => 1000, configurable: true });
    Object.defineProperty(el, 'clientHeight', { get: () => 500, configurable: true });

    const { result } = renderHook(() => useScrollSource(el));
    const src = result.current;

    expect(src.getScrollTop()).toBe(42);
    expect(src.getScrollHeight()).toBe(1000);
    expect(src.getClientHeight()).toBe(500);
  });

  it('fires subscribers on scroll', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const { result } = renderHook(() => useScrollSource(el));

    const cb = vi.fn();
    const unsub = result.current.subscribe(cb);

    act(() => {
      el.dispatchEvent(new Event('scroll'));
    });
    expect(cb).toHaveBeenCalledTimes(1);

    unsub();
    act(() => {
      el.dispatchEvent(new Event('scroll'));
    });
    expect(cb).toHaveBeenCalledTimes(1);
    el.remove();
  });

  it('returns 0 values when element is null', () => {
    const { result } = renderHook(() => useScrollSource(null));
    expect(result.current.getScrollTop()).toBe(0);
    expect(result.current.getScrollHeight()).toBe(0);
    expect(result.current.getClientHeight()).toBe(0);
  });

  it('attaches listeners when the element becomes available on a later render', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const { result, rerender } = renderHook(({ e }: { e: HTMLElement | null }) => useScrollSource(e), {
      initialProps: { e: null as HTMLElement | null },
    });

    const cb = vi.fn();
    result.current.subscribe(cb);

    // Initial mount with null: scrolling a (different) element does nothing
    act(() => { el.dispatchEvent(new Event('scroll')); });
    expect(cb).toHaveBeenCalledTimes(0);

    // Pass the element on a re-render: listeners should now attach
    rerender({ e: el });
    act(() => { el.dispatchEvent(new Event('scroll')); });
    expect(cb).toHaveBeenCalledTimes(1);
    el.remove();
  });
});
