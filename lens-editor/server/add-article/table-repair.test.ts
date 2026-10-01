import { describe, expect, it } from "vitest";
import { forceTableCellCounts, normalizeTables, splitTableRow } from "./table-repair";
import { normalizeArticleBody } from "./normalize-article";

/** Cell counts the way Lens Platform's validator counts them (comments stripped). */
function counts(body: string): number[] {
  return body
    .split("\n")
    .filter((line) => line.trim().startsWith("|"))
    .map((line) => splitTableRow(line.replace(/\{>>.*?<<\}/g, "")).length);
}

describe("normalizeTables", () => {
  it("turns pipes inside maths into \\vert and \\Vert so they no longer split cells", () => {
    const input = [
      "| Quantity | Formula |",
      "| --- | --- |",
      "| Norm | $\\|x\\|_2$ |",
      "| Conditional | $P(a|b)$ and $|x|$ |",
    ].join("\n");
    const out = normalizeTables(input);
    expect(out.body).toContain("| Norm | $\\Vert x\\Vert _2$ |");
    expect(out.body).toContain("| Conditional | $P(a\\vert b)$ and $\\vert x\\vert $ |");
    expect(counts(out.body)).toEqual([2, 2, 2, 2]);
    expect(out.changes.map((c) => c.code)).toEqual(["normalize.table-math-pipe"]);
  });

  it("leaves prices, code and escaped pipes alone", () => {
    const input = [
      "| Plan | Price | Note |",
      "| --- | --- | --- |",
      "| Basic | $5 | $10 a year |",
      "| Code | `a|b` | x \\| y |",
    ].join("\n");
    const out = normalizeTables(input);
    expect(out.body).toBe(input);
    expect(out.changes).toEqual([]);
  });

  it("separates a caption with a pipe from the table above it", () => {
    const input = [
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "Table 2: results for $|S|$ seeds",
      "",
      "After.",
    ].join("\n");
    const out = normalizeTables(input);
    expect(out.body).toBe(
      ["| A | B |", "| --- | --- |", "| 1 | 2 |", "", "Table 2: results for $|S|$ seeds", "", "After."].join("\n"),
    );
    expect(out.changes.map((c) => c.code)).toEqual(["normalize.table-blank-line-after"]);
  });

  it("pads a spanning section row (the arXiv 2607.18966 case) to the header width", () => {
    const input = [
      "| Evaluation | Description |",
      "| --- | --- |",
      "| _Alignment-flavored agentic coding tasks (Appendix [N](#appendix-n \"Appendix N ‣ Paper\"))_ |",
      "| 9\\. Authority Conflict | The agentic workspace eval. |",
    ].join("\n");
    const out = normalizeTables(input);
    expect(out.body.split("\n")[2]).toBe(
      "| _Alignment-flavored agentic coding tasks (Appendix [N](#appendix-n \"Appendix N ‣ Paper\"))_ |  |",
    );
    expect(counts(out.body)).toEqual([2, 2, 2, 2]);
    expect(out.changes.map((c) => c.code)).toEqual(["normalize.table-short-row-padded"]);
  });

  it("does not touch rows with too many cells, or tables inside code fences", () => {
    const input = [
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 | 3 |",
      "",
      "```md",
      "| A | B |",
      "| --- | --- |",
      "| $a|b$ |",
      "```",
    ].join("\n");
    expect(normalizeTables(input).body).toBe(input);
  });

  it("is idempotent and runs as part of normalizeArticleBody", () => {
    const input = [
      "| A | B |",
      "| --- | --- |",
      "| _Section_ |",
      "| $a|b$ | 2 |",
      "Caption | here",
    ].join("\n");
    const once = normalizeArticleBody(input, "https://example.com/");
    expect(counts(once.body)).toEqual([2, 2, 2, 2]);
    expect(once.body).toContain("\n\nCaption | here");
    expect(normalizeArticleBody(once.body, "https://example.com/").body).toBe(once.body);
  });
});

describe("forceTableCellCounts", () => {
  it("joins the extra cells of a long row into its last cell and flags the row", () => {
    const input = ["| A | B |", "| --- | --- |", "| 1 | 2 | 3 |", "| 4 | 5 |"].join("\n");
    const out = forceTableCellCounts(input);
    expect(out.body.split("\n")[2]).toBe(
      "| 1 | 2 \\| 3 {>>Importer: this row had 3 cells but the table has 2, so the last 2 were joined into this cell. Check it against the source.<<} |",
    );
    expect(out.body.split("\n")[3]).toBe("| 4 | 5 |");
    expect(counts(out.body)).toEqual([2, 2, 2, 2]);
    expect(out.rows).toEqual([
      expect.objectContaining({ line: 3, had: 3, expected: 2 }),
    ]);
  });

  it("pads a short row and rebuilds a delimiter row that disagrees with its header", () => {
    const input = ["| A | B | C |", "| --- | --- |", "| 1 |"].join("\n");
    const out = forceTableCellCounts(input);
    const lines = out.body.split("\n");
    expect(lines[1]).toBe("| --- | --- | --- |");
    expect(lines[2]).toBe(
      "| 1 |  | {>>Importer: this row had 1 of the table's 3 cells, so empty cells were added. Check it against the source.<<} |",
    );
    expect(counts(out.body)).toEqual([3, 3, 3]);
    expect(out.rows.map((row) => row.line)).toEqual([2, 3]);
  });

  it("changes nothing when every row already matches", () => {
    const input = ["| A | B |", "| --- | --- |", "| 1 | 2 |"].join("\n");
    expect(forceTableCellCounts(input)).toEqual({ body: input, rows: [] });
  });
});
