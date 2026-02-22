# Per-Folder Instant Document Creation - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the name-first document creation flow with instant per-folder creation (click "+" on any folder → creates "Untitled.md" → auto-focuses title for rename).

**Architecture:** Add `onCreateDocument` callback to the FileTree context so folder nodes can trigger creation. The Sidebar's new `handleInstantCreate` resolves the shared folder Y.Doc from the prefixed path and creates the document. A `justCreated` ref in NavigationContext signals DocumentTitle to auto-focus.

**Tech Stack:** React, yjs, vitest, react-testing-library

---

### Task 1: Add `generateUntitledName` utility

**Files:**
- Modify: `lens-editor/src/lib/multi-folder-utils.ts`
- Test: `lens-editor/src/lib/multi-folder-utils.test.ts`

**Step 1: Write the failing test**

In `lens-editor/src/lib/multi-folder-utils.test.ts`, add a new describe block at the end:

```typescript
describe('generateUntitledName', () => {
  it('returns "Untitled.md" when no conflicts', () => {
    const metadata: FolderMetadata = {
      '/Lens/Notes.md': { id: '1', type: 'markdown', version: 0 },
    };
    expect(generateUntitledName('/Lens', metadata)).toBe('Untitled.md');
  });

  it('returns "Untitled 1.md" when "Untitled.md" exists', () => {
    const metadata: FolderMetadata = {
      '/Lens/Untitled.md': { id: '1', type: 'markdown', version: 0 },
    };
    expect(generateUntitledName('/Lens', metadata)).toBe('Untitled 1.md');
  });

  it('returns "Untitled 2.md" when 0 and 1 exist', () => {
    const metadata: FolderMetadata = {
      '/Lens/Untitled.md': { id: '1', type: 'markdown', version: 0 },
      '/Lens/Untitled 1.md': { id: '2', type: 'markdown', version: 0 },
    };
    expect(generateUntitledName('/Lens', metadata)).toBe('Untitled 2.md');
  });

  it('handles subfolder paths', () => {
    const metadata: FolderMetadata = {
      '/Lens/Notes/Untitled.md': { id: '1', type: 'markdown', version: 0 },
    };
    expect(generateUntitledName('/Lens/Notes', metadata)).toBe('Untitled 1.md');
  });

  it('fills gaps in numbering', () => {
    const metadata: FolderMetadata = {
      '/Lens/Untitled.md': { id: '1', type: 'markdown', version: 0 },
      '/Lens/Untitled 3.md': { id: '2', type: 'markdown', version: 0 },
    };
    // Should take next sequential, not fill gap
    expect(generateUntitledName('/Lens', metadata)).toBe('Untitled 1.md');
  });
});
```

Add the import for `generateUntitledName` alongside the existing imports from `../lib/multi-folder-utils`. Also import `FolderMetadata` from `../hooks/useFolderMetadata` if not already imported.

**Step 2: Run test to verify it fails**

Run: `cd lens-editor && npx vitest run multi-folder-utils.test --reporter=verbose`
Expected: FAIL — `generateUntitledName` is not exported

**Step 3: Write minimal implementation**

In `lens-editor/src/lib/multi-folder-utils.ts`, add at the end:

```typescript
/**
 * Generate a unique "Untitled.md" / "Untitled N.md" name for a folder.
 * Checks merged metadata (prefixed paths) for collisions.
 * @param folderPath - The prefixed folder path, e.g. "/Lens" or "/Lens/Notes"
 * @param metadata - The merged folder metadata with prefixed paths
 */
export function generateUntitledName(
  folderPath: string,
  metadata: FolderMetadata
): string {
  const prefix = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;
  const existing = new Set(
    Object.keys(metadata)
      .filter((p) => p.startsWith(prefix))
      .map((p) => p.slice(prefix.length).split('/')[0]) // Only direct children
  );

  if (!existing.has('Untitled.md')) return 'Untitled.md';

  for (let i = 1; ; i++) {
    const candidate = `Untitled ${i}.md`;
    if (!existing.has(candidate)) return candidate;
  }
}
```

