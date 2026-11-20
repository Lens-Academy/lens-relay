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
import { useYDoc as sharedTestDoc } from '../../lib/ydoc-provider';

const mocks = vi.hoisted(() => ({
  metadata: null as null | Record<string, { id: string; type: 'markdown'; version: number }>,
  auth: {
    canWrite: true,
    canEdit: true,
    canPromote: true,
    role: 'edit' as const,
    folderUuid: null as string | null,
    isAllFolders: true,
  },
  sourceBarThrows: false,
}));

const renderWithProviders = (ui: React.ReactElement) =>
  render(
    <MemoryRouter>
      <DisplayNameProvider>{ui}</DisplayNameProvider>
    </MemoryRouter>
  );

// Mock lib/ydoc-provider (our YDocProvider) to avoid needing a YDocProvider
vi.mock('../../lib/ydoc-provider', () => {
  const Y = require('yjs');
  const ydoc = new Y.Doc();
  return { useYDoc: () => ydoc, useYjsProvider: () => ({ awareness: null }) };
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
  Editor: ({ initialSuggestionMode }: { initialSuggestionMode?: boolean }) => {
    // Don't call onEditorReady to keep editorView null (easier to test)
    return <div data-testid="mock-editor" data-initial-suggestion-mode={String(initialSuggestionMode)}>Mock Editor</div>;
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
  SuggestionModeToggle: ({ onSuggestionModeChange }: { onSuggestionModeChange?: (next: boolean) => void }) => (
    <button data-testid="mock-suggestion-toggle" onClick={() => onSuggestionModeChange?.(true)}>Suggestion Mode</button>
  ),
}));

vi.mock('../SourceModeToggle/SourceModeToggle', () => ({
  SourceModeToggle: () => <div data-testid="mock-source-toggle">Source Mode</div>,
  SourceModeChip: () => null,
}));

vi.mock('../DebugYMapPanel', () => ({
  DebugYMapPanel: () => <div data-testid="mock-debug-panel">Debug</div>,
}));

vi.mock('../BacklinksPanel', () => ({
  BacklinksPanel: () => <div data-testid="mock-backlinks-panel" className="backlinks-panel">Backlinks</div>,
}));

vi.mock('../ContentStatus/ContentStatusPanel', () => ({
  ContentStatusPanel: () => <div data-testid="mock-content-status-panel" />,
}));

vi.mock('../DiscussionPanel', () => ({
  ConnectedDiscussionPanel: () => null,
}));

vi.mock('../DiscussionPanel/useHasDiscussion', () => ({
  useHasDiscussion: () => false,
}));

vi.mock('../SourceLinksBar/useSourceLinks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../SourceLinksBar/useSourceLinks')>();
  return {
    useSourceLinks: (options: Parameters<typeof actual.useSourceLinks>[0]) => {
      if (mocks.sourceBarThrows) throw new Error('A bug in the sources bar');
      return actual.useSourceLinks(options);
    },
  };
});

