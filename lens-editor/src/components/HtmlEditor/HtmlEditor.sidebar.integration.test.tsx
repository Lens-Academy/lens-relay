/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { HtmlEditor } from './HtmlEditor';
import { addComment } from './comment-store';
import { DisplayNameProvider } from '../../contexts/DisplayNameContext';

function setup() {
  const doc = new Y.Doc();
  const ytext = doc.getText('contents');
  ytext.insert(0, '<p>hello</p>');
  const awareness = new Awareness(doc);
  return { ytext, awareness };
}

beforeEach(() => {
  // Stub ResizeObserver since CommentsLayer (and the bridge mocks) rely on it.
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
});

describe('HtmlEditor sidebar integration', () => {
  it('renders existing comments in the sidebar (orphan-pinned pre-bridge)', () => {
    const { ytext, awareness } = setup();
    addComment(ytext, 'origin', { id: 'c1', author: 'alice', ts: 't', body: 'hi there', position: 12 });

    render(
      <DisplayNameProvider>
        <HtmlEditor ytext={ytext} awareness={awareness} currentUser="alice" />
      </DisplayNameProvider>
    );

    // Sidebar shows the comment. In happy-dom the bridge never fires, so the
    // anchor state stays empty and the thread is `orphan: true` — it pins to
    // viewport.top instead of a real anchor, but renders identically.
    expect(screen.getByText('hi there')).toBeInTheDocument();
    expect(document.querySelector('[data-comment-thread="c1"]')).not.toBeNull();
  });

  it('Reply via sidebar appends to the cluster', () => {
    const { ytext, awareness } = setup();
    addComment(ytext, 'origin', { id: 'c1', author: 'alice', ts: 't', body: 'hi', position: 12 });

    render(
      <DisplayNameProvider>
        <HtmlEditor ytext={ytext} awareness={awareness} currentUser="alice" />
      </DisplayNameProvider>
    );

    // Open the reply form (button text from CommentCard.tsx is "Reply")
    fireEvent.click(screen.getByText('Reply'));

    // The reply form's textarea uses the AddCommentForm. Find the most recently
    // rendered textbox (the reply form's, not anything else).
    const textboxes = screen.getAllByRole('textbox') as HTMLTextAreaElement[];
    const replyArea = textboxes[textboxes.length - 1];
    fireEvent.change(replyArea, { target: { value: 'reply body' } });

    // Submit button: the CommentCard's reply form uses submitLabel="Send" (per Task 5)
    fireEvent.click(screen.getByText('Send'));

    expect(ytext.toString()).toContain('"body":"reply body"');
  });
});
