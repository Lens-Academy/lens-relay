import { Fragment, useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { EditorView } from '@codemirror/view';
import { EditorState, StateEffect } from '@codemirror/state';
import { useYDoc } from '../../lib/ydoc-provider';
import * as Y from 'yjs';
import { criticMarkupField, suggestionModeField } from '../Editor/extensions/criticmarkup';
import { sourceReadOnlyCompartment } from '../Editor/extensions/livePreview';
import { createLinkedDoc } from '../../lib/wikilink-create';
import { SourceSuggestionBanner } from '../SourceSuggestionBanner/SourceSuggestionBanner';
import { SyncedFileBanner } from '../SyncedFileBanner/SyncedFileBanner';
import { parseThreads } from '../../lib/criticmarkup-parser';
import { SyncStatus } from '../SyncStatus/SyncStatus';
import { Editor } from '../Editor/Editor';
import { DocumentTitle } from '../DocumentTitle';
import { SourceModeChip, SourceModeToggle } from '../SourceModeToggle/SourceModeToggle';
import { AuthorshipModeToggle } from '../AuthorshipModeToggle/AuthorshipModeToggle';
import { useAuthorshipSettings } from '../AuthorshipModeToggle/useAuthorshipSettings';
import { SpellcheckToggle } from '../SpellcheckToggle/SpellcheckToggle';
import { useSpellcheckSetting } from '../SpellcheckToggle/useSpellcheckSetting';
import { ListenButton } from '../ReadAloud/ListenButton';
import { ReadAloudBar } from '../ReadAloud/ReadAloudBar';
import { getReadAloud } from '../Editor/extensions/readAloud';
import { SuggestionModeToggle } from '../SuggestionModeToggle/SuggestionModeToggle';
import { PresencePanel } from '../PresencePanel/PresencePanel';
import { TableOfContents, PageOutline } from '../TableOfContents';
import { BacklinksPanel } from '../BacklinksPanel';
import { ConceptRowsPanel, panelHostField, setPanelHost } from '../ConceptRowsPanel';
import { JevCheckPanel } from '../JevCheckPanel/JevCheckPanel';
import { HistoryMenuItem, HistoryPanel } from '../HistoryPanel/HistoryPanel';
import { historyPath } from '../../lib/history-api';
import { isCheckPath } from '../../lib/jev-check';
import { matchRule } from '../../lib/concept-rows';
import { ConceptGraphPanel } from '../ConceptGraphPanel';
import { isConceptPath } from '../../lib/concept-graph';
import { PanelErrorBoundary } from '../PanelErrorBoundary';
import { ContentStatusPanel } from '../ContentStatus/ContentStatusPanel';
import { CommentsLayer, type CommentsLayerHandle } from '../Comments/CommentsLayer';
import { pinInsertKey, useThreadsFromYText } from '../Comments/criticmarkupAdapter';
import { commentTarget } from '../Comments/commentTarget';
import type { ThreadView } from '../Comments/types';
import { useScrollSource } from '../Comments/useScrollSource';
import { DebugYMapPanel } from '../DebugYMapPanel';
import { PanelDebugOverlay } from '../PanelDebugOverlay';
import { ConnectedDiscussionPanel } from '../DiscussionPanel';
import { PromotionStatus } from '../Promotion/PromotionStatus';
import { PromoteFileDialog } from '../Promotion/PromoteFileDialog';
import { WorkflowMenu } from '../WorkflowMenu';
import { ResizeHandle } from './ResizeHandle';
import { useHasDiscussion } from '../DiscussionPanel/useHasDiscussion';
import { useNavigation } from '../../contexts/NavigationContext';
import { useAuth } from '../../contexts/AuthContext';
import { useSidebar } from '../../contexts/SidebarContext';
import { useMobile } from '../../contexts/MobileContext';
import { MobileDrawer } from '../Mobile/MobileDrawer';
import { MobileCommentsSheet, type PendingCommentAction } from '../Mobile/MobileCommentsSheet';
import { MobileEditToolbar } from '../Mobile/MobileEditToolbar';
import { useDisplayName } from '../../contexts/DisplayNameContext';
import { persistentHighlightLine } from '../Editor/extensions/headingFlash';
import { revealFrontmatterPos } from '../Editor/extensions/frontmatter';
import { utf8ByteToUtf16Offset } from '../../lib/text-offsets';
import { resolveAnchorYFromView, resolveAnchorYFromDOM } from '../../lib/anchor-resolver';
import { findPathByUuid } from '../../lib/uuid-to-path';
import { pathToSegments } from '../../lib/path-display';
import { getPromotionStatus, type PromotionStatusResponse } from '../../lib/promotion-api';
import { editorPathToPromotionPath } from '../../lib/promotion-paths';
import { RELAY_ID, PANEL_CONFIG } from '../../App';
import { EDU_FOLDER_ID } from '../../lib/constants';

const PROMOTION_STATUS_REFRESH_MS = 10_000;
const SUGGESTION_MODE_KEY = 'lens-editor:suggestion-mode';

/**
 * Move the cursor to `pos`, scroll it into view, and flash its line — the
 * shared landing behavior for URL navigation targets (#L{n} and ?pos={offset}).
 * A position inside collapsed frontmatter first expands it, otherwise the
 * target would stay hidden behind the properties bar.
 */
function jumpToPos(view: EditorView, pos: number): void {
  revealFrontmatterPos(view, pos);
  const line = view.state.doc.lineAt(pos);
  view.dispatch({
    selection: { anchor: pos },
    effects: [
      EditorView.scrollIntoView(pos, { y: 'center' }),
      persistentHighlightLine.of(line.from),
    ],
  });
}

function readSuggestionMode(): boolean {
  try {
    return localStorage.getItem(SUGGESTION_MODE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeSuggestionMode(value: boolean): void {
  try {
    localStorage.setItem(SUGGESTION_MODE_KEY, String(value));
  } catch {
    // Storage may be unavailable (for example, in private browsing mode).
  }
}

/**
 * Editor area component that lives INSIDE the RelayProvider key boundary.
 * This allows it to remount when switching documents while keeping
 * the Sidebar stable outside the boundary.
 */
export function EditorArea({ currentDocId }: { currentDocId: string }) {
  const navigate = useNavigate();
  const routerLocation = useLocation();
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const [stateVersion, setStateVersion] = useState(0);
  const { metadata, onNavigate, folderDocs, folderNames } = useNavigation();
  const { canWrite, canEdit, canPromote, folderUuid, isAllFolders } = useAuth();
  const { manager, headerStage } = useSidebar();
  const { isMobile, activeDrawer, openDrawer, closeDrawer, toggleDrawer, editorFocused, setEditorFocused, setDocPanelsAvailable, setDiscussionAvailable } = useMobile();

  // Tell the mobile nav bar its comments/outline drawers have a host
  useEffect(() => {
    setDocPanelsAvailable(true);
    return () => setDocPanelsAvailable(false);
  }, [setDocPanelsAvailable]);
  const [pendingCommentAction, setPendingCommentAction] = useState<PendingCommentAction>(null);
  // Bumped with every new pending action; keys the sheet so it remounts and
  // consumes the action in its state initializers.
  const commentSheetEpochRef = useRef(0);
  const { displayName } = useDisplayName();
  const hasDiscussion = useHasDiscussion();

  // Surface the discussion drawer in the mobile nav bar's overflow menu
  useEffect(() => {
    setDiscussionAvailable(hasDiscussion);
    return () => setDiscussionAvailable(false);
  }, [hasDiscussion, setDiscussionAvailable]);

  // Y.Text for the document content (same field name used by Editor.tsx)
  const ydoc = useYDoc();
  const yText: Y.Text = useMemo(() => ydoc.getText('contents'), [ydoc]);

  // Ref to the editor DOM for CommentsLayer's [data-comment-from] focus toggle.
  // Assigned during render (not in a useEffect) so children mounted on the
  // same commit see it populated — children's mount effects run before the
  // parent's. (The scroll container is consumed via `useScrollSource` with the
  // live element value, so it doesn't need a ref.)
  const editorRootRef = useRef<HTMLElement | null>(null);
  editorRootRef.current = editorView ? editorView.dom : null;

  // Stable callbacks for CommentsLayer
  const getViewportRect = useCallback(() => {
    if (!editorView) return { top: 0, height: 0 };
    const rect = editorView.scrollDOM.getBoundingClientRect();
    return { top: rect.top, height: rect.height };
  }, [editorView]);

  const resolveAnchorYByOffset = useCallback((offset: number) => {
    if (editorView) {
      const cm = resolveAnchorYFromView(editorView, offset);
      if (cm != null) return cm;
    }
    const root = editorRootRef.current;
    return root ? resolveAnchorYFromDOM(root as HTMLElement, offset) : null;
  }, [editorView]);

  // Adapter: convert ThreadKey (string) back to numeric offset for the resolver.
  const resolveAnchorY = useCallback((key: string) => resolveAnchorYByOffset(Number(key)), [resolveAnchorYByOffset]);

  // Thread data and mutation callbacks from the criticmarkup adapter.
  const { threads, callbacks } = useThreadsFromYText(yText, displayName ?? 'anonymous', canEdit);
  // A link to a thread's place: the page with ?pos= (its UTF-8 offset), which
  // puts the cursor there when opened
  const copyCommentLink = useCallback((thread: ThreadView) => {
    const offset = new TextEncoder().encode(yText.toString().slice(0, Number(thread.key))).length;
    void navigator.clipboard?.writeText(`${window.location.origin}${window.location.pathname}?pos=${offset}`);
  }, [yText]);
  // An opened card stands by its text, so the text comes up a quarter of the
  // way down the page when it is off screen or low on it (Notion scrolls to
  // it); the card and its reply bar would otherwise be out of sight
  const scrollToThread = useCallback((key: string | null) => {
    if (key == null || !editorView) return;
    const pos = Math.min(Number(key), editorView.state.doc.length);
    const page = editorView.scrollDOM.getBoundingClientRect();
    const at = editorView.coordsAtPos(pos);
    if (at && at.top >= page.top && at.bottom <= page.top + page.height * 0.6) return;
    editorView.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: page.height / 4 }) });
  }, [editorView]);
  // Those who may edit resolve comments (the card's tick); anyone copies a link
  const commentActions = useMemo(
    () => ({ onCopyLink: copyCommentLink, ...(canEdit && { onResolve: callbacks.onResolve }) }),
    [canEdit, callbacks, copyCommentLink],
  );

  // ScrollSource wrapping the editor's scroll container. Pass the live element
  // (not the ref) so the hook re-attaches when editorView arrives.
  const scrollSource = useScrollSource(editorView ? (editorView.scrollDOM as HTMLElement) : null);

  const [synced, setSynced] = useState(false);
  const [isSourceMode, setIsSourceMode] = useState(false);
  // Settings in the page menu, held here so each new editor gets them
  const spellcheck = useSpellcheckSetting(editorView);
  const authorship = useAuthorshipSettings(editorView);
  const [isSuggestionMode, setIsSuggestionMode] = useState(readSuggestionMode);
  const handleSuggestionModeChange = useCallback((next: boolean) => {
    setIsSuggestionMode(next);
    writeSuggestionMode(next);
  }, []);
  const [promotionStatus, setPromotionStatus] = useState<PromotionStatusResponse | null>(null);
  const [promotionLoading, setPromotionLoading] = useState(false);
  const [promotionError, setPromotionError] = useState<string | null>(null);
  const [promoteDialogTarget, setPromoteDialogTarget] = useState<{
    filePath: string;
    status: PromotionStatusResponse | null;
  } | null>(null);
  const promotionRequestRef = useRef(0);
  const promotionFailedRef = useRef(false);

  // Derive current file path from doc ID for wikilink resolution
  const currentFilePath = useMemo(() => {
    if (!metadata || !Object.keys(metadata).length) return undefined;
    const uuid = currentDocId.slice(RELAY_ID.length + 1);
    return findPathByUuid(uuid, metadata) ?? undefined;
  }, [currentDocId, metadata]);
  const canUsePromotion = canPromote && (isAllFolders || folderUuid === EDU_FOLDER_ID);
  const promotionFilePath = useMemo(
    () => canUsePromotion ? editorPathToPromotionPath(currentFilePath) : null,
    [canUsePromotion, currentFilePath],
  );

  const refreshPromotionStatus = useCallback((options: { showLoading?: boolean } = {}) => {
    const showLoading = options.showLoading ?? true;
    const requestId = ++promotionRequestRef.current;

    if (!promotionFilePath) {
      setPromotionStatus(null);
      setPromotionError(null);
      setPromotionLoading(false);
      return;
    }

    if (showLoading) setPromotionLoading(true);
    // A background refresh keeps the last error on screen until a request succeeds,
    // so the label does not flicker; after a failure the interval stops asking.
    if (showLoading) setPromotionError(null);
    getPromotionStatus(promotionFilePath)
      .then((nextStatus) => {
        if (promotionRequestRef.current !== requestId) return;
        promotionFailedRef.current = false;
        setPromotionError(null);
        setPromotionStatus(nextStatus);
      })
      .catch((error: unknown) => {
        if (promotionRequestRef.current !== requestId) return;
        promotionFailedRef.current = true;
        setPromotionStatus(null);
        setPromotionError(error instanceof Error ? error.message : 'Unable to check production');
      })
      .finally(() => {
        if (promotionRequestRef.current !== requestId) return;
        if (showLoading) setPromotionLoading(false);
      });
  }, [promotionFilePath]);

  useEffect(() => {
    refreshPromotionStatus();
    if (!promotionFilePath) return;

    const intervalId = window.setInterval(() => {
      if (promotionFailedRef.current) return;
      refreshPromotionStatus({ showLoading: false });
    }, PROMOTION_STATUS_REFRESH_MS);

    return () => window.clearInterval(intervalId);
  }, [promotionFilePath, refreshPromotionStatus]);

  const openPromoteDialog = useCallback(() => {
    if (!promotionFilePath) return;
    setPromoteDialogTarget({ filePath: promotionFilePath, status: promotionStatus });
  }, [promotionFilePath, promotionStatus]);

  // Stable refs for upload getters (avoids stale closures in imagePasteExtension)
  const folderDocsRef = useRef<Map<string, import('yjs').Doc>>(new Map());
  folderDocsRef.current = folderDocs;
  const currentFilePathForUploadRef = useRef<string | undefined>(undefined);
  currentFilePathForUploadRef.current = currentFilePath;

  const getFolderDoc = useCallback(() => {
    const fp = currentFilePathForUploadRef.current;
    if (!fp) return null;
    const folderName = fp.split('/').filter(Boolean)[0];
    return folderName ? (folderDocsRef.current.get(folderName) ?? null) : null;
  }, []);

  const folderNamesRef = useRef(folderNames);
  folderNamesRef.current = folderNames;
  const createLinkedDocInFolder = useCallback(
    (target: Parameters<typeof createLinkedDoc>[0]) =>
      createLinkedDoc(target, folderDocsRef.current, folderNamesRef.current),
    [],
  );

  // The page header (icon and title), then the Concepts panel, for the files
  // the concept-row rules name, and the concept graph header, for concept
  // files: rendered into a block widget at the top of the document so they
  // scroll with it, as Notion's page header does (graph first if both).
  const [pageTopHost] = useState(() => document.createElement('div'));
  const showConceptPanel = matchRule(currentFilePath) !== null;
  const showConceptGraph = isConceptPath(currentFilePath);
  const showJevCheck = isCheckPath(currentFilePath);
  // Version history, for Lens Edu files only (server/history); closes when the file changes.
  const filePathForHistory = historyPath(currentFilePath);
  const [historyOpen, setHistoryOpen] = useState(false);
  useEffect(() => setHistoryOpen(false), [currentDocId]);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);
  useEffect(() => {
    if (!editorView) return;
    if (editorView.state.field(panelHostField, false) === undefined) {
      editorView.dispatch({ effects: StateEffect.appendConfig.of(panelHostField) });
    }
    editorView.dispatch({ effects: setPanelHost.of(pageTopHost) });
  }, [editorView, pageTopHost]);

  // Callback to receive view reference from Editor
  const handleEditorReady = useCallback((view: EditorView) => {
    setEditorView(view);
    // Force re-render to pass view to ToC
    setStateVersion(v => v + 1);
  }, []);

  // Read-aloud lives on the editor view (extensions/readAloud.ts).
  const readAloudEngine = getReadAloud(editorView)?.engine ?? null;
  const startReadAloud = useCallback(() => getReadAloud(editorView)?.start(), [editorView]);

  // Callback for document changes
  const handleDocChange = useCallback(() => {
    setStateVersion(v => v + 1);
  }, []);

  // Callback for Y.Doc sync completion
  const handleSynced = useCallback(() => setSynced(true), []);

  const commentsLayerRef = useRef<CommentsLayerHandle | null>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  editorViewRef.current = editorView;
  // A new comment's place, pinned when its form opens: the selected text,
  // which the comment highlights, or the cursor (Comments/commentTarget.ts)
  const pinCommentTarget = useCallback((view: EditorView) => {
    const target = commentTarget(view.state);
    return pinInsertKey(yText, String(target.to), target.from < target.to ? target.from : undefined);
  }, [yText]);
  const handleRequestAddComment = useCallback(() => {
    if (isMobile) {
      const view = editorViewRef.current;
      if (!view) return;
      commentSheetEpochRef.current++;
      setPendingCommentAction({ type: 'add', key: pinCommentTarget(view) });
      openDrawer('comments');
      return;
    }
    manager.expand('comment-margin');
    commentsLayerRef.current?.openAddForm();
  }, [manager.expand, isMobile, openDrawer, pinCommentTarget]);

  // Track suggestion mode from editor state
  useEffect(() => {
    if (!editorView) return;
    setIsSuggestionMode(editorView.state.field(suggestionModeField));
    const listener = EditorView.updateListener.of((update) => {
      if (update.state.field(suggestionModeField) !== update.startState.field(suggestionModeField)) {
        setIsSuggestionMode(update.state.field(suggestionModeField));
      }
    });
    editorView.dispatch({ effects: StateEffect.appendConfig.of(listener) });
  }, [editorView]);

  // Make editor read-only when both source mode and suggestion mode are active
  useEffect(() => {
    if (!editorView) return;
    const shouldBeReadOnly = isSourceMode && isSuggestionMode;
    editorView.dispatch({
      effects: sourceReadOnlyCompartment.reconfigure(
        shouldBeReadOnly
          ? [EditorView.editable.of(false), EditorState.readOnly.of(true)]
          : []
      ),
    });
  }, [editorView, isSourceMode, isSuggestionMode]);

  const handleCommentClick = useCallback((absFrom: number, opts?: { fromText?: boolean }) => {
    if (isMobile) {
      // A tap on commented text is for editing it; its badge opens the thread
      if (opts?.fromText) return;
      commentSheetEpochRef.current++;
      setPendingCommentAction({ type: 'focus', key: String(absFrom) });
      openDrawer('comments');
      return;
    }
    manager.expand('comment-margin');
    // A click in commented text opens its thread (it also places the cursor);
    // the badge toggles it
    if (opts?.fromText) commentsLayerRef.current?.focusThread(String(absFrom));
    else commentsLayerRef.current?.toggleFocus(String(absFrom));
  }, [manager.expand, isMobile, openDrawer]);

  // Track editor focus on mobile — drives the nav-bar ↔ edit-toolbar swap.
  // Read-only users get no toolbar, so keep the nav bar instead of hiding both.
  useEffect(() => {
    if (!editorView || !isMobile || !canWrite) {
      setEditorFocused(false);
      return;
    }
    const dom = editorView.contentDOM;
    const onFocus = () => setEditorFocused(true);
    const onBlur = () => setEditorFocused(false);
    dom.addEventListener('focus', onFocus);
    dom.addEventListener('blur', onBlur);
    setEditorFocused(editorView.hasFocus);
    return () => {
      dom.removeEventListener('focus', onFocus);
      dom.removeEventListener('blur', onBlur);
      setEditorFocused(false);
    };
  }, [editorView, isMobile, canWrite, setEditorFocused]);

  // Auto-collapse comment margin on notes without comments (after initial Y.Doc sync)
  const initialCommentCheckRef = useRef(false);
  useEffect(() => {
    if (isMobile) return; // sheet model — no margin to collapse
    if (initialCommentCheckRef.current || !editorView || !synced) return;
    initialCommentCheckRef.current = true;

    const ranges = editorView.state.field(criticMarkupField);
    const threads = parseThreads(ranges);
    if (threads.length === 0) {
      manager.collapseWithInfinity('comment-margin');
    } else {
      manager.expand('comment-margin');
    }
  }, [synced, editorView, manager, isMobile]);

  // Consume URL navigation targets once the editor has synced:
  //   ?pos={offset} — review page "Open" links; a UTF-8 byte offset from the
  //                   relay's suggestion scan, translated to a CM position here
  //   #L{number}    — line anchors
  // One effect handles both (?pos wins when both are present) so there is a
  // single jump and a single cleanup that strips every consumed target from
  // the URL — even malformed ones, which would otherwise linger and confuse
  // later navigation. Reads window.location (the router's location goes stale
  // after our raw replaceState); depends on routerLocation so an in-app
  // navigation to a new target on an already-mounted editor re-runs it.
  useEffect(() => {
    if (!synced || !editorView) return;
    const params = new URLSearchParams(window.location.search);
    const posParam = params.get('pos');
    const lineMatch = window.location.hash.match(/^#L(\d+)$/i);
    if (posParam === null && !lineMatch) return;

    const doc = editorView.state.doc;
    let target: number | null = null;
    if (posParam !== null) {
      const byteOffset = parseInt(posParam, 10);
      if (!Number.isNaN(byteOffset) && byteOffset >= 0) {
        target = utf8ByteToUtf16Offset(doc.toString(), byteOffset);
      }
    }
    if (target === null && lineMatch) {
      const lineNum = parseInt(lineMatch[1], 10);
      if (lineNum >= 1) target = doc.line(Math.min(lineNum, doc.lines)).from;
    }

    if (target !== null) jumpToPos(editorView, target);

    params.delete('pos');
    const qs = params.toString();
    const hash = lineMatch ? '' : window.location.hash;
    history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : '') + hash);
  }, [synced, editorView, routerLocation]);

  // Portal targets in the global header
  const breadcrumbTarget = document.getElementById('header-breadcrumb');
  const portalTarget = document.getElementById('header-controls');
  const menuTarget = document.getElementById('header-menu');
  const discussionToggleTarget = document.getElementById('header-discussion-toggle');
  const rightCollapsed = manager.collapsedState['right-sidebar'] ?? false;
  const commentMarginCollapsed = manager.collapsedState['comment-margin'] ?? false;
  const discussionCollapsed = manager.collapsedState['discussion'] ?? true;

  return (
    <main className="h-full flex flex-col min-h-0">
      {/* Portal breadcrumbs into global header */}
      {breadcrumbTarget && (() => {
        const segments = pathToSegments(currentFilePath);
        if (segments.length === 0) return null;
        return createPortal(
          // Notion's breadcrumb: each folder and the page, "/" between them;
          // long names are cut with an ellipsis (full path in the tooltip)
          // instead of running under the controls.
          <nav className="lens-breadcrumb" aria-label="Breadcrumb" title={segments.join(' / ')}>
            {segments.map((seg, i) => (
              <Fragment key={i}>
                {i > 0 && <span className="lens-crumb-separator" aria-hidden="true">/</span>}
                <span className="lens-crumb">
                  <span className="lens-crumb-name">{seg}</span>
                </span>
              </Fragment>
            ))}
          </nav>,
          breadcrumbTarget
        );
      })()}
      {/* The page's controls in the top bar, after Notion's: whether it is
          saved, who is here, the editing mode and Listen. The comments and
          panel buttons follow (App.tsx), then the page menu. */}
      {portalTarget && createPortal(
        <>
          {/* <PanelDebugOverlay config={PANEL_CONFIG} manager={manager} /> */}
          {/* <DebugYMapPanel /> */}
          {isSourceMode && <SourceModeChip editorView={editorView} onSourceModeChange={setIsSourceMode} />}
          {promotionFilePath && headerStage !== 'overflow' && (
            <PromotionStatus
              filePath={promotionFilePath}
              canPromote={canPromote}
              status={promotionStatus}
              loading={promotionLoading}
              error={promotionError}
              onRefresh={refreshPromotionStatus}
              onPromoteFile={openPromoteDialog}
              onPromoteMultiple={() => navigate(`/promote?path=${encodeURIComponent(promotionFilePath)}`)}
            />
          )}
          <SyncStatus />
          {headerStage !== 'overflow' && <PresencePanel />}
          <SuggestionModeToggle view={editorView} iconOnly={headerStage !== 'full'} isSuggestionMode={isSuggestionMode} onSuggestionModeChange={handleSuggestionModeChange} />
          <ListenButton engine={readAloudEngine} onStart={startReadAloud} />
        </>,
        portalTarget
      )}
      {/* Notion's page menu (•••): this page's settings, then the workflows
          and appearance. On a narrow bar it also takes who is here and the
          production status. */}
      {menuTarget && createPortal(
        <WorkflowMenu>
          {headerStage === 'overflow' && (
            <div className="lens-menu-presence">
              <PresencePanel />
              {promotionFilePath && (
                <PromotionStatus
                  filePath={promotionFilePath}
                  canPromote={canPromote}
                  status={promotionStatus}
                  loading={promotionLoading}
                  error={promotionError}
                  onRefresh={refreshPromotionStatus}
                  onPromoteFile={openPromoteDialog}
                  onPromoteMultiple={() => navigate(`/promote?path=${encodeURIComponent(promotionFilePath)}`)}
                />
              )}
            </div>
          )}
          <SourceModeToggle editorView={editorView} isSourceMode={isSourceMode} onSourceModeChange={setIsSourceMode} />
          <SpellcheckToggle setting={spellcheck} disabled={!editorView} />
          <AuthorshipModeToggle settings={authorship} disabled={!editorView} />
          {filePathForHistory && <HistoryMenuItem onOpen={() => setHistoryOpen(true)} />}
        </WorkflowMenu>,
        menuTarget
      )}
      {/* Portal Discord toggle into global header — only when doc has discussion */}
      {discussionToggleTarget && hasDiscussion && createPortal(
        <button
          onClick={() => (isMobile ? toggleDrawer('discussion') : manager.toggle('discussion'))}
          title="Toggle discussion"
          className="cursor-pointer text-gray-600 hover:text-gray-700 transition-colors"
        >
          <svg className="w-[22px] h-[22px]" viewBox="0 0 24 24" fill="currentColor" opacity={(isMobile ? activeDrawer !== 'discussion' : discussionCollapsed) ? (isMobile ? 0.35 : 0.2) : 0.45}>
            <path d="M19.73 4.87a18.2 18.2 0 0 0-4.6-1.44c-.2.36-.43.85-.59 1.23a16.84 16.84 0 0 0-5.07 0c-.16-.38-.4-.87-.6-1.23a18.17 18.17 0 0 0-4.6 1.44A19.25 19.25 0 0 0 .96 18.06a18.32 18.32 0 0 0 5.63 2.87c.46-.62.86-1.28 1.2-1.98a11.83 11.83 0 0 1-1.89-.91c.16-.12.31-.24.46-.37a12.97 12.97 0 0 0 11.28 0c.15.13.3.25.46.37-.6.36-1.23.67-1.9.92.35.7.75 1.35 1.2 1.97a18.27 18.27 0 0 0 5.63-2.87A19.22 19.22 0 0 0 19.73 4.87ZM8.3 15.12c-1.18 0-2.16-1.1-2.16-2.44 0-1.34.95-2.44 2.16-2.44 1.2 0 2.18 1.1 2.16 2.44 0 1.34-.95 2.44-2.16 2.44Zm7.4 0c-1.18 0-2.16-1.1-2.16-2.44 0-1.34.95-2.44 2.16-2.44 1.2 0 2.18 1.1 2.16 2.44 0 1.34-.96 2.44-2.16 2.44Z" />
          </svg>
        </button>,
        discussionToggleTarget
      )}
      {/* Editor + Sidebars container — CSS flexbox with pixel widths */}
      <div id="editor-area" className="flex-1 flex min-h-0 relative">
        {historyOpen && filePathForHistory && <HistoryPanel path={filePathForHistory} onClose={closeHistory} />}
        {/* Editor fills remaining space */}
        <div id="editor" className="flex-1 flex flex-col min-w-0 bg-white" style={{ minWidth: 250 }}>
          <SyncedFileBanner />
          {createPortal(
            <>
              <DocumentTitle currentDocId={currentDocId} />
              {showJevCheck && (
                <PanelErrorBoundary name="Jev check workbench" resetKey={currentDocId}>
                  <JevCheckPanel ytext={yText} />
                </PanelErrorBoundary>
              )}
              {showConceptGraph && (
                <PanelErrorBoundary name="Concept graph" resetKey={currentDocId}>
                  <ConceptGraphPanel docId={currentDocId} path={currentFilePath} ytext={yText} />
                </PanelErrorBoundary>
              )}
              {showConceptPanel && (
                <PanelErrorBoundary name="Concept relationships" resetKey={currentDocId}>
                  <ConceptRowsPanel docId={currentDocId} path={currentFilePath} ytext={yText} suggestionMode={isSuggestionMode} />
                </PanelErrorBoundary>
              )}
            </>,
            pageTopHost,
          )}
          {isSourceMode && isSuggestionMode && (
            <SourceSuggestionBanner />
          )}
          <div className="lens-page-area flex-1 min-h-0 relative">
            <ReadAloudBar engine={readAloudEngine} />
            {/* Notion's table of contents: dashes at the page's right edge */}
            {!isMobile && <PageOutline view={editorView} stateVersion={stateVersion} docId={currentDocId} />}
            <Editor
              readOnly={!canWrite}
              canAcceptReject={canEdit}
              onEditorReady={handleEditorReady}
              onDocChange={handleDocChange}
              onSynced={handleSynced}
              onNavigate={onNavigate}
              onRequestAddComment={handleRequestAddComment}
              onCommentClick={handleCommentClick}
              metadata={metadata}
              currentFilePath={currentFilePath}
              getFolderDoc={getFolderDoc}
              folderNames={folderNames}
              createLinkedDoc={createLinkedDocInFolder}
              initialSuggestionMode={isSuggestionMode}
            />
          </div>
        </div>

        {!isMobile && (
        <>
        {/* Comment margin — always rendered, width 0 when collapsed */}
        <ResizeHandle
          onDragStart={() => manager.getWidth('comment-margin')}
          onDrag={(size) => manager.setWidth('comment-margin', size)}
          onDragEnd={() => manager.onDragEnd('comment-margin')}
          disabled={commentMarginCollapsed}
        />
        <div
          id="comment-margin"
          className="overflow-hidden flex-shrink-0 relative"
          style={{ width: commentMarginCollapsed ? 0 : Math.max(320, manager.getWidth('comment-margin')) }}
        >
          {editorView && (
            <CommentsLayer
              ref={commentsLayerRef}
              threads={threads}
              resolveAnchorY={resolveAnchorY}
              getViewportRect={getViewportRect}
              scrollSource={scrollSource}
              editorRootRef={editorRootRef}
              onReply={callbacks.onReply}
              onEdit={callbacks.onEdit}
              onDelete={callbacks.onDelete}
              onAddComment={callbacks.onAddComment}
              getInsertKey={editorView ? () => pinCommentTarget(editorView) : undefined}
              actions={commentActions}
              numbered={false}
              onReact={canWrite ? callbacks.onReact : undefined}
              onFocusChange={scrollToThread}
            />
          )}
        </div>

        {/* Right sidebar — always rendered, width 0 when collapsed */}
        <ResizeHandle
          onDragStart={() => manager.getWidth('right-sidebar')}
          onDrag={(size) => manager.setWidth('right-sidebar', size)}
          onDragEnd={() => manager.onDragEnd('right-sidebar')}
          disabled={rightCollapsed}
        />
        <div
          id="right-sidebar"
          className="overflow-hidden flex-shrink-0 bg-[var(--lens-sidebar-bg)] flex flex-col"
          style={{ width: rightCollapsed ? 0 : manager.getWidth('right-sidebar') }}
        >
          {/* Backlinks (the table of contents is on the page), above the
              content status panel */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            <BacklinksPanel currentDocId={currentDocId} />
          </div>
          {/* Not mounted while collapsed, so it does not keep asking the platform. */}
          {!rightCollapsed && (
            <ContentStatusPanel
              docId={currentDocId}
              className="flex-shrink-0 max-h-[45%] overflow-y-auto border-t border-gray-200"
            />
          )}
        </div>

        {/* Discussion — conditionally rendered (only when doc has discussion) */}
        {hasDiscussion && (
          <>
            <ResizeHandle
              onDragStart={() => manager.getWidth('discussion')}
              onDrag={(size) => manager.setWidth('discussion', size)}
              onDragEnd={() => manager.onDragEnd('discussion')}
              disabled={discussionCollapsed}
            />
            <div
              id="discussion"
              className="overflow-hidden flex-shrink-0"
              style={{ width: discussionCollapsed ? 0 : manager.getWidth('discussion') }}
            >
              <ConnectedDiscussionPanel />
            </div>
          </>
        )}
        </>
        )}
      </div>

      {/* Mobile: side panels become drawers / bottom sheets */}
      {isMobile && (
        <>
          <MobileDrawer
            open={activeDrawer === 'comments'}
            onClose={closeDrawer}
            side="bottom"
            label="Comments"
          >
            <MobileCommentsSheet
              key={commentSheetEpochRef.current}
              threads={threads}
              pendingAction={pendingCommentAction}
              onPendingActionConsumed={() => setPendingCommentAction(null)}
              onReply={callbacks.onReply}
              onEdit={callbacks.onEdit}
              onDelete={callbacks.onDelete}
              onAddComment={canWrite ? callbacks.onAddComment : undefined}
              getInsertKey={editorView && canWrite ? () => pinCommentTarget(editorView) : undefined}
              actions={commentActions}
              numbered={false}
              onReact={canWrite ? callbacks.onReact : undefined}
            />
          </MobileDrawer>

          <MobileDrawer
            open={activeDrawer === 'right'}
            onClose={closeDrawer}
            side="right"
            label="Outline and backlinks"
          >
            {/* Bubble-phase: a heading tap goes to it and closes the drawer */}
            <div onClick={(e) => { if ((e.target as HTMLElement).closest('li')) closeDrawer(); }}>
              <TableOfContents view={editorView} stateVersion={stateVersion} />
            </div>
            <div className="border-t border-gray-200 mt-2" />
            <BacklinksPanel currentDocId={currentDocId} />
            <ContentStatusPanel docId={currentDocId} className="border-t border-gray-200" />
          </MobileDrawer>

          {hasDiscussion && (
            <MobileDrawer
              open={activeDrawer === 'discussion'}
              onClose={closeDrawer}
              side="right"
              label="Discussion"
            >
              <div className="h-full flex flex-col min-h-[50dvh]">
                <ConnectedDiscussionPanel />
              </div>
            </MobileDrawer>
          )}

          {editorView && editorFocused && canWrite && (
            <MobileEditToolbar view={editorView} onAddComment={handleRequestAddComment} />
          )}
        </>
      )}
      {promoteDialogTarget && (
        <PromoteFileDialog
          open
          filePath={promoteDialogTarget.filePath}
          status={promoteDialogTarget.status}
          onClose={() => setPromoteDialogTarget(null)}
          onPromoted={refreshPromotionStatus}
        />
      )}
    </main>
  );
}
