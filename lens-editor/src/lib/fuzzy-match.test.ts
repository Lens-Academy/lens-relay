import { describe, it, expect } from 'vitest';
import { fuzzyMatch, fuzzySearch, prepareFuzzyTarget } from './fuzzy-match';

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

  it('treats a slash in the query like a space', () => {
    const withSlash = fuzzyMatch('Lens/Browser', 'Lens/Browser Screenshot Editing');
    const withSpace = fuzzyMatch('Lens Browser', 'Lens/Browser Screenshot Editing');
    expect(withSlash.match).toBe(true);
    expect(withSlash.ranges).toEqual(withSpace.ranges);
    expect(withSlash.score).toBe(withSpace.score);
  });

  it('matches a query ending in a slash', () => {
    expect(fuzzyMatch('Lens/', 'Lens/Browser Screenshot Editing').match).toBe(true);
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
    // fuzzysort may find optimal positions; just verify ranges are valid
    expect(result.ranges.length).toBeGreaterThan(0);
    for (const [start, end] of result.ranges) {
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      expect(end).toBeLessThanOrEqual(4);
    }
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

  it('matches spaces in query against spaces in target (filename with spaces)', () => {
    const result = fuzzyMatch('Chat Panel', 'Lens/AI Chat Panel');
    expect(result.match).toBe(true);
    expect(result.score).toBeGreaterThan(0);
  });

  it('matches spaces in filenames across path segments', () => {
    const result = fuzzyMatch('Getting Started', 'Lens Edu/Modules/Module_x/Getting Started');
    expect(result.match).toBe(true);
    expect(result.score).toBeGreaterThan(0);
  });

  it('ranks substring match above scattered character match for "demo"', () => {
    const substringMatch = fuzzyMatch('demo', 'Detailed Demo Notes.md');
    const scatteredMatch = fuzzyMatch('demo', 'Docs/Early/Methods/Outline.md');
    expect(substringMatch.score).toBeGreaterThan(scatteredMatch.score);
  });
});

describe('fuzzySearch', () => {
  const items = [
    { id: 'a', path: 'Lens/Introduction' },
    { id: 'b', path: 'Lens/Getting Started' },
    { id: 'c', path: 'Lens Edu/Course Notes' },
    { id: 'd', path: 'Lens/Projects/Alpha' },
  ].map(item => ({ ...item, target: prepareFuzzyTarget(item.path) }));

  it('returns nothing for an empty query', () => {
    expect(fuzzySearch('', items, i => i.target)).toEqual([]);
  });

  it('returns only matching items, best-first, with highlight ranges', () => {
    const results = fuzzySearch('intro', items, i => i.target);
    expect(results.map(r => r.item.id)).toEqual(['a']);
    expect(results[0].ranges).toEqual([[5, 10]]);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('matches across path boundaries like fuzzyMatch', () => {
    const batch = fuzzySearch('lens alpha', items, i => i.target);
    expect(batch.map(r => r.item.id)).toEqual(['d']);
    const single = fuzzyMatch('lens alpha', 'Lens/Projects/Alpha');
    expect(batch[0].ranges).toEqual(single.ranges);
  });

  it('agrees with fuzzyMatch on ordering', () => {
    const batch = fuzzySearch('lens', items, i => i.target);
    const expected = items
      .map(i => ({ id: i.id, score: fuzzyMatch('lens', i.path).score }))
      .sort((x, y) => y.score - x.score)
      .map(x => x.id);
    expect(batch.map(r => r.item.id)).toEqual(expected);
  });

  it('accepts slashes in the query as separators', () => {
    const slash = fuzzySearch('lens/alpha', items, i => i.target);
    const space = fuzzySearch('lens alpha', items, i => i.target);
    expect(slash.map(r => r.item.id)).toEqual(['d']);
    expect(slash[0].ranges).toEqual(space[0].ranges);
    expect(fuzzySearch('lens/', items, i => i.target).length).toBe(items.length);
  });

  it('caps results at limit while keeping the best matches', () => {
    const all = fuzzySearch('lens', items, i => i.target);
    expect(all.length).toBeGreaterThan(2);
    const limited = fuzzySearch('lens', items, i => i.target, { limit: 2 });
    expect(limited.map(r => r.item.id)).toEqual(all.slice(0, 2).map(r => r.item.id));
  });
});