Add the `FolderMetadata` import at the top if not already there (it should already be imported via the existing `FolderInput` interface usage — check if `FolderMetadata` is already imported, and add it to the import if not).

**Step 4: Run test to verify it passes**

Run: `cd lens-editor && npx vitest run multi-folder-utils.test --reporter=verbose`
Expected: All tests PASS

**Step 5: Commit**

```bash
jj new -m "feat: add generateUntitledName utility for instant doc creation"
```

---

### Task 2: Add `onCreateDocument` to FileTreeContext

**Files:**
- Modify: `lens-editor/src/components/Sidebar/FileTreeContext.tsx`

**Step 1: Add the callback to the interface**

In `lens-editor/src/components/Sidebar/FileTreeContext.tsx`, add to the `FileTreeContextValue` interface:

```typescript
export interface FileTreeContextValue {
  onRequestRename?: (path: string) => void;
  onRequestDelete?: (path: string, name: string) => void;
  onRequestMove?: (path: string, docId: string) => void;
  onRenameSubmit?: (oldPath: string, newName: string, docId: string) => void;
  onCreateDocument?: (folderPath: string) => void;  // NEW
  editingPath: string | null;
  onEditingChange: (path: string | null) => void;
  activeDocId?: string;
}
```

No test needed — this is a type-only change. TypeScript compilation will verify.

**Step 2: Commit**

```bash
jj new -m "feat: add onCreateDocument callback to FileTreeContext"
```

---

### Task 3: Add "+" button to folder nodes in FileTreeNode

**Files:**
- Modify: `lens-editor/src/components/Sidebar/FileTreeNode.tsx`
- Test: `lens-editor/src/components/Sidebar/Sidebar.test.tsx`

**Step 1: Write the failing test**

In `lens-editor/src/components/Sidebar/Sidebar.test.tsx`, add a new test inside the existing describe block:

```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `cd lens-editor && npx vitest run Sidebar.test --reporter=verbose`
Expected: FAIL — no button with that accessible name

**Step 3: Write the implementation**

In `lens-editor/src/components/Sidebar/FileTreeNode.tsx`, add the "+" button inside the folder row. Find the section after the folder icon SVG and before the name span (around line 188). Add the "+" button to render **after** the name, pushed to the right with `ml-auto`:

Replace the existing `{/* Name or edit input */}` section and what follows through the closing `</div>` of the `content` variable. The key change: for folder nodes, add a "+" button after the name:

```tsx
      {/* Name or edit input */}
      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          className="flex-1 text-sm text-gray-700 bg-white border border-blue-400 rounded px-1 py-0 outline-none ml-1"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="truncate text-sm text-gray-700 ml-1" title={node.data.path}>
          {node.data.name}
        </span>
      )}

      {/* Create document button for folders */}
      {isFolder && ctx.onCreateDocument && (
        <button
          aria-label={`Create document in ${node.data.name}`}
          onClick={(e) => {
            e.stopPropagation();
            ctx.onCreateDocument!(node.data.path);
          }}
          className="ml-auto flex-shrink-0 p-0.5 text-gray-400 hover:text-gray-600 hover:bg-gray-200 rounded"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
        </button>
      )}
    </div>
  );
