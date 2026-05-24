import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import * as Y from 'yjs';
import { useDocConnection } from '../../hooks/useDocConnection';
import { useNavigation } from '../../contexts/NavigationContext';
import { useAuth } from '../../contexts/AuthContext';
import { useDisplayName } from '../../contexts/DisplayNameContext';
import { useHeaderCommentsControl } from '../../contexts/HeaderActionsContext';
import { useSidebar } from '../../contexts/SidebarContext';
import { parseSections } from '../SectionEditor/parseSections';
import type { Section } from '../SectionEditor/parseSections';
import { ModuleTreeEditor } from './ModuleTreeEditor';
import { ContentPanel, type ContentScope } from './ContentPanel';
import { CourseOverview } from './CourseOverview';
import { RELAY_ID } from '../../lib/constants';
import { SuggestionModeControl } from '../SuggestionModeToggle/SuggestionModeControl';
import { OverflowMenu } from '../OverflowMenu';
import { CommentsLayer, type CommentsLayerHandle } from '../Comments/CommentsLayer';
import type { CriticMarkupRange } from '../../lib/criticmarkup-parser';
import { useThreadsFromYText } from '../Comments/criticmarkupAdapter';
import { useScrollSource } from '../Comments/useScrollSource';
import { setCurrentAuthor } from '../Editor/extensions/criticmarkup';
import { resolveAnchorYFromSectionViews, resolveAnchorYFromDOM } from '../../lib/anchor-resolver';
import type { SectionViewEntry } from '../../lib/anchor-resolver';

const SUGGESTION_MODE_KEY = 'edu-editor:suggestion-mode';
const COMMENTS_VISIBLE_KEY = 'edu-editor:comments-visible';

function readBoolFromLocalStorage(key: string, defaultValue: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return defaultValue;
    return raw === 'true';
  } catch {
    return defaultValue;
  }
}

function writeBoolToLocalStorage(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // localStorage unavailable (private mode etc.) — silent fallback.
  }
}

interface EduEditorProps {
  moduleDocId: string;
  sourcePath?: string;
}

