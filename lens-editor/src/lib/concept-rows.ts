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
 * `components/ConceptRowsPanel`. The platform's content validator flags
 * duplicate rows for one target (lens-platform content_processor).
 */
import type { FolderMetadata } from '../hooks/useFolderMetadata';
import { resolvePageName } from './document-resolver';
import { parseSections } from '../components/SectionEditor/parseSections';
import { parseFields } from './parseFields';

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
}

const RELATIONSHIPS = { sharedFolder: 'Lens Edu', rowsIn: 'Concepts', section: 'Relationships', title: 'Concept relationships' };

/** "For a file in `openedIn`, embed the rows about it from the files in `rowsIn`." */
export const CONCEPT_ROW_RULES: readonly ConceptRowRule[] = [
  { ...RELATIONSHIPS, openedIn: 'articles', openedLabel: 'This article' },
  { ...RELATIONSHIPS, openedIn: 'video_transcripts', openedLabel: 'This video' },
  { ...RELATIONSHIPS, openedIn: 'Lenses', openedLabel: 'This lens', sourceContext: true },
];

/** The kinds of file a lens's `source::` can name that have rows of their
 *  own, by folder (relative to the shared folder). Others (widgets) are left out. */
export const SOURCE_KINDS: ReadonlyArray<{ folder: string; label: string }> = [
  { folder: 'articles', label: 'Article' },
  { folder: 'video_transcripts', label: 'Video' },
];

/** "Article" or "Video" for a source at `path` (merged path), or null. */
export function sourceKind(path: string, sharedFolder: string): string | null {
  return SOURCE_KINDS.find((k) => path.startsWith(`/${sharedFolder}/${k.folder}/`))?.label ?? null;
}

/** The rule for the file at `path` (a merged, folder-prefixed path), or null. */
export function matchRule(
  path: string | undefined,
  rules: readonly ConceptRowRule[] = CONCEPT_ROW_RULES,
): ConceptRowRule | null {
  if (!path || !/\.md$/i.test(path)) return null;
  return rules.find((r) => path.startsWith(`/${r.sharedFolder}/${r.openedIn}/`)) ?? null;
}

/** Folder (merged path, no trailing slash) whose files hold the rule's rows. */
export function rowsFolder(rule: ConceptRowRule): string {
  return `/${rule.sharedFolder}/${rule.rowsIn}`;
}

export interface ConceptRow {
  /** The heading's link target, without `|alias` or `#heading`. */
  target: string;
  /** 1-based line of the heading. */
  line: number;
  headingFrom: number;
  /** End of the heading line (before its newline). */
  headingTo: number;
  /** The free text: from the line after the heading, trailing newlines left out. */
  bodyFrom: number;
  bodyTo: number;
  /** Where the row ends: the next heading of level ≤ 3, or the section's end. */
  to: number;
}

export interface ParsedConceptFile {
  /** The rows section: `to` is where it ends (next heading of level ≤ 2, or the end). */
  section: { headingFrom: number; to: number } | null;
  rows: ConceptRow[];
}

