# Fix: Rename operations should update backlinks

**Date:** 2026-02-22
**Status:** Approved

## Problem

Renaming a file (via sidebar F2 or DocumentTitle editing) does not update wikilinks in other documents that reference the renamed file. This is a regression — moving files via drag-and-drop or the "Move to..." dialog correctly rewrites backlinks.

**Root cause:** Two separate code paths exist:
- **Rename** (sidebar/title): calls `renameDocument()` which only mutates the local Y.Doc `filemeta_v0` and `docs` maps. No server call, no backlink rewriting.
- **Move** (drag/dialog): calls `moveDocument()` which hits `POST /doc/move` on the server, which atomically handles metadata update + backlink rewriting + search index update.

## Solution: Route renames through moveDocument()

Unify both paths by having inline renames call the same server-side `moveDocument()` endpoint that drag-and-drop uses.

### Change 1: Sidebar `handleRenameSubmit`

**File:** `src/components/Sidebar/Sidebar.tsx`

- Change `onRenameSubmit` signature to include `docId` (UUID)
- Replace `renameDocument(doc, oldPath, newPath)` with `await moveDocument(docId, newPath)`
- Make callback async, add error handling

**File:** `src/components/Sidebar/FileTreeContext.tsx`

- Update `onRenameSubmit` type: `(oldPath: string, newName: string)` → `(oldPath: string, newName: string, docId: string)`

**File:** `src/components/Sidebar/FileTreeNode.tsx`

- Pass `node.data.docId` to `onRenameSubmit` call

### Change 2: DocumentTitle `handleSubmit`

**File:** `src/components/DocumentTitle.tsx`

- Replace `renameDocument(doc, originalPath, newPath)` with `await moveDocument(uuid, newPath)`
- Already has `uuid` from line 18
- Make async, add error handling

### Change 3: Server-side legacy `docs` map fix

**File:** `crates/y-sweet-core/src/link_indexer.rs` → `move_document()`

The server-side `move_document()` only updates `filemeta_v0` but not the legacy `docs` Y.Map. Per project conventions, both maps must stay in sync or Obsidian treats the document as orphaned and deletes it.

- Read the UUID from `filemeta_v0` metadata
- Update legacy `docs` map alongside `filemeta_v0` in both same-folder and cross-folder moves

### What stays

- `renameDocument()` in relay-api.ts: kept for tests (verifies Y.Doc transactional behavior) but no longer called from UI components.

## Trade-offs

- **Latency:** Rename becomes a network round-trip (~50ms) instead of instant local mutation. Acceptable — the Y.Doc sync was already async.
- **Offline:** Rename won't work if server is unreachable. Currently not a concern since the editor requires a live connection anyway.
