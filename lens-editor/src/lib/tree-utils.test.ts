import { describe, it, expect } from 'vitest';
import { buildTreeFromPaths, filterTree, getFolderIdsWithMatches, buildDocIdToPathMap } from './tree-utils';
import simpleFlat from '../test/fixtures/folder-metadata/simple-flat.json';
import nestedHierarchy from '../test/fixtures/folder-metadata/nested-hierarchy.json';

describe('buildTreeFromPaths', () => {
  it('builds flat file list from simple metadata', () => {
    const tree = buildTreeFromPaths(simpleFlat);

    expect(tree).toHaveLength(5);
    expect(tree.every((n) => !n.isFolder)).toBe(true);
  });

  it('sorts files alphabetically (case-insensitive)', () => {
    const tree = buildTreeFromPaths(simpleFlat);
    const names = tree.map((n) => n.name);

    expect(names).toEqual([
      'Archive.md',
      'Ideas.md',
      'Notes.md',
      'README.md',
      'Tasks.md',
    ]);
  });

  it('builds nested hierarchy with folders first', () => {
    const tree = buildTreeFromPaths(nestedHierarchy);

    // Root level: folders first, then files
    expect(tree[0].name).toBe('Archive');
    expect(tree[0].isFolder).toBe(true);
    expect(tree[1].name).toBe('Projects');
    expect(tree[1].isFolder).toBe(true);
    expect(tree[2].name).toBe('Daily Notes.md');
    expect(tree[2].isFolder).toBe(false);
  });

  it('nests children correctly under parent folders', () => {
    const tree = buildTreeFromPaths(nestedHierarchy);
    const projects = tree.find((n) => n.name === 'Projects');

    expect(projects).toBeDefined();
    expect(projects!.children).toHaveLength(2);
    expect(projects!.children![0].name).toBe('Alpha');
    expect(projects!.children![1].name).toBe('Beta');
  });

  it('includes docId for markdown files', () => {
    const tree = buildTreeFromPaths(simpleFlat);
    const readme = tree.find((n) => n.name === 'README.md');

    // Verify docId matches the fixture
    expect(readme?.docId).toBe(simpleFlat['/README.md'].id);
  });

  it('folders have undefined docId', () => {
    const tree = buildTreeFromPaths(nestedHierarchy);
    const projects = tree.find((n) => n.name === 'Projects');

    expect(projects?.docId).toBeUndefined();
  });
});

describe('filterTree', () => {
  it('returns all nodes when search term is empty', () => {
    const tree = buildTreeFromPaths(simpleFlat);
    const filtered = filterTree(tree, '');

    expect(filtered).toHaveLength(5);
  });

  it('filters files by name match', () => {
    const tree = buildTreeFromPaths(simpleFlat);
    const filtered = filterTree(tree, 'notes');

    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe('Notes.md');
  });

  it('keeps parent folders when children match', () => {
    const tree = buildTreeFromPaths(nestedHierarchy);
    const filtered = filterTree(tree, 'alpha');

    const projects = filtered.find((n) => n.name === 'Projects');
    expect(projects).toBeDefined();
    expect(projects!.children!.some((c) => c.name === 'Alpha')).toBe(true);
  });

  it('is case-insensitive', () => {
    const tree = buildTreeFromPaths(simpleFlat);
    const filtered = filterTree(tree, 'README');

    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe('README.md');
  });

  it('clones nodes (does not mutate original)', () => {
    const tree = buildTreeFromPaths(nestedHierarchy);
    filterTree(tree, 'alpha');

    const projects = tree.find((n) => n.name === 'Projects');
    expect(projects!.children).toHaveLength(2);
  });
});

describe('buildDocIdToPathMap', () => {
  it('produces folder name for root-level files', () => {
    const metadata = {
      '/Lens/Welcome.md': { id: 'id-1', type: 'markdown' as const, version: 0 },
    };
    const map = buildDocIdToPathMap(metadata);
    expect(map.get('id-1')).toBe('Lens');
  });

  it('produces parent path for nested files', () => {
    const metadata = {
      '/Lens/Physics/Quantum.md': { id: 'id-2', type: 'markdown' as const, version: 0 },
    };
    const map = buildDocIdToPathMap(metadata);
    expect(map.get('id-2')).toBe('Lens / Physics');
  });

  it('produces deeply nested path', () => {
    const metadata = {
      '/Lens Edu/CS/Algorithms/Sorting.md': { id: 'id-3', type: 'markdown' as const, version: 0 },
    };
    const map = buildDocIdToPathMap(metadata);
    expect(map.get('id-3')).toBe('Lens Edu / CS / Algorithms');
  });

  it('skips folder entries', () => {
    const metadata = {
      '/Lens/Physics': { id: 'folder-1', type: 'folder' as const, version: 0 },
      '/Lens/Physics/Quantum.md': { id: 'id-4', type: 'markdown' as const, version: 0 },
    };
    const map = buildDocIdToPathMap(metadata);
    expect(map.has('folder-1')).toBe(false);
    expect(map.get('id-4')).toBe('Lens / Physics');
  });

  it('does not include files with no parent path', () => {
    // Edge case: a file at root level with no folder prefix
    const metadata = {
      '/Orphan.md': { id: 'id-5', type: 'markdown' as const, version: 0 },
    };
    const map = buildDocIdToPathMap(metadata);
    // No parent segments → no entry
    expect(map.has('id-5')).toBe(false);
  });
});

describe('getFolderIdsWithMatches', () => {
  it('returns empty set for empty search term', () => {
    const tree = buildTreeFromPaths(nestedHierarchy);
    const ids = getFolderIdsWithMatches(tree, '');

    expect(ids.size).toBe(0);
  });

  it('returns folder IDs containing matching descendants', () => {
    const tree = buildTreeFromPaths(nestedHierarchy);
    const ids = getFolderIdsWithMatches(tree, 'readme');

    // Verify the IDs match the fixture
    expect(ids.has(nestedHierarchy['/Projects'].id)).toBe(true);
    expect(ids.has(nestedHierarchy['/Projects/Alpha'].id)).toBe(true);
  });

  it('does not include folders without matching descendants', () => {
    const tree = buildTreeFromPaths(nestedHierarchy);
    const ids = getFolderIdsWithMatches(tree, 'readme');

    expect(ids.has(nestedHierarchy['/Projects/Beta'].id)).toBe(false);
    expect(ids.has(nestedHierarchy['/Archive'].id)).toBe(false);
  });
});
