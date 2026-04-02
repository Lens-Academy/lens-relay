import { describe, it, expect } from 'vitest';
import {
  formatTimestamp,
  generateTimestampsJson,
  generateMarkdown,
  generateFilenameBase,
} from './export';
import type { TimestampedWord } from './types';

describe('formatTimestamp', () => {
  it('formats seconds to M:SS.mm', () => {
    expect(formatTimestamp(0.08)).toBe('0:00.08');
    expect(formatTimestamp(63.5)).toBe('1:03.50');
    expect(formatTimestamp(123.456)).toBe('2:03.46');
    expect(formatTimestamp(0)).toBe('0:00.00');
  });
});

describe('generateTimestampsJson', () => {
  it('converts timestamped words to formatted entries', () => {
    const words: TimestampedWord[] = [
      { text: 'Hello', start: 0.08 },
      { text: 'world', start: 1.5 },
    ];
    const result = generateTimestampsJson(words);
    expect(result).toEqual([
      { text: 'Hello', start: '0:00.08' },
      { text: 'world', start: '0:01.50' },
    ]);
  });
});

describe('generateMarkdown', () => {
  it('generates markdown with YAML frontmatter', () => {
    const md = generateMarkdown({
      title: 'AI Self Improvement - Computerphile',
      channel: 'Computerphile',
      url: 'https://www.youtube.com/watch?v=5qfIgCiYlfY',
      video_id: '5qfIgCiYlfY',
      body: 'First paragraph.\n\nSecond paragraph.',
    });
    expect(md).toBe(
      '---\n' +
        'title: "AI Self Improvement - Computerphile"\n' +
        'channel: "Computerphile"\n' +
        'url: "https://www.youtube.com/watch?v=5qfIgCiYlfY"\n' +
        'video_id: "5qfIgCiYlfY"\n' +
        '---\n' +
        '\n' +
        'First paragraph.\n' +
        '\n' +
        'Second paragraph.\n'
    );
  });
});

describe('generateFilenameBase', () => {
  it('generates lowercase hyphenated filename', () => {
    expect(
      generateFilenameBase('Computerphile', 'AI Self Improvement - Computerphile')
    ).toBe('computerphile-ai-self-improvement');
  });

  it('strips special characters', () => {
    expect(
      generateFilenameBase('Channel', "What's the Deal? (Part 1)")
    ).toBe('channel-whats-the-deal-part-1');
  });

  it('removes channel name suffix from title', () => {
    expect(
      generateFilenameBase('Computerphile', 'AI Safety - Computerphile')
    ).toBe('computerphile-ai-safety');
  });
});
