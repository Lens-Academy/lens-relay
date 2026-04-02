import type { TimestampedWord } from './types';

/** Normalize a word for comparison: lowercase, strip non-alphanumeric */
export function normalize(word: string): string {
  return word.replace(/[^\w]/g, '').toLowerCase();
}

interface DiffOp {
  op: 'equal' | 'replace' | 'insert' | 'delete';
  origStart: number;
  origEnd: number;
  corrStart: number;
  corrEnd: number;
}

/**
 * Compute edit operations between two string arrays using LCS.
 * Returns operations similar to Python's SequenceMatcher.get_opcodes().
 */
function getOpcodes(a: string[], b: string[]): DiffOp[] {
  const m = a.length;
  const n = b.length;

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find matching pairs
  const matches: [number, number][] = [];
  let i = m,
    j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      matches.unshift([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  // Convert matches to opcodes
  const ops: DiffOp[] = [];
  let ai = 0,
    bj = 0;

  for (const [mi, mj] of matches) {
    if (ai < mi || bj < mj) {
      if (ai < mi && bj < mj) {
        ops.push({
          op: 'replace',
          origStart: ai,
          origEnd: mi,
          corrStart: bj,
          corrEnd: mj,
        });
      } else if (ai < mi) {
        ops.push({
          op: 'delete',
          origStart: ai,
          origEnd: mi,
          corrStart: bj,
          corrEnd: bj,
        });
      } else {
        ops.push({
          op: 'insert',
          origStart: ai,
          origEnd: ai,
          corrStart: bj,
          corrEnd: mj,
        });
      }
    }
    ops.push({
      op: 'equal',
      origStart: mi,
      origEnd: mi + 1,
      corrStart: mj,
      corrEnd: mj + 1,
    });
    ai = mi + 1;
    bj = mj + 1;
  }

  // Handle remaining after last match
  if (ai < m || bj < n) {
    if (ai < m && bj < n) {
      ops.push({
        op: 'replace',
        origStart: ai,
        origEnd: m,
        corrStart: bj,
        corrEnd: n,
      });
    } else if (ai < m) {
      ops.push({
        op: 'delete',
        origStart: ai,
        origEnd: m,
        corrStart: bj,
        corrEnd: bj,
      });
    } else {
      ops.push({
        op: 'insert',
        origStart: ai,
        origEnd: ai,
        corrStart: bj,
        corrEnd: n,
      });
    }
  }

  return ops;
}

/**
 * Align corrected words to original timestamps using diff-based matching.
 *
 * - Equal words: use corrected text with original timestamp
 * - Replaced words: pair up, use original timestamps
 * - Inserted words: interpolate timestamps between surrounding words
 * - Deleted words: skip
 */
export function alignWords(
  original: TimestampedWord[],
  corrected: string[]
): TimestampedWord[] {
  const origNorm = original.map((w) => normalize(w.text));
  const corrNorm = corrected.map((w) => normalize(w));

  const ops = getOpcodes(origNorm, corrNorm);
  const result: TimestampedWord[] = [];

  let lastOrigIdx = -1;

  for (const op of ops) {
    if (op.op === 'equal') {
      for (let k = 0; k < op.origEnd - op.origStart; k++) {
        result.push({
          text: corrected[op.corrStart + k],
          start: original[op.origStart + k].start,
        });
        lastOrigIdx = op.origStart + k;
      }
    } else if (op.op === 'replace') {
      const origCount = op.origEnd - op.origStart;
      const corrCount = op.corrEnd - op.corrStart;
      const pairCount = Math.min(origCount, corrCount);

      for (let k = 0; k < pairCount; k++) {
        result.push({
          text: corrected[op.corrStart + k],
          start: original[op.origStart + k].start,
        });
        lastOrigIdx = op.origStart + k;
      }

      // Extra corrected words (insertions within replace)
      if (corrCount > origCount) {
        const prevTime =
          lastOrigIdx >= 0 ? original[lastOrigIdx].start : 0;
        const nextTime =
          op.origEnd < original.length
            ? original[op.origEnd].start
            : prevTime + 1.0;
        const numInserts = corrCount - origCount;

        for (let k = 0; k < numInserts; k++) {
          const frac = (k + 1) / (numInserts + 1);
          result.push({
            text: corrected[op.corrStart + pairCount + k],
            start: prevTime + frac * (nextTime - prevTime),
          });
        }
      }

      // Extra original words (deletions within replace) — just skip
      if (origCount > corrCount) {
        lastOrigIdx = op.origEnd - 1;
      }
    } else if (op.op === 'insert') {
      const prevTime =
        lastOrigIdx >= 0 ? original[lastOrigIdx].start : 0;
      const nextTime =
        op.origStart < original.length
          ? original[op.origStart].start
          : prevTime + 1.0;
      const numInserts = op.corrEnd - op.corrStart;

      for (let k = 0; k < numInserts; k++) {
        const frac = (k + 1) / (numInserts + 1);
        result.push({
          text: corrected[op.corrStart + k],
          start: prevTime + frac * (nextTime - prevTime),
        });
      }
    } else if (op.op === 'delete') {
      lastOrigIdx = op.origEnd - 1;
    }
  }

  return result;
}
