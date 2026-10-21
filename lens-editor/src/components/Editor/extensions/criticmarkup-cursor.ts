/**
 * Keeps the cursor out of the CriticMarkup syntax that live preview hides.
 *
 * Live preview hides a suggestion's delimiters and metadata (`{++{"author":…}@@`
 * and `++}`) in font-size: 0 spans, and a comment behind its badge, even with
 * the cursor on the line. Every position inside such a span is at the same
 * place on screen, so the cursor could stop there unseen: ArrowRight took one
 * press per hidden character, and Home, End or a click could leave the cursor
 * inside a delimiter (`{|++An added line++}`), where typing broke the markup.
 *
 * - The hidden spans are atomic ranges, so arrow keys, clicks and drags step
 *   over them in one go.
 * - A transaction filter does the same for the cursor moves CodeMirror doesn't
 *   check against atomic ranges: Home and End on a wrapped line's other rows
 *   (found by screen position), selections read from the page (touch), other
 *   extensions' commands.
 * - Home and End go to the line's start and end from its first and last row,
 *   as without line wrapping, instead of searching by screen position, which
 *   hidden syntax throws off.
 * - Backspace and Delete next to a hidden span delete the visible character
 *   on its far side, instead of a hidden character (or, by the atomic ranges,
 *   a whole delimiter).
 * - A cursor beside a hidden span faces the text on its other side, so that
 *   it is drawn as tall as that text, not as the hidden text (no height).
 *
 * Live preview only: source mode shows the syntax, so it stays editable there.
 */

import { EditorSelection, EditorState, Prec, RangeSet, RangeValue } from '@codemirror/state';
import type { Extension, SelectionRange, Text } from '@codemirror/state';
import { Direction, EditorView, ViewPlugin, keymap } from '@codemirror/view';
import type { CriticMarkupRange } from '../../../lib/criticmarkup-parser';

export interface HiddenSpan {
  from: number;
  to: number;
}

/**
 * The spans live preview hides: each suggestion's opening delimiter with its
 * metadata and its closing delimiter, and whole comments. Spans that touch are
 * joined (`--}{++` in a deletion+addition pair, a highlight's `==}` and its
 * comment, the comments of a thread), so the cursor doesn't stop between
 * them either.
 */
export function hiddenSyntaxSpans(ranges: readonly CriticMarkupRange[]): HiddenSpan[] {
  const parts: HiddenSpan[] = [];
  for (const r of ranges) {
    if (r.type === 'comment') parts.push({ from: r.from, to: r.to });
    else parts.push({ from: r.from, to: r.contentFrom }, { from: r.contentTo, to: r.to });
  }
  parts.sort((a, b) => a.from - b.from);
  const spans: HiddenSpan[] = [];
  for (const part of parts) {
    const last = spans[spans.length - 1];
    if (last && part.from <= last.to) last.to = Math.max(last.to, part.to);
    else spans.push({ ...part });
  }
  return spans;
}

/** The span that `pos` is strictly inside, if any. `spans` are sorted and apart. */
function spanAround(spans: readonly HiddenSpan[], pos: number): HiddenSpan | null {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const span = spans[mid];
    if (pos <= span.from) hi = mid;
    else if (pos >= span.to) lo = mid + 1;
    else return span;
  }
  return null;
}

/** The span that `pos` is inside or at an edge of, if any. Spans that touch are joined, so there is one at most. */
function spanAt(spans: readonly HiddenSpan[], pos: number): HiddenSpan | null {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const span = spans[mid];
    if (pos < span.from) hi = mid;
    else if (pos > span.to) lo = mid + 1;
    else return span;
  }
  return null;
}

/**
 * `selection` with every cursor at an edge of a hidden span associated with
 * the other side, or null when no cursor needed that.
 *
 * CodeMirror draws a cursor by the character on the side it is associated
 * with, and measures from there when it moves up or down, or to a wrapped
 * row's start or end. Hidden syntax is font-size: 0, so a cursor associated
 * with it was drawn with no height and couldn't be seen: after ArrowRight over
 * a suggestion's opening delimiter, for one, which leaves the cursor
 * associated with what it stepped over.
 *
 * A cursor keeps its side where the other one isn't on its line (at the start
 * or end of `{++An added line++}`) or, as `onRow` tells, on its screen row (a
 * wrapped row that starts with a suggestion): there it would be drawn at the
 * end of the row above, and Home, End and the arrow keys would go from there.
 */
