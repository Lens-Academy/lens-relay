/**
 * Y.Text-direct comment operations, parallel to comment-utils.ts (which
 * operates through a CodeMirror EditorView). Used by the EduEditor's
 * comments sidebar where there is no single EditorView covering the doc.
 *
 * All ops dispatch through the Y.Doc transaction system so they sync over
 * relay-server like any other edit.
 */

import * as Y from 'yjs';
import { getCurrentAuthor } from '../components/Editor/extensions/criticmarkup';
import type { CriticMarkupRange } from './criticmarkup-parser';

/**
 * Encode user-supplied multi-line content for inline criticmarkup storage.
 * Mirrors the encoding in comment-utils.insertCommentAt so the same parser
 * round-trips it.
 */
function encodeCommentContent(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function buildCommentMarkup(content: string): string {
  const author = getCurrentAuthor();
  const timestamp = Date.now();
  const meta = JSON.stringify({ author, timestamp });
  return `{>>${meta}@@${encodeCommentContent(content)}<<}`;
}

/**
 * Insert a new comment at `pos` in the Y.Text.
 */
export function insertCommentInYText(ytext: Y.Text, content: string, pos: number): void {
  const markup = buildCommentMarkup(content);
  ytext.insert(pos, markup);
}

/**
 * Append a reply to a thread that ends at `threadEndPos`. The thread end
 * is the position just after the closing `<<}` of the last comment in the
 * thread, matching how parseThreads groups adjacent comments.
 */
export function replyInYText(ytext: Y.Text, content: string, threadEndPos: number): void {
  insertCommentInYText(ytext, content, threadEndPos);
}

/**
 * Delete a criticmarkup range entirely (all delimiters + content + metadata).
 * Used for "delete my own comment" — the caller is responsible for ownership
 * checks before invoking.
 */
export function deleteRangeInYText(ytext: Y.Text, range: CriticMarkupRange): void {
  ytext.doc!.transact(() => {
    ytext.delete(range.from, range.to - range.from);
  });
}

/**
 * Edit the content of an existing comment (or other criticmarkup range)
 * by replacing the inner content slice. Preserves metadata header and
 * delimiters.
 */
export function editRangeContentInYText(
  ytext: Y.Text,
  range: CriticMarkupRange,
  newContent: string
): void {
  // For comments, the stored content is escaped (same encoding rules).
  const encoded = range.type === 'comment' ? encodeCommentContent(newContent) : newContent;
  ytext.doc!.transact(() => {
    const existingLength = range.contentTo - range.contentFrom;
    ytext.delete(range.contentFrom, existingLength);
    ytext.insert(range.contentFrom, encoded);
  });
}

/**
 * Returns true iff the given range was authored by the current user
 * (best-effort by author name comparison).
 */
export function isOwnRange(range: CriticMarkupRange): boolean {
  return range.metadata?.author === getCurrentAuthor();
}
