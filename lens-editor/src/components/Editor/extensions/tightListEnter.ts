/**
 * Tight List Enter Handler
 *
 * Wraps @codemirror/lang-markdown's insertNewlineContinueMarkup to always
 * produce tight list continuations (single \n between items), matching
 * Obsidian's behavior. The upstream command preserves non-tight (loose)
 * list formatting by inserting blank lines; this wrapper collapses them.
 */
import type { StateCommand, Transaction } from '@codemirror/state';
import { EditorSelection } from '@codemirror/state';
import {
  insertNewlineContinueMarkupCommand,
  deleteMarkupBackward,
} from '@codemirror/lang-markdown';

/**
 * Upstream command configured with nonTightLists: false.
 * This prevents the secondary trigger: pressing Enter on an empty 2nd
 * item in a tight list converting it to non-tight. Instead, it exits
 * the list (removes the marker), matching Obsidian behavior.
 */
const upstreamEnter = insertNewlineContinueMarkupCommand({
  nonTightLists: false,
});

/**
 * Matches the blank line inserted by nonTightList detection.
 * Pattern: \n followed by optional blockquote/indent chars (> space tab),
 * then another \n.
 *
 * Examples matched:
 *   "\n\n"       — simple list
 *   "\n  \n"     — nested list (indentation)
 *   "\n> \n"     — list inside blockquote
 */
const NON_TIGHT_BLANK = /\n[> \t]*\n/g;

/**
 * Enter handler that always produces tight list continuations.
 *
 * Delegates to the upstream markdown Enter command, then collapses any
 * blank-line insertion (from non-tight list detection) into a single
 * newline before dispatching.
 */
export const tightListContinueMarkup: StateCommand = ({ state, dispatch }) => {
  let captured: Transaction | null = null;
  const handled = upstreamEnter({
    state,
    dispatch: (tr: Transaction) => {
      captured = tr;
    },
  });

  if (!handled || !captured) return false;

  const tr = captured as Transaction;

  // Extract changes, collapsing non-tight blank lines
  const newChanges: { from: number; to: number; insert: string }[] = [];
  let totalRemoved = 0;

  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    let text = inserted.toString();
    let removedInThisChange = 0;
    text = text.replace(NON_TIGHT_BLANK, (match) => {
      removedInThisChange += match.length - 1;
      return '\n';
    });
    totalRemoved += removedInThisChange;
    newChanges.push({ from: fromA, to: toA, insert: text });
  });

  if (totalRemoved === 0) {
    // No non-tight pattern — dispatch original transaction unchanged
    dispatch(tr);
    return true;
  }

  // Rebuild transaction with collapsed newlines and adjusted cursor
  const newSelection = EditorSelection.create(
    tr.newSelection.ranges.map((r) =>
      EditorSelection.cursor(r.head - totalRemoved)
    )
  );

  dispatch(
    state.update({
      changes: newChanges,
      selection: newSelection,
      scrollIntoView: true,
      userEvent: 'input',
    })
  );

  return true;
};

/**
 * Markdown keymap with tight list Enter behavior.
 * Replaces the built-in markdownKeymap from @codemirror/lang-markdown.
 * Install at Prec.high to match the precedence of the original.
 */
export const tightMarkdownKeymap = [
  { key: 'Enter' as const, run: tightListContinueMarkup },
  { key: 'Backspace' as const, run: deleteMarkupBackward },
];
