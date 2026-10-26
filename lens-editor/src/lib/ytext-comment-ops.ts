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
import { withLinkedComments, type CriticMarkupRange } from './criticmarkup-parser';

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
 * Insert a new comment at `pos` in the Y.Text. With `highlightFrom`, the
 * text from there to `pos` is what the comment is on: it is wrapped in a
 * highlight the comment follows, {==text==}{>>comment<<}, as a CriticMarkup
 * comment on a span is written. Returns where the comment starts (its
 * thread's key).
 */
export function insertCommentInYText(ytext: Y.Text, content: string, pos: number, highlightFrom?: number): number {
  const markup = buildCommentMarkup(content);
  if (highlightFrom == null || highlightFrom >= pos) {
    ytext.insert(pos, markup);
    return pos;
  }
  const wrap = () => {
    ytext.insert(pos, `==}${markup}`);
    ytext.insert(highlightFrom, '{==');
  };
  if (ytext.doc) ytext.doc.transact(wrap);
  else wrap();
  return pos + 6;
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
 * Remove a comment thread (its `comments`, ranges of `ranges`, the Y.Text's
 * parse) and the highlight it is on, keeping the highlighted text: resolving
 * a comment, or deleting its last message (withLinkedComments).
 */
export function removeThreadInYText(ytext: Y.Text, ranges: CriticMarkupRange[], comments: CriticMarkupRange[]): void {
  const spans = withLinkedComments(ranges, comments).flatMap((r) =>
    r.type === 'highlight'
      ? [{ from: r.from, to: r.contentFrom }, { from: r.contentTo, to: r.to }]
      : [{ from: r.from, to: r.to }]);
  ytext.doc!.transact(() => {
    // Last first, so the earlier offsets still hold
    for (const span of spans.reverse()) ytext.delete(span.from, span.to - span.from);
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
