# Rename Backlink Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make inline renames (sidebar F2 and DocumentTitle) update backlinks by routing through the server-side `moveDocument()` API.

**Architecture:** Replace client-side `renameDocument()` calls in the two UI rename handlers with `moveDocument()` (existing server endpoint). Fix the server's `move_document()` to also update the legacy `docs` Y.Map for Obsidian compatibility.

**Tech Stack:** TypeScript (React), Rust (y-sweet-core link_indexer)

---

### Task 1: Pass docId through the rename callback chain

**Files:**
- Modify: `src/components/Sidebar/FileTreeContext.tsx:7`
- Modify: `src/components/Sidebar/FileTreeNode.tsx:73`

**Step 1: Update the context type**

In `src/components/Sidebar/FileTreeContext.tsx`, change line 7:

```typescript
// Before:
onRenameSubmit?: (oldPath: string, newName: string) => void;

// After:
onRenameSubmit?: (oldPath: string, newName: string, docId: string) => void;
```

**Step 2: Pass docId from FileTreeNode**

In `src/components/Sidebar/FileTreeNode.tsx`, change line 73:

```typescript
// Before:
ctx.onRenameSubmit?.(node.data.path, trimmed);

// After:
if (node.data.docId) {
  ctx.onRenameSubmit?.(node.data.path, trimmed, node.data.docId);
}
```

**Step 3: Run tests**

Run: `npx vitest run --exclude '**/*.integration.*'`
Expected: All 554 tests pass (no component tests exist for these files)

**Step 4: Commit**

```bash
jj describe -m "refactor: pass docId through rename callback chain"
```

---

### Task 2: Sidebar rename → moveDocument()

**Files:**
- Modify: `src/components/Sidebar/Sidebar.tsx:103-116`

**Step 1: Change handleRenameSubmit to use moveDocument**

In `src/components/Sidebar/Sidebar.tsx`, replace `handleRenameSubmit` (lines 103-116):

```typescript
// Before:
const handleRenameSubmit = useCallback((prefixedOldPath: string, newName: string) => {
  const doc = getFolderDocForPath(prefixedOldPath, folderDocs, folderNames);
  if (!doc) return;
  const folderName = getFolderNameFromPath(prefixedOldPath, folderNames)!;
  const oldPath = getOriginalPath(prefixedOldPath, folderName);
  const parts = oldPath.split('/');
  const filename = newName.endsWith('.md') ? newName : `${newName}.md`;
  parts[parts.length - 1] = filename;
  const newPath = parts.join('/');
  renameDocument(doc, oldPath, newPath);
}, [folderDocs, folderNames]);

// After:
const handleRenameSubmit = useCallback(async (prefixedOldPath: string, newName: string, docId: string) => {
  const folderName = getFolderNameFromPath(prefixedOldPath, folderNames);
  if (!folderName) return;
  const oldPath = getOriginalPath(prefixedOldPath, folderName);
  const parts = oldPath.split('/');
  const filename = newName.endsWith('.md') ? newName : `${newName}.md`;
  parts[parts.length - 1] = filename;
  const newPath = parts.join('/');
  try {
    await moveDocument(docId, newPath);
  } catch (err: any) {
    console.error('Rename failed:', err);
    setMoveError(err.message || 'Rename failed');
  }
}, [folderNames]);
```

**Step 2: Update imports**

In `src/components/Sidebar/Sidebar.tsx`, update the import from `relay-api`:

- Remove `renameDocument` from imports (if no longer used elsewhere in the file)
- Ensure `moveDocument` is imported (it should already be)

Check: `renameDocument` should only appear in the import line — grep the file to confirm. If it's used elsewhere, keep the import.

**Step 3: Run tests**

Run: `npx vitest run --exclude '**/*.integration.*'`
Expected: All pass

**Step 4: Commit**

```bash
jj describe -m "fix: sidebar rename uses moveDocument for backlink updates"
jj new
```

---

### Task 3: DocumentTitle rename → moveDocument()

**Files:**
- Modify: `src/components/DocumentTitle.tsx:1-48`

**Step 1: Change handleSubmit to use moveDocument**

Update import (line 5):

```typescript
// Before:
import { renameDocument } from '../lib/relay-api';

// After:
import { moveDocument } from '../lib/relay-api';
```

Replace `handleSubmit` (lines 35-48):

```typescript
// Before:
const handleSubmit = useCallback(() => {
  const trimmed = value.trim();
  if (!trimmed || trimmed === displayName || !path) return;

  const doc = getFolderDocForPath(path, folderDocs, folderNames);
  if (!doc) return;
  const folderName = getFolderNameFromPath(path, folderNames)!;
  const originalPath = getOriginalPath(path, folderName);
  const parts = originalPath.split('/');
  const filename = trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
  parts[parts.length - 1] = filename;
  const newPath = parts.join('/');
  renameDocument(doc, originalPath, newPath);
}, [value, displayName, path, folderDocs, folderNames]);

// After:
const handleSubmit = useCallback(async () => {
  const trimmed = value.trim();
  if (!trimmed || trimmed === displayName || !path) return;

  const folderName = getFolderNameFromPath(path, folderNames);
  if (!folderName) return;
  const originalPath = getOriginalPath(path, folderName);
  const parts = originalPath.split('/');
  const filename = trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
  parts[parts.length - 1] = filename;
  const newPath = parts.join('/');
  try {
    await moveDocument(uuid, newPath);
  } catch (err: any) {
    console.error('Rename failed:', err);
  }
}, [value, displayName, path, uuid, folderNames]);
```

