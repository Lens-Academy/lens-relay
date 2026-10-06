import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import * as Y from 'yjs';
import type { CauseCard, FileStatus } from '../../lib/content-status-api';

const mockFetch = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', mockFetch);
// Node 25 defines a global localStorage without methods; relayHeaders reads it.
vi.stubGlobal('localStorage', { getItem: () => null });

// ContentStatusPanel takes the doc and its provider from the Y.Doc context;
// a test plays the provider, first sync included.
const yjs = vi.hoisted(() => ({ doc: undefined as unknown, provider: undefined as unknown }));
vi.mock('../../lib/ydoc-provider', () => ({
  useYDoc: () => yjs.doc,
  useYjsProvider: () => yjs.provider,
}));

/** A provider before its first sync, as y-sweet's is when a document opens. */
function unsyncedProvider() {
  const listeners = new Set<() => void>();
  return {
    synced: false,
    on: (event: string, listener: () => void) => { if (event === 'synced') listeners.add(listener); },
    off: (_event: string, listener: () => void) => { listeners.delete(listener); },
    sync() {
      this.synced = true;
      listeners.forEach(listener => listener());
    },
  };
}

const NOW = new Date('2026-10-05T14:00:00Z').getTime();

const card: CauseCard = {
  id: 'card-1',
  created_at: '2026-10-05T13:58:00Z',
  commit: 'b'.repeat(40),
  error: { file: 'Lenses/X.md', line: 29, severity: 'error', message: 'start text appears twice' },
  what_broke: 'The excerpt at line 29 of Lenses/X.md no longer works: its start text now appears twice.',
  lost_content: [{ page: 'lens-x', title: 'X' }, { page: 'module-intro', title: 'Introduction' }],
  changes: [{ file: 'articles/a.md', summary: 'Line 12 added: "The cloud provider must verify"' }],
  authors: { names: ['Luc'], unknown: false, files_in_sync: 1, editors_in_sync: 1 },
  certainty: 'this_change',
};

function status(extra: Partial<FileStatus> = {}): FileStatus {
  return {
    path: 'Lenses/X.md',
    content: true,
    processed: { commit: '4d37677ba'.padEnd(40, '0'), commit_time: '2026-10-05T13:59:00Z', processed_at: '2026-10-05T13:59:57Z' },
    published: { state: 'published' },
    issues: [],
    cause_cards: { caused_here: [], broken_by: [] },
    used_by: [],
    ...extra,
  };
}

async function loadPanel() {
  vi.resetModules(); // a fresh "disabled for the session" memory per test
  return import('./ContentStatusPanel');
}

/** The query parameters of the n-th status request. */
function requestParams(n: number): URLSearchParams {
  const url = String(mockFetch.mock.calls[n][0]);
  expect(url.startsWith('/api/content-status?')).toBe(true);
  return new URLSearchParams(url.split('?')[1]);
}

