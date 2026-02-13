/**
 * Unit+1 tests for Sidebar component.
 * Uses real Sidebar, buildTreeFromPaths, and FileTree.
 * Mocks only the NavigationContext (no Y-Sweet network).
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { NavigationContext } from '../../contexts/NavigationContext';
import * as Y from 'yjs';

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
      <MemoryRouter initialEntries={['/c0000001-0000-4000-8000-000000000001/Lens/Welcome.md']}>
        <NavigationContext.Provider
          value={{
            metadata,
            folderDocs,
            folderNames,
            errors,
            onNavigate: vi.fn(),
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
});
