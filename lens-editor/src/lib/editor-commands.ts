/**
 * Formatting commands for the mobile editing toolbar.
 *
 * All commands operate on an EditorView and keep the selection sensible
 * afterwards. Line commands toggle: if every selected line already has the
 * prefix, it is removed; otherwise it is added.
 */

import type { EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import { yUndoManagerKeymap } from 'y-codemirror.next';

/** Wrap or unwrap the main selection with a symmetric inline marker (e.g. `**`). */
export function toggleInlineMark(view: EditorView, mark: string): boolean {
  const { state } = view;
  const range = state.selection.main;
  const len = mark.length;

  if (range.empty) {
    // Insert a marker pair and put the cursor between
    view.dispatch({
      userEvent: 'input.format',
      changes: { from: range.from, insert: mark + mark },
      selection: EditorSelection.cursor(range.from + len),
    });
    return true;
  }

  const selected = state.sliceDoc(range.from, range.to);
  const before = state.sliceDoc(Math.max(0, range.from - len), range.from);
  const after = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + len));
  // Guard against stripping part of a LONGER marker made of the same char
  // (e.g. toggling `*` on a selection inside `**bold**` must not eat the bold)
  const markChar = mark[0];
  const beyondBefore = state.sliceDoc(Math.max(0, range.from - len - 1), Math.max(0, range.from - len));
  const beyondAfter = state.sliceDoc(range.to + len, Math.min(state.doc.length, range.to + len + 1));
  const partOfLongerMark = beyondBefore === markChar || beyondAfter === markChar;

  if (selected.startsWith(mark) && selected.endsWith(mark) && selected.length >= 2 * len) {
    // Marks inside the selection — strip them
    view.dispatch({
      userEvent: 'input.format',
      changes: { from: range.from, to: range.to, insert: selected.slice(len, selected.length - len) },
      selection: EditorSelection.range(range.from, range.to - 2 * len),
    });
  } else if (before === mark && after === mark && !partOfLongerMark) {
    // Marks just outside the selection — strip them
    view.dispatch({
      userEvent: 'input.format',
      changes: [
        { from: range.from - len, to: range.from },
        { from: range.to, to: range.to + len },
      ],
      selection: EditorSelection.range(range.from - len, range.to - len),
    });
  } else {
    view.dispatch({
      userEvent: 'input.format',
      changes: [
        { from: range.from, insert: mark },
        { from: range.to, insert: mark },
      ],
      selection: EditorSelection.range(range.from + len, range.to + len),
    });
  }
  return true;
}

const LINE_PREFIX_RE = {
  bullet: /^(\s*)([-*+] (?!\[))/,
  task: /^(\s*)([-*+] \[[ xX]\] )/,
  ordered: /^(\s*)(\d+[.)] )/,
  quote: /^(\s*)(> ?)/,
} as const;

export type LinePrefixKind = keyof typeof LINE_PREFIX_RE;

const LINE_PREFIX_INSERT: Record<LinePrefixKind, string> = {
  bullet: '- ',
  task: '- [ ] ',
  ordered: '1. ',
  quote: '> ',
};

/** Toggle a line prefix (bullet / task / ordered / quote) on all selected lines. */
export function toggleLinePrefix(view: EditorView, kind: LinePrefixKind): boolean {
  const { state } = view;
  const range = state.selection.main;
  const startLine = state.doc.lineAt(range.from).number;
  const endLine = state.doc.lineAt(range.to).number;
  const re = LINE_PREFIX_RE[kind];

  const lines = [];
  for (let n = startLine; n <= endLine; n++) lines.push(state.doc.line(n));

  const nonEmpty = lines.filter(l => l.text.trim().length > 0 || lines.length === 1);
  const allHave = nonEmpty.length > 0 && nonEmpty.every(l => re.test(l.text));

  const changes = [];
  for (const line of nonEmpty) {
    // Strip any existing list/task/quote prefix first so kinds convert cleanly
    const existing =
      LINE_PREFIX_RE.task.exec(line.text) ??
      LINE_PREFIX_RE.bullet.exec(line.text) ??
      LINE_PREFIX_RE.ordered.exec(line.text) ??
      LINE_PREFIX_RE.quote.exec(line.text);

    if (allHave) {
      const m = re.exec(line.text)!;
      changes.push({ from: line.from + m[1].length, to: line.from + m[0].length });
    } else if (existing && !re.test(line.text)) {
      changes.push({
        from: line.from + existing[1].length,
        to: line.from + existing[0].length,
        insert: LINE_PREFIX_INSERT[kind],
      });
    } else if (!re.test(line.text)) {
      const indent = /^\s*/.exec(line.text)![0];
      changes.push({ from: line.from + indent.length, insert: LINE_PREFIX_INSERT[kind] });
    }
  }

  if (changes.length === 0) return true;
  view.dispatch({ changes, userEvent: 'input.format' });
  return true;
}

/**
 * Cycle heading level on the current line: none → 1 → 2 → 3 → none.
 * Existing deeper headings keep cycling (4 → 5 → 6 → none) so a tap never
 * silently flattens an H4-H6 authored elsewhere.
 */
export function cycleHeading(view: EditorView): boolean {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.from);
  const m = /^(#{1,6}) /.exec(line.text);
  const current = m ? m[1].length : 0;
  const next = current === 3 || current >= 6 ? 0 : current + 1;

  const changes = m
    ? { from: line.from, to: line.from + m[0].length, insert: next === 0 ? '' : '#'.repeat(next) + ' ' }
    : { from: line.from, insert: '#'.repeat(next) + ' ' };
  view.dispatch({ changes, userEvent: 'input.format' });
  return true;
}

/** Insert a wikilink `[[]]` (or wrap the selection) and place the cursor inside. */
export function insertWikilink(view: EditorView): boolean {
  const range = view.state.selection.main;
  const selected = view.state.sliceDoc(range.from, range.to);
  view.dispatch({
    userEvent: 'input.format',
    changes: { from: range.from, to: range.to, insert: `[[${selected}]]` },
    selection: EditorSelection.cursor(range.from + 2 + selected.length),
  });
  return true;
}

function runYKeymap(view: EditorView, key: string): boolean {
  const binding = yUndoManagerKeymap.find(b => b.key === key);
  return binding?.run ? binding.run(view) : false;
}

/** Undo via the editor's Y.UndoManager (same as Mod-z). */
export function undoCommand(view: EditorView): boolean {
  return runYKeymap(view, 'Mod-z');
}

/** Redo via the editor's Y.UndoManager (same as Mod-y). */
export function redoCommand(view: EditorView): boolean {
  return runYKeymap(view, 'Mod-y') || runYKeymap(view, 'Mod-Shift-z');
}
