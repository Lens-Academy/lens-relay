# Backlinks Feature Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Display backlinks (documents that link to the current document) in the Lens Editor sidebar, with infrastructure for future link-updating-on-rename.

**Architecture:** Server-side indexer (Rust, Phase 3) writes to `backlinks_v0` Y.Map in folder doc. Client-side hook reads and displays backlinks. Link extractor parses wikilinks from markdown. Existing `document-resolver.ts` handles name→UUID resolution.

**Tech Stack:** TypeScript, React, Vitest, Y.js, CodeMirror (existing), Rust/yrs (Phase 3)

---

## Phase 1: Link Extractor (Client Foundation)

### Task 1.1: Create Test Fixture for Wikilinks

**Files:**
- Create: `src/test/fixtures/documents/wikilinks-advanced.md`

**Step 1: Create the fixture file**

```markdown
# Advanced Wikilinks Test Document

## Basic Links
Simple: [[Note]]
Multiple: [[PageOne]] and [[PageTwo]]

## With Anchors
Section link: [[Note#Introduction]]
Deep anchor: [[Guide#Chapter 1#Section 2]]

## With Aliases
Aliased: [[Note|My Favorite Note]]
Long alias: [[Very Long Page Name|Short]]

## Combined
Full syntax: [[Note#Section|Display Text]]

## Edge Cases
Empty: [[]]
Unclosed: [[Broken
Just brackets: [ [Not a link] ]

## In Code (should be ignored)
Inline: `[[CodeNote]]`

Code block:
```
[[BlockNote]]
```

## Duplicates
Same link twice: [[Duplicate]] and [[Duplicate]]

## Special Characters
With spaces: [[My Note]]
With numbers: [[Note 123]]
```

**Step 2: Commit**

```bash
git add src/test/fixtures/documents/wikilinks-advanced.md
git commit -m "test: add wikilinks-advanced fixture for link extractor tests"
```

---

### Task 1.2: Write Failing Test - Basic Link Extraction

**Files:**
- Create: `src/lib/link-extractor.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { extractWikilinks } from './link-extractor';

describe('extractWikilinks', () => {
  describe('basic extraction', () => {
    it('extracts a simple wikilink', () => {
      const result = extractWikilinks('[[Note]]');
      expect(result).toEqual(['Note']);
    });

    it('returns empty array for no links', () => {
      const result = extractWikilinks('plain text with no links');
      expect(result).toEqual([]);
    });

    it('extracts multiple wikilinks', () => {
      const result = extractWikilinks('[[PageOne]] and [[PageTwo]]');
      expect(result).toEqual(['PageOne', 'PageTwo']);
    });
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test link-extractor
```

Expected: FAIL with "Cannot find module './link-extractor'"

**Step 3: Commit failing test**

```bash
git add src/lib/link-extractor.test.ts
git commit -m "test(RED): add basic link extraction tests"
```

---

### Task 1.3: Implement Basic Link Extraction

**Files:**
- Create: `src/lib/link-extractor.ts`

**Step 1: Write minimal implementation**

```typescript
/**
 * Extract wikilink targets from markdown text.
 * Returns the page names only (strips anchors and aliases).
 */
export function extractWikilinks(markdown: string): string[] {
  const links: string[] = [];
  const regex = /\[\[([^\]]+)\]\]/g;
  let match;

  while ((match = regex.exec(markdown)) !== null) {
    const content = match[1];
    if (content.trim()) {
      links.push(content);
    }
  }

  return links;
}
```

**Step 2: Run test to verify it passes**

```bash
npm test link-extractor
```

Expected: PASS

**Step 3: Commit**

```bash
git add src/lib/link-extractor.ts
git commit -m "feat(GREEN): implement basic wikilink extraction"
```

---

### Task 1.4: Write Failing Test - Anchor Handling

**Files:**
- Modify: `src/lib/link-extractor.test.ts`

**Step 1: Add the failing test**

