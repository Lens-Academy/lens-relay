import { describe, it, expect } from 'vitest';
import { normalizeHeadingLevels } from './useHeadings';
import type { Heading } from './useHeadings';

/** Helper: build minimal Heading[] from raw levels */
function headingsFromLevels(levels: number[]): Heading[] {
  return levels.map((level, i) => ({
    level,
    text: `Heading ${i}`,
    from: i * 100,
    to: i * 100 + 50,
  }));
}

const fixtures = [
  {
    name: 'already normalized (H1, H2, H3)',
    input: [1, 2, 3, 2, 1],
    expected: [1, 2, 3, 2, 1],
  },
  {
    name: 'starts at H3 — promotes to level 1',
    input: [3, 4, 4, 3, 2, 4, 3, 4],
    expected: [1, 2, 2, 1, 1, 2, 2, 3],
  },
  {
    name: 'single heading',
    input: [4],
    expected: [1],
  },
  {
    name: 'all same level',
    input: [2, 2, 2],
    expected: [1, 1, 1],
  },
  {
    name: 'gap in levels (H2 then H5) — child is still level 2',
    input: [2, 5, 5, 2],
    expected: [1, 2, 2, 1],
  },
  {
    name: 'descending levels (H4, H3, H2, H1)',
    input: [4, 3, 2, 1],
    expected: [1, 1, 1, 1],
  },
  {
    name: 'deep nesting from high start',
    input: [3, 4, 5, 6, 3],
    expected: [1, 2, 3, 4, 1],
  },
  {
    name: 'empty array',
    input: [],
    expected: [],
  },
];

describe('normalizeHeadingLevels', () => {
  for (const { name, input, expected } of fixtures) {
    it(name, () => {
      const headings = headingsFromLevels(input);
      const result = normalizeHeadingLevels(headings);
      expect(result.map((h) => h.displayLevel)).toEqual(expected);
    });
  }
});