```

Make sure the closing `</div>` for the `content` variable's outer div remains.

**Step 4: Run test to verify it passes**

Run: `cd lens-editor && npx vitest run Sidebar.test --reporter=verbose`
Expected: All tests PASS

**Step 5: Commit**

```bash
jj new -m "feat: add '+' create button to folder nodes in sidebar tree"
```

---

### Task 4: Add `justCreatedRef` to NavigationContext for auto-focus signaling

**Files:**
- Modify: `lens-editor/src/contexts/NavigationContext.tsx`
- Modify: `lens-editor/src/App.tsx` (where the provider is created)

**Step 1: Add `justCreatedRef` to the context**

In `lens-editor/src/contexts/NavigationContext.tsx`, add a `React.RefObject<boolean>` to the interface:

```typescript
import { createContext, useContext, type RefObject } from 'react';
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
  /** Set to true after instant-create; DocumentTitle reads and clears it */
  justCreatedRef: RefObject<boolean>;
}
```

**Step 2: Update the provider in App.tsx**

Read `lens-editor/src/App.tsx` to find where `NavigationContext.Provider` is rendered, then add a `useRef(false)` and pass it as `justCreatedRef` in the context value. The ref object is stable across renders so it won't cause re-renders.

Find the NavigationContext.Provider value object and add `justCreatedRef` to it. Create the ref near the top of the component:

```typescript
const justCreatedRef = useRef(false);
```

And add it to the provider value. Make sure `useRef` is imported from React.

**Step 3: Run existing tests to verify no regression**

Run: `cd lens-editor && npx vitest run --reporter=verbose`
Expected: Some tests may fail because they provide NavigationContext without `justCreatedRef`. Fix those test files by adding `justCreatedRef: { current: false }` to their mock context values. Check `Sidebar.test.tsx`, `Sidebar.integration.test.tsx`, `EditorArea.test.tsx`, and any other test that creates a `NavigationContext.Provider`.

**Step 4: Commit**

```bash
jj new -m "feat: add justCreatedRef to NavigationContext for auto-focus signaling"
```

---

### Task 5: Wire up instant-create handler in Sidebar and remove old create UI

**Files:**
- Modify: `lens-editor/src/components/Sidebar/Sidebar.tsx`
- Test: `lens-editor/src/components/Sidebar/Sidebar.test.tsx`

**Step 1: Write the failing test**

In `lens-editor/src/components/Sidebar/Sidebar.test.tsx`, add:

```typescript
import userEvent from '@testing-library/user-event';
import { createDocument } from '../../lib/relay-api';

vi.mock('../../lib/relay-api', async () => {
  const actual = await vi.importActual('../../lib/relay-api');
  return {
    ...actual,
    createDocument: vi.fn().mockResolvedValue('new-doc-id'),
    deleteDocument: vi.fn(),
    moveDocument: vi.fn(),
  };
});
```

Then add this test:

```typescript
  it('creates document in correct folder when "+" is clicked', async () => {
    const user = userEvent.setup();
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
    expect(createDocument).toHaveBeenCalledWith(eduDoc, '/Untitled.md', 'markdown');
    // Should navigate to new doc
    expect(mockNavigate).toHaveBeenCalled();
  });
```

**Step 2: Run test to verify it fails**

Run: `cd lens-editor && npx vitest run Sidebar.test --reporter=verbose`
Expected: FAIL — `createDocument` not called with expected args (old handler still wired)

**Step 3: Implement handleInstantCreate and remove old create UI**

In `lens-editor/src/components/Sidebar/Sidebar.tsx`:

1. **Remove** state: `isCreating`, `newDocName`
2. **Remove** `handleCreateDocument` callback
3. **Remove** `handleNewDocKeyDown` handler
4. **Remove** the `isCreating ? <input> : <button>` block from JSX (lines 239-265)

5. **Add** the `justCreatedRef` to the destructured values from `useNavigation()`:

```typescript
const { metadata, folderDocs, folderNames, onNavigate, justCreatedRef } = useNavigation();
```

6. **Add** import for `generateUntitledName`:

```typescript
import { getFolderDocForPath, getOriginalPath, getFolderNameFromPath, generateUntitledName } from '../../lib/multi-folder-utils';
```

7. **Add** new handler:

```typescript
  const handleInstantCreate = useCallback(async (folderPath: string) => {
    const folderName = getFolderNameFromPath(folderPath, folderNames);
    if (!folderName) return;
    const doc = folderDocs.get(folderName);
    if (!doc) return;

    // Compute the relative path within the shared folder
    const originalFolderPath = getOriginalPath(folderPath, folderName);
    const untitledName = generateUntitledName(folderPath, metadata);
    const path = originalFolderPath === '' || originalFolderPath === '/'
      ? `/${untitledName}`
      : `${originalFolderPath}/${untitledName}`;

    try {
      const id = await createDocument(doc, path, 'markdown');
      justCreatedRef.current = true;
      const compoundDocId = `${RELAY_ID}-${id}`;
      onNavigate(compoundDocId);
    } catch (error) {
      console.error('Failed to create document:', error);
    }
  }, [folderDocs, folderNames, metadata, onNavigate, justCreatedRef]);
