import { describe, it, expect } from 'vitest';
import { getSubtreeRange } from './getSubtreeRange';
import type { Section } from '../SectionEditor/parseSections';

function section(level: number, type = 'heading', label = ''): Section {
  return { type, label, level, from: 0, to: 0, content: '' };
}

describe('getSubtreeRange', () => {
  it('returns [index, index+1) for a leaf with no children', () => {
    const sections = [section(1), section(1)];
    expect(getSubtreeRange(sections, 0)).toEqual([0, 1]);
  });

  it('includes strictly deeper siblings as children', () => {
    // # Lens: Welcome (level 1)
    //   #### Text      (level 4)
    //   #### Question  (level 4)
    // # Learning Outcome:  (level 1)
    const sections = [section(1), section(4), section(4), section(1)];
    expect(getSubtreeRange(sections, 0)).toEqual([0, 3]);
  });

  it('stops at a same-level sibling', () => {
    // ## Lens (2)
    //   #### Text (4)
    // ## Test (2)
    const sections = [section(2), section(4), section(2)];
    expect(getSubtreeRange(sections, 0)).toEqual([0, 2]);
  });

  it('stops at a shallower sibling', () => {
    // ## Test (2)
    //   #### Question (4)
    // # Learning Outcome (1)
    const sections = [section(2), section(4), section(1)];
    expect(getSubtreeRange(sections, 0)).toEqual([0, 2]);
  });

  it('runs to the end when no later sibling exists', () => {
    const sections = [section(1), section(4), section(4)];
    expect(getSubtreeRange(sections, 0)).toEqual([0, 3]);
  });

  it('handles a root at the last index', () => {
    const sections = [section(1), section(1)];
    expect(getSubtreeRange(sections, 1)).toEqual([1, 2]);
  });

  it('ignores deeper sections when root is already deep', () => {
    // # (1)
    // ## (2)  <- root here
    // #### (4)
    // ## (2)
    const sections = [section(1), section(2), section(4), section(2)];
    expect(getSubtreeRange(sections, 1)).toEqual([1, 3]);
  });
});