export function faceShownSide(
  selection: EditorSelection,
  spans: readonly HiddenSpan[],
  doc: Text,
  onRow: (pos: number, side: -1 | 1) => boolean = () => true,
): EditorSelection | null {
  let turned = false;
  const ranges = selection.ranges.map((range) => {
    if (!range.empty) return range;
    const pos = range.head;
    const span = spanAt(spans, pos);
    if (!span || (span.from < pos && pos < span.to)) return range;
    const side = pos === span.to ? 1 : -1;
    const line = doc.lineAt(pos);
    if (range.assoc === side || pos === (side > 0 ? line.to : line.from) || !onRow(pos, side)) return range;
    turned = true;
    return EditorSelection.cursor(pos, side, range.bidiLevel ?? undefined, range.goalColumn);
  });
  return turned ? EditorSelection.create(ranges, selection.mainIndex) : null;
}

/**
 * Whether the character on side `side` of `pos` is on the screen row of the
 * hidden syntax on its other side. True where either isn't drawn, or the
 * layout can't be read (during a view update).
 */
function sameRow(view: EditorView, pos: number, side: -1 | 1): boolean {
  try {
    const shown = view.coordsAtPos(pos, side);
    const hidden = view.coordsAtPos(pos, side < 0 ? 1 : -1);
    if (!shown || !hidden) return true;
    // A hidden character's box has no height: it sits on its row's baseline,
    // which can be a little below a widget's box (a comment badge is shorter
    // than the text), and far from a box on the row above or below
    return shown.top <= hidden.bottom && hidden.top <= shown.bottom + (shown.bottom - shown.top) / 2;
  } catch {
    return true;
  }
}

// The view that shows each state, so that a transaction filter, which gets no
// view, can measure in it
const viewOf = new WeakMap<EditorState, EditorView>();
const trackView = ViewPlugin.define((view) => {
  viewOf.set(view.state, view);
  return { update: (update) => void viewOf.set(update.state, update.view) };
});

/**
 * Where a selection end at `pos`, inside `span`, goes. One that came in from a
 * side (it was at `before`) steps across, as with arrow keys: Home, and
 * ArrowUp, stop at the span's start; End, and ArrowDown, at its end. Otherwise
 * the nearer edge.
 */
function edgeFor(span: HiddenSpan, pos: number, before: number): number {
  if (before <= span.from) return span.to;
  if (before >= span.to) return span.from;
  return pos - span.from <= span.to - pos ? span.from : span.to;
}

/**
 * `selection` with every end that is inside a hidden span moved to an edge of
 * it (see edgeFor), or null when no end is inside one. `before` is the
 * selection it was moved from, in the same document.
 */
export function moveOutOfHiddenSyntax(
  selection: EditorSelection,
  before: EditorSelection,
  spans: readonly HiddenSpan[],
): EditorSelection | null {
  let moved = false;
  const ranges = selection.ranges.map((range, i) => {
    const prev = before.ranges.length === selection.ranges.length ? before.ranges[i] : before.main;
    const headSpan = spanAround(spans, range.head);
    const anchorSpan = range.empty ? null : spanAround(spans, range.anchor);
    if (!headSpan && !anchorSpan) return range;
    moved = true;
    const head = headSpan ? edgeFor(headSpan, range.head, prev.head) : range.head;
    if (range.empty) {
      // Associated with the hidden side, as CodeMirror's atomic skipping does;
      // a later filter turns it to the text beside it (faceShownSide)
      return EditorSelection.cursor(head, head === headSpan?.from ? 1 : -1, range.bidiLevel ?? undefined, range.goalColumn);
    }
    const anchor = anchorSpan ? edgeFor(anchorSpan, range.anchor, prev.anchor) : range.anchor;
    return EditorSelection.range(anchor, head, range.goalColumn, range.bidiLevel ?? undefined);
  });
  return moved ? EditorSelection.create(ranges, selection.mainIndex) : null;
}

