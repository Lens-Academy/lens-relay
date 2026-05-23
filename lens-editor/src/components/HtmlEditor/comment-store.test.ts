import { describe, it, expect } from 'vitest';
import {
  parsePayload,
  parseComments,
  serializeComment,
  serializeReply,
  type CommentMarker,
  type ReplyMarker,
} from './comment-store';

describe('serializeComment', () => {
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
