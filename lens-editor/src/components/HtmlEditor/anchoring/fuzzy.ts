/**
 * Approximate substring search (Sellers' algorithm: edit distance where the
 * match may start anywhere in the text). Used when a quote no longer appears
 * verbatim: a typo fixed, a word changed, punctuation edited.
 *
 * O(pattern × window); callers cap patterns at FUZZY_MAX_PATTERN characters
 * and search near the expected position first.
 */

export const FUZZY_MAX_PATTERN = 64;

export interface FuzzyMatch {
  start: number;
  end: number;
  errors: number;
}

export interface FuzzyOptions {
  from?: number;
  to?: number;
  /** Preferred match start; breaks ties between equally good matches. */
  expected?: number;
}

export function fuzzyFind(text: string, pattern: string, maxErrors: number, options: FuzzyOptions = {}): FuzzyMatch | null {
  const m = pattern.length;
  if (m === 0) return null;
  const hay = text.toLowerCase();
  const pat = pattern.toLowerCase();
  const from = Math.max(0, options.from ?? 0);
  const to = Math.min(hay.length, options.to ?? hay.length);
  if (to - from < m - maxErrors) return null;

  let prev = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  for (let i = 0; i <= m; i++) prev[i] = i;

  let bestEnd = -1;
  let bestErrors = maxErrors + 1;
  let bestDistance = Infinity;
  const expected = options.expected;

  for (let j = from; j < to; j++) {
    cur[0] = 0;
    const c = hay.charCodeAt(j);
    for (let i = 1; i <= m; i++) {
      const sub = prev[i - 1] + (pat.charCodeAt(i - 1) === c ? 0 : 1);
      const del = prev[i] + 1;
      const ins = cur[i - 1] + 1;
      cur[i] = sub < del ? (sub < ins ? sub : ins) : (del < ins ? del : ins);
    }
    const errors = cur[m];
    if (errors <= maxErrors) {
      const end = j + 1;
      const distance = expected === undefined ? 0 : Math.abs(end - m - expected);
      if (errors < bestErrors || (errors === bestErrors && distance < bestDistance)) {
        bestErrors = errors;
        bestEnd = end;
        bestDistance = distance;
      }
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  if (bestEnd < 0) return null;
  const start = matchStart(hay, pat, bestEnd, maxErrors);
  return { ...snapToWords(text, pattern, start, bestEnd), errors: bestErrors };
}

const WORD = /[\p{L}\p{N}_]/u;
const MAX_SNAP = 4;

/** Equally good alignments can stop mid-word ("dolor sit am" for "dolar sit
 *  amt"); when the pattern starts/ends on a word character, grow the match to
 *  the word's edge (a few characters at most). */
function snapToWords(text: string, pattern: string, start: number, end: number): { start: number; end: number } {
  if (WORD.test(pattern[pattern.length - 1] ?? '')) {
    let n = 0;
    while (n < MAX_SNAP && end < text.length && WORD.test(text[end]) && WORD.test(text[end - 1] ?? '')) { end++; n++; }
  }
  if (WORD.test(pattern[0] ?? '')) {
    let n = 0;
    while (n < MAX_SNAP && start > 0 && WORD.test(text[start - 1]) && WORD.test(text[start] ?? '')) { start--; n++; }
  }
  return { start, end };
}

/** Where the best alignment of `pat` ending at `end` starts: edit distance of
 *  the reversed pattern against the text read backwards from `end`. */
function matchStart(hay: string, pat: string, end: number, maxErrors: number): number {
  const m = pat.length;
  const span = Math.min(end, m + maxErrors);
  let prev = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  for (let i = 0; i <= m; i++) prev[i] = i;
  let bestLen = m;
  let bestErrors = prev[m];
  for (let j = 1; j <= span; j++) {
    cur[0] = j;
    const c = hay.charCodeAt(end - j);
    for (let i = 1; i <= m; i++) {
      const sub = prev[i - 1] + (pat.charCodeAt(m - i) === c ? 0 : 1);
      const del = prev[i] + 1;
      const ins = cur[i - 1] + 1;
      cur[i] = sub < del ? (sub < ins ? sub : ins) : (del < ins ? del : ins);
    }
    if (cur[m] < bestErrors || (cur[m] === bestErrors && Math.abs(j - m) < Math.abs(bestLen - m))) {
      bestErrors = cur[m];
      bestLen = j;
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return end - bestLen;
}

/** Similarity of two strings in [0, 1] (1 - normalized edit distance),
 *  for scoring how much of a quote's context survived. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;
  let prev = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    const c = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const sub = prev[j - 1] + (b.charCodeAt(j - 1) === c ? 0 : 1);
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      cur[j] = sub < del ? (sub < ins ? sub : ins) : (del < ins ? del : ins);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return 1 - prev[m] / Math.max(n, m);
}
