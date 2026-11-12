import { describe, expect, it } from 'vitest';
import { layoutMap, wrappedLines, type MapSizes } from './idea-map-layout';

const SIZES: MapSizes = { nodeWidth: 100, gapX: 40, gapY: 10, margin: 20 };

describe('layoutMap', () => {
  it('stacks the boxes of a column by their own heights, so a tall box never covers the next', () => {
    const heights: Record<string, number> = { a: 30, long: 90, c: 30, d: 30 };
    const { boxes, width, height } = layoutMap([['a', 'long', 'c'], ['d']], [], (key) => heights[key], SIZES);
    expect(boxes.map((box) => [box.key, box.x, box.y, box.height])).toEqual([
      ['a', 20, 20, 30],
      ['long', 20, 60, 90],
      ['c', 20, 160, 30],
      // A shorter column is centred on the tallest
      ['d', 160, 90, 30],
    ]);
    expect(width).toBe(20 + 100 + 40 + 100 + 20);
    expect(height).toBe(20 + 170 + 20);
    // No two boxes of a column overlap, whatever their heights
    const first = boxes.filter((box) => box.column === 0);
    first.slice(1).forEach((box, i) => expect(box.y).toBe(first[i].y + first[i].height + SIZES.gapY));
  });

  it('draws a line from the middle of a box to the middle of the next', () => {
    const { lines } = layoutMap([['a'], ['b']], [{ from: 'a', to: 'b', helpful: false }], (key) => (key === 'a' ? 30 : 70), SIZES);
    // a is centred on b: both middles are at 20 + 35
    expect(lines).toEqual([{ from: 'a', to: 'b', helpful: false, d: 'M120,55 C140,55 140,55 160,55' }]);
  });

  it('passes a column between two of its boxes, not behind a tall one', () => {
    const heights: Record<string, number> = { a: 30, top: 30, tall: 120, z: 30 };
    const { boxes, lines } = layoutMap(
      [['a'], ['top', 'tall'], ['z']],
      [{ from: 'a', to: 'z', helpful: true }],
      (key) => heights[key],
      SIZES,
    );
    const pass = Number(/ L\d+,([\d.]+)/.exec(lines[0].d)![1]);
    for (const box of boxes.filter((b) => b.column === 1)) {
      expect(pass <= box.y || pass >= box.y + box.height).toBe(true);
    }
    // The gap between "top" and "tall"
    expect(pass).toBe(20 + 30 + 5);
  });

  it('leaves out a line to an idea that is not on the map, and has no size without columns', () => {
    expect(layoutMap([['a']], [{ from: 'a', to: 'gone', helpful: false }], () => 30, SIZES).lines).toEqual([]);
    expect(layoutMap([], [], () => 30, SIZES)).toEqual({ boxes: [], lines: [], width: 0, height: 40 });
  });
});

describe('wrappedLines', () => {
  it('counts the lines a name takes when it wraps at whole words', () => {
    expect(wrappedLines('Corrigibility', 24)).toBe(1);
    expect(wrappedLines('We are on the path to building ASI', 24)).toBe(2);
    expect(wrappedLines('Building ASI without extreme caution will wipe out humanity', 24)).toBe(3);
    // A word longer than a line is cut
    expect(wrappedLines('Pneumonoultramicroscopicsilicovolcanoconiosis', 24)).toBe(2);
    expect(wrappedLines('a Pneumonoultramicroscopicsilicovolcanoconiosis b', 24)).toBe(3);
    expect(wrappedLines('', 24)).toBe(1);
  });
});
