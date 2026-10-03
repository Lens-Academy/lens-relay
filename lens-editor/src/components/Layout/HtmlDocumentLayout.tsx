import { useEffect, type ReactNode } from 'react';
import { BacklinksPanel } from '../BacklinksPanel';
import { MobileDrawer } from '../Mobile/MobileDrawer';
import { useSidebar } from '../../contexts/SidebarContext';
import { useMobile } from '../../contexts/MobileContext';
import { ResizeHandle } from './ResizeHandle';

/**
 * An HTML page beside the right sidebar a Markdown document has in EditorArea,
 * toggled by the same header button. The page has no outline, so the sidebar
 * holds only its backlinks; on a phone they open from the bottom bar's drawer.
 */
export function HtmlDocumentLayout({ docId, children }: { docId: string; children: ReactNode }) {
  const { manager } = useSidebar();
  const { isMobile, activeDrawer, closeDrawer, setDocPanelsAvailable } = useMobile();
  const rightCollapsed = manager.collapsedState['right-sidebar'] ?? false;

  // Shows the phone's bottom-bar buttons for the comments and backlinks drawers
  useEffect(() => {
    setDocPanelsAvailable(true);
    return () => setDocPanelsAvailable(false);
  }, [setDocPanelsAvailable]);

  return (
    <div id="editor-area" className="flex h-full w-full min-h-0">
      <div className="flex min-w-0 flex-1">{children}</div>
      {!isMobile && (
        <>
          <ResizeHandle
            onDragStart={() => manager.getWidth('right-sidebar')}
            onDrag={(size) => manager.setWidth('right-sidebar', size)}
            onDragEnd={() => manager.onDragEnd('right-sidebar')}
            disabled={rightCollapsed}
          />
          <div
            id="right-sidebar"
            className="overflow-y-auto overflow-x-hidden flex-shrink-0 bg-[#f6f6f6]"
            style={{ width: rightCollapsed ? 0 : manager.getWidth('right-sidebar') }}
          >
            <BacklinksPanel currentDocId={docId} />
          </div>
        </>
      )}
      {isMobile && (
        <MobileDrawer open={activeDrawer === 'right'} onClose={closeDrawer} side="right" label="Backlinks">
          <BacklinksPanel currentDocId={docId} />
        </MobileDrawer>
      )}
    </div>
  );
}
