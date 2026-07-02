import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockRefresh = vi.fn();
const recentTimestamp = Date.now() - 60_000; // 1 minute ago — within default 1h filter

// Default mock: loaded data with one file
function mockLoaded() {
  vi.doMock('../../hooks/useSuggestions', () => ({
    useSuggestions: () => ({
      data: [
        {
          path: 'Notes/Test.md',
          doc_id: 'relay-id-doc-uuid',
          suggestions: [
            {
              type: 'addition' as const,
              content: 'new text',
              old_content: null,
              new_content: null,
              author: 'AI',
              timestamp: recentTimestamp,
              from: 10,
              to: 50,
              raw_markup: `{++{"author":"AI","timestamp":${recentTimestamp}}@@new text++}`,
              context_before: 'before ',
              context_after: ' after',
            },
          ],
        },
      ],
      loading: false,
      error: null,
      refresh: mockRefresh,
    }),
  }));
}

function mockLoading() {
  vi.doMock('../../hooks/useSuggestions', () => ({
    useSuggestions: () => ({
      data: [],
      loading: true,
      error: null,
      refresh: mockRefresh,
    }),
  }));
}

function mockError() {
  vi.doMock('../../hooks/useSuggestions', () => ({
    useSuggestions: () => ({
      data: [],
      loading: false,
      error: 'Network error',
      refresh: mockRefresh,
    }),
  }));
}

function mockEmpty() {
  vi.doMock('../../hooks/useSuggestions', () => ({
    useSuggestions: () => ({
      data: [],
      loading: false,
      error: null,
      refresh: mockRefresh,
    }),
  }));
}

// Helper: find the file header button by the rendered filename (path without .md)
function getFileHeader() {
  // The filename "Test" is rendered in a span inside a button; get the button
  const filenameSpan = screen.getByText('Test');
  return filenameSpan.closest('button')!;
}

describe('ReviewPage', () => {
  beforeEach(() => {
    vi.resetModules();
    mockRefresh.mockClear();
  });

  describe('with loaded data', () => {
    beforeEach(() => mockLoaded());

    it('renders file with suggestion count', async () => {
      const { ReviewPage } = await import('./ReviewPage');
      render(<MemoryRouter><ReviewPage folderIds={['test-folder']} /></MemoryRouter>);
      // Path renders as "Notes/" + "Test" (.md stripped)
      expect(screen.getByText('Test')).toBeTruthy();
      expect(screen.getAllByText(/1 suggestion/).length).toBeGreaterThanOrEqual(1);
    });

    it('shows suggestion content when file is expanded', async () => {
      const { ReviewPage } = await import('./ReviewPage');
      render(<MemoryRouter><ReviewPage folderIds={['test-folder']} /></MemoryRouter>);
      // First file is auto-expanded
      expect(screen.getByText('new text')).toBeTruthy();
    });

    it('shows author badge', async () => {
      const { ReviewPage } = await import('./ReviewPage');
      render(<MemoryRouter><ReviewPage folderIds={['test-folder']} /></MemoryRouter>);
      // First file is auto-expanded; "AI (MCP)" appears in both filter bar and suggestion badge
      expect(screen.getAllByText('AI (MCP)').length).toBeGreaterThanOrEqual(2);
    });

    it('toggles file expansion on click', async () => {
      const { ReviewPage } = await import('./ReviewPage');
      render(<MemoryRouter><ReviewPage folderIds={['test-folder']} /></MemoryRouter>);
      const fileHeader = getFileHeader();
      // First file is auto-expanded on initial load
      expect(screen.getByText('new text')).toBeTruthy();
      // Click to collapse
      fireEvent.click(fileHeader);
      expect(screen.queryByText('new text')).toBeNull();
      // Click to expand again
      fireEvent.click(fileHeader);
      expect(screen.getByText('new text')).toBeTruthy();
    });
  });

  describe('loading state', () => {
    beforeEach(() => mockLoading());

    it('shows loading message', async () => {
      const { ReviewPage } = await import('./ReviewPage');
      render(<MemoryRouter><ReviewPage folderIds={['test-folder']} /></MemoryRouter>);
      expect(screen.getByText(/Scanning documents/)).toBeTruthy();
    });
  });

  describe('error state', () => {
    beforeEach(() => mockError());

    it('shows error message', async () => {
      const { ReviewPage } = await import('./ReviewPage');
      render(<MemoryRouter><ReviewPage folderIds={['test-folder']} /></MemoryRouter>);
      expect(screen.getByText(/Network error/)).toBeTruthy();
    });
  });

  describe('empty state', () => {
    beforeEach(() => mockEmpty());

    it('shows no-suggestions message', async () => {
      const { ReviewPage } = await import('./ReviewPage');
      render(<MemoryRouter><ReviewPage folderIds={['test-folder']} /></MemoryRouter>);
      expect(screen.getByText(/No pending suggestions/)).toBeTruthy();
    });
  });
});

