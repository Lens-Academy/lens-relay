---
phase: 08-move-surfaces
verified: 2026-02-20T15:56:21Z
status: passed
score: 8/8 must-haves verified
gaps: []
human_verification:
  - test: "Right-click a file in the lens-editor file tree and verify 'Move to...' appears, dialog opens, and tree updates after move"
    expected: "Context menu shows 'Move to...', dialog pre-populates current path, successful move updates the file tree via Y.js propagation"
    why_human: "Visual UI rendering and Y.js auto-propagation of filemeta_v0 changes cannot be verified programmatically"
  - test: "Call MCP move_document tool via MCP protocol with a live relay server and verify confirmation response"
    expected: "Tool returns string like 'Moved Lens/Old.md -> Lens/New.md (0 links rewritten)'"
    why_human: "End-to-end MCP protocol call requires a running relay server with MCP_API_KEY configured"
---

# Phase 8: Move Surfaces Verification Report

**Phase Goal:** Users can move files through the lens-editor UI, and AI assistants can move files via MCP -- both backed by the move API
**Verified:** 2026-02-20T15:56:21Z
**Status:** passed
**Re-verification:** No -- initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | AI assistant can call MCP move_document tool to relocate a document and receives confirmation | VERIFIED | `move_doc.rs` implements `execute()` returning `Ok("Moved {old}{old_path} -> {new}{new_path} ({n} links rewritten)")` |
| 2 | Move tool rejects missing/invalid parameters with clear error messages | VERIFIED | `move_doc.rs` lines 9-17 return `Err("Missing required parameter: file_path/new_path")`, lines 22-27 reject bad format |
| 3 | Move tool rejects moves to paths that already exist (409-style) | VERIFIED | `move_doc.rs` lines 81-96 check `filemeta.get(&txn, new_path).is_some()` and return `Err("Path '...' already exists in target folder")` |
| 4 | Move tool rejects moves for unknown UUIDs (404-style) | VERIFIED | `move_doc.rs` lines 29-33 call `doc_resolver().resolve_path()` and return `Err("Document not found: {file_path}")` |
| 5 | After MCP move, wikilinks in other documents are rewritten (full pipeline) | VERIFIED | `move_doc.rs` lines 204-215 call `link_indexer::move_document(...)` which returns `result.links_rewritten`; search index updated at lines 228-230 |
| 6 | User can right-click a file and see 'Move to...' in context menu | VERIFIED | `FileTreeContextMenu.tsx` lines 34-41 render `{!isFolder && <ContextMenu.Item onSelect={onMove}>Move to...</ContextMenu.Item>}` |
| 7 | Clicking 'Move to...' opens a dialog with path input and folder selector | VERIFIED | `Sidebar.tsx` lines 336-401 render a `Dialog.Root` with path input, folder selector (conditional on `folderNames.length > 1`), error display, and Move/Cancel buttons |
| 8 | After UI move, wikilinks are rewritten (full pipeline through POST /doc/move) | VERIFIED | `relay-api.ts` `moveDocument()` calls `POST /api/relay/doc/move` which routes via Vite proxy to `handle_move_document` in server.rs (registered at line 1482), which calls `link_indexer::move_document` |

