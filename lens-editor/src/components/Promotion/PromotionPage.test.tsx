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
      curriculum: { courses: [], modules: [], memberships: {} },
    });
  });

  it('preselects path from the query string after loading', async () => {
    renderPromotionPage('/promote?path=%2FLens%20Edu%2FNotes.md');

    expect(screen.getByText('Loading production differences...')).toBeInTheDocument();

    const table = await screen.findByRole('table');
    expect(within(table).getByRole('checkbox', { name: /Notes\.md/ })).toBeChecked();
    expect(within(table).getByRole('checkbox', { name: /Other\.md/ })).not.toBeChecked();
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

    const table = await screen.findByRole('table');
    expect(within(table).getByRole('checkbox', { name: /Other\.md/ })).toBeChecked();

    await user.type(screen.getByRole('searchbox', { name: 'Filter changed files' }), 'Notes');

    expect(within(table).queryByRole('checkbox', { name: /Other\.md/ })).not.toBeInTheDocument();
    expect(within(table).getByRole('checkbox', { name: /Notes\.md/ })).not.toBeChecked();

    await user.clear(screen.getByRole('searchbox', { name: 'Filter changed files' }));

    expect(within(table).getByRole('checkbox', { name: /Other\.md/ })).toBeChecked();
  });

  it('adds and removes every filtered file explicitly', async () => {
    const user = userEvent.setup();
    renderPromotionPage();

    const table = await screen.findByRole('table');
    const notes = within(table).getByRole('checkbox', { name: /Notes\.md/ });
    const other = within(table).getByRole('checkbox', { name: /Other\.md/ });

    await user.click(screen.getByRole('button', { name: 'Add 2 filtered files to selection' }));

    expect(notes).toBeChecked();
    expect(other).toBeChecked();
    expect(screen.getByText(/2 selected in results/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove 2 filtered files from selection' }));

    expect(notes).not.toBeChecked();
    expect(other).not.toBeChecked();
    expect(screen.getByText(/0 selected in results/)).toBeInTheDocument();
  });

  it('filters course unions and narrows them with mutually exclusive module choices', async () => {
    const user = userEvent.setup();
    vi.mocked(getPromotionChanges).mockResolvedValue({
      mainSha: 'main-sha',
      generatedAt: '2026-08-09T00:00:00Z',
      files: [
        { ...files[0], path: 'courses/One.md' },
        { ...files[0], path: 'modules/A.md' },
        { ...files[0], path: 'modules/B.md' },
        { ...files[0], path: 'Lenses/Shared.md' },
        { ...files[0], path: 'articles/Only A.md' },
        { ...files[0], path: 'courses/Two.md' },
        { ...files[0], path: 'modules/C.md' },
        { ...files[0], path: 'Lenses/Only C.md' },
        { ...files[0], path: 'Unrelated.md' },
      ],
      curriculum: {
        courses: [
          { path: 'courses/One.md', label: 'Course One', modulePaths: ['modules/A.md', 'modules/B.md'] },
          { path: 'courses/Two.md', label: 'Course Two', modulePaths: ['modules/C.md'] },
        ],
        modules: [
          { path: 'modules/A.md', label: 'Module A', coursePaths: ['courses/One.md'] },
          { path: 'modules/B.md', label: 'Module B', coursePaths: ['courses/One.md'] },
          { path: 'modules/C.md', label: 'Module C', coursePaths: ['courses/Two.md'] },
        ],
        memberships: {
          'courses/One.md': { coursePaths: ['courses/One.md'], modulePaths: [] },
          'modules/A.md': { coursePaths: ['courses/One.md'], modulePaths: ['modules/A.md'] },
          'modules/B.md': { coursePaths: ['courses/One.md'], modulePaths: ['modules/B.md'] },
          'Lenses/Shared.md': { coursePaths: ['courses/One.md'], modulePaths: ['modules/A.md', 'modules/B.md'] },
          'articles/Only A.md': { coursePaths: ['courses/One.md'], modulePaths: ['modules/A.md'] },
          'courses/Two.md': { coursePaths: ['courses/Two.md'], modulePaths: [] },
          'modules/C.md': { coursePaths: ['courses/Two.md'], modulePaths: ['modules/C.md'] },
          'Lenses/Only C.md': { coursePaths: ['courses/Two.md'], modulePaths: ['modules/C.md'] },
        },
      },
    });
    renderPromotionPage();
    const table = await screen.findByRole('table');

    await user.click(screen.getByText('All courses'));
    await user.click(screen.getByRole('checkbox', { name: /Course One/ }));
    expect(within(table).getByText('courses/One.md')).toBeInTheDocument();
    expect(within(table).queryByText('courses/Two.md')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All modules' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByText('Choose modules', { selector: 'summary span' }));
    await user.click(screen.getByRole('checkbox', { name: /Module A/ }));
    expect(screen.getByRole('button', { name: 'All modules' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(table).getByText('modules/A.md')).toBeInTheDocument();
    expect(within(table).getByText('articles/Only A.md')).toBeInTheDocument();
    expect(within(table).queryByText('modules/B.md')).not.toBeInTheDocument();
    expect(within(table).queryByText('courses/One.md')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'All modules' }));
    expect(screen.getByRole('checkbox', { name: /Module A/ })).not.toBeChecked();
    expect(within(table).getByText('modules/B.md')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: /Course Two/ }));
    expect(within(table).getByText('Lenses/Only C.md')).toBeInTheDocument();
  });

  it('keeps selected modules visible after the course changes and shows a zero count', async () => {
    const user = userEvent.setup();
    vi.mocked(getPromotionChanges).mockResolvedValue({
      mainSha: 'main-sha', generatedAt: 'now',
      files: [
        { ...files[0], path: 'modules/A.md' },
        { ...files[0], path: 'modules/B.md' },
      ],
      curriculum: {
        courses: [
          { path: 'courses/One.md', label: 'Course One', modulePaths: ['modules/A.md'] },
          { path: 'courses/Two.md', label: 'Course Two', modulePaths: ['modules/B.md'] },
        ],
        modules: [
          { path: 'modules/A.md', label: 'Module A', coursePaths: ['courses/One.md'] },
          { path: 'modules/B.md', label: 'Module B', coursePaths: ['courses/Two.md'] },
        ],
        memberships: {
          'modules/A.md': { coursePaths: ['courses/One.md'], modulePaths: ['modules/A.md'] },
          'modules/B.md': { coursePaths: ['courses/Two.md'], modulePaths: ['modules/B.md'] },
        },
      },
    });
    renderPromotionPage();
    await screen.findByRole('table');
    await user.click(screen.getByText('All courses'));
    await user.click(screen.getByRole('checkbox', { name: /Course One/ }));
    await user.click(screen.getByText('Choose modules', { selector: 'summary span' }));
    await user.click(screen.getByRole('checkbox', { name: /Module A/ }));
    await user.click(screen.getByText('Course One', { selector: 'summary span' }));
    await user.click(screen.getByRole('checkbox', { name: /Course Two/ }));
    await user.click(screen.getByRole('checkbox', { name: /Course One/ }));
    expect(screen.getByRole('checkbox', { name: /Module A/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Module A/ }).closest('label')).toHaveTextContent('0');
    expect(screen.getAllByText('No changed files match the current filters.')).toHaveLength(2);
  });

  it('filters by old rename path, folder, and selection without losing hidden selections', async () => {
    const user = userEvent.setup();
    vi.mocked(getPromotionChanges).mockResolvedValue({
      mainSha: 'main-sha', generatedAt: 'now',
      files: [
        { ...files[0], path: 'Lenses/New.md', oldPath: 'Lenses/Old.md', status: 'renamed' },
        { ...files[1], path: 'articles/Article.md' },
      ],
      curriculum: { courses: [], modules: [], memberships: {} },
    });
    renderPromotionPage('/promote?path=Lenses%2FNew.md');
    const table = await screen.findByRole('table');
    expect(screen.getByText('Out of filtered files, show:')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Files to show' })).toContainElement(
      screen.getByRole('button', { name: /^all$/i }),
    );
    await user.type(screen.getByRole('searchbox', { name: 'Filter changed files' }), 'Old.md');
    expect(within(table).getByText('Lenses/New.md')).toBeInTheDocument();
    await user.clear(screen.getByRole('searchbox', { name: 'Filter changed files' }));
    await user.click(screen.getByText('All folders'));
    await user.click(screen.getByRole('checkbox', { name: /^articles 1$/i }));
    expect(within(table).queryByText('Lenses/New.md')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /unselected/i }));
    expect(within(table).getByText('articles/Article.md')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(within(table).getByRole('checkbox', { name: /Lenses\/New\.md/ })).toBeChecked();
  });

  it('rejects an atomic filtered addition over the 1000-file limit', async () => {
    const user = userEvent.setup();
    const manyFiles = Array.from({ length: 1001 }, (_, index) => ({ ...files[0], path: `Lenses/${index}.md` }));
    vi.mocked(getPromotionChanges).mockResolvedValue({
      mainSha: 'main-sha', generatedAt: 'now', files: manyFiles,
      curriculum: { courses: [], modules: [], memberships: {} },
    });
    renderPromotionPage();
    await user.click(await screen.findByRole('button', { name: 'Add 1001 filtered files to selection' }));
    expect(screen.getByRole('alert')).toHaveTextContent('exceed the 1000-file limit by 1');
    expect(screen.getByText(/0 selected in results/)).toBeInTheDocument();
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
