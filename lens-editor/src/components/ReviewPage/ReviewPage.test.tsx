import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
      expect(screen.getByText('Test')).toBeTruthy();
      expect(screen.getAllByText(/1 suggestion/).length).toBeGreaterThanOrEqual(1);
    });

    it('shows suggestion content when file is expanded', async () => {
      const { ReviewPage } = await import('./ReviewPage');
      render(<MemoryRouter><ReviewPage folderIds={['test-folder']} /></MemoryRouter>);
      fireEvent.click(screen.getByText('Test'));
      expect(screen.getByText('new text')).toBeTruthy();
    });

    it('shows author badge', async () => {
      const { ReviewPage } = await import('./ReviewPage');
      render(<MemoryRouter><ReviewPage folderIds={['test-folder']} /></MemoryRouter>);
      fireEvent.click(screen.getByText('Test'));
      // "AI (MCP)" appears in both the filter bar and the suggestion badge
      expect(screen.getAllByText('AI (MCP)').length).toBeGreaterThanOrEqual(2);
    });

    it('toggles file expansion on click', async () => {
      const { ReviewPage } = await import('./ReviewPage');
      render(<MemoryRouter><ReviewPage folderIds={['test-folder']} /></MemoryRouter>);
      const fileHeader = screen.getByText('Test');
      // File is auto-expanded; collapse uses CSS grid-rows-[0fr], content stays in DOM
      const getGrid = () => screen.getByText('new text').closest('.grid');
      expect(getGrid()?.className).toContain('grid-rows-[1fr]');
      fireEvent.click(fileHeader);
      expect(getGrid()?.className).toContain('grid-rows-[0fr]');
      fireEvent.click(fileHeader);
      expect(getGrid()?.className).toContain('grid-rows-[1fr]');
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
