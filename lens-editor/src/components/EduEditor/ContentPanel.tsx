import { useEffect, useState, useRef, type ReactNode } from 'react';
import type { Section } from '../SectionEditor/parseSections';
import { findOrphanCommentOffsets } from './orphan-comments';
import { OrphanCommentAnchors } from './OrphanCommentAnchors';
import { parseSections } from '../SectionEditor/parseSections';
import { parseFields, parseFrontmatterFields, getFieldValueRange } from '../../lib/parseFields';
import { useDocConnection } from '../../hooks/useDocConnection';
import { useSectionEditor } from '../../hooks/useSectionEditor';
import { useNavigation } from '../../contexts/NavigationContext';
import { RELAY_ID } from '../../lib/constants';
import { openDocInNewTab, docUuidFromCompoundId } from '../../lib/url-utils';
import { getOriginalPath, getFolderNameFromPath } from '../../lib/multi-folder-utils';
import { getPlatformUrl, getModulePlatformUrl } from '../../lib/platform-url';
import { getSubtreeRange } from './getSubtreeRange';
import * as Y from 'yjs';
import {
  TextRenderer,
  ChatRenderer,
  ArticleRenderer,
  VideoRenderer,
  QuestionRenderer,
  HeadingRenderer,
} from './ContentPanel/renderers';
import type { CriticMarkupRange } from '../../lib/criticmarkup-parser';
import {
  buildGlobalCommentBadgeMap,
  sliceCommentBadgeMap,
} from '../../lib/criticmarkup-render';
import { ContextMenu } from '../Editor/ContextMenu';
import type { ContextMenuItem } from '../Editor/extensions/criticmarkup-context-menu';
import { getContextMenuItems } from '../Editor/extensions/criticmarkup-context-menu';
import type { SectionViewEntry } from '../../lib/anchor-resolver';

export type ContentScope =
  | { kind: 'full-doc'; docId: string; docName: string; docPath: string }
  | { kind: 'subtree'; docId: string; docName: string; docPath: string; rootSectionIndex: number; breadcrumb: string };

interface ContentPanelProps {
  scope: ContentScope | null;
  /** Frontmatter slug of the module the scope belongs to. When set, the
   *  "Show on Lensacademy.org" link points at the module page anchored to the
   *  selected lens instead of the standalone /lens/... page. */
  moduleSlug?: string;
  /** Frontmatter slug of the course the module belongs to (course mode only).
   *  Scopes the platform link to /course/:courseSlug/module/:moduleSlug so the
   *  platform stays inside the course. */
  courseSlug?: string;
  /** Master switch for the criticmarkup feature inside this panel. When false,
   *  text/heading sections render exactly as before. When true, criticmarkup
   *  syntax is rendered inline, the section editor gets the criticmarkup
   *  extension stack, and clicks on criticmarkup ranges fire onClickCriticRange. */
  criticMarkupEnabled?: boolean;
  /** Initial suggestion mode for criticmarkup-enabled section editors. */
  suggestionMode?: boolean;
  /** Called when the active section editor's cursor moves (or the editor
   *  closes). The argument is the absolute Y.Text offset, or null when no
   *  section editor is active. EduEditor uses this to drive the comments
   *  sidebar's "+ Add Comment" button. */
  onCommentInsertPosChange?: (pos: number | null) => void;
  /** Called when the user clicks an inline criticmarkup span — typically a
   *  comment marker — in a rendered (non-editing) section. */
  onClickCriticRange?: (range: CriticMarkupRange) => void;
  /** Called when the user clicks a comment marker (read or edit mode) with the
   *  absolute Y.Text offset. Wired through to CommentsLayer.focusThread. */
  onCommentClick?: (absFrom: number) => void;
  /** Called when the user invokes the "Add Comment" entry point — either the
   *  Ctrl/Cmd+Shift+M shortcut inside the active section editor or the
   *  right-click "Add Comment" menu item. The current cursor position has
   *  already been reported up via onCommentInsertPosChange, so the parent
   *  just needs to open its add-comment UI. */
  onRequestAddComment?: () => void;
  /** Ref to the scroll container ContentPanel renders inside. Used as the
   *  IntersectionObserver root so the scroll-spy can resolve which comment
   *  markers are currently visible. */
  scrollRootRef?: React.RefObject<HTMLElement | null>;
  /** Fires when the topmost-visible comment marker in the scroll container
   *  changes. Argument is the marker's absolute Y.Text position, or null
   *  when none are visible. EduEditor uses this to keep the sidebar
   *  auto-scrolled to the comments for the section currently on screen. */
  onVisibleCommentChange?: (absoluteFrom: number | null) => void;
  /** Fires when the active doc's Y.Text changes (on scope switch or initial
   *  connect). The parent uses this to pass the correct yText to CommentsLayer. */
  onYTextChange?: (ytext: Y.Text | null) => void;
  /** Fires when the active section editor view mounts or unmounts. The parent
   *  uses this to update its SectionViewEntry list for CommentsLayer's
   *  resolveAnchorY resolver. */
  onSectionViewChange?: (entry: SectionViewEntry | null) => void;
}

