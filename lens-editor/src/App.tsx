import { useState, useCallback, useEffect, useRef, type RefObject } from 'react';
import { Routes, Route, Navigate, useNavigate, useParams, useLocation } from 'react-router-dom';
import { useYDoc, useYjsProvider } from '@y-sweet/react';
import { RelayProvider } from './providers/RelayProvider';
import { Sidebar } from './components/Sidebar';
import { EditorArea } from './components/Layout';
import { ResizeHandle } from './components/Layout/ResizeHandle';
import { AwarenessInitializer } from './components/AwarenessInitializer/AwarenessInitializer';
import { DisconnectionModal } from './components/DisconnectionModal/DisconnectionModal';
import { NavigationContext, useNavigation } from './contexts/NavigationContext';
import { DisplayNameProvider } from './contexts/DisplayNameContext';
import { DisplayNamePrompt } from './components/DisplayNamePrompt';

// The display name feeds collaborative-editing presence. The import tool pages
// (/add-article, /add-video) don't edit documents, and the blocking modal made
// them unusable for fresh sessions and automation — skip it there.
function DisplayNamePromptGate() {
  const { pathname } = useLocation();
  if (pathname === '/add-article' || pathname === '/add-video') return null;
  return <DisplayNamePrompt />;
}
import { SidebarContext } from './contexts/SidebarContext';
import { HeaderActionsProvider, type HeaderCommentsControl } from './contexts/HeaderActionsContext';
import { useMultiFolderMetadata } from './hooks/useMultiFolderMetadata';
import { AuthProvider, useAuth, deriveCapabilities } from './contexts/AuthContext';
import type { UserRole } from './contexts/AuthContext';
import { getShareTokenFromUrl, stripShareTokenFromUrl, decodeRoleFromToken, isTokenExpired, decodeFolderFromToken, isAllFoldersToken } from './lib/auth-share';
import { setShareToken, setAuthErrorCallback } from './lib/auth';
import { urlForDoc } from './lib/url-utils';
import { ReviewPage } from './components/ReviewPage/ReviewPage';
import { AddVideoPage } from './components/AddVideoPage/AddVideoPage';
import { AddArticlePage } from './components/AddArticlePage/AddArticlePage';
import { PromotionRoute } from './components/Promotion/PromotionRoute';
import { MultiDocSectionEditor } from './components/SectionEditor';
import { useDocConnection, waitForProviderSynced } from './hooks/useDocConnection';
import { applySuggestionAction, applySuggestionActions } from './lib/suggestion-actions';
import type { SuggestionItem } from './hooks/useSuggestions';
import { useResolvedDocId } from './hooks/useResolvedDocId';
import { BlobDocumentView } from './components/BlobViewer';
import { ImageDocumentView } from './components/ImageDocumentView';
import { HtmlEditor } from './components/HtmlEditor';
import { findPathByUuid } from './lib/uuid-to-path';
import { QuickSwitcher } from './components/QuickSwitcher';
import { useRecentFiles } from './hooks/useRecentFiles';
import { RELAY_ID, FOLDERS, DEFAULT_DOC_UUID, EDU_FOLDER_ID } from './lib/constants';
import { pickEditor } from './lib/editor-selector';
import { EduEditor } from './components/EduEditor/EduEditor';
import { useContainerWidth } from './hooks/useContainerWidth';
import { usePanelManager, type PanelConfig } from './hooks/usePanelManager';
import { useHeaderBreakpoints } from './hooks/useHeaderBreakpoints';
import { MobileProvider, useMobile } from './contexts/MobileContext';
import { MobileNavBar } from './components/Mobile/MobileNavBar';
import { MobileDrawer } from './components/Mobile/MobileDrawer';
import { useEdgeSwipe } from './hooks/useEdgeSwipe';

// Panel configuration — single source of truth for all panel behavior
// All panels use CSS flexbox with pixel widths.
export const PANEL_CONFIG: PanelConfig = {
  'left-sidebar':   { group: 'app-outer',   minPx: 200, priority: 1 },
  'comment-margin': { group: 'editor-area', minPx: 150, priority: 3 },
  'right-sidebar':  { group: 'editor-area', minPx: 200, priority: 2 },
  'discussion':     { group: 'editor-area', minPx: 250, priority: 4 },
};

