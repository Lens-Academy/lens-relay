import { useState, useEffect } from 'react';
import type { StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  authorshipModeField,
  authorshipHoverField,
  recentWindowField,
  recentEnabledField,
  setAuthorshipMode,
  setAuthorshipHover,
  setRecentWindow,
  setRecentEnabled,
  loadAuthorshipMode,
  saveAuthorshipMode,
  loadAuthorshipHover,
  saveAuthorshipHover,
  loadRecentWindow,
  saveRecentWindow,
  loadRecentEnabled,
  saveRecentEnabled,
  type AuthorshipMode,
} from '../Editor/extensions/authorship';

export interface AuthorshipSettings {
  mode: AuthorshipMode;
  selectMode: (mode: AuthorshipMode) => void;
  hoverEnabled: boolean;
  toggleHover: () => void;
  recentEnabled: boolean;
  toggleRecent: () => void;
  windowMs: number;
  selectWindow: (ms: number) => void;
}

/**
 * The authorship provenance display: its mode, the author on hover, and
 * recent AI changes. Per-browser preferences, held by EditorArea so each new
 * editor (a doc switch) gets them while the page menu is closed.
 */
export function useAuthorshipSettings(view: EditorView | null): AuthorshipSettings {
  const [mode, setMode] = useState<AuthorshipMode>(() => loadAuthorshipMode());
  const [hoverEnabled, setHoverEnabled] = useState<boolean>(() => loadAuthorshipHover());
  const [windowMs, setWindowMs] = useState<number>(() => loadRecentWindow());
  const [recentEnabled, setRecentEnabledState] = useState<boolean>(() => loadRecentEnabled());

  // A recreated EditorView (doc switch) seeds its fields from storage. When
  // storage is unavailable that is the default, not what the settings
  // show — bring the view in line, in one transaction.
  useEffect(() => {
    if (!view) return;
    const effects: StateEffect<unknown>[] = [];
    if (view.state.field(authorshipModeField, false) !== mode) effects.push(setAuthorshipMode.of(mode));
    if (view.state.field(recentWindowField, false) !== windowMs) effects.push(setRecentWindow.of(windowMs));
    if (view.state.field(recentEnabledField, false) !== recentEnabled) effects.push(setRecentEnabled.of(recentEnabled));
    if (view.state.field(authorshipHoverField, false) !== hoverEnabled) effects.push(setAuthorshipHover.of(hoverEnabled));
    if (effects.length) view.dispatch({ effects });
  }, [view, mode, windowMs, recentEnabled, hoverEnabled]);

  return {
    mode,
    selectMode: (next) => {
      if (!view) return;
      setMode(next);
      saveAuthorshipMode(next);
      view.dispatch({ effects: setAuthorshipMode.of(next) });
    },
    hoverEnabled,
    toggleHover: () => {
      const next = !hoverEnabled;
      setHoverEnabled(next);
      saveAuthorshipHover(next);
      if (view) view.dispatch({ effects: setAuthorshipHover.of(next) });
    },
    recentEnabled,
    toggleRecent: () => {
      const next = !recentEnabled;
      setRecentEnabledState(next);
      saveRecentEnabled(next);
      if (view) view.dispatch({ effects: setRecentEnabled.of(next) });
    },
    windowMs,
    selectWindow: (ms) => {
      setWindowMs(ms);
      saveRecentWindow(ms);
      if (view) view.dispatch({ effects: setRecentWindow.of(ms) });
    },
  };
}
