import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
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
import { EduCommentsSidebar } from './EduCommentsSidebar';
import type { CriticMarkupRange } from '../../lib/criticmarkup-parser';
import { setCurrentAuthor } from '../Editor/extensions/criticmarkup';

const SUGGESTION_MODE_KEY = 'edu-editor:suggestion-mode';
const SIDEBAR_OPEN_KEY = 'edu-editor:comments-sidebar-open';

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

  // Suggestion-mode and comments-sidebar state, persisted across refreshes.
  const [isSuggestionMode, setIsSuggestionMode] = useState(() =>
    readBoolFromLocalStorage(SUGGESTION_MODE_KEY, false)
  );
  const [commentsSidebarOpen, setCommentsSidebarOpen] = useState(() =>
    readBoolFromLocalStorage(SIDEBAR_OPEN_KEY, false)
  );
  const [commentInsertPos, setCommentInsertPos] = useState<number | null>(null);
  const [focusedRangeFrom, setFocusedRangeFrom] = useState<number | null>(null);
  // Increment to ask the sidebar to open its add-comment form. Bumped by
  // the Mod-Shift-m shortcut and the right-click "Add Comment" item.
  const [addCommentTrigger, setAddCommentTrigger] = useState(0);
  // Absolute Y.Text position of the topmost comment marker currently visible
  // in the main content scroll area. Updated by ContentPanel via the
  // IntersectionObserver-backed scroll-spy. Drives a gentle sidebar
  // auto-scroll (block: 'nearest') so reviewers can scroll the page and
  // have the sidebar follow without losing their current focus.
  const [visibleCommentFrom, setVisibleCommentFrom] = useState<number | null>(null);
  // Ref to the main content scroll container; ContentPanel needs it as the
  // IntersectionObserver's root.
  const contentScrollRef = useRef<HTMLDivElement | null>(null);

  const handleSuggestionModeChange = useCallback((next: boolean) => {
    setIsSuggestionMode(next);
    writeBoolToLocalStorage(SUGGESTION_MODE_KEY, next);
  }, []);

  const handleSidebarToggle = useCallback(() => {
    setCommentsSidebarOpen(prev => {
      const next = !prev;
      writeBoolToLocalStorage(SIDEBAR_OPEN_KEY, next);
      return next;
    });
  }, []);

  const commentsControl = useMemo(() => ({
    isOpen: commentsSidebarOpen,
    onToggle: handleSidebarToggle,
    title: commentsSidebarOpen ? 'Hide comments' : 'Show comments',
  }), [commentsSidebarOpen, handleSidebarToggle]);

  useHeaderCommentsControl(commentsControl);

  const handleClickCriticRange = useCallback((range: CriticMarkupRange) => {
    if (range.type !== 'comment') return;
    if (!commentsSidebarOpen) {
      setCommentsSidebarOpen(true);
      writeBoolToLocalStorage(SIDEBAR_OPEN_KEY, true);
    }
    setFocusedRangeFrom(range.from);
  }, [commentsSidebarOpen]);

  // The Mod-Shift-m shortcut and the right-click "Add Comment" menu both
  // route here. We open the sidebar (if closed) and bump the trigger so the
  // sidebar shows its add-comment form. The sidebar itself reads the current
  // `commentInsertPos` (which ContentPanel keeps in sync with the active
  // section editor's cursor).
  const handleRequestAddComment = useCallback(() => {
    if (!commentsSidebarOpen) {
      setCommentsSidebarOpen(true);
      writeBoolToLocalStorage(SIDEBAR_OPEN_KEY, true);
    }
    setAddCommentTrigger(t => t + 1);
  }, [commentsSidebarOpen]);

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

  const activeDocId = scope?.docId ?? null;
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

        <div
          ref={contentScrollRef}
          className="flex-1 overflow-y-auto"
          style={{ background: '#faf8f3' }}
        >
          <div className="max-w-[720px] mx-auto py-8 px-10 h-full">
            <ContentPanel
              scope={scope}
              criticMarkupEnabled={criticMarkupEnabled}
              suggestionMode={isSuggestionMode}
              onCommentInsertPosChange={setCommentInsertPos}
              onClickCriticRange={handleClickCriticRange}
              onRequestAddComment={handleRequestAddComment}
              scrollRootRef={contentScrollRef}
              onVisibleCommentChange={setVisibleCommentFrom}
            />
          </div>
        </div>

        {/* Always rendered so width can transition. When closed: zero width
            and the inner panel is translated off-screen, so the layout
            collapses smoothly without remounting the sidebar (which would
            re-fetch the doc and lose UI state every toggle). */}
        <div
          className={`shrink-0 overflow-hidden border-gray-200 bg-white transition-[width,border-left-width] duration-200 ease-in-out ${
            commentsSidebarOpen ? 'w-[320px] border-l' : 'w-0 border-l-0'
          }`}
          aria-hidden={!commentsSidebarOpen}
        >
          <div
            className={`w-[320px] h-full flex flex-col transition-transform duration-200 ease-in-out ${
              commentsSidebarOpen ? 'translate-x-0' : 'translate-x-full'
            }`}
          >
            <EduCommentsSidebar
              docId={activeDocId}
              focusedRangeFrom={focusedRangeFrom}
              insertAtPos={commentInsertPos}
              addCommentTrigger={addCommentTrigger}
              visibleCommentFrom={visibleCommentFrom}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
