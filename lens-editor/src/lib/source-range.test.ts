import { describe, expect, it } from 'vitest';
import { paragraphRange } from './source-range';

const DOC = `---
title: x
---
# Heading

First line of para one,
second line of para one.

**Para two** has [a link](http://x).
- list item
# Next heading
Para three.`;

describe('paragraphRange', () => {
  it('takes the paragraph starting at a 1-based line, up to the blank line', () => {
    const r = paragraphRange(DOC, 6, 'First line of para one, second line of para one.')!;
    expect(DOC.slice(r.from, r.to)).toBe('First line of para one,\nsecond line of para one.');
  });
  it('stops at a heading, not only at a blank line', () => {
    const r = paragraphRange(DOC, 9, 'Para two has a link. list item')!;
    expect(DOC.slice(r.from, r.to)).toBe('**Para two** has [a link](http://x).\n- list item');
  });
  it('runs to the end of the file', () => {
    const r = paragraphRange(DOC, 13, 'Para three.')!;
    expect(DOC.slice(r.from, r.to)).toBe('Para three.');
  });
  it('finds the paragraph by its words when the file moved since the corpus was built', () => {
    const moved = 'new line\n\n' + DOC;
    const r = paragraphRange(moved, 13, 'Para three.')!;
    expect(moved.slice(r.from, r.to)).toBe('Para three.');
  });
  it('gives null rather than a wrong range when the words are gone', () => {
    expect(paragraphRange(DOC, 6, 'Something else entirely.')).toBeNull();
  });
});
