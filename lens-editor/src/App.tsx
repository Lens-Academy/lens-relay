import { useState, useCallback, useEffect, useRef, useMemo, type RefObject } from 'react';
import { Routes, Route, Navigate, useNavigate, useParams } from 'react-router-dom';
import { Group, Panel, Separator, usePanelRef, type GroupImperativeHandle } from 'react-resizable-panels';
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
  const [commentMarginCollapsed, setCommentMarginCollapsed] = useState(false);
  const sidebarRef = usePanelRef();
  const rightSidebarRef = usePanelRef();
  const discussionRef = usePanelRef();
  const [discussionCollapsed, setDiscussionCollapsed] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const desiredCollapsedRef = useRef<Record<string, boolean>>({
    'right-sidebar': false,
    'discussion': true,
    'comment-margin': false,
  });
  const editorAreaGroupRef = useRef<GroupImperativeHandle | null>(null);
  const commentMarginRef = usePanelRef();

  // Default expanded sizes for editor-area panels (percentage of editor-area group)
  const EDITOR_AREA_PANEL_DEFAULTS: Record<string, number> = { 'right-sidebar': 22, 'discussion': 20, 'comment-margin': 16 };

  // Apply desiredCollapsedRef to the editor-area layout atomically via setLayout().
  // Panels marked collapsed → 0%, panels marked expanded → default size, editor absorbs the difference.
  const applyEditorAreaLayout = useCallback(() => {
    const group = editorAreaGroupRef.current;
    if (!group) return;
    const layout = group.getLayout();
    if (!layout) return;

    const corrected = { ...layout };
    let delta = 0; // positive = freed space, negative = needed space

    for (const [id, shouldBeCollapsed] of Object.entries(desiredCollapsedRef.current)) {
      if (shouldBeCollapsed && (corrected[id] ?? 0) > 0) {
        delta += corrected[id];
        corrected[id] = 0;
      } else if (!shouldBeCollapsed && (corrected[id] ?? 0) === 0) {
        const targetSize = EDITOR_AREA_PANEL_DEFAULTS[id] ?? 20;
        corrected[id] = targetSize;
        delta -= targetSize;
      }
    }

    if (delta !== 0) {
      corrected['editor'] = Math.max((corrected['editor'] ?? 0) + delta, 30);
      group.setLayout(corrected);
    }
  }, []);

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
  const DISCUSSION_MIN_PX = 250;

  // Dynamic minSize as percentage
  const leftMinPercent = outerWidth > 0
    ? Math.max((LEFT_SIDEBAR_MIN_PX / outerWidth) * 100, 1)
    : 12;

  // Tiered auto-collapse: discussion collapses first, then sidebars
  // Tier 1: Discussion collapses first (threshold = 250 + 850 = 1100px)
  const discussionCollapseRefs = useMemo(() => [discussionRef], [discussionRef]);
  useAutoCollapse({
    containerWidth: outerWidth,
    panelRefs: discussionCollapseRefs,
    pixelMinimums: [DISCUSSION_MIN_PX],
    contentMinPx: CONTENT_MIN_PX + LEFT_SIDEBAR_MIN_PX + RIGHT_SIDEBAR_MIN_PX,
    onAutoCollapse: () => {
      desiredCollapsedRef.current['discussion'] = true;
      applyEditorAreaLayout();
      return true;
    },
    onAutoExpand: () => {
      desiredCollapsedRef.current['discussion'] = false;
      applyEditorAreaLayout();
      return true; // handled — skip panel.expand() which breaks after setLayout
    },
  });

  // Tier 2: Sidebars collapse second (threshold = 200 + 200 + 450 = 850px)
  const autoCollapseRefs = useMemo(() => [sidebarRef, rightSidebarRef], [sidebarRef, rightSidebarRef]);
  useAutoCollapse({
    containerWidth: outerWidth,
    panelRefs: autoCollapseRefs,
    pixelMinimums: [LEFT_SIDEBAR_MIN_PX, RIGHT_SIDEBAR_MIN_PX],
    contentMinPx: CONTENT_MIN_PX,
    onAutoCollapse: (ref) => {
      if (ref === rightSidebarRef) {
        desiredCollapsedRef.current['right-sidebar'] = true;
        applyEditorAreaLayout();
        return true;
      }
    },
    onAutoExpand: (ref) => {
      if (ref === rightSidebarRef) {
        desiredCollapsedRef.current['right-sidebar'] = false;
        applyEditorAreaLayout();
        return true; // handled — skip panel.expand()
      }
      // Left sidebar is in app-outer Group — panel.expand() works fine there
    },
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
    desiredCollapsedRef.current['right-sidebar'] = !desiredCollapsedRef.current['right-sidebar'];
    applyEditorAreaLayout();
  }, [applyEditorAreaLayout]);

  const toggleDiscussion = useCallback(() => {
    desiredCollapsedRef.current['discussion'] = !desiredCollapsedRef.current['discussion'];
    applyEditorAreaLayout();
  }, [applyEditorAreaLayout]);

  const toggleCommentMargin = useCallback(() => {
    desiredCollapsedRef.current['comment-margin'] = !desiredCollapsedRef.current['comment-margin'];
    applyEditorAreaLayout();
  }, [applyEditorAreaLayout]);

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
        <SidebarContext.Provider value={{ toggleLeftSidebar, leftCollapsed, sidebarRef, rightSidebarRef, rightCollapsed, setRightCollapsed, discussionRef, discussionCollapsed, setDiscussionCollapsed, toggleDiscussion, desiredCollapsedRef, editorAreaGroupRef, applyEditorAreaLayout, toggleCommentMargin, headerStage, commentMarginRef, commentMarginCollapsed, setCommentMarginCollapsed }}>
        <NavigationContext.Provider value={{ metadata, folderDocs, folderNames, errors, onNavigate, justCreatedRef }}>
          <div ref={outerRef as RefObject<HTMLDivElement>} className="h-screen flex flex-col bg-gray-50 overflow-hidden">
            {/* Full-width global header */}
            <header ref={headerRef as RefObject<HTMLElement>} className="flex items-center justify-between px-4 py-2 bg-[#f6f6f6] border-b border-gray-200 min-w-0 overflow-hidden">
              <div className="flex items-center gap-6 min-w-0">
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
              <div className="flex items-center gap-4 flex-shrink-0">
                <div id="header-controls" className="flex items-center gap-4" />
                {headerStage !== 'overflow' && (
                  <DisplayNameBadge compact={headerStage === 'hide-username'} />
                )}
                <button
                  onClick={toggleCommentMargin}
                  title="Toggle comments"
                  className="cursor-pointer text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    {!commentMarginCollapsed && <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" fill="currentColor" opacity="0.45" />}
                  </svg>
                </button>
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
                  className="cursor-pointer text-gray-600 hover:text-gray-700 transition-colors"
                >
                  <svg className="w-[22px] h-[22px]" viewBox="0 0 24 24" fill="currentColor" opacity={discussionCollapsed ? 0.2 : 0.45}>
                    <path d="M19.73 4.87a18.2 18.2 0 0 0-4.6-1.44c-.2.36-.43.85-.59 1.23a16.84 16.84 0 0 0-5.07 0c-.16-.38-.4-.87-.6-1.23a18.17 18.17 0 0 0-4.6 1.44A19.25 19.25 0 0 0 .96 18.06a18.32 18.32 0 0 0 5.63 2.87c.46-.62.86-1.28 1.2-1.98a11.83 11.83 0 0 1-1.89-.91c.16-.12.31-.24.46-.37a12.97 12.97 0 0 0 11.28 0c.15.13.3.25.46.37-.6.36-1.23.67-1.9.92.35.7.75 1.35 1.2 1.97a18.27 18.27 0 0 0 5.63-2.87A19.22 19.22 0 0 0 19.73 4.87ZM8.3 15.12c-1.18 0-2.16-1.1-2.16-2.44 0-1.34.95-2.44 2.16-2.44 1.2 0 2.18 1.1 2.16 2.44 0 1.34-.95 2.44-2.16 2.44Zm7.4 0c-1.18 0-2.16-1.1-2.16-2.44 0-1.34.95-2.44 2.16-2.44 1.2 0 2.18 1.1 2.16 2.44 0 1.34-.96 2.44-2.16 2.44Z" />
                  </svg>
                </button>
              </div>
            </header>
            <Group id="app-outer" className={`flex-1 min-h-0${isDragging ? ' panels-dragging' : ''}`}>
              <Panel id="sidebar" panelRef={sidebarRef} defaultSize="18%" minSize={`${leftMinPercent}%`} collapsible collapsedSize="0%" onResize={(size) => setLeftCollapsed(size.asPercentage === 0)}>
                <Sidebar />
              </Panel>
              <Separator className="w-px bg-gray-200 hover:bg-blue-400 focus:outline-none transition-colors cursor-col-resize" onDragging={setIsDragging} />
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
