import { useEffect, useState } from 'react';
import { EditorView } from '@codemirror/view';
import {
  loadSpellcheckEnabled,
  saveSpellcheckEnabled,
  spellcheckEnabledField,
  toggleSpellcheck,
} from '../Editor/extensions/harper';

interface SpellcheckToggleProps {
  view: EditorView | null;
  iconOnly?: boolean;
}

// Heroicons "check" with a text glyph: spelling checked.
function SpellcheckIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4"
      aria-hidden="true"
    >
      <path d="M2.5 13.5 5.5 5l3 8.5M3.6 10.5h3.8" />
      <path d="M10.5 12.5 12.5 15 17.5 8.5" />
    </svg>
  );
}

/**
 * Header switch for Harper spellcheck. Per-browser preference; the editor
 * re-lints the moment it changes.
 */
export function SpellcheckToggle({ view, iconOnly = false }: SpellcheckToggleProps) {
  const [enabled, setEnabled] = useState<boolean>(() => loadSpellcheckEnabled());

  // A recreated EditorView (doc switch) reads the stored value itself; this
  // only matters when the two disagree, e.g. storage changed in another tab.
  useEffect(() => {
    if (!view) return;
    if (view.state.field(spellcheckEnabledField, false) !== enabled) {
      toggleSpellcheck(view, enabled);
    }
  }, [view, enabled]);

  const toggle = () => {
    const next = !enabled;
    setEnabled(next);
    saveSpellcheckEnabled(next);
    if (view) toggleSpellcheck(view, next);
  };

  const label = enabled ? 'Spellcheck on' : 'Spellcheck off';
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={!view}
      title={`${label} (English only)`}
      aria-label={label}
      aria-pressed={enabled}
      className={`flex items-center gap-1.5 px-2 py-1 rounded-md border disabled:opacity-40 ${
        enabled
          ? 'border-gray-300 bg-white hover:bg-gray-50 text-gray-600'
          : 'border-gray-200 bg-gray-50 hover:bg-gray-100 text-gray-400 line-through'
      }`}
    >
      <SpellcheckIcon />
      {!iconOnly && <span className="text-xs">Spellcheck</span>}
    </button>
  );
}
