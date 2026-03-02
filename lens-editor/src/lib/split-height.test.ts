import { describe, test, expect } from 'vitest';
import { computeSplitHeight } from './split-height';

describe('computeSplitHeight', () => {
  const MIN = 80;

  test('both fit — each gets its content height', () => {
    const result = computeSplitHeight({
      topContent: 100,
      bottomContent: 80,
      available: 500,
      minHeight: MIN,
    });
    expect(result).toEqual({ topHeight: 100, bottomHeight: 80 });
  });

  test('both fit exactly — fills available space', () => {
    const result = computeSplitHeight({
      topContent: 250,
      bottomContent: 250,
      available: 500,
      minHeight: MIN,
    });
    expect(result).toEqual({ topHeight: 250, bottomHeight: 250 });
  });

  test('big top, small bottom — bottom keeps content, top gets remainder', () => {
    const result = computeSplitHeight({
      topContent: 1000,
      bottomContent: 100,
      available: 500,
      minHeight: MIN,
    });
    expect(result).toEqual({ topHeight: 400, bottomHeight: 100 });
  });

  test('small top, big bottom — top keeps content, bottom gets remainder', () => {
    const result = computeSplitHeight({
      topContent: 80,
      bottomContent: 800,
      available: 500,
      minHeight: MIN,
    });
    expect(result).toEqual({ topHeight: 80, bottomHeight: 420 });
  });

  test('both large, proportional — split by content ratio', () => {
    const result = computeSplitHeight({
      topContent: 600,
      bottomContent: 400,
      available: 500,
      minHeight: MIN,
    });
    expect(result).toEqual({ topHeight: 300, bottomHeight: 200 });
  });

  test('both large, equal — split evenly', () => {
    const result = computeSplitHeight({
      topContent: 800,
      bottomContent: 800,
      available: 500,
      minHeight: MIN,
    });
    expect(result).toEqual({ topHeight: 250, bottomHeight: 250 });
  });

  test('both large, extreme ratio — clamped to 35-65%', () => {
    // Both panels have content exceeding their proportional shares,
    // so clamping applies without redistribution
    const result = computeSplitHeight({
      topContent: 1500,
      bottomContent: 500,
      available: 500,
      minHeight: MIN,
    });
    // Unclamped ratio: 1500/2000 = 75% top. Clamped to 65% top, 35% bottom.
    expect(result).toEqual({ topHeight: 325, bottomHeight: 175 });
  });

  test('min-height enforcement — small content gets minHeight', () => {
    const result = computeSplitHeight({
      topContent: 1000,
      bottomContent: 30,
      available: 500,
      minHeight: MIN,
    });
    // bottomContent (30) < minHeight (80), so bottom gets 80, top gets 420
    expect(result).toEqual({ topHeight: 420, bottomHeight: 80 });
  });

  test('available equals 2x minHeight — both get minHeight', () => {
    const result = computeSplitHeight({
      topContent: 1000,
      bottomContent: 1000,
      available: 160,
      minHeight: MIN,
    });
    expect(result).toEqual({ topHeight: 80, bottomHeight: 80 });
  });

  test('zero content — sensible defaults (split evenly)', () => {
    const result = computeSplitHeight({
      topContent: 0,
      bottomContent: 0,
      available: 500,
      minHeight: MIN,
    });
    expect(result).toEqual({ topHeight: 250, bottomHeight: 250 });
  });
});
