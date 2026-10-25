// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { scrollsSideways } from './useEdgeSwipe';

function box(scrollWidth: number, clientWidth: number, scrollLeft: number, overflowX = 'auto') {
  const el = document.createElement('div');
  el.style.overflowX = overflowX;
  Object.defineProperty(el, 'scrollWidth', { value: scrollWidth });
  Object.defineProperty(el, 'clientWidth', { value: clientWidth });
  Object.defineProperty(el, 'scrollLeft', { value: scrollLeft });
  const inner = document.createElement('span');
  el.appendChild(inner);
  document.body.appendChild(el);
  return inner;
}

describe('scrollsSideways (a swipe the page can scroll is not a drawer swipe)', () => {
  it('a finger moving left inside a wide box with room to the right scrolls', () => {
    expect(scrollsSideways(box(800, 300, 0), -80)).toBe(true);
  });
  it('at its right end, the swipe goes to the drawer', () => {
    expect(scrollsSideways(box(800, 300, 500), -80)).toBe(false);
  });
  it('moving right scrolls back only when scrolled', () => {
    expect(scrollsSideways(box(800, 300, 0), 80)).toBe(false);
    expect(scrollsSideways(box(800, 300, 40), 80)).toBe(true);
  });
  it('a box that does not overflow, or hides its overflow, never claims the swipe', () => {
    expect(scrollsSideways(box(300, 300, 0), -80)).toBe(false);
    expect(scrollsSideways(box(800, 300, 0, 'hidden'), -80)).toBe(false);
  });
});

describe('useEdgeSwipe in a gesture', () => {
  it('a swipe that starts as a sideways scroll never opens the drawer, even once the scroller reaches its end', async () => {
    const { renderHook } = await import('@testing-library/react');
    const { useEdgeSwipe } = await import('./useEdgeSwipe');
    let opened = 0;
    renderHook(() => useEdgeSwipe({ enabled: true, onSwipeLeft: () => { opened++; } }));
    const el = document.createElement('div');
    el.style.overflowX = 'auto';
    Object.defineProperty(el, 'scrollWidth', { value: 800 });
    Object.defineProperty(el, 'clientWidth', { value: 300 });
    let left = 0;
    Object.defineProperty(el, 'scrollLeft', { get: () => left });
    document.body.appendChild(el);
    const touch = (type: string, x: number) => el.dispatchEvent(Object.assign(new Event(type, { bubbles: true }), { touches: [{ clientX: x, clientY: 100 }] }));
    touch('touchstart', 300);
    touch('touchmove', 200);   // past the threshold, room to scroll: a scroll
    left = 500;                // the native scroll reaches the end
    touch('touchmove', 100);
    touch('touchend', 100);
    expect(opened).toBe(0);
    // A fresh swipe at the end goes to the drawer.
    touch('touchstart', 300);
    touch('touchmove', 200);
    expect(opened).toBe(1);
  });
});
