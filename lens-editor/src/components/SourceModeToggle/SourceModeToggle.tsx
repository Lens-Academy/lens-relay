import { useState } from 'react';
import { EditorView } from '@codemirror/view';
import { toggleSourceMode } from '../Editor/extensions/livePreview';
import { SegmentedToggle, type SegmentedValue } from '../SegmentedToggle';

interface SourceModeToggleProps {
  editorView: EditorView | null;
}

// Eye icon (Heroicons Mini) - represents formatted/preview view
function PreviewIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="w-4 h-4"
    >
      <path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />
      <path
        fillRule="evenodd"
        d="M.664 10.59a1.651 1.651 0 010-1.186A10.004 10.004 0 0110 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0110 17c-4.257 0-7.893-2.66-9.336-6.41zM14 10a4 4 0 11-8 0 4 4 0 018 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}

// Code icon (Heroicons Mini) - represents raw source view
function SourceIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="w-4 h-4"
    >
      <path
        fillRule="evenodd"
        d="M6.28 5.22a.75.75 0 010 1.06L2.56 10l3.72 3.72a.75.75 0 01-1.06 1.06L.97 10.53a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 0zm7.44 0a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L17.44 10l-3.72-3.72a.75.75 0 010-1.06zM11.377 2.011a.75.75 0 01.612.867l-2.5 14.5a.75.75 0 01-1.478-.255l2.5-14.5a.75.75 0 01.866-.612z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/**
 * Toggle for switching between live preview and source mode.
 *
 * - Live Preview: Markdown renders with formatting (headings sized, syntax hidden)
 * - Source: Shows all raw markdown syntax
 */
export function SourceModeToggle({ editorView }: SourceModeToggleProps) {
  const [isSourceMode, setIsSourceMode] = useState(false);

  const handleChange = (value: SegmentedValue) => {
    if (!editorView) return;
    const newSourceMode = value === 'left';
    setIsSourceMode(newSourceMode);
    toggleSourceMode(editorView, newSourceMode);
  };

  return (
    <SegmentedToggle
      leftLabel={<SourceIcon />}
      rightLabel={<PreviewIcon />}
      leftTitle="Source Mode"
      rightTitle="Live Preview"
      value={isSourceMode ? 'left' : 'right'}
      onChange={handleChange}
      disabled={!editorView}
      ariaLabel="Toggle between source and preview mode"
    />
  );
}
