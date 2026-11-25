import { describe, expect, it } from 'vitest';
import { countSelections, countText, formatSelectionCount } from './selection-count';

describe('countText', () => {
  it('counts words and characters', () => {
    expect(countText('Hello world')).toEqual({ words: 2, characters: 11 });
  });

  it('ignores punctuation and markdown marks as words', () => {
    expect(countText('- **Bold** text — and _more_!')).toEqual({ words: 4, characters: 29 });
  });

  it('keeps contractions and hyphenated words whole', () => {
    expect(countText("don't re-read it")).toEqual({ words: 3, characters: 16 });
  });

  it('counts line breaks as characters', () => {
    expect(countText('one\ntwo')).toEqual({ words: 2, characters: 7 });
  });

  it('counts an emoji as one character', () => {
    expect(countText('hi 👋')).toEqual({ words: 1, characters: 4 });
  });

  it('handles accented and non-Latin words', () => {
    expect(countText('café naïve Привет')).toEqual({ words: 3, characters: 17 });
  });

  it('leaves out suggestion metadata, delimiters and comment threads', () => {
    const text = 'it should {--{"author":"Bob","timestamp":1794386605751}@@definitely --}go{>>{"author":"Ann"}@@why?<<}';
    expect(countText(text)).toEqual(countText('it should definitely go'));
    expect(countText('{~~old~>new~~} {==mark==}')).toEqual(countText('oldnew mark'));
  });

  it('is zero for whitespace only', () => {
    expect(countText('  \n ')).toEqual({ words: 0, characters: 4 });
  });
});

describe('countSelections', () => {
  it('sums several ranges', () => {
    expect(countSelections(['one two', 'three'])).toEqual({ words: 3, characters: 12 });
  });
});

describe('formatSelectionCount', () => {
  it('uses singular and plural', () => {
    expect(formatSelectionCount({ words: 1, characters: 1 })).toBe('1 word · 1 character');
    expect(formatSelectionCount({ words: 1234, characters: 5678 })).toBe('1,234 words · 5,678 characters');
  });
});
