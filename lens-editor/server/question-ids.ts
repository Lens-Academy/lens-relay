/**
 * Pure text transform behind `scripts/add-question-ids.ts`.
 *
 * Finds bare `#### Question` segment headers (any `##`..`######` level, no
 * title after the word) whose field block has no `id::` line and reports the
 * `id:: <uuid>` line to insert directly after the header. The transform is
 * insert-only, so the caller can apply it either to a string (`text`) or as
 * minimal Y.Text inserts (`inserts`, offsets relative to the ORIGINAL text).
 */

/** Bare header: `#### Question` with optional trailing whitespace, no title. */
export const BARE_QUESTION_HEADER = /^#{2,6} Question\s*$/;
/** A field line assigning the question id. */
const ID_LINE = /^\s*id::/;
/** Any heading line ends the field block. */
const HEADING_LINE = /^#/;

export interface QuestionIdInsert {
  /** Offset into the original text (UTF-16 code units) where `text` goes. */
  offset: number;
  /** 1-based line number of the header (in the original text). */
  headerLine: number;
  /** Exact string to insert, including its line terminator. */
  text: string;
}

export interface AddQuestionIdsResult {
  /** The transformed markdown (unchanged when `inserts` is empty). */
  text: string;
  /** Inserts in ascending offset order, relative to the original text. */
  inserts: QuestionIdInsert[];
}

interface Line {
  /** Line content without its terminator (and without a trailing `\r`). */
  content: string;
  /** Offset of the first character of the line. */
  start: number;
  /** Offset just past the terminator (or end of text for the last line). */
  end: number;
  /** The exact terminator: "\r\n", "\n" or "" for an unterminated last line. */
  eol: string;
}

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start <= text.length) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) {
      if (start < text.length) {
        lines.push({
          content: text.slice(start),
          start,
          end: text.length,
          eol: "",
        });
      }
      break;
    }
    const crlf = nl > start && text[nl - 1] === "\r";
    lines.push({
      content: text.slice(start, crlf ? nl - 1 : nl),
      start,
      end: nl + 1,
      eol: crlf ? "\r\n" : "\n",
    });
    start = nl + 1;
  }
  return lines;
}

/** Dominant line terminator of the text: CRLF if any CRLF is present. */
function dominantEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Compute the `id::` lines to add. Idempotent: a header whose field block
 * already carries an `id::` line is left alone, so running the result through
 * again yields no inserts. Line endings are preserved exactly: the inserted
 * line reuses the header line's own terminator (falling back to the
 * document's dominant one for an unterminated header at end of file).
 */
export function addQuestionIds(
  markdown: string,
  uuidFn: () => string,
): AddQuestionIdsResult {
  const lines = splitLines(markdown);
  const inserts: QuestionIdInsert[] = [];
  const docEol = dominantEol(markdown);

  for (let i = 0; i < lines.length; i++) {
    const header = lines[i];
    if (!BARE_QUESTION_HEADER.test(header.content)) continue;

    let hasId = false;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j].content;
      if (HEADING_LINE.test(l)) break;
      if (ID_LINE.test(l)) {
        hasId = true;
        break;
      }
    }
    if (hasId) continue;

    const idLine = `id:: ${uuidFn()}`;
    if (header.eol === "") {
      // Header is the unterminated last line: terminate it, then add the id.
      inserts.push({
        offset: header.end,
        headerLine: i + 1,
        text: `${docEol}${idLine}`,
      });
    } else {
      inserts.push({
        offset: header.end,
        headerLine: i + 1,
        text: `${idLine}${header.eol}`,
      });
    }
  }

  if (inserts.length === 0) return { text: markdown, inserts };

  let out = "";
  let cursor = 0;
  for (const ins of inserts) {
    out += markdown.slice(cursor, ins.offset) + ins.text;
    cursor = ins.offset;
  }
  out += markdown.slice(cursor);
  return { text: out, inserts };
}

/**
 * Should this relay path be processed? Markdown only, and nothing under a
 * `surveys/` directory (at the folder root or nested). Accepts paths with or
 * without a leading slash, e.g. "/course/x.md" as stored in `filemeta_v0`.
 */
export function shouldProcessPath(path: string): boolean {
  const p = path.replace(/^\/+/, "");
  if (!p.toLowerCase().endsWith(".md")) return false;
  const segments = p.split("/").slice(0, -1);
  return !segments.includes("surveys");
}

/**
 * Unified diff for an insert-only change, for the dry-run report. Each insert
 * becomes a hunk with `context` lines around it; adjacent hunks are merged.
 */
export function insertOnlyUnifiedDiff(
  path: string,
  original: string,
  inserts: QuestionIdInsert[],
  context = 3,
): string {
  if (inserts.length === 0) return "";
  const oldLines = splitLines(original);
  const oldContent = oldLines.map((l) => l.content);

  // Each insert adds the lines of `text` (minus terminators) after headerLine.
  // For the unterminated-EOF case the text starts with an EOL, which still
  // yields one added line after the header.
  type Hunk = {
    firstOld: number;
    lastOld: number;
    adds: Map<number, string[]>;
  };
  const hunks: Hunk[] = [];
  for (const ins of inserts) {
    const added = ins.text.split(/\r?\n/).filter((s) => s.length > 0);
    const after = ins.headerLine; // 1-based line the additions follow
    const firstOld = Math.max(1, after - context + 1);
    const lastOld = Math.min(oldContent.length, after + context);
    const last = hunks[hunks.length - 1];
    if (last && firstOld <= last.lastOld + 1) {
      last.lastOld = Math.max(last.lastOld, lastOld);
      last.adds.set(after, [...(last.adds.get(after) ?? []), ...added]);
    } else {
      hunks.push({ firstOld, lastOld, adds: new Map([[after, added]]) });
    }
  }

  const out: string[] = [`--- a/${path}`, `+++ b/${path}`];
  let newShift = 0; // lines added by earlier hunks
  for (const h of hunks) {
    const body: string[] = [];
    let addedHere = 0;
    for (let n = h.firstOld; n <= h.lastOld; n++) {
      body.push(` ${oldContent[n - 1]}`);
      const adds = h.adds.get(n);
      if (adds) {
        for (const a of adds) body.push(`+${a}`);
        addedHere += adds.length;
      }
    }
    const oldCount = h.lastOld - h.firstOld + 1;
    const newStart = h.firstOld + newShift;
    out.push(
      `@@ -${h.firstOld},${oldCount} +${newStart},${oldCount + addedHere} @@`,
      ...body,
    );
    newShift += addedHere;
  }
  return out.join("\n") + "\n";
}
