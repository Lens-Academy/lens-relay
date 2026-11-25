/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { SpellcheckToggle } from './SpellcheckToggle';
import { useSpellcheckSetting } from './useSpellcheckSetting';
import { harperLinter, spellcheckEnabledField } from '../Editor/extensions/harper';

function makeView() {
  return new EditorView({
    state: EditorState.create({ doc: 'helo', extensions: [harperLinter] }),
    parent: document.body,
  });
}

/** The menu row with its setting, as EditorArea holds it */
function Spellcheck({ view }: { view: EditorView | null }) {
  return <SpellcheckToggle setting={useSpellcheckSetting(view)} disabled={!view} />;
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
    render(<Spellcheck view={view} />);
    expect(view.state.field(spellcheckEnabledField)).toBe(true);
    expect(screen.getByRole('menuitemcheckbox', { name: /Spellcheck/ })).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Spellcheck/ }));
    expect(view.state.field(spellcheckEnabledField)).toBe(false);
    expect(screen.getByRole('menuitemcheckbox', { name: /Spellcheck/ })).toHaveAttribute('aria-checked', 'false');

    // Next page load: a fresh view reads the stored choice.
    const later = makeView();
    views.push(later);
    expect(later.state.field(spellcheckEnabledField)).toBe(false);
  });

  it('is disabled without an editor', () => {
    render(<Spellcheck view={null} />);
    expect(screen.getByRole('menuitemcheckbox', { name: /Spellcheck/ })).toBeDisabled();
  });
});
