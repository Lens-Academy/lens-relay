import { describe, it, expect } from 'vitest';
import { resolvePageName, resolveRelative, computeRelativePath, generateNewDocPath } from './document-resolver';
import type { FolderMetadata } from '../hooks/useFolderMetadata';

describe('resolvePageName', () => {
  const metadata: FolderMetadata = {
    '/RF1/Projects': { id: 'f-proj', type: 'folder', version: 0 },
    '/RF1/Projects/Roadmap.md': { id: 'doc-roadmap', type: 'markdown', version: 0 },
    '/RF1/Projects/Plan.md': { id: 'doc-plan', type: 'markdown', version: 0 },
    '/RF1/Notes/Ideas.md': { id: 'doc-ideas', type: 'markdown', version: 0 },
    '/RF1/Welcome.md': { id: 'doc-welcome-1', type: 'markdown', version: 0 },
    '/RF2/Welcome.md': { id: 'doc-welcome-2', type: 'markdown', version: 0 },
    '/RF2/Course Notes.md': { id: 'doc-course', type: 'markdown', version: 0 },
  };

  describe('relative resolution (priority 1)', () => {
    it('resolves sibling file', () => {
      const result = resolvePageName('Plan', metadata, '/RF1/Projects/Roadmap.md');
      expect(result).not.toBeNull();
      expect(result!.docId).toBe('doc-plan');
    });

    it('resolves ../ to parent directory', () => {
      const result = resolvePageName('../Welcome', metadata, '/RF1/Projects/Roadmap.md');
      expect(result).not.toBeNull();
      expect(result!.docId).toBe('doc-welcome-1');
    });

    it('resolves ../Dir/File cousin path', () => {
      const result = resolvePageName('../Notes/Ideas', metadata, '/RF1/Projects/Roadmap.md');
      expect(result).not.toBeNull();
      expect(result!.docId).toBe('doc-ideas');
    });

    it('resolves cross-folder via ../../', () => {
      const result = resolvePageName('../../RF2/Course Notes', metadata, '/RF1/Projects/Roadmap.md');
      expect(result).not.toBeNull();
      expect(result!.docId).toBe('doc-course');
    });

    it('is case-insensitive', () => {
      const result = resolvePageName('plan', metadata, '/RF1/Projects/Roadmap.md');
      expect(result).not.toBeNull();
      expect(result!.docId).toBe('doc-plan');
    });
  });

  describe('absolute resolution (priority 2)', () => {
    it('resolves full path from root', () => {
      // Relative: /RF1/Projects/RF1/Notes/Ideas.md → not found
      // Absolute: /RF1/Notes/Ideas.md → found
      const result = resolvePageName('RF1/Notes/Ideas', metadata, '/RF1/Projects/Roadmap.md');
      expect(result).not.toBeNull();
      expect(result!.docId).toBe('doc-ideas');
    });

    it('resolves when no currentFilePath', () => {
      const result = resolvePageName('RF1/Welcome', metadata);
      expect(result).not.toBeNull();
      expect(result!.docId).toBe('doc-welcome-1');
    });

    it('is case-insensitive', () => {
      const result = resolvePageName('rf1/welcome', metadata);
      expect(result).not.toBeNull();
      expect(result!.docId).toBe('doc-welcome-1');
    });
  });

  describe('relative takes priority over absolute', () => {
    it('prefers relative match when both could match', () => {
      const result = resolvePageName('Plan', metadata, '/RF1/Projects/Roadmap.md');
      expect(result!.docId).toBe('doc-plan');
    });

    it('falls through to absolute when relative misses', () => {
      const result = resolvePageName('RF2/Welcome', metadata, '/RF1/Projects/Roadmap.md');
      expect(result!.docId).toBe('doc-welcome-2');
    });
  });

  describe('resolution failure', () => {
    it('returns null when not found anywhere', () => {
      expect(resolvePageName('NonExistent', metadata, '/RF1/Projects/Roadmap.md')).toBeNull();
    });

    it('returns null for folder entries', () => {
      expect(resolvePageName('Projects', metadata, '/RF1/Welcome.md')).toBeNull();
    });

    it('returns null for basename-only without currentFilePath', () => {
      // "Plan" absolute → /Plan.md → not found
      expect(resolvePageName('Plan', metadata)).toBeNull();
    });
  });

  describe('single-folder metadata (no folder prefix)', () => {
    const simpleMetadata: FolderMetadata = {
      '/My Page.md': { id: 'doc-1', type: 'markdown', version: 0 },
      '/Existing Page.md': { id: 'doc-2', type: 'markdown', version: 0 },
    };

    it('resolves via absolute path', () => {
      const result = resolvePageName('My Page', simpleMetadata);
      expect(result).not.toBeNull();
      expect(result!.docId).toBe('doc-1');
    });

    it('returns null for non-existent page', () => {
      expect(resolvePageName('NonExistent', simpleMetadata)).toBeNull();
    });
  });
});

