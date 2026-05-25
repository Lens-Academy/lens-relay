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

  it('hides Edit/Delete when canModify is false', () => {
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
    expect(screen.queryByText('Edit')).toBeNull();
    expect(screen.queryByText('Delete')).toBeNull();
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
    fireEvent.click(screen.getByText('Edit'));
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
    fireEvent.click(screen.getByText('Delete'));
    // Confirm dialog has its own "Delete" button via confirmLabel
    const dialogButtons = screen.getAllByText('Delete');
    // Click the confirm button (last one rendered — in the dialog)
    fireEvent.click(dialogButtons[dialogButtons.length - 1]);
    expect(onDelete).toHaveBeenCalledWith(t.root);
  });

  it('Reply flow calls onReply(thread, body)', () => {
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
    fireEvent.click(screen.getByText('Reply'));
    // Find the Reply form's textarea by looking at the most recently rendered one
    // (the edit form is for the root, the reply form is the new one)
    const textareas = screen.getAllByRole('textbox') as HTMLTextAreaElement[];
    const replyArea = textareas[textareas.length - 1];
    fireEvent.change(replyArea, { target: { value: 'thanks' } });
    fireEvent.click(screen.getByText('Send'));
    expect(onReply).toHaveBeenCalledWith(t, 'thanks');
  });

  it('onFocus called with thread.key on click', () => {
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
    fireEvent.click(screen.getByText('Hello world'));
    expect(onFocus).toHaveBeenCalledWith('42');
  });
});
