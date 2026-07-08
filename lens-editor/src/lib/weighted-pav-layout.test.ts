import { describe, it, expect } from 'vitest';
import { computeWeightedLayout, type LayoutItem } from './weighted-pav-layout';

const GAP = 8;

function layout(items: LayoutItem[], gap = GAP) {
  const out = computeWeightedLayout({ items, gap });
  // Pair each item with its computed top, preserving input order.
  return items.map((it) => ({ item: it, top: out.get(it.key)! }));
}

/** True if no two adjacent cards overlap (within tiny FP tolerance). */
function noOverlap(placed: { item: LayoutItem; top: number }[]): boolean {
  for (let i = 1; i < placed.length; i++) {
    const prev = placed[i - 1];
    const cur = placed[i];
    if (cur.top + 1e-6 < prev.top + prev.item.height + GAP) return false;
  }
  return true;
}

describe('computeWeightedLayout', () => {
  it('returns each card at its anchor when none overlap', () => {
    const placed = layout([
      { key: 1, anchorY: 0,   height: 50, weight: 1 },
      { key: 2, anchorY: 100, height: 50, weight: 1 },
      { key: 3, anchorY: 200, height: 50, weight: 1 },
    ]);
    expect(placed.map((p) => p.top)).toEqual([0, 100, 200]);
  });

  it('never produces overlapping cards (no matter the input)', () => {
    // Three overlapping clusters of varied weights.
    const placed = layout([
      { key: 1, anchorY: 0,   height: 50, weight: 1 },
      { key: 2, anchorY: 30,  height: 50, weight: 5 },
      { key: 3, anchorY: 60,  height: 50, weight: 1 },
      { key: 4, anchorY: 200, height: 50, weight: 1 },
      { key: 5, anchorY: 210, height: 50, weight: 1 },
    ]);
    expect(noOverlap(placed)).toBe(true);
  });

  it('respects an infinite-weight pin exactly', () => {
    const placed = layout([
      { key: 1, anchorY: 0,  height: 50, weight: 1 },
      { key: 2, anchorY: 40, height: 50, weight: Number.POSITIVE_INFINITY },
    ]);
    const pinned = placed.find((p) => p.item.key === 2)!;
    expect(pinned.top).toBe(40);
    expect(noOverlap(placed)).toBe(true);
  });

  it('places a heavier card strictly closer to its anchor than a lighter one', () => {
    // Two overlapping cards with equal anchor-distance from the merged center.
    // The heavier card should land closer to its anchor.
    const light = layout([
      { key: 1, anchorY: 0,  height: 50, weight: 1 },
      { key: 2, anchorY: 40, height: 50, weight: 1 },
    ]);
    const heavy = layout([
      { key: 1, anchorY: 0,  height: 50, weight: 1 },
      { key: 2, anchorY: 40, height: 50, weight: 9 },
    ]);
    const lightErr2 = Math.abs(light.find((p) => p.item.key === 2)!.top - 40);
    const heavyErr2 = Math.abs(heavy.find((p) => p.item.key === 2)!.top - 40);
    expect(heavyErr2).toBeLessThan(lightErr2);
  });

  it('zero-weight card does not pull but still respects the gap', () => {
    const placed = layout([
      { key: 1, anchorY: 0,  height: 50, weight: 1 },
      { key: 2, anchorY: 40, height: 50, weight: 0 },
    ]);
    // The pulling card stays at its anchor; the passive card sits exactly
    // gap below.
    expect(placed[0].top).toBe(0);
    expect(placed[1].top).toBe(50 + GAP);
  });

  it('preserves anchor order across the result', () => {
    // After any merging, output order along y must still match input
    // anchor order (PAV is monotone).
    const placed = layout([
      { key: 'a', anchorY: 0,   height: 30, weight: 1 },
      { key: 'b', anchorY: 20,  height: 30, weight: 1 },
      { key: 'c', anchorY: 40,  height: 30, weight: 1 },
      { key: 'd', anchorY: 200, height: 30, weight: 1 },
    ]);
    const tops = placed.map((p) => p.top);
    expect(tops.every((t, i) => i === 0 || t > tops[i - 1])).toBe(true);
  });

  it('returns an empty map for empty input', () => {
    expect(computeWeightedLayout({ items: [], gap: GAP }).size).toBe(0);
  });
});
