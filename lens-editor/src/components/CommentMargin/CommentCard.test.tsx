/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, within, fireEvent } from '@testing-library/react';
import { CommentCard } from './CommentCard';
import type { CommentThread } from '../../lib/criticmarkup-parser';

function makeThread(comments: Array<{ content: string; author?: string; timestamp?: number }>): CommentThread {
  let pos = 0;
  const ranges = comments.map((c) => {
    const meta = JSON.stringify({ author: c.author ?? 'alice', timestamp: c.timestamp ?? 1000 });
    const markup = `{>>${meta}@@${c.content}<<}`;
    const from = pos;
    const to = pos + markup.length;
    const metaLength = meta.length + 2; // meta + @@
    const contentFrom = from + 3 + metaLength;
    const contentTo = to - 3;
    pos = to;
    return {
      type: 'comment' as const,
      from,
      to,
      contentFrom,
      contentTo,
      content: c.content,
      metadata: { author: c.author ?? 'alice', timestamp: c.timestamp ?? 1000 },
    };
  });
  return {
    comments: ranges,
    from: ranges[0].from,
    to: ranges[ranges.length - 1].to,
  };
}

describe('CommentCard', () => {
  afterEach(cleanup);

  it('renders root comment content', () => {
    const thread = makeThread([{ content: 'Hello world' }]);
    const { container } = render(
      <CommentCard
        thread={thread}
        badgeNumber={1}
        focused={false}
        onFocus={() => {}}
        onReply={() => {}}
        onScrollToComment={() => {}}
      />
    );
    expect(container.textContent).toContain('Hello world');
  });

  it('renders author name', () => {
    const thread = makeThread([{ content: 'test', author: 'bob' }]);
    const { container } = render(
      <CommentCard
        thread={thread}
        badgeNumber={1}
        focused={false}
        onFocus={() => {}}
        onReply={() => {}}
        onScrollToComment={() => {}}
      />
    );
    expect(container.textContent).toContain('bob');
  });

  it('shows reply count when thread has replies', () => {
    const thread = makeThread([
      { content: 'root' },
      { content: 'reply 1' },
      { content: 'reply 2' },
    ]);
    const { container } = render(
      <CommentCard
        thread={thread}
        badgeNumber={1}
        focused={false}
        onFocus={() => {}}
        onReply={() => {}}
        onScrollToComment={() => {}}
      />
    );
    expect(container.textContent).toContain('2 replies');
  });

  it('shows badge number', () => {
    const thread = makeThread([{ content: 'test' }]);
    const { container } = render(
      <CommentCard
        thread={thread}
        badgeNumber={3}
        focused={false}
        onFocus={() => {}}
        onReply={() => {}}
        onScrollToComment={() => {}}
      />
    );
    expect(container.textContent).toContain('3');
  });

  it('calls onFocus when clicked', () => {
    const onFocus = vi.fn();
    const thread = makeThread([{ content: 'test' }]);
    const { container } = render(
      <CommentCard
        thread={thread}
        badgeNumber={1}
        focused={false}
        onFocus={onFocus}
        onReply={() => {}}
        onScrollToComment={() => {}}
      />
    );
    fireEvent.click(container.querySelector('.comment-card')!);
    expect(onFocus).toHaveBeenCalled();
  });

  it('applies focused styling when focused', () => {
    const thread = makeThread([{ content: 'test' }]);
    const { container } = render(
      <CommentCard
        thread={thread}
        badgeNumber={1}
        focused={true}
        onFocus={() => {}}
        onReply={() => {}}
        onScrollToComment={() => {}}
      />
    );
    const card = container.querySelector('.comment-card');
    expect(card?.classList.contains('comment-card-focused')).toBe(true);
  });

  it('has Reply button', () => {
    const thread = makeThread([{ content: 'test' }]);
    const { container } = render(
      <CommentCard
        thread={thread}
        badgeNumber={1}
        focused={false}
        onFocus={() => {}}
        onReply={() => {}}
        onScrollToComment={() => {}}
      />
    );
    const replyBtn = container.querySelector('button');
    expect(replyBtn?.textContent).toContain('Reply');
  });
});
