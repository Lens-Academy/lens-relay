/**
 * Recent direct AI edits recorded in a content doc's `activity_v0` Y.Map by
 * the relay (crates/y-sweet-core/src/activity.rs). One entry per direct MCP
 * edit, retained for seven days. This module reads them and resolves where
 * an event's change sits in the current text.
 */
import * as Y from 'yjs';

export const ACTIVITY_MAP = 'activity_v0';

export interface DocActivityEvent {
  id: string;
  ts: number;
  actor: string;
  author: string;
  mode: string;
  kind: 'insert' | 'delete' | 'replace';
  old: string;
  new: string;
  oldTruncated: boolean;
  newTruncated: boolean;
  ctxBefore: string;
  ctxAfter: string;
  client: number;
  clockFrom: number;
  clockTo: number;
  /** Encoded Y.RelativePosition (v1) at the start of the changed region. */
  anchor: Uint8Array | null;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Parse one map value; null when malformed. */
export function parseActivityEvent(id: string, value: unknown): DocActivityEvent | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const ts = num(v.ts);
  const client = num(v.client);
  const clockFrom = num(v.clock_from);
  const clockTo = num(v.clock_to);
  const kind = str(v.kind);
  if (ts === null || client === null || clockFrom === null || clockTo === null) return null;
  if (kind !== 'insert' && kind !== 'delete' && kind !== 'replace') return null;
  const anchor = v.anchor instanceof Uint8Array ? v.anchor : null;
  return {
    id,
    ts,
    actor: str(v.actor),
    author: str(v.author),
    mode: str(v.mode, 'direct'),
    kind,
    old: str(v.old),
    new: str(v.new),
    oldTruncated: v.old_truncated === true,
    newTruncated: v.new_truncated === true,
    ctxBefore: str(v.ctx_before),
    ctxAfter: str(v.ctx_after),
    client,
    clockFrom,
    clockTo,
    anchor,
  };
}

/** All well-formed events in the doc, oldest first. */
export function readActivityEvents(doc: Y.Doc): DocActivityEvent[] {
  const map = doc.getMap(ACTIVITY_MAP);
  const events: DocActivityEvent[] = [];
  map.forEach((value, key) => {
    const ev = parseActivityEvent(key, value);
    if (ev) events.push(ev);
  });
  events.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return events;
}

/** True when the item range `[clock, clock + length)` of `client` overlaps
 *  the event's minted clock range. */
export function eventCoversItems(ev: DocActivityEvent, client: number, clock: number, length: number): boolean {
  return client === ev.client && clock < ev.clockTo && clock + length > ev.clockFrom;
}

/**
 * Where the event's old text used to be, as a position in `ytext`
 * (UTF-16 index), resolved in order of trust:
 *  1. the stored relative position (survives edits anywhere else),
 *  2. the surrounding context text, if it occurs exactly once,
 *  3. null — the caller should list the event rather than guess.
 */
export function resolveEventPosition(doc: Y.Doc, ytext: Y.Text, ev: DocActivityEvent): number | null {
  if (ev.anchor) {
    try {
      const rel = Y.decodeRelativePosition(ev.anchor);
      const abs = Y.createAbsolutePositionFromRelativePosition(rel, doc);
      if (abs && abs.type === ytext) return abs.index;
    } catch {
      // fall through to context search
    }
  }
  const text = ytext.toString();
  const unique = (needle: string): number => {
    if (!needle) return -1;
    const first = text.indexOf(needle);
    if (first === -1) return -1;
    return text.indexOf(needle, first + 1) === -1 ? first : -1;
  };
  const before = unique(ev.ctxBefore);
  if (before !== -1) return before + ev.ctxBefore.length;
  const after = unique(ev.ctxAfter);
  if (after !== -1) return after;
  return null;
}

/** "5 min ago" style label. */
export function formatEventAge(ts: number, now = Date.now()): string {
  const ms = Math.max(0, now - ts);
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(ms / 3600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(ms / 86400_000);
  return `${days}d ago`;
}
