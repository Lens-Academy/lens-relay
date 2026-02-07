# Multi-Folder Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Display documents from multiple Relay shared folders (Lens and Lens Edu) in a unified file tree.

**Architecture:** View transform approach - prefix paths with folder names for display only, strip prefixes when routing CRUD operations to the correct Y.Doc. Each folder maintains its own Y.Doc connection.

**Tech Stack:** React, Y.js, YSweetProvider, Vitest, happy-dom

**Reference:** See `docs/architecture/multi-folder-support.md` for full architecture details.

---

## Task 1: Pure Function Tests - `mergeMetadata`

**Files:**
- Create: `src/lib/multi-folder-utils.test.ts`

**Step 1: Write the failing test for mergeMetadata**

```typescript
// src/lib/multi-folder-utils.test.ts
import { describe, it, expect } from 'vitest';
import { mergeMetadata } from './multi-folder-utils';
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
```

**Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/multi-folder-utils.test.ts --run`
Expected: FAIL with "Cannot find module './multi-folder-utils'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/multi-folder-utils.ts
import type { FileMetadata, FolderMetadata } from '../hooks/useFolderMetadata';

export interface FolderInput {
  name: string;
  metadata: FolderMetadata;
}

/**
 * Merge metadata from multiple folders, prefixing paths with folder names.
 * Example: { "/doc.md": {...} } from "Lens" becomes { "/Lens/doc.md": {...} }
 */
export function mergeMetadata(folders: FolderInput[]): FolderMetadata {
  const merged: FolderMetadata = {};

  for (const folder of folders) {
    for (const [path, meta] of Object.entries(folder.metadata)) {
      const prefixedPath = `/${folder.name}${path}`;
      merged[prefixedPath] = meta;
    }
  }

  return merged;
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/multi-folder-utils.test.ts --run`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add src/lib/multi-folder-utils.ts src/lib/multi-folder-utils.test.ts
git commit -m "feat(multi-folder): add mergeMetadata pure function with tests"
```

---

## Task 2: Pure Function Tests - `getFolderNameFromPath`

**Files:**
- Modify: `src/lib/multi-folder-utils.test.ts`
- Modify: `src/lib/multi-folder-utils.ts`

**Step 1: Write the failing test**

Add to `src/lib/multi-folder-utils.test.ts`:

```typescript
import { mergeMetadata, getFolderNameFromPath } from './multi-folder-utils';

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
```

**Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/multi-folder-utils.test.ts --run`
Expected: FAIL with "getFolderNameFromPath is not exported"

**Step 3: Write minimal implementation**

Add to `src/lib/multi-folder-utils.ts`:

```typescript
/**
 * Extract folder name from a prefixed path.
 * Uses exact matching with trailing slash to avoid prefix confusion.
 * Example: "/Lens Edu/notes.md" with folders ["Lens", "Lens Edu"] returns "Lens Edu"
 */
export function getFolderNameFromPath(path: string, folderNames: string[]): string | null {
  // Sort by length descending to match longer names first
  // This ensures "Lens Edu" matches before "Lens"
  const sorted = [...folderNames].sort((a, b) => b.length - a.length);

  for (const name of sorted) {
    const prefix = `/${name}/`;
    if (path.startsWith(prefix)) {
      return name;
    }
  }

  return null;
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/multi-folder-utils.test.ts --run`
Expected: PASS (7 tests)

**Step 5: Commit**

```bash
git add src/lib/multi-folder-utils.ts src/lib/multi-folder-utils.test.ts
git commit -m "feat(multi-folder): add getFolderNameFromPath with prefix disambiguation"
```

---

## Task 3: Pure Function Tests - `getOriginalPath`

**Files:**
- Modify: `src/lib/multi-folder-utils.test.ts`
- Modify: `src/lib/multi-folder-utils.ts`

**Step 1: Write the failing test**

Add to `src/lib/multi-folder-utils.test.ts`:

```typescript
import { mergeMetadata, getFolderNameFromPath, getOriginalPath } from './multi-folder-utils';

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
```

**Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/multi-folder-utils.test.ts --run`
Expected: FAIL with "getOriginalPath is not exported"

**Step 3: Write minimal implementation**

Add to `src/lib/multi-folder-utils.ts`:

```typescript
/**
 * Strip the folder prefix from a path to get the original Y.Doc path.
 * Example: "/Lens Edu/notes.md" with folder "Lens Edu" returns "/notes.md"
 */