```typescript
  describe('anchor handling', () => {
    it('strips anchor from link', () => {
      const result = extractWikilinks('[[Note#Section]]');
      expect(result).toEqual(['Note']);
    });

    it('strips deep anchor', () => {
      const result = extractWikilinks('[[Guide#Chapter 1#Section 2]]');
      expect(result).toEqual(['Guide']);
    });
  });
```

**Step 2: Run test to verify it fails**

```bash
npm test link-extractor
```

Expected: FAIL - returns `['Note#Section']` instead of `['Note']`

**Step 3: Commit failing test**

```bash
git add src/lib/link-extractor.test.ts
git commit -m "test(RED): add anchor handling tests"
```

---

### Task 1.5: Implement Anchor Stripping

**Files:**
- Modify: `src/lib/link-extractor.ts`

**Step 1: Update implementation to strip anchors**

Replace the function body:

```typescript
export function extractWikilinks(markdown: string): string[] {
  const links: string[] = [];
  const regex = /\[\[([^\]]+)\]\]/g;
  let match;

  while ((match = regex.exec(markdown)) !== null) {
    let content = match[1];
    if (!content.trim()) continue;

    // Strip anchor (#) - take only the part before first #
    const anchorIndex = content.indexOf('#');
    if (anchorIndex !== -1) {
      content = content.substring(0, anchorIndex);
    }

    if (content.trim()) {
      links.push(content.trim());
    }
  }

  return links;
}
```

**Step 2: Run test to verify it passes**

```bash
npm test link-extractor
```

Expected: PASS

**Step 3: Commit**

```bash
git add src/lib/link-extractor.ts
git commit -m "feat(GREEN): strip anchors from wikilinks"
```

---

### Task 1.6: Write Failing Test - Alias Handling

**Files:**
- Modify: `src/lib/link-extractor.test.ts`

**Step 1: Add the failing test**

```typescript
  describe('alias handling', () => {
    it('strips alias from link', () => {
      const result = extractWikilinks('[[Note|Display Text]]');
      expect(result).toEqual(['Note']);
    });

    it('handles anchor and alias combined', () => {
      const result = extractWikilinks('[[Note#Section|Display]]');
      expect(result).toEqual(['Note']);
    });
  });
```

**Step 2: Run test to verify it fails**

```bash
npm test link-extractor
```

Expected: FAIL - returns `['Note|Display Text']` or `['Note#Section|Display']`

**Step 3: Commit failing test**

```bash
git add src/lib/link-extractor.test.ts
git commit -m "test(RED): add alias handling tests"
```

---

### Task 1.7: Implement Alias Stripping

**Files:**
- Modify: `src/lib/link-extractor.ts`

**Step 1: Update implementation to strip aliases**

```typescript
export function extractWikilinks(markdown: string): string[] {
  const links: string[] = [];
  const regex = /\[\[([^\]]+)\]\]/g;
  let match;

  while ((match = regex.exec(markdown)) !== null) {
    let content = match[1];
    if (!content.trim()) continue;

    // Strip alias (|) - take only the part before |
    const pipeIndex = content.indexOf('|');
    if (pipeIndex !== -1) {
      content = content.substring(0, pipeIndex);
    }

    // Strip anchor (#) - take only the part before first #
    const anchorIndex = content.indexOf('#');
    if (anchorIndex !== -1) {
      content = content.substring(0, anchorIndex);
    }

    const trimmed = content.trim();
    if (trimmed) {
      links.push(trimmed);
    }
  }

  return links;
}
```

**Step 2: Run test to verify it passes**

```bash
npm test link-extractor
```

Expected: PASS

**Step 3: Commit**

```bash
git add src/lib/link-extractor.ts
git commit -m "feat(GREEN): strip aliases from wikilinks"
```

---

### Task 1.8: Write Failing Test - Edge Cases

**Files:**
- Modify: `src/lib/link-extractor.test.ts`

**Step 1: Add edge case tests**

