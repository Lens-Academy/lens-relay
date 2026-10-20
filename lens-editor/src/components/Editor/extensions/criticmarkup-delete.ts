/**
 * Keeps deleting from breaking the CriticMarkup syntax that live preview hides.
 *
 * Live preview hides a suggestion's delimiters and metadata, and a comment
 * behind its badge (criticmarkup-cursor.ts keeps the cursor out of them). A
 * deletion that still took part of that syntax broke the suggestion: an
 * addition that lost its `++}` runs on to the next `++}` in the document (the
 * parser's patterns span lines), so one keystroke could hide several lines.
 *
 * - Word deletion (Ctrl+Delete and Ctrl+Backspace, Alt+Delete and
 *   Alt+Backspace on a Mac) finds the word in the text as shown, stepping over
 *   hidden syntax, and deletes only shown text. CodeMirror's own counts `{++`,
 *   `++}` and the metadata as words.
 * - A transaction filter on the user's edits (Backspace or Delete on a
 *   selection, typing or pasting over one, cut, drag and drop) leaves the
 *   hidden syntax of a suggestion or comment that an edit covers only part of
 *   in place, and deletes just the text shown in it. A suggestion whose shown
 *   text all goes is removed whole: left empty, it would show its metadata.
 *
 * Live preview only: source mode shows the syntax, so it stays editable there.
 */

