import { describe, it, expect, beforeEach } from 'vitest';
import {
  matchSource,
  sliceSpans,
  placeSpans,
  rememberCopied,
  recallCopied,
  forgetCopied,
  normalizeLineBreaks,
} from './carried-authorship';

const luc = { actor: 'human:Luc', at: 1 };
const ai = { actor: 'ai:unknown:Luc', at: 2 };

describe('matchSource', () => {
  it('ignores line breaks at the ends (a moved line)', () => {
    expect(matchSource('line3\n', '\nline3')).toEqual({ insertedFrom: 0, sourceFrom: 1, length: 5 });
  });

  it('finds the source inside a wrapped insert', () => {
    expect(matchSource('{++x@@line++}', 'line')).toEqual({ insertedFrom: 6, sourceFrom: 0, length: 4 });
  });

  it('returns null without overlap', () => {
    expect(matchSource('abc', 'xyz')).toBeNull();
    expect(matchSource('\n', '\n')).toBeNull();
  });
});

describe('spans', () => {
  const spans = [
    { length: 3, author: luc },
    { length: 1, author: null },
    { length: 4, author: ai },
  ];

  it('slices across spans', () => {
    expect(sliceSpans(spans, 2, 4)).toEqual([
      { length: 1, author: luc },
      { length: 1, author: null },
      { length: 2, author: ai },
    ]);
  });

  it('places carried spans only', () => {
    expect(placeSpans(spans, 10)).toEqual([
      { from: 10, to: 13, author: luc },
      { from: 14, to: 18, author: ai },
    ]);
  });
});

describe('the remembered copy', () => {
  beforeEach(() => forgetCopied());

  it('recalls the authors of exactly the copied text, without its client IDs', () => {
    rememberCopied({ text: 'abc', spans: [{ length: 3, author: { ...luc, client: 7 } }] });
    expect(recallCopied('abc')).toEqual([{ length: 3, author: luc }]);
    expect(recallCopied('abd')).toBeNull();
    expect(recallCopied('abcd')).toBeNull();
  });

  it('keeps no copied text in storage', () => {
    rememberCopied({ text: 'secret words', spans: [{ length: 12, author: luc }] });
    expect(JSON.stringify(localStorage)).not.toContain('secret');
  });

  it('only the last copy counts', () => {
    rememberCopied({ text: 'one', spans: [{ length: 3, author: luc }] });
    rememberCopied({ text: 'two', spans: [{ length: 3, author: ai }] });
    expect(recallCopied('one')).toBeNull();
    expect(recallCopied('two')).toEqual([{ length: 3, author: ai }]);
  });

  it('normalizes Windows line breaks', () => {
    expect(normalizeLineBreaks('a\r\nb\rc')).toBe('a\nb\nc');
  });
});
