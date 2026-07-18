/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { AuthorshipModeToggle } from './AuthorshipModeToggle';
import { authorshipModeField } from '../Editor/extensions/authorship';

function makeView() {
  return new EditorView({
    state: EditorState.create({ doc: '', extensions: [authorshipModeField] }),
    parent: document.body,
  });
}

const views: EditorView[] = [];
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
});
