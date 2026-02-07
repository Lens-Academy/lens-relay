// src/components/CommentsPanel/useComments.ts
import type { EditorView } from '@codemirror/view';
import { criticMarkupField } from '../Editor/extensions/criticmarkup';
import { parseThreads, type CommentThread } from '../../lib/criticmarkup-parser';

/**
 * Hook that extracts comments from the editor and groups them into threads.
 *
 * Note: This hook does not memoize because the parent component controls
 * re-renders via stateVersion prop. Memoizing on view.state would create
 * stale closure issues since React can't properly detect state changes.
 *
 * @param view - The CodeMirror EditorView instance
 * @returns Array of comment threads (empty if view is null or no comments)
 */
export function useComments(view: EditorView | null): CommentThread[] {
  if (!view) return [];

  const ranges = view.state.field(criticMarkupField);
  return parseThreads(ranges);
}
