import type { KeyboardEvent } from 'react';

/** Where a box is on the screen. */
export interface Box { left: number; top: number; right: number; bottom: number }

export type Direction = 'left' | 'right' | 'up' | 'down';

const ARROWS: Record<string, Direction> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

/** More than any distance on a screen: what puts a box out of line behind every one in line. */
const FAR = 1e6;

/** How far two ranges are apart; 0 when they overlap. */
const gap = (a1: number, a2: number, b1: number, b2: number) => Math.max(0, b1 - a2, a1 - b2);

/**
 * The box an arrow key goes to from `boxes[from]`, or -1 when there is none.
 * A box counts when its middle lies in that direction. One in the same row
 * (for left and right) or the same column (for up and down) comes before any
 * other, the nearest first; without one, the nearest of the others, where
 * being off to the side counts three times as far as being ahead.
 */
export function nextBox(boxes: readonly Box[], from: number, direction: Direction): number {
  const here = boxes[from];
  if (!here) return -1;
  const across = direction === 'left' || direction === 'right';
  const sign = direction === 'left' || direction === 'up' ? -1 : 1;
  /** Where a box is along the way of the arrow, and from side to side of it. */
  const along = (box: Box) => (across ? [box.left, box.right] : [box.top, box.bottom]);
  const aside = (box: Box) => (across ? [box.top, box.bottom] : [box.left, box.right]);
  const middle = ([start, end]: number[]) => (start + end) / 2;
  const [sideStart, sideEnd] = aside(here);
  let best = -1;
  let least = Infinity;
  boxes.forEach((box, index) => {
    if (index === from) return;
    const ahead = (middle(along(box)) - middle(along(here))) * sign;
    if (ahead < 1) return;
    const [start, end] = aside(box);
    const off = gap(sideStart, sideEnd, start, end);
    // Two that are as far ahead: the one more in line
    const far = (off > 0 ? FAR + 3 * off : 0) + ahead + Math.abs(middle([start, end]) - middle([sideStart, sideEnd])) / 100;
    if (far < least) {
      least = far;
      best = index;
    }
  });
  return best;
}

/**
 * The arrow keys move the focus between the ideas of a view (every element
 * with `data-key` in the one this listens on), by where they are on the screen.
 */
export function arrowFocus(e: KeyboardEvent<HTMLElement>) {
  const direction = ARROWS[e.key];
  if (!direction || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const from = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-key]') : null;
  if (!from || !e.currentTarget.contains(from)) return;
  const ideas = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-key]')];
  const next = ideas[nextBox(ideas.map((idea) => idea.getBoundingClientRect()), ideas.indexOf(from), direction)];
  if (!next) return;
  // Not the page: the arrow moved the focus
  e.preventDefault();
  next.focus();
}
