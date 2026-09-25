/**
 * The previous comment format, kept only to migrate pages that still use it:
 * comments lived inside the HTML source as
 *
 *   [[@comment:ID]]<!--lens-comment {"id","author","ts","body"}-->
 *   <!--lens-reply {"id","parent","author","ts","body"}-->
 *
 * An editor who opens such a page moves its threads into `comments_v0` (with
 * anchors described from where the markers render) and strips the markers.
 */
import type * as Y from 'yjs';

export interface LegacyMessage {
  id: string;
  author: string;
  ts: string;
  body: string;
}

export interface LegacyThread extends LegacyMessage {
  replies: LegacyMessage[];
}

interface FoundMarker {
  kind: 'comment' | 'reply';
  start: number;
  payloadStart: number;
  payloadEnd: number;
  end: number;
}

const TEXT_ANCHOR = /\[\[@comment:([^\]\s]+)\]\]/g;

export function hasLegacyComments(source: string): boolean {
  return /<!--lens-(?:comment|reply) \{/.test(source) || /\[\[@comment:[^\]\s]+\]\]/.test(source);
}

function findNextMarker(source: string, from: number): FoundMarker | null {
  let scan = from;
  while (scan < source.length) {
    const start = source.indexOf('<!--lens-', scan);
    if (start === -1) return null;
    const after = start + '<!--lens-'.length;
    let kind: 'comment' | 'reply' | null = null;
    if (source.startsWith('comment ', after)) kind = 'comment';
    else if (source.startsWith('reply ', after)) kind = 'reply';
    const payloadStart = kind ? after + kind.length + 1 : -1;
    if (!kind || source[payloadStart] !== '{') { scan = after; continue; }
    // Walk the JSON object, respecting strings, to find its end.
    let depth = 0;
    let inString = false;
    let escape = false;
    let i = payloadStart;
    for (; i < source.length; i++) {
      const c = source[i];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (inString) { if (c === '"') inString = false; continue; }
      if (c === '"') { inString = true; continue; }
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { i++; break; }
    }
    if (depth !== 0 || !source.startsWith('-->', i)) { scan = after; continue; }
    return { kind, start, payloadStart, payloadEnd: i, end: i + 3 };
  }
  return null;
}

function parsePayload(raw: string): Record<string, string> | null {
  try {
    const obj = JSON.parse(raw) as unknown;
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') out[k] = v;
    return out;
  } catch {
    return null;
  }
}

/** Threads in the source, in order. Replies join their parent by id wherever
 *  they are (the old parser silently dropped non-adjacent ones). */
export function parseLegacyComments(source: string): LegacyThread[] {
  const threads: LegacyThread[] = [];
  const byId = new Map<string, LegacyThread>();
  const replies: Array<LegacyMessage & { parent: string }> = [];
  for (let found = findNextMarker(source, 0); found; found = findNextMarker(source, found.end)) {
    const p = parsePayload(source.slice(found.payloadStart, found.payloadEnd));
    if (!p?.id || p.body === undefined) continue;
    const message = { id: p.id, author: p.author || 'Unknown', ts: p.ts || '', body: p.body };
    if (found.kind === 'comment') {
      if (byId.has(p.id)) continue;
      const thread = { ...message, replies: [] };
      threads.push(thread);
      byId.set(p.id, thread);
    } else if (p.parent) {
      replies.push({ ...message, parent: p.parent });
    }
  }
  for (const reply of replies) {
    const { parent, ...message } = reply;
    byId.get(parent)?.replies.push(message);
  }
  return threads;
}

/** Source ranges of every legacy marker (comment and reply blocks, text anchors). */
export function legacyMarkerRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let found = findNextMarker(source, 0); found; found = findNextMarker(source, found.end)) {
    ranges.push([found.start, found.end]);
  }
  for (const m of source.matchAll(TEXT_ANCHOR)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  // Drop ranges nested in earlier ones (an anchor-like string inside a body).
  const out: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && r[0] < last[1]) continue;
    out.push(r);
  }
  return out;
}

/** The source as the preview renders it before migration: text anchors
 *  removed (they would show as `[[@comment:…]]`); the HTML-comment markers
 *  stay, since they render as nothing and mark where each comment was. */
export function withoutLegacyTextAnchors(source: string): string {
  return source.includes('[[@comment:') ? source.replace(TEXT_ANCHOR, '') : source;
}

/** Remove every legacy marker from the Y.Text, back to front. */
export function stripLegacyMarkers(ytext: Y.Text, origin: unknown): number {
  const source = ytext.toString();
  const ranges = legacyMarkerRanges(source);
  if (ranges.length === 0) return 0;
  // Y.Text indexes by UTF-16 code unit in the editor, like JS strings.
  ytext.doc!.transact(() => {
    for (let i = ranges.length - 1; i >= 0; i--) {
      const [start, end] = ranges[i];
      ytext.delete(start, end - start);
    }
  }, origin);
  return ranges.length;
}
