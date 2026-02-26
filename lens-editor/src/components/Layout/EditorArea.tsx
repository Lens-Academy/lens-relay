import { useState, useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Group, Panel, Separator, usePanelRef, type GroupImperativeHandle } from 'react-resizable-panels';
import { EditorView } from '@codemirror/view';
import { SyncStatus } from '../SyncStatus/SyncStatus';
import { Editor } from '../Editor/Editor';
import { DocumentTitle } from '../DocumentTitle';
import { SourceModeToggle } from '../SourceModeToggle/SourceModeToggle';
import { SuggestionModeToggle } from '../SuggestionModeToggle/SuggestionModeToggle';
import { PresencePanel } from '../PresencePanel/PresencePanel';
import { OverflowMenu } from '../OverflowMenu';
import { TableOfContents } from '../TableOfContents';
import { BacklinksPanel } from '../BacklinksPanel';
import { CommentMargin } from '../CommentMargin';
import { DebugYMapPanel } from '../DebugYMapPanel';
import { ConnectedDiscussionPanel } from '../DiscussionPanel';
import { useHasDiscussion } from '../DiscussionPanel/useHasDiscussion';
import { useNavigation } from '../../contexts/NavigationContext';
import { useAuth } from '../../contexts/AuthContext';
import { useSidebar } from '../../contexts/SidebarContext';
import { findPathByUuid } from '../../lib/uuid-to-path';
import { pathToSegments } from '../../lib/path-display';
import { useContainerWidth } from '../../hooks/useContainerWidth';
import { RELAY_ID } from '../../App';

/**
 * Editor area component that lives INSIDE the RelayProvider key boundary.
 * This allows it to remount when switching documents while keeping
 * the Sidebar stable outside the boundary.
 */
