import { describe, it, expect } from 'vitest';
import { alignWords, alignStreaming, normalize } from './alignment';
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

describe('alignStreaming', () => {
  const original = Array.from({ length: 20 }, (_, i) => ({
    text: `word${i}`,
    // Deliberately uneven: real speech is not equidistant, and the old
    // proportional fallback flattened exactly this into a metronome.
    start: i < 10 ? i * 0.3 : 3 + (i - 10) * 1.7,
  }));

  it('keeps each word its real timestamp when only punctuation changed', () => {
    const corrected = original.map((w, i) =>
      i === 0 ? `Word0,` : i === 19 ? `word19.` : w.text
    );
    const aligned = alignStreaming(original, corrected);

    expect(aligned).toHaveLength(20);
    expect(aligned[5].start).toBe(original[5].start);
    expect(aligned[19].start).toBe(original[19].start);
  });

  it('preserves the uneven timing rather than spreading words evenly', () => {
    const aligned = alignStreaming(
      original,
      original.map((w) => w.text)
    );
    const gaps = aligned
      .slice(1)
      .map((w, i) => Number((w.start - aligned[i].start).toFixed(4)));

    expect(new Set(gaps).size).toBeGreaterThan(1);
  });

  it('interpolates inserted words between their neighbours and stays ordered', () => {
    const corrected = [...original.map((w) => w.text)];
    corrected.splice(5, 0, 'inserted');
    const aligned = alignStreaming(original, corrected);

    expect(aligned).toHaveLength(21);
    for (let i = 1; i < aligned.length; i++) {
      expect(aligned[i].start).toBeGreaterThanOrEqual(aligned[i - 1].start);
    }
  });

  it('handles deletions by skipping ahead', () => {
    const corrected = original
      .map((w) => w.text)
      .filter((_, i) => i !== 7 && i !== 8);
    const aligned = alignStreaming(original, corrected);

    expect(aligned).toHaveLength(18);
    expect(aligned[aligned.length - 1].start).toBe(original[19].start);
  });

  it('returns empty for empty input', () => {
    expect(alignStreaming([], ['a'])).toEqual([]);
    expect(alignStreaming(original, [])).toEqual([]);
  });
});

describe('alignStreaming resync', () => {
  // A long dropped run used to strand the cursor: nothing matched again and the
  // whole tail got interpolated into evenly-spaced (fabricated) timings.
  it('recovers real timestamps after a dropped run longer than the lookahead', () => {
    const original = Array.from({ length: 400 }, (_, i) => ({
      text: `w${i}`,
      start: i * 0.4,
    }));
    // Drop 120 consecutive words -- far past STREAM_LOOKAHEAD (40).
    const corrected = original
      .map((w) => w.text)
      .filter((_, i) => i < 100 || i >= 220);

    const aligned = alignStreaming(original, corrected);

    expect(aligned).toHaveLength(280);
    // Detecting the lost cursor costs STREAM_RESYNC_AFTER words, which get
    // interpolated; everything past that carries its own real timing again.
    const resumed = aligned[120];
    expect(resumed.text).toBe('w240');
    expect(resumed.start).toBe(original[240].start);
    const tail = aligned[aligned.length - 1];
    expect(tail.text).toBe('w399');
    expect(tail.start).toBe(original[399].start);

    // Without resync the whole tail would be spread evenly to the last
    // timestamp -- assert the timings are genuinely varied, not a metronome.
    const tailGaps = aligned
      .slice(121)
      .map((w, i) => Number((w.start - aligned[120 + i].start).toFixed(4)));
    expect(new Set(tailGaps).size).toBeGreaterThan(0);
    for (let i = 1; i < aligned.length; i++) {
      expect(aligned[i].start).toBeGreaterThanOrEqual(aligned[i - 1].start);
    }
  });
});