import { EditorSelection, EditorState, Prec, StateEffect, Text, Transaction, findClusterBreak } from '@codemirror/state';
import type { ChangeSpec, CharCategory, Extension, TransactionSpec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import type { CriticMarkupRange } from '../../../lib/criticmarkup-parser';
import { hiddenIn, spanAround, type HiddenSpan, type RangesOf } from './criticmarkup-cursor';

/** `spans` sorted, without empty ones, and joined where they overlap or touch */
function joined(spans: readonly HiddenSpan[]): HiddenSpan[] {
  const out: HiddenSpan[] = [];
  for (const span of [...spans].sort((a, b) => a.from - b.from)) {
    if (span.to <= span.from) continue;
    const last = out[out.length - 1];
    if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
    else out.push({ from: span.from, to: span.to });
  }
  return out;
}

/** Whether one of `spans` (joined) covers `from`-`to` */
function covers(spans: readonly HiddenSpan[], from: number, to: number): boolean {
  return spans.some((s) => s.from <= from && to <= s.to);
}

/** `spans` without what `cut` covers; both joined */
function without(spans: readonly HiddenSpan[], cut: readonly HiddenSpan[]): HiddenSpan[] {
  const out: HiddenSpan[] = [];
  for (const span of spans) {
    let from = span.from;
    for (const c of cut) {
      if (c.to <= from || c.from >= span.to) continue;
      if (c.from > from) out.push({ from, to: c.from });
      from = c.to;
    }
    if (from < span.to) out.push({ from, to: span.to });
  }
  return out;
}

/**
 * What of `deleted` (the document ranges an edit deletes) may go, so that no
 * suggestion or comment loses part of its hidden syntax. Of one that the
 * deletion covers only partly, the delimiters and metadata stay (a comment,
 * which shows as a badge, stays whole) and only its shown text goes. With
 * `removeEmptied`, a suggestion whose shown text all goes is removed whole.
 */
export function keepHiddenSyntax(
  deleted: readonly HiddenSpan[],
  ranges: readonly CriticMarkupRange[],
  removeEmptied: boolean,
): HiddenSpan[] {
  let gone = joined(deleted);
  const touched = (r: CriticMarkupRange) => gone.some((d) => d.from < r.to && r.from < d.to);
  if (removeEmptied) {
    for (let grew = true; grew;) {
      grew = false;
      for (const r of ranges) {
        if (r.type === 'comment' || !touched(r) || covers(gone, r.from, r.to)) continue;
        if (r.contentTo > r.contentFrom && !covers(gone, r.contentFrom, r.contentTo)) continue;
        gone = joined([...gone, { from: r.from, to: r.to }]);
        grew = true;
      }
    }
  }
  const kept: HiddenSpan[] = [];
  for (const r of ranges) {
    if (!touched(r) || covers(gone, r.from, r.to)) continue;
    if (r.type === 'comment') kept.push({ from: r.from, to: r.to });
    else kept.push({ from: r.from, to: r.contentFrom }, { from: r.contentTo, to: r.to });
  }
  return without(gone, joined(kept));
}

type Change = { fromA: number; toA: number; fromB: number; toB: number; inserted: Text };

/**
 * The user's edit `tr` with what it deletes cut down by keepHiddenSyntax, as a
 * transaction spec, or null when that changes nothing. What it inserts goes
 * where the first piece still deleted from its range starts (where the
 * replaced text showed), else where it was; its selection follows.
 */
export function protectHiddenSyntax(
  tr: Transaction,
  ranges: readonly CriticMarkupRange[],
  removeEmptied: boolean,
): TransactionSpec | null {
  if (!ranges.length) return null;
  const changes: Change[] = [];
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => changes.push({ fromA, toA, fromB, toB, inserted }));
  const deleted = changes.filter((c) => c.toA > c.fromA).map((c) => ({ from: c.fromA, to: c.toA }));
  if (!deleted.length) return null;
  const gone = keepHiddenSyntax(deleted, ranges, removeEmptied);
  if (gone.length === deleted.length && gone.every((g, i) => g.from === deleted[i].from && g.to === deleted[i].to)) {
    return null;
  }

  // Where each change's text goes: the start of the first piece left to
  // delete in its range (or, for an insertion, of one it falls in), which may
  // be before the change, at a suggestion removed whole
  const at = changes.map((c) => {
    const first = gone.find((g) => c.fromA < g.to && (c.toA > c.fromA ? g.from < c.toA : g.from <= c.fromA));
    return first ? first.from : c.fromA;
  });
  const texts = new Map<number, Text>();
  const offsets = changes.map((c, i) => {
    const before = texts.get(at[i]) ?? Text.empty;
    texts.set(at[i], before.append(c.inserted));
    return before.length;
  });
  const specs: ChangeSpec[] = gone.map((g) => ({ from: g.from, to: g.to, insert: texts.get(g.from) }));
  for (const [pos, insert] of texts) {
    if (insert.length && !gone.some((g) => g.from === pos)) specs.push({ from: pos, insert });
  }
  const next = tr.startState.changes(specs);

  // From where `tr` would leave a position to where this leaves it: inside or
  // at the edge of what a change inserts, by its place in that text
  const back = tr.changes.invertedDesc;
  const map = (pos: number, assoc: number) => {
    const i = changes.findIndex((c) => c.fromB <= pos && pos <= c.toB);
    if (i < 0) return next.mapPos(back.mapPos(pos, assoc), assoc);
    return next.mapPos(at[i], -1) + offsets[i] + pos - changes[i].fromB;
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
  // A user's edit carries no other annotations yet (keepAuthorship adds its
  // own after the filters)
  const history = tr.annotation(Transaction.addToHistory);
  return {
    changes: next,
    selection,
    effects: StateEffect.mapEffects(tr.effects, back.composeDesc(next.desc)),
    scrollIntoView: tr.scrollIntoView,
    userEvent: tr.annotation(Transaction.userEvent),
    annotations: [
      Transaction.time.of(tr.annotation(Transaction.time) ?? Date.now()),
      ...(history === undefined ? [] : [Transaction.addToHistory.of(history)]),
    ],
  };
}

/** The span that starts at `pos` (`forward`) or ends there. `spans` are sorted and apart. */
function spanFrom(spans: readonly HiddenSpan[], pos: number, forward: boolean): HiddenSpan | null {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const edge = forward ? spans[mid].from : spans[mid].to;
    if (edge === pos) return spans[mid];
    if (edge < pos) lo = mid + 1;
    else hi = mid;
  }
  return null;
}

/**
 * Where word deletion from `start` ends, and whether it crossed hidden syntax
 * on the way: CodeMirror's deleteGroupForward (`forward`) or
 * deleteGroupBackward on the text as shown, where hidden syntax counts as
 * nothing. A single space next to the cursor goes with the word after it, and
 * at a line's end (nothing shown before it) the line break goes alone.
 */
