import type { TranscriptRaw, TimestampedWord } from './types';

/**
 * Extract timestamped words from YouTube's json3 format.
 * Handles both word-level (auto-generated) and sentence-level (manual) captions.
 */
export function extractWords(raw: TranscriptRaw): TimestampedWord[] {
  const words: TimestampedWord[] = [];

  for (const event of raw.events) {
    if (!event.segs) continue;

    const baseTimeS = event.tStartMs / 1000;

    for (const seg of event.segs) {
      const text = (seg.utf8 || '').replace(/\n/g, ' ').trim();
      if (!text) continue;

      const offsetS = (seg.tOffsetMs || 0) / 1000;
      words.push({ text, start: baseTimeS + offsetS });
    }
  }

  return words;
}

/**
 * Detect if transcript has word-level timestamps.
 * Auto-generated captions have individual words; manual captions have phrases with spaces.
 */
export function isWordLevel(words: TimestampedWord[]): boolean {
  const sample = words.slice(0, 10);
  if (sample.length === 0) return true;
  const withSpaces = sample.filter((w) => w.text.includes(' ')).length;
  return withSpaces / sample.length < 0.25;
}

/**
 * Convert raw transcript to plain text with paragraph breaks.
 * Word-level: split on 2+ second timing gaps.
 * Sentence-level: join all entries with spaces.
 */
export function toPlainText(
  raw: TranscriptRaw,
  gapThreshold: number = 2.0
): string {
  const words = extractWords(raw);
  if (words.length === 0) return '';

  if (!isWordLevel(words)) {
    return words.map((w) => w.text).join(' ');
  }

  const paragraphs: string[] = [];
  let current: string[] = [];

  for (let i = 0; i < words.length; i++) {
    current.push(words[i].text);

    if (i + 1 < words.length) {
      const gap = words[i + 1].start - words[i].start;
      if (gap > gapThreshold) {
        paragraphs.push(current.join(' '));
        current = [];
      }
    }
  }

  if (current.length > 0) {
    paragraphs.push(current.join(' '));
  }

  return paragraphs.join('\n\n');
}
