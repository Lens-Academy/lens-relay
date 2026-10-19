/**
 * Concept rows ("junction rows"): what the team knows about a concept and a
 * source, stored once in the concept file and shown from the other end.
 *
 * A concept file (`Concepts/<name>.md`) has a `## Relationships` section; each
 * level-3 heading in it whose text is a single wikilink is a row about the
 * linked file, and runs until the next heading of level ≤ 3:
 *
 *     ## Relationships
 *
 *     ### [[../articles/ai-control-redwood]]
 *     Best intro we have. §2 is the explanation.
 *
 * Which files show which rows is the rule table below; the panel itself is
 * `components/ConceptRowsPanel`. The format, and the canonical parsing rules
 * this file shares with the relay's MCP tools and the platform's content
 * validator, are in docs/concept-relationships.md.
 */
import type { FolderMetadata } from '../hooks/useFolderMetadata';
import { resolvePageName } from './document-resolver';
import { basenameOf } from './course-tree';

export interface ConceptRowRule {
  /** Shared folder the rule applies in (the first path segment). */
  sharedFolder: string;
  /** Folder of the opened file, relative to the shared folder. */
  openedIn: string;
  /** Folder whose files hold the rows, relative to the shared folder. */
  rowsIn: string;
  /** Heading (level 2) of the section that holds the rows. */
  section: string;
  title: string;
  /** What the opened file is called in a row's pair header ("[Concept] × [This article]"). */
  openedLabel: string;
  /** Also show, greyed, the rows of the sources the opened file wraps
   *  (a lens's `source::` articles and videos). */
  sourceContext?: boolean;
  /** Also show the rows of the lenses that use the opened file as a
   *  `source::` (an article's or a video's lenses), editable. */
  lensContext?: boolean;
}

const RELATIONSHIPS = { sharedFolder: 'Lens Edu', rowsIn: 'Concepts', section: 'Relationships', title: 'Concept relationships' };

/** "For a file in `openedIn`, embed the rows about it from the files in `rowsIn`." */
export const CONCEPT_ROW_RULES: readonly ConceptRowRule[] = [
  { ...RELATIONSHIPS, openedIn: 'articles', openedLabel: 'This article', lensContext: true },
  { ...RELATIONSHIPS, openedIn: 'video_transcripts', openedLabel: 'This video', lensContext: true },
  { ...RELATIONSHIPS, openedIn: 'Lenses', openedLabel: 'This lens', sourceContext: true },
];

/** The kinds of file a lens's `source::` can name that have rows of their
 *  own, by folder (relative to the shared folder). Others (widgets) are left out. */
const SOURCE_KINDS: ReadonlyArray<{ folder: string; label: string }> = [
  { folder: 'articles', label: 'Article' },
  { folder: 'video_transcripts', label: 'Video' },
];

/** "Article" or "Video" for a source at `path` (merged path), or null. */
export function sourceKind(path: string, sharedFolder: string): string | null {
  return SOURCE_KINDS.find((k) => path.startsWith(`/${sharedFolder}/${k.folder}/`))?.label ?? null;
}

/** Whether `path` (merged path) is a lens in `sharedFolder`: a file of the
 *  rule with source context there. */
export function isLensPath(path: string, sharedFolder: string): boolean {
  const rule = matchRule(path);
  return !!rule?.sourceContext && rule.sharedFolder === sharedFolder;
}

/** The rule for the file at `path` (a merged, folder-prefixed path), or null. */
export function matchRule(path: string | undefined): ConceptRowRule | null {
  if (!path || !/\.md$/i.test(path)) return null;
  return CONCEPT_ROW_RULES.find((r) => path.startsWith(`/${r.sharedFolder}/${r.openedIn}/`)) ?? null;
}

/** Folder (merged path, no trailing slash) whose files hold the rule's rows. */
export function rowsFolder(rule: ConceptRowRule): string {
  return `/${rule.sharedFolder}/${rule.rowsIn}`;
}

export interface ConceptRow {
  /** The heading's link target, without `|alias` or `#heading`. */
  target: string;
  /** End of the heading line (before its newline). */
  headingTo: number;
  /** The free text: from the line after the heading, trailing newlines left out. */
  bodyFrom: number;
  bodyTo: number;
  /** Where the row ends: the next heading of level ≤ 3, or the section's end. */
  to: number;
}

