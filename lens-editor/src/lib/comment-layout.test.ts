import { describe, it, expect } from 'vitest';
import {
  resolveOverlaps,
  computeSharedHeight,
  computeEditorPadding,
  mapThreadPositions,
  type LayoutItem,
  type PositionMapper,
} from './comment-layout';
import type { CommentThread } from './criticmarkup-parser';

describe('resolveOverlaps', () => {
  it('returns empty array for empty input', () => {
    expect(resolveOverlaps([])).toEqual([]);
  });

  it('returns single item at its targetY', () => {
    const items: LayoutItem[] = [{ targetY: 100, height: 40 }];
    const result = resolveOverlaps(items);
    expect(result).toEqual([{ layoutY: 100 }]);
  });

  it('keeps non-overlapping items at their target positions', () => {
    const items: LayoutItem[] = [
      { targetY: 0, height: 40 },
      { targetY: 100, height: 40 },
      { targetY: 200, height: 40 },
    ];
    const result = resolveOverlaps(items);
    expect(result).toEqual([
      { layoutY: 0 },
      { layoutY: 100 },
      { layoutY: 200 },
    ]);
  });

  it('pushes overlapping items down', () => {
    const items: LayoutItem[] = [
      { targetY: 0, height: 40 },
      { targetY: 20, height: 40 }, // overlaps first (0+40 > 20)
    ];
    const result = resolveOverlaps(items);
    expect(result).toEqual([
      { layoutY: 0 },
      { layoutY: 44 }, // 0 + 40 + 4 (default gap)
    ]);
  });

  it('cascades push-down for multiple overlapping items', () => {
    const items: LayoutItem[] = [
      { targetY: 0, height: 40 },
      { targetY: 10, height: 40 },
      { targetY: 20, height: 40 },
    ];
    const result = resolveOverlaps(items);
    expect(result).toEqual([
      { layoutY: 0 },
      { layoutY: 44 },  // 0 + 40 + 4
      { layoutY: 88 },  // 44 + 40 + 4
    ]);
  });

  it('uses custom gap', () => {
    const items: LayoutItem[] = [
      { targetY: 0, height: 40 },
      { targetY: 20, height: 40 },
    ];
    const result = resolveOverlaps(items, 8);
    expect(result).toEqual([
      { layoutY: 0 },
      { layoutY: 48 }, // 0 + 40 + 8
    ]);
  });

  it('handles items at same targetY', () => {
    const items: LayoutItem[] = [
      { targetY: 100, height: 30 },
      { targetY: 100, height: 30 },
    ];
    const result = resolveOverlaps(items);
    expect(result).toEqual([
      { layoutY: 100 },
      { layoutY: 134 }, // 100 + 30 + 4
    ]);
  });
});

describe('computeSharedHeight', () => {
  it('returns editor height when no cards', () => {
    expect(computeSharedHeight(1000, 0)).toBe(1000);
  });

  it('returns editor height when cards fit within editor', () => {
    expect(computeSharedHeight(1000, 500)).toBe(1000);
  });

  it('returns lastCardBottom + padding when cards overflow editor', () => {
    expect(computeSharedHeight(1000, 1200)).toBe(1200 + 64);
  });

  it('uses custom padding', () => {
    expect(computeSharedHeight(1000, 1200, 100)).toBe(1300);
  });
});

describe('computeEditorPadding', () => {
  it('returns 0 when editor is taller than cards', () => {
    expect(computeEditorPadding(1000, 500)).toBe(0);
  });

  it('returns 0 when editor equals card bottom', () => {
    expect(computeEditorPadding(1000, 1000)).toBe(0);
  });

  it('returns difference + padding when cards overflow', () => {
    expect(computeEditorPadding(1000, 1200)).toBe(264); // (1200 + 64) - 1000
  });

  it('uses custom padding', () => {
    expect(computeEditorPadding(1000, 1200, 100)).toBe(300); // (1200 + 100) - 1000
  });
});

describe('mapThreadPositions', () => {
  const syntheticMapper: PositionMapper = (pos) => pos * 20;

  function makeThread(from: number, to: number, commentCount: number = 1): CommentThread {
    const comments = [];
    for (let i = 0; i < commentCount; i++) {
      comments.push({
        type: 'comment' as const,
        from: from + i * 10,
        to: from + (i + 1) * 10,
        contentFrom: from + i * 10 + 3,
        contentTo: from + (i + 1) * 10 - 3,
        content: `comment ${i}`,
      });
    }
    return { comments, from, to };
  }

  it('returns empty array for no threads', () => {
    expect(mapThreadPositions([], syntheticMapper)).toEqual([]);
  });

  it('maps single thread with badge number 1', () => {
    const threads = [makeThread(5, 15)];
    const result = mapThreadPositions(threads, syntheticMapper);
    expect(result).toEqual([
      { thread: threads[0], badgeNumber: 1, targetY: 100 }, // 5 * 20
    ]);
  });

  it('assigns sequential badge numbers', () => {
    const threads = [makeThread(5, 15), makeThread(50, 60)];
    const result = mapThreadPositions(threads, syntheticMapper);
    expect(result[0].badgeNumber).toBe(1);
    expect(result[1].badgeNumber).toBe(2);
  });

  it('uses thread.from for position mapping', () => {
    const threads = [makeThread(10, 30, 2)];
    const result = mapThreadPositions(threads, syntheticMapper);
    expect(result[0].targetY).toBe(200); // 10 * 20
  });
});
