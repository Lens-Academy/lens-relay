import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigation } from '../../../contexts/NavigationContext';
import { RELAY_ID } from '../../../lib/constants';
import { openDocInNewTab } from '../../../lib/url-utils';
import {
  courseChildrenFromText,
  findCourseAncestors,
  groupCoursesByFolder,
  listCourses,
  type CourseNodeKind,
  type CourseTreeNode,
} from '../../../lib/course-tree';
import type { FolderMetadata } from '../../../hooks/useFolderMetadata';
import { useBacklinksVersion } from '../../../hooks/useBacklinksVersion';
import { useDocTexts, type DocTextState } from '../../../hooks/useDocTexts';
import { FOLDER_ICON_SVG } from '../treeLayout';

const INDENT = 14;

type BadgedKind = Exclude<CourseNodeKind, 'group'>;

const BADGES: Record<Exclude<BadgedKind, 'link'>, string> = {
  course: 'Course',
  module: 'Module',
  meeting: 'Meeting',
  lens: 'Lens',
  outcome: 'Outcome',
  test: 'Test',
  article: 'Article',
  video: 'Video',
  page: 'Page',
  submodule: 'Submodule',
};

const BADGE_CLASS: Record<BadgedKind, string> = {
  course: 'bg-amber-100 text-amber-800',
  module: 'bg-purple-100 text-purple-700',
  meeting: 'bg-orange-100 text-orange-700',
  lens: 'bg-blue-100 text-blue-700',
  outcome: 'bg-green-100 text-green-700',
  test: 'bg-rose-100 text-rose-700',
  article: 'bg-teal-100 text-teal-700',
  video: 'bg-pink-100 text-pink-700',
  page: 'bg-gray-100 text-gray-600',
  submodule: 'bg-gray-100 text-gray-600',
  link: 'bg-gray-100 text-gray-500',
};

function badgeOf(node: CourseTreeNode): string | null {
  if (node.kind === 'group') return null;
  return node.kind === 'link' ? node.field ?? 'link' : BADGES[node.kind];
}

interface Row {
  node: CourseTreeNode;
  /** Path of node keys from the root; unique in the rendered tree. */
  id: string;
  depth: number;
  expandable: boolean;
  expanded: boolean;
  loading: boolean;
  error: boolean;
  /** The doc appears again inside itself: shown, not descended into. */
  cycle: boolean;
}

interface CourseTreeProps {
  /** Bare uuid of the document open in the editor, if any. */
  activeUuid: string | null;
}

/**
 * The course the open document belongs to, as a tree of the files that
 * embed each other: course → module / meeting → lens / outcome → article /
 * video, with survey links where they sit. Every course file is a root; the
 * one containing the open document is expanded down to it.
 */
