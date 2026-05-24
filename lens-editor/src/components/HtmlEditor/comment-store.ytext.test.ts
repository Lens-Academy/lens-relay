import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  addComment,
  addReply,
  editMessage,
  deleteMessage,
  parseComments,
} from './comment-store';

const ORIGIN = Symbol('test-origin');

function newDoc(initial = ''): { doc: Y.Doc; ytext: Y.Text } {
  const doc = new Y.Doc();
  const ytext = doc.getText('contents');
  if (initial) ytext.insert(0, initial);
  return { doc, ytext };
}

describe('addComment', () => {
  it('inserts a comment marker at the given source position', () => {
    const { ytext } = newDoc('<p>Hello world</p>');
    addComment(ytext, ORIGIN, {
      id: 'c1', author: 'luc', ts: 't1', body: 'why?', position: 14,
    });
    const after = ytext.toString();
    expect(after).toContain('<p>Hello world[[@comment:c1]]<!--lens-comment ');
    expect(parseComments(after)).toHaveLength(1);
    expect(parseComments(after)[0].comment.body).toBe('why?');
  });
});

describe('addReply', () => {
  it('inserts a reply marker immediately after the last marker in the cluster', () => {
    const { ytext } = newDoc(
      '<p>X</p><!--lens-comment {"id":"c1","author":"a","ts":"t","body":"q"}--><p>Y</p>'
    );
    addReply(ytext, ORIGIN, {
      id: 'r1', parent: 'c1', author: 'b', ts: 't2', body: 'answer',
    });
    const clusters = parseComments(ytext.toString());
    expect(clusters[0].replies).toHaveLength(1);
    expect(clusters[0].replies[0].body).toBe('answer');
    const parentEnd = ytext.toString().indexOf('-->') + 3;
    expect(ytext.toString().slice(parentEnd, parentEnd + '<!--lens-reply'.length)).toBe('<!--lens-reply');
  });

  it('appends to existing replies (preserves order)', () => {
    const { ytext } = newDoc(
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"q"}-->' +
      '<!--lens-reply {"id":"r1","parent":"c1","author":"b","ts":"t2","body":"first"}-->'
    );
    addReply(ytext, ORIGIN, { id: 'r2', parent: 'c1', author: 'c', ts: 't3', body: 'second' });
    expect(parseComments(ytext.toString())[0].replies.map(r => r.body)).toEqual(['first', 'second']);
  });
});

describe('editMessage', () => {
  it('atomically replaces a comment marker preserving cluster integrity', () => {
    const { doc, ytext } = newDoc(
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"old"}-->' +
      '<!--lens-reply {"id":"r1","parent":"c1","author":"b","ts":"t2","body":"x"}-->'
    );
    let transactionCount = 0;
    doc.on('afterTransaction', () => { transactionCount++; });
    editMessage(ytext, ORIGIN, { id: 'c1', newBody: 'new' });
    expect(parseComments(ytext.toString())[0].comment.body).toBe('new');
    expect(parseComments(ytext.toString())[0].replies).toHaveLength(1);
    expect(transactionCount).toBe(1);
  });

  it('edits a reply by id', () => {
    const { ytext } = newDoc(
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"q"}-->' +
      '<!--lens-reply {"id":"r1","parent":"c1","author":"b","ts":"t2","body":"old reply"}-->'
    );
    editMessage(ytext, ORIGIN, { id: 'r1', newBody: 'new reply' });
    expect(parseComments(ytext.toString())[0].replies[0].body).toBe('new reply');
  });

  it('edits the live clustered reply when a malformed duplicate marker appears earlier', () => {
    const malformed = '<!--lens-reply {"id":"r1"}-->';
    const { ytext } = newDoc(
      malformed +
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"q"}-->' +
      '<!--lens-reply {"id":"r1","parent":"c1","author":"b","ts":"t2","body":"old reply"}-->'
    );
    editMessage(ytext, ORIGIN, { id: 'r1', newBody: 'new reply' });
    expect(ytext.toString()).toContain(malformed);
    expect(parseComments(ytext.toString())[0].replies[0].body).toBe('new reply');
  });
});

describe('deleteMessage', () => {
  it('deleting a reply removes only that reply marker', () => {
    const { ytext } = newDoc(
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"q"}-->' +
      '<!--lens-reply {"id":"r1","parent":"c1","author":"b","ts":"t2","body":"x"}-->' +
      '<!--lens-reply {"id":"r2","parent":"c1","author":"c","ts":"t3","body":"y"}-->'
    );
    deleteMessage(ytext, ORIGIN, 'r1');
    const clusters = parseComments(ytext.toString());
    expect(clusters[0].replies.map(r => r.id)).toEqual(['r2']);
  });

  it('deletes the live clustered reply when a malformed duplicate marker appears earlier', () => {
    const malformed = '<!--lens-reply {"id":"r1"}-->';
    const { ytext } = newDoc(
      malformed +
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"q"}-->' +
      '<!--lens-reply {"id":"r1","parent":"c1","author":"b","ts":"t2","body":"x"}-->' +
      '<!--lens-reply {"id":"r2","parent":"c1","author":"c","ts":"t3","body":"y"}-->'
    );
    deleteMessage(ytext, ORIGIN, 'r1');
    expect(ytext.toString()).toContain(malformed);
    const clusters = parseComments(ytext.toString());
    expect(clusters[0].replies.map(r => r.id)).toEqual(['r2']);
  });

  it('deleting a parent comment cascades to replies in one transaction', () => {
    const { doc, ytext } = newDoc(
      '<p>A</p>' +
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"q"}-->' +
      '<!--lens-reply {"id":"r1","parent":"c1","author":"b","ts":"t2","body":"x"}-->' +
      '<p>B</p>'
    );
    let transactionCount = 0;
    doc.on('afterTransaction', () => { transactionCount++; });
    deleteMessage(ytext, ORIGIN, 'c1');
    expect(parseComments(ytext.toString())).toEqual([]);
    expect(ytext.toString()).toBe('<p>A</p><p>B</p>');
    expect(transactionCount).toBe(1);
  });

  it('does not open a transaction when deleting a missing id', () => {
    const { doc, ytext } = newDoc(
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"q"}-->'
    );
    let transactionCount = 0;
    doc.on('afterTransaction', () => { transactionCount++; });
    expect(() => deleteMessage(ytext, ORIGIN, 'missing')).toThrow('deleteMessage: no message with id missing');
    expect(transactionCount).toBe(0);
  });
});
