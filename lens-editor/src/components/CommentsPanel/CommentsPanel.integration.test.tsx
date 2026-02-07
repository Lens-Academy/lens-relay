// src/components/CommentsPanel/CommentsPanel.integration.test.tsx
/**
 * Integration tests for Comments Panel.
 * @vitest-environment happy-dom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createCriticMarkupEditor } from '../../test/codemirror-helpers';
import { CommentsPanel } from './CommentsPanel';

describe('Comments Panel Integration', () => {
  let editorCleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup();
    if (editorCleanup) editorCleanup();
  });

  describe('Full Workflow', () => {
    it('add comment → appears in panel → click → navigates', async () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello world this is a test document',
        10
      );
      editorCleanup = c;

      const { rerender, container } = render(<CommentsPanel view={view} />);

      // Add a comment
      fireEvent.click(screen.getByRole('button', { name: /add comment/i }));
      const textarea = screen.getByPlaceholderText(/add a comment/i);
      await userEvent.type(textarea, 'This is my note');
      fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

      // Re-render to pick up state change
      rerender(<CommentsPanel view={view} stateVersion={1} />);

      // Comment should appear in panel - scope to panel to avoid editor DOM
      const panel = container.querySelector('.comments-panel')! as HTMLElement;
      expect(within(panel).getByText('This is my note')).toBeInTheDocument();

      // Move cursor elsewhere
      view.dispatch({ selection: { anchor: 0 } });

      // Click comment to navigate
      fireEvent.click(within(panel).getByText('This is my note'));

      // Cursor should be at comment position (somewhere in the document, not at 0)
      expect(view.state.selection.main.head).toBeGreaterThan(5);
    });

    it('thread reply creates adjacent comment (same thread)', async () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        '{>>first<<} some text',
        0
      );
      editorCleanup = c;

      const { container } = render(<CommentsPanel view={view} />);

      // Reply to thread
      fireEvent.click(screen.getByRole('button', { name: /reply/i }));
      const textarea = screen.getByPlaceholderText(/reply/i);
      await userEvent.type(textarea, 'my reply');
      // Get the submit button inside the add-comment-form
      const form = container.querySelector('.add-comment-form')! as HTMLElement;
      const submitButton = within(form).getByRole('button', { name: /^reply$/i });
      fireEvent.click(submitButton);

      // Check document - reply should be adjacent (part of same thread)
      const doc = view.state.doc.toString();
      expect(doc).toMatch(/\{>>first<<\}\{>>.*my reply<<\}/);
    });

    it('multiple threads display separately', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        '{>>thread one<<} gap {>>thread two<<}',
        0
      );
      editorCleanup = c;

      const { container } = render(<CommentsPanel view={view} />);
      const panel = container.querySelector('.comments-panel')! as HTMLElement;

      expect(within(panel).getByText('thread one')).toBeInTheDocument();
      expect(within(panel).getByText('thread two')).toBeInTheDocument();

      // Should have 2 separate reply buttons (one per thread)
      const replyButtons = screen.getAllByRole('button', { name: /reply/i });
      expect(replyButtons).toHaveLength(2);
    });
  });

  describe('Edge Cases', () => {
    it('handles empty document', () => {
      const { view, cleanup: c } = createCriticMarkupEditor('', 0);
      editorCleanup = c;

      render(<CommentsPanel view={view} />);

      expect(screen.getByText('No comments in document')).toBeInTheDocument();
    });

    it('handles document with only non-comment markup', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        '{++added text++} {--deleted--}',
        0
      );
      editorCleanup = c;

      render(<CommentsPanel view={view} />);

      expect(screen.getByText('No comments in document')).toBeInTheDocument();
    });

    it('handles multiline comments', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        '{>>line one\nline two<<}',
        0
      );
      editorCleanup = c;

      const { container } = render(<CommentsPanel view={view} />);
      const panel = container.querySelector('.comments-panel')! as HTMLElement;

      expect(within(panel).getByText(/line one/)).toBeInTheDocument();
    });

    it('handles comment with metadata and minimal content', () => {
      // Note: Parser requires at least one character after @@ for metadata extraction
      const { view, cleanup: c } = createCriticMarkupEditor(
        '{>>{"author":"alice"}@@x<<}',
        0
      );
      editorCleanup = c;

      render(<CommentsPanel view={view} />);

      // Should show author with content
      expect(screen.getByText('alice')).toBeInTheDocument();
      const panel = document.querySelector('.comments-panel')! as HTMLElement;
      expect(within(panel).getByText('x')).toBeInTheDocument();
    });
  });

  describe('Metadata Display', () => {
    it('shows relative time for recent comments', () => {
      const recentTimestamp = Date.now() - 300000; // 5 minutes ago
      const { view, cleanup: c } = createCriticMarkupEditor(
        `{>>{"timestamp":${recentTimestamp}}@@recent comment<<}`,
        0
      );
      editorCleanup = c;

      render(<CommentsPanel view={view} />);

      expect(screen.getByText(/5m ago/)).toBeInTheDocument();
    });

    it('shows date for old comments', () => {
      const oldTimestamp = Date.now() - 864000000; // 10 days ago
      const { view, cleanup: c } = createCriticMarkupEditor(
        `{>>{"timestamp":${oldTimestamp}}@@old comment<<}`,
        0
      );
      editorCleanup = c;

      render(<CommentsPanel view={view} />);

      // Should show month/day format
      expect(screen.getByText(/Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/)).toBeInTheDocument();
    });
  });

  describe('Keyboard Navigation', () => {
    it('pressing Escape closes add comment form', async () => {
      const { view, cleanup: c } = createCriticMarkupEditor('hello world', 5);
      editorCleanup = c;

      render(<CommentsPanel view={view} />);

      fireEvent.click(screen.getByRole('button', { name: /add comment/i }));
      expect(screen.getByPlaceholderText(/add a comment/i)).toBeInTheDocument();

      fireEvent.keyDown(screen.getByPlaceholderText(/add a comment/i), {
        key: 'Escape',
      });

      expect(screen.queryByPlaceholderText(/add a comment/i)).not.toBeInTheDocument();
    });

    it('pressing Enter in form submits comment', async () => {
      const { view, cleanup: c } = createCriticMarkupEditor('hello world', 5);
      editorCleanup = c;

      render(<CommentsPanel view={view} />);

      fireEvent.click(screen.getByRole('button', { name: /add comment/i }));
      const textarea = screen.getByPlaceholderText(/add a comment/i);
      await userEvent.type(textarea, 'quick comment');
      fireEvent.keyDown(textarea, { key: 'Enter' });

      expect(view.state.doc.toString()).toMatch(/quick comment/);
    });
  });
});
