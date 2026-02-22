# Per-Folder Instant Document Creation

**Date:** 2026-02-22

## Problem

When creating a new document, there's no way to control which folder it's created in. The current implementation always defaults to the first folder. The UX also requires typing a name before creation, which adds unnecessary friction.

## Design

### UX: Instant Create (Obsidian/Notion Style)

Replace the current "type name first" flow with instant creation:

1. Every folder node in the sidebar tree gets a permanent "+" button (always visible, not hover-only)
2. Clicking "+" creates an "Untitled.md" document in that folder
3. Navigates to the new document
4. Auto-focuses the DocumentTitle input with all text selected so user can immediately type a real name
5. On blur/Enter, the document is renamed via the existing `moveDocument` API

### Naming Convention

- Default name: "Untitled.md"
- If "Untitled.md" exists: "Untitled 1.md", "Untitled 2.md", etc.
- Numbering checks existing docs in the target (sub)folder

### Subfolder Support

The "+" button appears on ALL folder nodes, not just top-level shared folders:

- `/Lens` "+" → creates `/Untitled.md` in the Lens folder doc
- `/Lens/Notes` "+" → creates `/Notes/Untitled.md` in the Lens folder doc
- `/Lens Edu` "+" → creates `/Untitled.md` in the Lens Edu folder doc
- `/Lens Edu/Physics` "+" → creates `/Physics/Untitled.md` in the Lens Edu folder doc

Resolution: use `getFolderNameFromPath()` to find the shared folder, then `getOriginalPath()` to compute the relative path within it.

## Component Changes

### Remove (Sidebar.tsx)

- `isCreating` state
- `newDocName` state
- `handleCreateDocument()` callback
- `handleNewDocKeyDown()` handler
- The "New Document" button/input form at the top of the sidebar

### Add/Modify

**FileTreeContext.tsx:**
- Add `onCreateDocument?: (folderPath: string) => void` to context type

**FileTreeNode.tsx:**
- For folder nodes: render a "+" button on the right side of the row
- Clicking calls `ctx.onCreateDocument(node.data.path)`

**Sidebar.tsx:**
- New `handleInstantCreate(folderPath: string)` handler:
  1. Extract shared folder name via `getFolderNameFromPath(folderPath, folderNames)`
  2. Get folder Y.Doc from `folderDocs.get(folderName)`
  3. Compute relative subfolder path via `getOriginalPath(folderPath, folderName)`
  4. Generate unique name: check existing docs for "Untitled.md" collisions
  5. Call `createDocument(folderDoc, subfolderPath + '/Untitled.md', 'markdown')`
  6. Navigate to the new document
  7. Set `justCreated` flag for auto-focus
- Pass `onCreateDocument={handleInstantCreate}` to `FileTreeProvider`

**NavigationContext (or lightweight signal):**
- Add `justCreated: boolean` flag + setter
- Set to `true` when instant-create navigates

**DocumentTitle.tsx:**
- Read `justCreated` flag from context
- When true: auto-focus input, select all text, clear the flag

### No Server Changes

The relay server already supports:
- Document creation via `/api/relay/doc/new`
- Path assignment via filemeta_v0 Y.Map
- Renaming via `moveDocument` (same-folder path change)

## Not In Scope

- Creating new subfolders (only creating documents within existing folders)
- Keyboard shortcuts for new document creation
- Template selection for new documents
