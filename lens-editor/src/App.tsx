import { useState, useCallback, useEffect, useRef, type RefObject } from 'react';
import { Routes, Route, Navigate, useNavigate, useParams } from 'react-router-dom';
import { RelayProvider } from './providers/RelayProvider';
import { Sidebar } from './components/Sidebar';
import { EditorArea } from './components/Layout';
import { ResizeHandle } from './components/Layout/ResizeHandle';
import { AwarenessInitializer } from './components/AwarenessInitializer/AwarenessInitializer';
import { DisconnectionModal } from './components/DisconnectionModal/DisconnectionModal';
import { NavigationContext, useNavigation } from './contexts/NavigationContext';
import { DisplayNameProvider } from './contexts/DisplayNameContext';
import { DisplayNamePrompt } from './components/DisplayNamePrompt';
import { SidebarContext } from './contexts/SidebarContext';
import { useMultiFolderMetadata, type FolderConfig } from './hooks/useMultiFolderMetadata';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import type { UserRole } from './contexts/AuthContext';
import { getShareTokenFromUrl, stripShareTokenFromUrl, decodeRoleFromToken, isTokenExpired, decodeFolderFromToken, isAllFoldersToken } from './lib/auth-share';
import { setShareToken, setAuthErrorCallback } from './lib/auth';
import { urlForDoc } from './lib/url-utils';
import { ReviewPage } from './components/ReviewPage/ReviewPage';
import { AddVideoPage } from './components/AddVideoPage/AddVideoPage';
import { SectionEditor } from './components/SectionEditor';
import { useDocConnection } from './hooks/useDocConnection';
import { applySuggestionAction } from './lib/suggestion-actions';
import type { SuggestionItem } from './hooks/useSuggestions';
import { useResolvedDocId } from './hooks/useResolvedDocId';
import { BlobDocumentView } from './components/BlobViewer';
import { findPathByUuid } from './lib/uuid-to-path';
import { QuickSwitcher } from './components/QuickSwitcher';
import { useRecentFiles } from './hooks/useRecentFiles';
import { useContainerWidth } from './hooks/useContainerWidth';
import { usePanelManager, type PanelConfig } from './hooks/usePanelManager';
import { useHeaderBreakpoints } from './hooks/useHeaderBreakpoints';

// Panel configuration — single source of truth for all panel behavior
// All panels use CSS flexbox with pixel widths.
export const PANEL_CONFIG: PanelConfig = {
  'left-sidebar':   { group: 'app-outer',   minPx: 200, maxPx: 250, priority: 1 },
  'comment-margin': { group: 'editor-area', minPx: 150, maxPx: 250, priority: 3 },
  'right-sidebar':  { group: 'editor-area', minPx: 200, maxPx: 250, priority: 2 },
  'discussion':     { group: 'editor-area', minPx: 250, maxPx: 270, priority: 4 },
};

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
const shareFolderUuid: string | null = shareToken ? decodeFolderFromToken(shareToken) : null;
const shareIsAllFolders: boolean = shareFolderUuid ? isAllFoldersToken(shareFolderUuid) : false;

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
          Your share link has expired. Check{' '}
          <a
            href="https://discord.com/channels/1440725236843806762/1464359318865448970"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:text-blue-800 underline"
          >
            #lens-internal
          </a>{' '}
          for a current editing link.
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
          Your access link is no longer valid. Check{' '}
          <a
            href="https://discord.com/channels/1440725236843806762/1464359318865448970"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:text-blue-800 underline"
          >
            #lens-internal
          </a>{' '}
          for a current editing link.
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
 * Section editor view — reads docUuid from URL, wraps SectionEditor with RelayProvider.
 */
