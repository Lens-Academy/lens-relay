/**
 * Suggestion-mode toggle for the EduEditor — plain-state variant of
 * SuggestionModeToggle that doesn't need a CodeMirror EditorView. The mode
 * is held in EduEditor and forwarded to whichever per-section editor
 * happens to be active.
 *
 * Role rules mirror the markdown editor:
 *  - view: locked Read-Only badge.
 *  - suggest: locked Suggest badge; mode is forced ON.
 *  - edit: full toggle.
 */

import { useEffect } from 'react';
import { SegmentedToggle, type SegmentedValue } from '../SegmentedToggle';
import { useAuth } from '../../contexts/AuthContext';

function EditIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
      <path d="M2.695 14.763l-1.262 3.154a.5.5 0 00.65.65l3.155-1.262a4 4 0 001.343-.885L17.5 5.5a2.121 2.121 0 00-3-3L3.58 13.42a4 4 0 00-.885 1.343z" />
    </svg>
  );
}

function SuggestIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
      <path fillRule="evenodd" d="M10 2c-2.236 0-4.43.18-6.57.524C1.993 2.755 1 4.014 1 5.426v5.148c0 1.413.993 2.67 2.43 2.902 1.168.188 2.352.327 3.55.414.28.02.521.18.642.413l1.713 3.293a.75.75 0 001.33 0l1.713-3.293a.783.783 0 01.642-.413 41.102 41.102 0 003.55-.414c1.437-.231 2.43-1.49 2.43-2.902V5.426c0-1.413-.993-2.67-2.43-2.902A41.289 41.289 0 0010 2zM6.75 6a.75.75 0 000 1.5h6.5a.75.75 0 000-1.5h-6.5zm0 2.5a.75.75 0 000 1.5h3.5a.75.75 0 000-1.5h-3.5z" clipRule="evenodd" />
    </svg>
  );
}

function ViewIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
      <path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />
      <path fillRule="evenodd" d="M.664 10.59a1.651 1.651 0 010-1.186A10.004 10.004 0 0110 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0110 17c-4.257 0-7.893-2.66-9.336-6.41zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clipRule="evenodd" />
    </svg>
  );
}

interface EduSuggestionModeToggleProps {
  isSuggestionMode: boolean;
  onChange: (next: boolean) => void;
  iconOnly?: boolean;
}

export function EduSuggestionModeToggle({
  isSuggestionMode,
  onChange,
  iconOnly = false,
}: EduSuggestionModeToggleProps) {
  const { role } = useAuth();

  // Force suggest-only users into suggestion mode.
  useEffect(() => {
    if (role === 'suggest' && !isSuggestionMode) {
      onChange(true);
    }
  }, [role, isSuggestionMode, onChange]);

  if (role === 'view') {
    return (
      <span
        className="inline-flex items-center px-3 py-1.5 rounded-md text-sm font-medium bg-red-100 text-red-800"
        title="Read-Only"
      >
        {iconOnly ? <ViewIcon /> : 'Read-Only'}
      </span>
    );
  }

  if (role === 'suggest') {
    return (
      <span
        className="inline-flex items-center px-3 py-1.5 rounded-md text-sm font-medium bg-amber-100 text-amber-800"
        title="Suggest + Comment Only"
      >
        {iconOnly ? <SuggestIcon /> : 'Suggest + Comment Only'}
      </span>
    );
  }

  return (
    <SegmentedToggle
      leftLabel={iconOnly ? <SuggestIcon /> : 'Suggesting'}
      rightLabel={iconOnly ? <EditIcon /> : 'Editing'}
      leftTitle="Suggesting"
      rightTitle="Editing"
      value={isSuggestionMode ? 'left' : 'right'}
      onChange={(value: SegmentedValue) => onChange(value === 'left')}
      ariaLabel="Toggle between suggesting and editing mode"
    />
  );
}
