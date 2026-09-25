import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  addMessage, commentsMap, createThread, deleteMessage, editMessage, readThreads, recordSeen,
  setThreadAnchor, setThreadStatus,
} from './thread-store';
import type { TextAnchor } from '../anchoring/types';

const anchor: TextAnchor = {
  v: 1, kind: 'text', quote: 'hello', prefix: '', suffix: ' world', position: { start: 0, end: 5, total: 11 },
};

describe('thread store', () => {
  it('creates, replies, edits and deletes', () => {
    const doc = new Y.Doc();
    const id = createThread(doc, 'o', { anchor, author: 'Ann', authorId: 'a1', body: 'First', ts: 1 });
    const replyId = addMessage(doc, 'o', id, { author: 'Bob', body: 'Second', ts: 2 })!;
    editMessage(doc, 'o', id, replyId, 'Second, edited');
    let [thread] = readThreads(doc);
    expect(thread).toMatchObject({ id, anchor, status: 'open', createdBy: 'Ann', createdAt: 1 });
    expect(thread.messages.map(m => [m.author, m.body])).toEqual([['Ann', 'First'], ['Bob', 'Second, edited']]);
    expect(thread.messages[1].editedAt).toBeGreaterThan(0);

    deleteMessage(doc, 'o', id, replyId);
    [thread] = readThreads(doc);
    expect(thread.messages).toHaveLength(1);
    deleteMessage(doc, 'o', id, thread.messages[0].id);
    expect(readThreads(doc)).toHaveLength(0);
  });

  it('merges concurrent replies from two clients', () => {
    const a = new Y.Doc();
    const id = createThread(a, 'o', { anchor, author: 'Ann', body: 'Root', ts: 1 });
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    addMessage(a, 'o', id, { author: 'Ann', body: 'From A', ts: 2 });
    addMessage(b, 'o', id, { author: 'Bob', body: 'From B', ts: 3 });
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(readThreads(a)[0].messages.map(m => m.body)).toEqual(['Root', 'From A', 'From B']);
    expect(readThreads(b)).toEqual(readThreads(a));
  });

  it('resolves, reopens on reply, and records what was seen', () => {
    const doc = new Y.Doc();
    const id = createThread(doc, 'o', { anchor, author: 'Ann', body: 'Root' });
    setThreadStatus(doc, 'o', id, 'resolved', 'Bob');
    expect(readThreads(doc)[0]).toMatchObject({ status: 'resolved', resolvedBy: 'Bob' });
    addMessage(doc, 'o', id, { author: 'Ann', body: 'Not fixed yet' });
    expect(readThreads(doc)[0].status).toBe('open');
    expect(readThreads(doc)[0].resolvedBy).toBeUndefined();

    recordSeen(doc, 'o', id, 'guessed');
    const at = readThreads(doc)[0].seen!.at;
    recordSeen(doc, 'o', id, 'guessed'); // unchanged: no write
    expect(readThreads(doc)[0].seen).toEqual({ state: 'guessed', at });
  });

  it('keeps the original quote when an anchor is replaced', () => {
    const doc = new Y.Doc();
    const id = createThread(doc, 'o', { anchor, author: 'Ann', body: 'Root' });
    recordSeen(doc, 'o', id, 'orphaned');
    setThreadAnchor(doc, 'o', id, { ...anchor, quote: 'hullo' });
    setThreadAnchor(doc, 'o', id, { ...anchor, quote: 'hallo' });
    const [thread] = readThreads(doc);
    expect(thread.anchor).toMatchObject({ quote: 'hallo' });
    expect(thread.originalQuote).toBe('hello');
    expect(thread.seen).toBeUndefined();
  });

  it('skips malformed entries written by other clients', () => {
    const doc = new Y.Doc();
    commentsMap(doc).set('junk', 'not a map' as never);
    const bad = new Y.Map<unknown>();
    bad.set('anchor', { kind: 'text', quote: 'x' });
    commentsMap(doc).set('empty', bad as never); // no messages
    expect(readThreads(doc)).toEqual([]);
  });
});