export interface ParsedConceptFile {
  /** Every rows section, in order: `to` is where it ends (the next heading of
   *  level ≤ 2, or the end). New rows go to the first. */
  sections: Array<{ to: number }>;
  rows: ConceptRow[];
}

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const SINGLE_LINK = /^\[\[([^[\]\n]+)\]\]$/;

/** A wikilink's page part: `[[a/b#H|Alias]]` → `a/b`. */
function linkPage(inner: string): string {
  return inner.split('|')[0].split('#')[0].trim();
}

interface Heading { level: number; text: string; from: number; to: number }

/**
 * ATX headings of `text`, by the canonical concept-row rules (v1, shared with
 * the relay's MCP tools and the platform validator): up to 3 spaces of indent;
 * a closing run of #s is not part of the text; none inside frontmatter
 * (closing `---` may have trailing whitespace), fenced code (CommonMark
 * opening and closing), `%% %%` comments, list items or block quotes. Setext
 * headings and HTML blocks are not handled.
 *
 * The editor parses the raw text, pending CriticMarkup included, because it
 * edits at raw offsets: a heading that exists only inside a pending
 * suggestion is a known, accepted divergence from the relay (rule 6).
 */
function headingsOf(text: string): Heading[] {
  const out: Heading[] = [];
  let pos = 0;
  let line = 0;
  let fence: { char: string; len: number } | null = null;
  let inComment = false;
  let inList = false;
  let inFrontmatter = /^---[ \t]*\r?(\n|$)/.test(text);
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const raw = text.slice(pos, end).replace(/\r$/, '');
    line++;
    if (inFrontmatter) {
      if (line > 1 && /^---[ \t]*$/.test(raw)) inFrontmatter = false;
    } else if (fence) {
      const close = FENCE_CLOSE.exec(raw);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) fence = null;
    } else {
      const open = FENCE_OPEN.exec(raw);
      const commentAtStart = inComment;
      // `%%` toggles an Obsidian comment, inline or across lines.
      if ((raw.match(/%%/g)?.length ?? 0) % 2 === 1) inComment = !inComment;
      if (open && !(open[1][0] === '`' && open[2].includes('`')) && !commentAtStart) {
        fence = { char: open[1][0], len: open[1].length };
      } else if (!commentAtStart) {
        if (LIST_ITEM.test(raw)) inList = true;
        else if (raw.trim() && !/^[ \t]/.test(raw)) inList = false;
        const m = HEADING.exec(raw);
        // An indented heading under a list item belongs to the item.
        const inItem = inList && /^[ \t]/.test(raw);
        if (m && !inItem) {
          const headingText = (m[2] ?? '').replace(/(^|[ \t]+)#+$/, '').trim();
          out.push({ level: m[1].length, text: headingText, from: pos, to: pos + raw.length });
        }
      }
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  return out;
}

/**
 * The rows sections and their rows, by the canonical concept-row rules (v1):
 * every level-2 heading that is exactly `section` (case-sensitive) starts a
 * section, which ends at the next heading of level ≤ 2; a row is a level-3
 * heading in it that is exactly one wikilink (`|alias` and `#anchor` inside
 * the brackets allowed; an `![[embed]]` or an empty page is not a row); its
 * body runs to the next heading of level ≤ 3.
 */
export function parseConceptFile(text: string, section = 'Relationships'): ParsedConceptFile {
  const headings = headingsOf(text);
  const sections: ParsedConceptFile['sections'] = [];
  const rows: ConceptRow[] = [];
  headings.forEach((h, start) => {
    if (h.level !== 2 || h.text !== section) return;
    const endIndex = headings.findIndex((n, i) => i > start && n.level <= 2);
    const sectionTo = endIndex === -1 ? text.length : headings[endIndex].from;
    sections.push({ to: sectionTo });
    const inside = headings.slice(start + 1, endIndex === -1 ? undefined : endIndex);
    inside.forEach((r, i) => {
      if (r.level !== 3) return;
      const link = SINGLE_LINK.exec(r.text);
      const target = link ? linkPage(link[1]) : '';
      if (!target) return;
      const next = inside.slice(i + 1).find((n) => n.level <= 3);
      const to = next ? next.from : sectionTo;
      const bodyFrom = Math.min(r.to + 1, to);
      let bodyTo = to;
      while (bodyTo > bodyFrom && /\s/.test(text[bodyTo - 1])) bodyTo--;
      rows.push({ target, headingTo: r.to, bodyFrom, bodyTo, to });
    });
  });
  return { sections, rows };
}

/**
 * Whether an empty row has no line of its own to be edited on, and where the
 * line break that gives it one goes: 'after' its (empty) text when it sits at
 * the very start of the next heading's line, 'before' it when it sits at the
 * end of its own heading line (no line break after it: the end of the
 * file). Null when it has a line.
 * Without the break, typing there would run into a heading.
 */
export function bodyLineFix(row: ConceptRow, textLength: number): 'before' | 'after' | null {
  if (row.bodyFrom === row.headingTo) return 'before';
  return row.bodyFrom === row.to && row.to < textLength ? 'after' : null;
}

/**
 * The live row an edit is for. `liveRows` are the live file's rows about the
 * target (rowsAbout); `entry` was found in a snapshot that may be stale, so
 * when there are several: the row at the same position if its text is
 * unchanged (two rows with the same text, or two empty ones, are told apart
 * by position), else the first with the same text, else the one at the
 * same position.
 */
export function findLiveRow(
  liveRows: readonly ConceptRow[],
  liveText: string,
  entry: Pick<RowEntry, 'index' | 'body'>,
): ConceptRow | null {
  if (liveRows.length <= 1) return liveRows[0] ?? null;
  const bodyOf = (r: ConceptRow) => liveText.slice(r.bodyFrom, r.bodyTo);
  const atIndex = liveRows[entry.index];
  if (atIndex && bodyOf(atIndex) === entry.body) return atIndex;
  return liveRows.find((r) => bodyOf(r) === entry.body) ?? atIndex ?? null;
}

/**
 * Whether the row's lines end in \r\n (from the end of its heading through
 * its end). CodeMirror counts \r\n as one character, so a row editor bound
 * to such a row (y-section-sync) would write at drifting offsets, even into
 * an empty or one-line row, whose body has no \r of its own: it is edited
 * in the concept file instead.
 */
export function rowHasCR(text: string, row: ConceptRow): boolean {
  return text.slice(row.headingTo, row.to).includes('\r');
}

/** Why a row heading cannot link to `link` (a path with characters that end
 *  or split a wikilink), or null. */
export function rowLinkProblem(link: string): string | null {
  return /[#|[\]]/.test(link)
    ? 'A file whose name or folder contains #, |, [ or ] cannot be linked from a concept row. Rename it first.'
    : null;
}

/** The rows of a concept file about the document `targetId`: its heading's
 *  link resolves to that document (by id, as links resolve in the editor). */
export function rowsAbout(
  text: string,
  conceptPath: string,
  targetId: string,
  metadata: FolderMetadata,
  section = 'Relationships',
): ConceptRow[] {
  return parseConceptFile(text, section).rows.filter(
    (row) => resolvePageName(row.target, metadata, conceptPath)?.docId === targetId,
  );
}

/** One line for a collapsed row: the first non-empty line, cut at `max` chars. */
export function rowPreview(body: string, max = 120): string {
  const first = body.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

export interface RowInsertion {
  at: number;
  insert: string;
  /** Where the new row's free text lies once inserted. */
  bodyFrom: number;
  bodyTo: number;
}

/**
 * A new row `### [[link]]` with `body` (empty: just an empty line under it),
 * appended to the end of the (first) rows section, which is added at the end
 * of the file when missing.
 */
export function planRowInsertion(text: string, link: string, body = '', section = 'Relationships'): RowInsertion {
  const heading = `### [[${link}]]\n`;
  const row = `${heading}${body}\n`;
  const first = parseConceptFile(text, section).sections[0];
  const at = first ? first.to : text.length;
  const before = text.slice(0, at);
  const gap = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const head = first ? '' : `## ${section}\n\n`;
  // A heading follows: keep a blank line before it.
  const tail = at < text.length ? '\n' : '';
  const bodyFrom = at + gap.length + head.length + heading.length;
  return { at, insert: gap + head + row + tail, bodyFrom, bodyTo: bodyFrom + body.length };
}

/**
 * Add a row about `targetId` to the concept file `text` (live), unless one is
 * already there: the live text, not a snapshot, decides. Returns which of the
 * file's rows about the target to open.
 */
export function insertRowUnlessPresent(
  text: { toString(): string; insert(index: number, content: string): void },
  conceptPath: string,
  targetId: string,
  link: string,
  body: string,
  metadata: FolderMetadata,
  section = 'Relationships',
): { index: number } {
  if (rowsAbout(text.toString(), conceptPath, targetId, metadata, section).length > 0) return { index: 0 };
  const plan = planRowInsertion(text.toString(), link, body, section);
  text.insert(plan.at, plan.insert);
  const index = rowsAbout(text.toString(), conceptPath, targetId, metadata, section).findIndex((r) => r.bodyFrom === plan.bodyFrom);
  return { index: Math.max(0, index) };
}

/**
 * Another row's text as the first draft of a new row: line breaks as \n,
 * leading blank lines and trailing whitespace dropped (a row body as read
 * starts with the line break after its heading in a CRLF file).
 */
export function draftFromRow(body: string): string {
  return body.replace(/\r\n?/g, '\n').replace(/^\s*\n/, '').trimEnd();
}

/** Whether a concept file's text uses \r\n line breaks (a row added to it
 *  could not be edited in place). */
export function hasCRLF(text: string): boolean {
  return text.includes('\r');
}

/** A new concept file with its first row, under frontmatter holding its
 *  `id:` (a new uuid, from relay-api's generateUUID; it stays when the file
 *  is renamed). */
export function newConceptText(name: string, id: string, link: string, body = '', section = 'Relationships'): string {
  return `---\nid: ${id}\n---\n# ${name}\n\n## ${section}\n\n### [[${link}]]\n${body}\n`;
}

/**
 * The link targets of every `source::` field in a lens (canonical concept-row
 * rules v1 #8): several per section, before the first heading, in CRLF files
 * too, but not inside `#### Text` sections (their content is prose). The
 * first wikilink of each value; `sourceKind` keeps articles and videos.
 * Unlike course-tree's sectionWikilink (one `source::` per section, for the
 * course tree), this must find every source, to match the relay and platform.
 */
export function lensSourceTargets(text: string): string[] {
  const targets: string[] = [];
  let inText = false;
  let inFrontmatter = /^---[ \t]*\r?(\n|$)/.test(text);
  text.split('\n').forEach((rawLine, i) => {
    const line = rawLine.replace(/\r$/, '');
    if (inFrontmatter) {
      if (i > 0 && /^---[ \t]*$/.test(line)) inFrontmatter = false;
      return;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      inText = heading[1].length === 4 && (heading[2] ?? '').trim().toLowerCase() === 'text';
      return;
    }
    if (inText) return;
    const field = /^source::(.*)$/.exec(line);
    const link = field && /\[\[([^[\]\n]+)\]\]/.exec(field[1]);
    const target = link ? linkPage(link[1]) : '';
    if (target && !targets.includes(target)) targets.push(target);
  });
  return targets;
}

export interface RowEntry {
  conceptId: string;
  conceptPath: string;
  conceptName: string;
  row: ConceptRow;
  /** Which of the file's rows about the target this is (they are told apart by order). */
  index: number;
  body: string;
  /** Its lines end in \r\n (rowHasCR): shown read-only. */
  crlf?: boolean;
}

export interface CollectedRows {
  rows: RowEntry[];
  /** Concept files that link the target only outside a row heading. */
  mentions: Array<{ conceptId: string; conceptPath: string; conceptName: string }>;
  /** Sources not read yet. */
  pending: number;
}

/**
 * The rows about `targetId` among `sourceIds` (documents linking to it, from
 * the backlinks index), keeping only files in the rule's rows folder. A file
 * not read yet (`texts` lacks it) counts as pending.
 */
export function collectRows(
  targetId: string,
  sourceIds: readonly string[],
  texts: ReadonlyMap<string, string>,
  metadata: FolderMetadata,
  rule: ConceptRowRule,
  pathOf: (id: string) => string | null,
): CollectedRows {
  const folder = `${rowsFolder(rule)}/`;
  const out: CollectedRows = { rows: [], mentions: [], pending: 0 };
  for (const conceptId of sourceIds) {
    const conceptPath = pathOf(conceptId);
    if (!conceptPath || !conceptPath.startsWith(folder) || !/\.md$/i.test(conceptPath)) continue;
    const conceptName = basenameOf(conceptPath);
    const text = texts.get(conceptId);
    if (text === undefined) {
      out.pending++;
      continue;
    }
    const rows = rowsAbout(text, conceptPath, targetId, metadata, rule.section);
    if (rows.length === 0) out.mentions.push({ conceptId, conceptPath, conceptName });
    rows.forEach((row, index) => {
      out.rows.push({
        conceptId, conceptPath, conceptName, row, index,
        body: text.slice(row.bodyFrom, row.bodyTo),
        crlf: rowHasCR(text, row),
      });
    });
  }
  out.rows.sort((a, b) => a.conceptName.localeCompare(b.conceptName) || a.index - b.index);
  out.mentions.sort((a, b) => a.conceptName.localeCompare(b.conceptName));
  return out;
}

/** The rows about one of a lens's sources (an article or a video), or, on
 *  an article or video, about one of the lenses that use it. */
export interface SourceRows {
  sourceId: string;
  sourceName: string;
  /** "Article", "Video" or "Lens". */
  kind: string;
  rows: RowEntry[];
}

export interface LensRowGroups {
  /** One per lens row, with its concept's rows about the lens's sources (only
   *  on the concept's first lens row, and only sources that have a row there). */
  lens: Array<{ entry: RowEntry; sourceRows: SourceRows[] }>;
  /** One per concept with rows about the lens's sources but none about the
   *  lens, with those rows per source. */
  sourceOnly: Array<{ conceptId: string; conceptName: string; sourceRows: SourceRows[] }>;
}

/**
 * The lenses among `candidateIds` (the opened file's backlinkers) that use
 * `targetId` as a `source::` (canonical concept-row rules v1 #10): files in
 * the lenses folder whose `lensSourceTargets` resolve to it. A lens not read
 * yet (`texts` lacks it) counts as pending. By lens name.
 */
export function lensesUsing(
  targetId: string,
  candidateIds: readonly string[],
  texts: ReadonlyMap<string, string>,
  metadata: FolderMetadata,
  sharedFolder: string,
  pathOf: (id: string) => string | null,
): { lenses: Array<{ id: string; path: string }>; pending: number } {
  const lenses: Array<{ id: string; path: string }> = [];
  let pending = 0;
  for (const id of new Set(candidateIds)) {
    const path = pathOf(id);
    if (!path || id === targetId || !isLensPath(path, sharedFolder)) continue;
    const text = texts.get(id);
    if (text === undefined) {
      pending++;
      continue;
    }
    const uses = lensSourceTargets(text).some((t) => resolvePageName(t, metadata, path)?.docId === targetId);
    if (uses) lenses.push({ id, path });
  }
  lenses.sort((a, b) => basenameOf(a.path).localeCompare(basenameOf(b.path)) || a.path.localeCompare(b.path));
  return { lenses, pending };
}

/**
 * A lens's rows grouped by concept: a concept with a lens row shows once,
 * its source rows under the lens row; a concept with only source rows also
 * shows once, however many of the sources it has rows for. Lens rows keep
 * the order they come in; the others go by concept name.
 *
 * Mirrored on an article or video (rule #10): `own` are its rows and
 * `sources` the rows about the lenses that use it.
 */
export function groupLensRows(own: readonly RowEntry[], sources: readonly SourceRows[]): LensRowGroups {
  const forConcept = (conceptId: string) => sources
    .map((src) => ({ ...src, rows: src.rows.filter((r) => r.conceptId === conceptId) }))
    .filter((src) => src.rows.length > 0);
  const seen = new Set<string>();
  const lens = own.map((entry) => {
    const first = !seen.has(entry.conceptId);
    seen.add(entry.conceptId);
    return { entry, sourceRows: first ? forConcept(entry.conceptId) : [] };
  });
  const names = new Map<string, string>();
  for (const src of sources) {
    for (const r of src.rows) if (!seen.has(r.conceptId)) names.set(r.conceptId, r.conceptName);
  }
  const sourceOnly = [...names]
    .sort(([, a], [, b]) => a.localeCompare(b))
    .map(([conceptId, conceptName]) => ({ conceptId, conceptName, sourceRows: forConcept(conceptId) }));
  return { lens, sourceOnly };
}