/**
 * Find the absolute Y.Text range of a field's value within a section.
 * Returns [from, to) offsets into the full Y.Text.
 * If the field isn't found, falls back to the whole section range.
 */
/**
 * Find the absolute Y.Text range of a YAML frontmatter field's value.
 * Handles both `key: value` and `key: "quoted value"` on a single line.
 * For multi-line quoted values, captures until the closing quote.
 */
function getFrontmatterFieldRange(
  sectionContent: string,
  sectionFrom: number,
  fieldName: string,
): [number, number] | null {
  const pattern = new RegExp(`^${fieldName}:\\s*(.*)$`, 'm');
  const match = pattern.exec(sectionContent);
  if (!match) return null;

  let valueStr = match[1];
  let valueStart = match.index + match[0].length - valueStr.length;

  // Strip surrounding quotes
  if (valueStr.startsWith('"') && valueStr.endsWith('"')) {
    valueStart += 1;
    valueStr = valueStr.slice(1, -1);
  }

  return [sectionFrom + valueStart, sectionFrom + valueStart + valueStr.length];
}

/** Map section type to the primary prose field name */
function proseFieldForType(type: string): string | null {
  if (type === 'text') return 'content';
  if (type === 'chat') return 'instructions';
  if (type === 'question') return 'content';
  return null;
}

