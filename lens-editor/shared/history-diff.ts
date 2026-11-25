import { diffLines, diffWordsWithSpace } from 'diff';

/**
 * Word-level comparison of two versions of a file, shared by the history panel (what it marks)
 * and the server (the change count and first-change preview on each session row).
 */

export type DiffPart = { kind: 'same' | 'added' | 'removed'; text: string };
export interface ChangeSummary {
  /** Separate places changed: edits fewer than GAP_WORDS unchanged words apart count as one. */
  changes: number;
  added: number;
  removed: number;
  first: { removed: string; added: string } | null;
}

const GAP_WORDS = 4;
const PREVIEW_CHARS = 60;
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

// Diff cost grows with the number of edits, so both passes give up past a cap (jsdiff then
// returns undefined) and mark that span by whole lines/blocks instead. Words are compared only
// inside changed line blocks. Assay measured 1.4 s for one file's summaries on the request path
// with whole-file word diffs (#220).
const MAX_LINE_EDITS = 1000;
const MAX_WORD_EDITS = 2000;
const kindOf = (p: { added?: boolean; removed?: boolean }): DiffPart['kind'] => (p.added ? 'added' : p.removed ? 'removed' : 'same');
const whole = (removed: string, added: string): DiffPart[] => [
  ...(removed ? [{ kind: 'removed' as const, text: removed }] : []),
  ...(added ? [{ kind: 'added' as const, text: added }] : []),
];

function lineThenWordDiff(base: string, text: string): DiffPart[] {
  const lines = diffLines(base, text, { maxEditLength: MAX_LINE_EDITS });
  if (!lines) return whole(base, text);
  const out: DiffPart[] = [];
  let removed = '', added = '';
  const flush = () => {
    const words = removed && added ? diffWordsWithSpace(removed, added, { maxEditLength: MAX_WORD_EDITS }) : undefined;
    if (words) for (const p of words) out.push({ kind: kindOf(p), text: p.value });
    else out.push(...whole(removed, added));
    removed = added = '';
  };
  for (const p of lines) {
    if (p.removed) removed += p.value;
    else if (p.added) added += p.value;
    else { flush(); out.push({ kind: 'same', text: p.value }); }
  }
  flush();
  return out;
}

/** Word-level changes from `base` (null: the file's first version) to `text`. */
export function diffVersions(base: string | null, text: string) {
  const parts: DiffPart[] = base === null ? [{ kind: 'added', text }] : lineThenWordDiff(base, text);
  const count = (k: DiffPart['kind']) => parts.filter(p => p.kind === k).reduce((n, p) => n + words(p.text), 0);
  return { parts, added: count('added'), removed: count('removed') };
}

// Suggestion (CriticMarkup) markers and the author metadata the relay writes into them,
// e.g. {++{"author":"Luc's AI","timestamp":1790449050412}@@text++}; previews show only the text.
const MARKUP_OPEN = /\{(\+\+|--|>>|~~|==)(\{[^{}]*\}@@)?/g;
const MARKUP_CLOSE = /(\+\+|--|<<|~~|==)\}/g;
// The metadata alone, kept out of summaries: re-stamping it is not a change anyone made.
const META = /(\{(?:\+\+|--|>>|~~|==))\{[^{}]*\}@@/g;
const noMeta = (s: string) => s.replace(META, '$1');
const plain = (s: string) => s.replace(MARKUP_OPEN, '').replace(MARKUP_CLOSE, '').replace(/~>/g, ' → ');
const hasWord = (h: { removed: string[]; added: string[] }) => /[\p{L}\p{N}]/u.test(plain([...h.removed, ...h.added].join(' ')));

const clip = (pieces: string[]) => {
  const s = pieces.map(p => plain(p).trim()).filter(Boolean).join(' … ');
  return s.length > PREVIEW_CHARS ? s.slice(0, PREVIEW_CHARS).trimEnd() + '…' : s;
};

export function summarize(base: string | null, text: string): ChangeSummary {
  const { parts, added, removed } = diffVersions(base === null ? null : noMeta(base), noMeta(text));
  const hunks: { removed: string[]; added: string[] }[] = [];
  let open = false;
  for (const p of parts) {
    if (p.kind === 'same') {
      if (words(p.text) >= GAP_WORDS) open = false;
      continue;
    }
    if (!p.text.trim()) continue;
    if (!open) { hunks.push({ removed: [], added: [] }); open = true; }
    hunks.at(-1)![p.kind].push(p.text);
  }
  // Preview the first change with a letter or digit in it; "+ :" says nothing.
  const h = hunks.find(hasWord) ?? hunks[0];
  return { changes: hunks.length, added, removed, first: h ? { removed: clip(h.removed), added: clip(h.added) } : null };
}

/** 'ai:opus-5.5:Andreas' → 'Andreas (AI)'; human names unchanged. */
export function authorLabel(raw: string): string {
  const m = /^ai:[^:]*:(.+)$/.exec(raw);
  return m ? `${m[1]} (AI)` : raw;
}
