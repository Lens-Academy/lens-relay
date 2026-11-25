import { useEffect, useState } from 'react';
import { EditorView } from '@codemirror/view';
import {
  loadSpellcheckEnabled,
  saveSpellcheckEnabled,
  spellcheckEnabledField,
  toggleSpellcheck,
} from '../Editor/extensions/harper';

export interface SpellcheckSetting {
  enabled: boolean;
  toggle: () => void;
}

/**
 * Harper spellcheck on or off: a per-browser preference; the editor re-lints
 * the moment it changes. Held by EditorArea, so each new editor (a doc
 * switch) gets it while the page menu is closed.
 */
export function useSpellcheckSetting(view: EditorView | null): SpellcheckSetting {
  const [enabled, setEnabled] = useState<boolean>(() => loadSpellcheckEnabled());

  // A recreated EditorView (doc switch) seeds from storage. When storage is
  // unavailable that is the default, not what the setting shows.
  useEffect(() => {
    if (!view) return;
    if (view.state.field(spellcheckEnabledField, false) !== enabled) {
      toggleSpellcheck(view, enabled);
    }
  }, [view, enabled]);

  return {
    enabled,
    toggle: () => {
      const next = !enabled;
      setEnabled(next);
      saveSpellcheckEnabled(next);
      if (view) toggleSpellcheck(view, next);
    },
  };
}