class HiddenSyntax extends RangeValue {}
const hiddenSyntax = new HiddenSyntax();

type RangesOf = (state: EditorState) => readonly CriticMarkupRange[];
type Hidden = { spans: HiddenSpan[]; set: RangeSet<HiddenSyntax> };

// Per parse: the ranges array changes only when the document does
const hiddenCache = new WeakMap<readonly CriticMarkupRange[], Hidden>();

function hiddenIn(ranges: readonly CriticMarkupRange[]): Hidden {
  let hidden = hiddenCache.get(ranges);
  if (!hidden) {
    const spans = hiddenSyntaxSpans(ranges);
    hidden = { spans, set: RangeSet.of(spans.map((s) => hiddenSyntax.range(s.from, s.to))) };
    hiddenCache.set(ranges, hidden);
  }
  return hidden;
}

/**
 * Backspace (`forward` false) and Delete: a cursor at the end of a hidden span
 * on the side it deletes (or inside one, where a command put it) first moves
 * to the span's other end, so the delete command that runs next removes the
 * visible character beyond it. Returns false, so that that command (and the
 * suggestion-mode wrapping, which sees the cursor where the delete starts) runs.
 */
export function stepOverHiddenSyntax(view: EditorView, rangesOf: RangesOf, forward: boolean): boolean {
  const { state } = view;
  if (state.readOnly) return false;
  const { spans } = hiddenIn(rangesOf(state));
  let moved = false;
  const ranges = state.selection.ranges.map((range) => {
    if (!range.empty) return range;
    // Spans are at least three characters long, so one beside the cursor
    // contains the next position over
    const beside = spanAround(spans, forward ? range.head + 1 : range.head - 1);
    const span = spanAround(spans, range.head) ?? (range.head === (forward ? beside?.from : beside?.to) ? beside : null);
    if (!span) return range;
    moved = true;
    return EditorSelection.cursor(forward ? span.to : span.from, forward ? -1 : 1);
  });
  if (moved) view.dispatch({ selection: EditorSelection.create(ranges, state.selection.mainIndex) });
  return false;
}

/** Whether line boundary `end` is on the screen row of the cursor `start` */
function onCursorRow(view: EditorView, start: SelectionRange, end: number, forward: boolean): boolean {
  // The row CodeMirror takes for the cursor (see its moveToLineBoundary)
  const line = view.state.doc.lineAt(start.head);
  const cursor = view.coordsAtPos(start.assoc < 0 && start.head > line.from ? start.head - 1 : start.head);
  const boundary = view.coordsAtPos(end, forward ? -1 : 1);
  // A hidden character's box has no height: it sits on its row's baseline
  return !!cursor && !!boundary && cursor.top <= boundary.bottom && boundary.top <= cursor.bottom;
}

/**
 * Where Home (`forward` false) or End moves `start`: CodeMirror's
 * moveByLineBoundary, except on the line's first row (for Home) or last row
 * (for End), where it is the line's start or end, as it is without line
 * wrapping. With wrapping, CodeMirror finds the row's start or end by screen
 * position, and the zero-size boxes of hidden syntax can stop that short or
 * send it past: after a suggestion's opening delimiter, or after a comment
 * badge.
 */
export function lineBoundaryTarget(
  view: EditorView,
  start: SelectionRange,
  forward: boolean,
  spans: readonly HiddenSpan[],
): SelectionRange {
  const line = view.lineBlockAt(start.head);
  // The line's start or end, or, where hidden syntax runs over it from the line
  // before or after (a comment written over two lines), where its text shows
  const hidden = spanAround(spans, forward ? line.to : line.from);
  const end = hidden ? (forward ? hidden.from : hidden.to) : forward ? line.to : line.from;
  let moved = view.moveToLineBoundary(start, forward);
  if (moved.head !== end && onCursorRow(view, start, end, forward)) {
    moved = EditorSelection.cursor(end, forward ? -1 : 1);
  } else if (moved.head === start.head && moved.head !== end) {
    // At a wrapped row's start or end already: on to the line's
    moved = EditorSelection.cursor(end, forward ? -1 : 1);
  }
  // Home goes to the end of the indentation first
  if (!forward && moved.head === line.from && line.length) {
    const space = /^\s*/.exec(view.state.sliceDoc(line.from, Math.min(line.from + 100, line.to)))![0].length;
    if (space && start.head !== line.from + space) moved = EditorSelection.cursor(line.from + space);
  }
  return moved;
}

