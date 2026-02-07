import { useState, useEffect } from 'react';
import { EditorView } from '@codemirror/view';
import {
  toggleSuggestionMode,
  suggestionModeField,
} from '../Editor/extensions/criticmarkup';
import { SegmentedToggle, type SegmentedValue } from '../SegmentedToggle';

interface SuggestionModeToggleProps {
  view: EditorView | null;
}

/**
 * Toggle for switching between Editing and Suggesting modes.
 *
 * - Editing: Edits are applied directly to the document
 * - Suggesting: Edits are wrapped in CriticMarkup for review
 */
export function SuggestionModeToggle({ view }: SuggestionModeToggleProps) {
  const [isSuggestionMode, setIsSuggestionMode] = useState(false);

  // Sync local state with editor state when view changes
  useEffect(() => {
    if (!view) return;
    setIsSuggestionMode(view.state.field(suggestionModeField));
  }, [view]);

  const handleChange = (value: SegmentedValue) => {
    if (!view) return;
    const newSuggestionMode = value === 'left';
    setIsSuggestionMode(newSuggestionMode);
    view.dispatch({
      effects: toggleSuggestionMode.of(newSuggestionMode),
    });
  };

  return (
    <SegmentedToggle
      leftLabel="Suggesting"
      rightLabel="Editing"
      value={isSuggestionMode ? 'left' : 'right'}
      onChange={handleChange}
      disabled={!view}
      ariaLabel="Toggle between suggesting and editing mode"
    />
  );
}
