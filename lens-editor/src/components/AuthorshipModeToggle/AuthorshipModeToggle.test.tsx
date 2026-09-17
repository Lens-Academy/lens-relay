/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { AuthorshipModeToggle } from './AuthorshipModeToggle';
import { authorshipHoverField, authorshipModeField, loadAuthorshipMode } from '../Editor/extensions/authorship';

function makeView() {
  return new EditorView({
    state: EditorState.create({ doc: '', extensions: [authorshipModeField, authorshipHoverField] }),
    parent: document.body,
  });
}

const views: EditorView[] = [];
// The mode and the hover switch persist in localStorage; start each test clean.
beforeEach(() => localStorage.clear());
afterEach(() => {
  while (views.length) views.pop()!.destroy();
});

describe('AuthorshipModeToggle', () => {
  it('applies the selected mode to the view', () => {
    const view = makeView();
    views.push(view);
    render(<AuthorshipModeToggle view={view} />);

    fireEvent.click(screen.getByRole('button', { name: /Authorship display/ }));
    fireEvent.click(screen.getByText('Inline'));

    expect(view.state.field(authorshipModeField)).toBe('inline');
  });

  it('re-applies the selected mode when the editor view is recreated', () => {
    const viewA = makeView();
    views.push(viewA);
    const { rerender } = render(<AuthorshipModeToggle view={viewA} />);

    fireEvent.click(screen.getByRole('button', { name: /Authorship display/ }));
    fireEvent.click(screen.getByText('Inline'));
    expect(viewA.state.field(authorshipModeField)).toBe('inline');

    // Doc switch: EditorArea hands the toggle a fresh EditorView whose field
    // starts back at the default. The toggle still shows "Inline", so the
    // view must be brought in line with it.
    const viewB = makeView();
    views.push(viewB);
    rerender(<AuthorshipModeToggle view={viewB} />);

    expect(viewB.state.field(authorshipModeField)).toBe('inline');
  });

  it('remembers the selected mode for the next editor', () => {
    const view = makeView();
    views.push(view);
    render(<AuthorshipModeToggle view={view} />);

    fireEvent.click(screen.getByRole('button', { name: /Authorship display/ }));
    fireEvent.click(screen.getByText('Off'));

    expect(loadAuthorshipMode()).toBe('hidden');
    // A view created on the next page load starts from the stored mode.
    const later = makeView();
    views.push(later);
    expect(later.state.field(authorshipModeField)).toBe('hidden');
  });

  it('keeps the hover box off until switched on, and persists the switch', () => {
    const view = makeView();
    views.push(view);
    render(<AuthorshipModeToggle view={view} />);
    expect(view.state.field(authorshipHoverField)).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /Authorship display/ }));
    fireEvent.click(screen.getByText('Show author on hover'));
    expect(view.state.field(authorshipHoverField)).toBe(true);

    const later = makeView();
    views.push(later);
    expect(later.state.field(authorshipHoverField)).toBe(true);
  });
});