const HEADING = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE = /^[ \t]*(```|~~~)/;
const SINGLE_LINK = /^\[\[([^[\]\n]+)\]\]$/;

/** A wikilink's page part: `[[a/b#H|Alias]]` → `a/b`. */
export function linkPage(inner: string): string {
  return inner.split('|')[0].split('#')[0].trim();
}

interface Heading { level: number; text: string; from: number; to: number; line: number }

/** Headings of `text`, outside frontmatter and fenced code. */
function headingsOf(text: string): Heading[] {
  const out: Heading[] = [];
  let pos = 0;
  let line = 0;
  let fence: string | null = null;
  let inFrontmatter = text.startsWith('---\n') || text.startsWith('---\r\n');
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const raw = text.slice(pos, end).replace(/\r$/, '');
    line++;
    if (inFrontmatter) {
      if (line > 1 && raw === '---') inFrontmatter = false;
    } else {
      const fenceMatch = FENCE.exec(raw);
      if (fenceMatch) {
        if (fence === null) fence = fenceMatch[1];
        else if (fence === fenceMatch[1]) fence = null;
      } else if (fence === null) {
        const m = HEADING.exec(raw);
        // A closing sequence of #s (`### [[x]] ###`) is not part of the text.
        const headingText = (m?.[2] ?? '').replace(/(^|[ \t]+)#+$/, '').trim();
        if (m) out.push({ level: m[1].length, text: headingText, from: pos, to: pos + raw.length, line });
      }
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  return out;
}

/**
 * The rows section and its rows, by the same rules as the platform's content
 * validator: the level-2 heading matches `section` exactly (case-sensitive);
 * a row is a level-3 heading that is exactly one wikilink (`|alias` and
 * `#anchor` allowed, nothing else); headings in code, lists and quotes do
 * not count (only a `#` at the start of a line makes a heading).
 */
export function parseConceptFile(text: string, section = 'Relationships'): ParsedConceptFile {
  const headings = headingsOf(text);
  const start = headings.findIndex((h) => h.level === 2 && h.text === section);
  if (start === -1) return { section: null, rows: [] };
  const endIndex = headings.findIndex((h, i) => i > start && h.level <= 2);
  const sectionTo = endIndex === -1 ? text.length : headings[endIndex].from;
  const inside = headings.slice(start + 1, endIndex === -1 ? undefined : endIndex);

  const rows: ConceptRow[] = [];
  inside.forEach((h, i) => {
    if (h.level !== 3) return;
    const link = SINGLE_LINK.exec(h.text);
    const target = link ? linkPage(link[1]) : '';
    if (!target) return;
    const next = inside.slice(i + 1).find((n) => n.level <= 3);
    const to = next ? next.from : sectionTo;
    const bodyFrom = Math.min(h.to + 1, to);
    let bodyTo = to;
    while (bodyTo > bodyFrom && /\s/.test(text[bodyTo - 1])) bodyTo--;
    rows.push({ target, line: h.line, headingFrom: h.from, headingTo: h.to, bodyFrom, bodyTo, to });
  });
  return { section: { headingFrom: headings[start].from, to: sectionTo }, rows };
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
 * appended to the end of the rows section, which is added at the end of the
 * file when missing.
 */
export function planRowInsertion(text: string, link: string, body = '', section = 'Relationships'): RowInsertion {
  const heading = `### [[${link}]]\n`;
  const row = `${heading}${body}\n`;
  const parsed = parseConceptFile(text, section);
  const at = parsed.section ? parsed.section.to : text.length;
  const before = text.slice(0, at);
  const gap = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const head = parsed.section ? '' : `## ${section}\n\n`;
  // A heading follows: keep a blank line before it.
  const tail = at < text.length ? '\n' : '';
  const bodyFrom = at + gap.length + head.length + heading.length;
  return { at, insert: gap + head + row + tail, bodyFrom, bodyTo: bodyFrom + body.length };
}

/** A new concept file with its first row. */
export function newConceptText(name: string, link: string, body = '', section = 'Relationships'): string {
  return `# ${name}\n\n## ${section}\n\n### [[${link}]]\n${body}\n`;
}

/** The link targets of every `source::` in a lens (articles, videos, and
 *  whatever else; `sourceKind` sorts them), outside its text sections. */
export function lensSourceTargets(text: string): string[] {
  const targets: string[] = [];
  for (const section of parseSections(text)) {
    if (section.type === 'text' || section.type === 'frontmatter') continue;
    const source = parseFields(section.content).get('source') ?? '';
    const m = /\[\[([^[\]\n]+)\]\]/.exec(source);
    const target = m ? linkPage(m[1]) : '';
    if (target && !targets.includes(target)) targets.push(target);
  }
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
}

export interface CollectedRows {
  rows: RowEntry[];
  /** Concept files that link the target only outside a row heading. */
  mentions: Array<{ conceptId: string; conceptPath: string; conceptName: string }>;
  /** Sources not read yet. */
  pending: number;
}

export function fileName(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/i, '');
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
    const conceptName = fileName(conceptPath);
    const text = texts.get(conceptId);
    if (text === undefined) {
      out.pending++;
      continue;
    }
    const rows = rowsAbout(text, conceptPath, targetId, metadata, rule.section);
    if (rows.length === 0) out.mentions.push({ conceptId, conceptPath, conceptName });
    rows.forEach((row, index) => {
      out.rows.push({ conceptId, conceptPath, conceptName, row, index, body: text.slice(row.bodyFrom, row.bodyTo) });
    });
  }
  out.rows.sort((a, b) => a.conceptName.localeCompare(b.conceptName) || a.index - b.index);
  out.mentions.sort((a, b) => a.conceptName.localeCompare(b.conceptName));
  return out;
}

/** The rows about one of a lens's sources (an article or a video). */
export interface SourceRows {
  sourceId: string;
  sourceName: string;
  /** "Article" or "Video". */
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
 * A lens's rows grouped by concept: a concept with a lens row shows once,
 * its source rows under the lens row; a concept with only source rows also
 * shows once, however many of the sources it has rows for. Lens rows keep
 * the order they come in; the others go by concept name.
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
