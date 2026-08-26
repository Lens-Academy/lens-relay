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
 * Words the prompt explicitly permits the model to drop, anywhere they appear.
 *
 * Deliberately excludes the unigrams of "you know" and "like": those are
 * ordinary content words, and exempting them outright would let a model
 * quietly delete every "you" or "like" in a transcript without registering as
 * content loss. Multi-word markers are handled by DISCOURSE_PHRASES instead,
 * which only excuses them where they actually occur as the phrase.
 */
const FILLER = new Set(["uh", "um", "uhh", "erm", "er", "ah", "mm", "hmm"]);

/**
 * Multi-word discourse markers the cleanup is expected to remove.
 *
 * These cost nothing in a lecture and dominate in a conversation, which is why
 * a blanket threshold cannot serve both: an interview transcript spends its
 * entire non-filler budget on "you know" and "kind of" and is rejected for
 * doing exactly what the prompt asked. Excusing them per occurrence -- rather
 * than exempting "know" or "of" globally, or simply raising the threshold --
 * keeps the gate's real job intact, which is catching truncation, paraphrase
 * and fabrication.
 */
const DISCOURSE_PHRASES: string[][] = [
  ["you", "know"],
  ["sort", "of"],
  ["kind", "of"],
  ["i", "mean"],
];

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
 * How many of each word the cleanup may drop without it counting as content
 * loss, derived from where those words actually sit in the original.
 *
 * Order matters here in a way the multiset comparison cannot see: "know" is a
 * content word on its own and filler in "you know", and the second "the" in
 * "the the model" is a stutter while the first is not. Computing the allowance
 * from the original sequence lets the comparison stay an O(n) multiset diff
 * while still telling those cases apart.
 */
function droppableCounts(words: string[]): Map<string, number> {
  // Dropping the empties also closes the gaps around speaker-change markers
  // like ">>", so ">> you know" still reads as the phrase "you know".
  const norm = words.map(normalize).filter((w) => w !== "");
  const allow = new Map<string, number>();
  const add = (w: string) => allow.set(w, (allow.get(w) ?? 0) + 1);

  for (let i = 0; i < norm.length; i++) {
    if (FILLER.has(norm[i])) add(norm[i]);
    // A stutter: the repeat is droppable, the first utterance is not.
    if (i > 0 && norm[i] === norm[i - 1]) add(norm[i]);
  }

  for (const phrase of DISCOURSE_PHRASES) {
    for (let i = 0; i + phrase.length <= norm.length; i++) {
      let hit = true;
      for (let k = 0; k < phrase.length; k++) {
        if (norm[i + k] !== phrase[k]) {
          hit = false;
          break;
        }
      }
      if (!hit) continue;
      for (const w of phrase) add(w);
      // Non-overlapping: "kind of kind of" excuses two occurrences, not three.
      i += phrase.length - 1;
    }
  }

  return allow;
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
  const droppable = droppableCounts(original);
  let droppedNonFiller = 0;
  for (const [word, n] of origCounts) {
    const missing = Math.max(0, n - (corrCounts.get(word) ?? 0));
    if (!missing) continue;
    droppedNonFiller += Math.max(0, missing - (droppable.get(word) ?? 0));
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
