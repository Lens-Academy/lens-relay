import type { NormalizationChange } from "./normalize-article";
import { fencedLineMask } from "./footnote-typing";

/**
 * Markdown table repairs, so one miscounted row cannot discard a whole import.
 *
 * Lens Platform's validator (`scanTables` / `splitTableRow` in lens-platform
 * content_processor/src/validator/article-structure.ts) counts the cells of
 * every row after a delimiter row and fails the article on any row whose count
 * differs from the header. It scans with inline code and maths blanked out,
 * and a table only ends at a blank line or a line without a `|`.
 *
 * `normalizeTables` runs before validation with the other safe normalizations
 * and again on every reviewer pass's output. Its repairs never lose text:
 *
 *  1. a row with fewer cells than the header, e.g. a spanning section row
 *     (`| _Agentic coding tasks_ |`) from a colspan in the source table, gets
 *     empty cells. GFM pads it the same way, so the rendered table is the same,
 *     and the validator is satisfied (the arXiv 2607.18966 failure);
 *  2. a caption or paragraph straight after a table whose cell count does not
 *     fit the table (`Table 2: A | B | C`) is split off by a blank line, since
 *     both GFM and the validator would otherwise take it as one more row;
 *  3. a `|` inside `$…$` maths in a row becomes `\vert` (`\|` becomes `\Vert`).
 *     This one is for readers, not the validator, which masks maths: GFM splits
 *     cells before maths is found, so `$P(a|b)$` renders as two broken cells.
 *
 * A row with MORE cells than its header is not touched there: GFM drops the
 * extra cells, so which text belongs where is a judgement for the reviewer.
 * Only when the reviewer's rounds are spent and table rows are all that is
 * still wrong does `forceTableCellCounts` make the counts match, flag each row
 * it changed with a CriticMarkup comment, and let the article be written.
 */

const DELIMITER_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
// The validator strips CriticMarkup comments and %% comments before scanning
// (stripAuthoringMarkupForValidation), so cell counts must ignore them too.
// They are the forms an importer or reviewer might leave in a cell.
const COUNT_IGNORED_RE = /\{>>.*?<<\}|%%.*?%%/g;
// Inline maths as Lens finds it (the frontend's rule, mirrored in the
// validator's proseMask): never crosses a `$`, and keeps prices out.
const INLINE_MATH_RE = /(?<!\$)\$(?!\$)([^\s$](?:[^$\n]*?[^\s$])?)\$(?![\d$])/g;
const DISPLAY_MATH_RE = /\$\$([^$\n]+?)\$\$/g;

/** Cells of one table row, split exactly as Lens Platform's `splitTableRow`
 * does (backslash escapes and inline code protect a `|`, nothing else). */
export function splitTableRow(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  let codeTicks = 0;
  for (const char of line.trim().replace(/^\|/, "").replace(/\|$/, "")) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (char === "`") codeTicks ^= 1;
    if (char === "|" && !codeTicks) {
      cells.push(current.trim());
      current = "";
    } else current += char;
  }
  cells.push(current.trim());
  return cells;
}

function cellCount(line: string): number {
  return splitTableRow(line.replace(COUNT_IGNORED_RE, "")).length;
}

interface TableBlock {
  /** Line index of the header row. */
  header: number;
  /** Line indexes of the body rows, in order. */
  rows: number[];
  /** Header cell count. */
  expected: number;
}

/** Tables as the validator sees them: a header line, a delimiter line, then
 * every following non-blank line containing a `|`. Fenced code is skipped. */
function findTables(lines: string[]): TableBlock[] {
  const fenced = fencedLineMask(lines);
  const tables: TableBlock[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    if (fenced[i] || fenced[i - 1] || !DELIMITER_RE.test(lines[i])) continue;
    const rows: number[] = [];
    for (
      let row = i + 1;
      row < lines.length && !fenced[row] && lines[row].includes("|") && lines[row].trim();
      row += 1
    ) {
      rows.push(row);
    }
    tables.push({ header: i - 1, rows, expected: cellCount(lines[i - 1]) });
    i += rows.length;
  }
  return tables;
}

/** Replace `|` (and TeX's `\|`) inside `$…$` / `$$…$$` spans of one table row
 * with `\vert` / `\Vert`, which render identically and do not split cells.
 * Inline code is left alone. */
