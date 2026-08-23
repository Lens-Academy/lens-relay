import { normalize } from "./alignment";

/**
 * Fidelity gate for the LLM cleanup pass.
 *
 * The formatting prompt forbids adding content and allows removing only filler
 * words, but nothing enforced that. This turns "we trust the prompt" into a
 * checked invariant: if the model paraphrases, hallucinates, or silently drops
 * a chunk, we detect it and keep the unpolished-but-faithful transcript.
 *
 * The comparison is a word multiset diff rather than an LCS, so it costs O(n)
 * and works at any transcript length -- the LCS aligner has an O(m*n) memory
 * ceiling, and the longest transcripts are exactly where a dropped chunk is
 * most likely and least visible.
 */

/**
 * Words the prompt explicitly permits the model to drop.
 *
 * Deliberately excludes the unigrams of "you know" and "like": those are
 * ordinary content words, and exempting them would let a model quietly delete
 * every "you" or "like" in a transcript without registering as content loss.
 * Dropping genuine "you know" filler instead spends a little of the
 * non-filler budget below, which real transcripts stay well inside.
 */
const FILLER = new Set(["uh", "um", "uhh", "erm", "er", "ah", "mm", "hmm"]);

/** A cleanup pass should barely change the word inventory. */
const MAX_INSERTED_RATIO = 0.03;
const MAX_DROPPED_NON_FILLER_RATIO = 0.08;
const MIN_LENGTH_RATIO = 0.85;
const MAX_LENGTH_RATIO = 1.15;

export interface VerificationResult {
  ok: boolean;
  /** Human-readable failure cause; undefined when ok. */
  reason?: string;
  stats: {
    originalWords: number;
    correctedWords: number;
    lengthRatio: number;
    inserted: number;
    droppedNonFiller: number;
  };
}

function counts(words: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of words) {
    const n = normalize(w);
    if (!n) continue;
    m.set(n, (m.get(n) ?? 0) + 1);
  }
  return m;
}

/**
 * Check that `corrected` is a faithful cleanup of `original`.
 *
 * Both inputs are raw word arrays; normalization (case, punctuation) happens
 * here, so pure punctuation/capitalization edits register as no change at all.
 */
export function verifyCorrection(
  original: string[],
  corrected: string[],
): VerificationResult {
  const origCounts = counts(original);
  const corrCounts = counts(corrected);
  const origTotal = [...origCounts.values()].reduce((a, b) => a + b, 0);
  const corrTotal = [...corrCounts.values()].reduce((a, b) => a + b, 0);

  let inserted = 0;
  for (const [word, n] of corrCounts) {
    inserted += Math.max(0, n - (origCounts.get(word) ?? 0));
  }
  let droppedNonFiller = 0;
  for (const [word, n] of origCounts) {
    const missing = Math.max(0, n - (corrCounts.get(word) ?? 0));
    if (missing && !FILLER.has(word)) droppedNonFiller += missing;
  }

  const lengthRatio = origTotal === 0 ? 1 : corrTotal / origTotal;
  const stats = {
    originalWords: origTotal,
    correctedWords: corrTotal,
    lengthRatio,
    inserted,
    droppedNonFiller,
  };

  const fail = (reason: string): VerificationResult => ({
    ok: false,
    reason,
    stats,
  });

  if (corrTotal === 0) return fail("cleanup returned no text");
  // Catches the failure that matters most: a chunk lost, or the model
  // summarising instead of formatting.
  if (lengthRatio < MIN_LENGTH_RATIO) {
    return fail(
      `cleanup lost ${Math.round((1 - lengthRatio) * 100)}% of the transcript ` +
        `(${corrTotal} of ${origTotal} words)`,
    );
  }
  if (lengthRatio > MAX_LENGTH_RATIO) {
    return fail(
      `cleanup grew the transcript by ${Math.round((lengthRatio - 1) * 100)}%`,
    );
  }
  if (origTotal > 0 && inserted / origTotal > MAX_INSERTED_RATIO) {
    return fail(
      `cleanup introduced ${inserted} words not present in the original ` +
        `(${((inserted / origTotal) * 100).toFixed(1)}%)`,
    );
  }
  if (
    origTotal > 0 &&
    droppedNonFiller / origTotal > MAX_DROPPED_NON_FILLER_RATIO
  ) {
    return fail(
      `cleanup dropped ${droppedNonFiller} non-filler words ` +
        `(${((droppedNonFiller / origTotal) * 100).toFixed(1)}%)`,
    );
  }

  return { ok: true, stats };
}
