import { describe, it, expect } from 'vitest';
import {
  extractWords,
  isWordLevel,
  toPlainText,
  flattenToWords,
} from './transcript';
import type { TranscriptRaw } from './types';

const wordLevelTranscript: TranscriptRaw = {
  events: [
    {
      tStartMs: 80,
      dDurationMs: 3560,
      segs: [
        { utf8: 'the', acAsrConf: 0 },
        { utf8: ' stamp', tOffsetMs: 80, acAsrConf: 0 },
        { utf8: ' collecting', tOffsetMs: 360, acAsrConf: 0 },
      ],
    },
    // Newline event (no useful content)
    { tStartMs: 1470, dDurationMs: 2170, aAppend: 1, segs: [{ utf8: '\n' }] },
    {
      tStartMs: 1480,
      dDurationMs: 4640,
      segs: [
        { utf8: 'about', acAsrConf: 0 },
        { utf8: ' last', tOffsetMs: 280, acAsrConf: 0 },
      ],
    },
    // Event with no segs (should be skipped)
    { tStartMs: 5000, dDurationMs: 100 },
  ],
};

const sentenceLevelTranscript: TranscriptRaw = {
  events: [
    {
      tStartMs: 100,
      dDurationMs: 5000,
      segs: [{ utf8: 'The stamp collecting machine we talked about' }],
    },
    {
      tStartMs: 5100,
      dDurationMs: 4000,
      segs: [{ utf8: 'last time is a physical impossibility' }],
    },
  ],
};

describe('extractWords', () => {
  it('extracts word-level timestamps from json3 events', () => {
    const words = extractWords(wordLevelTranscript);
    expect(words).toEqual([
      { text: 'the', start: 0.08 },
      { text: 'stamp', start: 0.16 },
      { text: 'collecting', start: 0.44 },
      { text: 'about', start: 1.48 },
      { text: 'last', start: 1.76 },
    ]);
  });

  it('extracts sentence-level entries as single segments', () => {
    const words = extractWords(sentenceLevelTranscript);
    expect(words).toEqual([
      { text: 'The stamp collecting machine we talked about', start: 0.1 },
      { text: 'last time is a physical impossibility', start: 5.1 },
    ]);
  });

  it('skips newline-only and empty segments', () => {
    const words = extractWords(wordLevelTranscript);
    const texts = words.map((w) => w.text);
    expect(texts).not.toContain('\n');
    expect(texts).not.toContain('');
  });
});

describe('isWordLevel', () => {
  it('returns true for word-level transcripts', () => {
    const words = extractWords(wordLevelTranscript);
    expect(isWordLevel(words)).toBe(true);
  });

  it('returns false for sentence-level transcripts', () => {
    const words = extractWords(sentenceLevelTranscript);
    expect(isWordLevel(words)).toBe(false);
  });
});

describe('toPlainText', () => {
  it('joins word-level words into paragraphs split by timing gaps', () => {
    // Create transcript with a 3-second gap in the middle
    const raw: TranscriptRaw = {
      events: [
        {
          tStartMs: 0,
          dDurationMs: 1000,
          segs: [
            { utf8: 'hello' },
            { utf8: ' world', tOffsetMs: 500 },
          ],
        },
        {
          tStartMs: 5000,
          dDurationMs: 1000,
          segs: [
            { utf8: 'second' },
            { utf8: ' paragraph', tOffsetMs: 500 },
          ],
        },
      ],
    };
    const text = toPlainText(raw);
    expect(text).toBe('hello world\n\nsecond paragraph');
  });

  it('joins sentence-level entries into single block', () => {
    const text = toPlainText(sentenceLevelTranscript);
    expect(text).toBe(
      'The stamp collecting machine we talked about last time is a physical impossibility'
    );
  });
});

describe('flattenToWords', () => {
  it('splits multi-word entries into individual words with same timestamp', () => {
    const words = flattenToWords([
      { text: 'hello world', start: 0.5 },
      { text: 'goodbye', start: 2.0 },
    ]);
    expect(words).toEqual([
      { text: 'hello', start: 0.5 },
      { text: 'world', start: 0.5 },
      { text: 'goodbye', start: 2.0 },
    ]);
  });

  it('passes through single-word entries unchanged', () => {
    const words = flattenToWords([
      { text: 'hello', start: 0.0 },
      { text: 'world', start: 1.0 },
    ]);
    expect(words).toEqual([
      { text: 'hello', start: 0.0 },
      { text: 'world', start: 1.0 },
    ]);
  });
});