```typescript
  describe('edge cases', () => {
    it('ignores empty brackets', () => {
      const result = extractWikilinks('[[]]');
      expect(result).toEqual([]);
    });

    it('ignores unclosed brackets', () => {
      const result = extractWikilinks('[[Broken');
      expect(result).toEqual([]);
    });

    it('ignores whitespace-only content', () => {
      const result = extractWikilinks('[[   ]]');
      expect(result).toEqual([]);
    });

    it('handles link with spaces in name', () => {
      const result = extractWikilinks('[[My Note]]');
      expect(result).toEqual(['My Note']);
    });

    it('preserves duplicate links', () => {
      const result = extractWikilinks('[[A]] and [[A]]');
      expect(result).toEqual(['A', 'A']);
    });
  });
```

**Step 2: Run test to verify it passes**

```bash
npm test link-extractor
```

Expected: PASS (these should already work with current implementation)

**Step 3: Commit**

```bash
git add src/lib/link-extractor.test.ts
git commit -m "test(GREEN): add edge case tests for link extractor"
```

---

### Task 1.9: Write Failing Test - Code Block Handling

**Files:**
- Modify: `src/lib/link-extractor.test.ts`

**Step 1: Add code block tests**

```typescript
  describe('code block handling', () => {
    it('ignores links in inline code', () => {
      const result = extractWikilinks('See `[[CodeNote]]` here');
      expect(result).toEqual([]);
    });

    it('ignores links in fenced code blocks', () => {
      const markdown = `
\`\`\`
[[BlockNote]]
\`\`\`
`;
      const result = extractWikilinks(markdown);
      expect(result).toEqual([]);
    });

    it('ignores links in tilde-fenced code blocks', () => {
      const markdown = `
~~~
[[TildeBlock]]
~~~
`;
      const result = extractWikilinks(markdown);
      expect(result).toEqual([]);
    });

    it('ignores links in code blocks with language specifier', () => {
      const markdown = `
\`\`\`markdown
[[InCodeBlock]]
\`\`\`
`;
      const result = extractWikilinks(markdown);
      expect(result).toEqual([]);
    });

    it('extracts links outside code but ignores inside', () => {
      const markdown = '[[RealLink]] and `[[FakeLink]]`';
      const result = extractWikilinks(markdown);
      expect(result).toEqual(['RealLink']);
    });
  });

  describe('anchor-only links', () => {
    it('returns empty for anchor-only links (current doc reference)', () => {
      const result = extractWikilinks('[[#Section]]');
      expect(result).toEqual([]);
    });
  });
```

**Step 2: Run test to verify it fails**

```bash
npm test link-extractor
```

Expected: FAIL - currently extracts links from code blocks

**Step 3: Commit failing test**

```bash
git add src/lib/link-extractor.test.ts
git commit -m "test(RED): add code block handling tests"
```

---

### Task 1.10: Implement Code Block Stripping

**Files:**
- Modify: `src/lib/link-extractor.ts`

**Step 1: Add code stripping before link extraction**

```typescript
/**
 * Remove code blocks and inline code from markdown.
 * This prevents extracting links from code examples.
 */
function stripCode(markdown: string): string {
  // Remove fenced code blocks (``` or ~~~ with optional language)
  let result = markdown.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1/gm, '');
  // Fallback: simple fenced blocks without matching
  result = result.replace(/```[\s\S]*?```/g, '');
  result = result.replace(/~~~[\s\S]*?~~~/g, '');
  // Remove inline code (handles empty backticks too)
  result = result.replace(/`[^`]*`/g, '');
  return result;
}

/**
 * Extract wikilink targets from markdown text.
 * Returns the page names only (strips anchors and aliases).
 * Ignores links inside code blocks and inline code.
 */
export function extractWikilinks(markdown: string): string[] {
  const links: string[] = [];
  const cleanedMarkdown = stripCode(markdown);
  const regex = /\[\[([^\]]+)\]\]/g;
  let match;

  while ((match = regex.exec(cleanedMarkdown)) !== null) {
    let content = match[1];
    if (!content.trim()) continue;

    // Strip alias (|) - take only the part before |
    const pipeIndex = content.indexOf('|');
    if (pipeIndex !== -1) {
      content = content.substring(0, pipeIndex);
    }

    // Strip anchor (#) - take only the part before first #
    const anchorIndex = content.indexOf('#');
    if (anchorIndex !== -1) {
      content = content.substring(0, anchorIndex);
    }

    const trimmed = content.trim();
    if (trimmed) {
      links.push(trimmed);
    }
  }

  return links;
}
```

