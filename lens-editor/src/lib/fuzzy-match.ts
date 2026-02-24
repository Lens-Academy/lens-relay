export interface FuzzyMatchResult {
  match: boolean;
  score: number;
  /** Matched character ranges as [start, end) pairs for highlighting */
  ranges: [number, number][];
}

/**
 * Fuzzy-match a query against a target string.
 *
 * Characters in query must appear in target in order (not necessarily contiguous).
 * Case-insensitive. Returns match status, a score for ranking, and character
 * ranges for highlight rendering.
 *
 * Scoring favors: contiguous runs, word-boundary matches, shorter targets.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatchResult {
  if (query.length === 0) {
    return { match: true, score: 0, ranges: [] };
  }
  if (target.length === 0) {
    return { match: false, score: 0, ranges: [] };
  }

  const lowerQuery = query.toLowerCase();
  const lowerTarget = target.toLowerCase();

  // Match characters in order, collecting indices
  const indices: number[] = [];
  let qi = 0;
  for (let ti = 0; ti < lowerTarget.length && qi < lowerQuery.length; ti++) {
    if (lowerTarget[ti] === lowerQuery[qi] || (lowerQuery[qi] === ' ' && lowerTarget[ti] === '/')) {
      indices.push(ti);
      qi++;
    }
  }

  if (qi < lowerQuery.length) {
    return { match: false, score: 0, ranges: [] };
  }

  // Build ranges from indices (merge contiguous)
  const ranges: [number, number][] = [];
  let rangeStart = indices[0];
  let rangeEnd = indices[0] + 1;
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] === rangeEnd) {
      rangeEnd++;
    } else {
      ranges.push([rangeStart, rangeEnd]);
      rangeStart = indices[i];
      rangeEnd = indices[i] + 1;
    }
  }
  ranges.push([rangeStart, rangeEnd]);

  // Score: base + contiguity bonus + word-boundary bonus + length penalty
  let score = 0;

  // Contiguity: count pairs of consecutive indices
  let contiguous = 0;
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] === indices[i - 1] + 1) contiguous++;
  }
  score += contiguous * 10;

  // Word-boundary bonus: character is at position 0 or preceded by non-alphanumeric
  for (const idx of indices) {
    if (idx === 0 || /[^a-zA-Z0-9]/.test(target[idx - 1])) {
      score += 15;
    }
  }

  // Exact prefix bonus
  if (indices[0] === 0 && contiguous === indices.length - 1) {
    score += 20;
  }

  // Shorter targets score higher (normalize: 100 / target.length)
  score += 100 / target.length;

  return { match: true, score, ranges };
}