function SectionEditorView() {
  const { docUuid } = useParams<{ docUuid: string }>();
  const { metadata } = useNavigation();
  const navigate = useNavigate();

  const shortCompoundId = docUuid ? `${RELAY_ID}-${docUuid}` : '';
  const activeDocId = useResolvedDocId(shortCompoundId, metadata);

  if (!docUuid) {
    return (
      <main className="flex-1 flex items-center justify-center bg-gray-50">
        <p className="text-gray-500">Provide a document UUID: /section-editor/:docUuid</p>
      </main>
    );
  }

  if (!activeDocId) {
    return (
      <main className="flex-1 flex items-center justify-center bg-gray-50">
        <div className="text-sm text-gray-500">Resolving document...</div>
      </main>
    );
  }

  return (
    <RelayProvider key={activeDocId} docId={activeDocId}>
      <AwarenessInitializer />
      <SectionEditor onOpenInEditor={() => navigate(`/${docUuid}`)} />
    </RelayProvider>
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

  // Check if this is a blob file — must be before early returns
  const uuid = activeDocId ? activeDocId.slice(RELAY_ID.length + 1) : null;
  const filePath = uuid ? findPathByUuid(uuid, metadata) : null;
  const fileEntry = filePath ? metadata[filePath] : null;
  const isBlobFile = fileEntry?.type === 'file' && fileEntry?.hash;

  if (!docUuid) return <DocumentNotFound />;

  // Show loading while resolving short UUID on cold page load
  if (!activeDocId) {
    return (
      <main className="flex-1 flex items-center justify-center bg-gray-50">
        <div className="text-sm text-gray-500">Loading document...</div>
      </main>
    );
  }

  // Blob files (proper blob with hash) — render read-only viewer, no Y.Doc sync
  if (isBlobFile && fileEntry?.hash && filePath) {
    const fileName = filePath.split('/').pop() ?? undefined;
    const folderName = filePath.split('/').filter(Boolean)[0];
    const folderConfig = FOLDERS.find(f => f.name === folderName);
    const folderDocId = folderConfig ? `${RELAY_ID}-${folderConfig.id}` : '';
    return <BlobDocumentView docId={activeDocId} hash={fileEntry.hash} folderDocId={folderDocId} fileName={fileName} />;
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
  return <AuthenticatedApp role={shareRole} folderUuid={shareFolderUuid} isAllFolders={shareIsAllFolders} shareToken={shareToken} />;
}

function ReviewPageWithActions({ folderIds, folders, relayId }: { folderIds: string[]; folders: { id: string; name: string }[]; relayId: string }) {
  const { getOrConnect, disconnectAll } = useDocConnection();

  useEffect(() => disconnectAll, [disconnectAll]);

  const handleAction = async (docId: string, suggestion: SuggestionItem, action: 'accept' | 'reject') => {
    const doc = await getOrConnect(docId);
    applySuggestionAction(doc, suggestion, action);
  };

  return (
    <ReviewPage
      folderIds={folderIds}
      folders={folders}
      relayId={relayId}
      onAction={handleAction}
    />
  );
}

/**
 * Landing page shown when no document is selected.
 * Shows a prompt to select a file from the sidebar or quick switcher.
 */
function DefaultLanding() {
  return (
    <main className="flex-1 flex items-center justify-center bg-gray-50 pt-32">
      <div className="text-center max-w-md px-6">
        <h1 className="text-xl font-semibold text-gray-800 mb-3">Select a document</h1>
        <p className="text-gray-500">
          Choose a file from the sidebar, or press{' '}
          <kbd className="px-1.5 py-0.5 text-xs font-mono bg-gray-100 border border-gray-300 rounded">Ctrl+O</kbd>
          {' '}to open the quick switcher.
        </p>
      </div>
    </main>
  );
}

function AuthenticatedApp({ role, folderUuid, isAllFolders, shareToken }: { role: UserRole; folderUuid: string | null; isAllFolders: boolean; shareToken: string }) {
  const navigate = useNavigate();

  // Filter folders based on token scope
  const accessibleFolders = isAllFolders
    ? FOLDERS
    : FOLDERS.filter(f => f.id === folderUuid);
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);

  // Unified panel manager — single source of truth for all panel collapse/expand
  const manager = usePanelManager(PANEL_CONFIG);

  // Use multi-folder metadata hook
  const { metadata, folderDocs, errors } = useMultiFolderMetadata(accessibleFolders);
  const folderNames = accessibleFolders.map(f => f.name);
  const { recentFiles, pushRecent } = useRecentFiles();
  const justCreatedRef = useRef(false);

  const { ref: outerRef, width: outerWidth } = useContainerWidth();
  const { ref: headerRef, width: headerWidth } = useContainerWidth();
  const headerStage = useHeaderBreakpoints(headerWidth);

  // Auto-collapse/expand panels based on viewport width
  useEffect(() => {
    manager.autoResize(outerWidth);
  }, [outerWidth, manager.autoResize]);

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

  const { collapsedState } = manager;
  const leftCollapsed = collapsedState['left-sidebar'] ?? false;
  const rightCollapsed = collapsedState['right-sidebar'] ?? false;
  const commentMarginCollapsed = collapsedState['comment-margin'] ?? false;

  return (
    <AuthProvider role={role} folderUuid={folderUuid} isAllFolders={isAllFolders}>
      <DisplayNameProvider>
        <DisplayNamePrompt />
        <SidebarContext.Provider value={{ manager, headerStage }}>
        <NavigationContext.Provider value={{ metadata, folderDocs, folderNames, errors, onNavigate, justCreatedRef }}>
          <div ref={outerRef as RefObject<HTMLDivElement>} className="h-screen flex flex-col bg-gray-50 overflow-hidden">
            {/* Full-width global header */}
            <header ref={headerRef as RefObject<HTMLElement>} className="flex items-center justify-between px-4 py-2 bg-[#f6f6f6] border-b border-gray-200 min-w-0 overflow-hidden">
              <div className="flex items-center gap-6 min-w-0">
                <button
                  onClick={() => manager.toggle('left-sidebar')}
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
                <button
                  onClick={() => manager.toggle('comment-margin')}
                  title="Toggle comments"
                  className="cursor-pointer text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    {!commentMarginCollapsed && <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" fill="currentColor" opacity="0.45" />}
                  </svg>
                </button>
                <button
                  onClick={() => manager.toggle('right-sidebar')}
                  title="Toggle right sidebar"
                  className="cursor-pointer text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <path d="M15 3v18" />
                    {!rightCollapsed && <rect x="15" y="3" width="6" height="18" rx="2" fill="currentColor" opacity="0.45" />}
                  </svg>
                </button>
                <div id="header-discussion-toggle" className="flex" />
              </div>
            </header>
            <div id="app-outer" className="flex-1 flex min-h-0">
              <div
                id="sidebar"
                className="overflow-hidden flex-shrink-0"
                style={{ width: leftCollapsed ? 0 : manager.getWidth('left-sidebar') }}
              >
                <Sidebar />
              </div>
              <ResizeHandle
                orientation="vertical"
                reverse
                onDragStart={() => manager.getWidth('left-sidebar')}
                onDrag={(size) => manager.setWidth('left-sidebar', size)}
                onDragEnd={() => manager.onDragEnd('left-sidebar')}
                disabled={leftCollapsed}
              />
              <div className="flex-1 min-w-0">
                <Routes>
                  <Route path="/review" element={
                    role === 'edit' && isAllFolders
                      ? <ReviewPageWithActions folderIds={accessibleFolders.map(f => `${RELAY_ID}-${f.id}`)} folders={accessibleFolders.map(f => ({ id: `${RELAY_ID}-${f.id}`, name: f.name }))} relayId={RELAY_ID} />
                      : <DefaultLanding />
                  } />
                  <Route path="/add-video" element={
                    role === 'edit' && (isAllFolders || folderUuid === 'ea4015da-24af-4d9d-ac49-8c902cb17121')
                      ? <AddVideoPage shareToken={shareToken} />
                      : <DefaultLanding />
                  } />
                  <Route path="/section-editor/:docUuid" element={<SectionEditorView />} />
                  <Route path="/:docUuid/*" element={<DocumentView />} />
                  <Route path="/" element={<DefaultLanding />} />
                </Routes>
              </div>
            </div>
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
