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
// Max words before falling back to streaming alignment.
// LCS DP table is O(m*n) memory; 5000*5000 = 200MB which is acceptable.
const MAX_LCS_WORDS = 5000;

export function alignWords(
  original: TimestampedWord[],
  corrected: string[]
): TimestampedWord[] {
  // Too long for the LCS table -- align by streaming instead. Still real
  // timings; see alignStreaming.
  if (original.length > MAX_LCS_WORDS || corrected.length > MAX_LCS_WORDS) {
    return alignStreaming(original, corrected);
  }

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

/** How far ahead to search for a word's match before giving up on it. */
const STREAM_LOOKAHEAD = 40;
/** Consecutive misses that mean the cursor has lost the thread entirely. */
const STREAM_RESYNC_AFTER = 8;
/** Wider net cast to find the thread again once it is lost. */
const STREAM_RESYNC_LOOKAHEAD = 2000;

/**
 * Alignment for transcripts too long for the LCS table.
 *
 * Walks both sequences with a single forward cursor, matching each corrected
 * word to the next occurrence of it in the original within a small lookahead
 * window. A cleanup pass only punctuates, recases and fixes the odd word, so
 * the two sequences stay in lockstep and nearly every word matches exactly --
 * which means real caption timings, not invented ones. Words with no match
 * (model insertions) are interpolated between their neighbours, exactly as the
 * LCS path does.
 *
 * This replaces an earlier fallback that spread words evenly across the video
 * duration. That produced plausible-looking but fabricated timestamps -- every
 * word equidistant -- on precisely the long videos where seeking to a moment
 * matters most.
 */
export function alignStreaming(
  original: TimestampedWord[],
  corrected: string[]
): TimestampedWord[] {
  if (original.length === 0 || corrected.length === 0) return [];

  const origNorm = original.map((w) => normalize(w.text));
  const times: Array<number | null> = new Array(corrected.length).fill(null);

  let oi = 0;
  let misses = 0;
  for (let ci = 0; ci < corrected.length; ci++) {
    const c = normalize(corrected[ci]);
    if (!c) continue;
    // Once enough words in a row have failed to match, the cursor is no longer
    // tracking the transcript -- a long dropped run, say. Without a wider
    // search it would never match again and every remaining word would be
    // interpolated across the rest of the video, reintroducing exactly the
    // fabricated uniform timings this function exists to avoid.
    const span =
      misses >= STREAM_RESYNC_AFTER
        ? STREAM_RESYNC_LOOKAHEAD
        : STREAM_LOOKAHEAD;
    const limit = Math.min(origNorm.length, oi + span);
    let found = false;
    for (let k = oi; k < limit; k++) {
      if (origNorm[k] === c) {
        times[ci] = original[k].start;
        oi = k + 1;
        found = true;
        break;
      }
    }
    misses = found ? 0 : misses + 1;
  }

  // Interpolate unmatched runs between the anchors that surround them, so the
  // output stays monotonically non-decreasing and covers the full timeline.
  const firstTime = original[0].start;
  const lastTime = original[original.length - 1].start;
  const result: TimestampedWord[] = new Array(corrected.length);
  let i = 0;
  let prevTime = firstTime;

  while (i < corrected.length) {
    if (times[i] !== null) {
      prevTime = times[i]!;
      result[i] = { text: corrected[i], start: prevTime };
      i++;
      continue;
    }
    let j = i;
    while (j < corrected.length && times[j] === null) j++;
    const nextTime = j < corrected.length ? times[j]! : lastTime;
    const span = Math.max(0, nextTime - prevTime);
    const gaps = j - i + 1;
    for (let k = i; k < j; k++) {
      result[k] = {
        text: corrected[k],
        start: prevTime + ((k - i + 1) / gaps) * span,
      };
    }
    i = j;
  }

  return result;
}