**Step 2: Run test to verify it passes**

```bash
npm test link-extractor
```

Expected: PASS

**Step 3: Commit**

```bash
git add src/lib/link-extractor.ts
git commit -m "feat(GREEN): ignore wikilinks in code blocks"
```

---

### Task 1.11: Run Full Test Suite and Verify

**Step 1: Run all tests**

```bash
npm test
```

Expected: All tests pass

**Step 2: Run with coverage**

```bash
npm run test:coverage
```

Expected: link-extractor.ts has high coverage

---

## Phase 2: Backlinks Display (Client UI)

### Task 2.1: Extend MockRelayProvider for Backlinks

**Files:**
- Modify: `src/test/MockRelayProvider.tsx`

**Step 1: Write failing test for new helper**

Create a simple test in the test file first to verify the helper works:

```typescript
// In a scratch test or the actual test file
import { createDocFromFixture } from './MockRelayProvider';

it('createDocFromFixture supports backlinks', () => {
  const doc = createDocFromFixture(
    { '/Note.md': { id: 'uuid-1', type: 'markdown' } },
    { 'uuid-1': ['uuid-2', 'uuid-3'] }
  );
  const backlinks = doc.getMap('backlinks_v0');
  expect(backlinks.get('uuid-1')).toEqual(['uuid-2', 'uuid-3']);
});
```

**Step 2: Update createDocFromFixture to support backlinks**

```typescript
import React, { useState, createContext, useContext } from 'react';
import * as Y from 'yjs';
import type { FolderMetadata } from '../hooks/useFolderMetadata';

// Context for Y.Doc access in tests
export const YDocContext = createContext<Y.Doc | null>(null);

// Hook to access the Y.Doc in tests
export function useYDoc(): Y.Doc | null {
  return useContext(YDocContext);
}

interface MockRelayProviderProps {
  fixture: Record<string, FolderMetadata[string]>;
  backlinks?: Record<string, string[]>;
  children: React.ReactNode;
}

/**
 * Mock provider that creates an in-memory Y.Doc from fixture data.
 * Use in tests to avoid real relay server connections.
 */
export function MockRelayProvider({ fixture, backlinks, children }: MockRelayProviderProps) {
  const [doc] = useState(() => createDocFromFixture(fixture, backlinks));

  return (
    <YDocContext.Provider value={doc}>
      {children}
    </YDocContext.Provider>
  );
}

/**
 * Create a standalone Y.Doc from fixture for unit tests.
 * @param fixture - Map of paths to file metadata (filemeta_v0)
 * @param backlinks - Optional map of target UUIDs to source UUID arrays (backlinks_v0)
 */
export function createDocFromFixture(
  fixture: Record<string, FolderMetadata[string]>,
  backlinks?: Record<string, string[]>
): Y.Doc {
  const doc = new Y.Doc();

  // Populate filemeta_v0
  const filemeta = doc.getMap('filemeta_v0');
  for (const [path, meta] of Object.entries(fixture)) {
    filemeta.set(path, meta);
  }

  // Populate backlinks_v0 if provided
  if (backlinks) {
    const backlinksMap = doc.getMap<string[]>('backlinks_v0');
    for (const [targetId, sourceIds] of Object.entries(backlinks)) {
      backlinksMap.set(targetId, sourceIds);
    }
  }

  return doc;
}
```

**Step 3: Run tests to verify**

```bash
npm test MockRelayProvider
```

**Step 4: Commit**

```bash
git add src/test/MockRelayProvider.tsx
git commit -m "feat: extend MockRelayProvider to support backlinks_v0 fixture"
```

---

### ~~Tasks 2.2-2.4: REMOVED - useLinkIndex Hook~~

