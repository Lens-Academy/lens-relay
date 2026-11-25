/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { CommentCard } from './CommentCard';
import type { ThreadView, MessageView } from './types';

function message(over: Partial<MessageView> = {}): MessageView {
  return {
    id: 'alice|1700000000000',
    author: 'Alice',
    body: 'Hello world',
    timestamp: '1700000000000',
    canModify: true,
    ...over,
  };
}

function thread(over: Partial<ThreadView> = {}): ThreadView {
  return {
    key: '100',
    root: message(),
    replies: [],
    order: 1,
    orphan: false,
    ...over,
  };
}

describe('CommentCard', () => {
  afterEach(cleanup);

  it('renders root body, author, and badge number', () => {
    render(
      <CommentCard
        thread={thread()}
        number={1}
        focused={false}
        onFocus={vi.fn()}
        onReply={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    expect(screen.getByText('Hello world')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('has no ••• menu when there is nothing to do with the message', () => {
    const t = thread({ root: message({ canModify: false }) });
    render(
      <CommentCard
        thread={t}
        focused
        onFocus={vi.fn()}
        onReply={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
  });

  it('Edit flow submits via onEdit(message, body)', () => {
    const t = thread();
    const onEdit = vi.fn();
    render(
      <CommentCard
        thread={t}
        focused
        onFocus={vi.fn()}
        onReply={vi.fn()}
        onEdit={onEdit}
        onDelete={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    // The AddCommentForm pre-fills with initialValue=body
    const textarea = screen.getByDisplayValue('Hello world') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'updated' } });
    // Find the Save submit button — submitLabel="Save"
    fireEvent.click(screen.getByText('Save'));
    expect(onEdit).toHaveBeenCalledWith(t.root, 'updated');
  });

  it('Delete flow calls onDelete(message)', () => {
    const t = thread();
    const onDelete = vi.fn();
    render(
      <CommentCard
        thread={t}
        focused
        onFocus={vi.fn()}
        onReply={vi.fn()}
        onEdit={vi.fn()}
        onDelete={onDelete}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    // Confirm dialog has its own "Delete" button via confirmLabel
    const dialogButtons = screen.getAllByText('Delete');
    // Click the confirm button (last one rendered — in the dialog)
    fireEvent.click(dialogButtons[dialogButtons.length - 1]);
    expect(onDelete).toHaveBeenCalledWith(t.root);
  });

  it("offers Delete but not Edit on someone else's comment when canDelete", () => {
    const t = thread({ root: message({ canModify: false, canDelete: true }) });
    const onDelete = vi.fn();
    render(
      <CommentCard
        thread={t}
        focused
        onFocus={vi.fn()}
        onReply={vi.fn()}
        onEdit={vi.fn()}
        onDelete={onDelete}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(screen.getByText(/Delete Alice's comment for everyone/)).toBeInTheDocument();
    const dialogButtons = screen.getAllByText('Delete');
    fireEvent.click(dialogButtons[dialogButtons.length - 1]);
    expect(onDelete).toHaveBeenCalledWith(t.root);
  });

  it('an open card has the reply bar, which sends with onReply(thread, body)', () => {
    const t = thread();
    const onReply = vi.fn();
    render(
      <CommentCard
        thread={t}
        focused
        onFocus={vi.fn()}
        onReply={onReply}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    const replyArea = screen.getByPlaceholderText('Reply…');
    fireEvent.change(replyArea, { target: { value: 'thanks' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onReply).toHaveBeenCalledWith(t, 'thanks');
  });

  it('opens on a click (onFocus with thread.key), and has no reply bar while closed', () => {
    const t = thread({ key: '42' });
    const onFocus = vi.fn();
    render(
      <CommentCard
        thread={t}
        focused={false}
        onFocus={onFocus}
        onReply={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    expect(screen.queryByPlaceholderText('Reply…')).toBeNull();
    fireEvent.click(screen.getByText('Hello world'));
    expect(onFocus).toHaveBeenCalledWith('42');
  });

  it('shows reactions, and toggles one from its pill or the picker', () => {
    const root = message({ reactions: [{ emoji: '👍', names: ['Bob', 'Alice'], mine: true }] });
    const onReact = vi.fn();
    render(
      <CommentCard
        thread={thread({ root })}
        focused
        onFocus={vi.fn()}
        onReply={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onReact={onReact}
      />
    );
    const pill = screen.getByTitle('Bob, Alice');
    expect(pill).toHaveTextContent('👍2');
    expect(pill).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(pill);
    expect(onReact).toHaveBeenLastCalledWith(root, '👍');

    fireEvent.click(screen.getByRole('button', { name: 'Add reaction' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'React with 🎉' }));
    expect(onReact).toHaveBeenLastCalledWith(root, '🎉');
  });

  it('resolves from the first message and copies a link from the ••• menu', () => {
    const t = thread({ replies: [message({ id: 'bob|1', author: 'Bob', body: 'Reply', canModify: false })] });
    const onResolve = vi.fn();
    const onCopyLink = vi.fn();
    render(
      <CommentCard
        thread={t}
        focused
        onFocus={vi.fn()}
        onReply={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        actions={{ onResolve, onCopyLink }}
      />
    );
    // One resolve tick, on the first message
    const resolve = screen.getAllByRole('button', { name: 'Resolve' });
    expect(resolve).toHaveLength(1);
    fireEvent.click(resolve[0]);
    expect(onResolve).toHaveBeenCalledWith(t);

    fireEvent.click(screen.getAllByRole('button', { name: 'More actions' })[1]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }));
    expect(onCopyLink).toHaveBeenCalledWith(t);
  });
});