```

8. **Pass** `onCreateDocument` to the FileTreeProvider:

```typescript
<FileTreeProvider
  value={{
    editingPath,
    onEditingChange: setEditingPath,
    onRequestRename: (path) => setEditingPath(path),
    onRequestDelete: (path, name) => setDeleteTarget({ path, name }),
    onRequestMove: handleMoveRequest,
    onRenameSubmit: handleRenameSubmit,
    onCreateDocument: handleInstantCreate,  // NEW
    activeDocId,
  }}
>
```

**Step 4: Run test to verify it passes**

Run: `cd lens-editor && npx vitest run Sidebar.test --reporter=verbose`
Expected: All tests PASS

**Step 5: Also verify the old "New Document" button test doesn't exist or update it**

Run: `cd lens-editor && npx vitest run --reporter=verbose`
Expected: All tests PASS. If any test references the removed "New Document" button, update or remove it.

**Step 6: Commit**

```bash
jj new -m "feat: wire instant-create handler, remove old create UI"
```

---

### Task 6: Auto-focus DocumentTitle on new document creation

**Files:**
- Modify: `lens-editor/src/components/DocumentTitle.tsx`

**Step 1: Implement auto-focus**

In `lens-editor/src/components/DocumentTitle.tsx`:

1. Import `useNavigation`:

```typescript
import { useNavigation } from '../contexts/NavigationContext';
```

2. Inside the component, read the ref and add an effect:

```typescript
const { justCreatedRef } = useNavigation();

// Auto-focus and select when doc was just created
useEffect(() => {
  if (justCreatedRef.current && inputRef.current) {
    justCreatedRef.current = false;
    // Delay to ensure the component is fully mounted with correct value
    setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
      }
    }, 100);
  }
}, [justCreatedRef, displayName]);
```

Place this effect after the existing `useEffect` that syncs `value` from `displayName`.

**Step 2: Run all tests to verify no regressions**

Run: `cd lens-editor && npx vitest run --reporter=verbose`
Expected: All tests PASS. The EditorArea test mocks DocumentTitle so it won't be affected.

**Step 3: Commit**

```bash
jj new -m "feat: auto-focus DocumentTitle input after instant create"
```

---

### Task 7: Manual integration test

**Step 1: Start the local relay server**

```bash
cd lens-editor && npm run relay:start
```

**Step 2: Setup test documents**

```bash
cd lens-editor && npm run relay:setup
```

**Step 3: Start the dev server**

```bash
cd lens-editor && npm run dev:local
```

**Step 4: Generate a share link**

```bash
cd lens-editor && npx tsx scripts/generate-share-link.ts --role edit --folder b0000001-0000-4000-8000-000000000001 --base-url http://dev.vps:5173
```

**Step 5: Test in browser**

1. Open the share link in the browser
2. Verify each folder node has a "+" button
3. Click "+" on "Relay Folder 1" → should create "Untitled.md" and navigate to it
4. Verify the DocumentTitle input is focused with "Untitled" selected
5. Type a new name, press Enter → should rename the document
6. Click "+" again → should create "Untitled 1.md"
7. If there are subfolders, verify "+" works on them too

**Step 6: Commit any fixes from manual testing**

---

### Task 8: Clean up — remove any dead code

**Step 1: Search for references to removed state**

Search for `isCreating`, `newDocName`, `handleCreateDocument`, `handleNewDocKeyDown` across the codebase. Remove any stale references in tests or other files.

**Step 2: Run full test suite**

Run: `cd lens-editor && npx vitest run --reporter=verbose`
Expected: All tests PASS

**Step 3: Final commit**

```bash
jj new -m "chore: clean up dead code from old create-document flow"
```