> **Review Finding:** These tasks were removed because `useLinkIndex` would create a **duplicate WebSocket connection** to the folder doc. The `useFolderMetadata` hook already connects to the folder doc and exposes it via `NavigationContext`. BacklinksPanel should read `backlinks_v0` directly from that existing `doc` - which is exactly what Task 2.6's implementation does.
>
> **Lesson:** Don't create new hooks that duplicate existing connections. Reuse the shared folder doc from context.

---

### Task 2.2: Create UUID-to-Path Helper

**Files:**
- Create: `src/lib/uuid-to-path.ts`
- Create: `src/lib/uuid-to-path.test.ts`

**Step 1: Write failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { findPathByUuid } from './uuid-to-path';
import type { FolderMetadata } from '../hooks/useFolderMetadata';

describe('findPathByUuid', () => {
  const metadata: FolderMetadata = {
    '/Notes.md': { id: 'uuid-1', type: 'markdown', version: 0 },
    '/Projects/README.md': { id: 'uuid-2', type: 'markdown', version: 0 },
    '/image.png': { id: 'uuid-3', type: 'image', version: 0 },
  };

  it('returns path for existing UUID', () => {
    expect(findPathByUuid('uuid-1', metadata)).toBe('/Notes.md');
  });

  it('returns path for nested file', () => {
    expect(findPathByUuid('uuid-2', metadata)).toBe('/Projects/README.md');
  });

  it('returns null for non-existent UUID', () => {
    expect(findPathByUuid('missing-uuid', metadata)).toBeNull();
  });

  it('returns null for empty metadata', () => {
    expect(findPathByUuid('uuid-1', {})).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test uuid-to-path
```

Expected: FAIL

**Step 3: Write minimal implementation**

```typescript
import type { FolderMetadata } from '../hooks/useFolderMetadata';

/**
 * Find the file path for a given document UUID.
 * This is a linear scan - acceptable for <1000 docs.
 */
export function findPathByUuid(uuid: string, metadata: FolderMetadata): string | null {
  for (const [path, meta] of Object.entries(metadata)) {
    if (meta.id === uuid) {
      return path;
    }
  }
  return null;
}
```

**Step 4: Run test to verify it passes**

```bash
npm test uuid-to-path
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/uuid-to-path.ts src/lib/uuid-to-path.test.ts
git commit -m "feat: add findPathByUuid helper for reverse UUID lookup"
```

---

### Task 2.3: Write Failing Test - BacklinksPanel Component

**Files:**
- Create: `src/components/BacklinksPanel/BacklinksPanel.test.tsx`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import * as Y from 'yjs';
import { BacklinksPanel } from './BacklinksPanel';
import { NavigationContext } from '../../contexts/NavigationContext';
import type { FolderMetadata } from '../../hooks/useFolderMetadata';

// Helper to create test context
function createTestContext(metadata: FolderMetadata, backlinks: Record<string, string[]>) {
  const doc = new Y.Doc();
  const backlinksMap = doc.getMap<string[]>('backlinks_v0');
  for (const [targetId, sourceIds] of Object.entries(backlinks)) {
    backlinksMap.set(targetId, sourceIds);
  }
  return { metadata, doc, onNavigate: vi.fn() };
}

describe('BacklinksPanel', () => {
  it('shows "No backlinks" when empty', () => {
    const ctx = createTestContext(
      { '/Note.md': { id: 'uuid-1', type: 'markdown', version: 0 } },
      {}
    );

    render(
      <NavigationContext.Provider value={ctx}>
        <BacklinksPanel currentDocId="uuid-1" />
      </NavigationContext.Provider>
    );

    expect(screen.getByText(/no backlinks/i)).toBeInTheDocument();
  });

  it('displays backlink document names', () => {
    const metadata: FolderMetadata = {
      '/Target.md': { id: 'target-uuid', type: 'markdown', version: 0 },
      '/Source1.md': { id: 'source-1', type: 'markdown', version: 0 },
      '/Folder/Source2.md': { id: 'source-2', type: 'markdown', version: 0 },
    };
    const backlinks = {
      'target-uuid': ['source-1', 'source-2'],
    };
    const ctx = createTestContext(metadata, backlinks);

    render(
      <NavigationContext.Provider value={ctx}>
        <BacklinksPanel currentDocId="target-uuid" />
      </NavigationContext.Provider>
    );

    expect(screen.getByText('Source1')).toBeInTheDocument();
    expect(screen.getByText('Source2')).toBeInTheDocument();
  });

  it('calls onNavigate when clicking a backlink', () => {
    const metadata: FolderMetadata = {
      '/Target.md': { id: 'target-uuid', type: 'markdown', version: 0 },
      '/Source.md': { id: 'source-uuid', type: 'markdown', version: 0 },
    };
    const backlinks = { 'target-uuid': ['source-uuid'] };
    const ctx = createTestContext(metadata, backlinks);

    render(
      <NavigationContext.Provider value={ctx}>
        <BacklinksPanel currentDocId="target-uuid" />
      </NavigationContext.Provider>
    );

    fireEvent.click(screen.getByText('Source'));

    expect(ctx.onNavigate).toHaveBeenCalledWith('source-uuid');
  });

  it('handles missing source documents gracefully', () => {
    const metadata: FolderMetadata = {
      '/Target.md': { id: 'target-uuid', type: 'markdown', version: 0 },
      // source-uuid is NOT in metadata (deleted document)
    };
    const backlinks = { 'target-uuid': ['source-uuid'] };
    const ctx = createTestContext(metadata, backlinks);

    render(
      <NavigationContext.Provider value={ctx}>
        <BacklinksPanel currentDocId="target-uuid" />
      </NavigationContext.Provider>
    );

    // Should not crash, might show unknown or filter out
    expect(screen.queryByText(/no backlinks/i)).toBeInTheDocument();
  });

  it('shows loading state when doc is null', () => {
    const ctx = { metadata: {}, doc: null, onNavigate: vi.fn() };

    render(
      <NavigationContext.Provider value={ctx}>
        <BacklinksPanel currentDocId="any-id" />
      </NavigationContext.Provider>
    );

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test BacklinksPanel
```

Expected: FAIL - module not found

**Step 3: Commit failing test**

```bash
mkdir -p src/components/BacklinksPanel
git add src/components/BacklinksPanel/BacklinksPanel.test.tsx
git commit -m "test(RED): add BacklinksPanel component tests"
```

---

### Task 2.4: Implement BacklinksPanel Component

**Files:**
- Create: `src/components/BacklinksPanel/BacklinksPanel.tsx`
- Create: `src/components/BacklinksPanel/index.ts`

**Step 1: Create the component**

```typescript
// BacklinksPanel.tsx
import { useMemo, useState, useEffect } from 'react';
import { useNavigation } from '../../contexts/NavigationContext';
import { findPathByUuid } from '../../lib/uuid-to-path';

interface BacklinksPanelProps {
  currentDocId: string;
}

/**
 * Panel displaying documents that link to the current document.
 * Observes backlinks_v0 Y.Map for live updates.
 */
export function BacklinksPanel({ currentDocId }: BacklinksPanelProps) {
  const { metadata, doc, onNavigate } = useNavigation();

  // Force re-render when backlinks Y.Map changes
  const [backlinksVersion, setBacklinksVersion] = useState(0);

  // Subscribe to backlinks_v0 changes for live updates
  useEffect(() => {
    if (!doc) return;

    const backlinksMap = doc.getMap<string[]>('backlinks_v0');
    const observer = () => setBacklinksVersion(v => v + 1);
    backlinksMap.observe(observer);

    return () => backlinksMap.unobserve(observer);
  }, [doc]);

  // Get backlinks from the folder doc's backlinks_v0 Y.Map
  const backlinks = useMemo(() => {
    // Trigger re-compute when backlinksVersion changes
    void backlinksVersion;

    if (!doc) return [];

    const backlinksMap = doc.getMap<string[]>('backlinks_v0');
    const sourceUuids = backlinksMap.get(currentDocId) || [];

    // Resolve UUIDs to paths, filtering out missing docs
    return sourceUuids
      .map(uuid => {
        const path = findPathByUuid(uuid, metadata);
        if (!path) return null;

        // Extract filename without extension for display
        const filename = path.split('/').pop() || path;
        const displayName = filename.replace(/\.md$/i, '');

        return { uuid, path, displayName };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
  }, [doc, currentDocId, metadata, backlinksVersion]);

  // Loading state when doc not yet available
  if (!doc) {
    return (
      <div className="p-3 text-sm text-gray-400">
        Loading...
      </div>
    );
  }

  if (backlinks.length === 0) {
    return (
      <div className="p-3 text-sm text-gray-500">
        No backlinks
      </div>
    );
  }

  return (
    <div className="p-3">
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
        Backlinks
      </h3>
      <ul className="space-y-1">
        {backlinks.map(({ uuid, displayName }) => (
          <li key={uuid}>
            <button
              onClick={() => onNavigate(uuid)}
              className="w-full text-left px-2 py-1 text-sm text-gray-700 hover:bg-gray-100 rounded transition-colors"
            >
              {displayName}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

```typescript
// index.ts
export { BacklinksPanel } from './BacklinksPanel';
```

**Step 2: Run test to verify it passes**

```bash
npm test BacklinksPanel
```

Expected: PASS

**Step 3: Commit**

```bash
git add src/components/BacklinksPanel/
git commit -m "feat(GREEN): implement BacklinksPanel component"
```

---

### Task 2.5: Integrate BacklinksPanel into EditorArea

**Files:**
- Modify: `src/components/Layout/EditorArea.tsx`

**Step 1: Add the import and component**

```typescript
import { useState, useCallback } from 'react';
import { EditorView } from '@codemirror/view';
import { SyncStatus } from '../SyncStatus/SyncStatus';
import { Editor } from '../Editor/Editor';
import { SourceModeToggle } from '../SourceModeToggle/SourceModeToggle';
import { PresencePanel } from '../PresencePanel/PresencePanel';
import { TableOfContents } from '../TableOfContents';
import { BacklinksPanel } from '../BacklinksPanel';
import { DebugYMapPanel } from '../DebugYMapPanel';
import { useNavigation } from '../../contexts/NavigationContext';

/**
 * Editor area component that lives INSIDE the RelayProvider key boundary.
 * This allows it to remount when switching documents while keeping
 * the Sidebar stable outside the boundary.
 */
export function EditorArea({ currentDocId }: { currentDocId: string }) {
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const [stateVersion, setStateVersion] = useState(0);
  const { metadata, onNavigate } = useNavigation();

  // Callback to receive view reference from Editor
  const handleEditorReady = useCallback((view: EditorView) => {
    setEditorView(view);
    setStateVersion(v => v + 1);
  }, []);

  // Callback for document changes
  const handleDocChange = useCallback(() => {
    setStateVersion(v => v + 1);
  }, []);

  return (
    <main className="flex-1 flex flex-col min-h-0">
      {/* Controls bar */}
      <div className="flex items-center justify-end gap-4 px-4 py-2 bg-white border-b border-gray-200">
        <DebugYMapPanel />
        <SourceModeToggle editorView={editorView} />
        <PresencePanel />
        <SyncStatus />
      </div>
      {/* Editor + Sidebars container */}
      <div className="flex-1 flex min-h-0">
        {/* Editor */}
        <div className="flex-1 px-4 py-6 min-w-0 overflow-auto">
          <Editor
            onEditorReady={handleEditorReady}
            onDocChange={handleDocChange}
            onNavigate={onNavigate}
            metadata={metadata}
          />
        </div>
        {/* Right Sidebar */}
        <aside className="w-56 flex-shrink-0 border-l border-gray-200 bg-white overflow-y-auto flex flex-col">
          <TableOfContents view={editorView} stateVersion={stateVersion} />
          <div className="border-t border-gray-200">
            <BacklinksPanel currentDocId={currentDocId} />
          </div>
        </aside>
      </div>
    </main>
  );
}
```

**Note:** This change requires `currentDocId` to be passed to EditorArea. Check how EditorArea is used and update the parent component accordingly.

**Step 2: Update App.tsx to pass currentDocId**

In `src/App.tsx`, change line 50 from:

```tsx
<EditorArea />
```

to:

```tsx
<EditorArea currentDocId={activeDocId} />
```

The `activeDocId` state already exists in App.tsx (line 30) - it just needs to be passed through.

**Step 3: Test manually**

```bash
npm run dev
```

Open the editor and verify BacklinksPanel appears below TableOfContents.

**Step 4: Commit**

```bash
git add src/components/Layout/EditorArea.tsx src/App.tsx
git commit -m "feat: integrate BacklinksPanel into EditorArea sidebar"
```

---

### Task 2.6: Run Full Test Suite

**Step 1: Run all tests**

```bash
npm test
```

Expected: All tests pass

**Step 2: Run linting**

```bash
npm run lint
```

Expected: No errors

---

## Phase 3: Server-Side Link Indexer (relay-server - Rust)

> **Note:** This phase is implemented in the `relay-server` Rust codebase. The following outlines the implementation steps but with less code detail since it's a different tech stack.

### Task 3.1: Add Link Parser Module

**Files:**
- Create: `relay-server/src/link_parser.rs`

**Implementation:**
- Regex pattern: `\[\[([^\]]+)\]\]`
- Strip code blocks before parsing
- Strip anchors (`#`) and aliases (`|`) from content
- Return `Vec<String>` of link targets

**Tests:**
- Basic extraction
- Anchor/alias stripping
- Code block handling

---

### Task 3.2: Add Folder-Doc Reverse Index

**Files:**
- Modify: `relay-server/src/server.rs` (or appropriate module)

**Implementation:**
- `HashMap<String, String>` mapping `doc_uuid -> folder_id`
- Populate when folder doc loads by scanning `filemeta_v0`
- Update when `filemeta_v0` changes

---

### Task 3.3: Add Link Indexer with Debouncing

**Files:**
- Create: `relay-server/src/link_indexer.rs`

**Implementation:**
- Hook into `observe_update_v1` for content docs
- Check `transaction.origin` - skip if "link-indexer"
- Debounce: reset 2-second timer on each change
- When timer fires:
  1. Extract text from `Y.Text("contents")`
  2. Parse wikilinks
  3. Resolve to UUIDs via `filemeta_v0`
  4. Update `backlinks_v0` in folder doc

---

### Task 3.4: Add Startup Full-Scan

**Files:**
- Modify: `relay-server/src/link_indexer.rs`

**Implementation:**
- On server startup, for each loaded folder doc:
  1. Scan all content docs referenced in `filemeta_v0`
  2. Build complete backlinks index
  3. Write to `backlinks_v0`

---

### Task 3.5: Integration Testing

**Steps:**
1. Start local relay-server
2. Connect with Lens Editor
3. Edit a document to add `[[Link]]`
4. Verify `backlinks_v0` updates
5. Open the target document
6. Verify BacklinksPanel shows the source

---

## Summary: Commit Sequence

1. `test: add wikilinks-advanced fixture for link extractor tests`
2. `test(RED): add basic link extraction tests`
3. `feat(GREEN): implement basic wikilink extraction`
4. `test(RED): add anchor handling tests`
5. `feat(GREEN): strip anchors from wikilinks`
6. `test(RED): add alias handling tests`
7. `feat(GREEN): strip aliases from wikilinks`
8. `test(GREEN): add edge case tests for link extractor`
9. `test(RED): add code block handling tests`
10. `feat(GREEN): ignore wikilinks in code blocks`
11. `feat: extend MockRelayProvider to support backlinks_v0 fixture`
12. `feat: add findPathByUuid helper for reverse UUID lookup`
13. `test(RED): add BacklinksPanel component tests`
14. `feat(GREEN): implement BacklinksPanel component`
15. `feat: integrate BacklinksPanel into EditorArea sidebar`

---

Plan complete and saved to `docs/plans/2026-02-04-backlinks-implementation.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
