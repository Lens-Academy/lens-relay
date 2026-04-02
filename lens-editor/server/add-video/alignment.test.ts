import { describe, it, expect } from 'vitest';
import { alignWords, normalize } from './alignment';
import type { TimestampedWord } from './types';

describe('normalize', () => {
  it('lowercases and strips punctuation', () => {
    expect(normalize('Hello!')).toBe('hello');
    expect(normalize("don't")).toBe('dont');
    expect(normalize('ChatGPT')).toBe('chatgpt');
    expect(normalize('word')).toBe('word');
  });
});

describe('alignWords', () => {
  it('preserves timestamps for unchanged words', () => {
    const original: TimestampedWord[] = [
      { text: 'hello', start: 0.0 },
      { text: 'world', start: 1.0 },
    ];
    const corrected = ['hello', 'world'];

    const result = alignWords(original, corrected);
    expect(result).toEqual([
      { text: 'hello', start: 0.0 },
      { text: 'world', start: 1.0 },
    ]);
  });

  it('uses original timestamp for replaced words', () => {
    const original: TimestampedWord[] = [
      { text: 'chaty', start: 0.1 },
      { text: 'is', start: 0.5 },
    ];
    const corrected = ['ChatGPT', 'is'];

    const result = alignWords(original, corrected);
    expect(result[0].text).toBe('ChatGPT');
    expect(result[0].start).toBe(0.1);
    expect(result[1].text).toBe('is');
    expect(result[1].start).toBe(0.5);
  });

  it('interpolates timestamps for inserted words', () => {
    const original: TimestampedWord[] = [
      { text: 'hello', start: 0.0 },
      { text: 'world', start: 2.0 },
    ];
    // Insert "beautiful" between hello and world
    const corrected = ['hello', 'beautiful', 'world'];

    const result = alignWords(original, corrected);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ text: 'hello', start: 0.0 });
    expect(result[1].text).toBe('beautiful');
    expect(result[1].start).toBeGreaterThan(0.0);
    expect(result[1].start).toBeLessThan(2.0);
    expect(result[2]).toEqual({ text: 'world', start: 2.0 });
  });

  it('skips deleted words', () => {
    const original: TimestampedWord[] = [
      { text: 'um', start: 0.0 },
      { text: 'hello', start: 0.5 },
      { text: 'world', start: 1.0 },
    ];
    const corrected = ['hello', 'world'];

    const result = alignWords(original, corrected);
    expect(result).toEqual([
      { text: 'hello', start: 0.5 },
      { text: 'world', start: 1.0 },
    ]);
  });

  it('handles replacement with different word count', () => {
    const original: TimestampedWord[] = [
      { text: 'deep', start: 0.0 },
      { text: 'earning', start: 0.5 },
      { text: 'is', start: 1.0 },
    ];
    // "deep earning" corrected to "deep learning"
    const corrected = ['deep', 'learning', 'is'];

    const result = alignWords(original, corrected);
    expect(result).toHaveLength(3);
    expect(result[0].text).toBe('deep');
    expect(result[1].text).toBe('learning');
    expect(result[2].text).toBe('is');
  });
});
