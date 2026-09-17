/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { SpellcheckToggle } from './SpellcheckToggle';
import { harperLinter, spellcheckEnabledField } from '../Editor/extensions/harper';

function makeView() {
  return new EditorView({
    state: EditorState.create({ doc: 'helo', extensions: [harperLinter] }),
    parent: document.body,
  });
}

const views: EditorView[] = [];
beforeEach(() => localStorage.clear());
afterEach(() => {
  while (views.length) views.pop()!.destroy();
});

describe('SpellcheckToggle', () => {
  it('starts on, switches the editor off, and remembers it', () => {
    const view = makeView();
    views.push(view);
    render(<SpellcheckToggle view={view} />);
    expect(view.state.field(spellcheckEnabledField)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Spellcheck on' }));
    expect(view.state.field(spellcheckEnabledField)).toBe(false);
    expect(screen.getByRole('button', { name: 'Spellcheck off' })).toHaveAttribute('aria-pressed', 'false');

    // Next page load: a fresh view reads the stored choice.
    const later = makeView();
    views.push(later);
    expect(later.state.field(spellcheckEnabledField)).toBe(false);
  });

  it('hides the label when icon-only', () => {
    render(<SpellcheckToggle view={null} iconOnly />);
    expect(screen.queryByText('Spellcheck')).toBeNull();
    expect(screen.getByRole('button', { name: 'Spellcheck on' })).toBeDisabled();
  });
});