describe('EditorArea', () => {
  beforeEach(() => {
    vi.useRealTimers();
    localStorage.removeItem('lens-editor:suggestion-mode');
    mocks.metadata = null;
    mocks.auth = {
      canWrite: true,
      canEdit: true,
      canPromote: true,
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

  it('restores suggesting mode when the editor remounts for another document', async () => {
    const user = userEvent.setup();
    const headerControls = document.createElement('div');
    headerControls.id = 'header-controls';
    document.body.appendChild(headerControls);
    const firstDocument = renderWithProviders(<EditorArea currentDocId="first-doc" />);

    await user.click(screen.getAllByTestId('mock-suggestion-toggle')[0]);
    firstDocument.unmount();

    renderWithProviders(<EditorArea currentDocId="second-doc" />);

    expect(screen.getByTestId('mock-editor')).toHaveAttribute('data-initial-suggestion-mode', 'true');
    document.body.removeChild(headerControls);
  });

  it('has the backlinks in the right sidebar, and the table of contents on the page', () => {
    const { container } = renderWithProviders(<EditorArea currentDocId="test-doc" />);

    const sidebar = container.querySelector('#right-sidebar');
    expect(sidebar?.querySelector('[data-testid="mock-backlinks-panel"]')).toBeInTheDocument();
    expect(sidebar?.querySelector('.toc-panel')).toBeNull();
  });

  it('renders panels with correct layout structure', () => {
    const { container } = renderWithProviders(<EditorArea currentDocId="test-doc" />);

    // The page area, a container the table of contents' dashes measure
    expect(container.querySelector('.lens-page-area')).toBeInTheDocument();

    // Check that main uses resizable panel layout
    const main = container.querySelector('main');
    expect(main).toBeInTheDocument();
  });

  it('keeps the mode and who is here in the top bar, and the page settings in the page menu', async () => {
    const user = userEvent.setup();
    const headerControls = document.createElement('div');
    headerControls.id = 'header-controls';
    const headerMenu = document.createElement('div');
    headerMenu.id = 'header-menu';
    document.body.append(headerControls, headerMenu);

    renderWithProviders(<EditorArea currentDocId="test-doc" />);

    expect(headerControls).toContainElement(screen.getByTestId('mock-presence-panel'));
    expect(headerControls).toContainElement(screen.getByTestId('mock-suggestion-toggle'));
    const menuButton = screen.getByRole('button', { name: /open workflows menu/i });
    expect(headerMenu).toContainElement(menuButton);
    expect(screen.queryByTestId('mock-source-toggle')).toBeNull();

    await user.click(menuButton);
    expect(screen.getByTestId('mock-source-toggle')).toBeInTheDocument();
    expect(screen.getByRole('menuitemcheckbox', { name: /spellcheck/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /authorship/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /review suggestions/i })).toBeInTheDocument();

    headerControls.remove();
    headerMenu.remove();
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

describe('EditorArea sources bar', () => {
  const DOC_UUID = 'c0000001-0000-4000-8000-000000000001';
  const DOC_ID = `${RELAY_ID}-${DOC_UUID}`;
  const LINK = 'https://example.com/post';
  const REGION = { name: 'Sources on this page' };
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const { urls } = JSON.parse(String(init?.body)) as { urls: string[] };
    return new Response(JSON.stringify({
      ready: true,
      results: urls.map((url) => ({ url, status: 'queued', id: 'j1' })),
      links: urls.map((url) => ({ url, key: url, kind: 'article', state: 'new' })),
      queue: { workers: 2, avg_job_minutes: 4, queued: 0, processing: 0 },
    }));
  });

  function setText(text: string) {
    const contents = sharedTestDoc().getText('contents');
    contents.delete(0, contents.length);
    contents.insert(0, text);
  }

  function renderArea(path: string) {
    mocks.metadata = { [path]: { id: DOC_UUID, type: 'markdown', version: 0 } };
    return renderWithProviders(<EditorArea currentDocId={DOC_ID} />);
  }

  beforeEach(() => {
    mocks.sourceBarThrows = false;
    mocks.metadata = null;
    mocks.auth = {
      canWrite: true,
      canEdit: true,
      canPromote: true,
      role: 'edit',
      folderUuid: null,
      isAllFolders: true,
    };
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    localStorage.clear();
    vi.mocked(getPromotionStatus).mockResolvedValue({ state: 'clean' } as never);
    setText(`See ${LINK}`);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setText('');
  });

  it('floats a page\'s sources over the top of the page, taking up no room', async () => {
    renderArea('/Lens/Notes/page.md');
    const bar = await screen.findByRole('region', REGION);
    expect(within(bar).getByText("example.com/post isn't in the library yet.")).toBeInTheDocument();
    // Outside the scroller, so it stays in view from 300 lines down
    expect(bar.compareDocumentPosition(screen.getByTestId('mock-editor')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const wrapper = bar.parentElement as HTMLElement;
    expect(wrapper.className).toContain('h-0');
    expect(wrapper.className).toContain('absolute');
    // In the page area, where the paste prompt and menus can go over it
    expect(wrapper.parentElement?.className).toContain('lens-page-area');
  });

  it('passes Suggesting mode down', async () => {
    localStorage.setItem('lens-editor:suggestion-mode', 'true');
    renderArea('/Lens/Notes/page.md');
    const bar = await screen.findByRole('region', REGION);
    await userEvent.click(within(bar).getByRole('button', { name: 'Import and link' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)) as { linkBack: { protectHuman?: boolean } };
    expect(body.linkBack.protectHuman).toBe(true);
    localStorage.removeItem('lens-editor:suggestion-mode');
  });

  it('asks nothing for someone who can only suggest', async () => {
    mocks.auth = { ...mocks.auth, canEdit: false };
    renderArea('/Lens/Notes/page.md');
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', REGION)).not.toBeInTheDocument();
  });

  it('asks nothing for a link scoped to one folder other than Lens Edu', async () => {
    mocks.auth = { ...mocks.auth, isAllFolders: false, folderUuid: 'some-other-folder' };
    renderArea('/Lens/Notes/page.md');
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks nothing on a Lens Edu page', async () => {
    renderArea('/Lens Edu/Lenses/page.md');
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', REGION)).not.toBeInTheDocument();
  });

  it('keeps a crash in the bar away from the editor', async () => {
    mocks.sourceBarThrows = true;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderArea('/Lens/Notes/page.md');
    expect(screen.getByTestId('mock-editor')).toBeInTheDocument();
    expect(screen.getByText(/Sources could not be shown/)).toBeInTheDocument();
    consoleError.mockRestore();
  });
});