export function shownGroupEnd(
  state: EditorState,
  start: number,
  forward: boolean,
  spans: readonly HiddenSpan[],
): { pos: number; crossed: boolean } {
  const categorize = state.charCategorizer(start);
  const inside = spanAround(spans, start);
  let pos = inside ? (forward ? inside.to : inside.from) : start;
  let crossed = !!inside;
  let passed = false; // any shown character
  let group: CharCategory | null = null;
  for (;;) {
    const hidden = spanFrom(spans, pos, forward);
    if (hidden) {
      pos = forward ? hidden.to : hidden.from;
      crossed = true;
      continue;
    }
    const line = state.doc.lineAt(pos);
    if (pos === (forward ? line.to : line.from)) {
      if (!passed && line.number !== (forward ? state.doc.lines : 1)) pos += forward ? 1 : -1;
      break;
    }
    const next = findClusterBreak(line.text, pos - line.from, forward) + line.from;
    const char = line.text.slice(Math.min(pos, next) - line.from, Math.max(pos, next) - line.from);
    const category = categorize(char);
    if (group !== null && category !== group) break;
    if (char !== ' ' || passed) group = category;
    passed = true;
    pos = next;
  }
  return { pos, crossed };
}

/**
 * Word deletion (`forward`, or backward) on the text as shown, from every
 * cursor: deletes the shown text up to the end of the word (shownGroupEnd),
 * never hidden syntax. Returns false, so that CodeMirror's own command runs,
 * when there is a selection to delete or no cursor's word reaches hidden syntax.
 */
export function deleteShownGroup(view: EditorView, rangesOf: RangesOf, forward: boolean): boolean {
  const { state } = view;
  if (state.readOnly || state.selection.ranges.some((r) => !r.empty)) return false;
  const { spans } = hiddenIn(rangesOf(state));
  const ends = state.selection.ranges.map((r) => shownGroupEnd(state, r.head, forward, spans));
  if (!ends.some((end) => end.crossed)) return false;
  const words = state.selection.ranges.map((r, i) => ({
    from: Math.min(r.head, ends[i].pos),
    to: Math.max(r.head, ends[i].pos),
  }));
  const changes = state.changes(without(joined(words), spans));
  // Only hidden syntax up to the document's start or end (a comment): keep it
  if (changes.empty) return true;
  view.dispatch({
    changes,
    selection: EditorSelection.create(
      words.map((w) => EditorSelection.cursor(changes.mapPos(w.from, forward ? 1 : -1), forward ? 1 : -1)),
      state.selection.mainIndex,
    ),
    scrollIntoView: true,
    userEvent: forward ? 'delete.forward' : 'delete.backward',
  });
  return true;
}

/** The user events of edits that can delete: typing, pasting, deleting, cut, drag and drop */
const EDITS = ['input', 'delete', 'move.drop'];

export interface HiddenSyntaxDeletionConfig {
  /** The CriticMarkup ranges of a state */
  rangesOf: RangesOf;
  /** Whether suggestion mode is on: it then decides what an emptied suggestion becomes */
  suggesting: (state: EditorState) => boolean;
  /**
   * Whether the cursor is in an addition of the user's own, where suggestion
   * mode lets edits within its text through and turns ones that go past it
   * into deletion suggestions beside it, never deleting markup
   */
  inOwnAddition: (state: EditorState) => boolean;
  /** Whether Ctrl+Backspace rejects the change at the cursor here instead (criticmarkup-commands) */
  rejectsOnWordDeletion: (view: EditorView) => boolean;
}

/** The deletion handling above */
export function hiddenSyntaxDeletion(config: HiddenSyntaxDeletionConfig): Extension {
  const { rangesOf, suggesting, inOwnAddition, rejectsOnWordDeletion } = config;
  const forward = (view: EditorView) => deleteShownGroup(view, rangesOf, true);
  const back = (view: EditorView) => deleteShownGroup(view, rangesOf, false);
  return [
    // Filters run from the lowest precedence up: ahead of suggestion mode's,
    // which then wraps only what this leaves to delete
    Prec.low(EditorState.transactionFilter.of((tr) => {
      if (!tr.docChanged || !EDITS.some((event) => tr.isUserEvent(event))) return tr;
      const suggests = suggesting(tr.startState);
      if (suggests && inOwnAddition(tr.startState)) return tr;
      return protectHiddenSyntax(tr, rangesOf(tr.startState), !suggests) ?? tr;
    })),
    // CodeMirror's word deletion keys
    Prec.highest(keymap.of([
      { key: 'Mod-Delete', mac: 'Alt-Delete', run: forward },
      { key: 'Mod-Backspace', mac: 'Alt-Backspace', run: (view) => !rejectsOnWordDeletion(view) && back(view) },
      { mac: 'Ctrl-Alt-h', run: back },
    ])),
  ];
}
