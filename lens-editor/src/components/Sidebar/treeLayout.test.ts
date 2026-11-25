import { describe, it, expect } from 'vitest';
import { treeGuides, treeItemPadding } from './treeLayout';

describe('treeGuides', () => {
  it('runs a line down the middle of the icon of each folder an item is in', () => {
    // Section contents (level 1) have none; inside a folder, one under its icon
    expect(treeGuides(0)).toEqual([]);
    expect(treeGuides(1)).toEqual([]);
    expect(treeGuides(2)).toEqual([8 + treeItemPadding(1) + 11]);
    expect(treeGuides(3)).toEqual([8 + treeItemPadding(1) + 11, 8 + treeItemPadding(2) + 11]);
  });
});