// --- Bulk accept via onFileAction ---

function makeSuggestion(from: number, text: string) {
  return {
    type: 'addition' as const,
    content: text,
    old_content: null,
    new_content: null,
    author: 'AI',
    timestamp: recentTimestamp,
    from,
    to: from + 10,
    raw_markup: `{++{"author":"AI","timestamp":${recentTimestamp}}@@${text}++}`,
    context_before: '',
    context_after: '',
  };
}

function mockTwoFiles() {
  vi.doMock('../../hooks/useSuggestions', () => ({
    useSuggestions: () => ({
      data: [
        { path: 'Notes/One.md', doc_id: 'relay-doc-1', folder_id: 'f1', suggestions: [makeSuggestion(10, 'aaa'), makeSuggestion(50, 'bbb')] },
        { path: 'Notes/Two.md', doc_id: 'relay-doc-2', folder_id: 'f1', suggestions: [makeSuggestion(5, 'ccc'), makeSuggestion(90, 'ddd')] },
      ],
      loading: false,
      error: null,
      refresh: mockRefresh,
    }),
  }));
}

describe('ReviewPage bulk actions', () => {
  beforeEach(() => {
    vi.resetModules();
    mockRefresh.mockClear();
    mockTwoFiles();
  });

  async function renderWithFileAction(onFileAction: import('./ReviewPage').FileActionHandler) {
    const { ReviewPage } = await import('./ReviewPage');
    render(
      <MemoryRouter>
        <ReviewPage folderIds={['f1']} onFileAction={onFileAction} />
      </MemoryRouter>,
    );
  }

  function clickBulkAccept() {
    // Header button reads "Accept Filtered" (author filter auto-seeds to AI)
    fireEvent.click(screen.getByText('Accept Filtered'));
    // Confirm dialog — double-click on purpose: only one run may start
    const confirmButton = screen.getByRole('button', { name: /^Accept \d+ suggestion/ });
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);
  }

  it('calls onFileAction once per file with all its suggestions', async () => {
    // Prevents: bulk accept doing one server round-trip per suggestion
    // (minutes-long "Accept all filtered" with ~100 suggestions, 2026-07-02).
    // Also prevents: confirm-button double-click starting a second concurrent
    // run that re-submits every file.
    const calls: Array<[string, number, string]> = [];
    await renderWithFileAction(async (docId, suggestions, action) => {
      calls.push([docId, suggestions.length, action]);
      return { applied: suggestions, failed: [] };
    });
    clickBulkAccept();
    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls).toContainEqual(['relay-doc-1', 2, 'accept']);
    expect(calls).toContainEqual(['relay-doc-2', 2, 'accept']);
    // Give a potential second (buggy) run a chance to fire, then re-assert
    await new Promise(r => setTimeout(r, 10));
    expect(calls.length).toBe(2);
  });

  it('marks the correct row as not-found when a later suggestion fails in a per-file batch', async () => {
    // Prevents: index-keyed resolved statuses landing on the wrong row after
    // applied suggestions are removed from the list (badge shift)
    await renderWithFileAction(async (_docId, suggestions) =>
      // First suggestion applies, second fails
      ({ applied: suggestions.slice(0, 1), failed: suggestions.slice(1) }),
    );
    // File One is auto-expanded; use its per-file Accept All button
    fireEvent.click(screen.getByTitle('Accept all in file'));
    await waitFor(() => expect(screen.getByText(/No longer found/)).toBeTruthy());
    // The applied row ('aaa') left the list; the failed row ('bbb') remains with the badge
    expect(screen.queryByText('aaa')).toBeNull();
    expect(screen.getByText('bbb')).toBeTruthy();
  });

  it('disables bulk buttons and shows progress while running', async () => {
    // Prevents: double-click starting a second concurrent bulk run while
    // the first is still applying (button gave no feedback at all)
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    await renderWithFileAction(async (_docId, suggestions) => {
      await gate;
      return { applied: suggestions, failed: [] };
    });
    clickBulkAccept();
    const progressButton = await screen.findByRole('button', { name: /Accepting/ });
    expect((progressButton as HTMLButtonElement).disabled).toBe(true);
    release();
    await waitFor(() => expect(screen.queryByText(/Accepting/)).toBeNull());
  });

  it('removes applied suggestions without refetching and keeps failed ones visible', async () => {
    // Prevents: end-of-run refresh() re-showing accepted suggestions from the
    // lagging server-side suggestions index ("reacts weirdly to reloads")
    await renderWithFileAction(async (docId, suggestions) => {
      if (docId === 'relay-doc-1') return { applied: suggestions, failed: [] };
      return { applied: suggestions.slice(1), failed: suggestions.slice(0, 1) };
    });
    clickBulkAccept();
    // File One fully applied -> disappears; file Two keeps 1 failed suggestion
    await waitFor(() => expect(screen.queryByText('One')).toBeNull());
    expect(screen.getByText('Two')).toBeTruthy();
    expect(screen.getByText(/1 of 1 suggestion across 1 of 1 file/)).toBeTruthy();
    // No refetch: the suggestions index lags behind just-applied changes
    expect(mockRefresh).not.toHaveBeenCalled();
    // Failure surfaced
    expect(screen.getByText(/couldn't be applied/)).toBeTruthy();
  });
});