**Step 2: Clean up unused imports**

Remove these imports that are no longer needed (since we no longer access the Y.Doc directly):

- Remove `getFolderDocForPath` from the import if only used here (check first)
- Keep `getFolderNameFromPath` and `getOriginalPath` — still used
- Remove `folderDocs` from the destructured `useNavigation()` call if not used elsewhere in the component

**Step 3: Run tests**

Run: `npx vitest run --exclude '**/*.integration.*'`
Expected: All pass

**Step 4: Commit**

```bash
jj describe -m "fix: DocumentTitle rename uses moveDocument for backlink updates"
jj new
```

---

### Task 4: Server-side legacy `docs` map fix

**Files:**
- Modify: `crates/y-sweet-core/src/link_indexer.rs:559-578`

**Step 1: Add legacy docs map update for within-folder moves**

After the `filemeta_v0` update in the within-folder branch (line 572-578), add:

```rust
// Within-folder: remove old, insert new in one transaction
let mut txn = source_folder_doc.transact_mut_with("link-indexer");
let filemeta = txn.get_or_insert_map("filemeta_v0");
filemeta.remove(&mut txn, &old_path);
filemeta.insert(&mut txn, new_path, Any::Map(meta_fields.clone().into()));
// Also update legacy "docs" map for Obsidian compatibility
let docs_map = txn.get_or_insert_map("docs");
if let Some(legacy_value) = docs_map.get(&txn, &old_path) {
    let legacy_clone = legacy_value.to_string(&txn);
    docs_map.remove(&mut txn, &old_path);
    docs_map.insert(&mut txn, new_path, legacy_clone);
}
```

**Step 2: Add legacy docs map update for cross-folder moves**

In the cross-folder branch (lines 560-571), add legacy docs updates:

```rust
if is_cross_folder {
    // Cross-folder: remove from source, add to target
    let legacy_value = {
        let txn = source_folder_doc.transact();
        let docs_map = txn.get_map("docs");
        docs_map.and_then(|m| m.get(&txn, &old_path).map(|v| v.to_string(&txn)))
    };
    {
        let mut txn = source_folder_doc.transact_mut_with("link-indexer");
        let filemeta = txn.get_or_insert_map("filemeta_v0");
        filemeta.remove(&mut txn, &old_path);
        // Remove from legacy docs map
        let docs_map = txn.get_or_insert_map("docs");
        docs_map.remove(&mut txn, &old_path);
    }
    {
        let mut txn = target_folder_doc.transact_mut_with("link-indexer");
        let filemeta = txn.get_or_insert_map("filemeta_v0");
        filemeta.insert(&mut txn, new_path, Any::Map(meta_fields.clone().into()));
        // Add to legacy docs map in target
        if let Some(ref lv) = legacy_value {
            let docs_map = txn.get_or_insert_map("docs");
            docs_map.insert(&mut txn, new_path, lv.clone());
        }
    }
}
```

**Important:** The exact Rust API for reading a `MapRef` value as a string depends on the yrs types used. Check how `extract_id_from_filemeta_entry` reads values — the legacy `docs` map stores plain string values (UUID strings), not nested maps. The read pattern may need to use `Value::Any(Any::String(s))` matching instead of `.to_string()`. Verify against the yrs API before implementing.

**Step 3: Build**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo check --manifest-path=/home/penguin/code/lens-relay/ws1/crates/Cargo.toml`
Expected: Compiles without errors

**Step 4: Commit**

```bash
jj describe -m "fix: move_document updates legacy docs Y.Map for Obsidian compat"
jj new
```

---

### Task 5: Manual verification

**Step 1: Start local relay with R2**

```bash
npm run relay:start:r2   # Terminal 1
npm run dev:local:r2     # Terminal 2
```

**Step 2: Test sidebar rename**

1. Open the editor, navigate to a file that has backlinks
2. F2 to rename it in the sidebar
3. Check that documents linking to it have updated wikilinks

**Step 3: Test DocumentTitle rename**

1. Open a document with backlinks
2. Edit the title at the top
3. Check that backlinks updated

**Step 4: Test drag-and-drop still works**

1. Drag a file to a different folder
2. Verify backlinks updated (regression check)

---

## File Summary

| File | Change |
|------|--------|
| `src/components/Sidebar/FileTreeContext.tsx` | Add `docId` param to `onRenameSubmit` type |
| `src/components/Sidebar/FileTreeNode.tsx` | Pass `node.data.docId` to `onRenameSubmit` |
| `src/components/Sidebar/Sidebar.tsx` | `handleRenameSubmit` → async, calls `moveDocument()` |
| `src/components/DocumentTitle.tsx` | `handleSubmit` → async, calls `moveDocument()` |
| `crates/y-sweet-core/src/link_indexer.rs` | `move_document()` updates legacy `docs` Y.Map |
