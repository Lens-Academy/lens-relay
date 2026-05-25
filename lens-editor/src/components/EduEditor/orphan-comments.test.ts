import { describe, it, expect } from 'vitest';
import { findOrphanCommentOffsets } from './orphan-comments';
import { parseSections } from '../SectionEditor/parseSections';

describe('findOrphanCommentOffsets', () => {
  it('returns a comment in a Text section heading line as orphan of that section', () => {
    const text = '#### Text {>>{"author":"X","timestamp":1}@@hi<<}\ncontent::\nbody\n';
    const sections = parseSections(text);
    const orphans = findOrphanCommentOffsets(text, sections);
    expect(orphans).toEqual([{ absFrom: 10, sectionIndex: 0 }]);
  });

  it('does NOT return a comment that lives inside a Text section content:: field', () => {
    const text = '#### Text\ncontent::\nfoo {>>{"author":"X","timestamp":1}@@hi<<} bar\n';
    const sections = parseSections(text);
    expect(findOrphanCommentOffsets(text, sections)).toEqual([]);
  });

  it('returns a comment in a Chat section heading line as orphan, but not one in instructions::', () => {
    const text =
      '#### Chat {>>{"author":"X","timestamp":1}@@heading<<}\n' +
      'instructions:: help {>>{"author":"X","timestamp":2}@@inline<<} more\n';
    const sections = parseSections(text);
    const orphans = findOrphanCommentOffsets(text, sections);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].sectionIndex).toBe(0);
    // The heading-line comment starts at column 10 ("#### Chat ").
    expect(orphans[0].absFrom).toBe(10);
  });

  it('treats a generic heading section (no rendered fields) as entirely orphan', () => {
    const text = '# Module: Foo {>>{"author":"X","timestamp":1}@@hi<<}\n';
    const sections = parseSections(text);
    const orphans = findOrphanCommentOffsets(text, sections);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].sectionIndex).toBe(0);
  });
});
