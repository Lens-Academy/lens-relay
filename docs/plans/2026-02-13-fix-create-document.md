# Fix Create Document Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix "New Document" creation so it works in insecure contexts (HTTP) and navigates to the new document after creation.

**Architecture:** Replace `crypto.randomUUID()` with a fallback that uses `crypto.getRandomValues()` (available in all contexts). Fix the `catch` block and `onBlur` handler so the UI never gets stuck. Thread the returned document ID back through `onSelectDocument` to navigate to it.

**Tech Stack:** React, TypeScript, Vitest, yjs

---

### Task 1: Add UUID Fallback in relay-api.ts

**Files:**
- Modify: `lens-editor/src/lib/relay-api.ts:108`
- Test: `lens-editor/src/lib/relay-api.test.ts`

**Step 1: Write the failing test**

Add a test to `relay-api.test.ts` that verifies `createDocument` still produces valid UUIDs when `crypto.randomUUID` is undefined (simulating an insecure context):

```typescript
it('generates valid UUID even when crypto.randomUUID is unavailable', async () => {
  const original = crypto.randomUUID;
  // @ts-expect-error - simulating insecure context
  crypto.randomUUID = undefined;
  try {
    const id = await createDocument(doc, '/InsecureContext.md');
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  } finally {
    crypto.randomUUID = original;
  }
});
```

Add this inside the `describe('createDocument', ...)` block, after the existing `creates document with valid UUID` test.

**Step 2: Run test to verify it fails**

Run: `cd lens-editor && npx vitest run src/lib/relay-api.test.ts --reporter=verbose`
Expected: FAIL — `crypto.randomUUID is not a function`

**Step 3: Write minimal implementation**

In `relay-api.ts`, add a helper function near the top (after the `debug` function, around line 18):

```typescript
/** UUID v4 generator that works in insecure contexts (plain HTTP). */
function generateUUID(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback using crypto.getRandomValues (available in all contexts)
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
```

Then replace line 108:
```typescript
// OLD:
const id = crypto.randomUUID();
// NEW:
const id = generateUUID();
```

**Step 4: Run test to verify it passes**

Run: `cd lens-editor && npx vitest run src/lib/relay-api.test.ts --reporter=verbose`
Expected: ALL PASS

**Step 5: Commit**

```
jj describe -m "fix: use UUID fallback for insecure contexts (HTTP)"
```

---

### Task 2: Fix catch Block and onBlur in Sidebar.tsx

**Files:**
- Modify: `lens-editor/src/components/Sidebar/Sidebar.tsx:112-143` (handleCreateDocument + onBlur)

**Step 1: Fix the catch block**

In `handleCreateDocument` (line 112-132), the `catch` block must reset UI state so the input never gets stuck. Change:

```typescript
// OLD (lines 129-131):
} catch (error) {
  console.error('Failed to create document:', error);
}

// NEW:
} catch (error) {
  console.error('Failed to create document:', error);
  setNewDocName('');
  setIsCreating(false);
}
```

**Step 2: Fix the onBlur handler**

The `onBlur` handler (lines 156-160) should submit when text is present, cancel when empty. Change:

```tsx
// OLD (lines 156-160):
onBlur={() => {
  if (!newDocName.trim()) {
    setIsCreating(false);
  }
}}

// NEW:
onBlur={() => {
  if (newDocName.trim()) {
    handleCreateDocument();
  } else {
    setIsCreating(false);
  }
}}
```

**Step 3: Run existing tests**

Run: `cd lens-editor && npx vitest run src/components/Sidebar/ --reporter=verbose`
Expected: ALL PASS (existing tests should not break)

**Step 4: Commit**

```
jj new && jj describe -m "fix: reset create-doc UI on error, submit on blur"
```

---

### Task 3: Navigate to Newly Created Document

**Files:**
- Modify: `lens-editor/src/components/Sidebar/Sidebar.tsx:112-132` (handleCreateDocument)

**Step 1: Update handleCreateDocument to navigate after creation**

`createDocument()` returns the new document's UUID. `handleSelect()` (line 81-84) builds the compound ID (`RELAY_ID-uuid`) and calls `onSelectDocument`. Reuse that same pattern:

```typescript
// OLD (lines 112-132):
const handleCreateDocument = useCallback(async () => {
  if (!newDocName.trim()) return;
  const targetFolder = folderNames[0];
  if (!targetFolder) return;
  const doc = folderDocs.get(targetFolder);
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
    setNewDocName('');
    setIsCreating(false);
  }
}, [folderDocs, folderNames, newDocName]);

// NEW:
const handleCreateDocument = useCallback(async () => {
  if (!newDocName.trim()) return;
  const targetFolder = folderNames[0];
  if (!targetFolder) return;
  const doc = folderDocs.get(targetFolder);
  if (!doc) return;
  const name = newDocName.trim();
  const filename = name.endsWith('.md') ? name : `${name}.md`;
  const path = `/${filename}`;

  try {
    const id = await createDocument(doc, path, 'markdown');
    setNewDocName('');
    setIsCreating(false);
    // Navigate to the newly created document
    const compoundDocId = `${RELAY_ID}-${id}`;
    onSelectDocument(compoundDocId);
  } catch (error) {
    console.error('Failed to create document:', error);
    setNewDocName('');
    setIsCreating(false);
  }
}, [folderDocs, folderNames, newDocName, onSelectDocument]);
```

Note: `RELAY_ID` is already imported at line 12. `onSelectDocument` is already a prop (line 16). The dependency array gains `onSelectDocument`.

**Step 2: Run all tests**

Run: `cd lens-editor && npx vitest run --reporter=verbose`
Expected: ALL PASS

**Step 3: Manual verification via Chrome DevTools MCP**

1. Navigate to `http://dev.vps:5373`
2. Click "+ New Document"
3. Type "Test Doc" and press Enter
4. Verify: input closes, new file appears in tree, editor loads the new document
5. Click "+ New Document" again, type "Another", click outside the input
6. Verify: same behavior — document created and navigated to

**Step 4: Commit**

```
jj new && jj describe -m "feat: navigate to newly created document"
```
