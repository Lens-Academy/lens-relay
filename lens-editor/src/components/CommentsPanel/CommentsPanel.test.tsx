// src/components/CommentsPanel/CommentsPanel.test.tsx
/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommentsPanel } from './CommentsPanel';
import { createCriticMarkupEditor } from '../../test/codemirror-helpers';

describe('CommentsPanel', () => {
  let editorCleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup();
    if (editorCleanup) editorCleanup();
  });

  it('shows "No document open" when view is null', () => {
    render(<CommentsPanel view={null} />);
    expect(screen.getByText('No document open')).toBeInTheDocument();
  });

  it('shows "No comments" when document has no comments', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello world',
      0
    );
    editorCleanup = c;

    render(<CommentsPanel view={view} />);
    expect(screen.getByText('No comments in document')).toBeInTheDocument();
  });

  it('shows panel header "Comments"', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      '{>>my comment<<}',
      0
    );
    editorCleanup = c;

    render(<CommentsPanel view={view} />);
    expect(screen.getByText('Comments')).toBeInTheDocument();
  });

  it('displays comment content', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello {>>my note<<} world',
      0
    );
    editorCleanup = c;

    const { container } = render(<CommentsPanel view={view} />);
    // Scope to the comments-panel to avoid matching the CodeMirror editor DOM
    const panel = container.querySelector('.comments-panel')! as HTMLElement;
    expect(within(panel).getByText('my note')).toBeInTheDocument();
  });

  it('displays multiple threads', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      '{>>first<<} gap {>>second<<}',
      0
    );
    editorCleanup = c;

    const { container } = render(<CommentsPanel view={view} />);
    // Scope to the comments-panel to avoid matching the CodeMirror editor DOM
    const panel = container.querySelector('.comments-panel')! as HTMLElement;
    expect(within(panel).getByText('first')).toBeInTheDocument();
    expect(within(panel).getByText('second')).toBeInTheDocument();
  });
});

describe('Comment Metadata', () => {
  let editorCleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup();
    if (editorCleanup) editorCleanup();
  });

  it('displays author name when available', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      '{>>{"author":"alice"}@@my note<<}',
      0
    );
    editorCleanup = c;

    render(<CommentsPanel view={view} />);
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  it('displays formatted timestamp when available', () => {
    // Timestamp: 2024-02-03 12:00:00 UTC
    const { view, cleanup: c } = createCriticMarkupEditor(
      '{>>{"timestamp":1706961600000}@@my note<<}',
      0
    );
    editorCleanup = c;

    render(<CommentsPanel view={view} />);
    // Should display relative or formatted time
    expect(screen.getByText(/Feb|2024|ago/)).toBeInTheDocument();
  });

  it('displays "Anonymous" when no author', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      '{>>my note<<}',
      0
    );
    editorCleanup = c;

    render(<CommentsPanel view={view} />);
    expect(screen.getByText('Anonymous')).toBeInTheDocument();
  });
});

describe('Navigation', () => {
  let editorCleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup();
    if (editorCleanup) editorCleanup();
  });

  it('scrolls editor to comment position when clicked', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello {>>my note<<} world',
      0
    );
    editorCleanup = c;

    const { container } = render(<CommentsPanel view={view} />);

    // Scope to the comments-panel to avoid matching the CodeMirror editor DOM
    const panel = container.querySelector('.comments-panel')! as HTMLElement;
    const comment = within(panel).getByText('my note');
    fireEvent.click(comment);

    // Cursor should move to comment position
    const cursorPos = view.state.selection.main.head;
    // Comment is at position 6 (after "hello ")
    expect(cursorPos).toBeGreaterThanOrEqual(6);
    expect(cursorPos).toBeLessThanOrEqual(22);
  });

  it('has cursor pointer on comment items', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      '{>>my note<<}',
      0
    );
    editorCleanup = c;

    const { container } = render(<CommentsPanel view={view} />);

    const commentItem = container.querySelector('.comment-item');
    expect(commentItem).toHaveClass('cursor-pointer');
  });
});

