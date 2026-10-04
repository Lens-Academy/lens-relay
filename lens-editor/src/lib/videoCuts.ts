/**
 * Cut points for video segments (`from::` / `to::`): parsing and writing the
 * times, suggesting a cut from the transcript's word timings, and the end
 * fade the platform plays, so the cut picker sounds like the platform.
 */
import { parseTimestamp } from 'lens-content-processor/dist/bundler/video.js';

/** One word of a transcript's `.timestamps.json` sidecar. */
export interface TimedWord {
  text: string;
  /** Start time in `M:SS.ss` form, as the sidecar stores it. */
  start: string;
}

/** A word with its start time in seconds. */
export interface Word {
  text: string;
  start: number;
}

/** The platform's clip-end fade (lens-platform `VideoPlayer.tsx`,
 *  `CLIP_FADE_SECONDS`): full volume until this long before `to::`, falling
 *  linearly to silence at `to::`. Keep the two in step. */
export const CLIP_FADE_SECONDS = 0.2;

export function clipEndVolume(currentTime: number, end: number): number {
  const left = end - currentTime;
  if (left >= CLIP_FADE_SECONDS) return 1;
  if (left <= 0) return 0;
  return left / CLIP_FADE_SECONDS;
}

/** Seconds from a `from::` / `to::` value, read exactly as the content
 *  processor reads it (quotes allowed); null when it would refuse it. */
export function parseTime(value: string): number | null {
  return parseTimestamp(value.trim().replace(/^"(.*)"$/, '$1'));
}

/** `M:SS` for whole seconds, else `M:SS.ss` (trailing zeros dropped).
 *  Minutes run past 59 rather than adding an hour part, because the content
 *  processor accepts fractions only in the `M:SS.ss` form. */
export function formatTime(seconds: number): string {
  const hundredths = Math.round(Math.max(0, seconds) * 100);
  const minutes = Math.floor(hundredths / 6000);
  const rest = hundredths - minutes * 6000;
  const secs = Math.floor(rest / 100);
  const frac = rest % 100;
  const base = `${minutes}:${String(secs).padStart(2, '0')}`;
  if (frac === 0) return base;
  return `${base}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}

/** The sidecar's words with times in seconds, dropping any it cannot read. */
export function toWords(timed: TimedWord[]): Word[] {
  const words: Word[] = [];
  for (const w of timed) {
    const start = parseTime(w.start);
    if (start !== null) words.push({ text: w.text, start });
  }
  return words;
}

const SENTENCE_END = /[.?!…]["'”’)\]]*$/;

/** How far before the next sentence's first word a suggested cut sits. The
 *  sidecar has only start times (YouTube's, often a little late), so the cut
 *  goes a bit before the word rather than exactly on it. */
const LEAD_IN = 0.15;
/** A cut never comes closer than this after the previous word's start, so a
 *  tight gap does not cut into that word. */
const MIN_AFTER_LAST_WORD = 0.2;

export interface CutSuggestion {
  /** Suggested cut, in seconds. */
  time: number;
  /** Index of the first word of the sentence the cut comes before. */
  wordIndex: number;
}

/** A cut just before the first word of a sentence: where a clip should end
 *  (to leave that sentence out) or start (to take it in). */
export function cutBefore(words: Word[], wordIndex: number): number {
  const next = words[wordIndex].start;
  const prev = wordIndex > 0 ? words[wordIndex - 1].start : 0;
  const cut = Math.max(next - LEAD_IN, Math.min(prev + MIN_AFTER_LAST_WORD, next));
  return Math.round(cut * 100) / 100;
}

/** The sentence boundary nearest to `around`, within `window` seconds,
 *  as a cut just before the next sentence's first word. */
export function suggestCut(words: Word[], around: number, window = 4): CutSuggestion | null {
  let best: CutSuggestion | null = null;
  let bestDistance = Infinity;
  for (let i = 1; i < words.length; i++) {
    if (!SENTENCE_END.test(words[i - 1].text.trim())) continue;
    const time = cutBefore(words, i);
    const distance = Math.abs(time - around);
    if (distance <= window && distance < bestDistance) {
      best = { time, wordIndex: i };
      bestDistance = distance;
    }
  }
  return best;
}

/** Candidate cuts: `count` steps either side of `centre`, never below 0. */
export function candidates(centre: number, step: number, count = 3): number[] {
  const out: number[] = [];
  for (let k = -count; k <= count; k++) {
    const t = Math.round((centre + k * step) * 100) / 100;
    if (t >= 0) out.push(t);
  }
  return out;
}

/** The YouTube video id of a transcript's `url:` (watch, youtu.be, embed,
 *  shorts or live links). */
export function youtubeId(url: string): string | null {
  const m = url.match(
    /(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:embed\/|v\/|shorts\/|live\/|watch\?(?:.*&)?v=))([\w-]{11})/,
  );
  return m ? m[1] : null;
}
