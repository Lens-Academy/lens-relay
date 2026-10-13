import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { readMdResolve, setMdResolved, mdResolveMap } from './md-comment-resolve';
import { parse } from './criticmarkup-parser';

const COMMENT = 'Hi {>>{"author":"alice","timestamp":1}@@please fix<<} end';
const ROOT_ID = 'alice|1';

function docWithComment() {
  const doc = new Y.Doc();
  doc.getText('contents').insert(0, COMMENT);
  return doc;
}

describe('md-comment-resolve', () => {
  it('records and reads resolve state keyed by the thread root id', () => {
    const doc = docWithComment();
    expect(readMdResolve(doc, ROOT_ID)).toBeNull();

    setMdResolved(doc, ROOT_ID, true, 'bob');

    const info = readMdResolve(doc, ROOT_ID);
    expect(info?.by).toBe('bob');
    expect(typeof info?.at).toBe('number');
  });

  it('reopening clears the resolve entry', () => {
    const doc = docWithComment();
    setMdResolved(doc, ROOT_ID, true, 'bob');
    setMdResolved(doc, ROOT_ID, false, 'bob');
    expect(readMdResolve(doc, ROOT_ID)).toBeNull();
  });

  it('never touches the document text', () => {
    const doc = docWithComment();
    setMdResolved(doc, ROOT_ID, true, 'bob');
    // The markdown is byte-for-byte unchanged — resolve state lives out of band.
    expect(doc.getText('contents').toString()).toBe(COMMENT);
    const comment = parse(doc.getText('contents').toString()).find(r => r.type === 'comment')!;
    expect(comment.content).toBe('please fix');
    expect(comment.metadata?.author).toBe('alice');
  });

  it('two peers resolving the same thread converge without corrupting the text', () => {
    // The bug the inline-metadata approach had: a delete+insert at one offset
    // on both peers duplicated the header and corrupted the comment body. A
    // Y.Map entry is last-writer-wins, so both peers converge cleanly.
    const a = docWithComment();
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a)); // b starts in sync with a

    // Offline: both resolve the same thread, naming different resolvers.
    setMdResolved(a, ROOT_ID, true, 'bob');
    setMdResolved(b, ROOT_ID, true, 'carol');

    // Exchange updates both ways.
    const ua = Y.encodeStateAsUpdate(a);
    const ub = Y.encodeStateAsUpdate(b);
    Y.applyUpdate(a, ub);
    Y.applyUpdate(b, ua);

    // Both converge to the same single resolve entry and identical text.
    expect(a.getText('contents').toString()).toBe(COMMENT);
    expect(b.getText('contents').toString()).toBe(COMMENT);
    expect(mdResolveMap(a).size).toBe(1);
    expect(readMdResolve(a, ROOT_ID)).toEqual(readMdResolve(b, ROOT_ID));
    expect(readMdResolve(a, ROOT_ID)?.by).toMatch(/^(bob|carol)$/);
  });

  it('resolve and reopen racing converge to one deterministic state', () => {
    const a = docWithComment();
    setMdResolved(a, ROOT_ID, true, 'bob');
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a)); // both resolved

    // a reopens, b resolves again (with a different resolver) while offline.
    setMdResolved(a, ROOT_ID, false, 'bob');
    setMdResolved(b, ROOT_ID, true, 'carol');

    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    // Converged and text untouched, whichever side won.
    expect(readMdResolve(a, ROOT_ID)).toEqual(readMdResolve(b, ROOT_ID));
    expect(a.getText('contents').toString()).toBe(COMMENT);
  });
});
