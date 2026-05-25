import { describe, it, expect } from 'vitest';
import {
  addComment,
  deleteMessage,
  editMessage,
  parsePayload,
  parseComments,
  serializeCommentAnchor,
  serializeComment,
  serializeReply,
  type CommentMarker,
  type ReplyMarker,
} from './comment-store';
import * as Y from 'yjs';

describe('serializeComment', () => {
  it('emits a visible inline anchor for comment placement', () => {
    expect(serializeCommentAnchor('c1')).toBe('[[@comment:c1]]');
  });

  it('emits an HTML comment node with JSON payload', () => {
    const marker: CommentMarker = {
      kind: 'comment',
      id: 'c1',
      author: 'luc@x',
      ts: '2026-05-23T14:33:00Z',
      body: 'why?',
    };
    expect(serializeComment(marker)).toBe(
      '<!--lens-comment {"id":"c1","author":"luc@x","ts":"2026-05-23T14:33:00Z","body":"why?"}-->'
    );
  });

  it('encodes --> in body as \\u002d\\u002d> so the HTML comment is not terminated early', () => {
    const marker: CommentMarker = {
      kind: 'comment', id: 'c1', author: 'a', ts: 't', body: 'has --> in it',
    };
    const out = serializeComment(marker);
    expect(out).toContain('\\u002d\\u002d>');
    expect(out.indexOf('-->')).toBe(out.length - 3);
  });

  it('round-trips a body containing --> losslessly', () => {
    const marker: CommentMarker = {
      kind: 'comment', id: 'c1', author: 'a', ts: 't', body: 'see --> there',
    };
    const out = serializeComment(marker);
    const parsed = parseComments(out);
    expect(parsed[0].comment.body).toBe('see --> there');
  });

  it('round-trips a body containing literal { and } characters', () => {
    const marker: CommentMarker = {
      kind: 'comment', id: 'c1', author: 'a', ts: 't', body: 'has {nested} braces',
    };
    const parsed = parseComments(serializeComment(marker));
    expect(parsed[0].comment.body).toBe('has {nested} braces');
  });
});

describe('serializeReply', () => {
  it('emits an HTML comment node with reply JSON payload including parent', () => {
    const marker: ReplyMarker = {
      kind: 'reply',
      id: 'r1',
      parent: 'c1',
      author: 'luc@x',
      ts: '2026-05-23T14:34:00Z',
      body: 'because',
    };
    expect(serializeReply(marker)).toBe(
      '<!--lens-reply {"id":"r1","parent":"c1","author":"luc@x","ts":"2026-05-23T14:34:00Z","body":"because"}-->'
    );
  });
});

describe('parsePayload', () => {
  it('returns null for non-object and array JSON values', () => {
    expect(parsePayload('"x"')).toBeNull();
    expect(parsePayload('1')).toBeNull();
    expect(parsePayload('true')).toBeNull();
    expect(parsePayload('null')).toBeNull();
    expect(parsePayload('[]')).toBeNull();
  });
});

describe('parseComments', () => {
  it('returns empty for source with no markers', () => {
    expect(parseComments('<p>hello</p>')).toEqual([]);
  });

  it('parses a single top-level comment with correct source bounds', () => {
    const marker = '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->';
    const src = `before ${marker} after`;
    const result = parseComments(src);
    expect(result).toHaveLength(1);
    expect(result[0].comment).toEqual({ kind: 'comment', id: 'c1', author: 'a', ts: 't', body: 'x' });
    expect(result[0].replies).toEqual([]);
    expect(src.slice(result[0].sourceStart, result[0].sourceEnd)).toBe(marker);
  });

  it('parses an anchored parent comment with source bounds including the anchor', () => {
    const anchor = '[[@comment:c1]]';
    const marker = '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->';
    const src = `before ${anchor}${marker} after`;
    const result = parseComments(src);
    expect(result).toHaveLength(1);
    expect(src.slice(result[0].sourceStart, result[0].sourceEnd)).toBe(`${anchor}${marker}`);
  });

  it('clusters replies with their parent', () => {
    const src =
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->' +
      '\n<!--lens-reply {"id":"r1","parent":"c1","author":"b","ts":"t2","body":"y"}-->' +
      '\n<!--lens-reply {"id":"r2","parent":"c1","author":"a","ts":"t3","body":"z"}-->';
    const result = parseComments(src);
    expect(result).toHaveLength(1);
    expect(result[0].replies.map(r => r.id)).toEqual(['r1', 'r2']);
  });

  it('skips replies to earlier comments after an intervening comment without overlapping ranges', () => {
    const c1 = '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->';
    const c2 = '<!--lens-comment {"id":"c2","author":"b","ts":"t2","body":"y"}-->';
    const lateReply = '<!--lens-reply {"id":"r1","parent":"c1","author":"a","ts":"t3","body":"late"}-->';
    const src = c1 + '\n' + c2 + '\n' + lateReply;
    const result = parseComments(src);
    expect(result).toHaveLength(2);
    expect(result[0].comment.id).toBe('c1');
    expect(result[0].replies).toEqual([]);
    expect(src.slice(result[0].sourceStart, result[0].sourceEnd)).toBe(c1);
    expect(result[1].comment.id).toBe('c2');
    expect(result[1].replies).toEqual([]);
    expect(result[0].sourceEnd).toBeLessThanOrEqual(result[1].sourceStart);
  });

  it('round-trips: parse then serialize produces byte-equal source for canonical comment markers', () => {
    const src = 'X<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"y"}-->Y';
    const parsed = parseComments(src);
    const reSerialized = serializeComment(parsed[0].comment);
    expect(src.slice(parsed[0].sourceStart, parsed[0].sourceEnd)).toBe(reSerialized);
  });

  it('treats reply with non-matching parent as orphan data skipped from clusters', () => {
    const src = '<!--lens-reply {"id":"r1","parent":"missing","author":"a","ts":"t","body":"x"}-->';
    expect(parseComments(src)).toEqual([]);
  });

  it('ignores markers with malformed JSON', () => {
    const src = '<!--lens-comment {not json}-->' +
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"ok"}-->';
    expect(parseComments(src).map(c => c.comment.id)).toEqual(['c1']);
  });
});

describe('comment mutations', () => {
  function makeText(source: string) {
    const doc = new Y.Doc();
    const ytext = doc.getText('html');
    ytext.insert(0, source);
    return ytext;
  }

  it('addComment inserts a visible anchor immediately before the metadata marker', () => {
    const ytext = makeText('<p>Hello world</p>');
    addComment(ytext, null, {
      id: 'c1',
      author: 'a',
      ts: 't',
      body: 'x',
      position: 8,
    });

    expect(ytext.toString()).toBe(
      '<p>Hello[[@comment:c1]]<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}--> world</p>'
    );
  });

  it('editMessage preserves an anchored comment marker', () => {
    const ytext = makeText(
      '<p>Hello[[@comment:c1]]<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"old"}--> world</p>'
    );

    editMessage(ytext, null, { id: 'c1', newBody: 'new' });

    expect(ytext.toString()).toBe(
      '<p>Hello[[@comment:c1]]<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"new"}--> world</p>'
    );
  });

  it('deleteMessage removes the visible anchor with the parent comment cluster', () => {
    const ytext = makeText(
      '<p>Hello[[@comment:c1]]<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->' +
      '<!--lens-reply {"id":"r1","parent":"c1","author":"b","ts":"t2","body":"y"}--> world</p>'
    );

    deleteMessage(ytext, null, 'c1');

    expect(ytext.toString()).toBe('<p>Hello world</p>');
  });
});
