/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi } from 'vitest';
import { effectiveY, makeIframeScrollSource } from './htmlCommentsAdapter';

describe('effectiveY', () => {
  it('combines iframe top, rect y, and scroll delta', () => {
    // iframeTop + rect.y - (current - baseline) = 200 + 100 - (70 - 50) = 280
    expect(effectiveY({ y: 100, x: 0, w: 10, h: 10 }, 50, 70, 200)).toBe(280);
  });

  it('returns iframeTop + rect.y when scroll has not moved', () => {
    expect(effectiveY({ y: 50, x: 0, w: 10, h: 10 }, 0, 0, 100)).toBe(150);
  });
});

describe('makeIframeScrollSource', () => {
  it('reads getters from the provided state function', () => {
    const state = { scrollTop: 30, scrollHeight: 1000, clientHeight: 500 };
    const src = makeIframeScrollSource(() => state);
    expect(src.getScrollTop()).toBe(30);
    expect(src.getScrollHeight()).toBe(1000);
    expect(src.getClientHeight()).toBe(500);
    state.scrollTop = 50;
    expect(src.getScrollTop()).toBe(50);
  });

  it('notify fires subscribers; unsubscribe stops them', () => {
    const src = makeIframeScrollSource(() => ({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }));
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = src.subscribe(a);
    src.subscribe(b);
    src.notify();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    unsubA();
    src.notify();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });
});
