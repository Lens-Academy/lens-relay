import { describe, it, expect } from 'vitest';
import type { ThreadKey, MessageView, ThreadView, ScrollSource } from './types';

describe('Comments types', () => {
  it('ThreadKey is a string alias', () => {
    // ThreadKey is just a string, so we validate by assignment
    const key: ThreadKey = 'some-thread-id';
    expect(typeof key).toBe('string');
  });

  it('MessageView shape is correct', () => {
    const m: MessageView = {
      id: 'msg-1',
      author: 'alice',
      body: 'hi',
      timestamp: '2026-05-24T00:00:00Z',
      canModify: true,
    };
    expect(m.id).toBe('msg-1');
    expect(m.author).toBe('alice');
    expect(m.body).toBe('hi');
    expect(m.timestamp).toBe('2026-05-24T00:00:00Z');
    expect(m.canModify).toBe(true);
  });

  it('ThreadView shape is correct', () => {
    const t: ThreadView = {
      key: '100',
      root: {
        id: 'r',
        author: 'a',
        body: 'b',
        timestamp: 't',
        canModify: false,
      },
      replies: [],
      order: 1,
      orphan: false,
    };
    expect(t.key).toBe('100');
    expect(t.root.id).toBe('r');
    expect(t.replies).toHaveLength(0);
    expect(t.order).toBe(1);
    expect(t.orphan).toBe(false);
  });

  it('ScrollSource interface is satisfied by implementation', () => {
    const scrollSource: ScrollSource = {
      getScrollTop: () => 0,
      getScrollHeight: () => 1000,
      getClientHeight: () => 800,
      subscribe: () => () => {}, // unsubscribe function
    };
    expect(typeof scrollSource.getScrollTop).toBe('function');
    expect(typeof scrollSource.getScrollHeight).toBe('function');
    expect(typeof scrollSource.getClientHeight).toBe('function');
    expect(typeof scrollSource.subscribe).toBe('function');
  });
});
