/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { AuthorshipModeToggle, RecentChangesToggle } from './AuthorshipModeToggle';
import { useAuthorshipSettings } from './useAuthorshipSettings';
import { authorshipHoverField, authorshipModeField, loadAuthorshipMode, recentEnabledField, recentWindowField } from '../Editor/extensions/authorship';

function makeView() {
  return new EditorView({
    state: EditorState.create({ doc: '', extensions: [authorshipModeField, authorshipHoverField, recentEnabledField, recentWindowField] }),
    parent: document.body,
  });
}

/** The menu's two rows with their settings, as EditorArea holds them */
function Authorship({ view }: { view: EditorView | null }) {
  const settings = useAuthorshipSettings(view);
  return (
    <>
      <AuthorshipModeToggle settings={settings} />
      <RecentChangesToggle settings={settings} />
    </>
  );
}

const views: EditorView[] = [];
// The mode and the hover switch persist in localStorage; start each test clean.
beforeEach(() => localStorage.clear());
afterEach(() => {
  while (views.length) views.pop()!.destroy();
});

describe('AuthorshipModeToggle', () => {
  it('shows the current display, and opens its options under it', () => {
    const view = makeView();
    views.push(view);
    render(<Authorship view={view} />);
    const row = screen.getByRole('button', { name: /Authorship/ });
    expect(row).toHaveTextContent('Gutter');
    expect(row).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menuitemradio', { name: /Gutter/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('applies the selected mode to the view', () => {
    const view = makeView();
    views.push(view);
    render(<Authorship view={view} />);

    fireEvent.click(screen.getByRole('button', { name: /Authorship/ }));
    fireEvent.click(screen.getByText('Inline'));

    expect(view.state.field(authorshipModeField)).toBe('inline');
  });

  it('re-applies the selected mode when the editor view is recreated', () => {
    const viewA = makeView();
    views.push(viewA);
    const { rerender } = render(<Authorship view={viewA} />);

    fireEvent.click(screen.getByRole('button', { name: /Authorship/ }));
    fireEvent.click(screen.getByText('Inline'));
    expect(viewA.state.field(authorshipModeField)).toBe('inline');

    // Doc switch: EditorArea hands the toggle a fresh EditorView whose field
    // starts back at the default. The toggle still shows "Inline", so the
    // view must be brought in line with it.
    const viewB = makeView();
    views.push(viewB);
    rerender(<Authorship view={viewB} />);

    expect(viewB.state.field(authorshipModeField)).toBe('inline');
  });

  it('remembers the selected mode for the next editor', () => {
    const view = makeView();
    views.push(view);
    render(<Authorship view={view} />);

    fireEvent.click(screen.getByRole('button', { name: /Authorship/ }));
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
    render(<Authorship view={view} />);
    expect(view.state.field(authorshipHoverField)).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /Authorship/ }));
    fireEvent.click(screen.getByText('Show author on hover'));
    expect(view.state.field(authorshipHoverField)).toBe(true);

    const later = makeView();
    views.push(later);
    expect(later.state.field(authorshipHoverField)).toBe(true);
  });

  it('has "Highlight recent changes" as a row of its own, outside the Authorship options', () => {
    const view = makeView();
    views.push(view);
    render(<Authorship view={view} />);
    // The Authorship options are closed, and the switch is there anyway
    expect(screen.getByRole('button', { name: /Authorship/ })).toHaveAttribute('aria-expanded', 'false');
    const recent = screen.getByRole('menuitemcheckbox', { name: /Highlight recent changes/ });
    expect(recent).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('group', { name: 'Recent changes window' })).not.toBeInTheDocument();

    fireEvent.click(recent);
    expect(view.state.field(recentEnabledField)).toBe(true);
    expect(recent).toHaveAttribute('aria-checked', 'true');
    // While on, its time window under it
    fireEvent.click(screen.getByRole('menuitemradio', { name: '1h' }));
    expect(view.state.field(recentWindowField)).toBe(3600_000);
    // Opening Authorship no longer shows a second copy
    fireEvent.click(screen.getByRole('button', { name: /Authorship/ }));
    expect(screen.getAllByText('Highlight recent changes')).toHaveLength(1);
  });
});
