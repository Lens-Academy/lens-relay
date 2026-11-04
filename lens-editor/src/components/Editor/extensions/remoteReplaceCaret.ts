import { EditorSelection, EditorState, Transaction, type Extension } from '@codemirror/state';
import type * as Y from 'yjs';

/**
 * Keeps the caret past text someone else replaced. When another person's edit
 * replaces text the caret is in, or just after, a plain mapping leaves it before
 * the new text, so the next thing typed lands in front of it: someone writing
 * after a bare URL would find their words before the wikilink it became. A caret
 * at the start of the replaced text stays before it, and one in a link's label
 * isn't in any change, since a swap leaves the label alone.
 */

/** The end of the replacement a caret at `pos` was in, or null. */
function endOfReplacement(tr: Transaction, pos: number): number | null {
  let end: number | null = null;
  tr.changes.iterChanges((fromA, toA, fromB, toB) => {
    if (fromA < toA && fromB < toB && fromA < pos && pos <= toA) end = toB;
  });
  return end;
}

/**
 * Whether the Y.Text had this change before the editor did, as it does for
 * another person's edit. A local change hasn't reached it yet. y-sync marks its
 * transactions with an annotation, but the package doesn't export it.
 */
function cameFromY(tr: Transaction, ytext: Y.Text): boolean {
  if (ytext.length !== tr.newDoc.length) return false;
  return ytext.length !== tr.startState.doc.length || ytext.toString() === tr.newDoc.toString();
}

export function remoteReplaceCaret(ytext: Y.Text): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || tr.selection || tr.annotation(Transaction.userEvent)) return tr;
    const { ranges, mainIndex } = tr.startState.selection;
    let moved = false;
    const next = ranges.map((range) => {
      const end = range.empty ? endOfReplacement(tr, range.head) : null;
      if (end === null) return range.map(tr.changes);
      moved = true;
      return EditorSelection.cursor(end);
    });
    if (!moved || !cameFromY(tr, ytext)) return tr;
    return [tr, { selection: EditorSelection.create(next, mainIndex), sequential: true }];
  });
}
