/**
 * Unit+1 tests for Sidebar component.
 * Uses real Sidebar, buildTreeFromPaths, and FileTree.
 * Mocks only the NavigationContext (no Y-Sweet network).
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { NavigationContext } from '../../contexts/NavigationContext';
import * as Y from 'yjs';

// Mock useResolvedDocId — unit tests don't test doc resolution
vi.mock('../../hooks/useResolvedDocId', () => ({
  useResolvedDocId: (compoundId: string) => compoundId || null,
}));

vi.mock('../../lib/relay-api', async () => {
  const actual = await vi.importActual('../../lib/relay-api');
  return {
    ...actual,
    createDocument: vi.fn().mockResolvedValue('new-doc-id'),
    deleteDocument: vi.fn(),
    moveDocument: vi.fn(),
  };
});

describe('Sidebar with multi-folder metadata', () => {
  it('renders folder prefixes as top-level folder nodes', () => {
    // Metadata with folder-prefixed paths (as produced by mergeMetadata)
    const metadata = {
      '/Lens/Welcome.md': { id: 'welcome', type: 'markdown' as const, version: 0 },
      '/Lens/Getting Started.md': { id: 'getting-started', type: 'markdown' as const, version: 0 },
      '/Lens Edu/Course Notes.md': { id: 'course-notes', type: 'markdown' as const, version: 0 },
      '/Lens Edu/Syllabus.md': { id: 'syllabus', type: 'markdown' as const, version: 0 },
    };

    const folderDocs = new Map<string, Y.Doc>([
      ['Lens', new Y.Doc()],
      ['Lens Edu', new Y.Doc()],
    ]);
    const folderNames = ['Lens', 'Lens Edu'];
    const errors = new Map<string, Error>();

    render(
      <MemoryRouter initialEntries={['/c0000001/Lens/Welcome.md']}>
        <NavigationContext.Provider
          value={{
            metadata,
            folderDocs,
            folderNames,
            errors,
            onNavigate: vi.fn(),
            justCreatedRef: { current: false },
          }}
        >
          <Sidebar />
        </NavigationContext.Provider>
      </MemoryRouter>
    );

    // Should have "Lens" and "Lens Edu" as top-level folder nodes
    const lensFolder = screen.getByRole('treeitem', { name: /^Lens$/ });
    const lensEduFolder = screen.getByRole('treeitem', { name: /^Lens Edu$/ });

    expect(lensFolder).toBeInTheDocument();
    expect(lensEduFolder).toBeInTheDocument();
  });

  it('shows create button on folder nodes', () => {
    const metadata = {
      '/Lens/Welcome.md': { id: 'welcome', type: 'markdown' as const, version: 0 },
    };

    const folderDocs = new Map<string, Y.Doc>([
      ['Lens', new Y.Doc()],
    ]);
    const folderNames = ['Lens'];
    const errors = new Map<string, Error>();

    render(
      <MemoryRouter initialEntries={['/welcome']}>
        <NavigationContext.Provider
          value={{
            metadata,
            folderDocs,
            folderNames,
            errors,
            onNavigate: vi.fn(),
            justCreatedRef: { current: false },
          }}
        >
          <Sidebar />
        </NavigationContext.Provider>
      </MemoryRouter>
    );

    // The Lens folder row should contain a create-document button
    const createBtn = screen.getByRole('button', { name: /create document in Lens/i });
    expect(createBtn).toBeInTheDocument();
  });

  it('opens file in new tab on ctrl+click', async () => {
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    const mockNavigate = vi.fn();
    const metadata = {
      '/Lens/Welcome.md': { id: 'welcome', type: 'markdown' as const, version: 0 },
    };
    const folderDocs = new Map<string, Y.Doc>([['Lens', new Y.Doc()]]);
    const folderNames = ['Lens'];
    const errors = new Map<string, Error>();

    render(
      <MemoryRouter initialEntries={['/c0000001/Lens/Welcome.md']}>
        <NavigationContext.Provider
          value={{ metadata, folderDocs, folderNames, errors, onNavigate: mockNavigate, justCreatedRef: { current: false } }}
        >
          <Sidebar />
        </NavigationContext.Provider>
      </MemoryRouter>
    );

    // Find the file node text, then its clickable parent row
    const fileText = screen.getByText('Welcome.md');
    const fileRow = fileText.closest('[class*="cursor-pointer"]') as HTMLElement;
    expect(fileRow).not.toBeNull();

    fireEvent.click(fileRow, { ctrlKey: true });

    expect(windowOpen).toHaveBeenCalledWith(
      expect.stringContaining('/welcome'),
      '_blank'
    );
    expect(mockNavigate).not.toHaveBeenCalled();
    windowOpen.mockRestore();
  });

  it('opens file in new tab on middle-click', async () => {
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    const mockNavigate = vi.fn();
    const metadata = {
      '/Lens/Welcome.md': { id: 'welcome', type: 'markdown' as const, version: 0 },
    };
    const folderDocs = new Map<string, Y.Doc>([['Lens', new Y.Doc()]]);
    const folderNames = ['Lens'];
    const errors = new Map<string, Error>();

    render(
      <MemoryRouter initialEntries={['/c0000001/Lens/Welcome.md']}>
        <NavigationContext.Provider
          value={{ metadata, folderDocs, folderNames, errors, onNavigate: mockNavigate, justCreatedRef: { current: false } }}
        >
          <Sidebar />
        </NavigationContext.Provider>
      </MemoryRouter>
    );

    const fileText = screen.getByText('Welcome.md');
    const fileRow = fileText.closest('[class*="cursor-pointer"]') as HTMLElement;
    expect(fileRow).not.toBeNull();

    fireEvent(fileRow, new MouseEvent('auxclick', { bubbles: true, button: 1 }));

    expect(windowOpen).toHaveBeenCalledWith(
      expect.stringContaining('/welcome'),
      '_blank'
    );
    expect(mockNavigate).not.toHaveBeenCalled();
    windowOpen.mockRestore();
  });

  it('creates document in correct folder when "+" is clicked', async () => {
    const user = userEvent.setup();
    const { createDocument: mockCreate } = await import('../../lib/relay-api');
    const metadata = {
      '/Lens/Welcome.md': { id: 'welcome', type: 'markdown' as const, version: 0 },
      '/Lens Edu/Course.md': { id: 'course', type: 'markdown' as const, version: 0 },
    };

    const lensDoc = new Y.Doc();
    const eduDoc = new Y.Doc();
    const folderDocs = new Map<string, Y.Doc>([
      ['Lens', lensDoc],
      ['Lens Edu', eduDoc],
    ]);
    const folderNames = ['Lens', 'Lens Edu'];
    const errors = new Map<string, Error>();
    const mockNavigate = vi.fn();

    render(
      <MemoryRouter initialEntries={['/welcome']}>
        <NavigationContext.Provider
          value={{
            metadata,
            folderDocs,
            folderNames,
            errors,
            onNavigate: mockNavigate,
            justCreatedRef: { current: false },
          }}
        >
          <Sidebar />
        </NavigationContext.Provider>
      </MemoryRouter>
    );

    // Click "+" on Lens Edu folder
    const createBtn = screen.getByRole('button', { name: /create document in Lens Edu/i });
    await user.click(createBtn);

    // Should call createDocument with the Lens Edu doc and correct path
    expect(mockCreate).toHaveBeenCalledWith(eduDoc, '/Untitled.md', 'markdown');
    // Should navigate to new doc
    expect(mockNavigate).toHaveBeenCalled();
  });
});