describe('ReviewPage bulk retry', () => {
  beforeEach(() => {
    vi.resetModules();
    mockRefresh.mockClear();
    mockTwoFiles();
  });

  async function renderWithFileAction(onFileAction: import('./ReviewPage').FileActionHandler) {
    const { ReviewPage } = await import('./ReviewPage');
    render(
      <MemoryRouter>
        <ReviewPage folderIds={['f1']} onFileAction={onFileAction} />
      </MemoryRouter>,
    );
  }

  it('retries a file whose handler threw and reports no failures when the retry succeeds', async () => {
    // Prevents: a transient websocket drop mid-run (relay restart, Cloudflare
    // tunnel blip) permanently failing whole files and discarding their edits
    // ("181 suggestions couldn't be applied", 2026-07-02)
    const attempts: Record<string, number> = {};
    await renderWithFileAction(async (docId, suggestions) => {
      attempts[docId] = (attempts[docId] ?? 0) + 1;
      if (docId === 'relay-doc-2' && attempts[docId] === 1) {
        throw new Error('Connection lost');
      }
      return { applied: suggestions, failed: [] };
    });
    fireEvent.click(screen.getByText('Accept Filtered'));
    fireEvent.click(screen.getByRole('button', { name: /^Accept \d+ suggestion/ }));
    await waitFor(() => expect(screen.queryByText(/Accepting/)).toBeNull());
    expect(attempts['relay-doc-2']).toBe(2);
    // Retry succeeded: nothing reported as failed, both files gone from the list
    expect(screen.queryByText(/couldn't be applied/)).toBeNull();
    expect(screen.getByText(/No suggestions match|No pending suggestions/)).toBeTruthy();
  });

  it('reports failures only after the retry also fails', async () => {
    // Prevents: transient-failure retry masking persistent failures
    await renderWithFileAction(async (docId, suggestions) => {
      if (docId === 'relay-doc-2') throw new Error('Connection lost');
      return { applied: suggestions, failed: [] };
    });
    fireEvent.click(screen.getByText('Accept Filtered'));
    fireEvent.click(screen.getByRole('button', { name: /^Accept \d+ suggestion/ }));
    await waitFor(() => expect(screen.queryByText(/Accepting/)).toBeNull());
    expect(screen.getByText(/2 suggestions couldn't be applied/)).toBeTruthy();
  });
});

describe('ReviewPage bulk retry scope', () => {
  beforeEach(() => {
    vi.resetModules();
    mockRefresh.mockClear();
    mockTwoFiles();
  });

  it('does not retry suggestions the handler returned as failed', async () => {
    // Prevents: deterministic failures (markup changed / already resolved)
    // burning a pointless reconnect + apply cycle on the retry pass
    const calls: string[] = [];
    const { ReviewPage } = await import('./ReviewPage');
    render(
      <MemoryRouter>
        <ReviewPage
          folderIds={['f1']}
          onFileAction={async (docId, suggestions) => {
            calls.push(docId);
            return { applied: [], failed: suggestions };
          }}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('Accept Filtered'));
    fireEvent.click(screen.getByRole('button', { name: /^Accept \d+ suggestion/ }));
    await waitFor(() => expect(screen.getByText(/couldn't be applied/)).toBeTruthy());
    // One call per file, no second pass
    expect(calls).toHaveLength(2);
  });
});
