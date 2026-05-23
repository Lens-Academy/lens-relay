import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CommentCard } from './CommentCard';
import type { CommentThread } from '../../lib/criticmarkup-parser';

function thread(): CommentThread {
  return {
    from: 0,
    to: 10,
    comments: [
      {
        type: 'comment',
        from: 0,
        to: 10,
        contentFrom: 2,
        contentTo: 8,
        content: 'Hello world',
        metadata: { author: 'Alice', timestamp: 1700000000000 },
      },
    ],
  };
}

describe('CommentCard', () => {
  it('renders the root content and author', () => {
    render(
      <CommentCard
        thread={thread()}
        top={100}
        focused={false}
        currentUserName="Bob"
        onFocus={vi.fn()}
        onReply={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText('Hello world')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('shows Edit and Delete only when the current user is the author', () => {
    const t = thread();
    const { rerender } = render(
      <CommentCard
        thread={t}
        top={0}
        focused
        currentUserName="Alice"
        onFocus={vi.fn()} onReply={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /edit/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).toBeInTheDocument();

    rerender(
      <CommentCard
        thread={t}
        top={0}
        focused
        currentUserName="Bob"
        onFocus={vi.fn()} onReply={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('calls onFocus when the card is clicked', async () => {
    const onFocus = vi.fn();
    const { container } = render(
      <CommentCard
        thread={thread()}
        top={0} focused={false} currentUserName="Bob"
        onFocus={onFocus} onReply={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()}
      />,
    );
    (container.firstChild as HTMLElement).click();
    expect(onFocus).toHaveBeenCalledWith(0);
  });
});