export function EditorArea({ currentDocId }: { currentDocId: string }) {
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const [stateVersion, setStateVersion] = useState(0);
  const { metadata, onNavigate } = useNavigation();
  const { canWrite } = useAuth();
  const { manager, headerStage } = useSidebar();
  const hasDiscussion = useHasDiscussion();
  const [addCommentTrigger, setAddCommentTrigger] = useState(0);
  const { ref: innerRef, width: innerWidth } = useContainerWidth();

  // Panel refs — register with manager so it can call collapse/expand/setLayout
  const rightSidebarRef = usePanelRef();
  const commentMarginRef = usePanelRef();
  const discussionRef = usePanelRef();
  const editorAreaGroupRef = useRef<GroupImperativeHandle | null>(null);

  // Register refs with manager on mount
  useEffect(() => {
    manager.setPanelRef('right-sidebar', rightSidebarRef);
    manager.setPanelRef('comment-margin', commentMarginRef);
    manager.setPanelRef('discussion', discussionRef);
    manager.setGroupRef('editor-area', editorAreaGroupRef);
  }, [manager.setPanelRef, manager.setGroupRef, rightSidebarRef, commentMarginRef, discussionRef]);

  const RIGHT_SIDEBAR_MIN_PX = 200;
  const rightMinPercent = innerWidth > 0
    ? Math.max((RIGHT_SIDEBAR_MIN_PX / innerWidth) * 100, 1)
    : 14;

  const DISCUSSION_MIN_PX = 250;
  const discussionMinPercent = innerWidth > 0
    ? Math.max((DISCUSSION_MIN_PX / innerWidth) * 100, 1)
    : 20;

  // Derive current file path from doc ID for wikilink resolution
  const currentFilePath = useMemo(() => {
    if (!metadata || !Object.keys(metadata).length) return undefined;
    const uuid = currentDocId.slice(RELAY_ID.length + 1);
    return findPathByUuid(uuid, metadata) ?? undefined;
  }, [currentDocId, metadata]);

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

  // Callback for "Add Comment" from editor context menu
  const handleRequestAddComment = useCallback(() => {
    manager.expand('comment-margin');
    setAddCommentTrigger(v => v + 1);
  }, [manager.expand]);

  // Portal targets in the global header
  const breadcrumbTarget = document.getElementById('header-breadcrumb');
  const portalTarget = document.getElementById('header-controls');

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
        headerStage === 'overflow' ? (
          <OverflowMenu>
            <SuggestionModeToggle view={editorView} iconOnly />
            <SourceModeToggle editorView={editorView} />
            <PresencePanel />
            <SyncStatus />
          </OverflowMenu>
        ) : (
          <>
            <DebugYMapPanel />
            <SuggestionModeToggle view={editorView} iconOnly={headerStage !== 'full'} />
            <SourceModeToggle editorView={editorView} />
            <PresencePanel />
            <SyncStatus />
          </>
        ),
        portalTarget
      )}
      {/* Editor + Sidebars container */}
      <div ref={innerRef as RefObject<HTMLDivElement>} className="flex-1 flex min-h-0">
        <Group id="editor-area" groupRef={editorAreaGroupRef} className="flex-1 min-h-0">
          {/* Editor */}
          <Panel id="editor" order={1} minSize="30%">
            <div className="h-full flex flex-col min-w-0 bg-white">
              <div className="px-6 pt-5 pb-1">
                <DocumentTitle currentDocId={currentDocId} />
              </div>
              <div className="mx-6 border-b border-gray-200" />
              <div className="flex-1 min-h-0">
                <Editor
                  readOnly={!canWrite}
                  onEditorReady={handleEditorReady}
                  onDocChange={handleDocChange}
                  onNavigate={onNavigate}
                  onRequestAddComment={handleRequestAddComment}
                  metadata={metadata}
                  currentFilePath={currentFilePath}
                />
              </div>
            </div>
          </Panel>

          {/* Comment margin — position-aligned cards, no visible separator */}
          <Panel id="comment-margin" panelRef={commentMarginRef} defaultSize="16%" minSize="0%" collapsible collapsedSize="0%" onResize={(size) => manager.onPanelResize('comment-margin', size.asPercentage)}>
            <div className="h-full border-l border-gray-100 bg-gray-50/50">
              {editorView && (
                <CommentMargin
                  view={editorView}
                  stateVersion={stateVersion}
                  addCommentTrigger={addCommentTrigger}
                />
              )}
            </div>
          </Panel>

          <Separator className="w-px bg-gray-200 hover:bg-blue-400 focus:outline-none transition-colors cursor-col-resize" />

          {/* Right sidebar — vertical Group for ToC / Backlinks */}
          <Panel id="right-sidebar" order={2} panelRef={rightSidebarRef} defaultSize="18%" minSize={`${rightMinPercent}%`} collapsible collapsedSize="0%" onResize={(size) => manager.onPanelResize('right-sidebar', size.asPercentage)}>
            <div className="h-full bg-[#f6f6f6]">
              <Group id="right-panels" orientation="vertical">
                <Panel id="toc" defaultSize="50%" minSize="10%" collapsible collapsedSize="0%">
                  <div className="h-full overflow-y-auto">
                    <TableOfContents view={editorView} stateVersion={stateVersion} />
                  </div>
                </Panel>
                <Separator className="h-px bg-gray-200 hover:bg-blue-400 focus:outline-none transition-colors cursor-row-resize" />
                <Panel id="backlinks" defaultSize="50%" minSize="10%" collapsible collapsedSize="0%">
                  <div className="h-full overflow-y-auto">
                    <BacklinksPanel currentDocId={currentDocId} />
                  </div>
                </Panel>
              </Group>
            </div>
          </Panel>

          {hasDiscussion && (
            <>
              <Separator className="w-1 bg-gray-200 hover:bg-blue-400 focus:outline-none transition-colors cursor-col-resize" />
              <Panel
                id="discussion"
                order={3}
                panelRef={discussionRef}
                defaultSize="20%"
                minSize={`${discussionMinPercent}%`}
                collapsible
                collapsedSize="0%"
                onResize={(size) => manager.onPanelResize('discussion', size.asPercentage)}
              >
                <ConnectedDiscussionPanel />
              </Panel>
            </>
          )}
        </Group>
      </div>
    </main>
  );
}
