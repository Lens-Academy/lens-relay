// src/components/Editor/extensions/criticmarkup-commands.ts
import type { EditorView, KeyBinding } from '@codemirror/view';
import { criticMarkupField } from './criticmarkup';
import type { CriticMarkupRange } from '../../../lib/criticmarkup-parser';

/**
 * Find the CriticMarkup range containing the given position.
 * Returns null if position is not inside any markup.
 */
export function findRangeAtPosition(view: EditorView, pos: number): CriticMarkupRange | null {
  const ranges = view.state.field(criticMarkupField);
  return ranges.find(r => pos >= r.from && pos <= r.to) ?? null;
}

/**
 * Find the CriticMarkup range containing the cursor position.
 */
function findRangeAtCursor(view: EditorView): CriticMarkupRange | null {
  return findRangeAtPosition(view, view.state.selection.main.head);
}

/**
 * Get the replacement text when accepting a CriticMarkup range.
 * Returns the content that should replace the entire markup.
 */
function getAcceptReplacement(range: CriticMarkupRange): string {
  switch (range.type) {
    case 'addition':
      return range.content;
    case 'deletion':
      return ''; // Content is deleted
    case 'substitution':
      return range.newContent ?? '';
    case 'highlight':
      return range.content;
    case 'comment':
      return ''; // Comments are removed
    default:
      return '';
  }
}

/**
 * Get the replacement text when rejecting a CriticMarkup range.
 * Returns the content that should replace the entire markup.
 */
function getRejectReplacement(range: CriticMarkupRange): string {
  switch (range.type) {
    case 'addition':
      return ''; // Addition is rejected, nothing added
    case 'deletion':
      return range.content; // Keep the "deleted" content
    case 'substitution':
      return range.oldContent ?? '';
    case 'highlight':
      return range.content;
    case 'comment':
      return ''; // Comments are removed either way
    default:
      return '';
  }
}

/**
 * Accept the CriticMarkup change at cursor position.
 * Uses targeted change (only the markup range) to preserve Y.js structure.
 * Returns true if a change was accepted, false if cursor not in markup.
 */
export function acceptChangeAtCursor(view: EditorView): boolean {
  const range = findRangeAtCursor(view);
  if (!range) return false;

  const replacement = getAcceptReplacement(range);

  view.dispatch({
    changes: { from: range.from, to: range.to, insert: replacement },
  });

  return true;
}

/**
 * Reject the CriticMarkup change at cursor position.
 * Uses targeted change (only the markup range) to preserve Y.js structure.
 * Returns true if a change was rejected, false if cursor not in markup.
 */
export function rejectChangeAtCursor(view: EditorView): boolean {
  const range = findRangeAtCursor(view);
  if (!range) return false;

  const replacement = getRejectReplacement(range);

  view.dispatch({
    changes: { from: range.from, to: range.to, insert: replacement },
  });

  return true;
}

/**
 * Keymap for CriticMarkup accept/reject.
 * - Mod-Enter: Accept change at cursor
 * - Mod-Backspace: Reject change at cursor
 */
export const criticMarkupKeymap: KeyBinding[] = [
  {
    key: 'Mod-Enter',
    run: acceptChangeAtCursor,
  },
  {
    key: 'Mod-Backspace',
    run: rejectChangeAtCursor,
  },
];
