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
        focused
        currentUserName="Bob"
        onFocus={vi.fn()} onReply={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('calls onFocus when the comment body text is clicked', () => {
    // Regression: a blanket stopPropagation on CommentRow's outer div was
    // swallowing clicks on the comment text, so only clicks on the bare card
    // root fired onFocus. Click on the text node to lock that contract.
    const onFocus = vi.fn();
    render(
      <CommentCard
        thread={thread()}
        focused={false} currentUserName="Bob"
        onFocus={onFocus} onReply={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()}
      />,
    );
    screen.getByText('Hello world').click();
    expect(onFocus).toHaveBeenCalledWith(0);
  });

  it('does not call onFocus when an action button is clicked', () => {
    const onFocus = vi.fn();
    render(
      <CommentCard
        thread={thread()}
        focused={false} currentUserName="Alice"
        onFocus={onFocus} onReply={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()}
      />,
    );
    screen.getByRole('button', { name: /reply/i }).click();
    expect(onFocus).not.toHaveBeenCalled();
  });
});
