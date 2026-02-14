# Obsidian-Style Link Resolution Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Align `resolvePageName()` with Obsidian's link resolution: basename-only links resolve globally across all folders, path-based links resolve only within the current folder.

**Architecture:** Single function change in `document-resolver.ts`. The `currentFolder` scoping filter moves from "applied always" to "applied only when pageName contains `/`". Basename queries (no `/`) always search all entries globally. Component wiring (EditorArea, Editor) is already done and unchanged.

**Tech Stack:** TypeScript, Vitest

---

## Context

**Current behavior (broken):** When `currentFolder` is provided, ALL matching (both path and basename) is scoped to that folder. This means `[[Welcome]]` from Folder 1 won't find `Welcome.md` in Folder 2, and `[[Welcome]]` from a nonexistent folder returns null.

**Desired behavior (Obsidian-style):**
- `[[filename]]` (no `/`) -- global basename match across ALL folders, ignoring `currentFolder`
- `[[path/to/filename]]` (has `/`) -- match only within `currentFolder` (relative/absolute within that folder), no cross-folder fallback

**Files already wired (NO changes needed):**
- `src/components/Layout/EditorArea.tsx` -- derives `currentFolder` from doc ID
- `src/components/Editor/Editor.tsx` -- passes `currentFolder` to `resolvePageName()`

**Files to change:**
- `src/lib/document-resolver.ts` -- resolution algorithm
- `src/lib/document-resolver.test.ts` -- update tests to match new behavior

---

## Task 1: Update Tests for New Basename Global Behavior

**Files:**
- Modify: `src/lib/document-resolver.test.ts:114-157` (folder-prefixed paths describe block)

The existing "folder-prefixed paths" test block has tests that assume basename is scoped to `currentFolder`. These need updating to reflect the new behavior: basename is always global.

### Step 1: Write failing tests (RED)

Replace the entire `folder-prefixed paths (multi-folder)` describe block with:

```typescript
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
```

### Step 2: Run tests to verify they fail

Run: `cd /home/penguin/code/lens-relay/ws2/lens-editor && npx vitest run src/lib/document-resolver.test.ts`

Expected: 2 tests fail:
- `resolves globally ignoring currentFolder` -- currently returns null because basename is scoped to "Nonexistent Folder"
- `resolves basename case-insensitively` (with currentFolder='Relay Folder 1') might pass, but the "ignoring currentFolder" test definitely fails

---

## Task 2: Implement Obsidian-Style Resolution

**Files:**
- Modify: `src/lib/document-resolver.ts:20-57` (resolvePageName function)

### Step 3: Write minimal implementation (GREEN)

Replace the `resolvePageName` function body with:

```typescript
export function resolvePageName(
  pageName: string,
  metadata: FolderMetadata,
  currentFolder?: string
): ResolvedDocument | null {
  const hasPath = pageName.includes('/');
  const lowerName = pageName.toLowerCase();
  const lowerPathSuffix = ('/' + pageName + '.md').toLowerCase();

  // Path-based links: scope to currentFolder only
  // Basename links: search globally (ignore currentFolder)
  const folderPrefix = (hasPath && currentFolder) ? `/${currentFolder}/` : null;
  const lowerFolderPrefix = folderPrefix?.toLowerCase() ?? null;

  let basenameMatch: ResolvedDocument | null = null;

  for (const [path, meta] of Object.entries(metadata)) {
    if (meta.type !== 'markdown') continue;

    const lowerPath = path.toLowerCase();

    // Skip entries outside current folder (only for path-based links)
    if (lowerFolderPrefix && !lowerPath.startsWith(lowerFolderPrefix)) continue;

    // Tier 1: Path suffix match — return immediately
    if (lowerPath.endsWith(lowerPathSuffix)) {
      return { docId: meta.id, path };
    }

    // Tier 2: Basename match — save as fallback (only for non-path links)
    if (!hasPath && !basenameMatch) {
      const filename = path.split('/').pop() || '';
      const nameWithoutExt = filename.replace(/\.md$/i, '');
      if (nameWithoutExt.toLowerCase() === lowerName) {
        basenameMatch = { docId: meta.id, path };
      }
    }
  }

  return basenameMatch;
}
```

Update the JSDoc comment above the function:

```typescript
/**
 * Resolve a page name to a document ID (case-insensitive, matching Obsidian).
 *
 * Resolution strategy depends on whether pageName contains a path separator:
 *
 * - Basename only ("Ideas"): global search across all folders.
 *   Matches any file whose name (without .md) equals pageName.
 *
 * - Path-based ("Notes/Ideas"): scoped to currentFolder when provided.
 *   Matches paths ending with /pageName.md within the folder.
 *   No cross-folder fallback — returns null if not found in currentFolder.
 *
 * All matching is case-insensitive.
 */
```

### Step 4: Run tests to verify they pass

Run: `cd /home/penguin/code/lens-relay/ws2/lens-editor && npx vitest run src/lib/document-resolver.test.ts`

Expected: ALL tests pass (including unchanged nested-hierarchy, edge-cases, ambiguous, and generateNewDocPath tests)

### Step 5: Commit

```bash
jj st
jj describe -m "feat: align wikilink resolution with Obsidian behavior

Basename links ([[filename]]) resolve globally across all folders.
Path links ([[path/to/file]]) resolve only within the current folder.
This matches Obsidian's getFirstLinkpathDest() resolution strategy."
```

---

## Task 3: Run Full Test Suite

### Step 6: Run all unit tests

Run: `cd /home/penguin/code/lens-relay/ws2/lens-editor && npx vitest run`

Expected: All ~447 unit tests pass. Integration tests may fail (expected — need running server).

### Step 7: Visual verification in browser

1. Navigate to `http://dev.vps:5273/` (dev server should already be running on port 5273)
2. Open a document containing `[[Notes/Ideas]]` — should render as resolved (clickable widget)
3. Open a document containing `[[Welcome]]` — should render as resolved from any folder
4. Verify existing `[[Page]]` links still work
5. Verify `![[Page]]` embed links still work (from earlier fix)

---

## Summary of Changes

| What changes | Current behavior | New behavior |
|---|---|---|
| `[[filename]]` with `currentFolder` | Scoped to folder | Global search |
| `[[path/file]]` with `currentFolder` | Scoped to folder | Scoped to folder (same) |
| `[[filename]]` without `currentFolder` | Global | Global (same) |
| `[[path/file]]` without `currentFolder` | Global | Global (same) |

Only one behavioral change: basename-only links ignore `currentFolder` scoping.
