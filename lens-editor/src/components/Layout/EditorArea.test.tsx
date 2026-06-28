// src/components/Layout/EditorArea.test.tsx
/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { EditorArea } from './EditorArea';
import { DisplayNameProvider } from '../../contexts/DisplayNameContext';
import { RELAY_ID } from '../../App';
import { getPromotionStatus } from '../../lib/promotion-api';

const mocks = vi.hoisted(() => ({
  metadata: null as null | Record<string, { id: string; type: 'markdown'; version: number }>,
  auth: {
    canWrite: true,
    canEdit: true,
    role: 'edit' as const,
    folderUuid: null as string | null,
    isAllFolders: true,
  },
}));

const renderWithProviders = (ui: React.ReactElement) =>
  render(
    <MemoryRouter>
      <DisplayNameProvider>{ui}</DisplayNameProvider>
    </MemoryRouter>
  );

// Mock @y-sweet/react to avoid needing a YDocProvider
vi.mock('@y-sweet/react', () => {
  const Y = require('yjs');
  const ydoc = new Y.Doc();
  return { useYDoc: () => ydoc };
});

// Mock the providers that EditorArea needs
vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    metadata: mocks.metadata,
    folderDocs: new Map(),
    folderNames: [],
    errors: new Map(),
    onNavigate: vi.fn(),
    justCreatedRef: { current: false },
  }),
}));

// Mock DocumentTitle to avoid metadata dependency
vi.mock('../DocumentTitle', () => ({
  DocumentTitle: () => <div data-testid="mock-document-title">Title</div>,
}));

// Mock AuthContext used by EditorArea
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => mocks.auth,
}));

vi.mock('../../lib/promotion-api', () => ({
  getPromotionStatus: vi.fn(),
}));

// Mock the Editor component to avoid Y.Doc complexity
vi.mock('../Editor/Editor', () => ({
  Editor: ({ onEditorReady }: { onEditorReady?: (view: unknown) => void }) => {
    // Don't call onEditorReady to keep editorView null (easier to test)
    return <div data-testid="mock-editor">Mock Editor</div>;
  },
}));

// Mock SyncStatus and PresencePanel to avoid Y.js provider dependencies
vi.mock('../SyncStatus/SyncStatus', () => ({
  SyncStatus: () => <div data-testid="mock-sync-status">Synced</div>,
}));

vi.mock('../PresencePanel/PresencePanel', () => ({
  PresencePanel: () => <div data-testid="mock-presence-panel">Presence</div>,
}));

vi.mock('../SuggestionModeToggle/SuggestionModeToggle', () => ({
  SuggestionModeToggle: () => <div data-testid="mock-suggestion-toggle">Suggestion Mode</div>,
}));

vi.mock('../SourceModeToggle/SourceModeToggle', () => ({
  SourceModeToggle: () => <div data-testid="mock-source-toggle">Source Mode</div>,
}));

vi.mock('../DebugYMapPanel', () => ({
  DebugYMapPanel: () => <div data-testid="mock-debug-panel">Debug</div>,
}));

vi.mock('../BacklinksPanel', () => ({
  BacklinksPanel: () => <div data-testid="mock-backlinks-panel" className="backlinks-panel">Backlinks</div>,
}));

vi.mock('../DiscussionPanel', () => ({
  ConnectedDiscussionPanel: () => null,
}));

vi.mock('../DiscussionPanel/useHasDiscussion', () => ({
  useHasDiscussion: () => false,
}));