export function getOriginalPath(prefixedPath: string, folderName: string): string {
  const prefix = `/${folderName}`;
  if (prefixedPath.startsWith(prefix)) {
    return prefixedPath.slice(prefix.length);
  }
  return prefixedPath;
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/multi-folder-utils.test.ts --run`
Expected: PASS (10 tests)

**Step 5: Commit**

```bash
git add src/lib/multi-folder-utils.ts src/lib/multi-folder-utils.test.ts
git commit -m "feat(multi-folder): add getOriginalPath to strip folder prefix"
```

---

## Task 4: Hook Tests Setup - Mock Infrastructure

**Files:**
- Create: `src/hooks/useMultiFolderMetadata.test.tsx`

**Step 1: Write the test file with mock setup**

```typescript
// src/hooks/useMultiFolderMetadata.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import * as Y from 'yjs';
import type { FileMetadata } from './useFolderMetadata';

// Use vi.hoisted to define mock class before vi.mock hoisting
const { MockYSweetProvider, mockProviderInstances, resetMockProviders } = vi.hoisted(() => {
  const instances: Array<{
    listeners: Map<string, Set<(...args: unknown[]) => void>>;
    synced: boolean;
    doc: Y.Doc;
    folderId: string;
    emitSynced: () => void;
    destroy: () => void;
    on: (event: string, handler: (...args: unknown[]) => void) => void;
    off: (event: string, handler: (...args: unknown[]) => void) => void;
  }> = [];

  class MockYSweetProviderClass {
    private listeners: Map<string, Set<(...args: unknown[]) => void>> = new Map();
    public synced = false;
    public doc: Y.Doc;
    public folderId: string;

    constructor(
      _authEndpoint: unknown,
      docId: string,
      doc: Y.Doc,
      _options?: unknown
    ) {
      this.doc = doc;
      // Extract folder ID from docId (format: "local-{folderId}" or "{relayId}-{folderId}")
      this.folderId = docId.split('-').slice(1).join('-');
      instances.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => void) {
      if (!this.listeners.has(event)) {
        this.listeners.set(event, new Set());
      }
      this.listeners.get(event)!.add(handler);
    }

    off(event: string, handler: (...args: unknown[]) => void) {
      this.listeners.get(event)?.delete(handler);
    }

    emitSynced() {
      this.synced = true;
      this.listeners.get('synced')?.forEach((h) => h());
    }

    destroy() {
      this.listeners.clear();
    }
  }

  return {
    MockYSweetProvider: MockYSweetProviderClass,
    mockProviderInstances: instances,
    resetMockProviders: () => {
      instances.length = 0;
    },
  };
});

// Mock the auth module
vi.mock('../lib/auth', () => ({
  getClientToken: vi.fn().mockResolvedValue({
    url: 'ws://mock-relay/doc/test-doc',
    baseUrl: 'http://mock-relay',
    docId: 'test-doc',
    token: 'mock-token',
    authorization: 'full',
  }),
}));

// Mock @y-sweet/client
vi.mock('@y-sweet/client', () => ({
  YSweetProvider: MockYSweetProvider,
}));

// Import the hook AFTER mocks are set up
import { useMultiFolderMetadata } from './useMultiFolderMetadata';

describe('useMultiFolderMetadata', () => {
  beforeEach(() => {
    resetMockProviders();
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockProviderInstances.forEach((p) => {
      if (p.doc && !p.doc.isDestroyed) {
        p.doc.destroy();
      }
    });
  });

  it('connects to multiple folder docs', async () => {
    const { result } = renderHook(() => useMultiFolderMetadata([
      { id: 'folder-1', name: 'Lens' },
      { id: 'folder-2', name: 'Lens Edu' }
    ]));

    await waitFor(() => {
      expect(mockProviderInstances.length).toBe(2);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- src/hooks/useMultiFolderMetadata.test.tsx --run`
Expected: FAIL with "Cannot find module './useMultiFolderMetadata'"

**Step 3: Write minimal hook stub**

```typescript
// src/hooks/useMultiFolderMetadata.ts
import { useState, useEffect, useRef, useMemo } from 'react';
import * as Y from 'yjs';
import { YSweetProvider } from '@y-sweet/client';
import { getClientToken } from '../lib/auth';
import type { FolderMetadata } from './useFolderMetadata';

const USE_LOCAL_YSWEET = import.meta.env?.VITE_LOCAL_YSWEET === 'true';
const RELAY_ID = USE_LOCAL_YSWEET ? 'local' : 'cb696037-0f72-4e93-8717-4e433129d789';

export interface FolderConfig {
  id: string;
  name: string;
}

interface FolderConnection {
  doc: Y.Doc;
  provider: YSweetProvider;
  name: string;
}

export interface UseMultiFolderMetadataReturn {
  metadata: FolderMetadata;
  folderDocs: Map<string, Y.Doc>;
  loading: boolean;
  errors: Map<string, Error>;
}

export function useMultiFolderMetadata(folders: FolderConfig[]): UseMultiFolderMetadataReturn {
  const [metadata, setMetadata] = useState<FolderMetadata>({});
  const [folderDocs, setFolderDocs] = useState<Map<string, Y.Doc>>(new Map());
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<Map<string, Error>>(new Map());

  const connectionsRef = useRef<Map<string, FolderConnection>>(new Map());

  // Stable key for folders to avoid infinite loop
  const foldersKey = useMemo(
    () => folders.map(f => `${f.id}:${f.name}`).join('|'),
    [folders]
  );

  useEffect(() => {
    const connections = new Map<string, FolderConnection>();
    const docsMap = new Map<string, Y.Doc>();

    for (const folder of folders) {
      const folderDocId = `${RELAY_ID}-${folder.id}`;
      const doc = new Y.Doc();

      const authEndpoint = () => getClientToken(folderDocId);
      const provider = new YSweetProvider(authEndpoint, folderDocId, doc, {
        connect: true,
      });

      connections.set(folder.name, { doc, provider, name: folder.name });
      // KEY: Use folder NAME as key
      docsMap.set(folder.name, doc);
    }

    connectionsRef.current = connections;
    setFolderDocs(docsMap);

    return () => {
      connections.forEach((conn) => {
        conn.provider.destroy();
        conn.doc.destroy();
      });
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foldersKey]);

  return { metadata, folderDocs, loading, errors };
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- src/hooks/useMultiFolderMetadata.test.tsx --run`
Expected: PASS (1 test)

**Step 5: Commit**

```bash
git add src/hooks/useMultiFolderMetadata.ts src/hooks/useMultiFolderMetadata.test.tsx
git commit -m "feat(multi-folder): add useMultiFolderMetadata hook stub with tests"
```

---

## Task 5: Hook Tests - Metadata Merging

**Files:**
- Modify: `src/hooks/useMultiFolderMetadata.test.tsx`
- Modify: `src/hooks/useMultiFolderMetadata.ts`

**Step 1: Write the failing test**

Add to `src/hooks/useMultiFolderMetadata.test.tsx`:

```typescript
it('merges metadata from both folders with prefixes', async () => {
  const { result } = renderHook(() => useMultiFolderMetadata([
    { id: 'folder-1', name: 'Lens' },
    { id: 'folder-2', name: 'Lens Edu' }
  ]));

  await waitFor(() => expect(mockProviderInstances.length).toBe(2));

  // Populate both mock providers with data
  act(() => {
    mockProviderInstances[0].doc.getMap<FileMetadata>('filemeta_v0').set('/doc.md', { id: 'uuid1', type: 'markdown', version: 0 });
    mockProviderInstances[1].doc.getMap<FileMetadata>('filemeta_v0').set('/syllabus.md', { id: 'uuid2', type: 'markdown', version: 0 });
    mockProviderInstances.forEach(p => p.emitSynced());
  });

  await waitFor(() => {
    expect(result.current.metadata['/Lens/doc.md']).toBeDefined();
    expect(result.current.metadata['/Lens Edu/syllabus.md']).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- src/hooks/useMultiFolderMetadata.test.tsx --run`
Expected: FAIL - metadata object is empty

**Step 3: Implement metadata syncing and merging**

Update `src/hooks/useMultiFolderMetadata.ts`:

```typescript
// src/hooks/useMultiFolderMetadata.ts
import { useState, useEffect, useRef, useMemo } from 'react';
import * as Y from 'yjs';
import { YSweetProvider } from '@y-sweet/client';
import { getClientToken } from '../lib/auth';
import type { FileMetadata, FolderMetadata } from './useFolderMetadata';
import { mergeMetadata, type FolderInput } from '../lib/multi-folder-utils';

const USE_LOCAL_YSWEET = import.meta.env?.VITE_LOCAL_YSWEET === 'true';
const RELAY_ID = USE_LOCAL_YSWEET ? 'local' : 'cb696037-0f72-4e93-8717-4e433129d789';

export interface FolderConfig {
  id: string;
  name: string;
}

interface FolderConnection {
  doc: Y.Doc;
  provider: YSweetProvider;
  name: string;
}

export interface UseMultiFolderMetadataReturn {
  metadata: FolderMetadata;
  /** Map from folder NAME to Y.Doc (for CRUD routing by folder name) */
  folderDocs: Map<string, Y.Doc>;
  loading: boolean;
  /** Map from folder NAME to Error (for partial sync failure display) */
  errors: Map<string, Error>;
}

export function useMultiFolderMetadata(folders: FolderConfig[]): UseMultiFolderMetadataReturn {
  const [metadata, setMetadata] = useState<FolderMetadata>({});
  // KEY FIX: Map keyed by folder NAME (not ID) for easier CRUD routing
  const [folderDocs, setFolderDocs] = useState<Map<string, Y.Doc>>(new Map());
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<Map<string, Error>>(new Map());

  const connectionsRef = useRef<Map<string, FolderConnection>>(new Map());
  const folderMetadataRef = useRef<Map<string, FolderMetadata>>(new Map());

  // Stable key for folders to avoid infinite loop
  // Only reconnect if folder IDs actually change
  const foldersKey = useMemo(
    () => folders.map(f => `${f.id}:${f.name}`).join('|'),
    [folders]
  );

  useEffect(() => {
    const connections = new Map<string, FolderConnection>();
    const docsMap = new Map<string, Y.Doc>();
    folderMetadataRef.current = new Map();
    let syncedCount = 0;

    // Recompute merged metadata from all folders
    const updateMergedMetadata = () => {
      const folderInputs: FolderInput[] = [];
      for (const folder of folders) {
        const meta = folderMetadataRef.current.get(folder.name) ?? {};
        folderInputs.push({ name: folder.name, metadata: meta });
      }
      const merged = mergeMetadata(folderInputs);
      setMetadata(merged);
    };

    for (const folder of folders) {
      const folderDocId = `${RELAY_ID}-${folder.id}`;
      const doc = new Y.Doc();

      const authEndpoint = () => getClientToken(folderDocId);
      const provider = new YSweetProvider(authEndpoint, folderDocId, doc, {
        connect: true,
      });

      // Get the filemeta_v0 Map for this folder
      const filemeta = doc.getMap<FileMetadata>('filemeta_v0');

      // Function to extract metadata from Y.Map
      const extractMetadata = (): FolderMetadata => {
        const entries: FolderMetadata = {};
        filemeta.forEach((value, key) => {
          entries[key] = value;
        });
        return entries;
      };

      // Update when synced
      provider.on('synced', () => {
        folderMetadataRef.current.set(folder.name, extractMetadata());
        updateMergedMetadata();
        syncedCount++;
        // Only set loading=false when ALL folders have synced
        if (syncedCount >= folders.length) {
          setLoading(false);
        }
      });

      // Handle connection errors for partial failure support
      provider.on('connection-error', (err: Error) => {
        setErrors(prev => new Map(prev).set(folder.name, err));
        syncedCount++;
        if (syncedCount >= folders.length) {
          setLoading(false);
        }
      });

      // Subscribe to changes
      filemeta.observe(() => {
        folderMetadataRef.current.set(folder.name, extractMetadata());
        updateMergedMetadata();
      });

      // Handle data already present
      if (filemeta.size > 0) {
        folderMetadataRef.current.set(folder.name, extractMetadata());
        updateMergedMetadata();
      }

      connections.set(folder.name, { doc, provider, name: folder.name });
      // KEY FIX: Use folder NAME as key for docsMap
      docsMap.set(folder.name, doc);
    }

    connectionsRef.current = connections;
    setFolderDocs(docsMap);

    return () => {
      connections.forEach((conn) => {
        conn.provider.destroy();
        conn.doc.destroy();
      });
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foldersKey]);  // Use stable key instead of folders array

  return { metadata, folderDocs, loading, errors };
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- src/hooks/useMultiFolderMetadata.test.tsx --run`
Expected: PASS (2 tests)

**Step 5: Commit**

```bash
git add src/hooks/useMultiFolderMetadata.ts src/hooks/useMultiFolderMetadata.test.tsx
git commit -m "feat(multi-folder): implement metadata syncing and merging in hook"
```

---

## Task 6: Hook Tests - Folder Docs Map

**Files:**
- Modify: `src/hooks/useMultiFolderMetadata.test.tsx`

**Step 1: Write the failing test**

Add to `src/hooks/useMultiFolderMetadata.test.tsx`:

```typescript
it('returns folderDocs map keyed by folder NAME for CRUD routing', async () => {
  const { result } = renderHook(() => useMultiFolderMetadata([
    { id: 'folder-1', name: 'Lens' },
    { id: 'folder-2', name: 'Lens Edu' }
  ]));

  await waitFor(() => {
    // KEY: Map is keyed by folder NAME, not folder ID
    expect(result.current.folderDocs.get('Lens')).toBeInstanceOf(Y.Doc);
    expect(result.current.folderDocs.get('Lens Edu')).toBeInstanceOf(Y.Doc);
  });
});
```

**Step 2: Run test to verify it passes**

Run: `npm test -- src/hooks/useMultiFolderMetadata.test.tsx --run`
Expected: PASS (3 tests) - this should already work from Task 5

**Step 3: Commit**

```bash
git add src/hooks/useMultiFolderMetadata.test.tsx
git commit -m "test(multi-folder): add folderDocs map test"
```

---

## Task 7: Hook Tests - Cleanup on Unmount

**Files:**
- Modify: `src/hooks/useMultiFolderMetadata.test.tsx`

**Step 1: Write the test**

Add to `src/hooks/useMultiFolderMetadata.test.tsx`:

```typescript
it('cleans up all providers on unmount', async () => {
  const { unmount } = renderHook(() => useMultiFolderMetadata([
    { id: 'folder-1', name: 'Lens' },
    { id: 'folder-2', name: 'Lens Edu' }
  ]));

  await waitFor(() => expect(mockProviderInstances.length).toBe(2));

  const destroySpies = mockProviderInstances.map(p => vi.spyOn(p, 'destroy'));

  unmount();

  destroySpies.forEach(spy => {
    expect(spy).toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it passes**

Run: `npm test -- src/hooks/useMultiFolderMetadata.test.tsx --run`
Expected: PASS (4 tests) - cleanup should already work from Task 5

**Step 3: Commit**

```bash
git add src/hooks/useMultiFolderMetadata.test.tsx
git commit -m "test(multi-folder): add cleanup verification test"
```

---

## Task 7.5: Hook Tests - Partial Sync Failure

**Files:**
- Modify: `src/hooks/useMultiFolderMetadata.test.tsx`

**Step 1: Write the test for partial sync failure**

Add to `src/hooks/useMultiFolderMetadata.test.tsx`:

```typescript
it('handles partial sync failure - shows working folder, reports error', async () => {
  const { result } = renderHook(() => useMultiFolderMetadata([
    { id: 'folder-1', name: 'Lens' },
    { id: 'folder-2', name: 'Lens Edu' }
  ]));

  await waitFor(() => expect(mockProviderInstances.length).toBe(2));

  // First folder syncs successfully with data
  act(() => {
    mockProviderInstances[0].doc.getMap('filemeta_v0').set('/doc.md', { id: 'uuid1', type: 'markdown', version: 0 });
    mockProviderInstances[0].emitSynced();
  });

  // Second folder fails to connect
  act(() => {
    const errorEvent = mockProviderInstances[1].listeners.get('connection-error');
    errorEvent?.forEach(handler => handler(new Error('Connection refused')));
  });

  await waitFor(() => {
    // Loading should complete (both folders finished, one way or another)
    expect(result.current.loading).toBe(false);
  });

  // Should have metadata from successful folder
  expect(result.current.metadata['/Lens/doc.md']).toBeDefined();

  // Should have error for failed folder
  expect(result.current.errors.get('Lens Edu')).toBeInstanceOf(Error);
  expect(result.current.errors.get('Lens Edu')?.message).toBe('Connection refused');

  // Should NOT have error for successful folder
  expect(result.current.errors.get('Lens')).toBeUndefined();
});
```

**Step 2: Run test to verify it passes**

Run: `npm test -- src/hooks/useMultiFolderMetadata.test.tsx --run`
Expected: PASS (5 tests) - partial failure handling should work from Task 5

**Step 3: Commit**

```bash
git add src/hooks/useMultiFolderMetadata.test.tsx
git commit -m "test(multi-folder): add partial sync failure test"
```

---

## Task 8: Update NavigationContext Types

**Files:**
- Modify: `src/contexts/NavigationContext.tsx`

**Step 1: Update the context to support multiple folder docs**

```typescript
// src/contexts/NavigationContext.tsx
import { createContext, useContext } from 'react';
import type { FolderMetadata } from '../hooks/useFolderMetadata';
import type * as Y from 'yjs';

interface NavigationContextValue {
  metadata: FolderMetadata;
  /** Map from folder NAME to Y.Doc */
  folderDocs: Map<string, Y.Doc>;
  folderNames: string[];
  /** Map from folder NAME to Error (for partial sync failures) */
  errors: Map<string, Error>;
  onNavigate: (docId: string) => void;
}

export const NavigationContext = createContext<NavigationContextValue | null>(null);

export function useNavigation() {
  const ctx = useContext(NavigationContext);
  if (!ctx) throw new Error('useNavigation must be used within NavigationProvider');
  return ctx;
}
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: Type errors in App.tsx and Sidebar.tsx (expected - we'll fix next)

**Step 3: Commit**

```bash
git add src/contexts/NavigationContext.tsx
git commit -m "feat(multi-folder): update NavigationContext for multiple folder docs"
```

---

## Task 9: Update App.tsx to Use Multi-Folder Hook

**Files:**
- Modify: `src/App.tsx`

**Step 1: Update App to use useMultiFolderMetadata**

```typescript
// src/App.tsx
import { useState } from 'react';
import { RelayProvider } from './providers/RelayProvider';
import { Sidebar } from './components/Sidebar';
import { EditorArea } from './components/Layout';
import { AwarenessInitializer } from './components/AwarenessInitializer/AwarenessInitializer';
import { DisconnectionModal } from './components/DisconnectionModal/DisconnectionModal';
import { NavigationContext } from './contexts/NavigationContext';
import { useMultiFolderMetadata, type FolderConfig } from './hooks/useMultiFolderMetadata';

// Local Y-Sweet uses test IDs, production uses real Relay IDs
const USE_LOCAL_YSWEET = import.meta.env.VITE_LOCAL_YSWEET === 'true';

// Relay server ID (from CLAUDE.md)
export const RELAY_ID = USE_LOCAL_YSWEET
  ? 'local'
  : 'cb696037-0f72-4e93-8717-4e433129d789';

// Folder configuration
const FOLDERS: FolderConfig[] = USE_LOCAL_YSWEET
  ? [
      { id: 'test-folder', name: 'Lens' },
      { id: 'test-folder-edu', name: 'Lens Edu' },
    ]
  : [
      { id: 'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e', name: 'Lens' },
      { id: 'ea4015da-24af-4d9d-ac49-8c902cb17121', name: 'Lens Edu' },
    ];

// Default document to show on load
const DOC_UUID = USE_LOCAL_YSWEET
  ? 'welcome'
  : '76c3e654-0e77-4538-962f-1b419647206e';
const DEFAULT_DOC_ID = `${RELAY_ID}-${DOC_UUID}`;

export function App() {
  const [activeDocId, setActiveDocId] = useState<string>(DEFAULT_DOC_ID);

  // Use multi-folder metadata hook
  const { metadata, folderDocs, errors } = useMultiFolderMetadata(FOLDERS);
  const folderNames = FOLDERS.map(f => f.name);

  return (
    <NavigationContext.Provider value={{ metadata, folderDocs, folderNames, errors, onNavigate: setActiveDocId }}>
      <div className="h-screen flex bg-gray-50">
        <Sidebar activeDocId={activeDocId} onSelectDocument={setActiveDocId} />

        <RelayProvider key={activeDocId} docId={activeDocId}>
          <AwarenessInitializer />
          <EditorArea />
          <DisconnectionModal />
        </RelayProvider>
      </div>
    </NavigationContext.Provider>
  );
}
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: Type errors in Sidebar.tsx (expected - we'll fix next)

**Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(multi-folder): wire up useMultiFolderMetadata in App"
```

---

## Task 10: Add CRUD Routing Helpers

**Files:**
- Modify: `src/lib/multi-folder-utils.ts`
- Modify: `src/lib/multi-folder-utils.test.ts`

**Step 1: Write the failing test**

Add to `src/lib/multi-folder-utils.test.ts`:

```typescript
import * as Y from 'yjs';
import {
  mergeMetadata,
  getFolderNameFromPath,
  getOriginalPath,
  getFolderDocForPath
} from './multi-folder-utils';

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
```

**Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/multi-folder-utils.test.ts --run`
Expected: FAIL with "getFolderDocForPath is not exported"

**Step 3: Write minimal implementation**

Add to `src/lib/multi-folder-utils.ts`:

```typescript
import * as Y from 'yjs';

/**
 * Get the Y.Doc for a given prefixed path by extracting the folder name.
 */
export function getFolderDocForPath(
  prefixedPath: string,
  folderDocs: Map<string, Y.Doc>,
  folderNames: string[]
): Y.Doc | null {
  const folderName = getFolderNameFromPath(prefixedPath, folderNames);
  if (!folderName) return null;
  return folderDocs.get(folderName) ?? null;
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/multi-folder-utils.test.ts --run`
Expected: PASS (all tests)

**Step 5: Commit**

```bash
git add src/lib/multi-folder-utils.ts src/lib/multi-folder-utils.test.ts
git commit -m "feat(multi-folder): add getFolderDocForPath for CRUD routing"
```

---

## Task 11: Update Sidebar CRUD Operations

**Files:**
- Modify: `src/components/Sidebar/Sidebar.tsx`

**Step 1: Update Sidebar to route CRUD operations**

```typescript
// src/components/Sidebar/Sidebar.tsx
import { useState, useDeferredValue, useMemo, useCallback } from 'react';
import { SearchInput } from './SearchInput';
import { FileTree } from './FileTree';
import { FileTreeProvider } from './FileTreeContext';
import { ConfirmDialog } from '../ConfirmDialog';
import { useNavigation } from '../../contexts/NavigationContext';
import { buildTreeFromPaths, filterTree } from '../../lib/tree-utils';
import { createDocument, renameDocument, deleteDocument } from '../../lib/relay-api';
import { getFolderDocForPath, getFolderNameFromPath, getOriginalPath } from '../../lib/multi-folder-utils';
import { RELAY_ID } from '../../App';

interface SidebarProps {
  activeDocId: string;
  onSelectDocument: (docId: string) => void;
}

export function Sidebar({ activeDocId, onSelectDocument }: SidebarProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const deferredSearch = useDeferredValue(searchTerm);

  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ path: string; name: string } | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [newDocName, setNewDocName] = useState('');

  const { metadata, folderDocs, folderNames } = useNavigation();

  // Build tree from metadata
  const treeData = useMemo(() => {
    return buildTreeFromPaths(metadata);
  }, [metadata]);

  // Filter tree based on search
  const filteredTree = useMemo(() => {
    if (!deferredSearch) return treeData;
    return filterTree(treeData, deferredSearch);
  }, [treeData, deferredSearch]);

  const isStale = searchTerm !== deferredSearch;

  // Build compound doc ID and call parent handler
  const handleSelect = useCallback((docId: string) => {
    const compoundDocId = `${RELAY_ID}-${docId}`;
    onSelectDocument(compoundDocId);
  }, [onSelectDocument]);

  // Get the folder for the current active document (for new document creation)
  const getActiveFolderName = useCallback((): string => {
    // Find the path for the active doc
    for (const [path, meta] of Object.entries(metadata)) {
      if (`${RELAY_ID}-${meta.id}` === activeDocId) {
        const folderName = getFolderNameFromPath(path, folderNames);
        if (folderName) return folderName;
      }
    }
    // Default to first folder
    return folderNames[0] ?? 'Lens';
  }, [metadata, activeDocId, folderNames]);

  // CRUD handlers with folder routing
  const handleRenameSubmit = useCallback((oldPath: string, newName: string) => {
    const doc = getFolderDocForPath(oldPath, folderDocs, folderNames);
    if (!doc) return;

    const folderName = getFolderNameFromPath(oldPath, folderNames);
    if (!folderName) return;

    // Get original paths (without folder prefix)
    const originalOldPath = getOriginalPath(oldPath, folderName);

    // Build new path
    const parts = originalOldPath.split('/');
    const filename = newName.endsWith('.md') ? newName : `${newName}.md`;
    parts[parts.length - 1] = filename;
    const originalNewPath = parts.join('/');

    renameDocument(doc, originalOldPath, originalNewPath);
  }, [folderDocs, folderNames]);

  const handleDeleteConfirm = useCallback(() => {
    if (!deleteTarget) return;

    const doc = getFolderDocForPath(deleteTarget.path, folderDocs, folderNames);
    if (!doc) return;

    const folderName = getFolderNameFromPath(deleteTarget.path, folderNames);
    if (!folderName) return;

    const originalPath = getOriginalPath(deleteTarget.path, folderName);
    deleteDocument(doc, originalPath);
    setDeleteTarget(null);
  }, [deleteTarget, folderDocs, folderNames]);

  const handleCreateDocument = useCallback(async () => {
    if (!newDocName.trim()) return;

    // Create in the same folder as the active document
    const folderName = getActiveFolderName();
    const doc = folderDocs.get(folderName);
    if (!doc) return;

    const name = newDocName.trim();
    const filename = name.endsWith('.md') ? name : `${name}.md`;
    const path = `/${filename}`;

    try {
      await createDocument(doc, path, 'markdown');
      setNewDocName('');
      setIsCreating(false);
    } catch (error) {
      console.error('Failed to create document:', error);
    }
  }, [newDocName, folderDocs, getActiveFolderName]);

  const handleNewDocKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleCreateDocument();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setIsCreating(false);
      setNewDocName('');
    }
  };

  const hasAnyDocs = folderDocs.size > 0;

  return (
    <aside className="w-64 flex-shrink-0 bg-white border-r border-gray-200 flex flex-col h-full">
      <div className="p-3 border-b border-gray-200 space-y-2">
        {isCreating ? (
          <input
            type="text"
            value={newDocName}
            onChange={(e) => setNewDocName(e.target.value)}
            onKeyDown={handleNewDocKeyDown}
            onBlur={() => {
              if (!newDocName.trim()) {
                setIsCreating(false);
              }
            }}
            placeholder="New document name..."
            className="w-full px-3 py-1.5 text-sm border border-blue-400 rounded-md outline-none"
            autoFocus
          />
        ) : (
          <button
            onClick={() => setIsCreating(true)}
            disabled={!hasAnyDocs}
            className="w-full px-3 py-1.5 text-sm font-medium text-gray-700 bg-gray-100
                       hover:bg-gray-200 rounded-md disabled:opacity-60 disabled:cursor-not-allowed"
          >
            + New Document
          </button>
        )}

        <SearchInput
          value={searchTerm}
          onChange={setSearchTerm}
          placeholder="Filter documents..."
        />
      </div>

      <div className={`flex-1 overflow-y-auto ${isStale ? 'opacity-80' : ''}`}>
        {!hasAnyDocs && Object.keys(metadata).length === 0 && (
          <div className="p-4 text-sm text-gray-500">
            Loading documents...
          </div>
        )}

        {filteredTree.length === 0 && hasAnyDocs && (
          <div className="p-4 text-sm text-gray-500 text-center">
            {searchTerm ? (
              'No matching documents'
            ) : (
              <>
                No documents yet.
                <br />
                Click &ldquo;New Document&rdquo; to create one.
              </>
            )}
          </div>
        )}

        {filteredTree.length > 0 && (
          <FileTreeProvider
            value={{
              editingPath,
              onEditingChange: setEditingPath,
              onRequestRename: (path) => setEditingPath(path),
              onRequestDelete: (path, name) => setDeleteTarget({ path, name }),
              onRenameSubmit: handleRenameSubmit,
              activeDocId,
            }}
          >
            <FileTree
              data={filteredTree}
              onSelect={handleSelect}
              openAll={!!deferredSearch}
            />
          </FileTreeProvider>
        )}
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Delete ${deleteTarget?.name}?`}
        description="This cannot be undone."
        onConfirm={handleDeleteConfirm}
        confirmLabel="Delete"
      />
    </aside>
  );
}
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Verify app runs**

Run: `npm run dev:local`
Expected: App opens with both folders visible in sidebar

**Step 4: Commit**

```bash
git add src/components/Sidebar/Sidebar.tsx
git commit -m "feat(multi-folder): update Sidebar with folder-aware CRUD routing"
```

---

## Task 12: Integration Test - Both Folders in DOM

**Files:**
- Create: `src/components/Sidebar/Sidebar.integration.test.tsx`

**Step 1: Write the integration test**

```typescript
// src/components/Sidebar/Sidebar.integration.test.tsx
/**
 * Integration test verifying both folders appear in the sidebar.
 * Requires local Y-Sweet: npx y-sweet serve --port 8090
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { Sidebar } from './Sidebar';
import { NavigationContext } from '../../contexts/NavigationContext';
import { useMultiFolderMetadata, type FolderConfig } from '../../hooks/useMultiFolderMetadata';

// Mock RELAY_ID to use local Y-Sweet prefix
vi.mock('../../App', () => ({
  RELAY_ID: 'local',
}));

const YSWEET_URL = 'http://localhost:8090';

// Test folder configuration (matches setup-local-ysweet.mjs)
const TEST_FOLDERS: FolderConfig[] = [
  { id: 'test-folder', name: 'Lens' },
  { id: 'test-folder-edu', name: 'Lens Edu' },
];

async function checkServer(): Promise<boolean> {
  try {
    const response = await fetch(`${YSWEET_URL}/`);
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

/**
 * Test wrapper that uses REAL useMultiFolderMetadata hook.
 * This ensures we're testing real behavior, not mock behavior.
 */
function TestApp({ onSelectDocument }: { onSelectDocument: (id: string) => void }) {
  const { metadata, folderDocs, errors } = useMultiFolderMetadata(TEST_FOLDERS);
  const folderNames = TEST_FOLDERS.map(f => f.name);

  return (
    <NavigationContext.Provider value={{ metadata, folderDocs, folderNames, errors, onNavigate: onSelectDocument }}>
      <Sidebar activeDocId="local-welcome" onSelectDocument={onSelectDocument} />
    </NavigationContext.Provider>
  );
}

describe('Sidebar Multi-Folder Integration', () => {
  beforeAll(async () => {
    const serverUp = await checkServer();
    if (!serverUp) {
      throw new Error(
        'Local Y-Sweet not running! Start with: npx y-sweet serve --port 8090\n' +
        'Then run: npm run local:setup'
      );
    }
  });

  it('shows both folders in the file tree', async () => {
    const handleSelect = vi.fn();

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
});
```

**Step 2: Run the integration test**

Run: `npm test -- src/components/Sidebar/Sidebar.integration.test.tsx --run`
Expected: PASS (requires Y-Sweet running with `npm run local:setup`)

**Step 3: Add to package.json scripts**

Add to `package.json`:
```json
"test:integration:sidebar": "vitest run Sidebar.integration"
```

**Step 4: Commit**

```bash
git add src/components/Sidebar/Sidebar.integration.test.tsx package.json
git commit -m "test(multi-folder): add integration test for both folders in DOM"
```

---

## Task 13: Manual Verification

**Step 1: Start local Y-Sweet**

```bash
npx y-sweet serve --port 8090
```

**Step 2: Setup test folders**

```bash
npm run local:setup
```

**Step 3: Run dev server**

```bash
npm run dev:local
```

**Step 4: Verify in browser**

1. Open http://localhost:5173
2. Verify sidebar shows:
   - "Lens" folder with Welcome.md, Getting Started.md, Notes/Ideas.md
   - "Lens Edu" folder with Course Notes.md, Syllabus.md, Resources/Links.md
3. Click documents in both folders - verify they open
4. Create a new document - verify it appears in the correct folder
5. Rename a document - verify it works
6. Delete a document - verify it works

**Step 5: Final commit**

```bash
git add -A
git commit -m "feat(multi-folder): complete multi-folder support implementation"
```

---

## Summary

| Task | Description | Estimated Time |
|------|-------------|----------------|
| 1 | Pure function tests - `mergeMetadata` | 5 min |
| 2 | Pure function tests - `getFolderNameFromPath` | 5 min |
| 3 | Pure function tests - `getOriginalPath` | 3 min |
| 4 | Hook tests setup | 10 min |
| 5 | Hook tests - metadata merging | 10 min |
| 6 | Hook tests - folder docs map | 2 min |
| 7 | Hook tests - cleanup | 2 min |
| 8 | Update NavigationContext | 3 min |
| 9 | Update App.tsx | 5 min |
| 10 | CRUD routing helpers | 5 min |
| 11 | Update Sidebar | 15 min |
| 12 | Integration test | 10 min |
| 13 | Manual verification | 10 min |

**Total estimated time:** ~85 minutes
