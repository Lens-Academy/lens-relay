import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  ACTIVITY_MAP,
  eventCoversItems,
  formatEventAge,
  parseActivityEvent,
  readActivityEvents,
  resolveEventPosition,
} from './activity';

function rawEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    ts: 1_000,
    actor: 'ai:fable-5:luc',
    author: "Luc's AI",
    mode: 'direct',
    kind: 'replace',
    old: 'old',
    new: 'new',
    old_truncated: false,
    new_truncated: false,
    ctx_before: 'before ',
    ctx_after: ' after',
    pos: 7,
    client: 42,
    clock_from: 10,
    clock_to: 13,
    ...overrides,
  };
}

describe('activity events', () => {
  it('parses well-formed entries and skips malformed ones', () => {
    const ev = parseActivityEvent('e1', rawEvent({ anchor: new Uint8Array([0, 42, 5, 0]) }));
    expect(ev).not.toBeNull();
    expect(ev!.kind).toBe('replace');
    expect(ev!.clockFrom).toBe(10);
    expect(ev!.anchor).toBeInstanceOf(Uint8Array);
    expect(parseActivityEvent('bad', 'nope')).toBeNull();
    expect(parseActivityEvent('bad', rawEvent({ kind: 'weird' }))).toBeNull();
    expect(parseActivityEvent('bad', rawEvent({ ts: 'soon' }))).toBeNull();
  });

  it('reads events from the doc map sorted by time', () => {
    const doc = new Y.Doc();
    const map = doc.getMap(ACTIVITY_MAP);
    map.set('b', rawEvent({ ts: 2_000 }));
    map.set('a', rawEvent({ ts: 1_000 }));
    map.set('junk', 'x');
    expect(readActivityEvents(doc).map(e => e.id)).toEqual(['a', 'b']);
  });

  it('matches item clock ranges', () => {
    const ev = parseActivityEvent('e', rawEvent())!;
    expect(eventCoversItems(ev, 42, 10, 3)).toBe(true);
    expect(eventCoversItems(ev, 42, 12, 5)).toBe(true);
    expect(eventCoversItems(ev, 42, 13, 5)).toBe(false);
    expect(eventCoversItems(ev, 42, 0, 10)).toBe(false);
    expect(eventCoversItems(ev, 7, 10, 3)).toBe(false);
  });

  it('resolves the anchor written by another replica after later edits', () => {
    const server = new Y.Doc();
    const stext = server.getText('contents');
    stext.insert(0, 'hello world');
    // Anchor at "world" (index 6), Assoc::After — same encoding the relay writes.
    const rel = Y.createRelativePositionFromTypeIndex(stext, 6, 0);
    const anchor = Y.encodeRelativePosition(rel);

    const browser = new Y.Doc();
    Y.applyUpdate(browser, Y.encodeStateAsUpdate(server));
    const btext = browser.getText('contents');
    btext.insert(0, 'PREFIX '); // shifts everything after

    const ev = parseActivityEvent('e', rawEvent({ anchor }))!;
    expect(resolveEventPosition(browser, btext, ev)).toBe('PREFIX hello '.length);
  });

  it('falls back to unique context, then null', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, 'alpha before  after omega');
    const ev = parseActivityEvent('e', rawEvent({ anchor: undefined }))!;
    expect(resolveEventPosition(doc, ytext, ev)).toBe('alpha before '.length);

    ytext.insert(0, 'before before ');
    const ambiguous = parseActivityEvent('e', rawEvent({ ctx_after: 'zzz' }))!;
    expect(resolveEventPosition(doc, ytext, ambiguous)).toBeNull();
  });

  it('formats ages', () => {
    const now = 10_000_000;
    expect(formatEventAge(now - 10_000, now)).toBe('just now');
    expect(formatEventAge(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(formatEventAge(now - 3 * 3600_000, now)).toBe('3h ago');
    expect(formatEventAge(now - 2 * 86400_000, now)).toBe('2d ago');
  });
});