/** Home or End (`forward`), selecting with `extend` */
function cursorToLineBoundary(view: EditorView, rangesOf: RangesOf, forward: boolean, extend: boolean): boolean {
  const { selection } = view.state;
  const { spans } = hiddenIn(rangesOf(view.state));
  const next = EditorSelection.create(selection.ranges.map((range) => {
    const moved = lineBoundaryTarget(view, range, forward, spans);
    return extend ? EditorSelection.range(range.anchor, moved.head, moved.goalColumn, moved.bidiLevel ?? undefined) : moved;
  }), selection.mainIndex);
  if (next.eq(selection, true)) return false;
  view.dispatch({ selection: next, scrollIntoView: true, userEvent: 'select' });
  return true;
}

/** The cursor handling above, for the CriticMarkup ranges `rangesOf` reads */
export function hiddenSyntaxCursor(rangesOf: RangesOf): Extension {
  const back = (view: EditorView) => stepOverHiddenSyntax(view, rangesOf, false);
  const forward = (view: EditorView) => stepOverHiddenSyntax(view, rangesOf, true);
  const home = (extend: boolean) => (view: EditorView) => cursorToLineBoundary(view, rangesOf, false, extend);
  const end = (extend: boolean) => (view: EditorView) => cursorToLineBoundary(view, rangesOf, true, extend);
  // Cmd+Left/Right go to the line's visual left and right
  const ltr = (view: EditorView) => view.textDirectionAt(view.state.selection.main.head) === Direction.LTR;
  const left = (extend: boolean) => (view: EditorView) => cursorToLineBoundary(view, rangesOf, !ltr(view), extend);
  const right = (extend: boolean) => (view: EditorView) => cursorToLineBoundary(view, rangesOf, ltr(view), extend);
  return [
    EditorView.atomicRanges.of((view) => hiddenIn(rangesOf(view.state)).set),
    EditorState.transactionFilter.of((tr) => {
      if (!tr.selection || !tr.isUserEvent('select')) return tr;
      const { spans } = hiddenIn(rangesOf(tr.docChanged ? tr.state : tr.startState));
      const moved = moveOutOfHiddenSyntax(tr.selection, tr.startState.selection.map(tr.changes), spans);
      return moved ? [tr, { selection: moved, sequential: true }] : tr;
    }),
    // Every cursor beside hidden syntax, wherever it came from (a key, a
    // click, typing, a command), faces the text beside it. Runs after the
    // other filters (highest precedence), so it sees the selection they leave.
    Prec.highest(EditorState.transactionFilter.of((tr) => {
      if (!tr.selection && !tr.docChanged) return tr;
      const state = tr.docChanged ? tr.state : tr.startState;
      // Rows can be measured while the view shows the document the selection is in
      const view = tr.docChanged ? undefined : viewOf.get(tr.startState);
      const onRow = view?.state === tr.startState ? (pos: number, side: -1 | 1) => sameRow(view, pos, side) : undefined;
      const facing = faceShownSide(tr.newSelection, hiddenIn(rangesOf(state)).spans, state.doc, onRow);
      return facing ? [tr, { selection: facing, sequential: true }] : tr;
    })),
    trackView,
    // Ahead of every other Backspace/Delete binding, which then see the moved cursor
    Prec.highest(keymap.of([
      { key: 'Backspace', run: back, shift: back },
      { key: 'Delete', run: forward },
      { key: 'Home', run: home(false), shift: home(true), preventDefault: true },
      { key: 'End', run: end(false), shift: end(true), preventDefault: true },
      { mac: 'Cmd-ArrowLeft', run: left(false), shift: left(true), preventDefault: true },
      { mac: 'Cmd-ArrowRight', run: right(false), shift: right(true), preventDefault: true },
    ])),
  ];
}
