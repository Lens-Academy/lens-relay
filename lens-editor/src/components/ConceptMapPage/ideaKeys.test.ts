import { describe, expect, it } from 'vitest';
import { nextBox, type Box } from './ideaKeys';

const box = (left: number, top: number, width = 100, height = 30): Box => ({ left, top, right: left + width, bottom: top + height });

describe('nextBox', () => {
  // Three columns as the map draws them; the middle one holds three boxes
  const columns = [box(0, 100), box(200, 0), box(200, 50), box(200, 100, 100, 60), box(400, 40)];

  it('goes to the nearest box in the next column, the one level with it first', () => {
    expect(nextBox(columns, 0, 'right')).toBe(3);
    expect(nextBox(columns, 3, 'left')).toBe(0);
    expect(nextBox(columns, 1, 'right')).toBe(4);
    expect(nextBox(columns, 4, 'left')).toBe(2);
  });

  it('stays in the column for up and down', () => {
    expect(nextBox(columns, 1, 'down')).toBe(2);
    expect(nextBox(columns, 2, 'down')).toBe(3);
    expect(nextBox(columns, 3, 'up')).toBe(2);
  });

  it('gives -1 where nothing lies in that direction', () => {
    expect(nextBox(columns, 0, 'left')).toBe(-1);
    expect(nextBox(columns, 1, 'up')).toBe(-1);
    expect(nextBox(columns, 4, 'right')).toBe(-1);
    expect(nextBox(columns, 9, 'right')).toBe(-1);
  });

  it('follows the rows of wrapped boxes of different widths', () => {
    // Row one: three boxes; row two: two wider ones
    const rows = [box(0, 0, 80), box(90, 0, 150), box(250, 0, 60), box(0, 40, 200), box(210, 40, 100)];
    expect(nextBox(rows, 0, 'right')).toBe(1);
    expect(nextBox(rows, 1, 'right')).toBe(2);
    expect(nextBox(rows, 2, 'left')).toBe(1);
    expect(nextBox(rows, 0, 'down')).toBe(3);
    expect(nextBox(rows, 2, 'down')).toBe(4);
    expect(nextBox(rows, 4, 'up')).toBe(2);
    expect(nextBox(rows, 3, 'right')).toBe(4);
  });

  it('moves nowhere when the boxes have no place yet', () => {
    const none = [box(0, 0, 0, 0), box(0, 0, 0, 0)];
    expect(nextBox(none, 0, 'right')).toBe(-1);
    expect(nextBox(none, 0, 'down')).toBe(-1);
  });
});
