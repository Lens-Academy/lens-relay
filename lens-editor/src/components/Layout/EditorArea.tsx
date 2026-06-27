import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { EditorView } from '@codemirror/view';
import { EditorState, StateEffect } from '@codemirror/state';
import { useYDoc } from '@y-sweet/react';
import * as Y from 'yjs';
import { criticMarkupField, suggestionModeField } from '../Editor/extensions/criticmarkup';
import { sourceReadOnlyCompartment } from '../Editor/extensions/livePreview';
import { SourceSuggestionBanner } from '../SourceSuggestionBanner/SourceSuggestionBanner';
import { parseThreads } from '../../lib/criticmarkup-parser';
import { SyncStatus } from '../SyncStatus/SyncStatus';
import { Editor } from '../Editor/Editor';
import { DocumentTitle } from '../DocumentTitle';
import { SourceModeToggle } from '../SourceModeToggle/SourceModeToggle';
import { SuggestionModeToggle } from '../SuggestionModeToggle/SuggestionModeToggle';
import { PresencePanel } from '../PresencePanel/PresencePanel';
import { OverflowMenu } from '../OverflowMenu';
import { TableOfContents } from '../TableOfContents';
import { BacklinksPanel } from '../BacklinksPanel';
import { CommentsLayer, type CommentsLayerHandle } from '../Comments/CommentsLayer';
import { useThreadsFromYText } from '../Comments/criticmarkupAdapter';
import { useScrollSource } from '../Comments/useScrollSource';
import { DebugYMapPanel } from '../DebugYMapPanel';
import { PanelDebugOverlay } from '../PanelDebugOverlay';
import { ConnectedDiscussionPanel } from '../DiscussionPanel';
import { PromotionStatus } from '../Promotion/PromotionStatus';
import { PromoteFileDialog } from '../Promotion/PromoteFileDialog';
import { ResizeHandle } from './ResizeHandle';
import { useHasDiscussion } from '../DiscussionPanel/useHasDiscussion';
import { useNavigation } from '../../contexts/NavigationContext';
import { useAuth } from '../../contexts/AuthContext';
import { useSidebar } from '../../contexts/SidebarContext';
import { useDisplayName } from '../../contexts/DisplayNameContext';
import { persistentHighlightLine } from '../Editor/extensions/headingFlash';
import { resolveAnchorYFromView, resolveAnchorYFromDOM } from '../../lib/anchor-resolver';
import { findPathByUuid } from '../../lib/uuid-to-path';
import { pathToSegments } from '../../lib/path-display';
import { getPromotionStatus, type PromotionStatusResponse } from '../../lib/promotion-api';
import { useAutoSplitHeight } from '../../hooks/useAutoSplitHeight';
import { RELAY_ID, PANEL_CONFIG } from '../../App';

/**
 * Editor area component that lives INSIDE the RelayProvider key boundary.
 * This allows it to remount when switching documents while keeping
 * the Sidebar stable outside the boundary.
 */
