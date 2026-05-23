import { describe, it, expect } from 'vitest';
import { computeWeightedLayout } from './weighted-pav-layout';

describe('computeWeightedLayout', () => {
  it('returns each card at its anchor when none overlap', () => {
    const result = computeWeightedLayout({
      items: [
        { key: 1, anchorY: 0,   height: 50, weight: 1 },
        { key: 2, anchorY: 100, height: 50, weight: 1 },
        { key: 3, anchorY: 200, height: 50, weight: 1 },
      ],
      gap: 8,
    });
    expect(result.get(1)).toBe(0);
    expect(result.get(2)).toBe(100);
    expect(result.get(3)).toBe(200);
  });

  it('merges two overlapping equal-weight cards to their midpoint', () => {
    const result = computeWeightedLayout({
      items: [
        { key: 1, anchorY: 0,  height: 50, weight: 1 },
        { key: 2, anchorY: 40, height: 50, weight: 1 }, // overlap
      ],
      gap: 8,
    });
    // Cards span (y1, y1+50) and (y2, y2+50). Constraint y2 ≥ y1 + 58.
    // Equal weights → minimise (y1)² + (y2-40)². With y2 = y1 + 58,
    // minimise y1² + (y1+18)². d/dy1 = 4y1 + 36 = 0 → y1 = -9, y2 = 49.
    expect(result.get(1)).toBeCloseTo(-9, 5);
    expect(result.get(2)).toBeCloseTo(49, 5);
  });

  it('weights heavier card closer to its anchor', () => {
    const result = computeWeightedLayout({
      items: [
        { key: 1, anchorY: 0,  height: 50, weight: 1 },
        { key: 2, anchorY: 40, height: 50, weight: 9 }, // 9x heavier
      ],
      gap: 8,
    });
    // y2 = y1 + 58. Minimise 1·y1² + 9·(y1+18)². d/dy1 = 2y1 + 18·(y1+18) = 0
    // → 20·y1 = -324 → y1 = -16.2; y2 = 41.8 (closer to its anchor 40).
    expect(result.get(1)).toBeCloseTo(-16.2, 5);
    expect(result.get(2)).toBeCloseTo(41.8, 5);
  });

  it('treats infinite weight as a hard pin', () => {
    const result = computeWeightedLayout({
      items: [
        { key: 1, anchorY: 0,  height: 50, weight: 1 },
        { key: 2, anchorY: 40, height: 50, weight: Number.POSITIVE_INFINITY },
      ],
      gap: 8,
    });
    // Card 2 pinned at 40; card 1 must end ≤ 32; closest to its anchor 0 is -18.
    expect(result.get(2)).toBe(40);
    expect(result.get(1)).toBeCloseTo(-18, 5);
  });

  it('zero-weight card still respects overlap but does not pull', () => {
    const result = computeWeightedLayout({
      items: [
        { key: 1, anchorY: 0,  height: 50, weight: 1 },
        { key: 2, anchorY: 40, height: 50, weight: 0 },
      ],
      gap: 8,
    });
    // Only card 1 pulls. Card 1 stays at anchor 0; card 2 placed at 58.
    expect(result.get(1)).toBe(0);
    expect(result.get(2)).toBe(58);
  });

  it('chains overlap propagation across three cards', () => {
    const result = computeWeightedLayout({
      items: [
        { key: 1, anchorY: 0,  height: 50, weight: 1 },
        { key: 2, anchorY: 40, height: 50, weight: 1 },
        { key: 3, anchorY: 80, height: 50, weight: 1 },
      ],
      gap: 8,
    });
    // All three merge. Offsets within block: 0, 58, 116.
    // Minimise (y)² + (y+58-40)² + (y+116-80)² = y² + (y+18)² + (y+36)².
    // d/dy = 2y + 2(y+18) + 2(y+36) = 6y + 108 = 0 → y = -18.
    expect(result.get(1)).toBeCloseTo(-18, 5);
    expect(result.get(2)).toBeCloseTo(40, 5);
    expect(result.get(3)).toBeCloseTo(98, 5);
  });

  it('does not merge cards that already satisfy the gap', () => {
    const result = computeWeightedLayout({
      items: [
        { key: 1, anchorY: 0,   height: 50, weight: 1 },
        { key: 2, anchorY: 200, height: 50, weight: 1 },
      ],
      gap: 8,
    });
    expect(result.get(1)).toBe(0);
    expect(result.get(2)).toBe(200);
  });

  it('returns empty map for empty input', () => {
    expect(computeWeightedLayout({ items: [], gap: 8 }).size).toBe(0);
  });
});
