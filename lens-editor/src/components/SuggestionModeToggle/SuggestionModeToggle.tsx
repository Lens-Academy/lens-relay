import { EditorView } from '@codemirror/view';
import {
  toggleSuggestionMode,
} from '../Editor/extensions/criticmarkup';
import { SuggestionModeControl } from './SuggestionModeControl';

interface SuggestionModeToggleProps {
  view: EditorView | null;
  /** When true, show icons instead of text labels */
  iconOnly?: boolean;
  /** Controlled suggestion mode state (from EditorArea's updateListener) */
  isSuggestionMode: boolean;
  onSuggestionModeChange?: (next: boolean) => void;
}

/**
 * Toggle for switching between Editing and Suggesting modes.
 *
 * - For 'edit' role: Full toggle between Editing and Suggesting modes
 * - For 'suggest' role: Locked into Suggesting mode (shows badge instead of toggle)
 * - For 'view' role: Locked "Read-Only" badge (no editing capabilities)
 */
export function SuggestionModeToggle({ view, iconOnly = false, isSuggestionMode, onSuggestionModeChange }: SuggestionModeToggleProps) {
  const handleChange = (next: boolean) => {
    if (!view) return;
    view.dispatch({
      effects: toggleSuggestionMode.of(next),
    });
    onSuggestionModeChange?.(next);
  };

  return (
    <SuggestionModeControl
      isSuggestionMode={isSuggestionMode}
      onChange={handleChange}
      iconOnly={iconOnly}
      disabled={!view}
    />
  );
}