describe('Thread Display', () => {
  let editorCleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup();
    if (editorCleanup) editorCleanup();
  });

  it('shows thread with multiple replies grouped together', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      '{>>first<<}{>>reply1<<}{>>reply2<<}',
      0
    );
    editorCleanup = c;

    const { container } = render(<CommentsPanel view={view} />);

    // Should show as single thread with indented replies
    const thread = container.querySelector('.comment-thread');
    expect(thread).toBeInTheDocument();

    // First comment is root, rest are replies
    const panel = container.querySelector('.comments-panel')! as HTMLElement;
    expect(within(panel).getByText('first')).toBeInTheDocument();
    expect(within(panel).getByText('reply1')).toBeInTheDocument();
    expect(within(panel).getByText('reply2')).toBeInTheDocument();
  });

  it('shows reply count for threads with multiple comments', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      '{>>first<<}{>>reply<<}',
      0
    );
    editorCleanup = c;

    render(<CommentsPanel view={view} />);
    expect(screen.getByText('1 reply')).toBeInTheDocument();
  });

  it('shows "replies" (plural) for 2+ replies', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      '{>>first<<}{>>reply1<<}{>>reply2<<}',
      0
    );
    editorCleanup = c;

    render(<CommentsPanel view={view} />);
    expect(screen.getByText('2 replies')).toBeInTheDocument();
  });
});

describe('Add Comment', () => {
  let editorCleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup();
    if (editorCleanup) editorCleanup();
  });

  it('shows "Add Comment" button', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello world',
      5
    );
    editorCleanup = c;

    render(<CommentsPanel view={view} />);
    expect(screen.getByRole('button', { name: /add comment/i })).toBeInTheDocument();
  });

  it('shows form when "Add Comment" clicked', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello world',
      5
    );
    editorCleanup = c;

    render(<CommentsPanel view={view} />);
    fireEvent.click(screen.getByRole('button', { name: /add comment/i }));

    expect(screen.getByPlaceholderText(/add a comment/i)).toBeInTheDocument();
  });

  it('inserts comment at cursor position when submitted', async () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello world',
      5 // cursor after "hello"
    );
    editorCleanup = c;

    render(<CommentsPanel view={view} />);
    fireEvent.click(screen.getByRole('button', { name: /add comment/i }));

    const textarea = screen.getByPlaceholderText(/add a comment/i);
    await userEvent.type(textarea, 'my note');
    fireEvent.click(screen.getByRole('button', { name: /add$/i }));

    // Document should contain the new comment
    expect(view.state.doc.toString()).toMatch(/\{>>.*my note<<\}/);
  });
});

describe('Reply to Thread', () => {
  let editorCleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup();
    if (editorCleanup) editorCleanup();
  });

  it('shows reply button on thread', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      '{>>first comment<<}',
      0
    );
    editorCleanup = c;

    render(<CommentsPanel view={view} />);
    expect(screen.getByRole('button', { name: /reply/i })).toBeInTheDocument();
  });

  it('shows reply form when reply button clicked', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      '{>>first comment<<}',
      0
    );
    editorCleanup = c;

    render(<CommentsPanel view={view} />);
    fireEvent.click(screen.getByRole('button', { name: /reply/i }));

    expect(screen.getByPlaceholderText(/reply/i)).toBeInTheDocument();
  });

  it('inserts reply adjacent to thread end', async () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      '{>>first<<} more text',
      0
    );
    editorCleanup = c;

    const { container } = render(<CommentsPanel view={view} />);
    fireEvent.click(screen.getByRole('button', { name: /reply/i }));

    const textarea = screen.getByPlaceholderText(/reply/i);
    await userEvent.type(textarea, 'my reply');
    // Get the submit button inside the add-comment-form
    const form = container.querySelector('.add-comment-form')! as HTMLElement;
    const submitButton = within(form).getByRole('button', { name: /^reply$/i });
    fireEvent.click(submitButton);

    // Reply should be adjacent (no space between)
    const doc = view.state.doc.toString();
    expect(doc).toMatch(/<<\}\{>>.*my reply<<\}/);
  });
});
