import { useState, useCallback, useMemo, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Group, Panel, Separator } from 'react-resizable-panels';
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
import { CommentsPanel } from '../CommentsPanel';
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
  const { rightSidebarRef, setRightCollapsed, discussionRef, setDiscussionCollapsed, headerStage } = useSidebar();
  const hasDiscussion = useHasDiscussion();

  const [isDragging, setIsDragging] = useState(false);
  const { ref: innerRef, width: innerWidth } = useContainerWidth();

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
        <Group id="editor-area" className={`flex-1 min-h-0${isDragging ? ' panels-dragging' : ''}`}>
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
                  metadata={metadata}
                  currentFilePath={currentFilePath}
                />
              </div>
            </div>
          </Panel>

          <Separator className="w-1 bg-gray-200 hover:bg-blue-400 focus:outline-none transition-colors cursor-col-resize" onDragging={setIsDragging} />

          {/* Right sidebar — vertical Group for ToC / Backlinks / Comments */}
          <Panel id="right-sidebar" order={2} panelRef={rightSidebarRef} defaultSize="22%" minSize={`${rightMinPercent}%`} collapsible collapsedSize="0%" onResize={(size) => setRightCollapsed(size.asPercentage === 0)}>
            <div className="h-full border-l border-gray-200 bg-white">
              <Group id="right-panels" orientation="vertical">
                <Panel id="toc" defaultSize="30%" minSize="10%" collapsible collapsedSize="0%">
                  <div className="h-full overflow-y-auto">
                    <TableOfContents view={editorView} stateVersion={stateVersion} />
                  </div>
                </Panel>
                <Separator className="h-1 bg-gray-200 hover:bg-blue-400 focus:outline-none transition-colors cursor-row-resize" />
                <Panel id="backlinks" defaultSize="30%" minSize="10%" collapsible collapsedSize="0%">
                  <div className="h-full overflow-y-auto">
                    <BacklinksPanel currentDocId={currentDocId} />
                  </div>
                </Panel>
                <Separator className="h-1 bg-gray-200 hover:bg-blue-400 focus:outline-none transition-colors cursor-row-resize" />
                <Panel id="comments" defaultSize="40%" minSize="10%" collapsible collapsedSize="0%">
                  <div className="h-full overflow-y-auto">
                    <CommentsPanel view={editorView} stateVersion={stateVersion} />
                  </div>
                </Panel>
              </Group>
            </div>
          </Panel>

          {hasDiscussion && (
            <>
              <Separator className="w-1 bg-gray-200 hover:bg-blue-400 focus:outline-none transition-colors cursor-col-resize" onDragging={setIsDragging} />
              <Panel
                id="discussion"
                order={3}
                panelRef={discussionRef}
                defaultSize="20%"
                minSize={`${discussionMinPercent}%`}
                collapsible
                collapsedSize="0%"
                onResize={(size) => setDiscussionCollapsed(size.asPercentage === 0)}
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
