# Multi-Folder Support

## Overview

Display documents from multiple Relay shared folders in a unified file tree.

## Folders

| Name | Folder ID | Y.Doc ID |
|------|-----------|----------|
| Lens | `fbd5eb54-73cc-41b0-ac28-2b93d3b4244e` | `{RELAY_ID}-fbd5eb54-...` |
| Lens Edu | `ea4015da-24af-4d9d-ac49-8c902cb17121` | `{RELAY_ID}-ea4015da-...` |

## Approach

### View Transform (Not Data Modification)

Each folder's Y.Doc stores paths without folder prefixes:
```
Lens Y.Doc:      { "/doc.md": {...}, "/notes/meeting.md": {...} }
Lens Edu Y.Doc:  { "/syllabus.md": {...} }
```

For display, we prefix paths with folder names:
```
Merged view: {
  "/Lens/doc.md": {...},
  "/Lens/notes/meeting.md": {...},
  "/Lens Edu/syllabus.md": {...}
}
```

`buildTreeFromPaths()` then creates top-level folder nodes automatically.

### CRUD Routing

When writing (create/rename/delete), strip the prefix and route to the correct Y.Doc:
- Path `/Lens Edu/syllabus.md` → `lensEduDoc.renameDocument("/syllabus.md", ...)`

### Obsidian Compatibility: Dual-Map Updates

**Critical**: Obsidian requires document entries in BOTH `filemeta_v0` AND the legacy `docs` Y.Map. If an entry exists only in `filemeta_v0`, Obsidian treats it as orphaned and deletes it.

All CRUD operations must update both maps atomically:

```typescript
folderDoc.transact(() => {
  filemeta.set(path, { id, type: 'markdown', version: 0 });
  legacyDocs.set(path, id);  // Required for Obsidian compatibility!
}, origin);
```

Consider a helper function `writeDocumentMetadata(doc, path, meta)` to ensure this.

## Edge Cases

### Folder Name Collisions

If a document path inside one folder matches another folder's display name:
- Lens Y.Doc has `/Lens Edu/doc.md` (a subfolder named "Lens Edu")
- Merged: `/Lens/Lens Edu/doc.md` vs `/Lens Edu/...`

These are distinct paths, but could be confusing. The path parsing must be exact:
- `/Lens-Archive/doc.md` → folder name is `Lens-Archive`, not `Lens`
- `/Lens/doc.md` → folder name is `Lens`

### Special Characters in Folder Names

Folder names may contain spaces (e.g., "Lens Edu"). Test for:
- Spaces in folder names
- Unicode characters
- Path parsing edge cases

### Empty Folders

A folder with no documents should still appear in the tree as an empty top-level folder.

## Error Handling

### Partial Sync Failure

If one folder connects but another fails:
- **Show available folders** - Don't block the entire UI
- **Indicate failed folders** - Show error state for the failed folder
- **Retry logic** - Attempt reconnection with exponential backoff

### Connection Drop Mid-Session

If a Y.Doc connection drops after initial sync:
- Show folder-specific error indicator
- Preserve last-known metadata (read-only)
- Attempt automatic reconnection

## Components

### New: `useMultiFolderMetadata(folders[])`

- Connects to multiple folder Y.Docs simultaneously
- Merges metadata with folder name prefixes
- Returns `{ metadata, folderDocs: Map<folderId, Y.Doc>, errors: Map<folderId, Error> }`
- Handles partial sync (some folders succeed, others fail)

### New: `src/lib/multi-folder-utils.ts`

Pure functions for path transformation:
- `mergeMetadata(folders[])` - Combine metadata with prefixes
- `getFolderNameFromPath(path, folderNames[])` - Extract folder name from prefixed path
- `getOriginalPath(path, folderName)` - Strip folder prefix

### Updated: `NavigationContext`

- Change `doc: Y.Doc` to `folderDocs: Map<string, Y.Doc>`
- Add helper: `getFolderDocForPath(path) → Y.Doc`

### Updated: `Sidebar`

