/**
 * Course tree: the embed structure of a course, derived from the documents'
 * `# Kind:` sections and their `field:: [[wikilink]]` values.
 *
 * A course file lists modules and meetings; a module lists lenses and
 * learning outcomes; a lens embeds articles and videos; an outcome lists its
 * test and suggested lenses. Every level is the same shape (sections whose
 * fields point at other files), so one parser covers all of them and the
 * tree is built by loading each document on demand.
 */
import type { FolderMetadata } from '../hooks/useFolderMetadata';
import type * as Y from 'yjs';
import { parseSections, type Section } from '../components/SectionEditor/parseSections';
import { parseFields } from './parseFields';
import { parseWikilink, resolvePathToUuid } from './resolveDocPath';
import { pathToSegments } from './path-display';
import { uuidToPathIndex } from './uuid-to-path';
import { backlinkSources } from './backlinks';

export type CourseNodeKind =
  | 'course'
  | 'module'
  | 'meeting'
  | 'lens'
  | 'outcome'
  | 'test'
  | 'article'
  | 'video'
  | 'page'
  | 'submodule'
  | 'link'
  | 'group';

export interface CourseTreeNode {
  /** Stable key within its parent: section index plus target. */
  key: string;
  kind: CourseNodeKind;
  label: string;
  /** For `link` nodes: the field the link came from (`survey`). */
  field?: string;
  /** Relay doc UUID when the wikilink resolved to a document. */
  uuid?: string;
  /** Folder-prefixed metadata path of the target document. */
  path?: string;
  /** The wikilink pointed at a file that is not in the folder metadata. */
  unresolved?: boolean;
  /** Children known from the parent's text alone (field links of a section). */
  children: CourseTreeNode[];
}

/** Section types whose `source::` (or heading wikilink) points at another file. */
const REF_KINDS: Record<string, CourseNodeKind> = {
  'module-ref': 'module',
  'meeting-ref': 'meeting',
  'lens-ref': 'lens',
  'lo-ref': 'outcome',
  'test-ref': 'test',
  'article-ref': 'article',
  'video-ref': 'video',
  'article': 'article',
  'article-excerpt': 'article',
  'video': 'video',
  'video-excerpt': 'video',
  'page': 'page',
  'submodule': 'submodule',
};

/** The word a ref section's heading starts with, per kind (`# Learning Outcome:`). */
const KIND_WORDS: Partial<Record<CourseNodeKind, string>> = {
  module: 'module',
  meeting: 'meeting',
  lens: 'lens',
  outcome: 'learning outcome',
  test: 'test',
  article: 'article',
  video: 'video',
  page: 'page',
  submodule: 'submodule',
};

const CRITIC_COMMENT = /\{>>[\s\S]*?<<\}/g;

/** First `[[target]]` or `![[target]]` in a string, as a bare `[[target]]`. */
export function firstWikilink(value: string): string | null {
  const match = value.match(/!?\[\[([^\]]+)\]\]/);
  return match ? `[[${match[1]}]]` : null;
}

/**
 * The wikilink a field value starts with, ignoring inline comments and
 * anything after it. Prose fields that merely mention a file (`content::`
 * text with a link in a sentence) yield null.
 */
