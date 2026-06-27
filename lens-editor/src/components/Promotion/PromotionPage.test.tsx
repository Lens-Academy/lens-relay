/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import * as Y from 'yjs';
import { NavigationContext } from '../../contexts/NavigationContext';
import type { FolderMetadata } from '../../hooks/useFolderMetadata';
import { PromotionPage } from './PromotionPage';
import { createPromotionPr, getPromotionChanges, getPromotionDiff } from '../../lib/promotion-api';

vi.mock('../../lib/promotion-api', () => ({
  getPromotionChanges: vi.fn(),
  getPromotionDiff: vi.fn(),
  createPromotionPr: vi.fn(),
}));

const files = [
  {
    path: 'Notes.md',
    oldPath: null,
    status: 'modified' as const,
    additions: 3,
    deletions: 1,
    isBinary: false,
  },
  {
    path: 'Other.md',
    oldPath: null,
    status: 'added' as const,
    additions: 9,
    deletions: 0,
    isBinary: false,
  },
];

const metadata: FolderMetadata = {
  '/Lens Edu/Notes.md': {
    id: '11111111-1111-4111-8111-111111111111',
    type: 'markdown',
    version: 1,
  },
  '/Lens Edu/Other.md': {
    id: '22222222-2222-4222-8222-222222222222',
    type: 'markdown',
    version: 1,
  },
};