- Route CRUD operations through path → Y.Doc lookup

## New Document Behavior

Create in the **same folder as the currently active document**:
1. Parse active document's path to determine its folder
2. Create new document in that folder
3. Fall back to first folder only if no document is active

## Files Changed

| File | Change | Estimate |
|------|--------|----------|
| `src/lib/multi-folder-utils.ts` | New - pure functions | ~50 lines |
| `src/lib/multi-folder-utils.test.ts` | New - tests | ~80 lines |
| `src/hooks/useMultiFolderMetadata.ts` | New - hook | ~150 lines |
| `src/hooks/useMultiFolderMetadata.test.tsx` | New - tests | ~120 lines |
| `src/contexts/NavigationContext.tsx` | Small update | ~20 lines |
| `src/App.tsx` | Use new hook, define folder config | ~20 lines |
| `src/components/Sidebar/Sidebar.tsx` | CRUD routing | ~50 lines |

**Total estimate**: ~200 lines production code, ~200 lines tests

## Testing Strategy

### Test Infrastructure

Local Y-Sweet has two test folders (set up via `npm run local:setup`):

| Folder | ID | Documents |
|--------|-----|-----------|
| Lens | `test-folder` | Welcome.md, Getting Started.md, Notes/Ideas.md |
| Lens Edu | `test-folder-edu` | Course Notes.md, Syllabus.md, Resources/Links.md |

### Test Levels (Unit+1 Style)

Following TDD, tests are written before implementation. We use real dependencies where practical, mocking only at slow/external boundaries.

#### 1. Pure Function Tests (No Mocking)

Test the core transformation logic in isolation:

```typescript
// src/lib/multi-folder-utils.test.ts

test('mergeMetadata combines folders with name prefixes', () => {
  const result = mergeMetadata([
    { name: 'Lens', metadata: { '/doc.md': { id: 'uuid1', type: 'markdown' } } },
    { name: 'Lens Edu', metadata: { '/syllabus.md': { id: 'uuid2', type: 'markdown' } } }
  ]);

  expect(result['/Lens/doc.md']).toEqual({ id: 'uuid1', type: 'markdown' });
  expect(result['/Lens Edu/syllabus.md']).toEqual({ id: 'uuid2', type: 'markdown' });
});

test('handles empty folder', () => {
  const result = mergeMetadata([
    { name: 'Lens', metadata: {} },
    { name: 'Lens Edu', metadata: { '/doc.md': { id: 'uuid1', type: 'markdown' } } }
  ]);

  expect(Object.keys(result)).toHaveLength(1);
  expect(result['/Lens Edu/doc.md']).toBeDefined();
});

test('getFolderNameFromPath extracts folder name', () => {
  const folderNames = ['Lens', 'Lens Edu', 'Lens-Archive'];

  expect(getFolderNameFromPath('/Lens Edu/notes.md', folderNames)).toBe('Lens Edu');
  expect(getFolderNameFromPath('/Lens/deep/nested/doc.md', folderNames)).toBe('Lens');
});

test('distinguishes similar folder name prefixes', () => {
  const folderNames = ['Lens', 'Lens-Archive'];

  // Must not confuse "Lens" with "Lens-Archive"
  expect(getFolderNameFromPath('/Lens-Archive/doc.md', folderNames)).toBe('Lens-Archive');
  expect(getFolderNameFromPath('/Lens/doc.md', folderNames)).toBe('Lens');
});

test('handles folder names with spaces', () => {
  const folderNames = ['Lens Edu'];
  expect(getFolderNameFromPath('/Lens Edu/notes.md', folderNames)).toBe('Lens Edu');
});

test('getOriginalPath strips folder prefix', () => {
  expect(getOriginalPath('/Lens Edu/notes.md', 'Lens Edu')).toBe('/notes.md');
  expect(getOriginalPath('/Lens/sub/doc.md', 'Lens')).toBe('/sub/doc.md');
});

test('getOriginalPath handles root-level files', () => {
  expect(getOriginalPath('/Lens/file.md', 'Lens')).toBe('/file.md');
});
```

