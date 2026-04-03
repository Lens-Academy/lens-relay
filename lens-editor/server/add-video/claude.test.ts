import { describe, it, expect } from 'vitest';
import { buildClaudeArgs, buildPrompt, splitIntoChunks } from './claude';

describe('buildPrompt', () => {
  it('includes the raw text file path and formatting instructions', () => {
    const prompt = buildPrompt('/tmp/transcripts/abc123');
    expect(prompt).toContain('/tmp/transcripts/abc123/raw.txt');
    expect(prompt).toContain('corrected.txt');
    expect(prompt).toContain('punctuation');
    expect(prompt).toContain('Capitalization');
  });
});

describe('buildClaudeArgs', () => {
  it('returns correct CLI arguments', () => {
    const args = buildClaudeArgs('/tmp/transcripts/abc123');
    expect(args).not.toContain('--bare');
    expect(args).toContain('-p');
    expect(args).toContain('--allowedTools');
    expect(args.join(' ')).toContain('Read');
    expect(args.join(' ')).toContain('Write');
    expect(args.join(' ')).toContain('--max-turns');
    expect(args.join(' ')).toContain('--model');
    expect(args).toContain('sonnet');
  });
});

describe('splitIntoChunks', () => {
  it('returns single chunk for short text', () => {
    const text = 'Hello world. This is short.';
    const chunks = splitIntoChunks(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it('splits at paragraph boundaries', () => {
    // Create text with paragraphs that exceed chunk threshold
    const para = Array(1000).fill('word').join(' '); // ~1000 words
    const text = Array(8).fill(para).join('\n\n'); // 8 paragraphs, ~8000 words
    const chunks = splitIntoChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should end with complete paragraphs
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/^\n/);
      expect(chunk).not.toMatch(/\n$/);
    }
  });

  it('never splits mid-paragraph', () => {
    const shortPara = 'Short paragraph here.';
    const longPara = Array(6000).fill('word').join(' '); // 6000 words - over target
    const text = shortPara + '\n\n' + longPara;
    const chunks = splitIntoChunks(text);
    // The long paragraph stays together even though it exceeds the target
    expect(chunks.some((c) => c.includes(longPara))).toBe(true);
  });
});
