// src/components/Editor/extensions/criticmarkup-commands.ts
import type { EditorState } from '@codemirror/state';
import type { EditorView, KeyBinding } from '@codemirror/view';
import { criticMarkupField, canAcceptRejectFacet } from './criticmarkup';
import type { CriticMarkupRange } from '../../../lib/criticmarkup-parser';

/**
 * Find the CriticMarkup range containing the given position, or the change
 * nested in it there (a deletion of part of someone else's addition; not a
 * comment or highlight on it). Returns null if position is not inside any markup.
 */
export function findRangeAtPosition(view: EditorView, pos: number): CriticMarkupRange | null {
  const ranges = view.state.field(criticMarkupField);
  let found: CriticMarkupRange | null = null;
  for (const r of ranges) {
    if (pos < r.from || pos > r.to) continue;
    const nested = found && r.from >= found.from && r.to <= found.to;
    if (!found || (nested && r.type !== 'comment' && r.type !== 'highlight')) found = r;
  }
  return found;
}

/**
 * Find the CriticMarkup range containing the cursor position.
 */
function findRangeAtCursor(view: EditorView): CriticMarkupRange | null {
  return findRangeAtPosition(view, view.state.selection.main.head);
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
 * Suggestion mode splits someone else's addition around the text you type
 * into it (their part, yours, their part). When that addition of yours goes
 * (rejected, or its last character deleted), this is the change that removes
 * it and joins their two parts again: from the first part's content end to
 * the second part's content start. Null when `range` isn't between two
 * additions that open alike (same author and time, or both without metadata).
 */
export function removalJoiningSplit(state: EditorState, range: CriticMarkupRange): CmChange | null {
  const ranges = state.field(criticMarkupField);
  const before = ranges.find(r => r.type === 'addition' && r.to === range.from);
  const after = ranges.find(r => r.type === 'addition' && r.from === range.to);
  if (!before || !after) return null;
  const opening = (r: CriticMarkupRange) => state.doc.sliceString(r.from, r.contentFrom);
  if (opening(before) !== opening(after)) return null;
  return { from: before.contentTo, to: after.contentFrom };
}

/**
 * Accept or reject one change: a range, or the two ranges of a deletion+addition
 * pair. Removing a range whole also joins the parts of an addition it split.
 */
export function applyChange(view: EditorView, ranges: CriticMarkupRange[], action: 'accept' | 'reject'): void {
  let changes = ranges.flatMap(r => surgicalChangesFor(view, r, action));
  const [only] = changes;
  if (ranges.length === 1 && changes.length === 1 && only.from === ranges[0].from && only.to === ranges[0].to && !only.insert) {
    changes = [removalJoiningSplit(view.state, ranges[0]) ?? only];
  }
  view.dispatch({ changes });
}

/**
 * Accept CriticMarkup changes. If a non-collapsed selection exists,
 * accepts all ranges overlapping the selection. Otherwise accepts
 * the single range at cursor position.
 * Returns true if any change was accepted.
 */
export function acceptChangeAtCursor(view: EditorView): boolean {
  const selected = findRangesInSelection(view);
  if (selected.length > 0) {
    view.dispatch({ changes: selected.flatMap(r => surgicalChangesFor(view, r, 'accept')) });
    return true;
  }

  const range = findRangeAtCursor(view);
  if (!range) return false;

  applyChange(view, [range], 'accept');
  return true;
}

/**
 * Reject CriticMarkup changes. If a non-collapsed selection exists,
 * rejects all ranges overlapping the selection. Otherwise rejects
 * the single range at cursor position.
 * Returns true if any change was rejected.
 */
export function rejectChangeAtCursor(view: EditorView): boolean {
  const selected = findRangesInSelection(view);
  if (selected.length > 0) {
    view.dispatch({ changes: selected.flatMap(r => surgicalChangesFor(view, r, 'reject')) });
    return true;
  }

  const range = findRangeAtCursor(view);
  if (!range) return false;

  applyChange(view, [range], 'reject');
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