#### 2. Integration Test: Both Folders in DOM (happy-dom + real Y-Sweet)

The key acceptance test - verifies both folders appear in the sidebar using **real hook connections**, not manually constructed context values:

```typescript
// src/components/Sidebar/Sidebar.integration.test.tsx
// @vitest-environment happy-dom

import { TEST_FOLDERS } from '../../../scripts/setup-local-ysweet.mjs';

const testFolderConfig = TEST_FOLDERS.map(f => ({ id: f.id, name: f.name }));

/**
 * Test wrapper that uses real useMultiFolderMetadata hook.
 * This ensures we're testing real behavior, not mock behavior.
 */
function TestApp({ onSelectDocument }: { onSelectDocument: (id: string) => void }) {
  const { metadata, folderDocs } = useMultiFolderMetadata(testFolderConfig);

  return (
    <NavigationContext.Provider value={{ metadata, folderDocs, onNavigate: onSelectDocument }}>
      <Sidebar activeDocId="local-welcome" onSelectDocument={onSelectDocument} />
    </NavigationContext.Provider>
  );
}

test('shows both folders in the file tree', async () => {
  const handleSelect = vi.fn();

  // Render with REAL hook connecting to REAL Y-Sweet
  const { container } = render(<TestApp onSelectDocument={handleSelect} />);

  // Wait for real network sync (longer timeout)
  await waitFor(() => {
    expect(container.textContent).toContain('Lens');
    expect(container.textContent).toContain('Lens Edu');
  }, { timeout: 10000 });

  // Verify documents from both folders appear
  expect(container.textContent).toContain('Welcome');
  expect(container.textContent).toContain('Course Notes');
});

test('handles partial sync failure gracefully', async () => {
  // TODO: Test with one folder unavailable
  // Should show available folder, indicate error for failed folder
});
```

#### 3. Hook Test: `useMultiFolderMetadata` (Mock YSweetProvider)

Tests hook lifecycle with mocked network layer (same pattern as existing `useFolderMetadata.test.tsx`):

```typescript
// src/hooks/useMultiFolderMetadata.test.tsx

test('connects to multiple folder docs', async () => {
  const { result } = renderHook(() => useMultiFolderMetadata([
    { id: 'folder-1', name: 'Lens' },
    { id: 'folder-2', name: 'Lens Edu' }
  ]));

  await waitFor(() => {
    expect(mockProviderInstances.length).toBe(2);
  });
});

test('merges metadata from both folders with prefixes', async () => {
  const { result } = renderHook(() => useMultiFolderMetadata([
    { id: 'folder-1', name: 'Lens' },
    { id: 'folder-2', name: 'Lens Edu' }
  ]));

  await waitFor(() => expect(mockProviderInstances.length).toBe(2));

  // Populate both mock providers with data
  act(() => {
    mockProviderInstances[0].doc.getMap('filemeta_v0').set('/doc.md', { id: 'uuid1', type: 'markdown' });
    mockProviderInstances[1].doc.getMap('filemeta_v0').set('/syllabus.md', { id: 'uuid2', type: 'markdown' });
    mockProviderInstances.forEach(p => p.emitSynced());
  });

  await waitFor(() => {
    expect(result.current.metadata['/Lens/doc.md']).toBeDefined();
    expect(result.current.metadata['/Lens Edu/syllabus.md']).toBeDefined();
  });
});

test('returns folderDocs map for CRUD routing', async () => {
  const { result } = renderHook(() => useMultiFolderMetadata([
    { id: 'folder-1', name: 'Lens' },
    { id: 'folder-2', name: 'Lens Edu' }
  ]));

  await waitFor(() => {
    expect(result.current.folderDocs.get('folder-1')).toBeInstanceOf(Y.Doc);
    expect(result.current.folderDocs.get('folder-2')).toBeInstanceOf(Y.Doc);
  });
});

test('cleans up all providers on unmount', async () => {
  const { unmount } = renderHook(() => useMultiFolderMetadata([
    { id: 'folder-1', name: 'Lens' },
    { id: 'folder-2', name: 'Lens Edu' }
  ]));

  await waitFor(() => expect(mockProviderInstances.length).toBe(2));

  unmount();

  expect(mockProviderInstances[0].doc.isDestroyed).toBe(true);
  expect(mockProviderInstances[1].doc.isDestroyed).toBe(true);
});
```