**Score:** 8/8 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `crates/relay/src/mcp/tools/move_doc.rs` | MCP move_document tool implementation | VERIFIED | 241 lines, full implementation with sync block pattern, calls `link_indexer::move_document`, updates search index |
| `crates/relay/src/mcp/tools/mod.rs` | move_document tool definition and dispatch entry | VERIFIED | Line 6: `pub mod move_doc;`; lines 171-196: full tool definition in `tool_definitions()`; line 244: dispatch match arm `"move_document" => match move_doc::execute(...)` |
| `crates/relay/src/mcp/router.rs` | Updated tool count test | VERIFIED | Line 278: `assert_eq!(tools_arr.len(), 7)` and line 291: `assert!(names.contains(&"move_document"))` |
| `lens-editor/src/lib/relay-api.ts` | moveDocument() function calling POST /doc/move | VERIFIED | Lines 264-301: `MoveDocumentResponse` interface and `moveDocument()` function calling `fetch('/api/relay/doc/move', ...)` |
| `lens-editor/src/components/Sidebar/FileTreeContextMenu.tsx` | Move to... context menu item | VERIFIED | Lines 8, 17, 34-41: `onMove` prop wired, `Move to...` item rendered for non-folder nodes |
| `lens-editor/src/components/Sidebar/Sidebar.tsx` | Move handler wiring and move dialog state | VERIFIED | Lines 45-49: state vars; lines 153-179: `handleMoveRequest`/`handleMoveConfirm` handlers; line 309: `onRequestMove: handleMoveRequest`; lines 336-401: full Radix Dialog UI |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `move_doc.rs` | `link_indexer::move_document` | Direct function call | WIRED | Line 205: `let result = link_indexer::move_document(uuid, new_path, ...)` |
| `mod.rs` | `move_doc.rs` | Module declaration and dispatch | WIRED | Line 6: `pub mod move_doc;`; line 244: `"move_document" => match move_doc::execute(server, arguments)` |
| `Sidebar.tsx` | `relay-api.ts` | Import and call moveDocument() | WIRED | Line 13: `import { ..., moveDocument } from '../../lib/relay-api'`; line 171: `await moveDocument(moveTarget.docId, moveNewPath, targetFolder)` |
| `relay-api.ts` | `POST /doc/move` | fetch('/api/relay/doc/move') | WIRED | Line 289: `fetch('/api/relay/doc/move', { method: 'POST', ... })`; Vite proxy at `/api/relay` strips prefix and forwards to relay server (vite.config.ts line 87-99) |
| `FileTreeContextMenu.tsx` | `FileTreeContext.tsx` | onMove callback prop | WIRED | `FileTreeNode.tsx` line 60-64: `handleMove` calls `ctx.onRequestMove?.(node.data.path, node.data.docId)`; `FileTreeContextMenu` receives `onMove={handleMove}` at line 209 |

### Requirements Coverage

| Requirement | Status | Notes |
|-------------|--------|-------|
| UI-04: Users can move files in lens-editor via context menu | SATISFIED | Full implementation verified: context menu -> dialog -> API call -> Y.js propagation |
| UI-05: AI assistants can relocate documents via MCP with automatic backlink rewriting | SATISFIED | Full implementation verified: move_document tool -> link_indexer::move_document -> links_rewritten count |

### Anti-Patterns Found

No blockers or stubs found. All `placeholder` occurrences in Sidebar.tsx are HTML `placeholder=""` attributes on input elements, not stub code.

### Human Verification Required

#### 1. File Tree Move UI

**Test:** Start the dev server against local relay, right-click a file in the file tree, select "Move to...", enter a new path, click Move
**Expected:** Dialog pre-populates with current path; successful move closes dialog; file tree shows file at new location (Y.js propagation from server-side filemeta_v0 update)
**Why human:** Visual rendering of context menu and dialog, and Y.js propagation behavior cannot be verified programmatically

#### 2. MCP move_document End-to-End

**Test:** With relay server running and MCP_API_KEY set, call `initialize`, `notifications/initialized`, then `tools/call` with `move_document` tool
**Expected:** Response contains old path, new path, and links_rewritten count in the format `"Moved {folder}{old} -> {folder}{new} ({n} links rewritten)"`
**Why human:** End-to-end MCP over HTTP requires a running server; cargo test covers the tool registration and dispatch logic but not live HTTP integration

### Gaps Summary

No gaps. All 8 observable truths are verified. Both delivery surfaces (MCP tool and file tree UI) are substantively implemented and fully wired. The complete pipeline is confirmed:

- MCP surface: `move_document` tool registered as 7th tool, resolves path -> UUID, calls `link_indexer::move_document`, updates search index, returns confirmation with links_rewritten count
- UI surface: Context menu "Move to..." for files, Radix Dialog with path input and conditional folder selector, `moveDocument()` API function calling `POST /api/relay/doc/move` through the Vite proxy

All 312 Rust tests pass (including `tools_list_returns_seven_tools`). TypeScript compiles without errors.

---

_Verified: 2026-02-20T15:56:21Z_
_Verifier: Claude (gsd-verifier)_
