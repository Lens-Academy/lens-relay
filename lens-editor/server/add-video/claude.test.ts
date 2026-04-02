import { describe, it, expect } from 'vitest';
import { buildClaudeArgs, buildPrompt } from './claude';

describe('buildPrompt', () => {
  it('includes the raw text file path and formatting instructions', () => {
    const prompt = buildPrompt('/tmp/transcripts/abc123');
    expect(prompt).toContain('/tmp/transcripts/abc123/raw.txt');
    expect(prompt).toContain('corrected.txt');
    expect(prompt).toContain('punctuation');
    expect(prompt).toContain('capitalization');
  });
});

describe('buildClaudeArgs', () => {
  it('returns correct CLI arguments', () => {
    const args = buildClaudeArgs('/tmp/transcripts/abc123');
    expect(args).toContain('--bare');
    expect(args).toContain('-p');
    expect(args).toContain('--allowedTools');
    expect(args.join(' ')).toContain('Read');
    expect(args.join(' ')).toContain('Write');
    expect(args.join(' ')).toContain('--max-turns');
    expect(args.join(' ')).toContain('--max-budget-usd');
  });
});