#### 4. CRUD Routing Tests

Test that operations route to the correct Y.Doc and update both maps:

```typescript
// src/lib/multi-folder-utils.test.ts

test('creates document in correct folder and updates both maps', async () => {
  const lensDoc = new Y.Doc();
  const lensEduDoc = new Y.Doc();
  const folderDocs = new Map([
    ['Lens', lensDoc],
    ['Lens Edu', lensEduDoc]
  ]);

  await createDocumentInFolder('/Lens Edu/new.md', 'new-uuid', folderDocs);

  // Verify Lens Edu doc was modified with stripped path
  const filemeta = lensEduDoc.getMap('filemeta_v0');
  const legacyDocs = lensEduDoc.getMap('docs');

  expect(filemeta.get('/new.md')).toEqual({
    id: 'new-uuid',
    type: 'markdown',
    version: 0
  });
  expect(legacyDocs.get('/new.md')).toBe('new-uuid');

  // Verify Lens doc was NOT modified
  expect(lensDoc.getMap('filemeta_v0').size).toBe(0);
});

test('rename routes to correct folder doc and updates both maps', async () => {
  const lensEduDoc = new Y.Doc();
  const folderDocs = new Map([['Lens Edu', lensEduDoc]]);

  // Setup existing doc
  lensEduDoc.transact(() => {
    lensEduDoc.getMap('filemeta_v0').set('/old.md', { id: 'uuid', type: 'markdown', version: 0 });
    lensEduDoc.getMap('docs').set('/old.md', 'uuid');
  });

  renameDocumentInFolder('/Lens Edu/old.md', '/Lens Edu/new.md', folderDocs);

  const filemeta = lensEduDoc.getMap('filemeta_v0');
  const legacyDocs = lensEduDoc.getMap('docs');

  // Old path removed from both maps
  expect(filemeta.has('/old.md')).toBe(false);
  expect(legacyDocs.has('/old.md')).toBe(false);

  // New path exists in both maps
  expect(filemeta.get('/new.md')).toBeDefined();
  expect(legacyDocs.get('/new.md')).toBe('uuid');
});

test('delete removes from both maps', async () => {
  const lensDoc = new Y.Doc();
  const folderDocs = new Map([['Lens', lensDoc]]);

  // Setup existing doc
  lensDoc.transact(() => {
    lensDoc.getMap('filemeta_v0').set('/doc.md', { id: 'uuid', type: 'markdown', version: 0 });
    lensDoc.getMap('docs').set('/doc.md', 'uuid');
  });

  deleteDocumentInFolder('/Lens/doc.md', folderDocs);

  expect(lensDoc.getMap('filemeta_v0').has('/doc.md')).toBe(false);
  expect(lensDoc.getMap('docs').has('/doc.md')).toBe(false);
});
```

### TDD Order of Implementation

1. **RED**: Write `Sidebar.integration.test.tsx` expecting both folders - will fail
2. **RED**: Write pure function tests for `mergeMetadata`, `getFolderNameFromPath`, `getOriginalPath` - will fail
3. **GREEN**: Implement pure functions in `src/lib/multi-folder-utils.ts`
4. **RED**: Write `useMultiFolderMetadata.test.tsx` - will fail
5. **GREEN**: Implement `useMultiFolderMetadata` hook
6. **GREEN**: Wire up in App.tsx, NavigationContext, Sidebar - integration test passes
7. **REFACTOR**: Clean up

### Running Tests

```bash
# Unit tests (fast, no server needed)
npm run test:run

# Integration tests (requires local Y-Sweet)
npx y-sweet serve --port 8090  # Terminal 1
npm run test:integration       # Terminal 2
```
