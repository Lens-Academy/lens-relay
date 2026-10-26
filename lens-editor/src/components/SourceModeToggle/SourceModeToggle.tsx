import { EditorView } from '@codemirror/view';
import { toggleSourceMode } from '../Editor/extensions/livePreview';
import { MenuSwitchRow } from '../Menu/MenuSwitchRow';

interface SourceModeToggleProps {
  editorView: EditorView | null;
  isSourceMode: boolean;
  onSourceModeChange: (sourceMode: boolean) => void;
}

// Code icon (Heroicons Mini) - represents raw source view
function SourceIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="w-4 h-4"
      aria-hidden="true"
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
 * Source mode, a switch in the page menu: on, the page shows its raw
 * markdown; off, the live preview (headings sized, syntax hidden).
 */
export function SourceModeToggle({ editorView, isSourceMode, onSourceModeChange }: SourceModeToggleProps) {
  const handleToggle = () => {
    if (!editorView) return;
    onSourceModeChange(!isSourceMode);
    toggleSourceMode(editorView, !isSourceMode);
  };

  return (
    <MenuSwitchRow
      icon={<SourceIcon />}
      label="Source mode"
      description="Show the page's markdown"
      checked={isSourceMode}
      onToggle={handleToggle}
      disabled={!editorView}
    />
  );
}

/**
 * Shown in the top bar while the page is in source mode, so that is never
 * missed: a click goes back to the live preview.
 */
export function SourceModeChip({ editorView, onSourceModeChange }: Omit<SourceModeToggleProps, 'isSourceMode'>) {
  return (
    <button
      type="button"
      className="lens-topbar-button lens-topbar-chip"
      title="Back to the live preview"
      onClick={() => {
        if (!editorView) return;
        onSourceModeChange(false);
        toggleSourceMode(editorView, false);
      }}
    >
      <SourceIcon />
      <span>Source</span>
      <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
        <path d="m3 3 6 6M9 3 3 9" />
      </svg>
    </button>
  );
}
