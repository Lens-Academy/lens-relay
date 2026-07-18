// src/components/Editor/extensions/criticmarkup-commands.ts
import type { EditorView, KeyBinding } from '@codemirror/view';
import { criticMarkupField, canAcceptRejectFacet } from './criticmarkup';
import type { CriticMarkupRange } from '../../../lib/criticmarkup-parser';

/**
 * Find the CriticMarkup range containing the given position.
 * Returns null if position is not inside any markup.
 */
export function findRangeAtPosition(view: EditorView, pos: number): CriticMarkupRange | null {
  const ranges = view.state.field(criticMarkupField);
  return ranges.find(r => pos >= r.from && pos <= r.to) ?? null;
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

  view.dispatch({ changes: surgicalChangesFor(view, range, 'accept') });
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

  view.dispatch({ changes: surgicalChangesFor(view, range, 'reject') });
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
