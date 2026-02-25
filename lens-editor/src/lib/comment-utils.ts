import type { EditorView } from '@codemirror/view';
import { getCurrentAuthor } from '../components/Editor/extensions/criticmarkup';

/**
 * Scroll the editor to a specific position and focus it.
 */
export function scrollToPosition(view: EditorView, pos: number): void {
  view.dispatch({
    selection: { anchor: pos },
    scrollIntoView: true,
  });
  view.focus();
}

/**
 * Insert a comment at the specified position.
 * Used for both new comments and replies (replies insert at thread end for adjacency).
 */
export function insertCommentAt(view: EditorView, content: string, pos: number): void {
  const author = getCurrentAuthor();
  const timestamp = Date.now();
  const meta = JSON.stringify({ author, timestamp });
  const markup = `{>>${meta}@@${content}<<}`;

  view.dispatch({
    changes: { from: pos, insert: markup },
  });
}
