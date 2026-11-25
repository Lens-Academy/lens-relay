/**
 * GFM tables whose cells may hold aliased wikilinks.
 *
 * Lezer's Table extension splits a row at every unescaped `|`, so the alias pipe
 * in `| [[Some note|alias]] | 7/10 |` became a column separator. This is Lezer's
 * table parser with one change: a `|` inside `[[...]]` stays in the cell. The
 * escaped form Obsidian writes in tables, `[[note\|alias]]`, still works (the
 * `\|` never split a cell). It defines the same nodes (Table, TableHeader,
 * TableRow, TableCell, TableDelimiter) as Lezer's Table.
 *
 * Use it through `lensMarkdownExtensions` on `commonmarkLanguage`, not next to
 * GFM: Lezer keeps a replaced parser's `endLeaf`, and GFM's would still split a
 * table at a body row that looks like a delimiter row.
 */

import { foldNodeProp } from '@codemirror/language';
import { Autolink, Emoji, Strikethrough, Subscript, Superscript, TaskList } from '@lezer/markdown';
import type { BlockContext, Element, LeafBlock, LeafBlockParser, Line, MarkdownConfig } from '@lezer/markdown';
import { tags as t } from '@lezer/highlight';
import { WikilinkExtension } from './wikilinkParser';

const PIPE = 124;
const BACKSLASH = 92;
const OPEN_BRACKET = 91;

/**
 * If a wikilink opens at `i` (`[[`), the index just past its closing `]]`, else -1.
 * Like the inline wikilink parser: the first `]]` closes it, and `[[]]` is no link.
 */
export function wikilinkEnd(text: string, i: number): number {
  if (text.charCodeAt(i) !== OPEN_BRACKET || text.charCodeAt(i + 1) !== OPEN_BRACKET) return -1;
  const close = text.indexOf(']]', i + 2);
  return close > i + 2 ? close + 2 : -1;
}

/** Lezer's parseRow, except that a `|` inside `[[...]]` does not end the cell. */
function parseRow(cx: BlockContext, line: string, startI = 0, elts?: Element[], offset = 0): number {
  let count = 0, first = true, cellStart = -1, cellEnd = -1, esc = false;
  const parseCell = () => {
    elts!.push(cx.elt('TableCell', offset + cellStart, offset + cellEnd,
      cx.parser.parseInline(line.slice(cellStart, cellEnd), offset + cellStart)));
  };
  for (let i = startI; i < line.length; i++) {
    const next = line.charCodeAt(i);
    const linkEnd = esc ? -1 : wikilinkEnd(line, i);
    if (linkEnd > -1) {
      if (cellStart < 0) cellStart = i;
      cellEnd = linkEnd;
      i = linkEnd - 1;
      // The link ends in `]`, so the next character is not escaped
      esc = false;
      continue;
    }
    if (next === PIPE && !esc) {
      if (!first || cellStart > -1) count++;
      first = false;
      if (elts) {
        if (cellStart > -1) parseCell();
        elts.push(cx.elt('TableDelimiter', i + offset, i + offset + 1));
      }
      cellStart = cellEnd = -1;
    } else if (esc || (next !== 32 && next !== 9)) {
      if (cellStart < 0) cellStart = i;
      cellEnd = i + 1;
    }
    esc = !esc && next === BACKSLASH;
  }
  if (cellStart > -1) {
    count++;
    if (elts) parseCell();
  }
  return count;
}

function hasPipe(str: string, start: number): boolean {
  for (let i = start; i < str.length; i++) {
    const next = str.charCodeAt(i);
    if (next === PIPE) return true;
    if (next === BACKSLASH) i++;
  }
  return false;
}

const delimiterLine = /^\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)?$/;

class TableParser implements LeafBlockParser {
  // Null: the second line has not been seen yet. False: not a table.
  // An array: a table, with the rows parsed so far.
  rows: Element[] | false | null = null;

  nextLine(cx: BlockContext, line: Line, leaf: LeafBlock): boolean {
    if (this.rows == null) { // Second line
      this.rows = false;
      let lineText;
      if ((line.next === 45 || line.next === 58 || line.next === PIPE) && // '-', ':', '|'
          delimiterLine.test(lineText = line.text.slice(line.pos))) {
        const firstRow: Element[] = [];
        const firstCount = parseRow(cx, leaf.content, 0, firstRow, leaf.start);
        if (firstCount === parseRow(cx, lineText, line.pos)) {
          this.rows = [
            cx.elt('TableHeader', leaf.start, leaf.start + leaf.content.length, firstRow),
            cx.elt('TableDelimiter', cx.lineStart + line.pos, cx.lineStart + line.text.length),
          ];
        }
      }
    } else if (this.rows) { // Line after the second
      const content: Element[] = [];
      parseRow(cx, line.text, line.pos, content, cx.lineStart);
      this.rows.push(cx.elt('TableRow', cx.lineStart + line.pos, cx.lineStart + line.text.length, content));
    }
    return false;
  }

  finish(cx: BlockContext, leaf: LeafBlock): boolean {
    if (!this.rows) return false;
    cx.addLeafElement(leaf, cx.elt('Table', leaf.start, leaf.start + leaf.content.length, this.rows));
    return true;
  }
}

export const WikilinkTable: MarkdownConfig = {
  defineNodes: [
    { name: 'Table', block: true },
    { name: 'TableHeader', style: { 'TableHeader/...': t.heading } },
    'TableRow',
    { name: 'TableCell', style: t.content },
    { name: 'TableDelimiter', style: t.processingInstruction },
  ],
  parseBlock: [{
    name: 'Table',
    leaf(_, leaf) { return hasPipe(leaf.content, 0) ? new TableParser() : null; },
    endLeaf(cx, line, leaf) {
      if (leaf.parsers.some(p => p instanceof TableParser) || !hasPipe(line.text, line.basePos)) return false;
      const next = cx.peekLine();
      return delimiterLine.test(next) && parseRow(cx, line.text, line.basePos) === parseRow(cx, next, line.basePos);
    },
    before: 'SetextHeading',
  }],
};

/**
 * The editor's Markdown: `markdownLanguage`'s extensions (GFM, sub/superscript,
 * emoji, table folding) with WikilinkTable in place of GFM's Table, plus
 * wikilinks. Pass with `base: commonmarkLanguage`.
 */
export const lensMarkdownExtensions: MarkdownConfig[] = [
  WikilinkExtension,
  WikilinkTable,
  TaskList,
  Strikethrough,
  Autolink,
  Subscript,
  Superscript,
  Emoji,
  {
    props: [
      foldNodeProp.add({
        Table: (tree, state) => ({ from: state.doc.lineAt(tree.from).to, to: tree.to }),
      }),
    ],
  },
];