describe('ContentStatusView', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('says whether staging has the text, lists issues by their file field, and the pages that use it', async () => {
    const { ContentStatusView } = await loadPanel();
    render(<ContentStatusView status={status({
      issues: [
        { file: 'Lenses/X.md', line: 14, severity: 'error', category: 'production', message: 'Missing title', suggestion: 'Add title::' },
        { file: 'Lenses/X.md', severity: 'warning', category: 'wip', message: 'Short' },
      ],
      used_by: [
        { page: 'module-intro', title: 'Introduction', reads: 'text' },
        { page: 'course-a', title: 'Course A', reads: 'facts' },
      ],
    })} />);

    // The panel reads staging; learners get production, which changes on promotion.
    expect(screen.getByText('On staging')).toBeInTheDocument();
    expect(screen.getByText('Staging has this text. Production gets it when the file is promoted. Commit 4d37677, processed 3 s ago.')).toBeInTheDocument();
    expect(screen.queryByText(/Published|Learners/)).toBeNull();
    expect(screen.getByText('Issues in this file (2)')).toBeInTheDocument();
    expect(screen.getByText(': Missing title').closest('li')).toHaveTextContent('Error line 14: Missing titleFix: Add title::');
    expect(screen.getByText(': Short').closest('li')).toHaveTextContent('Warning (wip) : Short');
    expect(screen.getByText('Used by 2 pages')).toBeInTheDocument();
    expect(screen.getByText('Introduction').closest('li')).toHaveTextContent('Introduction · uses its text');
    expect(screen.getByText('Course A').closest('li')).toHaveTextContent('Course A · uses facts about it only');
  });

  it.each([
    ['pending', 'Staging is updating'],
    ['behind', 'Not on staging yet'],
    ['missing', 'Not on staging yet'],
  ] as const)('names the %s state in plain words', async (state, label) => {
    const { ContentStatusView } = await loadPanel();
    render(<ContentStatusView status={status({ published: { state } })} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText('No issues in this file.')).toBeInTheDocument();
  });

  it('renders a cause card as what broke, which change, what changed, who and how sure', async () => {
    const { ContentStatusView } = await loadPanel();
    render(<ContentStatusView status={status({ cause_cards: { caused_here: [card], broken_by: [] } })} />);

    expect(screen.getByText('Problems a change to this file caused')).toBeInTheDocument();
    const item = screen.getByText(card.what_broke).closest('li')!;
    expect(item).toHaveTextContent('Missing from 2 pages: X, Introduction.');
    expect(item).toHaveTextContent('articles/a.md: Line 12 added: "The cloud provider must verify"');
    expect(item).toHaveTextContent('Changed by Luc.');
    expect(item).toHaveTextContent('Caused by this change. Since 2 min ago.');
  });

  it('never invents an author', async () => {
    const { CauseCardView } = await loadPanel();
    const authorLine = (authors: CauseCard['authors']) => {
      const { container, unmount } = render(<ul><CauseCardView card={{ ...card, authors }} /></ul>);
      const text = Array.from(container.querySelectorAll('p'), p => p.textContent ?? '')
        .find(line => /^(Changed by|Author unknown)/.test(line));
      unmount();
      return text;
    };

    const unknown = { ...card, authors: { names: [], unknown: true, files_in_sync: 4 }, certainty: 'one_of_these' as const };
    const { container } = render(<ul><CauseCardView card={unknown} /></ul>);
    expect(container).toHaveTextContent('Author unknown. The same sync changed 4 files.');
    expect(container).toHaveTextContent('Caused by one of these changes.');

    expect(authorLine(undefined)).toBe('Author unknown.');
    expect(authorLine({ names: ['Luc', 'ai:opus-5.5:iris'], unknown: false, editors_in_sync: 2 }))
      .toBe('Changed by Luc and ai:opus-5.5:iris.');
    // Iris changed another file in the same sync: the line must not say a
    // second person changed this one.
    expect(authorLine({ names: ['Luc'], unknown: false, files_in_sync: 2, editors_in_sync: 2 }))
      .toBe('Changed by Luc. The same sync changed 2 files by 2 editors.');
    // One change has a known author and another has none: keep the name.
    expect(authorLine({ names: ['Luc'], unknown: true, files_in_sync: 1, editors_in_sync: 1 }))
      .toBe('Changed by Luc. Some of the changes have no known author.');
  });

  it('shows the drafts check when the file has pending suggestions', async () => {
    const { ContentStatusView } = await loadPanel();
    render(<ContentStatusView status={status({
      drafts: {
        pending: 2,
        issues: [{ file: 'Lenses/X.md', line: 3, severity: 'error', message: 'Broken link' }],
        new_elsewhere: [{ file: 'modules/M.md', line: 7, severity: 'warning', message: 'Lens has no title' }],
      },
    })} />);
    expect(screen.getByText('2 pending suggestions: if all are accepted')).toBeInTheDocument();
    expect(screen.getByText(': Broken link').closest('li')).toHaveTextContent('Error line 3: Broken link');
    expect(screen.getByText(': Lens has no title').closest('li')).toHaveTextContent('Warning modules/M.md:7: Lens has no title');
  });
});

