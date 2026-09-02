import fuzzysort from 'fuzzysort';

export interface FuzzyMatchResult {
  match: boolean;
  score: number;
  /** Matched character ranges as [start, end) pairs for highlighting */
  ranges: [number, number][];
}

export interface FuzzySearchResult<T> {
  item: T;
  score: number;
  /** Matched character ranges as [start, end) pairs for highlighting */
  ranges: [number, number][];
}

export interface FuzzySearchOptions {
  /** Return at most this many results (best-scoring first). */
  limit?: number;
}

/** A pre-processed search target; build with {@link prepareFuzzyTarget}. */
export type FuzzyTarget = Fuzzysort.Prepared;

/**
 * Treat spaces and slashes as equivalent separators. Applied to both the
 * query and the target so "Lens/Browser" and "Lens Browser" match the same
 * paths.
 */
function normalizeSeparators(text: string): string {
  return text.replace(/\//g, ' ');
}

/** Convert fuzzysort's matched indexes into sorted [start, end) range pairs. */
function indexesToRanges(indexes: ReadonlyArray<number>): [number, number][] {
  const sorted = Array.from(indexes).sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  if (sorted.length === 0) return ranges;

  let rangeStart = sorted[0];
  let rangeEnd = sorted[0] + 1;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === rangeEnd) {
      rangeEnd++;
    } else {
      ranges.push([rangeStart, rangeEnd]);
      rangeStart = sorted[i];
      rangeEnd = sorted[i] + 1;
    }
  }
  ranges.push([rangeStart, rangeEnd]);
  return ranges;
}

/**
 * Pre-process a target string for repeated searching.
 *
 * Preparing once and reusing the result across queries avoids re-normalizing
 * and re-indexing every target on every keystroke. Applies the same
 * space/slash normalization as {@link fuzzyMatch}.
 */
export function prepareFuzzyTarget(target: string): FuzzyTarget {
  return fuzzysort.prepare(normalizeSeparators(target));
}

/**
 * Fuzzy-search a query against many items at once.
 *
 * `getTarget` returns each item's prepared target (see {@link prepareFuzzyTarget}).
 * Results are sorted best-first. With `limit`, only the top N are kept, which
 * makes the search and the subsequent render much cheaper on large folders.
 */
export function fuzzySearch<T>(
  query: string,
  items: ReadonlyArray<T>,
  getTarget: (item: T) => FuzzyTarget,
  options: FuzzySearchOptions = {}
): FuzzySearchResult<T>[] {
  if (query.length === 0) return [];

  const results = fuzzysort.go(normalizeSeparators(query), items, {
    key: getTarget as unknown as (item: T) => string,
    limit: options.limit,
  });

  return results.map(r => ({
    item: r.obj,
    score: r.score,
    ranges: indexesToRanges(r.indexes),
  }));
}

/**
 * Fuzzy-match a query against a target string.
 *
 * Spaces and slashes are treated as equivalent separators so that queries
 * match across path boundaries and within names containing spaces.
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

  const result = fuzzysort.single(normalizeSeparators(query), normalizeSeparators(target));

  if (result === null) {
    return { match: false, score: 0, ranges: [] };
  }

  return { match: true, score: result.score, ranges: indexesToRanges(result.indexes) };
}