describe('resolveRelative', () => {
  it('resolves sibling file', () => {
    expect(resolveRelative('/RF1/Projects/Roadmap.md', 'Plan'))
      .toBe('/RF1/Projects/Plan.md');
  });

  it('resolves parent directory with ../', () => {
    expect(resolveRelative('/RF1/Projects/Roadmap.md', '../Welcome'))
      .toBe('/RF1/Welcome.md');
  });

  it('resolves cousin path via ../', () => {
    expect(resolveRelative('/RF1/Projects/Roadmap.md', '../Notes/Ideas'))
      .toBe('/RF1/Notes/Ideas.md');
  });

  it('resolves cross-folder with multiple ../', () => {
    expect(resolveRelative('/RF1/Projects/Roadmap.md', '../../RF2/Course Notes'))
      .toBe('/RF2/Course Notes.md');
  });

  it('resolves subdirectory path', () => {
    expect(resolveRelative('/RF1/Projects/Roadmap.md', 'Sub/Deep'))
      .toBe('/RF1/Projects/Sub/Deep.md');
  });

  it('clamps at root (does not go above /)', () => {
    expect(resolveRelative('/RF1/Welcome.md', '../../Above'))
      .toBe('/Above.md');
  });

  it('handles root-level file', () => {
    expect(resolveRelative('/Welcome.md', 'Other'))
      .toBe('/Other.md');
  });

  it('handles . segments', () => {
    expect(resolveRelative('/RF1/Projects/Roadmap.md', './Plan'))
      .toBe('/RF1/Projects/Plan.md');
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

describe('computeRelativePath', () => {
  it('returns basename for sibling file', () => {
    expect(computeRelativePath('/RF1/Projects/Roadmap.md', '/RF1/Projects/Plan.md'))
      .toBe('Plan');
  });

  it('returns ../ for parent directory file', () => {
    expect(computeRelativePath('/RF1/Projects/Roadmap.md', '/RF1/Welcome.md'))
      .toBe('../Welcome');
  });

  it('returns ../ path for cousin file', () => {
    expect(computeRelativePath('/RF1/Projects/Roadmap.md', '/RF1/Notes/Ideas.md'))
      .toBe('../Notes/Ideas');
  });

  it('returns multiple ../ for cross-folder file', () => {
    expect(computeRelativePath('/RF1/Projects/Roadmap.md', '/RF2/Course Notes.md'))
      .toBe('../../RF2/Course Notes');
  });

  it('returns subdirectory path', () => {
    expect(computeRelativePath('/RF1/Projects/Roadmap.md', '/RF1/Projects/Sub/Deep.md'))
      .toBe('Sub/Deep');
  });

  it('handles root-level files', () => {
    expect(computeRelativePath('/Welcome.md', '/Other.md'))
      .toBe('Other');
  });

  it('is inverse of resolveRelative', () => {
    const from = '/RF1/Projects/Roadmap.md';
    const to = '/RF1/Notes/Ideas.md';
    const rel = computeRelativePath(from, to);
    expect(resolveRelative(from, rel)).toBe(to);
  });
});

describe('Spec Matrix (docs/wikilink-resolution-spec.md)', () => {
  // Virtual tree entries matching the spec exactly
  const spec: FolderMetadata = {
    '/Relay Folder 1/Welcome.md': { id: 'W', type: 'markdown', version: 0 },
    '/Relay Folder 1/Getting Started.md': { id: 'GS', type: 'markdown', version: 0 },
    '/Relay Folder 1/Notes': { id: 'f-notes', type: 'folder', version: 0 },
    '/Relay Folder 1/Notes/Ideas.md': { id: 'I', type: 'markdown', version: 0 },
    '/Relay Folder 1/Projects': { id: 'f-proj', type: 'folder', version: 0 },
    '/Relay Folder 1/Projects/Roadmap.md': { id: 'R', type: 'markdown', version: 0 },
    '/Relay Folder 2/Course Notes.md': { id: 'CN', type: 'markdown', version: 0 },
    '/Relay Folder 2/Syllabus.md': { id: 'S', type: 'markdown', version: 0 },
    '/Relay Folder 2/Resources': { id: 'f-res', type: 'folder', version: 0 },
    '/Relay Folder 2/Resources/Links.md': { id: 'L', type: 'markdown', version: 0 },
  };

  // Helper: assert resolves to expected ID
  const expectResolves = (link: string, from: string, expectedId: string) => {
    const result = resolvePageName(link, spec, from);
    expect(result, `[[${link}]] from ${from}`).not.toBeNull();
    expect(result!.docId).toBe(expectedId);
  };

  // Helper: assert does NOT resolve
  const expectNull = (link: string, from: string) => {
    expect(resolvePageName(link, spec, from), `[[${link}]] from ${from}`).toBeNull();
  };

  describe('from [W] Relay Folder 1/Welcome.md', () => {
    const W = '/Relay Folder 1/Welcome.md';
    it('[[Getting Started]] → GS (relative sibling)', () => expectResolves('Getting Started', W, 'GS'));
    it('[[Notes/Ideas]] → I (relative subdirectory)', () => expectResolves('Notes/Ideas', W, 'I'));
    it('[[Ideas]] → null (no basename matching)', () => expectNull('Ideas', W));
    it('[[Nonexistent]] → null', () => expectNull('Nonexistent', W));
    it('[[Relay Folder 2/Syllabus]] → S (absolute cross-folder)', () => expectResolves('Relay Folder 2/Syllabus', W, 'S'));
    it('[[../Relay Folder 2/Syllabus]] → S (relative cross-folder)', () => expectResolves('../Relay Folder 2/Syllabus', W, 'S'));
  });

  describe('from [I] Relay Folder 1/Notes/Ideas.md', () => {
    const I = '/Relay Folder 1/Notes/Ideas.md';
    it('[[../Welcome]] → W', () => expectResolves('../Welcome', I, 'W'));
    it('[[../Projects/Roadmap]] → R', () => expectResolves('../Projects/Roadmap', I, 'R'));
    it('[[../Getting Started]] → GS', () => expectResolves('../Getting Started', I, 'GS'));
    it('[[Welcome]] → null (no /Notes/Welcome.md)', () => expectNull('Welcome', I));
    it('[[Getting Started]] → null', () => expectNull('Getting Started', I));
    it('[[Ideas]] → I (self-link)', () => expectResolves('Ideas', I, 'I'));
    it('[[Relay Folder 1/Welcome]] → W (absolute)', () => expectResolves('Relay Folder 1/Welcome', I, 'W'));
  });

  describe('from [R] Relay Folder 1/Projects/Roadmap.md', () => {
    const R = '/Relay Folder 1/Projects/Roadmap.md';
    it('[[../Notes/Ideas]] → I', () => expectResolves('../Notes/Ideas', R, 'I'));
    it('[[../Welcome]] → W', () => expectResolves('../Welcome', R, 'W'));
    it('[[Notes/Ideas]] → null', () => expectNull('Notes/Ideas', R));
    it('[[Welcome]] → null', () => expectNull('Welcome', R));
  });

  describe('from [L] Relay Folder 2/Resources/Links.md', () => {
    const L = '/Relay Folder 2/Resources/Links.md';
    it('[[../Syllabus]] → S', () => expectResolves('../Syllabus', L, 'S'));
    it('[[../Course Notes]] → CN', () => expectResolves('../Course Notes', L, 'CN'));
    it('[[Syllabus]] → null', () => expectNull('Syllabus', L));
    it('[[../../Relay Folder 1/Notes/Ideas]] → I (cross-folder relative)', () => expectResolves('../../Relay Folder 1/Notes/Ideas', L, 'I'));
    it('[[../../Relay Folder 1/Welcome]] → W (cross-folder relative)', () => expectResolves('../../Relay Folder 1/Welcome', L, 'W'));
    it('[[Relay Folder 1/Notes/Ideas]] → I (cross-folder absolute)', () => expectResolves('Relay Folder 1/Notes/Ideas', L, 'I'));
    it('[[../../Nonexistent Folder/File]] → null', () => expectNull('../../Nonexistent Folder/File', L));
  });

  describe('from [CN] Relay Folder 2/Course Notes.md', () => {
    const CN = '/Relay Folder 2/Course Notes.md';
    it('[[Syllabus]] → S', () => expectResolves('Syllabus', CN, 'S'));
    it('[[Resources/Links]] → L', () => expectResolves('Resources/Links', CN, 'L'));
    it('[[../Relay Folder 1/Welcome]] → W (cross-folder relative)', () => expectResolves('../Relay Folder 1/Welcome', CN, 'W'));
    it('[[Relay Folder 1/Welcome]] → W (cross-folder absolute)', () => expectResolves('Relay Folder 1/Welcome', CN, 'W'));
  });

  describe('from [S] Relay Folder 2/Syllabus.md', () => {
    const S = '/Relay Folder 2/Syllabus.md';
    it('[[Course Notes]] → CN', () => expectResolves('Course Notes', S, 'CN'));
    it('[[Resources/Links]] → L', () => expectResolves('Resources/Links', S, 'L'));
  });

  describe('type filtering', () => {
    it('folder entries never resolve', () => expectNull('Notes', '/Relay Folder 1/Welcome.md'));
    it('folder entries never resolve (RF2)', () => expectNull('Resources', '/Relay Folder 2/Course Notes.md'));
  });
});
