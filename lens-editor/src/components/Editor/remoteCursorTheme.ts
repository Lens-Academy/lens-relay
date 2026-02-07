import { EditorView } from '@codemirror/view';

/**
 * Theme extension to customize remote cursor appearance.
 * Overrides y-codemirror.next defaults per CONTEXT.md decisions:
 * - Labels always visible (not hover-only)
 * - First name displayed above caret
 * - Colored caret line
 * - No selection highlighting (caret only)
 */
export const remoteCursorTheme = EditorView.theme({
  // Make label always visible (override default opacity: 0)
  '.cm-ySelectionInfo': {
    opacity: '1',
    transitionDelay: '0s',
    // Improve readability
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: '11px',
    fontWeight: '500',
    borderRadius: '3px',
    padding: '2px 6px',
    top: '-1.6em', // Position higher to avoid overlapping text
  },
  // Thicker, more visible caret
  '.cm-ySelectionCaret': {
    borderLeftWidth: '2px',
    borderRightWidth: '0', // Single-sided caret
  },
  // Keep label visible on hover (same as non-hover)
  '.cm-ySelectionCaret:hover > .cm-ySelectionInfo': {
    opacity: '1',
  },
  // Disable selection highlighting per CONTEXT.md - cursor caret only
  '.cm-ySelection': {
    background: 'none !important',
  },
  '.cm-yLineSelection': {
    background: 'none !important',
  },
});
