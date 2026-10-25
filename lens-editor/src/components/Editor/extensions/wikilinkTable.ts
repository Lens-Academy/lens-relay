/**
 * GFM tables whose cells may hold aliased wikilinks.
 *
 * Lezer's Table extension splits a row at every unescaped `|`, so the alias pipe
 * in `| [[Some note|alias]] | 7/10 |` became a column separator. Obsidian keeps a
 * `|` inside `[[...]]` part of the link; this is Lezer's table parser with that
 * one change. It defines the same nodes (Table, TableHeader, TableRow, TableCell,
 * TableDelimiter) and replaces Lezer's "Table" block parser, so add it after
 * `markdownLanguage` / GFM and in place of `Table`.
 */

import type { BlockContext, Element, LeafBlock, LeafBlockParser, Line, MarkdownConfig } from '@lezer/markdown';
import { tags as t } from '@lezer/highlight';

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