export function leadingWikilink(value: string): string | null {
  const bare = value.replace(CRITIC_COMMENT, '');
  return /^\s*!?\[\[/.test(bare) ? firstWikilink(bare) : null;
}

/** The wikilink a ref section points at: its `source::` field, else one in its heading. */
export function sectionWikilink(section: Section): string | null {
  return leadingWikilink(parseFields(section.content).get('source') ?? '') ?? firstWikilink(section.label);
}

export function basenameOf(path: string): string {
  return pathToSegments(path).at(-1) ?? path;
}

/** True for `/<folder>/courses/<file>.md`: the files the tree uses as roots. */
export function isCoursePath(path: string): boolean {
  return /^\/[^/]+\/courses\/[^/]+\.md$/i.test(path);
}

/** All course files across the shared folders, sorted by name. */
export function listCourses(metadata: FolderMetadata): CourseTreeNode[] {
  return Object.entries(metadata)
    .filter(([path, meta]) => meta.type === 'markdown' && isCoursePath(path))
    .sort(([a], [b]) => basenameOf(a).localeCompare(basenameOf(b)))
    .map(([path, meta]) => ({
      key: `course:${meta.id}`,
      kind: 'course' as const,
      label: basenameOf(path),
      uuid: meta.id,
      path,
      children: [],
    }));
}

/**
 * Label of a ref section: the heading text after its own `Kind:` word, the
 * wikilink alias, or the target file name.
 */
function refLabel(section: Section, kind: CourseNodeKind, source: string | null): string {
  const word = KIND_WORDS[kind] ?? kind;
  const rest = section.label.replace(new RegExp(`^${word}\\b\\s*:?\\s*`, 'i'), '').trim();
  const restLink = firstWikilink(rest);
  if (restLink) {
    const parsed = parseWikilink(restLink)!;
    return parsed.display ?? basenameOf(parsed.path);
  }
  if (rest) return rest;
  if (source) {
    const parsed = parseWikilink(source)!;
    return parsed.display ?? basenameOf(parsed.path);
  }
  return '';
}

function targetNode(
  key: string,
  kind: CourseNodeKind,
  label: string,
  wikilink: string,
  docPath: string,
  metadata: FolderMetadata,
  field?: string,
): CourseTreeNode {
  const { path } = parseWikilink(wikilink)!;
  const uuid = resolvePathToUuid(path, docPath, metadata);
  return {
    key,
    kind,
    label: label || basenameOf(path),
    field,
    uuid: uuid ?? undefined,
    path: uuid ? uuidToPathIndex(metadata).get(uuid) : undefined,
    unresolved: !uuid,
    children: [],
  };
}

/**
 * The files a document embeds or links to, in document order.
 *
 * Ref sections (`# Module:`, `# Lens:`, `#### Article`, …) become nodes of
 * their kind; their `source::` decides the target. Every other
 * `field:: [[link]]` (a meeting's `survey::`, a course's
 * `application-survey::`) becomes a `link` node under the section it sits
 * in. Sections nest by heading level, so an inline lens keeps the article it
 * embeds as its child. Sections that resolve to nothing and have no
 * children are dropped.
 */
export function courseChildrenFromText(
  text: string,
  docPath: string,
  metadata: FolderMetadata,
): CourseTreeNode[] {
  const roots: CourseTreeNode[] = [];
  const stack: { level: number; node: CourseTreeNode }[] = [];
  const parentFor = (level: number): CourseTreeNode[] => {
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
    return stack.length > 0 ? stack[stack.length - 1].node.children : roots;
  };

  parseSections(text).forEach((section, index) => {
    const fields = parseFields(section.content);
    const kind = REF_KINDS[section.type];

    const fieldLinks: CourseTreeNode[] = [];
    for (const [field, value] of fields) {
      if (kind && field === 'source') continue;
      const link = leadingWikilink(value);
      if (link) fieldLinks.push(targetNode(`${index}:${field}`, 'link', '', link, docPath, metadata, field));
    }

    let node: CourseTreeNode;
    if (kind) {
      const source = sectionWikilink(section);
      const label = refLabel(section, kind, source);
      node = source
        ? targetNode(`${index}:${kind}`, kind, label, source, docPath, metadata)
        : { key: `${index}:${kind}`, kind, label: label || kind, children: [] };
      node.children.push(...fieldLinks);
    } else if (section.type === 'heading') {
      node = { key: `${index}:group`, kind: 'group', label: section.label, children: fieldLinks };
    } else {
      // frontmatter, body and content sections: their links join the current level
      parentFor(section.level).push(...fieldLinks);
      return;
    }

    parentFor(section.level).push(node);
    stack.push({ level: section.level, node });
  });

  return prune(roots);
}

/** Drop nodes that point at nothing and contain nothing. */
function prune(nodes: CourseTreeNode[]): CourseTreeNode[] {
  const kept: CourseTreeNode[] = [];
  for (const node of nodes) {
    node.children = prune(node.children);
    if (node.uuid || node.unresolved || node.children.length > 0) kept.push(node);
  }
  return kept;
}

/** Backlink hops to follow before giving up on finding a course. */
const MAX_ANCESTOR_DEPTH = 6;

/**
 * Every document reachable upward from `uuid` through the folder docs'
 * backlinks maps (target uuid → source uuids), up to the course files,
 * including `uuid` itself. Null when no course links in within a few hops.
 *
 * Backlinks also index prose mentions, so this is a superset of the tree's
 * embed path: expanding every node in it always reveals the document, at
 * the cost of the odd extra open node.
 */
export function findCourseAncestors(
  uuid: string,
  folderDocs: Iterable<Y.Doc>,
  metadata: FolderMetadata,
): Set<string> | null {
  const paths = uuidToPathIndex(metadata);
  const path = paths.get(uuid);
  if (!path) return null;

  const docs = Array.from(folderDocs);
  const visited = new Set<string>([uuid]);
  let foundCourse = isCoursePath(path);
  let frontier = [uuid];
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const target of frontier) {
      for (const source of backlinkSources(target, docs)) {
        if (visited.has(source)) continue;
        const sourcePath = paths.get(source);
        if (!sourcePath || sourcePath.includes('/_trash/')) continue;
        visited.add(source);
        if (isCoursePath(sourcePath)) foundCourse = true;
        else next.push(source);
      }
    }
    frontier = next;
  }
  return foundCourse ? visited : null;
}
