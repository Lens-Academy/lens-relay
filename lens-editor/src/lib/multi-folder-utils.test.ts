// src/lib/multi-folder-utils.test.ts
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  mergeMetadata,
  getFolderNameFromPath,
  getOriginalPath,
  getFolderDocForPath
} from './multi-folder-utils';
import type { FileMetadata } from '../hooks/useFolderMetadata';

describe('mergeMetadata', () => {
  it('combines folders with name prefixes', () => {
    const result = mergeMetadata([
      { name: 'Lens', metadata: { '/doc.md': { id: 'uuid1', type: 'markdown', version: 0 } } },
      { name: 'Lens Edu', metadata: { '/syllabus.md': { id: 'uuid2', type: 'markdown', version: 0 } } }
    ]);

    expect(result['/Lens/doc.md']).toEqual({ id: 'uuid1', type: 'markdown', version: 0 });
    expect(result['/Lens Edu/syllabus.md']).toEqual({ id: 'uuid2', type: 'markdown', version: 0 });
  });

  it('handles empty folder', () => {
    const result = mergeMetadata([
      { name: 'Lens', metadata: {} },
      { name: 'Lens Edu', metadata: { '/doc.md': { id: 'uuid1', type: 'markdown', version: 0 } } }
    ]);

    expect(Object.keys(result)).toHaveLength(1);
    expect(result['/Lens Edu/doc.md']).toBeDefined();
  });

  it('preserves nested paths', () => {
    const result = mergeMetadata([
      { name: 'Lens', metadata: { '/notes/meeting.md': { id: 'uuid1', type: 'markdown', version: 0 } } }
    ]);

    expect(result['/Lens/notes/meeting.md']).toEqual({ id: 'uuid1', type: 'markdown', version: 0 });
  });
});

describe('getFolderNameFromPath', () => {
  it('extracts folder name from prefixed path', () => {
    const folderNames = ['Lens', 'Lens Edu', 'Lens-Archive'];

    expect(getFolderNameFromPath('/Lens Edu/notes.md', folderNames)).toBe('Lens Edu');
    expect(getFolderNameFromPath('/Lens/deep/nested/doc.md', folderNames)).toBe('Lens');
  });

  it('distinguishes similar folder name prefixes', () => {
    const folderNames = ['Lens', 'Lens-Archive'];

    // Must not confuse "Lens" with "Lens-Archive"
    expect(getFolderNameFromPath('/Lens-Archive/doc.md', folderNames)).toBe('Lens-Archive');
    expect(getFolderNameFromPath('/Lens/doc.md', folderNames)).toBe('Lens');
  });

  it('handles folder names with spaces', () => {
    const folderNames = ['Lens Edu'];
    expect(getFolderNameFromPath('/Lens Edu/notes.md', folderNames)).toBe('Lens Edu');
  });

  it('returns null for unrecognized path', () => {
    const folderNames = ['Lens'];
    expect(getFolderNameFromPath('/Unknown/doc.md', folderNames)).toBeNull();
  });
});

describe('getOriginalPath', () => {
  it('strips folder prefix', () => {
    expect(getOriginalPath('/Lens Edu/notes.md', 'Lens Edu')).toBe('/notes.md');
    expect(getOriginalPath('/Lens/sub/doc.md', 'Lens')).toBe('/sub/doc.md');
  });

  it('handles root-level files', () => {
    expect(getOriginalPath('/Lens/file.md', 'Lens')).toBe('/file.md');
  });

  it('preserves nested structure', () => {
    expect(getOriginalPath('/Lens/a/b/c/deep.md', 'Lens')).toBe('/a/b/c/deep.md');
  });
});

describe('getFolderDocForPath', () => {
  it('returns correct Y.Doc for prefixed path', () => {
    const lensDoc = new Y.Doc();
    const lensEduDoc = new Y.Doc();
    const folderDocs = new Map([
      ['Lens', lensDoc],
      ['Lens Edu', lensEduDoc]
    ]);
    const folderNames = ['Lens', 'Lens Edu'];

    expect(getFolderDocForPath('/Lens/doc.md', folderDocs, folderNames)).toBe(lensDoc);
    expect(getFolderDocForPath('/Lens Edu/syllabus.md', folderDocs, folderNames)).toBe(lensEduDoc);
  });

  it('returns null for unrecognized path', () => {
    const folderDocs = new Map([['Lens', new Y.Doc()]]);
    const folderNames = ['Lens'];

    expect(getFolderDocForPath('/Unknown/doc.md', folderDocs, folderNames)).toBeNull();
  });
});
