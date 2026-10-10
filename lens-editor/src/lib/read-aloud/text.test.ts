import { describe, expect, it } from 'vitest';
import { findActiveWord, findSpokenWord, prepareTtsText, splitSentences } from './text';

const split = (s: string) => splitSentences(s).map(r => s.slice(r.start, r.end));

describe('splitSentences', () => {
  it('splits on terminal punctuation and on block separators', () => {
    expect(split('One two. Three? Four!\nA heading\nLast "quoted." End')).toEqual([
      'One two.', 'Three?', 'Four!', 'A heading', 'Last "quoted."', 'End',
    ]);
  });

  it('keeps abbreviations, initials and list ordinals together', () => {
    expect(split('Mr. Lee met I. J. Good in the U.S. last year.\n1. First step.')).toEqual([
      'Mr. Lee met I. J. Good in the U.S. last year.',
      '1. First step.',
    ]);
  });

  it('drops pieces without letters or digits', () => {
    expect(split('Hello.\n  \n...\n')).toEqual(['Hello.']);
  });
});

describe('prepareTtsText', () => {
  it('dots acronyms the voice would otherwise misread', () => {
    expect(prepareTtsText('ASI and xAI, but not AI or LLMs')).toBe('A.S.I. and x.A.I., but not AI or LLMs');
  });
});

describe('findSpokenWord', () => {
  it('finds tokens forward from the cursor, ignoring case on a second try', () => {
    expect(findSpokenWord('The cat and the dog', 4, 'the')).toEqual({ start: 12, end: 15 });
    expect(findSpokenWord('The cat', 0, 'the')).toEqual({ start: 0, end: 3 });
    expect(findSpokenWord('In 2020 it rained', 3, 'twenty')).toBeNull();
    expect(findSpokenWord('Hi.', 0, '.')).toBeNull();
  });
});

describe('findActiveWord', () => {
  it('returns the last word started by the given time', () => {
    expect(findActiveWord([0, 0.5, 1], 0.7)).toBe(1);
    expect(findActiveWord([0.2, 0.5], 0.1)).toBe(-1);
    expect(findActiveWord([], 3)).toBe(-1);
  });
});