describe('ContentStatusSection polling', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  function answer(body: unknown, init?: ResponseInit) {
    return Promise.resolve(Response.json(body, init));
  }

  /** Requests made so far, once the poll in flight (whose SHA-1 runs off the
   * fake clock) has sent its request. */
  async function requestsAfter(n: number) {
    await act(() => vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(n)));
  }

  /** findByText polls with setTimeout, which these tests fake. */
  async function shows(text: string | RegExp) {
    await act(() => vi.waitFor(() => expect(screen.getByText(text)).toBeInTheDocument()));
  }

  it('sends the live text\'s blob id, polls every 5 s while behind and every 30 s once published', async () => {
    const { ContentStatusSection, FAST_POLL_MS, SLOW_POLL_MS } = await loadPanel();
    const { gitBlobId } = await import('../../lib/content-status-api');
    const ytext = new Y.Doc().getText('contents');
    ytext.insert(0, 'hello\n');
    mockFetch
      .mockImplementationOnce(() => answer(status({ published: { state: 'behind' } })))
      .mockImplementation(() => answer(status()));

    render(<ContentStatusSection ytext={ytext} path="Lenses/X.md" />);
    await requestsAfter(1);
    expect(requestParams(0).get('blob')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    expect(requestParams(0).get('path')).toBe('Lenses/X.md');
    expect(requestParams(0).get('drafts')).toBe('0');
    await shows('Not on staging yet');

    await act(() => vi.advanceTimersByTimeAsync(FAST_POLL_MS));
    await requestsAfter(2);
    await shows('On staging');

    await act(() => vi.advanceTimersByTimeAsync(SLOW_POLL_MS - 1000));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await requestsAfter(3);

    // An edit makes the answer stale: the next check comes within 5 s.
    act(() => ytext.insert(6, 'more {++pending++}\n'));
    await act(() => vi.advanceTimersByTimeAsync(FAST_POLL_MS));
    await requestsAfter(4);
    expect(requestParams(3).get('blob')).toBe(await gitBlobId(ytext.toString()));
    expect(requestParams(3).get('drafts')).toBe('1');
  });

  it('hides itself and stops when the server has it switched off', async () => {
    const { ContentStatusSection } = await loadPanel();
    const ytext = new Y.Doc().getText('contents');
    mockFetch.mockImplementation(() => answer({ error: 'off', code: 'disabled' }, { status: 404 }));

    const { container } = render(<ContentStatusSection ytext={ytext} path="Lenses/X.md" />);
    await requestsAfter(1);
    await act(() => vi.advanceTimersByTimeAsync(120_000));

    expect(container).toBeEmptyDOMElement();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('hides itself for files the platform does not build, and stops asking', async () => {
    const { ContentStatusSection } = await loadPanel();
    const ytext = new Y.Doc().getText('contents');
    mockFetch.mockImplementation(() => answer({ path: 'AI Guide/X.md', content: false }));

    const { container } = render(<ContentStatusSection ytext={ytext} path="AI Guide/X.md" />);
    await requestsAfter(1);
    await act(() => vi.advanceTimersByTimeAsync(120_000));

    expect(container).toBeEmptyDOMElement();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('stays hidden while the platform has no status yet, and keeps checking slowly', async () => {
    const { ContentStatusSection, SLOW_POLL_MS } = await loadPanel();
    const ytext = new Y.Doc().getText('contents');
    mockFetch
      .mockImplementationOnce(() => answer({ code: 'not_found' }, { status: 404 }))
      .mockImplementation(() => answer(status()));

    const { container } = render(<ContentStatusSection ytext={ytext} path="Lenses/X.md" />);
    await requestsAfter(1);
    expect(container).toBeEmptyDOMElement();

    await act(() => vi.advanceTimersByTimeAsync(SLOW_POLL_MS));
    await requestsAfter(2);
    await shows('On staging');
  });

  it('asks nothing until the document has synced, then sends the synced text\'s blob id and drafts flag', async () => {
    const { ContentStatusPanel } = await loadPanel();
    const { NavigationContext } = await import('../../contexts/NavigationContext');
    const { gitBlobId } = await import('../../lib/content-status-api');
    const doc = new Y.Doc();
    const provider = unsyncedProvider();
    Object.assign(yjs, { doc, provider });
    mockFetch.mockImplementation(() => answer(status()));
    const navigation = {
      metadata: { '/Lens Edu/Lenses/X.md': { id: 'uuid-x', type: 'markdown' as const, version: 0 } },
      folderDocs: new Map(),
      folderNames: [],
      errors: new Map(),
      onNavigate: () => {},
      justCreatedRef: { current: false },
    };

    render(
      <NavigationContext.Provider value={navigation}>
        <ContentStatusPanel docId={`${'r'.repeat(36)}-uuid-x`} />
      </NavigationContext.Provider>,
    );
    // Until the sync the text is empty, and its blob id would read as "not on staging".
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(mockFetch).not.toHaveBeenCalled();

    const text = 'Synced text {++with a suggestion++}\n';
    act(() => {
      doc.getText('contents').insert(0, text);
      provider.sync();
    });
    await requestsAfter(1);
    expect(requestParams(0).get('path')).toBe('Lenses/X.md');
    expect(requestParams(0).get('blob')).toBe(await gitBlobId(text));
    expect(requestParams(0).get('drafts')).toBe('1');
    await shows('On staging');
  });

  it('lets a check wait while the tab is hidden, and makes it when the tab is shown', async () => {
    const { ContentStatusSection, SLOW_POLL_MS } = await loadPanel();
    const ytext = new Y.Doc().getText('contents');
    ytext.insert(0, 'hello\n');
    mockFetch.mockImplementation(() => answer(status()));
    let hidden = false;
    const visibility = vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    try {
      render(<ContentStatusSection ytext={ytext} path="Lenses/X.md" />);
      await requestsAfter(1);

      hidden = true;
      await act(() => vi.advanceTimersByTimeAsync(4 * SLOW_POLL_MS));
      expect(mockFetch).toHaveBeenCalledTimes(1);

      hidden = false;
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      await requestsAfter(2);
    } finally {
      visibility.mockRestore();
    }
  });
});