function escapeMathPipes(line: string): string {
  const fix = (inner: string) =>
    inner
      .replace(/\\\|/g, "\\Vert ")
      .replace(/(^|[^\\])\|/g, (_, before: string) => `${before}\\vert `)
      // A second pass catches `||`, whose second bar the lookbehind skipped.
      .replace(/(^|[^\\])\|/g, (_, before: string) => `${before}\\vert `);
  return line
    .split(/(`+[^`]*`+)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(DISPLAY_MATH_RE, (_, inner: string) => `$$${fix(inner)}$$`)
            .replace(INLINE_MATH_RE, (_, inner: string) => `$${fix(inner)}$`),
    )
    .join("");
}

function isTableLine(line: string): boolean {
  return line.trim().startsWith("|");
}

/** Idempotent table repairs that never change the rendered table. */
export function normalizeTables(body: string): { body: string; changes: NormalizationChange[] } {
  const changes = new Map<string, NormalizationChange>();
  const record = (code: string, before: string, after: string) => {
    const change = changes.get(code) ?? { code, count: 0, samples: [] };
    change.count += 1;
    if (change.samples.length < 5) change.samples.push({ before: before.slice(0, 512), after: after.slice(0, 512) });
    changes.set(code, change);
  };

  let lines = body.split("\n");

  // 1. A line without a leading `|` whose cell count does not fit the table
  //    is a caption or paragraph that GFM and the validator would both take
  //    as one more row: put a blank line before it. A row that fits stays,
  //    since GFM rows need no leading pipe.
  const insertBefore = new Set<number>();
  for (const table of findTables(lines)) {
    if (!isTableLine(lines[table.header])) continue;
    const end = table.rows.find(
      (row) => !isTableLine(lines[row]) && cellCount(lines[row]) !== table.expected,
    );
    if (end !== undefined) insertBefore.add(end);
  }
  if (insertBefore.size > 0) {
    const next: string[] = [];
    lines.forEach((line, index) => {
      if (insertBefore.has(index)) {
        record("normalize.table-blank-line-after", line, `\n${line}`);
        next.push("");
      }
      next.push(line);
    });
    lines = next;
  }

  // 2. Maths pipes, on the header and every row.
  for (const table of findTables(lines)) {
    for (const index of [table.header, ...table.rows]) {
      const fixed = escapeMathPipes(lines[index]);
      if (fixed !== lines[index]) {
        record("normalize.table-math-pipe", lines[index], fixed);
        lines[index] = fixed;
      }
    }
  }

  // 3. Rows short of the header get empty cells: GFM pads them the same way,
  //    so the rendered table is unchanged and the validator is satisfied.
  for (const table of findTables(lines)) {
    for (const index of table.rows) {
      const count = cellCount(lines[index]);
      if (count >= table.expected || !isTableLine(lines[index])) continue;
      const padded = padRow(lines[index], table.expected - count);
      record("normalize.table-short-row-padded", lines[index], padded);
      lines[index] = padded;
    }
  }

  return { body: lines.join("\n"), changes: [...changes.values()] };
}

function padRow(line: string, missing: number): string {
  const trimmed = line.trimEnd();
  const base = trimmed.endsWith("|") && !trimmed.endsWith("\\|") ? trimmed : `${trimmed} |`;
  return base + "  |".repeat(missing);
}

function rowFromCells(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

export interface ForcedTableRow {
  /** 1-based line within the body. */
  line: number;
  had: number;
  expected: number;
  before: string;
  after: string;
}

/**
 * Last resort after the reviewer's rounds: make every table row's cell count
 * match its header, flagging each changed row with a CriticMarkup comment so a
 * human checks it against the source. Short rows are padded; the extra cells
 * of a long row are kept, joined into the last cell with an escaped `\|`, so no
 * text is lost. A delimiter row that disagrees with its header is rebuilt.
 */
export function forceTableCellCounts(body: string): { body: string; rows: ForcedTableRow[] } {
  const lines = body.split("\n");
  const rows: ForcedTableRow[] = [];
  for (const table of findTables(lines)) {
    const delimiterIndex = table.header + 1;
    if (cellCount(lines[delimiterIndex]) !== table.expected) {
      const before = lines[delimiterIndex];
      lines[delimiterIndex] = rowFromCells(new Array(table.expected).fill("---"));
      rows.push({
        line: delimiterIndex + 1,
        had: cellCount(before),
        expected: table.expected,
        before,
        after: lines[delimiterIndex],
      });
    }
    for (const index of table.rows) {
      const before = lines[index];
      const had = cellCount(before);
      if (had === table.expected) continue;
      // Split without the comments the count ignores (their own pipes would
      // otherwise shift cells), and carry them over to the last cell.
      const comments = before.match(COUNT_IGNORED_RE) ?? [];
      const cells = splitTableRow(before.replace(COUNT_IGNORED_RE, ""));
      const fixed =
        had < table.expected
          ? [...cells, ...new Array(table.expected - cells.length).fill("")]
          : [...cells.slice(0, table.expected - 1), cells.slice(table.expected - 1).join(" \\| ")];
      const note =
        had < table.expected
          ? `{>>Importer: this row had ${had} of the table's ${table.expected} cells, so empty cells were added. Check it against the source.<<}`
          : `{>>Importer: this row had ${had} cells but the table has ${table.expected}, so the last ${had - table.expected + 1} were joined into this cell. Check it against the source.<<}`;
      fixed[table.expected - 1] = [fixed[table.expected - 1], ...comments, note].filter(Boolean).join(" ");
      lines[index] = rowFromCells(fixed);
      rows.push({ line: index + 1, had, expected: table.expected, before, after: lines[index] });
    }
  }
  return { body: lines.join("\n"), rows };
}