function renderPromotionPage(initialEntry = '/promote') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <NavigationContext.Provider
        value={{
          metadata,
          folderDocs: new Map<string, Y.Doc>(),
          folderNames: ['Lens Edu'],
          errors: new Map<string, Error>(),
          onNavigate: vi.fn(),
          justCreatedRef: { current: false },
        }}
      >
        <PromotionPage />
      </NavigationContext.Provider>
    </MemoryRouter>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('PromotionPage', () => {
  beforeEach(() => {
    vi.mocked(getPromotionChanges).mockReset();
    vi.mocked(getPromotionDiff).mockReset();
    vi.mocked(createPromotionPr).mockReset();
    vi.mocked(getPromotionChanges).mockResolvedValue({
      mainSha: 'main-sha',
      generatedAt: '2026-06-27T00:00:00Z',
      files,
    });
  });

  it('preselects path from the query string after loading', async () => {
    renderPromotionPage('/promote?path=%2FLens%20Edu%2FNotes.md');

    expect(screen.getByText('Loading production differences...')).toBeInTheDocument();

    const notesCheckbox = await screen.findByRole('checkbox', { name: /Notes\.md/ });
    expect(notesCheckbox).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Other\.md/ })).not.toBeChecked();
  });

  it('creates a promotion PR for selected files using only selected paths', async () => {
    const user = userEvent.setup();
    vi.mocked(createPromotionPr).mockResolvedValue({
      branch: 'promote/notes',
      prNumber: 42,
      prUrl: 'https://github.com/Lens-Academy/lens-relay/pull/42',
      mainSha: 'main-sha',
      autoMergeEnabled: true,
    });
    renderPromotionPage('/promote?path=%2FLens%20Edu%2FNotes.md');

    await user.click(await screen.findByRole('button', { name: 'Create promotion PR' }));

    await waitFor(() => {
      expect(createPromotionPr).toHaveBeenCalledWith({ paths: ['Notes.md'] });
    });
    expect(Object.keys(vi.mocked(createPromotionPr).mock.calls[0][0])).toEqual(['paths']);
    expect(await screen.findByText('Pull request created')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Pull request #42/ })).toHaveAttribute(
      'href',
      'https://github.com/Lens-Academy/lens-relay/pull/42'
    );
  });

  it('loads and renders a diff after View diff', async () => {
    const user = userEvent.setup();
    vi.mocked(getPromotionDiff).mockResolvedValue({
      path: 'Notes.md',
      mainSha: 'main-sha',
      status: 'modified',
      isBinary: false,
      beforeBlob: null,
      afterBlob: null,
      diff: '@@ -1 +1 @@\n-old\n+new',
    });
    renderPromotionPage();

    const row = await screen.findByRole('row', { name: /Notes\.md/ });
    await user.click(within(row).getByRole('button', { name: 'View diff' }));

    expect(getPromotionDiff).toHaveBeenCalledWith('Notes.md');
    expect(await screen.findByText('@@ -1 +1 @@')).toBeInTheDocument();
    expect(screen.getByText('+new')).toBeInTheDocument();
  });

  it('ignores stale diff responses when a newer diff request finishes first', async () => {
    const user = userEvent.setup();
    const notesDiff = deferred<Awaited<ReturnType<typeof getPromotionDiff>>>();
    const otherDiff = deferred<Awaited<ReturnType<typeof getPromotionDiff>>>();
    vi.mocked(getPromotionDiff)
      .mockReturnValueOnce(notesDiff.promise)
      .mockReturnValueOnce(otherDiff.promise);
    renderPromotionPage();

    const notesRow = await screen.findByRole('row', { name: /Notes\.md/ });
    const otherRow = screen.getByRole('row', { name: /Other\.md/ });
    await user.click(within(notesRow).getByRole('button', { name: 'View diff' }));
    await user.click(within(otherRow).getByRole('button', { name: 'View diff' }));

    otherDiff.resolve({
      path: 'Other.md',
      mainSha: 'main-sha',
      status: 'added',
      isBinary: false,
      beforeBlob: null,
      afterBlob: null,
      diff: '@@ -0 +1 @@\n+other',
    });

    expect(await screen.findByText('Diff: Other.md')).toBeInTheDocument();
    expect(screen.getByText('+other')).toBeInTheDocument();

    notesDiff.resolve({
      path: 'Notes.md',
      mainSha: 'main-sha',
      status: 'modified',
      isBinary: false,
      beforeBlob: null,
      afterBlob: null,
      diff: '@@ -1 +1 @@\n+notes',
    });

    await waitFor(() => {
      expect(screen.getByText('Diff: Other.md')).toBeInTheDocument();
    });
    expect(screen.queryByText('Diff: Notes.md')).not.toBeInTheDocument();
    expect(screen.queryByText('+notes')).not.toBeInTheDocument();
  });

  it('filtering hides non-matching files without losing selection', async () => {
    const user = userEvent.setup();
    renderPromotionPage('/promote?path=%2FLens%20Edu%2FOther.md');

    expect(await screen.findByRole('checkbox', { name: /Other\.md/ })).toBeChecked();

    await user.type(screen.getByRole('searchbox', { name: 'Filter changed files' }), 'Notes');

    expect(screen.queryByRole('checkbox', { name: /Other\.md/ })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Notes\.md/ })).not.toBeChecked();

    await user.clear(screen.getByRole('searchbox', { name: 'Filter changed files' }));

    expect(screen.getByRole('checkbox', { name: /Other\.md/ })).toBeChecked();
  });

  it('shows an auto-merge warning when PR result has autoMergeEnabled false', async () => {
    const user = userEvent.setup();
    vi.mocked(createPromotionPr).mockResolvedValue({
      branch: 'promote/notes',
      prNumber: 43,
      prUrl: 'https://github.com/Lens-Academy/lens-relay/pull/43',
      mainSha: 'main-sha',
      autoMergeEnabled: false,
      warning: 'Auto-merge could not be enabled.',
    });
    renderPromotionPage('/promote?path=%2FLens%20Edu%2FNotes.md');

    await user.click(await screen.findByRole('button', { name: 'Create promotion PR' }));

    expect(await screen.findByText('Auto-merge could not be enabled.')).toBeInTheDocument();
  });

  it('does not create the same promotion PR again after success', async () => {
    const user = userEvent.setup();
    vi.mocked(createPromotionPr).mockResolvedValue({
      branch: 'promote/notes',
      prNumber: 44,
      prUrl: 'https://github.com/Lens-Academy/lens-relay/pull/44',
      mainSha: 'main-sha',
      autoMergeEnabled: true,
    });
    renderPromotionPage('/promote?path=%2FLens%20Edu%2FNotes.md');

    const createButton = await screen.findByRole('button', { name: 'Create promotion PR' });
    await user.click(createButton);
    expect(await screen.findByText('Pull request created')).toBeInTheDocument();
    expect(createButton).toBeDisabled();

    await user.click(createButton);

    expect(createPromotionPr).toHaveBeenCalledTimes(1);
  });

  it('links changed files back to their editor route', async () => {
    renderPromotionPage();

    const row = await screen.findByRole('row', { name: /Notes\.md/ });

    expect(within(row).getByRole('link', { name: 'Open in editor' })).toHaveAttribute(
      'href',
      '/11111111/Lens-Edu/Notes.md'
    );
  });
});
