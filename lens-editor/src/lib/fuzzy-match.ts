import fuzzysort from 'fuzzysort';

export interface FuzzyMatchResult {
  match: boolean;
  score: number;
  /** Matched character ranges as [start, end) pairs for highlighting */
  ranges: [number, number][];
}

/**
 * Fuzzy-match a query against a target string.
 *
 * Spaces in the query are treated as `/` for path-aware matching.
 * Case-insensitive. Returns match status, a score for ranking, and character
 * ranges for highlight rendering.
 *
 * Uses fuzzysort for optimal match positioning and scoring.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatchResult {
  if (query.length === 0) {
    return { match: true, score: 0, ranges: [] };
  }
  if (target.length === 0) {
    return { match: false, score: 0, ranges: [] };
  }

  // Replace spaces with / for path-aware matching
  const normalizedQuery = query.replace(/ /g, '/');

  const result = fuzzysort.single(normalizedQuery, target);
  if (result === null) {
    return { match: false, score: 0, ranges: [] };
  }

  // Convert indexes array to [start, end) range pairs
  const indexes = Array.from(result.indexes).sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  if (indexes.length > 0) {
    let rangeStart = indexes[0];
    let rangeEnd = indexes[0] + 1;
    for (let i = 1; i < indexes.length; i++) {
      if (indexes[i] === rangeEnd) {
        rangeEnd++;
      } else {
        ranges.push([rangeStart, rangeEnd]);
        rangeStart = indexes[i];
        rangeEnd = indexes[i] + 1;
      }
    }
    ranges.push([rangeStart, rangeEnd]);
  }

  return { match: true, score: result.score, ranges };
}
