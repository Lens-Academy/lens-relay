/**
 * Text helpers shared by every read-aloud source (Markdown in CodeMirror, HTML
 * pages in the preview frame). Ported from lens-platform's immersion reader
 * (walkArticleForReading, prepareTtsText, findSpokenWordInFlat,
 * findActiveWord) so sentences split and acronyms sound the same.
 *
 * Bundled into the preview frame's bridge as well: no DOM or React here.
 */

export interface CharRange {
  start: number;
  end: number;
}

/** Sentence end: terminal punctuation, an optional closing quote, then space. */
const SENTENCE_END_RE = /([.!?]+["'”’]?)(\s+|$)/g;

/** Stands in for dots inside abbreviations while splitting. */
const ABBREV_DOT = String.fromCharCode(1);

const SINGLE_ABBREVS = [
  'Mr', 'Mrs', 'Ms', 'Dr', 'St', 'Sr', 'Jr', 'Prof', 'vs', 'etc', 'Inc', 'Ltd', 'Co', 'Corp', 'No',
];

function maskAbbreviations(text: string): string {
  // Dotted acronyms: "U.S.", "i.e.", "e.g."
  let out = text.replace(/\b((?:[A-Za-z]\.){2,})/g, m => m.replace(/\./g, ABBREV_DOT));
  // Initials: "I. J. Good", "Timothy B. Lee"
  out = out.replace(/\b([A-Z])\.(?=\s+[A-Z])/g, `$1${ABBREV_DOT}`);
  // A list ordinal at a line start: "1. Technical safety." is one sentence.
  out = out.replace(/(^|\n)(\d+)\./g, (_m, before: string, digits: string) => `${before}${digits}${ABBREV_DOT}`);
  for (const abbr of SINGLE_ABBREVS) {
    out = out.replace(new RegExp(`\\b(${abbr})\\.(?=\\s+[A-Za-z])`, 'g'), `$1${ABBREV_DOT}`);
  }
  return out;
}

/**
 * Split `flat` into sentence ranges: on terminal punctuation (abbreviations
 * excepted), and on every "\n", which sources use as the block separator so
 * headings and list items without a full stop are units of their own.
 * Ranges are trimmed; ranges without a letter or digit are dropped.
 */
export function splitSentences(flat: string): CharRange[] {
  const masked = maskAbbreviations(flat);
  const pieces: CharRange[] = [];
  const re = new RegExp(SENTENCE_END_RE.source, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const end = m.index + m[1].length;
    if (end > last) pieces.push({ start: last, end });
    last = re.lastIndex;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < masked.length) pieces.push({ start: last, end: masked.length });

  const out: CharRange[] = [];
  for (const piece of pieces) {
    let cursor = piece.start;
    for (let i = piece.start; i <= piece.end; i++) {
      if (i === piece.end || flat[i] === '\n') {
        let s = cursor;
        let e = i;
        while (s < e && /\s/.test(flat[s])) s++;
        while (e > s && /\s/.test(flat[e - 1])) e--;
        if (e > s && /[\p{L}\p{N}]/u.test(flat.slice(s, e))) out.push({ start: s, end: e });
        cursor = i + 1;
      }
    }
  }
  return out;
}

/**
 * The text actually sent to the voice. Only patterns the voice misreads:
 * all-caps acronyms of 3-6 letters are dotted so they are spelled out
 * (`ASI` → `A.S.I.`), and camelCase acronyms too (`xAI` → `x.A.I.`).
 * Two-letter acronyms and plurals (`AI`, `LLMs`) are read fine as they are.
 */
export function prepareTtsText(text: string): string {
  return text
    .replace(/\b([a-z])([A-Z]{2,5})\b/g, (_m, lower: string, upper: string) => `${lower}.${upper.split('').join('.')}.`)
    .replace(/\b([A-Z]{3,6})\b/g, (_m, acronym: string) => `${acronym.split('').join('.')}.`);
}

/**
 * Where a spoken token sits in the sentence, searching forward from `cursor`
 * within a short lookahead (case-sensitive first, then not). Tokens the voice
 * expanded ("twenty twenty" for "2020") match nothing, and the highlight then
 * stays on the last word that did.
 */
export function findSpokenWord(haystack: string, cursor: number, needle: string, maxLookahead = 60): CharRange | null {
  if (!needle || !/[\p{L}\p{N}]/u.test(needle)) return null;
  if (cursor < 0) cursor = 0;
  if (cursor >= haystack.length) return null;
  const slice = haystack.slice(cursor, cursor + needle.length + maxLookahead);
  let local = slice.indexOf(needle);
  if (local < 0) local = slice.toLowerCase().indexOf(needle.toLowerCase());
  if (local < 0) return null;
  return { start: cursor + local, end: cursor + local + needle.length };
}

/** Index of the last word whose start time is ≤ `time`, or -1. */
export function findActiveWord(starts: number[], time: number): number {
  if (starts.length === 0 || time < starts[0]) return -1;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (starts[mid] <= time) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
