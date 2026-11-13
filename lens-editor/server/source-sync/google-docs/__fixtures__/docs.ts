/**
 * For the tests: small Google Docs JSON built by hand, shaped as the Docs
 * API returns it (each paragraph's text ends in "\n").
 */

import type { ParagraphElement, StructuralElement, TextStyle } from "../docs-types";

export const run = (content: string, textStyle: TextStyle = {}): ParagraphElement => ({ textRun: { content, textStyle } });

export const para = (
  elements: ParagraphElement[],
  namedStyleType = "NORMAL_TEXT",
  bullet?: { listId: string; nestingLevel?: number },
): StructuralElement => ({ paragraph: { elements, paragraphStyle: { namedStyleType }, bullet } });

export const text = (s: string, style?: TextStyle) => para([run(`${s}\n`, style)]);

export const heading = (level: number | "TITLE" | "SUBTITLE", s: string) =>
  para([run(`${s}\n`)], typeof level === "number" ? `HEADING_${level}` : level);

export const image = (id: string) => para([{ inlineObjectElement: { inlineObjectId: id } }, run("\n")]);

/** A two-column table, one row per [key, value cell]: an Atlas component when a row is "type". */
export const table = (rows: [string, StructuralElement[]][]): StructuralElement => ({
  table: {
    columns: 2,
    tableRows: rows.map(([key, value]) => ({ tableCells: [{ content: [text(key)] }, { content: value }] })),
  },
});
