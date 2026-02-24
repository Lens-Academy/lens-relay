import { describe, it, expect } from 'vitest';
import { fuzzyMatch } from './fuzzy-match';

describe('fuzzyMatch', () => {
  it('returns no match when query chars are not in target in order', () => {
    const result = fuzzyMatch('zxy', 'hello world');
    expect(result.match).toBe(false);
    expect(result.score).toBe(0);
    expect(result.ranges).toEqual([]);
  });

  it('matches exact substring', () => {
    const result = fuzzyMatch('hello', 'hello world');
    expect(result.match).toBe(true);
    expect(result.score).toBeGreaterThan(0);
    expect(result.ranges).toEqual([[0, 5]]);
  });

  it('matches scattered characters in order', () => {
    const result = fuzzyMatch('hlo', 'hello');
    expect(result.match).toBe(true);
    expect(result.ranges.length).toBeGreaterThan(0);
  });

  it('is case-insensitive', () => {
    const result = fuzzyMatch('HeLLo', 'hello world');
    expect(result.match).toBe(true);
  });

  it('scores contiguous matches higher than scattered', () => {
    const contiguous = fuzzyMatch('hell', 'hello');
    const scattered = fuzzyMatch('helo', 'help docs');
    expect(contiguous.score).toBeGreaterThan(scattered.score);
  });

  it('scores word-boundary matches higher', () => {
    const boundary = fuzzyMatch('tw', 'tree-walker');
    const mid = fuzzyMatch('tw', 'between');
    expect(boundary.score).toBeGreaterThan(mid.score);
  });

  it('scores shorter targets higher for same match quality', () => {
    const short = fuzzyMatch('abc', 'abc');
    const long = fuzzyMatch('abc', 'abc-something-very-long');
    expect(short.score).toBeGreaterThan(long.score);
  });

  it('returns correct ranges for highlighting', () => {
    const result = fuzzyMatch('ac', 'abcd');
    expect(result.match).toBe(true);
    expect(result.ranges).toEqual([[0, 1], [2, 3]]);
  });

  it('handles empty query', () => {
    const result = fuzzyMatch('', 'hello');
    expect(result.match).toBe(true);
    expect(result.score).toBe(0);
    expect(result.ranges).toEqual([]);
  });

  it('handles empty target', () => {
    const result = fuzzyMatch('a', '');
    expect(result.match).toBe(false);
  });

  it('matches space in query against / in target (path-aware)', () => {
    const result = fuzzyMatch('resources links', 'Relay Folder 2/Resources/Links');
    expect(result.match).toBe(true);
    expect(result.score).toBeGreaterThan(0);
  });
});
