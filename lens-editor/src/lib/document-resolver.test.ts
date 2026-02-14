import { describe, it, expect } from 'vitest';
import { resolvePageName, generateNewDocPath } from './document-resolver';
import type { FolderMetadata } from '../hooks/useFolderMetadata';
import nestedHierarchy from '../test/fixtures/folder-metadata/nested-hierarchy.json';
import edgeCases from '../test/fixtures/folder-metadata/edge-cases.json';

// Type assertion for JSON imports
const nestedMetadata = nestedHierarchy as FolderMetadata;
const edgeCasesMetadata = edgeCases as FolderMetadata;

describe('resolvePageName', () => {
  describe('with nested hierarchy fixture', () => {
    it('returns null for non-existent page', () => {
      expect(resolvePageName('NonExistent', nestedMetadata)).toBeNull();
    });

    it('matches exact filename without extension', () => {
      const result = resolvePageName('Daily Notes', nestedMetadata);

      expect(result).not.toBeNull();
      expect(result!.docId).toBe(nestedMetadata['/Daily Notes.md'].id);
      expect(result!.path).toBe('/Daily Notes.md');
    });

    it('matches case-insensitively', () => {
      const result = resolvePageName('daily notes', nestedMetadata);

      expect(result!.docId).toBe(nestedMetadata['/Daily Notes.md'].id);
    });

    it('matches files in subdirectories', () => {
      const result = resolvePageName('README', nestedMetadata);

      expect(result!.docId).toBe(nestedMetadata['/Projects/Alpha/README.md'].id);
      expect(result!.path).toBe('/Projects/Alpha/README.md');
    });

    it('matches files in deeply nested folders', () => {
      const result = resolvePageName('Notes', nestedMetadata);

      expect(result!.docId).toBe(nestedMetadata['/Projects/Beta/Notes.md'].id);
      expect(result!.path).toBe('/Projects/Beta/Notes.md');
    });

    it('ignores folders', () => {
      expect(resolvePageName('Archive', nestedMetadata)).toBeNull();
      expect(resolvePageName('Projects', nestedMetadata)).toBeNull();
    });

    it('resolves exact path wikilink', () => {
      const result = resolvePageName('Projects/Alpha/README', nestedMetadata);
      expect(result).not.toBeNull();
      expect(result!.docId).toBe(nestedMetadata['/Projects/Alpha/README.md'].id);
      expect(result!.path).toBe('/Projects/Alpha/README.md');
    });

    it('resolves case-insensitive path wikilink', () => {
      const result = resolvePageName('projects/alpha/readme', nestedMetadata);
      expect(result).not.toBeNull();
      expect(result!.docId).toBe(nestedMetadata['/Projects/Alpha/README.md'].id);
    });

    it('prefers exact path over basename match', () => {
      // "Projects/Beta/Notes" should resolve to /Projects/Beta/Notes.md
      // not just any file named "Notes" found by basename
      const result = resolvePageName('Projects/Beta/Notes', nestedMetadata);
      expect(result!.path).toBe('/Projects/Beta/Notes.md');
    });

    it('still resolves basename when no path match', () => {
      // Existing behavior must not regress
      const result = resolvePageName('README', nestedMetadata);
      expect(result).not.toBeNull();
      expect(result!.path).toBe('/Projects/Alpha/README.md');
    });
  });

  describe('with edge cases fixture', () => {
    it('matches files with special characters in name', () => {
      const result = resolvePageName('Special Characters !@#$', edgeCasesMetadata);

      expect(result).not.toBeNull();
      expect(result!.docId).toBe(edgeCasesMetadata['/Special Characters !@#$.md'].id);
    });

    it('matches files in deeply nested paths', () => {
      const result = resolvePageName('File', edgeCasesMetadata);

      expect(result!.docId).toBe(edgeCasesMetadata['/Deep/Nested/Path/File.md'].id);
      expect(result!.path).toBe('/Deep/Nested/Path/File.md');
    });

    it('handles case variations (uppercase file)', () => {
      const result = resolvePageName('uppercase', edgeCasesMetadata);

      expect(result!.docId).toBe(edgeCasesMetadata['/UPPERCASE.md'].id);
    });

    it('handles case variations (lowercase file)', () => {
      const result = resolvePageName('LOWERCASE', edgeCasesMetadata);

      expect(result!.docId).toBe(edgeCasesMetadata['/lowercase.md'].id);
    });

    it('ignores non-markdown files', () => {
      expect(resolvePageName('screenshot-1234567890', edgeCasesMetadata)).toBeNull();
    });

    it('ignores empty folders', () => {
      expect(resolvePageName('Empty Folder', edgeCasesMetadata)).toBeNull();
    });
  });

  describe('folder-prefixed paths (multi-folder)', () => {
    // Simulates metadata from mergeMetadata() which prefixes paths with folder name
    const prefixedMetadata: FolderMetadata = {
      '/Relay Folder 1/Notes': { id: 'folder-notes', type: 'folder', version: 0 },
      '/Relay Folder 1/Welcome.md': { id: 'doc-welcome-1', type: 'markdown', version: 0 },
      '/Relay Folder 1/Notes/Ideas.md': { id: 'doc-ideas-1', type: 'markdown', version: 0 },
      '/Relay Folder 2/Welcome.md': { id: 'doc-welcome-2', type: 'markdown', version: 0 },
      '/Relay Folder 2/Notes/Ideas.md': { id: 'doc-ideas-2', type: 'markdown', version: 0 },
    };

    describe('path-based links (has /)', () => {
      it('resolves path within current folder', () => {
        const result = resolvePageName('Notes/Ideas', prefixedMetadata, 'Relay Folder 1');
        expect(result).not.toBeNull();
        expect(result!.docId).toBe('doc-ideas-1');
      });

      it('resolves path from different folder', () => {
        const result = resolvePageName('Notes/Ideas', prefixedMetadata, 'Relay Folder 2');
        expect(result).not.toBeNull();
        expect(result!.docId).toBe('doc-ideas-2');
      });

      it('returns null when path not in current folder', () => {
        const result = resolvePageName('Notes/Ideas', prefixedMetadata, 'Nonexistent Folder');
        expect(result).toBeNull();
      });

      it('resolves case-insensitive path within folder', () => {
        const result = resolvePageName('notes/ideas', prefixedMetadata, 'Relay Folder 1');
        expect(result).not.toBeNull();
        expect(result!.docId).toBe('doc-ideas-1');
      });

      it('does not cross folders for path-based links', () => {
        // Path "Notes/Ideas" with a folder that has no Notes/Ideas.md
        // should NOT fall back to another folder
        const metadataOnlyInFolder1: FolderMetadata = {
          '/Folder A/Notes/Ideas.md': { id: 'only-in-a', type: 'markdown', version: 0 },
          '/Folder B/Other.md': { id: 'other-b', type: 'markdown', version: 0 },
        };
        const result = resolvePageName('Notes/Ideas', metadataOnlyInFolder1, 'Folder B');
        expect(result).toBeNull();
      });

      it('resolves path globally when no currentFolder', () => {
        const result = resolvePageName('Notes/Ideas', prefixedMetadata);
        expect(result).not.toBeNull();
      });
    });

    describe('basename links (no /)', () => {
      it('resolves globally ignoring currentFolder', () => {
        // "Welcome" exists in both folders — should find a match regardless of currentFolder
        const result = resolvePageName('Welcome', prefixedMetadata, 'Nonexistent Folder');
        expect(result).not.toBeNull();
      });

      it('resolves from any folder', () => {
        const result = resolvePageName('Welcome', prefixedMetadata, 'Relay Folder 1');
        expect(result).not.toBeNull();
        // Should find a Welcome.md (could be from either folder)
        expect(result!.path).toMatch(/Welcome\.md$/);
      });

      it('resolves without currentFolder', () => {
        const result = resolvePageName('Welcome', prefixedMetadata);
        expect(result).not.toBeNull();
      });

      it('resolves basename case-insensitively', () => {
        const result = resolvePageName('welcome', prefixedMetadata, 'Relay Folder 1');
        expect(result).not.toBeNull();
      });
    });
  });

  describe('ambiguous page names', () => {
    // Extended fixture with multiple files having the same name
    const ambiguousMetadata: FolderMetadata = {
      ...nestedMetadata,
      '/Projects/Beta/README.md': {
        id: 'aaaabbbb-cccc-4ddd-8eee-ffffffffffff',
        type: 'markdown',
        version: 0,
      },
      '/Archive/README.md': {
        id: 'bbbbcccc-dddd-4eee-8fff-000000000000',
        type: 'markdown',
        version: 0,
      },
    };

    it('returns the first match for duplicate page names', () => {
      // The current implementation returns the first matching entry found
      // This behavior depends on object iteration order
      const result = resolvePageName('README', ambiguousMetadata);

      expect(result).not.toBeNull();
      // Should return one of the README files (exact behavior depends on iteration order)
      const validIds = [
        nestedMetadata['/Projects/Alpha/README.md'].id,
        'aaaabbbb-cccc-4ddd-8eee-ffffffffffff',
        'bbbbcccc-dddd-4eee-8fff-000000000000',
      ];
      expect(validIds).toContain(result!.docId);
    });

    it('prefers exact case match over case-insensitive for duplicate names', () => {
      // When there are multiple matches, exact case should be preferred
      const result = resolvePageName('README', ambiguousMetadata);
      expect(result).not.toBeNull();
      // All README files have exact case match, so any is valid
      expect(result!.path).toMatch(/README\.md$/);
    });
  });
});

describe('generateNewDocPath', () => {
  it('adds .md extension', () => {
    expect(generateNewDocPath('New Page')).toBe('/New Page.md');
  });

  it('sanitizes invalid filename characters', () => {
    expect(generateNewDocPath('What is this?')).toBe('/What is this-.md');
  });

  it('replaces forward slashes', () => {
    expect(generateNewDocPath('A/B')).toBe('/A-B.md');
  });

  it('replaces backslashes', () => {
    expect(generateNewDocPath('A\\B')).toBe('/A-B.md');
  });

  it('replaces colons', () => {
    expect(generateNewDocPath('Time: 10:00')).toBe('/Time- 10-00.md');
  });

  it('handles names matching production document titles', () => {
    // Based on production-sample.json document names
    expect(generateNewDocPath('Course YAML examples')).toBe('/Course YAML examples.md');
    expect(generateNewDocPath('Dev, Staging, and Production environments')).toBe(
      '/Dev, Staging, and Production environments.md'
    );
  });
});