export function ContentPanel({
  scope,
  moduleSlug,
  courseSlug,
  criticMarkupEnabled = false,
  suggestionMode = false,
  onCommentInsertPosChange,
  onClickCriticRange,
  onCommentClick,
  onRequestAddComment,
  scrollRootRef,
  onVisibleCommentChange,
  onYTextChange,
  onSectionViewChange,
}: ContentPanelProps) {
  const { getOrConnect } = useDocConnection();
  const { metadata, folderNames } = useNavigation();
  const [sections, setSections] = useState<Section[]>([]);
  const [synced, setSynced] = useState(false);
  const [frontmatter, setFrontmatter] = useState<Map<string, string>>(new Map());
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingFmField, setEditingFmField] = useState<string | null>(null); // frontmatter field name being edited
  // Latest Y.Text string — kept in state so the document-wide comment badge
  // map recomputes on every doc change (including inserts from other clients).
  const [docText, setDocText] = useState<string>('');
  const ytextRef = useRef<Y.Text | null>(null);

  // Right-click context menu state for the active section editor. Mirrors
  // the markdown editor's ContextMenu flow.
  const [contextMenu, setContextMenu] = useState<{
    items: ContextMenuItem[];
    position: { x: number; y: number };
  } | null>(null);

  // Document-wide comment badge map — keyed by ABSOLUTE Y.Text positions.
  // Built once per docText change and sliced per field/section so badge
  // numbers stay linear across the same document, including while a single
  // field is open in CodeMirror.
  const globalBadgeMap = criticMarkupEnabled
    ? buildGlobalCommentBadgeMap(docText)
    : new Map();

  // Map sectionIndex → absolute offsets of comments that fall OUTSIDE any
  // rendered field value (headings, blank lines, sections with no field).
  // Used to emit invisible anchor elements so CommentsLayer can place a card
  // for these comments even though they have no inline marker.
  const orphansBySection = (() => {
    const map = new Map<number, number[]>();
    if (!criticMarkupEnabled) return map;
    for (const o of findOrphanCommentOffsets(docText, sections)) {
      const arr = map.get(o.sectionIndex);
      if (arr) arr.push(o.absFrom);
      else map.set(o.sectionIndex, [o.absFrom]);
    }
    return map;
  })();

  // Compute the editing range
  const editRange = (() => {
    if (editingIndex === null && !editingFmField) return { from: 0, to: 0 };

    const currentSections = parseSections(ytextRef.current?.toString() ?? '');

    // Frontmatter field editing
    if (editingFmField) {
      const fmSection = currentSections.find(s => s.type === 'frontmatter');
      if (!fmSection) return { from: 0, to: 0 };
      const range = getFrontmatterFieldRange(fmSection.content, fmSection.from, editingFmField);
      if (!range) return { from: 0, to: 0 };
      return { from: range[0], to: range[1] };
    }

    // Section editing
    const section = currentSections[editingIndex!];
    if (!section) return { from: 0, to: 0 };
    const proseField = proseFieldForType(section.type);
    if (proseField) {
      const [from, to] = getFieldValueRange(section.content, section.from, proseField);
      return { from, to };
    }
    return { from: section.from, to: section.to };
  })();

  const isEditing = editingIndex !== null || editingFmField !== null;

  function startEditingSection(index: number) {
    setEditingFmField(null);
    setEditingIndex(index);
  }

  const editKey = editingFmField ?? (editingIndex !== null ? `section-${editingIndex}` : null);

  // Only opt the section editor into criticmarkup for free-text section types.
  // Frontmatter-field edits and structured field edits stay plain.
  const editingSectionType: string | null = (() => {
    if (editingIndex === null) return null;
    return sections[editingIndex]?.type ?? null;
  })();
  // Any section whose visible content is free-form prose should get the
  // criticmarkup extension stack in its section editor — so comments and
  // suggestions added there render as widgets, not raw markup.
  const sectionAllowsCriticMarkup =
    editingSectionType === 'text' ||
    editingSectionType === 'heading' ||
    editingSectionType === 'chat' ||
    editingSectionType === 'question';
  const sectionEditorCriticMarkup = criticMarkupEnabled && sectionAllowsCriticMarkup;
  const editorCommentBadgeMap = sectionEditorCriticMarkup
    ? sliceCommentBadgeMap(globalBadgeMap, editRange.from, Math.max(0, editRange.to - editRange.from))
    : undefined;

  const { mountRef, viewRef: sectionViewRef } = useSectionEditor({
    ytext: ytextRef.current,
    sectionFrom: editRange.from,
    sectionTo: editRange.to,
    active: isEditing,
    editKey,
    enableCriticMarkup: sectionEditorCriticMarkup,
    initialSuggestionMode: suggestionMode,
    commentBadgeMap: editorCommentBadgeMap,
    yTextOffsetBase: editRange.from,
    // Mod-Shift-m → flush cursor position upward then open the add-comment UI.
    onRequestAddComment: onRequestAddComment
      ? () => {
          const view = sectionViewRef.current;
          if (view && onCommentInsertPosChange) {
            onCommentInsertPosChange(editRange.from + view.state.selection.main.head);
          }
          onRequestAddComment();
        }
      : undefined,
    onCommentClick,
  });

  // Right-click handler for the active criticmarkup-enabled section editor.
  // Builds a context menu that combines criticmarkup actions (Accept/Reject
  // when the click lands inside a markup range) with an always-present
  // "Add Comment" item — same UX as the markdown editor's ContextMenu.
  const handleSectionContextMenu = (e: React.MouseEvent) => {
    if (!sectionEditorCriticMarkup) return;
    const view = sectionViewRef.current;
    if (!view) return;
    const clickPos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (clickPos == null) return;

    const markupItems = getContextMenuItems(view, clickPos);
    const items: ContextMenuItem[] = [...markupItems];
    if (onRequestAddComment) {
      items.push({
        label: 'Add Comment',
        shortcut: 'Ctrl+Shift+M',
        action: () => {
          // Move the cursor to the right-clicked position so the new comment
          // anchors there, then push the absolute position up to the
          // sidebar (synchronously — relying on focus/keyup events would miss
          // a programmatic dispatch).
          view.dispatch({ selection: { anchor: clickPos } });
          view.focus();
          onCommentInsertPosChange?.(editRange.from + clickPos);
          onRequestAddComment();
        },
      });
    }

    if (items.length === 0) return;

    e.preventDefault();
    setContextMenu({ items, position: { x: e.clientX, y: e.clientY } });
  };

  // Bubble the active editor's absolute cursor position to the parent so the
  // comments sidebar knows where "+ Add Comment" should insert. Listens to the
  // CodeMirror view's update events; tears down when the editor closes.
  useEffect(() => {
    if (!onCommentInsertPosChange) return;

    if (!isEditing) {
      onCommentInsertPosChange(null);
      return;
    }

    // Wait one frame for useSectionEditor's mount to land, then attach a
    // selection-change listener.
    let cancelled = false;
    const tick = requestAnimationFrame(() => {
      if (cancelled) return;
      const view = sectionViewRef.current;
      if (!view) {
        onCommentInsertPosChange(editRange.from);
        return;
      }

      const reportPos = () => {
        const head = view.state.selection.main.head;
        onCommentInsertPosChange(editRange.from + head);
      };
      reportPos();

      const dom = view.dom;
      const onSelect = () => reportPos();
      dom.addEventListener('keyup', onSelect);
      dom.addEventListener('mouseup', onSelect);
      dom.addEventListener('focus', onSelect, true);

      // Stash teardown on a sentinel so the cleanup below can reach it.
      (dom as HTMLElement & { __cmCleanup?: () => void }).__cmCleanup = () => {
        dom.removeEventListener('keyup', onSelect);
        dom.removeEventListener('mouseup', onSelect);
        dom.removeEventListener('focus', onSelect, true);
      };
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(tick);
      const view = sectionViewRef.current;
      const dom = view?.dom as (HTMLElement & { __cmCleanup?: () => void }) | undefined;
      dom?.__cmCleanup?.();
      onCommentInsertPosChange(null);
      // Close any lingering context menu when the editor unmounts.
      setContextMenu(null);
    };
  }, [isEditing, editRange.from, onCommentInsertPosChange, sectionViewRef]);

  const docId = scope?.docId ?? null;

  // Connect to doc when scope changes
  useEffect(() => {
    if (!docId) return;

    let cancelled = false;

    async function connect() {
      const { doc } = await getOrConnect(docId!);
      if (cancelled) return;

      const ytext = doc.getText('contents');
      ytextRef.current = ytext;

      const update = () => {
        const text = ytext.toString();
        setDocText(text);
        const parsed = parseSections(text);
        setSections(parsed);

        const fmSection = parsed.find(s => s.type === 'frontmatter');
        if (fmSection) {
          setFrontmatter(parseFrontmatterFields(fmSection.content));
        }
      };

      setSynced(true);
      update();
      ytext.observe(update);
      onYTextChange?.(ytext);

      return () => {
        ytext.unobserve(update);
      };
    }

    setSynced(false);
    setSections([]);
    setDocText('');
    setEditingIndex(null);
    setEditingFmField(null);
    onYTextChange?.(null);
    const cleanupPromise = connect();
    return () => {
      cancelled = true;
      onYTextChange?.(null);
      cleanupPromise.then(cleanup => cleanup?.());
    };
  }, [docId, getOrConnect]); // eslint-disable-line react-hooks/exhaustive-deps

  // Report the active section view (and its Y.Text slice range) to the parent.
  // The parent uses this to build a SectionViewEntry list for CommentsLayer's
  // multi-view anchor resolver. We report after every editKey change (which is
  // when useSectionEditor mounts/unmounts a view) and whenever the edit range
  // shifts. We use a rAF so the viewRef has been populated by useSectionEditor
  // before we read it.
  useEffect(() => {
    if (!onSectionViewChange) return;
    if (!isEditing) {
      onSectionViewChange(null);
      return;
    }
    const tick = requestAnimationFrame(() => {
      const view = sectionViewRef.current;
      if (!view) {
        onSectionViewChange(null);
        return;
      }
      onSectionViewChange({
        view,
        yTextFrom: editRange.from,
        yTextTo: editRange.from + view.state.doc.length,
      });
    });
    return () => {
      cancelAnimationFrame(tick);
      onSectionViewChange(null);
    };
    // editKey drives remounts; editRange.from shifts the slice offset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, editKey, editRange.from, onSectionViewChange]);

  // Scroll-spy: watch comment markers in the content scroll container and
  // report a single "active" one upward. The sidebar uses this to follow
  // along as the user reads.
  //
  // Active-comment selection is *direction-aware* — this is the rule that
  // matches the way readers actually navigate prose:
  //   - Scrolling down  → `max(absoluteFrom)` of visible markers
  //                       (the deepest comment you've reached)
  //   - Scrolling up    → `min(absoluteFrom)` of visible markers
  //                       (earlier comments coming back into view)
  //   - Idle / just     → `min(absoluteFrom)` of visible markers
  //     opened a lens     (first comment of the new section, after a 200ms
  //                       no-scroll period or when new comment elements
  //                       just appeared via a lens switch).
  //
  // We also proactively reap ghost entries from the observed set: when
  // React re-renders the prose, old span DOM nodes are detached but
  // IntersectionObserver never fires a "leave" callback for them. Without
  // cleanup they'd haunt `observed` forever, anchoring the active to a
  // stale render's positions.
  //
  // Markers are any element carrying `data-comment-from` — both rendered
  // prose pills (CriticMarkupSpan) and active CodeMirror badges. The value
  // is always absolute (the CM badge widget runs offsets through
  // commentOffsetTranslator before stamping the attribute).
  useEffect(() => {
    const root = scrollRootRef?.current;
    if (!root || !onVisibleCommentChange || !criticMarkupEnabled) return;

    const observed = new Map<Element, number>();
    let lastReported: number | null = null;
    let direction: 'up' | 'down' | 'none' = 'none';
    let prevScrollTop = root.scrollTop;
    let stableTimeout: number | null = null;

    const resolveAbsoluteFrom = (el: Element): number | null => {
      const v = (el as HTMLElement).dataset.commentFrom;
      if (v == null || v === '') return null;
      const n = parseInt(v, 10);
      return isNaN(n) ? null : n;
    };

    const cleanGhosts = () => {
      for (const el of Array.from(observed.keys())) {
        if (!root.contains(el)) observed.delete(el);
      }
    };

    const pickActive = (): number | null => {
      if (observed.size === 0) return null;
      let result: number | null = null;
      for (const v of observed.values()) {
        if (result === null) { result = v; continue; }
        if (direction === 'down') {
          if (v > result) result = v;
        } else {
          if (v < result) result = v;
        }
      }
      return result;
    };

    const report = () => {
      cleanGhosts();
      const next = pickActive();
      if (next !== lastReported) {
        lastReported = next;
        onVisibleCommentChange(next);
      }
    };

    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const abs = resolveAbsoluteFrom(entry.target);
            if (abs != null) observed.set(entry.target, abs);
          } else {
            observed.delete(entry.target);
          }
        }
        report();
      },
      { root, threshold: 0 }
    );

    const seen = new WeakSet<Element>();
    const scan = () => {
      cleanGhosts();
      const els = root.querySelectorAll<HTMLElement>('[data-comment-from]');
      els.forEach((el) => {
        if (seen.has(el) && root.contains(el)) return;
        seen.add(el);
        intersectionObserver.observe(el);
      });
      report();
    };

    scan();

    const isMarkerNode = (el: Element): boolean =>
      el.matches?.('[data-comment-from]') === true ||
      el.querySelector?.('[data-comment-from]') !== null;

    const mutationObserver = new MutationObserver((records) => {
      // When new comment markers appear (lens switch, section editor opening,
      // doc swap) reset direction to 'none' so the next pick uses `min` —
      // the user just navigated, they haven't started scrolling the new view
      // yet, so they expect to see the first comment of the new content.
      let sawNewMarker = false;
      outer: for (const r of records) {
        for (const node of r.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (isMarkerNode(node as Element)) { sawNewMarker = true; break outer; }
        }
      }
      if (sawNewMarker) direction = 'none';
      scan();
    });
    mutationObserver.observe(root, { childList: true, subtree: true });

    const onScroll = () => {
      const now = root.scrollTop;
      if (now > prevScrollTop) direction = 'down';
      else if (now < prevScrollTop) direction = 'up';
      prevScrollTop = now;

      // After 200ms of no scroll, drop back to the idle rule so that if the
      // user lands on a long block of prose without scrolling further, the
      // active doesn't stay "pinned to deepest reached."
      if (stableTimeout != null) window.clearTimeout(stableTimeout);
      stableTimeout = window.setTimeout(() => {
        direction = 'none';
        report();
      }, 200);

      report();
    };

    root.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      intersectionObserver.disconnect();
      mutationObserver.disconnect();
      root.removeEventListener('scroll', onScroll);
      if (stableTimeout != null) window.clearTimeout(stableTimeout);
      observed.clear();
    };
  }, [scrollRootRef, onVisibleCommentChange, criticMarkupEnabled, editRange.from, docId]);

  // Null scope: show placeholder
  if (!scope) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center gap-3 py-24">
        <div className="text-2xl font-semibold text-gray-400">Pick a lens</div>
        <div className="text-sm text-gray-400">Select a lens from the list on the left to get started.</div>
      </div>
    );
  }

  if (!synced) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400 text-sm">
        Loading lens...
      </div>
    );
  }

  // Derive lensPath and lensUuid for article/video source resolution
  const lensUuid = scope.docId.slice(RELAY_ID.length + 1);
  const lensPath = Object.entries(metadata).find(([, m]) => m.id === lensUuid)?.[0] ?? '';

  const tldr = frontmatter.get('tldr');

  // Derive platform URL for the published lensacademy.org link. Prefer the
  // module page (course-scoped when possible) anchored to the selected lens —
  // standalone /lens/... URLs get redirected by the platform to the bare
  // /module/... page, losing course context.
  const platformUrl = (() => {
    if (moduleSlug) {
      return getModulePlatformUrl(moduleSlug, { courseSlug, lensTitle: scope.docName });
    }
    const folderName = lensPath ? getFolderNameFromPath(lensPath, folderNames) : null;
    const originalPath = lensPath && folderName ? getOriginalPath(lensPath, folderName) : null;
    return originalPath ? getPlatformUrl(originalPath) : null;
  })();

  let visibleFrom = 0;
  let visibleTo = sections.length;
  if (scope.kind === 'subtree' && sections.length > scope.rootSectionIndex) {
    const [rangeFrom, rangeTo] = getSubtreeRange(sections, scope.rootSectionIndex);
    visibleFrom = rangeFrom + 1; // skip the root header itself — it's in the toolbar
    visibleTo = rangeTo;
  }

  return (
    <div>
      <div className="mb-6 text-[11px] text-gray-400 flex items-center gap-2">
        <span>
          {scope.docName}.md
          {scope.kind === 'subtree' && <span> &middot; {scope.breadcrumb}</span>}
        </span>
        <button
          onClick={() => openDocInNewTab(RELAY_ID, docUuidFromCompoundId(scope.docId), metadata)}
          className="text-[10px] text-blue-500 hover:text-blue-700 hover:underline"
        >
          Open in File Editor
        </button>
        {platformUrl && (
          <a
            href={platformUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-blue-500 hover:text-blue-700 hover:underline"
          >
            Show on Lensacademy.org
          </a>
        )}
      </div>

      {editingFmField === 'tldr' ? (
        <div className="mb-4 rounded-lg border-2 border-blue-400 bg-white overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 bg-blue-50 border-b border-blue-200">
            <span className="font-medium text-sm text-blue-700">User-facing TL;DR</span>
            <button onClick={() => setEditingFmField(null)}
              className="text-xs px-2 py-1 bg-blue-100 hover:bg-blue-200 text-blue-600 rounded">
              Done
            </button>
          </div>
          <div ref={mountRef} style={{ minHeight: '40px' }} />
        </div>
      ) : tldr ? (
        <div className="mb-4 p-3 bg-white rounded-lg border border-[#e8e5df] text-[13px] text-gray-500 leading-relaxed relative group cursor-pointer hover:outline hover:outline-2 hover:outline-blue-300/30 hover:outline-offset-1"
          onClick={() => { setEditingIndex(null); setEditingFmField('tldr'); }}>
          <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded font-medium opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            click to edit
          </div>
          <strong className="text-[#b87018]">User-facing TL;DR:</strong> {tldr}
        </div>
      ) : null}

      {editingFmField === 'summary_for_tutor' ? (
        <div className="mb-6 rounded-lg border-2 border-blue-400 bg-white overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 bg-blue-50 border-b border-blue-200">
            <span className="font-medium text-sm text-blue-700">AI-facing summary</span>
            <button onClick={() => setEditingFmField(null)}
              className="text-xs px-2 py-1 bg-blue-100 hover:bg-blue-200 text-blue-600 rounded">
              Done
            </button>
          </div>
          <div ref={mountRef} style={{ minHeight: '40px' }} />
        </div>
      ) : frontmatter.get('summary_for_tutor') ? (
        <div className="mb-6 p-3 bg-white rounded-lg border border-[#e8e5df] text-[13px] text-gray-500 leading-relaxed relative group cursor-pointer hover:outline hover:outline-2 hover:outline-blue-300/30 hover:outline-offset-1"
          onClick={() => { setEditingIndex(null); setEditingFmField('summary_for_tutor'); }}>
          <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded font-medium opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            click to edit
          </div>
          <strong className="text-[#6a2d9b]">AI-facing summary:</strong> {frontmatter.get('summary_for_tutor')}
        </div>
      ) : null}

      {sections
        .map((section, i) => ({ section, i }))
        .filter(({ i }) => i >= visibleFrom && i < visibleTo)
        .flatMap(({ section, i }): ReactNode[] => {
        const sectionEl = ((): ReactNode => {
        if (section.type === 'frontmatter') return null;

        const fields = parseFields(section.content);

        // Editing state — show CM editor
        if (editingIndex === i) {
          return (
            <div key={i} className="mb-7 rounded-lg border-2 border-blue-400 bg-white overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2 bg-blue-50 border-b border-blue-200">
                <span className="font-medium text-sm text-blue-700">{section.label}</span>
                <button onClick={() => setEditingIndex(null)}
                  className="text-xs px-2 py-1 bg-blue-100 hover:bg-blue-200 text-blue-600 rounded">
                  Done
                </button>
              </div>
              <div
                ref={mountRef}
                onContextMenu={handleSectionContextMenu}
                style={{ minHeight: '60px' }}
              />
            </div>
          );
        }

        // Text section
        if (section.type === 'text') {
          const content = fields.get('content') ?? '';
          // Compute the absolute Y.Text offset of the content field so we
          // can slice the global badge map into local positions inside
          // `content`. Each badge entry carries its own absoluteFrom so the
          // inline span can call onClickCriticRange with absolute positions
          // directly — no fragile arithmetic in the bubble path, which is
          // important because parseFields may shift positions vs. the source.
          const [contentAbsFrom] = getFieldValueRange(section.content, section.from, 'content');
          const localBadgeMap = criticMarkupEnabled
            ? sliceCommentBadgeMap(globalBadgeMap, contentAbsFrom, content.length)
            : undefined;
          return (
            <TextRenderer
              key={i}
              content={content}
              onStartEdit={() => startEditingSection(i)}
              enableCriticMarkup={criticMarkupEnabled}
              onClickCriticRange={onClickCriticRange}
              onCommentClick={onCommentClick}
              commentBadgeMap={localBadgeMap}
            />
          );
        }

        // Chat section
        if (section.type === 'chat') {
          const instructions = fields.get('instructions') ?? '';
          const [instructionsAbsFrom] = getFieldValueRange(section.content, section.from, 'instructions');
          const instructionsBadgeMap = criticMarkupEnabled
            ? sliceCommentBadgeMap(globalBadgeMap, instructionsAbsFrom, instructions.length)
            : undefined;
          return (
            <ChatRenderer
              key={i}
              title={section.label}
              instructions={instructions}
              onStartEdit={() => startEditingSection(i)}
              enableCriticMarkup={criticMarkupEnabled}
              onClickCriticRange={onClickCriticRange}
              onCommentClick={onCommentClick}
              commentBadgeMap={instructionsBadgeMap}
            />
          );
        }

        // Article segment — source inherits from previous article segment
        if (section.type === 'article') {
          let articleSource = fields.get('source')?.trim();
          const from = fields.get('from') ?? undefined;
          const to = fields.get('to') ?? undefined;

          if (!articleSource) {
            for (let j = i - 1; j >= 0; j--) {
              if (sections[j].type === 'article') {
                const prevFields = parseFields(sections[j].content);
                const src = prevFields.get('source')?.trim();
                if (src) {
                  articleSource = src;
                  break;
                }
              }
            }
          }

          if (!articleSource) {
            return (
              <div key={i} className="mb-7 p-4 bg-amber-50 rounded-lg border border-amber-200 text-sm text-amber-700">
                Article segment missing source:: field (no preceding article to inherit from)
              </div>
            );
          }

          return (
            <ArticleRenderer
              key={i}
              fromAnchor={from}
              toAnchor={to}
              articleSourceWikilink={articleSource}
              lensSourcePath={lensPath}
            />
          );
        }

        // Video segment — source inherits from previous video segment
        if (section.type === 'video') {
          let videoSource = fields.get('source')?.trim();
          const from = fields.get('from') ?? undefined;
          const to = fields.get('to') ?? undefined;

          if (!videoSource) {
            for (let j = i - 1; j >= 0; j--) {
              if (sections[j].type === 'video') {
                const prevFields = parseFields(sections[j].content);
                const src = prevFields.get('source')?.trim();
                if (src) {
                  videoSource = src;
                  break;
                }
              }
            }
          }

          if (!videoSource) {
            return (
              <div key={i} className="mb-7 p-4 bg-amber-50 rounded-lg border border-amber-200 text-sm text-amber-700">
                Video segment missing source:: field (no preceding video to inherit from)
              </div>
            );
          }

          return (
            <VideoRenderer
              key={i}
              fromTime={from}
              toTime={to}
              videoSourceWikilink={videoSource}
              lensSourcePath={lensPath}
            />
          );
        }

        // Question section
        if (section.type === 'question') {
          const content = fields.get('content') ?? '';
          const assessmentInstructions = fields.get('assessment-instructions');
          const enforceVoice = fields.get('enforce-voice');
          const maxChars = fields.get('max-chars');
          // Per-field badge maps: the question section's content and
          // assessment-instructions live at different absolute Y.Text
          // offsets within the same section, so we slice the global map
          // twice.
          const [questionContentAbsFrom] = getFieldValueRange(section.content, section.from, 'content');
          const contentBadgeMap = criticMarkupEnabled
            ? sliceCommentBadgeMap(globalBadgeMap, questionContentAbsFrom, content.length)
            : undefined;
          const assessmentBadgeMap = criticMarkupEnabled && assessmentInstructions
            ? (() => {
                const [absFrom] = getFieldValueRange(section.content, section.from, 'assessment-instructions');
                return sliceCommentBadgeMap(globalBadgeMap, absFrom, assessmentInstructions.length);
              })()
            : undefined;
          return (
            <QuestionRenderer
              key={i}
              content={content}
              assessmentInstructions={assessmentInstructions}
              enforceVoice={enforceVoice}
              maxChars={maxChars}
              onStartEdit={() => startEditingSection(i)}
              enableCriticMarkup={criticMarkupEnabled}
              onClickCriticRange={onClickCriticRange}
              onCommentClick={onCommentClick}
              contentBadgeMap={contentBadgeMap}
              assessmentBadgeMap={assessmentBadgeMap}
            />
          );
        }

        // Page header
        if (section.type === 'page') {
          return (
            <HeadingRenderer
              key={i}
              label={section.label}
              fontSize={22}
              onStartEdit={() => startEditingSection(i)}
            />
          );
        }

        // Article/video reference heading and generic heading. Only the
        // generic 'heading' type takes criticmarkup styling — ref labels
        // come from another doc's title and aren't user-edited prose.
        if (section.type === 'article-ref' || section.type === 'video-ref' || section.type === 'heading') {
          const isPlainHeading = section.type === 'heading';
          return (
            <HeadingRenderer
              key={i}
              label={section.label}
              onStartEdit={() => startEditingSection(i)}
              enableCriticMarkup={criticMarkupEnabled && isPlainHeading}
              onClickCriticRange={isPlainHeading ? onClickCriticRange : undefined}
              onCommentClick={isPlainHeading ? onCommentClick : undefined}
            />
          );
        }

        return null;
        })();

        if (sectionEl == null) return [];
        const orphans = orphansBySection.get(i) ?? [];
        if (orphans.length === 0) return [sectionEl];
        const anchorEntries = orphans.map((absFrom) => ({
          absFrom,
          badgeNumber: globalBadgeMap.get(absFrom)?.badgeNumber,
        }));
        return [
          <OrphanCommentAnchors
            key={`anchors-${i}`}
            anchors={anchorEntries}
            onCommentClick={onCommentClick}
          />,
          sectionEl,
        ];
      })}
      {contextMenu && (
        <ContextMenu
          items={contextMenu.items}
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