// Re-export for consumers that import from App (backwards compat)
export { RELAY_ID, FOLDERS, DEFAULT_DOC_UUID } from './lib/constants';
export type { FolderConfig } from './hooks/useMultiFolderMetadata';

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

function clearTokenAndReload() {
  localStorage.removeItem('lens-share-token');
  window.location.reload();
}

const ACCESS_KEY_MESSAGE_URL =
  'https://discord.com/channels/1440725236843806762/1481581688705519689/1510923946168684624';

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

export function TokenExpired() {
  return (
    <div className="h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center max-w-md px-6">
        <div className="text-5xl mb-4">⏱️</div>
        <h1 className="text-2xl font-semibold text-gray-800 mb-2">Link Expired</h1>
        <p className="text-gray-500">
          Your access key has expired. Get the current access key from{' '}
          <a
            href={ACCESS_KEY_MESSAGE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:text-blue-800 underline"
          >
            this Discord message
          </a>.
        </p>
        <button
          onClick={clearTokenAndReload}
          className="mt-4 text-sm text-blue-600 hover:text-blue-800 underline"
        >
          Clear saved link and try again
        </button>
      </div>
    </div>
  );
}

export function TokenInvalid() {
  const folderName = FOLDERS.find(f => f.id === shareFolderUuid)?.name;
  return (
    <div className="h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center max-w-md px-6">
        <div className="text-5xl mb-4">🔑</div>
        {folderName ? (
          <>
            <h1 className="text-2xl font-semibold text-gray-800 mb-2">Wrong Folder</h1>
            <p className="text-gray-500">
              Your access link is for <strong>{folderName}</strong>, which doesn't include this document.
            </p>
            <a href="/" className="mt-4 inline-block text-sm text-blue-600 hover:text-blue-800 underline">
              Go to {folderName}
            </a>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-semibold text-gray-800 mb-2">Access Link Invalid</h1>
            <p className="text-gray-500">
              Your access key is no longer valid. Get the current access key from{' '}
              <a
                href={ACCESS_KEY_MESSAGE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:text-blue-800 underline"
              >
                this Discord message
              </a>.
            </p>
          </>
        )}
        <br />
        <button
          onClick={clearTokenAndReload}
          className="mt-2 text-sm text-gray-400 hover:text-gray-600 underline"
        >
          Clear saved link and try again
        </button>
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
 * Multi-document section editor view — reads `+`-separated docUuids from URL.
 * Single doc URLs still work (no `+` = array of one).
 */
function MultiDocSectionEditorView() {
  const { docUuid } = useParams<{ docUuid: string }>();
  const { metadata } = useNavigation();
  const navigate = useNavigate();

  if (!docUuid) {
    return (
      <main className="flex-1 flex items-center justify-center bg-gray-50">
        <p className="text-gray-500">Provide document UUID(s): /section-editor/:doc1 or /section-editor/:doc1+:doc2</p>
      </main>
    );
  }

  const docUuids = docUuid.split('+');

  // Resolve each UUID to a full compound doc ID
  // Can't use useResolvedDocId in a loop (hooks rule), so resolve inline from metadata
  const resolvedIds = docUuids.map(uuid => {
    const shortCompoundId = `${RELAY_ID}-${uuid}`;
    // Full-length: 73 chars (36 relay + 1 dash + 36 doc)
    if (shortCompoundId.length >= 73) return shortCompoundId;
    // Short: prefix match against metadata
    const docPrefix = shortCompoundId.slice(37);
    for (const meta of Object.values(metadata)) {
      if (meta.id.startsWith(docPrefix)) {
        return `${RELAY_ID}-${meta.id}`;
      }
    }
    return null;
  });

  const allResolved = resolvedIds.every(id => id != null);

  if (!allResolved) {
    return (
      <main className="flex-1 flex items-center justify-center bg-gray-50">
        <div className="text-sm text-gray-500">Resolving documents...</div>
      </main>
    );
  }

  return <MultiDocSectionEditor
    compoundDocIds={resolvedIds as string[]}
    onOpenInEditor={(docUuid) => navigate(`/${docUuid}`)}
  />;
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
  // docId is null for empty input or while resolving; notFound means the server
  // definitively answered that no such doc exists
  const { docId: activeDocId, notFound } = useResolvedDocId(shortCompoundId, metadata);

  // Update URL to use short UUID + decorative path when metadata loads
  useEffect(() => {
    if (!activeDocId || !docUuid || Object.keys(metadata).length === 0) return;
    const expectedUrl = urlForDoc(activeDocId, metadata);
    const currentPath = `/${docUuid}${splatPath ? `/${splatPath}` : ''}`;
    if (currentPath !== expectedUrl) {
      // Keep query/hash (?pos= navigation targets, #L line anchors) — they are
      // consumed and cleaned up by EditorArea once the editor has synced
      navigate(expectedUrl + window.location.search + window.location.hash, { replace: true });
    }
  }, [metadata, activeDocId, docUuid, splatPath, navigate]);

  // Select editor before early returns to keep hook order stable.
  const uuid = activeDocId ? activeDocId.slice(RELAY_ID.length + 1) : null;
  const filePath = uuid ? findPathByUuid(uuid, metadata) : null;
  const fileEntry = filePath ? metadata[filePath] : null;
  const editorKind = pickEditor(filePath, fileEntry ?? null);

  if (!docUuid) return <DocumentNotFound />;

  // The URL points at a doc that doesn't exist (deleted, or a bad link)
  if (notFound) return <DocumentNotFound />;

  // Show loading while resolving short UUID on cold page load
  if (!activeDocId) {
    return (
      <main className="flex-1 flex items-center justify-center bg-gray-50">
        <div className="text-sm text-gray-500">Loading document...</div>
      </main>
    );
  }

  // Image files — render inline image viewer, no Y.Doc sync
  if (editorKind === 'image' && fileEntry?.hash && filePath) {
    const fileName = filePath.split('/').pop() ?? undefined;
    return <ImageDocumentView docId={activeDocId} hash={fileEntry.hash} fileName={fileName} />;
  }

  // Blob files (proper blob with hash) — render read-only viewer, no Y.Doc sync
  if (editorKind === 'blob' && fileEntry?.hash && filePath) {
    const fileName = filePath.split('/').pop() ?? undefined;
    const folderName = filePath.split('/').filter(Boolean)[0];
    const folderConfig = FOLDERS.find(f => f.name === folderName);
    const folderDocId = folderConfig ? `${RELAY_ID}-${folderConfig.id}` : '';
    return <BlobDocumentView docId={activeDocId} hash={fileEntry.hash} folderDocId={folderDocId} fileName={fileName} />;
  }

  if (editorKind === 'html') {
    return (
      <RelayProvider key={activeDocId} docId={activeDocId}>
        <AwarenessInitializer />
        <HtmlEditorMount />
        <DisconnectionModal />
      </RelayProvider>
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

function HtmlEditorMount() {
  const ydoc = useYDoc();
  const provider = useYjsProvider();
  const { canWrite } = useAuth();
  const ytext = ydoc.getText('contents');
  return <HtmlEditor ytext={ytext} awareness={provider.awareness} readOnly={!canWrite} />;
}

function EduEditorView() {
  const { docUuid } = useParams<{ docUuid: string }>();
  const { metadata } = useNavigation();

  if (!docUuid) {
    return (
      <main className="flex-1 flex items-center justify-center bg-gray-50">
        <p className="text-gray-500">Provide a module UUID: /edu/:moduleDocId</p>
      </main>
    );
  }

  const shortCompoundId = `${RELAY_ID}-${docUuid}`;
  let resolvedId: string | null = null;

  if (shortCompoundId.length >= 73) {
    resolvedId = shortCompoundId;
  } else {
    const docPrefix = shortCompoundId.slice(37);
    for (const meta of Object.values(metadata)) {
      if (meta.id.startsWith(docPrefix)) {
        resolvedId = `${RELAY_ID}-${meta.id}`;
        break;
      }
    }
  }

  if (!resolvedId) {
    return (
      <main className="flex-1 flex items-center justify-center bg-gray-50">
        <div className="text-sm text-gray-500">Resolving module document...</div>
      </main>
    );
  }

  const docUuidFull = resolvedId.slice(RELAY_ID.length + 1);
  const sourcePath = Object.entries(metadata).find(([, m]) => m.id === docUuidFull)?.[0] ?? '';

  return <EduEditor moduleDocId={resolvedId} sourcePath={sourcePath} />;
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
  return (
    <MobileProvider>
      <AuthenticatedApp role={shareRole} folderUuid={shareFolderUuid} isAllFolders={shareIsAllFolders} shareToken={shareToken} />
    </MobileProvider>
  );
}

function ReviewPageWithActions({ folderIds, folders, relayId }: { folderIds: string[]; folders: { id: string; name: string }[]; relayId: string }) {
  const { getOrConnect, disconnect, disconnectAll } = useDocConnection();

  useEffect(() => disconnectAll, [disconnectAll]);

  const handleAction = async (docId: string, suggestion: SuggestionItem, action: 'accept' | 'reject') => {
    const { doc, provider } = await getOrConnect(docId);
    applySuggestionAction(doc, suggestion, action);
    await waitForProviderSynced(provider);
  };

  // Whole-file batches: one transaction and one sync round-trip per document
  // instead of one per suggestion, so bulk accepts finish in seconds. The doc
  // is disconnected right after syncing — a bulk run over many files must not
  // accumulate one open websocket + doc copy per file.
  const handleFileAction = async (docId: string, suggestions: SuggestionItem[], action: 'accept' | 'reject') => {
    if (suggestions.length === 0) return { applied: [], failed: [] };
    const { doc, provider } = await getOrConnect(docId);
    try {
      const result = applySuggestionActions(doc, suggestions, action);
      if (result.applied.length > 0) {
        await waitForProviderSynced(provider);
      }
      return result;
    } finally {
      disconnect(docId);
    }
  };

  return (
    <ReviewPage
      folderIds={folderIds}
      folders={folders}
      relayId={relayId}
      onAction={handleAction}
      onFileAction={handleFileAction}
    />
  );
}

/**
 * Landing page shown when no document is selected.
 * Shows a prompt to select a file from the sidebar or quick switcher.
 */
function DefaultLanding() {
  const { isMobile } = useMobile();
  return (
    <main className="flex-1 flex items-center justify-center bg-gray-50 pt-32 max-md:pt-8">
      <div className="text-center max-w-md px-6">
        <h1 className="text-xl font-semibold text-gray-800 mb-3">Select a document</h1>
        {isMobile ? (
          <p className="text-gray-500">
            Tap <span aria-hidden="true">☰</span> below to browse files, or the magnifier to search.
          </p>
        ) : (
          <p className="text-gray-500">
            Choose a file from the sidebar, or press{' '}
            <kbd className="px-1.5 py-0.5 text-xs font-mono bg-gray-100 border border-gray-300 rounded">Ctrl+O</kbd>
            {' '}to open the quick switcher.
          </p>
        )}
      </div>
    </main>
  );
}

function AuthenticatedApp({ role, folderUuid, isAllFolders, shareToken }: { role: UserRole; folderUuid: string | null; isAllFolders: boolean; shareToken: string }) {
  const navigate = useNavigate();
  const { isMobile, activeDrawer, closeDrawer, openDrawer, docPanelsAvailable } = useMobile();

  // Obsidian-style swipes to open the drawers (buttons still work too)
  useEdgeSwipe({
    enabled: isMobile && activeDrawer === null,
    onSwipeRight: useCallback(() => openDrawer('left'), [openDrawer]),
    onSwipeLeft: useCallback(() => {
      if (docPanelsAvailable) openDrawer('right');
    }, [openDrawer, docPanelsAvailable]),
  });

  // This component renders AuthProvider, so it can't consume useAuth() itself.
  const { canEdit } = deriveCapabilities(role);

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
  // Note: open mobile drawers dismiss themselves on route change
  // (MobileContext watches location), so navigation needn't close them here.
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
  const [headerCommentsControl, setHeaderCommentsControl] = useState<HeaderCommentsControl | null>(null);
  const commentsOpen = headerCommentsControl?.isOpen ?? !commentMarginCollapsed;
  const commentsTitle = headerCommentsControl?.title ?? 'Toggle comments';
  const handleToggleComments = headerCommentsControl?.onToggle ?? (() => manager.toggle('comment-margin'));

  return (
    <AuthProvider role={role} folderUuid={folderUuid} isAllFolders={isAllFolders}>
      <DisplayNameProvider>
        <DisplayNamePromptGate />
        <SidebarContext.Provider value={{ manager, headerStage }}>
          <HeaderActionsProvider onCommentsControlChange={setHeaderCommentsControl}>
            <NavigationContext.Provider value={{ metadata, folderDocs, folderNames, errors, onNavigate, justCreatedRef }}>
          <div ref={outerRef as RefObject<HTMLDivElement>} className="h-dvh flex flex-col bg-gray-50 overflow-hidden">
            {/* Full-width global header */}
            <header ref={headerRef as RefObject<HTMLElement>} className="flex items-center justify-between px-4 py-2 bg-[#f6f6f6] border-b border-gray-200 min-w-0 overflow-hidden">
              <div className="flex items-center gap-6 min-w-0">
                {!isMobile && <button
                  onClick={() => manager.toggle('left-sidebar')}
                  title="Toggle left sidebar"
                  className="cursor-pointer text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <path d="M9 3v18" />
                    {!leftCollapsed && <rect x="3" y="3" width="6" height="18" rx="2" fill="currentColor" opacity="0.45" />}
                  </svg>
                </button>}
                {(headerStage === 'full' || headerStage === 'compact-toggles') && (
                  <h1 className="text-lg font-semibold text-gray-900">Lens Editor</h1>
                )}
                <div id="header-breadcrumb" />
              </div>
              <div className="flex items-center gap-4 flex-shrink-0">
                <div id="header-controls" className="flex items-center gap-4" />
                {/* Stays visible on mobile when a page registers its own
                    comments control (HtmlEditor) — the bottom bar only
                    covers EditorArea's comment sheet */}
                {(!isMobile || headerCommentsControl != null) && <button
                  onClick={handleToggleComments}
                  title={commentsTitle}
                  className="cursor-pointer text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    {commentsOpen && <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" fill="currentColor" opacity="0.45" />}
                  </svg>
                </button>}
                {!isMobile && <button
                  onClick={() => manager.toggle('right-sidebar')}
                  title="Toggle right sidebar"
                  className="cursor-pointer text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <path d="M15 3v18" />
                    {!rightCollapsed && <rect x="15" y="3" width="6" height="18" rx="2" fill="currentColor" opacity="0.45" />}
                  </svg>
                </button>}
                <div id="header-discussion-toggle" className="flex" />
              </div>
            </header>
            <div id="app-outer" className="flex-1 flex min-h-0">
              {!isMobile && (
                <>
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
                </>
              )}
              <div className="flex-1 min-w-0">
                <Routes>
                  <Route path="/review" element={
                    canEdit
                      ? <ReviewPageWithActions folderIds={accessibleFolders.map(f => `${RELAY_ID}-${f.id}`)} folders={accessibleFolders.map(f => ({ id: `${RELAY_ID}-${f.id}`, name: f.name }))} relayId={RELAY_ID} />
                      : <DefaultLanding />
                  } />
                  <Route path="/add-video" element={
                    canEdit && (isAllFolders || folderUuid === EDU_FOLDER_ID)
                      ? <AddVideoPage shareToken={shareToken} />
                      : <DefaultLanding />
                  } />
                  <Route path="/add-article" element={
                    canEdit && (isAllFolders || folderUuid === EDU_FOLDER_ID)
                      ? <AddArticlePage shareToken={shareToken} />
                      : <DefaultLanding />
                  } />
                  <Route path="/edu/:docUuid" element={<EduEditorView />} />
                  <Route path="/section-editor/:docUuid" element={<MultiDocSectionEditorView />} />
                  <Route path="/promote" element={<PromotionRoute />} />
                  <Route path="/:docUuid/*" element={<DocumentView />} />
                  <Route path="/" element={<DefaultLanding />} />
                </Routes>
              </div>
            </div>
            {isMobile && <MobileNavBar onOpenQuickSwitcher={() => setQuickSwitcherOpen(true)} />}
          </div>
          {isMobile && (
            <MobileDrawer
              open={activeDrawer === 'left'}
              onClose={closeDrawer}
              side="left"
              label="Files"
            >
              <div className="h-full">
                <Sidebar />
              </div>
            </MobileDrawer>
          )}
          <QuickSwitcher
            open={quickSwitcherOpen}
            onOpenChange={setQuickSwitcherOpen}
            recentFiles={recentFiles}
            onSelect={handleQuickSwitcherSelect}
          />
            </NavigationContext.Provider>
          </HeaderActionsProvider>
        </SidebarContext.Provider>
      </DisplayNameProvider>
    </AuthProvider>
  );
}
