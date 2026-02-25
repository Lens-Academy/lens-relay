import { useState, useCallback, useEffect, useRef, type RefObject } from 'react';
import { Routes, Route, Navigate, useNavigate, useParams } from 'react-router-dom';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';
import { RelayProvider } from './providers/RelayProvider';
import { Sidebar } from './components/Sidebar';
import { EditorArea } from './components/Layout';
import { AwarenessInitializer } from './components/AwarenessInitializer/AwarenessInitializer';
import { DisconnectionModal } from './components/DisconnectionModal/DisconnectionModal';
import { NavigationContext, useNavigation } from './contexts/NavigationContext';
import { DisplayNameProvider } from './contexts/DisplayNameContext';
import { DisplayNamePrompt } from './components/DisplayNamePrompt';
import { DisplayNameBadge } from './components/DisplayNameBadge';
import { SidebarContext } from './contexts/SidebarContext';
import { useMultiFolderMetadata, type FolderConfig } from './hooks/useMultiFolderMetadata';
import { AuthProvider } from './contexts/AuthContext';
import type { UserRole } from './contexts/AuthContext';
import { getShareTokenFromUrl, stripShareTokenFromUrl, decodeRoleFromToken, isTokenExpired } from './lib/auth-share';
import { setShareToken, setAuthErrorCallback } from './lib/auth';
import { urlForDoc } from './lib/url-utils';
import { useResolvedDocId } from './hooks/useResolvedDocId';
import { QuickSwitcher } from './components/QuickSwitcher';
import { useRecentFiles } from './hooks/useRecentFiles';
import { useContainerWidth } from './hooks/useContainerWidth';
import { useAutoCollapse } from './hooks/useAutoCollapse';
import { useHeaderBreakpoints } from './hooks/useHeaderBreakpoints';

// VITE_LOCAL_RELAY=true routes requests to a local relay-server via Vite proxy
const USE_LOCAL_RELAY = import.meta.env.VITE_LOCAL_RELAY === 'true';

// Use R2 (production) data with local relay? Set VITE_LOCAL_R2=true
const USE_LOCAL_R2 = USE_LOCAL_RELAY && import.meta.env.VITE_LOCAL_R2 === 'true';

// Relay server ID — switches between production and local test IDs
export const RELAY_ID = (USE_LOCAL_RELAY && !USE_LOCAL_R2)
  ? 'a0000000-0000-4000-8000-000000000000'
  : 'cb696037-0f72-4e93-8717-4e433129d789';

// Folder configuration
const FOLDERS: FolderConfig[] = (USE_LOCAL_RELAY && !USE_LOCAL_R2)
  ? [
      { id: 'b0000001-0000-4000-8000-000000000001', name: 'Relay Folder 1' },
      { id: 'b0000002-0000-4000-8000-000000000002', name: 'Relay Folder 2' },
    ]
  : [
      { id: 'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e', name: 'Lens' },
      { id: 'ea4015da-24af-4d9d-ac49-8c902cb17121', name: 'Lens Edu' },
    ];

// Default document short UUID (first 8 chars — used only in URL redirect)
const DEFAULT_DOC_UUID = (USE_LOCAL_RELAY && !USE_LOCAL_R2) ? 'c0000001' : '76c3e654';

// Read share token from URL once at module load (before React renders)
const shareToken = getShareTokenFromUrl();
const shareRole: UserRole | null = shareToken ? decodeRoleFromToken(shareToken) : null;
const shareExpired: boolean = shareToken ? isTokenExpired(shareToken) : false;

// Store share token for all relay auth calls, then strip from URL bar
if (shareToken) {
  setShareToken(shareToken);
  stripShareTokenFromUrl();
}

function AccessDenied() {
  return (
    <div className="h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center max-w-md px-6">
        <div className="text-5xl mb-4">🔒</div>
        <h1 className="text-2xl font-semibold text-gray-800 mb-2">Access Required</h1>
        <p className="text-gray-500">You need a share link to access this editor. Please ask the document owner for a link.</p>
      </div>
    </div>
  );
}

function TokenExpired() {
  return (
    <div className="h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center max-w-md px-6">
        <div className="text-5xl mb-4">⏱️</div>
        <h1 className="text-2xl font-semibold text-gray-800 mb-2">Link Expired</h1>
        <p className="text-gray-500">
          Your share link has expired. Please ask an admin for a new access link.
        </p>
      </div>
    </div>
  );
}

function TokenInvalid() {
  return (
    <div className="h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center max-w-md px-6">
        <div className="text-5xl mb-4">🔑</div>
        <h1 className="text-2xl font-semibold text-gray-800 mb-2">Access Link Invalid</h1>
        <p className="text-gray-500">
          Your access link is no longer valid. Please ask an admin for a new access link.
        </p>
      </div>
    </div>
  );
}

