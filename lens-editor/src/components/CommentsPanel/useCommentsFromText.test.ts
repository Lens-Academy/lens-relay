import { describe, it, expect } from 'vitest';
import { useCommentsFromText } from './useComments';

describe('useCommentsFromText', () => {
  it('returns an empty array when text is null or empty', () => {
    expect(useCommentsFromText(null)).toEqual([]);
    expect(useCommentsFromText('')).toEqual([]);
  });

  it('returns no threads for plain text without criticmarkup', () => {
    expect(useCommentsFromText('Just some prose without comments.')).toEqual([]);
  });

  it('groups adjacent comments into one thread', () => {
    // Two comment ranges with no gap between them — parseThreads should fold
    // them into a single thread of two messages.
    const text =
      'Para. {>>{"author":"alice","timestamp":1}@@first<<}{>>{"author":"bob","timestamp":2}@@reply<<}';
    const threads = useCommentsFromText(text);
    expect(threads).toHaveLength(1);
    expect(threads[0].comments).toHaveLength(2);
    expect(threads[0].comments[0].content).toBe('first');
    expect(threads[0].comments[1].content).toBe('reply');
  });

  it('does not collapse non-adjacent threads', () => {
    const text =
      'A {>>{"author":"alice","timestamp":1}@@first<<} middle {>>{"author":"bob","timestamp":2}@@second<<} end';
    const threads = useCommentsFromText(text);
    expect(threads).toHaveLength(2);
    expect(threads[0].comments).toHaveLength(1);
    expect(threads[1].comments).toHaveLength(1);
  });
});
