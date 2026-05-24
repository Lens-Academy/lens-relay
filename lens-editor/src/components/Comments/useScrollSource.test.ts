/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRef } from 'react';
import { useScrollSource } from './useScrollSource';

describe('useScrollSource', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads scrollTop/scrollHeight/clientHeight from the element', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollTop', { get: () => 42, configurable: true });
    Object.defineProperty(el, 'scrollHeight', { get: () => 1000, configurable: true });
    Object.defineProperty(el, 'clientHeight', { get: () => 500, configurable: true });

    const ref = { current: el } as React.RefObject<HTMLElement | null>;
    const { result } = renderHook(() => useScrollSource(ref));
    const src = result.current;

    expect(src.getScrollTop()).toBe(42);
    expect(src.getScrollHeight()).toBe(1000);
    expect(src.getClientHeight()).toBe(500);
  });

  it('fires subscribers on scroll', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const ref = { current: el } as React.RefObject<HTMLElement | null>;
    const { result } = renderHook(() => useScrollSource(ref));

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

  it('returns 0 values when ref is null', () => {
    const ref = { current: null } as React.RefObject<HTMLElement | null>;
    const { result } = renderHook(() => useScrollSource(ref));
    expect(result.current.getScrollTop()).toBe(0);
    expect(result.current.getScrollHeight()).toBe(0);
    expect(result.current.getClientHeight()).toBe(0);
  });
});