function DocumentNotFound() {
  return (
    <main className="flex-1 flex items-center justify-center bg-gray-50">
      <div className="text-center max-w-md px-6">
        <h1 className="text-2xl font-semibold text-gray-800 mb-2">Document Not Found</h1>
        <p className="text-gray-500 mb-4">This document may have been deleted or the link may be incorrect.</p>
        <a href="/" className="text-blue-600 hover:text-blue-800 underline">Go to default document</a>
      </div>
    </main>
  );
}

/**
 * Document view — reads docUuid from URL params, resolves short UUIDs, renders editor.
 * Lives inside NavigationContext so it can access metadata and onNavigate.
 *
 * IMPORTANT: All hooks must be called before any early returns (Rules of Hooks).
 */
function DocumentView() {
  const { docUuid, '*': splatPath } = useParams<{ docUuid: string; '*': string }>();
  const { metadata } = useNavigation();
  const navigate = useNavigate();

  // Build compound ID from URL param (may be short: RELAY_ID + 8-char prefix)
  // Empty string when docUuid is missing — hook handles this gracefully
  const shortCompoundId = docUuid ? `${RELAY_ID}-${docUuid}` : '';

  // Resolve short UUID to full compound ID (instant from metadata, or server fetch)
  // Returns null for empty input or while resolving
  const activeDocId = useResolvedDocId(shortCompoundId, metadata);

  // Update URL to use short UUID + decorative path when metadata loads
  useEffect(() => {
    if (!activeDocId || !docUuid || Object.keys(metadata).length === 0) return;
    const expectedUrl = urlForDoc(activeDocId, metadata);
    const currentPath = `/${docUuid}${splatPath ? `/${splatPath}` : ''}`;
    if (currentPath !== expectedUrl) {
      navigate(expectedUrl, { replace: true });
    }
  }, [metadata, activeDocId, docUuid, splatPath, navigate]);

  if (!docUuid) return <DocumentNotFound />;

  // Show loading while resolving short UUID on cold page load
  if (!activeDocId) {
    return (
      <main className="flex-1 flex items-center justify-center bg-gray-50">
        <div className="text-sm text-gray-500">Loading document...</div>
      </main>
    );
  }

  return (
    <RelayProvider key={activeDocId} docId={activeDocId}>
      <AwarenessInitializer />
      <EditorArea currentDocId={activeDocId} />
      <DisconnectionModal />
    </RelayProvider>
  );
}

export function App() {
  const [authError, setAuthError] = useState(false);

  useEffect(() => {
    setAuthErrorCallback(() => setAuthError(true));
  }, []);

  if (!shareToken || !shareRole) {
    return <AccessDenied />;
  }
  if (shareExpired) {
    return <TokenExpired />;
  }
  if (authError) {
    return <TokenInvalid />;
  }
  return <AuthenticatedApp role={shareRole} />;
}

