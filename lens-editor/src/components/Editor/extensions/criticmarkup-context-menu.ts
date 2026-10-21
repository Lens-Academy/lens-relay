// src/components/Editor/extensions/criticmarkup-context-menu.ts
import type { EditorView } from '@codemirror/view';
import { findRangeAtPosition, bulkChangeCount, acceptChangeAtCursor, rejectChangeAtCursor } from './criticmarkup-commands';

export interface ContextMenuItem {
  label: string;
  action: () => void;
  shortcut?: string;
}

/**
 * Get context menu items for CriticMarkup: the accept/reject of the ✓ ✗
 * buttons there. None on a comment, which has no ✓ ✗ (accepting or rejecting
 * a comment deletes it).
 *
 * @param view - The EditorView instance
 * @param atPosition - Optional position to check (for right-click). If not provided, uses cursor position.
 * @param target - The right-clicked element, if any. A right-click on a comment's badge can
 *   land in the change before it (posAtCoords is off on lines with hidden markup), so the
 *   badge itself tells that it was the comment.
 * @returns Menu items if position is inside markup, empty array otherwise.
 */
export function getContextMenuItems(view: EditorView, atPosition?: number, target?: EventTarget | null): ContextMenuItem[] {
  if (target instanceof Element && target.closest('.cm-comment-badge')) return [];

  // Check for bulk selection first: its suggestions, as on the bulk ✓ ✗
  const count = bulkChangeCount(view);
  if (count !== null) {
    if (count === 0) return [];
    const changes = count === 1 ? '1 Change' : `${count} Changes`;
    return [
      {
        label: `Accept ${changes}`,
        action: () => acceptChangeAtCursor(view),
        shortcut: 'Ctrl+Enter',
      },
      {
        label: `Reject ${changes}`,
        action: () => rejectChangeAtCursor(view),
        shortcut: 'Ctrl+Backspace',
      },
    ];
  }

  const pos = atPosition ?? view.state.selection.main.head;
  const range = findRangeAtPosition(view, pos);

  if (!range || range.type === 'comment') {
    return [];
  }

  // If we're checking a click position different from cursor,
  // first move cursor to that position so accept/reject work correctly
  const needsMoveCursor = atPosition !== undefined && atPosition !== view.state.selection.main.head;

  return [
    {
      label: 'Accept Change',
      action: () => {
        if (needsMoveCursor) {
          view.dispatch({ selection: { anchor: pos } });
        }
        acceptChangeAtCursor(view);
      },
      shortcut: 'Ctrl+Enter',
    },
    {
      label: 'Reject Change',
      action: () => {
        if (needsMoveCursor) {
          view.dispatch({ selection: { anchor: pos } });
        }
        rejectChangeAtCursor(view);
      },
      shortcut: 'Ctrl+Backspace',
    },
  ];
}
