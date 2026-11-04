import { EditorSelection, EditorState, Transaction, type Extension } from '@codemirror/state';
import type * as Y from 'yjs';

/**
 * Keeps the caret past a link someone else turned into a wikilink. A plain
 * mapping leaves a caret that was at or in the link before the new markup, so
 * the next thing typed lands in front of it, or inside a suggestion's markup.
 *
 * Only link swaps, recognised narrowly: any other edit by someone else is left
 * to CodeMirror, whose mapping is right for ordinary co-editing (a caret in a
 * sentence someone retypes stays where their typing began, not after it).
 */

interface Change {
  fromA: number;
  toA: number;
  toB: number;
  inserted: string;
}

/** What a swap removes: some of a URL, or the `[` that opens a label. */
const isLinkText = (text: string) => text.includes('http') || text === '[';
const isWikilinkMarkup = (text: string) => text.includes('[[') || text.includes(']]');
/** The closing half of a link wrapped as a suggestion: `--}{++meta@@[[…]]++}`. */
const isSuggestedSwapEnd = (text: string) => text.startsWith('--}{++') && text.includes('[[');

/** Where a caret at `pos` should go after a link swap in `tr`, or null. */
function endOfSwap(tr: Transaction, changes: Change[], pos: number): number | null {
  let end: number | null = null;
  for (const change of changes) {
    const { fromA, toA, toB, inserted } = change;
    if (fromA < toA && inserted && fromA < pos && pos <= toA) {
      // A swap in place: the link's text out, wikilink markup in
      if (isLinkText(tr.startState.doc.sliceString(fromA, toA)) && isWikilinkMarkup(inserted)) end = toB;
    } else if (fromA === toA && isSuggestedSwapEnd(inserted)) {
      // A swap as a suggestion: `{--meta@@` went in at the link's start, this at its end
      const opener = [...changes]
        .reverse()
        .find((other) => other.fromA === other.toA && other.fromA < fromA && other.inserted.startsWith('{--'));
      if (opener && opener.fromA < pos && pos <= fromA) end = toB;
    }
  }
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
    const changes: Change[] = [];
    tr.changes.iterChanges((fromA, toA, _fromB, toB, inserted) =>
      changes.push({ fromA, toA, toB, inserted: inserted.toString() }),
    );
    // Cheap first: no wikilink markup going in, no swap
    if (!changes.some(({ inserted }) => isWikilinkMarkup(inserted))) return tr;
    const { ranges, mainIndex } = tr.startState.selection;
    let moved = false;
    const next = ranges.map((range) => {
      const end = range.empty ? endOfSwap(tr, changes, range.head) : null;
      if (end === null) return range.map(tr.changes);
      moved = true;
      return EditorSelection.cursor(end);
    });
    if (!moved || !cameFromY(tr, ytext)) return tr;
    return [tr, { selection: EditorSelection.create(next, mainIndex), sequential: true }];
  });
}