function AuthenticatedApp({ role }: { role: UserRole }) {
  const navigate = useNavigate();
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const sidebarRef = usePanelRef();
  const rightSidebarRef = usePanelRef();
  const discussionRef = usePanelRef();
  const [discussionCollapsed, setDiscussionCollapsed] = useState(true);

  // Use multi-folder metadata hook
  const { metadata, folderDocs, errors } = useMultiFolderMetadata(FOLDERS);
  const folderNames = FOLDERS.map(f => f.name);
  const { recentFiles, pushRecent } = useRecentFiles();
  const justCreatedRef = useRef(false);

  const { ref: outerRef, width: outerWidth } = useContainerWidth();
  const { ref: headerRef, width: headerWidth } = useContainerWidth();
  const headerStage = useHeaderBreakpoints(headerWidth);

  // Pixel minimums
  const LEFT_SIDEBAR_MIN_PX = 200;
  const CONTENT_MIN_PX = 450;
  const RIGHT_SIDEBAR_MIN_PX = 200;

  // Dynamic minSize as percentage
  const leftMinPercent = outerWidth > 0
    ? Math.max((LEFT_SIDEBAR_MIN_PX / outerWidth) * 100, 1)
    : 12;

  // Auto-collapse all sidebars when content would be squeezed
  useAutoCollapse({
    containerWidth: outerWidth,
    panelRefs: [sidebarRef, rightSidebarRef],
    pixelMinimums: [LEFT_SIDEBAR_MIN_PX, RIGHT_SIDEBAR_MIN_PX],
    contentMinPx: CONTENT_MIN_PX,
  });

  const toggleLeftSidebar = useCallback(() => {
    const panel = sidebarRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) {
      panel.expand();
    } else {
      panel.collapse();
    }
  }, [sidebarRef]);

  const toggleRightSidebar = useCallback(() => {
    const panel = rightSidebarRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) {
      panel.expand();
    } else {
      panel.collapse();
    }
  }, [rightSidebarRef]);

  const toggleDiscussion = useCallback(() => {
    const panel = discussionRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) {
      panel.expand();
    } else {
      panel.collapse();
    }
  }, [discussionRef]);

  // Ctrl+O keyboard shortcut to open quick switcher
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'o') {
        e.preventDefault();
        setQuickSwitcherOpen(true);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // Navigate by updating the URL — React Router handles the rest
  // Also tracks recent files at this chokepoint (all navigation paths go through here)
  const onNavigate = useCallback((compoundDocId: string) => {
    const uuid = compoundDocId.slice(RELAY_ID.length + 1);
    pushRecent(uuid);
    const url = urlForDoc(compoundDocId, metadata);
    navigate(url);
  }, [navigate, metadata, pushRecent]);

  const handleQuickSwitcherSelect = useCallback((docId: string) => {
    const compoundId = `${RELAY_ID}-${docId}`;
    onNavigate(compoundId);
  }, [onNavigate]);

  return (
    <AuthProvider role={role}>
      <DisplayNameProvider>
        <DisplayNamePrompt />
        <SidebarContext.Provider value={{ toggleLeftSidebar, leftCollapsed, sidebarRef, rightSidebarRef, rightCollapsed, setRightCollapsed, discussionRef, discussionCollapsed, setDiscussionCollapsed, toggleDiscussion, headerStage }}>
        <NavigationContext.Provider value={{ metadata, folderDocs, folderNames, errors, onNavigate, justCreatedRef }}>
          <div ref={outerRef as RefObject<HTMLDivElement>} className="h-screen flex flex-col bg-gray-50">
            {/* Full-width global header */}
            <header ref={headerRef as RefObject<HTMLElement>} className="flex items-center justify-between px-4 py-2 bg-white shadow-sm border-b border-gray-200">
              <div className="flex items-center gap-6">
                <button
                  onClick={toggleLeftSidebar}
                  title="Toggle left sidebar"
                  className="cursor-pointer text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <path d="M9 3v18" />
                    {!leftCollapsed && <rect x="3" y="3" width="6" height="18" rx="2" fill="currentColor" opacity="0.45" />}
                  </svg>
                </button>
                {(headerStage === 'full' || headerStage === 'compact-toggles') && (
                  <h1 className="text-lg font-semibold text-gray-900">Lens Editor</h1>
                )}
                <div id="header-breadcrumb" />
              </div>
              <div className="flex items-center gap-4">
                <div id="header-controls" className="flex items-center gap-4" />
                {headerStage !== 'overflow' && (
                  <DisplayNameBadge compact={headerStage === 'hide-username'} />
                )}
                <button
                  onClick={toggleRightSidebar}
                  title="Toggle right sidebar"
                  className="cursor-pointer text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <path d="M15 3v18" />
                    {!rightCollapsed && <rect x="15" y="3" width="6" height="18" rx="2" fill="currentColor" opacity="0.45" />}
                  </svg>
                </button>
                <button
                  onClick={toggleDiscussion}
                  title="Toggle discussion"
                  className="cursor-pointer text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    {!discussionCollapsed && <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" fill="currentColor" opacity="0.45" />}
                  </svg>
                </button>
              </div>
            </header>
            <Group id="app-outer" className="flex-1 min-h-0">
              <Panel id="sidebar" panelRef={sidebarRef} defaultSize="18%" minSize={`${leftMinPercent}%`} collapsible collapsedSize="0%" onResize={(size) => setLeftCollapsed(size.asPercentage === 0)}>
                <Sidebar />
              </Panel>
              <Separator className="w-1 bg-gray-200 hover:bg-blue-400 focus:outline-none transition-colors cursor-col-resize" />
              <Panel id="main-content" minSize="30%">
                <Routes>
                  <Route path="/:docUuid/*" element={<DocumentView />} />
                  <Route path="/" element={<Navigate to={`/${DEFAULT_DOC_UUID}`} replace />} />
                </Routes>
              </Panel>
            </Group>
          </div>
          <QuickSwitcher
            open={quickSwitcherOpen}
            onOpenChange={setQuickSwitcherOpen}
            recentFiles={recentFiles}
            onSelect={handleQuickSwitcherSelect}
          />
        </NavigationContext.Provider>
        </SidebarContext.Provider>
      </DisplayNameProvider>
    </AuthProvider>
  );
}