export function EduEditor({ moduleDocId, sourcePath }: EduEditorProps) {
  const { getOrConnect, disconnectAll } = useDocConnection();
  const { metadata } = useNavigation();
  const { canWrite } = useAuth();
  const { displayName } = useDisplayName();
  const { headerStage } = useSidebar();

  // Comment authorship — the markdown editor's AwarenessInitializer sets
  // currentAuthor from the displayName, but it only mounts inside the
  // /:docUuid/* route. EduEditor lives in a different route, so we have to
  // wire the same setter ourselves; otherwise comments authored here are
  // attributed to the default 'anonymous'.
  useEffect(() => {
    if (displayName) {
      setCurrentAuthor(displayName);
    }
  }, [displayName]);
  const [docSections, setDocSections] = useState<Section[]>([]);
  const [synced, setSynced] = useState(false);
  const [scope, setScope] = useState<ContentScope | null>(null);

  // Selected module state (course mode only)
  const [selectedModuleDocId, setSelectedModuleDocId] = useState<string | null>(null);
  const [selectedModuleName, setSelectedModuleName] = useState('');
  const [selectedModuleSections, setSelectedModuleSections] = useState<Section[]>([]);
  const [selectedModuleSynced, setSelectedModuleSynced] = useState(false);

  // Suggestion-mode and comments-layer visibility, persisted across refreshes.
  const [isSuggestionMode, setIsSuggestionMode] = useState(() =>
    readBoolFromLocalStorage(SUGGESTION_MODE_KEY, false)
  );
  const [commentsVisible, setCommentsVisible] = useState(() =>
    readBoolFromLocalStorage(COMMENTS_VISIBLE_KEY, false)
  );
  // Ref to the main content scroll container; ContentPanel needs it as the
  // IntersectionObserver's root.
  const contentScrollRef = useRef<HTMLDivElement | null>(null);
  // The content panel's wrapper div — CommentsLayer uses it as editorRootRef
  // to toggle [data-comment-focused] on markers inside it.
  const contentPanelWrapperRef = useRef<HTMLDivElement | null>(null);

  // Active Y.Text for the currently selected doc (set by ContentPanel via
  // onYTextChange callback).
  const [activeYText, setActiveYText] = useState<Y.Text | null>(null);

  // Stable fallback Y.Text so hooks can be called unconditionally.
  const fallbackYText = useMemo(() => new Y.Doc().getText('contents'), []);
  const effectiveYText = activeYText ?? fallbackYText;

  // Thread data and mutation callbacks from the criticmarkup adapter.
  const { threads, callbacks } = useThreadsFromYText(effectiveYText, displayName ?? '');

  // ScrollSource wrapping the content scroll container.
  const scrollSource = useScrollSource(contentScrollRef);

  // Currently mounted section editor view. ContentPanel reports it via
  // onSectionViewChange so CommentsLayer can resolve comment anchor positions
  // using the multi-view resolver.
  const sectionViewsRef = useRef<SectionViewEntry[]>([]);

  const handleSuggestionModeChange = useCallback((next: boolean) => {
    setIsSuggestionMode(next);
    writeBoolToLocalStorage(SUGGESTION_MODE_KEY, next);
  }, []);

  const handleCommentsToggle = useCallback(() => {
    setCommentsVisible(prev => {
      const next = !prev;
      writeBoolToLocalStorage(COMMENTS_VISIBLE_KEY, next);
      return next;
    });
  }, []);

  const commentsControl = useMemo(() => ({
    isOpen: commentsVisible,
    onToggle: handleCommentsToggle,
    title: commentsVisible ? 'Hide comments' : 'Show comments',
  }), [commentsVisible, handleCommentsToggle]);

  useHeaderCommentsControl(commentsControl);

  const ensureCommentsVisible = useCallback(() => {
    if (!commentsVisible) {
      setCommentsVisible(true);
      writeBoolToLocalStorage(COMMENTS_VISIBLE_KEY, true);
    }
  }, [commentsVisible]);

  const handleClickCriticRange = useCallback((range: CriticMarkupRange) => {
    if (range.type !== 'comment') return;
    ensureCommentsVisible();
  }, [ensureCommentsVisible]);

  const commentsLayerRef = useRef<CommentsLayerHandle | null>(null);

  // Absolute insertion position pushed up by the active section editor via
  // ContentPanel's onCommentInsertPosChange. Tracked in a ref so reading it
  // from getInsertCursorPos doesn't require re-rendering on every cursor move.
  const commentInsertPosRef = useRef<number | null>(null);
  const handleCommentInsertPosChange = useCallback((pos: number | null) => {
    commentInsertPosRef.current = pos;
  }, []);

  // openAddForm runs only after the sidebar is visible AND the CommentsLayer
  // ref is attached. handleRequestAddComment may run while the sidebar is
  // still hidden (first render after ensureCommentsVisible flips state), so
  // we defer to an effect.
  const [pendingOpenAddForm, setPendingOpenAddForm] = useState(false);
  const handleRequestAddComment = useCallback(() => {
    ensureCommentsVisible();
    setPendingOpenAddForm(true);
  }, [ensureCommentsVisible]);
  useEffect(() => {
    if (!pendingOpenAddForm) return;
    if (!commentsLayerRef.current) return;
    commentsLayerRef.current.openAddForm();
    setPendingOpenAddForm(false);
  }, [pendingOpenAddForm, commentsVisible, activeYText]);

  const handleCommentClick = useCallback((absFrom: number) => {
    ensureCommentsVisible();
    commentsLayerRef.current?.focusThread(String(absFrom));
  }, [ensureCommentsVisible]);

  const handleYTextChange = useCallback((ytext: Y.Text | null) => {
    setActiveYText(ytext);
  }, []);

  const handleSectionViewChange = useCallback((entry: SectionViewEntry | null) => {
    sectionViewsRef.current = entry ? [entry] : [];
  }, []);

  // Try CM section views first (edit mode); fall back to DOM scanning for
  // read-mode sections where no CM view is mounted.
  const resolveAnchorYByOffset = useCallback((offset: number) => {
    const cm = resolveAnchorYFromSectionViews(sectionViewsRef.current, offset);
    if (cm != null) return cm;
    const root = contentPanelWrapperRef.current;
    return root ? resolveAnchorYFromDOM(root, offset) : null;
  }, []);

  // Adapter: convert ThreadKey (string) back to numeric offset for the resolver.
  const resolveAnchorY = useCallback((key: string) => resolveAnchorYByOffset(Number(key)), [resolveAnchorYByOffset]);

  const getViewportRect = useCallback(() => {
    const rect = contentScrollRef.current?.getBoundingClientRect();
    return rect ? { top: rect.top, height: rect.height } : { top: 0, height: 0 };
  }, []);

  const isCourseMode = docSections.some(s => s.type === 'module-ref');

  // Connect to the primary doc (course or module)
  useEffect(() => {
    let cancelled = false;

    async function connect() {
      const { doc } = await getOrConnect(moduleDocId);
      if (cancelled) return;

      const ytext = doc.getText('contents');
      const update = () => {
        setDocSections(parseSections(ytext.toString()));
      };

      setSynced(true);
      update();
      ytext.observe(update);

      return () => { ytext.unobserve(update); };
    }

    const cleanupPromise = connect();
    return () => {
      cancelled = true;
      cleanupPromise.then(cleanup => cleanup?.());
    };
  }, [moduleDocId, getOrConnect]);

  // Connect to selected module doc (course mode)
  useEffect(() => {
    if (!selectedModuleDocId) {
      setSelectedModuleSections([]);
      setSelectedModuleSynced(false);
      return;
    }

    let cancelled = false;

    async function connect() {
      const { doc } = await getOrConnect(selectedModuleDocId!);
      if (cancelled) return;

      const ytext = doc.getText('contents');
      const update = () => {
        setSelectedModuleSections(parseSections(ytext.toString()));
      };

      setSelectedModuleSynced(true);
      update();
      ytext.observe(update);

      return () => { ytext.unobserve(update); };
    }

    const cleanupPromise = connect();
    return () => {
      cancelled = true;
      cleanupPromise.then(cleanup => cleanup?.());
    };
  }, [selectedModuleDocId, getOrConnect]);

  // Reset selection when top-level doc changes
  useEffect(() => {
    setSelectedModuleDocId(null);
    setSelectedModuleName('');
    setScope(null);
  }, [moduleDocId]);

  useEffect(() => disconnectAll, [disconnectAll]);

  const handleSelect = useCallback((next: ContentScope) => {
    setScope(next);
  }, []);

  const handleSelectModule = useCallback((docId: string, name: string) => {
    setSelectedModuleDocId(docId);
    setSelectedModuleName(name);
    setScope(null);
  }, []);

  // Derive module path for the selected module
  const selectedModuleUuid = selectedModuleDocId?.slice(RELAY_ID.length + 1);
  const selectedModulePath = selectedModuleUuid
    ? Object.entries(metadata).find(([, m]) => m.id === selectedModuleUuid)?.[0] ?? ''
    : '';

  const activeSelection =
    scope === null
      ? null
      : {
          docId: scope.docId,
          rootIndex: scope.kind === 'subtree' ? scope.rootSectionIndex : undefined,
        };

  if (!synced) {
    return (
      <div className="h-full flex items-center justify-center text-gray-400 text-sm">
        Connecting...
      </div>
    );
  }

  // Determine which sections/path/docId to pass to ModuleTreeEditor
  const moduleTreeSections = isCourseMode ? selectedModuleSections : docSections;
  const moduleTreePath = isCourseMode ? selectedModulePath : (sourcePath ?? '');
  const moduleTreeDocId = isCourseMode ? (selectedModuleDocId ?? undefined) : moduleDocId;

  // The criticmarkup feature is gated on the user being able to edit-or-suggest
  // (edit + suggest roles). View-only users can still see existing markup if
  // it's in the source, but the toggle is locked.
  // Enable for edit AND suggest roles — suggest users need the criticmarkup
  // extension so comments and inline `{++ ++}` / `{-- --}` suggestions render
  // as widgets, not raw markup. (Previously gated on canEdit which excluded
  // suggest-role entirely.)
  const criticMarkupEnabled = canWrite;

  const portalTarget = typeof document === 'undefined'
    ? null
    : document.getElementById('header-controls');

  return (
    <div className="h-full flex flex-col">
      {portalTarget && createPortal(
        headerStage === 'overflow' ? (
          <OverflowMenu>
            <SuggestionModeControl
              isSuggestionMode={isSuggestionMode}
              onChange={handleSuggestionModeChange}
              iconOnly
            />
          </OverflowMenu>
        ) : (
          <SuggestionModeControl
            isSuggestionMode={isSuggestionMode}
            onChange={handleSuggestionModeChange}
            iconOnly={headerStage !== 'full'}
          />
        ),
        portalTarget
      )}
      <div className="flex-1 flex overflow-hidden">
        <div className="w-[420px] min-w-[420px] border-r-2 border-gray-200 bg-[#fbfaf7] overflow-y-auto p-4">
          {isCourseMode ? (
            <>
              <div className="text-[11px] uppercase tracking-wider text-gray-500 font-semibold mb-3 pb-2 border-b border-gray-200">
                Course
              </div>
              <CourseOverview
                courseSections={docSections}
                coursePath={sourcePath ?? ''}
                metadata={metadata}
                selectedModuleDocId={selectedModuleDocId}
                onSelectModule={handleSelectModule}
              />
              {selectedModuleDocId && (
                <>
                  <div className="text-[11px] uppercase tracking-wider text-gray-500 font-semibold mt-4 mb-3 pt-3 pb-2 border-t border-b border-gray-200">
                    {selectedModuleName}
                  </div>
                  {selectedModuleSynced ? (
                    <ModuleTreeEditor
                      moduleSections={moduleTreeSections}
                      modulePath={moduleTreePath}
                      moduleDocId={moduleTreeDocId}
                      activeSelection={activeSelection}
                      onSelect={handleSelect}
                    />
                  ) : (
                    <div className="text-xs text-gray-400 italic py-2">Loading module...</div>
                  )}
                </>
              )}
            </>
          ) : (
            <>
              <div className="text-[11px] uppercase tracking-wider text-gray-500 font-semibold mb-3 pb-2 border-b border-gray-200">
                {sourcePath?.split('/').pop()?.replace(/\.md$/, '') ?? 'Module'}
              </div>
              <ModuleTreeEditor
                moduleSections={moduleTreeSections}
                modulePath={moduleTreePath}
                moduleDocId={moduleTreeDocId}
                activeSelection={activeSelection}
                onSelect={handleSelect}
              />
            </>
          )}
        </div>

        {/* Content + comments. Sub-flex so the comments column sits beside the
            content rather than overlaying it. The content scroll container
            owns vertical scrolling; CommentsLayer listens to its scroll events
            but lives in a sibling div so it doesn't cover the prose. */}
        <div className="flex-1 flex overflow-hidden">
          <div
            ref={contentScrollRef}
            className="flex-1 overflow-y-auto"
            style={{ background: '#faf8f3' }}
          >
            <div
              ref={contentPanelWrapperRef}
              className="max-w-[720px] mx-auto py-8 px-10 h-full"
            >
              <ContentPanel
                scope={scope}
                criticMarkupEnabled={criticMarkupEnabled}
                suggestionMode={isSuggestionMode}
                onClickCriticRange={handleClickCriticRange}
                onCommentClick={handleCommentClick}
                onRequestAddComment={handleRequestAddComment}
                onCommentInsertPosChange={handleCommentInsertPosChange}
                scrollRootRef={contentScrollRef}
                onYTextChange={handleYTextChange}
                onSectionViewChange={handleSectionViewChange}
              />
            </div>
          </div>

          {commentsVisible && activeYText && (
            <div
              className="w-[320px] shrink-0 relative border-l border-gray-200"
              style={{ background: '#faf8f3' }}
            >
              <CommentsLayer
                ref={commentsLayerRef}
                threads={threads}
                resolveAnchorY={resolveAnchorY}
                getViewportRect={getViewportRect}
                scrollSource={scrollSource}
                editorRootRef={contentPanelWrapperRef}
                currentUserName={displayName ?? ''}
                onReply={callbacks.onReply}
                onEdit={callbacks.onEdit}
                onDelete={callbacks.onDelete}
                onAddComment={callbacks.onAddComment}
                getInsertKey={() => commentInsertPosRef.current != null ? String(commentInsertPosRef.current) : null}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