describe('EditorArea', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.metadata = null;
    mocks.auth = {
      canWrite: true,
      canEdit: true,
      role: 'edit',
      folderUuid: null,
      isAllFolders: true,
    };
    vi.mocked(getPromotionStatus).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders comment margin panel', () => {
    const { container } = renderWithProviders(<EditorArea currentDocId="test-doc" />);

    // Comment margin panel exists (editorView is null so CommentMargin won't render content,
    // but the panel container should exist)
    const main = container.querySelector('main');
    expect(main).toBeInTheDocument();
  });

  it('renders TableOfContents in sidebar', () => {
    const { container } = renderWithProviders(<EditorArea currentDocId="test-doc" />);

    const tocPanel = container.querySelector('.toc-panel');
    expect(tocPanel).toBeInTheDocument();
  });

  it('renders panels with correct layout structure', () => {
    const { container } = renderWithProviders(<EditorArea currentDocId="test-doc" />);

    expect(container.querySelector('.toc-panel')).toBeInTheDocument();

    // Check that main uses resizable panel layout
    const main = container.querySelector('main');
    expect(main).toBeInTheDocument();
  });

  it('places workflow navigation after source controls and before the user badge', () => {
    const headerControls = document.createElement('div');
    headerControls.id = 'header-controls';
    document.body.appendChild(headerControls);

    renderWithProviders(<EditorArea currentDocId="test-doc" />);

    const source = screen.getByTestId('mock-source-toggle');
    const menu = screen.getByRole('button', { name: /open workflows menu/i });
    const presence = screen.getByTestId('mock-presence-panel');

    expect(source.compareDocumentPosition(menu) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(menu.compareDocumentPosition(presence) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    document.body.removeChild(headerControls);
  });

  it('checks production status using the repo-relative path for Lens Edu files', async () => {
    const headerControls = document.createElement('div');
    headerControls.id = 'header-controls';
    document.body.appendChild(headerControls);
    mocks.metadata = {
      '/Lens Edu/Notes.md': { id: 'note-uuid', type: 'markdown', version: 0 },
    };
    vi.mocked(getPromotionStatus).mockResolvedValue({
      path: 'Notes.md',
      oldPath: null,
      status: 'identical',
      additions: 0,
      deletions: 0,
      isBinary: false,
      mainSha: 'main-sha',
    });

    renderWithProviders(<EditorArea currentDocId={`${RELAY_ID}-note-uuid`} />);

    await waitFor(() => {
      expect(getPromotionStatus).toHaveBeenCalledWith('Notes.md');
    });
    expect(await screen.findByRole('button', { name: /identical to production/i })).toBeInTheDocument();

    document.body.removeChild(headerControls);
  });

  it('refreshes production status on an interval while a Lens Edu file is open', async () => {
    vi.useFakeTimers();
    const headerControls = document.createElement('div');
    headerControls.id = 'header-controls';
    document.body.appendChild(headerControls);
    mocks.metadata = {
      '/Lens Edu/Notes.md': { id: 'note-uuid', type: 'markdown', version: 0 },
    };
    vi.mocked(getPromotionStatus).mockResolvedValue({
      path: 'Notes.md',
      oldPath: null,
      status: 'identical',
      additions: 0,
      deletions: 0,
      isBinary: false,
      mainSha: 'main-sha',
    });

    renderWithProviders(<EditorArea currentDocId={`${RELAY_ID}-note-uuid`} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getPromotionStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(getPromotionStatus).toHaveBeenCalledTimes(2);

    document.body.removeChild(headerControls);
  });

  it('does not render production promotion controls outside the Lens Edu promotion scope', async () => {
    const headerControls = document.createElement('div');
    headerControls.id = 'header-controls';
    document.body.appendChild(headerControls);
    mocks.metadata = {
      '/Lens/Notes.md': { id: 'note-uuid', type: 'markdown', version: 0 },
    };

    renderWithProviders(<EditorArea currentDocId={`${RELAY_ID}-note-uuid`} />);

    await waitFor(() => {
      expect(getPromotionStatus).not.toHaveBeenCalled();
    });
    expect(screen.queryByRole('button', { name: /production/i })).not.toBeInTheDocument();

    document.body.removeChild(headerControls);
  });

  it('keeps an open single-file promotion dialog targeted to the selected file after navigation', async () => {
    const user = userEvent.setup();
    const headerControls = document.createElement('div');
    headerControls.id = 'header-controls';
    document.body.appendChild(headerControls);
    mocks.metadata = {
      '/Lens Edu/Notes.md': { id: 'note-uuid', type: 'markdown', version: 0 },
      '/Lens Edu/Other.md': { id: 'other-uuid', type: 'markdown', version: 0 },
    };
    vi.mocked(getPromotionStatus).mockImplementation(async (path: string) => ({
      path,
      oldPath: null,
      status: 'modified',
      additions: path.includes('Other') ? 1 : 4,
      deletions: path.includes('Other') ? 0 : 2,
      isBinary: false,
      mainSha: 'main-sha',
    }));

    const { rerender } = renderWithProviders(<EditorArea currentDocId={`${RELAY_ID}-note-uuid`} />);

    await screen.findByRole('button', { name: /promote to production/i });
    await user.click(screen.getByRole('button', { name: /promote to production/i }));
    await user.click(screen.getByText('This file'));

    expect(within(screen.getByRole('dialog')).getByText('Notes.md')).toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <DisplayNameProvider>
          <EditorArea currentDocId={`${RELAY_ID}-other-uuid`} />
        </DisplayNameProvider>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(getPromotionStatus).toHaveBeenCalledWith('Other.md');
    });

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Notes.md')).toBeInTheDocument();
    expect(within(dialog).queryByText('Other.md')).not.toBeInTheDocument();

    document.body.removeChild(headerControls);
  });
});
