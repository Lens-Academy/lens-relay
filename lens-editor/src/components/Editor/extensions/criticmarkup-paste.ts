/**
 * Keeps a suggestion-mode paste from nesting a suggestion inside yours.
 *
 * Suggestion mode adds what you paste or drop as an addition of yours
 * (suggestionModeFilter in criticmarkup.ts). Copied text with a whole
 * suggestion in it carries the suggestion's markup, and inside your addition it
 * nested: `{++<you>@@ends with {++<them>@@an addition++}++}`. The parsers (this
 * editor's, the relay's and the review page's) end an addition at the first
 * `++}`, so yours ended at theirs: the editor showed `{++<them>@@` as text, and
 * a stray `++}` after it.
 *
 * Now the CriticMarkup in text you add in suggestion mode goes in as plain
 * text, as it reads once accepted (acceptedPieces): an addition's and a
 * highlight's text stay, a substitution's new text stays, and a deletion's text
 * and comments go. Your paste is one addition of yours, with one ✓ ✗. A pasted
 * suggestion can't stay its author's: they never suggested it there, and a
 * pasted deletion would put its text in the document for good when rejected,
 * without anyone accepting it.
 *
 * In source mode too: suggestion mode wraps what you add there as well.
 */

import { EditorSelection, EditorState, Transaction } from '@codemirror/state';
import type { Extension, StateField, TransactionSpec } from '@codemirror/state';
import { acceptedPieces } from '../../../lib/criticmarkup-actions';

type Piece = { from: number; to: number };

/** How many characters of `pieces` (sorted, apart) come before `offset` */
function keptBefore(pieces: readonly Piece[], offset: number): number {
  let n = 0;
  for (const p of pieces) n += Math.max(0, Math.min(p.to, offset) - p.from);
  return n;
}

/**
 * The transaction filter above, for the user's edits while `suggesting` is on.
 * It must run before suggestionModeFilter: filters run from the last one
 * given to the first.
 */
export function pastedSuggestionsAccepted(suggesting: StateField<boolean>): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || !tr.startState.field(suggesting) || !tr.annotation(Transaction.userEvent)) return tr;

    const inserts: { fromA: number; toA: number; fromB: number; toB: number; pieces: Piece[]; text: string; accepted: string }[] = [];
    tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      const text = inserted.toString();
      const pieces = acceptedPieces(text);
      const accepted = pieces.map((p) => text.slice(p.from, p.to)).join('');
      inserts.push({ fromA, toA, fromB, toB, pieces, text, accepted });
    });
    if (inserts.every((c) => c.accepted === c.text)) return tr;

    const changes = tr.startState.changes(inserts.map((c) => ({ from: c.fromA, to: c.toA, insert: c.accepted })));
    // From where `tr` would leave a position to where this leaves it: one in
    // the text a change inserts goes after what is kept of that text before it
    const back = tr.changes.invertedDesc;
    const map = (pos: number, assoc: number) => {
      const c = inserts.find((c) => c.fromB <= pos && pos <= c.toB);
      if (!c) return changes.mapPos(back.mapPos(pos, assoc), assoc);
      return changes.mapPos(c.fromA, -1) + keptBefore(c.pieces, pos - c.fromB);
    };
    const selection = tr.selection && EditorSelection.create(
      tr.selection.ranges.map((r) => {
        if (r.empty) return EditorSelection.cursor(map(r.head, r.assoc || -1), r.assoc);
        const from = map(r.from, 1);
        const to = Math.max(from, map(r.to, -1));
        return r.anchor < r.head ? EditorSelection.range(from, to) : EditorSelection.range(to, from);
      }),
      tr.selection.mainIndex,
    );
    return {
      changes,
      selection,
      effects: tr.effects,
      scrollIntoView: tr.scrollIntoView,
      userEvent: tr.annotation(Transaction.userEvent),
    };
  });
}

/**
 * `spec`, what suggestion mode makes of `tr`, with `tr`'s user event if it is
 * a paste or a drop: keepAuthorship knows pasted and dropped text by it, and
 * gives text copied in an editor its authors back.
 */
export function keepPasteEvent(tr: Transaction, spec: Transaction | TransactionSpec): Transaction | TransactionSpec {
  if (spec instanceof Transaction) return spec;
  if (!['input.paste', 'input.drop', 'move.drop'].some((event) => tr.isUserEvent(event))) return spec;
  return { ...spec, userEvent: tr.annotation(Transaction.userEvent) };
}
