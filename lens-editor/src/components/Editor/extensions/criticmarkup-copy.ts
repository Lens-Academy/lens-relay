/**
 * Keeps copying from taking part of the CriticMarkup syntax that live preview hides.
 *
 * A selection that runs into a suggestion from the text before it, or out of
 * one, covers part of its hidden delimiters and metadata. Copying, cutting or
 * dragging it took them along (`ain {++{"author":…}@@ins`), and pasting or
 * dropping that opened a suggestion that never closed: it ran on to the next
 * `++}` in the document, turning the lines in between into one broken
 * suggestion.
 *
 * Now the clipboard gets only the text shown of a suggestion or comment that
 * the selection covers part of (of a comment, which shows as a badge, nothing),
 * as deleting the selection deletes only that (criticmarkup-delete.ts). Ones
 * it covers whole go as they are, markup and all.
 *
 * Live preview only: source mode shows the syntax, so copies take it as it is.
 */

import type { Extension } from '@codemirror/state';
import { piecesToCopy } from './copiedText';
import type { RangesOf } from './criticmarkup-cursor';
import { keepHiddenSyntax } from './criticmarkup-delete';

/** The copying above, for the CriticMarkup ranges `rangesOf` reads */
export function hiddenSyntaxCopy(rangesOf: RangesOf): Extension {
  return piecesToCopy.of((state, ranges) => keepHiddenSyntax(ranges, rangesOf(state), false));
}
