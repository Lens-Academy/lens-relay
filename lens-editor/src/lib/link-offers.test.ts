import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  LINK_OFFERS_MAP,
  dismissLinkOffers,
  markLinkOffersSeen,
  observeLinkOffers,
  readLinkOffers,
  readSeenLinkOffers,
  undoLinkOfferDismissal,
} from './link-offers';

/** Passes every update between two docs, as a relay would. */
function connect(a: Y.Doc, b: Y.Doc) {
  a.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== b) Y.applyUpdate(b, update, a);
  });
  b.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== a) Y.applyUpdate(a, update, b);
  });
}

describe('link_offers_v0', () => {
  it('reads as empty on a page nobody has dismissed anything on', () => {
    expect(readLinkOffers(new Y.Doc()).size).toBe(0);
  });

  it('records who dismissed each URL and when', () => {
    const doc = new Y.Doc();
    dismissLinkOffers(doc, ['https://a.example/1', 'https://a.example/2'], 'Luc', 1234);
    expect(Object.fromEntries(readLinkOffers(doc))).toEqual({
      'https://a.example/1': { at: 1234, by: 'Luc' },
      'https://a.example/2': { at: 1234, by: 'Luc' },
    });
  });

  it('dismisses a list in one transaction', () => {
    const doc = new Y.Doc();
    const updates = vi.fn();
    doc.on('update', updates);
    dismissLinkOffers(doc, ['https://a.example/1', 'https://a.example/2', 'https://a.example/3'], 'Luc');
    expect(updates).toHaveBeenCalledTimes(1);
  });

  it('keeps the first dismissal and writes nothing when there is nothing new', () => {
    const doc = new Y.Doc();
    dismissLinkOffers(doc, ['https://a.example/1'], 'Luc', 1);
    const updates = vi.fn();
    doc.on('update', updates);
    dismissLinkOffers(doc, ['https://a.example/1'], 'Sam', 2);
    dismissLinkOffers(doc, [], 'Sam', 2);
    expect(updates).not.toHaveBeenCalled();
    expect(readLinkOffers(doc).get('https://a.example/1')).toEqual({ at: 1, by: 'Luc' });
  });

  it('undoes one URL and leaves the others', () => {
    const doc = new Y.Doc();
    dismissLinkOffers(doc, ['https://a.example/1', 'https://a.example/2'], 'Luc');
    undoLinkOfferDismissal(doc, 'https://a.example/1');
    expect([...readLinkOffers(doc).keys()]).toEqual(['https://a.example/2']);
  });

  it('writes nothing when undoing a URL that was not dismissed', () => {
    const doc = new Y.Doc();
    const updates = vi.fn();
    doc.on('update', updates);
    undoLinkOfferDismissal(doc, 'https://a.example/1');
    expect(updates).not.toHaveBeenCalled();
  });

  it('reaches everyone on the page, and tells them', () => {
    const luc = new Y.Doc();
    const sam = new Y.Doc();
    connect(luc, sam);
    const heard = vi.fn();
    const stop = observeLinkOffers(sam, heard);

    dismissLinkOffers(luc, ['https://a.example/1'], 'Luc');
    expect(readLinkOffers(sam).has('https://a.example/1')).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);

    undoLinkOfferDismissal(sam, 'https://a.example/1');
    expect(readLinkOffers(luc).size).toBe(0);

    stop();
    dismissLinkOffers(luc, ['https://a.example/2'], 'Luc');
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('adds nothing else to the doc and leaves the text alone', () => {
    const doc = new Y.Doc();
    doc.getText('contents').insert(0, 'See https://a.example/1');
    dismissLinkOffers(doc, ['https://a.example/1'], 'Luc');
    expect([...doc.share.keys()].sort()).toEqual(['contents', LINK_OFFERS_MAP].sort());
    expect(doc.getText('contents').toString()).toBe('See https://a.example/1');
  });
});

describe('what this browser has been offered', () => {
  beforeEach(() => localStorage.clear());

  it('starts empty, and keeps what it is told, per page', () => {
    expect(readSeenLinkOffers('doc-a').size).toBe(0);
    markLinkOffersSeen('doc-a', ['https://a.example/1']);
    markLinkOffersSeen('doc-a', ['https://a.example/2', 'https://a.example/1']);
    expect([...readSeenLinkOffers('doc-a')]).toEqual(['https://a.example/1', 'https://a.example/2']);
    expect(readSeenLinkOffers('doc-b').size).toBe(0);
  });

  it('writes nothing to the doc', () => {
    const doc = new Y.Doc();
    const updates = vi.fn();
    doc.on('update', updates);
    markLinkOffersSeen('doc-a', ['https://a.example/1']);
    expect(updates).not.toHaveBeenCalled();
  });

  it('keeps the newest when a page has more than it holds', () => {
    const urls = Array.from({ length: 600 }, (_, i) => `https://a.example/${i}`);
    markLinkOffersSeen('doc-a', urls);
    const seen = readSeenLinkOffers('doc-a');
    expect(seen.size).toBe(500);
    expect(seen.has('https://a.example/599')).toBe(true);
    expect(seen.has('https://a.example/0')).toBe(false);
  });

  it('survives something unreadable in storage', () => {
    localStorage.setItem('lens-editor:seen-link-offers:doc-a', 'not json');
    expect(readSeenLinkOffers('doc-a').size).toBe(0);
    localStorage.setItem('lens-editor:seen-link-offers:doc-a', '{"a":1}');
    expect(readSeenLinkOffers('doc-a').size).toBe(0);
    localStorage.setItem('lens-editor:seen-link-offers:doc-a', '["https://a.example/1",7]');
    expect([...readSeenLinkOffers('doc-a')]).toEqual(['https://a.example/1']);
  });

  it('survives storage that refuses', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(readSeenLinkOffers('doc-a').size).toBe(0);
    expect(() => markLinkOffersSeen('doc-a', ['https://a.example/1'])).not.toThrow();
    getItem.mockRestore();
    setItem.mockRestore();
  });
});
