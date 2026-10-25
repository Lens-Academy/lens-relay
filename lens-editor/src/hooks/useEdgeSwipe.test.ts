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
