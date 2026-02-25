import { EditorView } from '@codemirror/view';
import type { StateEffect } from '@codemirror/state';
import { getCurrentAuthor } from '../components/Editor/extensions/criticmarkup';

/**
 * Scroll the editor to a specific position and focus it.
 * Scrolls to the center 80% of the viewport (10% margin) with smooth animation.
 * Additional effects (e.g. focus state) can be included in the same dispatch
 * to avoid a second dispatch clobbering the scroll.
 */
export function scrollToPosition(view: EditorView, pos: number, extraEffects?: StateEffect<unknown>[]): void {
  const scrollDOM = view.scrollDOM;
  const yMargin = Math.round(scrollDOM.clientHeight * 0.1);

  scrollDOM.style.scrollBehavior = 'smooth';

  const effects: StateEffect<unknown>[] = [EditorView.scrollIntoView(pos, { y: 'nearest', yMargin })];
  if (extraEffects) effects.push(...extraEffects);

  view.dispatch({
    selection: { anchor: pos },
    effects,
  });

  setTimeout(() => {
    scrollDOM.style.scrollBehavior = '';
  }, 300);

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
