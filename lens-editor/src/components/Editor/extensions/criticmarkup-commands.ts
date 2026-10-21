// src/components/Editor/extensions/criticmarkup-commands.ts
import type { EditorView, KeyBinding } from '@codemirror/view';
import { criticMarkupField, canAcceptRejectFacet } from './criticmarkup';
import { countEdits, isAdjacentEditPair, isSuggestion, type CriticMarkupRange } from '../../../lib/criticmarkup-parser';

/**
 * Find the CriticMarkup range containing the given position.
 * Returns null if position is not inside any markup.
 */
export function findRangeAtPosition(view: EditorView, pos: number): CriticMarkupRange | null {
  const ranges = view.state.field(criticMarkupField);
  return ranges.find(r => pos >= r.from && pos <= r.to) ?? null;
}

/**
 * Find the CriticMarkup range containing the cursor position that accept and
 * reject act on: never a comment (accepting or rejecting one deletes it,
 * replies and all), but a change around it or right after it.
 */
function findRangeAtCursor(view: EditorView): CriticMarkupRange | null {
  const pos = view.state.selection.main.head;
  const range = findRangeAtPosition(view, pos);
  if (range?.type !== 'comment') return range;
  return view.state.field(criticMarkupField).find(r => r.type !== 'comment' && pos >= r.from && pos <= r.to) ?? null;
}

/**
 * Find all CriticMarkup ranges overlapping the current selection.
 * Returns empty array if selection is collapsed (cursor only).
 */
export function findRangesInSelection(view: EditorView): CriticMarkupRange[] {
  const sel = view.state.selection.main;
  if (sel.from === sel.to) return [];
  const ranges = view.state.field(criticMarkupField);
  return ranges.filter(r => r.from < sel.to && r.to > sel.from);
}

/**
 * The suggestions (additions, deletions, substitutions) the selection
 * overlaps, each deletion+addition pair whole, in document order: what the
 * bulk ✓ ✗ accept or reject. Its comments and highlights stay as they are.
 */
export function suggestionsInSelection(view: EditorView): CriticMarkupRange[] {
  const ranges = view.state.field(criticMarkupField);
  const picked = new Set<CriticMarkupRange>();
  for (const range of findRangesInSelection(view)) {
    if (!isSuggestion(range)) continue;
    const i = ranges.indexOf(range);
    if (i > 0 && isAdjacentEditPair(ranges[i - 1], range)) picked.add(ranges[i - 1]);
    picked.add(range);
    if (i + 1 < ranges.length && isAdjacentEditPair(range, ranges[i + 1])) picked.add(ranges[i + 1]);
  }
  return [...picked].sort((a, b) => a.from - b.from);
}

/**
 * The count on the bulk ✓ ✗, which show for a selection over several
 * CriticMarkup ranges: its suggestions, a deletion+addition pair counted once.
 * Null when the selection overlaps one range or none (that range's own ✓ ✗
 * show instead); 0 when they are all comments and highlights (no buttons).
 */
export function bulkChangeCount(view: EditorView): number | null {
  if (findRangesInSelection(view).length < 2) return null;
  return countEdits(suggestionsInSelection(view));
}

/**
 * Get the replacement text when accepting a CriticMarkup range.
 * Returns the content that should replace the entire markup.
 */
export function getAcceptReplacement(range: CriticMarkupRange): string {
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
export function getRejectReplacement(range: CriticMarkupRange): string {
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

type CmChange = { from: number; to: number; insert?: string };

/**
 * Build the changes for accepting/rejecting one range, deleting only the
 * markers/metadata/discarded content so the kept payload characters survive
 * in place. This preserves per-character authorship (provenance): the old
 * whole-span replace re-minted kept text under whoever clicked accept.
 * Falls back to the legacy full replace when positions don't line up.
 */
export function surgicalChangesFor(
  view: EditorView,
  range: CriticMarkupRange,
  action: 'accept' | 'reject'
): CmChange[] {
  const fallback: CmChange[] = [{
    from: range.from,
    to: range.to,
    insert: action === 'accept' ? getAcceptReplacement(range) : getRejectReplacement(range),
  }];

  const wholeSpan: CmChange[] = [{ from: range.from, to: range.to }];

  switch (range.type) {
    case 'comment':
      return wholeSpan;
    case 'addition':
      if (action === 'reject') return wholeSpan;
      break;
    case 'deletion':
      if (action === 'accept') return wholeSpan;
      break;
    case 'highlight':
      break;
    case 'substitution': {
      const oldContent = range.oldContent ?? '';
      const newContent = range.newContent ?? '';
      const doc = view.state.doc;
      if (action === 'accept') {
        const newStart = range.contentTo - newContent.length;
        if (newStart < range.contentFrom) return fallback;
        if (doc.sliceString(newStart, range.contentTo) !== newContent) return fallback;
        return [
          { from: range.from, to: newStart },
          { from: range.contentTo, to: range.to },
        ];
      }
      const oldEnd = range.contentFrom + oldContent.length;
      if (oldEnd > range.contentTo) return fallback;
      if (doc.sliceString(range.contentFrom, oldEnd) !== oldContent) return fallback;
      return [
        { from: range.from, to: range.contentFrom },
        { from: oldEnd, to: range.to },
      ];
    }
    default:
      return fallback;
  }

  // addition-accept / deletion-reject / highlight: keep [contentFrom, contentTo).
  if (range.contentFrom < range.from || range.contentTo > range.to) return fallback;
  return [
    { from: range.from, to: range.contentFrom },
    { from: range.contentTo, to: range.to },
  ];
}

/**
 * The ranges accept and reject act on. With a non-collapsed selection: the
 * suggestions it overlaps (suggestionsInSelection), or a highlight that is
 * all it overlaps (its own ✓ ✗ show there). Otherwise the range at the
 * cursor, never a comment.
 */
function rangesToApply(view: EditorView): CriticMarkupRange[] {
  const selected = findRangesInSelection(view);
  if (selected.length === 0) {
    const range = findRangeAtCursor(view);
    return range ? [range] : [];
  }
  const suggestions = suggestionsInSelection(view);
  if (suggestions.length === 0 && selected.length === 1 && selected[0].type === 'highlight') return selected;
  return suggestions;
}

/**
 * Accept CriticMarkup changes: the suggestions a non-collapsed selection
 * overlaps, or the change at the cursor (see rangesToApply).
 * Returns true if any change was accepted.
 */
export function acceptChangeAtCursor(view: EditorView): boolean {
  const targets = rangesToApply(view);
  if (targets.length === 0) return false;

  view.dispatch({ changes: targets.flatMap(r => surgicalChangesFor(view, r, 'accept')) });
  return true;
}

/**
 * Reject CriticMarkup changes: the suggestions a non-collapsed selection
 * overlaps, or the change at the cursor (see rangesToApply).
 * Returns true if any change was rejected.
 */
export function rejectChangeAtCursor(view: EditorView): boolean {
  const targets = rangesToApply(view);
  if (targets.length === 0) return false;

  view.dispatch({ changes: targets.flatMap(r => surgicalChangesFor(view, r, 'reject')) });
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
    run: (view) => {
      if (!view.state.facet(canAcceptRejectFacet)) return false;
      return acceptChangeAtCursor(view);
    },
  },
  {
    key: 'Mod-Backspace',
    run: (view) => {
      if (!view.state.facet(canAcceptRejectFacet)) return false;
      return rejectChangeAtCursor(view);
    },
  },
];
