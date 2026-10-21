/**
 * Carried authorship: keep who wrote a piece of text when it is re-inserted
 * somewhere else (a moved or duplicated line, a cut/copy and paste, a
 * dragged selection).
 *
 * Yjs has no "move": every such edit deletes and inserts, and inserted text
 * carries the clientID of whoever inserted it, so it would read as written by
 * the person moving it. Instead, the original authors of the text are looked
 * up before the edit and the inserted pieces are written under clientIDs that
 * resolve to those same authors (see carrierClientId in provenance.ts).
 *
 * This module holds the pure parts: authors of a range, matching inserted
 * text against the text it came from, and the remembered copy for pastes.
 */
import type * as Y from 'yjs';
import { getAuthorshipRuns } from './authorship-runs';
import { acceptedPieces } from './criticmarkup-actions';
import { getClientActorMap, getRegisteredAt } from './provenance';

/** Who wrote a piece of text. `client` is set only for text of the same doc. */
export interface CarriedAuthor {
  actor: string | null;
  at: number | null;
  client?: number;
}

/** A stretch of `length` characters, all by `author`; null means "not
 *  carried": written as an ordinary edit by the person making it. */
export interface AuthorSpan {
  length: number;
  author: CarriedAuthor | null;
}

/** Text plus who wrote each part of it. */
export interface AuthoredText {
  text: string;
  spans: AuthorSpan[];
}

/** An inserted range of a transaction (new-doc positions) and its author. */
export interface CarriedRange {
  from: number;
  to: number;
  author: CarriedAuthor;
}

/** Authors of `[from, to)` of the Y.Text, as spans covering the range. */
export function authorSpans(ydoc: Y.Doc, ytext: Y.Text, from: number, to: number): AuthorSpan[] {
  const actors = getClientActorMap(ydoc);
  const dates = new Map<number, number | null>();
  const spans: AuthorSpan[] = [];
  for (const run of getAuthorshipRuns(ytext)) {
    const start = Math.max(run.from, from);
    const end = Math.min(run.to, to);
    if (end <= start) continue;
    if (!dates.has(run.client)) dates.set(run.client, getRegisteredAt(ydoc, run.client));
    const author: CarriedAuthor = {
      actor: actors.get(run.client) ?? null,
      at: dates.get(run.client) ?? null,
      client: run.client,
    };
    const last = spans[spans.length - 1];
    if (last?.author?.client === run.client) last.length += end - start;
    else spans.push({ length: end - start, author });
  }
  return spans;
}

/** Spans of `[start, start + length)` of an authored text. */
export function sliceSpans(spans: AuthorSpan[], start: number, length: number): AuthorSpan[] {
  const out: AuthorSpan[] = [];
  let pos = 0;
  for (const span of spans) {
    const from = Math.max(pos, start);
    const to = Math.min(pos + span.length, start + length);
    if (to > from) out.push({ length: to - from, author: span.author });
    pos += span.length;
    if (pos >= start + length) break;
  }
  return out;
}

/** How many characters of the spans have no known author. */
export function unmarkedLength(spans: AuthorSpan[]): number {
  return spans.reduce((n, s) => n + (s.author && s.author.actor === null ? s.length : 0), 0);
}

/** Turn spans placed at doc position `at` into carried ranges. */
export function placeSpans(spans: AuthorSpan[], at: number): CarriedRange[] {
  const ranges: CarriedRange[] = [];
  let pos = at;
  for (const span of spans) {
    if (span.author) ranges.push({ from: pos, to: pos + span.length, author: span.author });
    pos += span.length;
  }
  return ranges;
}

function trimBreaks(text: string): { start: number; end: number } {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === '\n') start++;
  while (end > start && text[end - 1] === '\n') end--;
  return { start, end };
}

/**
 * Where inserted text re-uses a source text: the inserted text (line breaks
 * at its ends aside) found in the source, or the source (likewise) found in
 * the inserted text. Moving a line deletes "\nline" and inserts "line\n", so
 * the line breaks at the ends must not decide the match.
 */
export function matchSource(
  inserted: string,
  source: string
): { insertedFrom: number; sourceFrom: number; length: number } | null {
  const ins = trimBreaks(inserted);
  if (ins.end > ins.start) {
    const idx = source.indexOf(inserted.slice(ins.start, ins.end));
    if (idx >= 0) return { insertedFrom: ins.start, sourceFrom: idx, length: ins.end - ins.start };
  }
  const src = trimBreaks(source);
  if (src.end > src.start) {
    const idx = inserted.indexOf(source.slice(src.start, src.end));
    if (idx >= 0) return { insertedFrom: idx, sourceFrom: src.start, length: src.end - src.start };
  }
  return null;
}

// --- The remembered copy ----------------------------------------------------

/**
 * The last text copied, cut or dragged out of an editor, kept so a paste of
 * exactly that text gets its authors back. Stored as a hash, never the text,
 * and in localStorage so a paste in another tab (another document) matches
 * too. Only the last copy is kept: as it is, and, when it has suggestions in
 * it, as a suggestion-mode paste inserts it (with them accepted:
 * criticmarkup-paste.ts).
 */
interface CopiedForm {
  hash: string;
  length: number;
  spans: { length: number; author: { actor: string | null; at: number | null } | null }[];
}

interface CopiedRecord extends CopiedForm {
  accepted?: CopiedForm;
}

const STORAGE_KEY = 'lens-editor:copied-authorship';
let lastCopied: CopiedRecord | null = null;

/** 53-bit string hash (cyrb53), as hex. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

export function normalizeLineBreaks(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function storedForm(copied: AuthoredText): CopiedForm {
  return {
    hash: hashText(copied.text),
    length: copied.text.length,
    // Client IDs mean nothing in another doc: keep actor and date only
    spans: copied.spans.map((s) => ({
      length: s.length,
      author: s.author && { actor: s.author.actor, at: s.author.at },
    })),
  };
}

/** `copied` as a suggestion-mode paste inserts it, its CriticMarkup changes
 *  accepted, or null when that is the same text (or none) */
function acceptedForm(copied: AuthoredText): AuthoredText | null {
  const pieces = acceptedPieces(copied.text);
  const text = pieces.map((p) => copied.text.slice(p.from, p.to)).join('');
  if (!text || text === copied.text) return null;
  return { text, spans: pieces.flatMap((p) => sliceSpans(copied.spans, p.from, p.to - p.from)) };
}

export function rememberCopied(copied: AuthoredText): void {
  const record: CopiedRecord = storedForm(copied);
  const accepted = acceptedForm(copied);
  if (accepted) record.accepted = storedForm(accepted);
  lastCopied = record;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Storage full or blocked: this tab keeps it in memory, and an older
    // stored copy must not win over it
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // storage unusable altogether
    }
  }
}

function readCopied(): CopiedRecord | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as CopiedRecord;
  } catch {
    // fall through to this tab's own copy
  }
  return lastCopied;
}

/** The authors of `text` if it is exactly the text last copied (or that as
 *  suggestion mode pastes it), else null. */
export function recallCopied(text: string): AuthorSpan[] | null {
  const record = readCopied();
  const form = [record, record?.accepted].find((f) => f && f.length === text.length && f.hash === hashText(text));
  return form ? form.spans : null;
}

export function forgetCopied(): void {
  lastCopied = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // nothing to do
  }
}
