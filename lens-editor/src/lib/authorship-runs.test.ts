import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { getAuthorshipRuns } from './authorship-runs';

function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
}

describe('getAuthorshipRuns', () => {
  it('returns an empty list for an empty text', () => {
    const doc = new Y.Doc();
    expect(getAuthorshipRuns(doc.getText('contents'))).toEqual([]);
  });

  it('attributes a single-writer text to one run', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, 'hello world');
    expect(getAuthorshipRuns(ytext)).toEqual([
      { from: 0, to: 11, client: doc.clientID },
    ]);
  });

  it('merges adjacent items from the same client', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    // Separate transactions create separate items.
    ytext.insert(0, 'aaa');
    ytext.insert(3, 'bbb');
    ytext.insert(0, 'ccc');
    expect(getAuthorshipRuns(ytext)).toEqual([
      { from: 0, to: 9, client: doc.clientID },
    ]);
  });

  it('splits runs at author boundaries and covers the full text', () => {
    const a = new Y.Doc();
    a.getText('contents').insert(0, 'aaaa');

    const b = new Y.Doc();
    sync(a, b);
    b.getText('contents').insert(2, 'BB');
    sync(a, b);

    const runs = getAuthorshipRuns(a.getText('contents'));
    expect(runs).toEqual([
      { from: 0, to: 2, client: a.clientID },
      { from: 2, to: 4, client: b.clientID },
      { from: 4, to: 6, client: a.clientID },
    ]);
    expect(a.getText('contents').toString()).toBe('aaBBaa');
  });

  it('skips deleted content', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, 'abcdef');
    ytext.delete(1, 3); // "aef"
    expect(getAuthorshipRuns(ytext)).toEqual([
      { from: 0, to: 3, client: doc.clientID },
    ]);
    expect(ytext.toString()).toBe('aef');
  });

  it('attributes edits after a clientID rotation to the new ID', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, 'old');
    const oldId = doc.clientID;
    doc.clientID = 424242;
    ytext.insert(3, 'new');
    expect(getAuthorshipRuns(ytext)).toEqual([
      { from: 0, to: 3, client: oldId },
      { from: 3, to: 6, client: 424242 },
    ]);
  });

  it('run boundaries survive a round-trip through encode/apply', () => {
    const a = new Y.Doc();
    a.getText('contents').insert(0, 'aaaa');
    const b = new Y.Doc();
    sync(a, b);
    b.getText('contents').insert(4, 'bbbb');

    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, Y.encodeStateAsUpdate(b));
    expect(getAuthorshipRuns(fresh.getText('contents'))).toEqual([
      { from: 0, to: 4, client: a.clientID },
      { from: 4, to: 8, client: b.clientID },
    ]);
  });
});
