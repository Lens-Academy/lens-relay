import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';
import { setCurrentAuthor } from '../components/Editor/extensions/criticmarkup';
import { parse, parseThreads, decodeCommentContent } from './criticmarkup-parser';
import {
  insertCommentInYText,
  replyInYText,
  deleteRangeInYText,
  editRangeContentInYText,
  isOwnRange,
} from './ytext-comment-ops';

describe('ytext-comment-ops', () => {
  let doc: Y.Doc;
  let ytext: Y.Text;

  beforeEach(() => {
    doc = new Y.Doc();
    ytext = doc.getText('contents');
    setCurrentAuthor('alice');
  });

  it('inserts a comment with author metadata that round-trips through the parser', () => {
    ytext.insert(0, 'Hello world.');
    insertCommentInYText(ytext, 'first thought', 5);

    const ranges = parse(ytext.toString());
    const comment = ranges.find(r => r.type === 'comment');
    expect(comment).toBeDefined();
    expect(comment?.metadata?.author).toBe('alice');
    expect(comment?.content).toBe('first thought');
  });

  it('replies append a second comment that parseThreads groups with the first', () => {
    ytext.insert(0, 'Hello.');
    insertCommentInYText(ytext, 'first', 5);

    // Reply at the end of the just-inserted thread
    const firstRanges = parse(ytext.toString());
    const first = firstRanges.find(r => r.type === 'comment')!;
    replyInYText(ytext, 'reply text', first.to);

    const threads = parseThreads(parse(ytext.toString()));
    expect(threads).toHaveLength(1);
    expect(threads[0].comments).toHaveLength(2);
    expect(threads[0].comments[0].content).toBe('first');
    expect(threads[0].comments[1].content).toBe('reply text');
  });

  it('deletes the entire criticmarkup range when deleteRangeInYText is called', () => {
    ytext.insert(0, 'Before.');
    insertCommentInYText(ytext, 'doomed', 6);
    const before = parse(ytext.toString()).find(r => r.type === 'comment')!;

    deleteRangeInYText(ytext, before);

    expect(parse(ytext.toString())).toHaveLength(0);
    expect(ytext.toString()).toBe('Before.');
  });

  it('editRangeContentInYText replaces only the content slice, preserving metadata', () => {
    ytext.insert(0, 'Hi.');
    insertCommentInYText(ytext, 'old text', 2);
    const before = parse(ytext.toString()).find(r => r.type === 'comment')!;

    editRangeContentInYText(ytext, before, 'NEW text');

    const after = parse(ytext.toString()).find(r => r.type === 'comment')!;
    expect(after.content).toBe('NEW text');
    expect(after.metadata?.author).toBe('alice');
  });

  it('isOwnRange compares the author against the current author', () => {
    ytext.insert(0, 'Body.');
    setCurrentAuthor('alice');
    insertCommentInYText(ytext, 'mine', 4);
    setCurrentAuthor('bob');
    insertCommentInYText(ytext, 'theirs', 4);

    const ranges = parse(ytext.toString()).filter(r => r.type === 'comment');
    expect(ranges).toHaveLength(2);

    setCurrentAuthor('alice');
    const own = ranges.filter(isOwnRange);
    expect(own).toHaveLength(1);
    expect(own[0].content).toBe('mine');
  });

  it('roundtrips multi-line comment content through the encode/decode pair', () => {
    ytext.insert(0, 'Body.');
    insertCommentInYText(ytext, 'line one\nline two\\with-backslash', 4);
    const range = parse(ytext.toString()).find(r => r.type === 'comment')!;
    // The parser returns the raw stored content (still escaped); the sidebar
    // calls decodeCommentContent before display. We assert the round trip
    // recovers the original.
    expect(decodeCommentContent(range.content)).toBe('line one\nline two\\with-backslash');
  });
});
