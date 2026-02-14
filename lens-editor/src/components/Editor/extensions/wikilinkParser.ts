/**
 * Wikilink Parser Extension for Lezer Markdown
 *
 * Implements parsing for [[Page Name]] wikilink syntax commonly used in
 * Obsidian and other knowledge management tools.
 *
 * Creates a Wikilink node in the syntax tree with children:
 * - WikilinkMark: The [[ and ]] delimiters
 * - WikilinkContent: The page name text
 */

import type { MarkdownConfig, InlineParser, InlineContext } from '@lezer/markdown';
import { tags as t } from '@lezer/highlight';

// Character codes
const OPEN_BRACKET = 91; // [
const CLOSE_BRACKET = 93; // ]
const EXCLAMATION = 33; // !

/**
 * Wikilink inline parser for [[Page Name]] and ![[Page Name]] syntax
 *
 * Must run before the standard Link parser to avoid conflicts
 * since both use [ as the opening character. Also handles ![[
 * to prevent Lezer's Image parser from intercepting the ![ sequence.
 */
const WikilinkParser: InlineParser = {
  name: 'Wikilink',
  // Run before standard Link and Image parsers
  before: 'Link',
  parse(cx: InlineContext, next: number, pos: number): number {
    // Determine if this is ![[...]] or [[...]]
    let bracketStart: number;
    if (next === EXCLAMATION && cx.char(pos + 1) === OPEN_BRACKET && cx.char(pos + 2) === OPEN_BRACKET) {
      bracketStart = pos + 1;
    } else if (next === OPEN_BRACKET && cx.char(pos + 1) === OPEN_BRACKET) {
      bracketStart = pos;
    } else {
      return -1;
    }

    const contentStart = bracketStart + 2;

    // Find closing ]]
    let end = contentStart;
    while (end < cx.end) {
      const ch = cx.char(end);
      if (ch === CLOSE_BRACKET && cx.char(end + 1) === CLOSE_BRACKET) {
        // Found closing ]]
        // Don't match empty wikilinks [[]] or ![[]]
        if (end === contentStart) return -1;

        // Add wikilink element with children
        // Node spans from pos (including ! if present) through ]]
        return cx.addElement(
          cx.elt('Wikilink', pos, end + 2, [
            cx.elt('WikilinkMark', pos, contentStart),
            cx.elt('WikilinkContent', contentStart, end),
            cx.elt('WikilinkMark', end, end + 2),
          ])
        );
      }
      end++;
    }

    // No closing found
    return -1;
  },
};

/**
 * Wikilink extension for @lezer/markdown
 *
 * Defines the Wikilink node types and registers the inline parser.
 * Use with markdown({ extensions: [WikilinkExtension] })
 */
export const WikilinkExtension: MarkdownConfig = {
  defineNodes: [
    { name: 'Wikilink', style: t.link },
    { name: 'WikilinkMark', style: t.processingInstruction },
    { name: 'WikilinkContent', style: t.link },
  ],
  parseInline: [WikilinkParser],
};