export function CourseTree({ activeUuid }: CourseTreeProps) {
  const { metadata, folderDocs, onNavigate } = useNavigation();
  const backlinksVersion = useBacklinksVersion(folderDocs);

  const courses = useMemo(() => listCourses(metadata), [metadata]);
  // Under their folders of courses/ (user-facing, in-development, ...), as in the file tree
  const roots = useMemo(() => groupCoursesByFolder(courses), [courses]);

  // Everything upward of the active doc to its course; those rows open by default.
  const ancestors = useMemo(() => {
    void backlinksVersion;
    return activeUuid ? findCourseAncestors(activeUuid, folderDocs.values(), metadata) : null;
  }, [activeUuid, folderDocs, metadata, backlinksVersion]);
  // Keyed on content: metadata and backlinks change identity on every save
  // anywhere in the folder; the reveal logic must only run on a real change.
  const ancestorsKey = ancestors ? [...ancestors].sort().join('|') : '';
  const ancestorSet = useMemo(() => new Set(ancestorsKey ? ancestorsKey.split('|') : []), [ancestorsKey]);

  const { docs, request } = useDocTexts();

  // Parsed children per doc, cached on the text and metadata they came from.
  // (A state-held Map rather than a ref: it is read while rendering.)
  const [childrenCache] = useState(() => new Map<string, { text: string; metadata: FolderMetadata; children: CourseTreeNode[] }>());
  const childrenOf = useCallback((uuid: string, doc: DocTextState | undefined, path: string | undefined): CourseTreeNode[] => {
    if (!doc || doc.status !== 'ready') return [];
    const cached = childrenCache.get(uuid);
    if (cached && cached.text === doc.text && cached.metadata === metadata) return cached.children;
    const children = courseChildrenFromText(doc.text, path ?? '', metadata);
    childrenCache.set(uuid, { text: doc.text, metadata, children });
    return children;
  }, [metadata, childrenCache]);

  // A row on the way to the open document: one of its courses, modules or
  // lenses, or a folder holding its course (a folder row has no uuid)
  const holdsActive = useCallback((node: CourseTreeNode): boolean => (node.uuid
    ? ancestorSet.has(node.uuid)
    : !!node.folder && node.children.some((c) => !!c.uuid && ancestorSet.has(c.uuid))), [ancestorSet]);

  // Manual expand/collapse overrides, by row id. When the open document
  // changes, whatever was open stays open (frozen into overrides) and the
  // path to the new document reopens (its overrides cleared), like a file
  // tree revealing a file.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  const { rows, needed } = useMemo(() => {
    const rows: Row[] = [];
    const needed: string[] = [];
    const onPath = new Set<string>();
    const visit = (node: CourseTreeNode, parentId: string, depth: number) => {
      const id = parentId ? `${parentId}/${node.key}` : node.key;
      const cycle = !!node.uuid && onPath.has(node.uuid);
      const doc = node.uuid ? docs[node.uuid] : undefined;
      const children = node.uuid && !cycle
        ? [...node.children, ...childrenOf(node.uuid, doc, node.path)]
        : node.children;
      const pending = !!node.uuid && !cycle && (doc === undefined || doc.status === 'loading');
      const expandable = !cycle && (pending || children.length > 0);
      // A folder of courses starts open (archived ones closed) and always when it holds the open document's course
      const openByDefault = node.folder
        ? !/^archived$/i.test(node.label) || holdsActive(node)
        : holdsActive(node);
      const expanded = expandable && (overrides[id] ?? openByDefault);
      rows.push({
        node,
        id,
        depth,
        expandable,
        expanded,
        loading: doc?.status === 'loading',
        error: doc?.status === 'error',
        cycle,
      });
      // Courses (at the top or in a folder) load only once opened; everything
      // below loads as soon as it is on screen, so a row knows whether it can expand.
      if (node.uuid && !cycle && (expanded || node.kind !== 'course')) needed.push(node.uuid);
      if (!expanded) return;
      if (node.uuid) onPath.add(node.uuid);
      for (const child of children) visit(child, id, depth + 1);
      if (node.uuid) onPath.delete(node.uuid);
    };
    for (const root of roots) visit(root, '', 0);
    return { rows, needed };
  }, [roots, docs, overrides, holdsActive, childrenOf]);

  const neededKey = needed.join('|');
  useEffect(() => {
    request(neededKey ? neededKey.split('|') : []);
  }, [neededKey, request]);

  // One effect keeps the last rendered rows and reacts to a new active
  // chain, so the freeze always sees the rows of the previous chain.
  const rowsRef = useRef<Row[]>([]);
  const lastAncestorsKey = useRef<string | null>(null);
  useEffect(() => {
    if (lastAncestorsKey.current !== ancestorsKey) {
      lastAncestorsKey.current = ancestorsKey;
      const before = rowsRef.current;
      setOverrides(prev => {
        let changed = false;
        const next = { ...prev };
        for (const row of before) {
          if (holdsActive(row.node)) {
            if (row.id in next) {
              delete next[row.id];
              changed = true;
            }
          } else if (row.expanded && !(row.id in next)) {
            next[row.id] = true;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }
    rowsRef.current = rows;
  }, [rows, ancestorsKey, holdsActive]);

  const toggle = useCallback((row: Row) => {
    setOverrides(prev => ({ ...prev, [row.id]: !row.expanded }));
  }, []);

  const open = useCallback((uuid: string, newTab: boolean) => {
    if (newTab) openDocInNewTab(RELAY_ID, uuid, metadata);
    else onNavigate(`${RELAY_ID}-${uuid}`);
  }, [metadata, onNavigate]);

  // Bring the open document's row into view when it changes.
  const activeRowRef = useRef<HTMLDivElement | null>(null);
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!activeUuid || scrolledFor.current === activeUuid || !activeRowRef.current) return;
    scrolledFor.current = activeUuid;
    activeRowRef.current.scrollIntoView({ block: 'nearest' });
  }, [activeUuid, rows]);

  if (Object.keys(metadata).length === 0) {
    return <div className="p-4 text-sm text-gray-500">Loading documents...</div>;
  }
  if (courses.length === 0) {
    return (
      <div className="p-4 text-sm text-gray-500 text-center">
        No courses found.
        <br />
        Course files live in a <code>courses</code> folder.
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto py-1" data-testid="course-tree">
      {activeUuid && !ancestors && (
        <div className="px-3 py-1.5 text-[11px] text-gray-400">
          The open document is not part of a course.
        </div>
      )}
      {rows.map(row => {
        const { node } = row;
        const isActive = !!node.uuid && node.uuid === activeUuid;
        const navigable = !!node.uuid && !node.unresolved;
        const badge = badgeOf(node);
        const title = node.unresolved
          ? `Not found: ${node.label}`
          : row.cycle
            ? `${node.path ?? node.label} (embeds itself)`
            : node.path ?? node.label;
        return (
          <div
            key={row.id}
            ref={isActive ? activeRowRef : undefined}
            role="treeitem"
            aria-expanded={row.expandable ? row.expanded : undefined}
            aria-selected={isActive}
            data-kind={node.kind}
            className={`flex items-center h-7 pr-2 cursor-pointer select-none text-sm
                        ${isActive ? 'bg-blue-100' : 'hover:bg-gray-100'}`}
            style={{ paddingLeft: 4 + row.depth * INDENT }}
            title={title}
            onClick={(e) => {
              if (navigable) open(node.uuid!, e.metaKey || e.ctrlKey);
              else if (row.expandable) toggle(row);
            }}
            onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
            onAuxClick={(e) => {
              if (e.button === 1 && navigable) {
                e.preventDefault();
                open(node.uuid!, true);
              }
            }}
          >
            <button
              type="button"
              aria-label={row.expanded ? 'Collapse' : 'Expand'}
              tabIndex={-1}
              className={`w-4 h-4 flex-shrink-0 flex items-center justify-center text-gray-500
                          ${row.expandable ? '' : 'invisible'}`}
              onClick={(e) => { e.stopPropagation(); toggle(row); }}
            >
              {row.loading && row.expanded ? (
                <span className="w-2 h-2 rounded-full border border-gray-400 border-t-transparent animate-spin" />
              ) : (
                <svg
                  className={`w-3.5 h-3.5 transition-transform ${row.expanded ? 'rotate-90' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              )}
            </button>
            {node.folder && (
              <span className="ml-1 flex-shrink-0 flex text-[var(--lens-sidebar-icon)]" dangerouslySetInnerHTML={{ __html: FOLDER_ICON_SVG }} />
            )}
            {badge && (
              <span
                className={`ml-1 px-1 py-px rounded text-[9px] font-semibold uppercase tracking-wide flex-shrink-0 max-w-[4.5rem] truncate ${BADGE_CLASS[node.kind as BadgedKind]}`}
                title={badge}
              >
                {badge}
              </span>
            )}
            <span
              className={`ml-1.5 truncate ${
                node.unresolved ? 'text-red-600 line-through'
                  : node.folder ? 'text-gray-700'
                  : node.kind === 'group' ? 'text-gray-500 italic text-xs'
                    : navigable ? 'text-gray-700' : 'text-gray-500'
              }`}
            >
              {node.label}
            </span>
            {row.cycle && <span className="ml-1 text-gray-400 text-xs" aria-label="embeds itself">↺</span>}
            {row.error && <span className="ml-1 text-red-500 text-xs" title="Failed to load">!</span>}
          </div>
        );
      })}
    </div>
  );
}
