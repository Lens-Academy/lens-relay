/**
 * ArrowUp and ArrowDown (with or without Shift) stop on every line of text.
 *
 * Moving the cursor up, CodeMirror probes a point in the line above. To step
 * over a line's top padding, it skips the line when that point is above the
 * top of the line's first character. Live preview and CriticMarkup hide syntax
 * (`## `, `---`, `**`, `{++`) in font-size: 0 spans, and a hidden character's
 * box has no height and sits on the baseline, below the point. So the cursor
 * jumped over every line that starts with hidden syntax: # headings, rules,
 * setext underlines, a code block's closing fence, lines opening with bold,
 * italic or code, suggestions. These commands check where CodeMirror's move
 * landed, and when it went past the next line of text they put the cursor on
 * that line, under the same column. Other moves are left to CodeMirror.
 */

import { EditorSelection, Prec, type SelectionRange } from '@codemirror/state';
import { BlockType, keymap, type BlockInfo, type EditorView } from '@codemirror/view';

/**
 * The next line of text above or below `block`. Block widgets in between (the
 * frontmatter bar, a table) and lines collapsed to nothing are passed over, as
 * CodeMirror does. Null at the end of the document, or at a line that holds a
 * block widget, which this leaves to CodeMirror.
 */
function nextTextLine(view: EditorView, block: BlockInfo, forward: boolean): BlockInfo | null {
  const { length } = view.state.doc;
  for (let pos = forward ? block.to + 1 : block.from - 1; pos >= 0 && pos <= length; ) {
    const next = view.lineBlockAt(pos);
    if (Array.isArray(next.type)) return null;
    if (next.type === BlockType.Text && next.height >= 1) return next;
    pos = forward ? next.to + 1 : next.from - 1;
  }
  return null;
}

/**
 * Where moving from `range` should land when CodeMirror's vertical move went
 * past the next line of text, or null when it didn't.
 */
export function skippedLineTarget(view: EditorView, range: SelectionRange, forward: boolean): SelectionRange | null {
  try {
    const next = nextTextLine(view, view.lineBlockAt(range.head), forward);
    if (!next) return null;
    const moved = view.moveVertically(range, forward);
    // Landing at the very start (or end) of the document also counts: that is
    // where CodeMirror ends up when the line it skipped was the first (or last)
    const atEdge = moved.head === (forward ? view.state.doc.length : 0);
    if (!atEdge && (forward ? moved.head <= next.to : moved.head >= next.from)) return null;
    const goal = moved.goalColumn;
    if (goal == null) return null;
    // The line's row nearest to where the cursor came from: its last going up,
    // its first going down
    const x = view.contentDOM.getBoundingClientRect().left + goal;
    const y = view.documentTop + (forward ? next.top + 1 : next.bottom - 1);
    const target = view.posAndSideAtCoords({ x, y }, false);
    if (target.pos < next.from || target.pos > next.to) return null;
    return EditorSelection.cursor(target.pos, target.assoc, undefined, goal);
  } catch {
    // CodeMirror's measuring throws on some lines of nothing but hidden syntax
    // (a ```js line beside the code block's copy button). Leave those to its
    // own command.
    return null;
  }
}

/**
 * ArrowUp/ArrowDown (`extend`: with Shift). Handles a move that would jump
 * over a line, and returns false otherwise, so CodeMirror's command runs.
 */
export function stepLine(view: EditorView, forward: boolean, extend: boolean): boolean {
  const { selection } = view.state;
  const range = selection.main;
  // Several cursors, and a selection that ArrowUp collapses, are left to CodeMirror
  if (selection.ranges.length > 1 || (!extend && !range.empty)) return false;
  const target = skippedLineTarget(view, range, forward);
  if (!target) return false;
  view.dispatch({
    // A whole EditorSelection: a bare range would be read as { anchor, head }
    // and lose its goal column, so the next press would drift sideways
    selection: EditorSelection.create([
      extend ? EditorSelection.range(range.anchor, target.head, target.goalColumn) : target,
    ]),
    scrollIntoView: true,
    userEvent: 'select',
  });
  return true;
}

export const verticalMotionKeymap = Prec.high(keymap.of([
  { key: 'ArrowUp', run: (view) => stepLine(view, false, false), shift: (view) => stepLine(view, false, true) },
  { key: 'ArrowDown', run: (view) => stepLine(view, true, false), shift: (view) => stepLine(view, true, true) },
]));
