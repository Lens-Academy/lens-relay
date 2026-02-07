// src/components/CommentsPanel/AddCommentForm.test.tsx
/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddCommentForm } from './AddCommentForm';

describe('AddCommentForm', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders textarea and submit button', () => {
    render(<AddCommentForm onSubmit={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByPlaceholderText(/add a comment/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add/i })).toBeInTheDocument();
  });

  it('calls onSubmit with comment text when form submitted', async () => {
    const onSubmit = vi.fn();
    render(<AddCommentForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    const textarea = screen.getByPlaceholderText(/add a comment/i);
    await userEvent.type(textarea, 'My new comment');
    fireEvent.click(screen.getByRole('button', { name: /add/i }));

    expect(onSubmit).toHaveBeenCalledWith('My new comment');
  });

  it('submits on Enter key (without shift)', async () => {
    const onSubmit = vi.fn();
    render(<AddCommentForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    const textarea = screen.getByPlaceholderText(/add a comment/i);
    await userEvent.type(textarea, 'Comment text');
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(onSubmit).toHaveBeenCalledWith('Comment text');
  });

  it('does not submit on Shift+Enter (allows newline)', async () => {
    const onSubmit = vi.fn();
    render(<AddCommentForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    const textarea = screen.getByPlaceholderText(/add a comment/i);
    await userEvent.type(textarea, 'Line one');
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('calls onCancel when cancel button clicked', () => {
    const onCancel = vi.fn();
    render(<AddCommentForm onSubmit={vi.fn()} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onCancel).toHaveBeenCalled();
  });

  it('does not submit when text is empty', () => {
    const onSubmit = vi.fn();
    render(<AddCommentForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /add/i }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('clears textarea after successful submit', async () => {
    const onSubmit = vi.fn();
    render(<AddCommentForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    const textarea = screen.getByPlaceholderText(/add a comment/i) as HTMLTextAreaElement;
    await userEvent.type(textarea, 'Comment text');
    fireEvent.click(screen.getByRole('button', { name: /add/i }));

    expect(textarea.value).toBe('');
  });
});