export function EditorArea({ currentDocId }: { currentDocId: string }) {
  const navigate = useNavigate();
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const [stateVersion, setStateVersion] = useState(0);
  const { metadata, onNavigate, folderDocs } = useNavigation();
  const { canWrite, canEdit } = useAuth();
  const { manager, headerStage } = useSidebar();
  const { displayName } = useDisplayName();
  const hasDiscussion = useHasDiscussion();

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
  const { threads, callbacks } = useThreadsFromYText(yText, displayName ?? 'anonymous');

  // ScrollSource wrapping the editor's scroll container. Pass the live element
  // (not the ref) so the hook re-attaches when editorView arrives.
  const scrollSource = useScrollSource(editorView ? (editorView.scrollDOM as HTMLElement) : null);

  const [synced, setSynced] = useState(false);
  const [isSourceMode, setIsSourceMode] = useState(false);
  const [isSuggestionMode, setIsSuggestionMode] = useState(false);
  const [promotionStatus, setPromotionStatus] = useState<PromotionStatusResponse | null>(null);
  const [promotionLoading, setPromotionLoading] = useState(false);
  const [promotionError, setPromotionError] = useState<string | null>(null);
  const [promoteDialogTarget, setPromoteDialogTarget] = useState<{
    filePath: string;
    status: PromotionStatusResponse | null;
  } | null>(null);
  const promotionRequestRef = useRef(0);

  // Derive current file path from doc ID for wikilink resolution
  const currentFilePath = useMemo(() => {
    if (!metadata || !Object.keys(metadata).length) return undefined;
    const uuid = currentDocId.slice(RELAY_ID.length + 1);
    return findPathByUuid(uuid, metadata) ?? undefined;
  }, [currentDocId, metadata]);

  const refreshPromotionStatus = useCallback(() => {
    const requestId = ++promotionRequestRef.current;

    if (!currentFilePath || !canEdit) {
      setPromotionStatus(null);
      setPromotionError(null);
      setPromotionLoading(false);
      return;
    }

    setPromotionLoading(true);
    setPromotionError(null);
    getPromotionStatus(currentFilePath)
      .then((nextStatus) => {
        if (promotionRequestRef.current !== requestId) return;
        setPromotionStatus(nextStatus);
      })
      .catch((error: unknown) => {
        if (promotionRequestRef.current !== requestId) return;
        setPromotionStatus(null);
        setPromotionError(error instanceof Error ? error.message : 'Unable to check production');
      })
      .finally(() => {
        if (promotionRequestRef.current !== requestId) return;
        setPromotionLoading(false);
      });
  }, [canEdit, currentFilePath]);

  useEffect(() => refreshPromotionStatus(), [refreshPromotionStatus]);

  const openPromoteDialog = useCallback(() => {
    if (!currentFilePath) return;
    setPromoteDialogTarget({ filePath: currentFilePath, status: promotionStatus });
  }, [currentFilePath, promotionStatus]);

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

  // Callback to receive view reference from Editor
  const handleEditorReady = useCallback((view: EditorView) => {
    setEditorView(view);
    // Force re-render to pass view to ToC
    setStateVersion(v => v + 1);
  }, []);

  // Callback for document changes
  const handleDocChange = useCallback(() => {
    setStateVersion(v => v + 1);
  }, []);

  // Callback for Y.Doc sync completion
  const handleSynced = useCallback(() => setSynced(true), []);

  const commentsLayerRef = useRef<CommentsLayerHandle | null>(null);
  const handleRequestAddComment = useCallback(() => {
    manager.expand('comment-margin');
    commentsLayerRef.current?.openAddForm();
  }, [manager.expand]);

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

  const handleCommentClick = useCallback((absFrom: number) => {
    manager.expand('comment-margin');
    commentsLayerRef.current?.toggleFocus(String(absFrom));
  }, [manager.expand]);

  // Auto-collapse comment margin on notes without comments (after initial Y.Doc sync)
  const initialCommentCheckRef = useRef(false);
  useEffect(() => {
    if (initialCommentCheckRef.current || !editorView || !synced) return;
    initialCommentCheckRef.current = true;

    const ranges = editorView.state.field(criticMarkupField);
    const threads = parseThreads(ranges);
    if (threads.length === 0) {
      manager.collapseWithInfinity('comment-margin');
    } else {
      manager.expand('comment-margin');
    }
  }, [synced, editorView, manager]);

  // Scroll to #L{number} line on initial load
  useEffect(() => {
    if (!synced || !editorView) return;
    const match = window.location.hash.match(/^#L(\d+)$/i);
    if (!match) return;
    const lineNum = parseInt(match[1], 10);
    if (lineNum < 1) return;
    const doc = editorView.state.doc;
    const clampedLine = Math.min(lineNum, doc.lines);
    const line = doc.line(clampedLine);

    editorView.dispatch({
      selection: { anchor: line.from },
      effects: [
        EditorView.scrollIntoView(line.from, { y: 'center' }),
        persistentHighlightLine.of(line.from),
      ],
    });

    history.replaceState(null, '', window.location.pathname + window.location.search);
  }, [synced, editorView]);

  // Auto-split ToC/Backlinks vertical split inside right sidebar
  const sidebarContainerRef = useRef<HTMLDivElement>(null);
  const tocScrollRef = useRef<HTMLDivElement>(null);
  const blScrollRef = useRef<HTMLDivElement>(null);
  const [userOverride, setUserOverride] = useState<number | null>(null);

  // Reset override when document changes
  useEffect(() => setUserOverride(null), [currentDocId]);

  const { topHeight: tocHeight, bottomHeight: blHeight } = useAutoSplitHeight({
    containerRef: sidebarContainerRef,
    topRef: tocScrollRef,
    bottomRef: blScrollRef,
    handleHeight: 9,
    minHeight: 80,
    userOverride,
  });

  // Portal targets in the global header
  const breadcrumbTarget = document.getElementById('header-breadcrumb');
  const portalTarget = document.getElementById('header-controls');
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
          <span className="text-sm text-gray-600 truncate">
            {segments.map((seg, i) => (
              <span key={i}>
                {i > 0 && <span className="mx-0.5">›</span>}
                {seg}
              </span>
            ))}
          </span>,
          breadcrumbTarget
        );
      })()}
      {/* Portal editor controls into global header */}
      {portalTarget && createPortal(
        <>
          {/* <PanelDebugOverlay config={PANEL_CONFIG} manager={manager} /> */}
          {headerStage === 'overflow' ? (
            <OverflowMenu>
              <SuggestionModeToggle view={editorView} iconOnly isSuggestionMode={isSuggestionMode} />
              <SourceModeToggle editorView={editorView} isSourceMode={isSourceMode} onSourceModeChange={setIsSourceMode} />
              {currentFilePath && (
                <PromotionStatus
                  filePath={currentFilePath}
                  canPromote={canEdit}
                  status={promotionStatus}
                  loading={promotionLoading}
                  error={promotionError}
                  onRefresh={refreshPromotionStatus}
                  onPromoteFile={openPromoteDialog}
                  onPromoteMultiple={() => navigate(`/promote?path=${encodeURIComponent(currentFilePath)}`)}
                />
              )}
              <PresencePanel />
              <SyncStatus />
            </OverflowMenu>
          ) : (
            <>
              {/* <DebugYMapPanel /> */}
              <SuggestionModeToggle view={editorView} iconOnly={headerStage !== 'full'} isSuggestionMode={isSuggestionMode} />
              <SourceModeToggle editorView={editorView} isSourceMode={isSourceMode} onSourceModeChange={setIsSourceMode} />
              {currentFilePath && (
                <PromotionStatus
                  filePath={currentFilePath}
                  canPromote={canEdit}
                  status={promotionStatus}
                  loading={promotionLoading}
                  error={promotionError}
                  onRefresh={refreshPromotionStatus}
                  onPromoteFile={openPromoteDialog}
                  onPromoteMultiple={() => navigate(`/promote?path=${encodeURIComponent(currentFilePath)}`)}
                />
              )}
              <PresencePanel />
              <SyncStatus />
            </>
          )}
        </>,
        portalTarget
      )}
      {/* Portal Discord toggle into global header — only when doc has discussion */}
      {discussionToggleTarget && hasDiscussion && createPortal(
        <button
          onClick={() => manager.toggle('discussion')}
          title="Toggle discussion"
          className="cursor-pointer text-gray-600 hover:text-gray-700 transition-colors"
        >
          <svg className="w-[22px] h-[22px]" viewBox="0 0 24 24" fill="currentColor" opacity={discussionCollapsed ? 0.2 : 0.45}>
            <path d="M19.73 4.87a18.2 18.2 0 0 0-4.6-1.44c-.2.36-.43.85-.59 1.23a16.84 16.84 0 0 0-5.07 0c-.16-.38-.4-.87-.6-1.23a18.17 18.17 0 0 0-4.6 1.44A19.25 19.25 0 0 0 .96 18.06a18.32 18.32 0 0 0 5.63 2.87c.46-.62.86-1.28 1.2-1.98a11.83 11.83 0 0 1-1.89-.91c.16-.12.31-.24.46-.37a12.97 12.97 0 0 0 11.28 0c.15.13.3.25.46.37-.6.36-1.23.67-1.9.92.35.7.75 1.35 1.2 1.97a18.27 18.27 0 0 0 5.63-2.87A19.22 19.22 0 0 0 19.73 4.87ZM8.3 15.12c-1.18 0-2.16-1.1-2.16-2.44 0-1.34.95-2.44 2.16-2.44 1.2 0 2.18 1.1 2.16 2.44 0 1.34-.95 2.44-2.16 2.44Zm7.4 0c-1.18 0-2.16-1.1-2.16-2.44 0-1.34.95-2.44 2.16-2.44 1.2 0 2.18 1.1 2.16 2.44 0 1.34-.96 2.44-2.16 2.44Z" />
          </svg>
        </button>,
        discussionToggleTarget
      )}
      {/* Editor + Sidebars container — CSS flexbox with pixel widths */}
      <div id="editor-area" className="flex-1 flex min-h-0">
        {/* Editor fills remaining space */}
        <div id="editor" className="flex-1 flex flex-col min-w-0 bg-white" style={{ minWidth: 250 }}>
          <div className="max-w-[700px] mx-auto w-full">
            <div className="px-6 pt-5 pb-1">
              <DocumentTitle currentDocId={currentDocId} />
            </div>
            <div className="mx-6 border-b border-gray-200" />
          </div>
          {isSourceMode && isSuggestionMode && (
            <SourceSuggestionBanner />
          )}
          <div className="flex-1 min-h-0">
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
            />
          </div>
        </div>

        {/* Comment margin — always rendered, width 0 when collapsed */}
        <ResizeHandle
          onDragStart={() => manager.getWidth('comment-margin')}
          onDrag={(size) => manager.setWidth('comment-margin', size)}
          onDragEnd={() => manager.onDragEnd('comment-margin')}
          disabled={commentMarginCollapsed}
        />
        <div
          id="comment-margin"
          className={`overflow-hidden flex-shrink-0 relative ${commentMarginCollapsed ? '' : 'border-l border-gray-100 bg-gray-50/50'}`}
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
              getInsertKey={editorView ? () => String(editorView.state.selection.main.head) : undefined}
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
          ref={sidebarContainerRef}
          id="right-sidebar"
          className="overflow-hidden flex-shrink-0 bg-[#f6f6f6] flex flex-col"
          style={{ width: rightCollapsed ? 0 : manager.getWidth('right-sidebar') }}
        >
          <div ref={tocScrollRef} style={{ height: tocHeight, flexShrink: 0 }} className="overflow-y-auto">
            <TableOfContents view={editorView} stateVersion={stateVersion} />
          </div>
          <ResizeHandle
            orientation="horizontal"
            onDragStart={() => tocHeight}
            onDrag={(size) => setUserOverride(Math.max(50, size))}
            onDoubleClick={() => setUserOverride(null)}
          />
          <div ref={blScrollRef} style={{ height: blHeight, flexShrink: 0 }} className="overflow-y-auto">
            <BacklinksPanel currentDocId={currentDocId} />
          </div>
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
      </div>
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
