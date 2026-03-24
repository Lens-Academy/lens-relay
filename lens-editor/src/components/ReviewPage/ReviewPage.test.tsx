import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockRefresh = vi.fn();

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
              timestamp: 1709900000000,
              from: 10,
              to: 50,
              raw_markup: '{++{"author":"AI","timestamp":1709900000000}@@new text++}',
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
      // First file is auto-expanded; "AI" appears in both filter bar and suggestion badge
      expect(screen.getAllByText('AI').length).toBeGreaterThanOrEqual(2);
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
