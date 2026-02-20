# Roadmap: Lens Relay Search & MCP

## Milestones

- v1.0 Search & MCP MVP - Phases 1-5 (shipped 2026-02-11)
- v1.1 File Move & Backlink Updates - Phases 6-8 (in progress)

## Phases

<details>
<summary>v1.0 Search & MCP MVP (Phases 1-5) - SHIPPED 2026-02-11</summary>

See `.planning/milestones/v1.0-ROADMAP.md` for full details.

- [x] **Phase 1: Search Index** - tantivy BM25 search with HTTP API (2 plans)
- [x] **Phase 2: MCP Transport** - Streamable HTTP JSON-RPC with session tracking (2 plans)
- [x] **Phase 3: MCP Read-Only Tools** - DocumentResolver + read/glob/get_links tools (2 plans)
- [x] **Phase 4: MCP Search & Edit Tools** - grep + CriticMarkup edit with read-before-edit (2 plans)
- [x] **Phase 5: Search UI** - lens-editor search panel with debounced hook (2 plans)

</details>

### v1.1 File Move & Backlink Updates (In Progress)

**Milestone Goal:** Users and AI assistants can move documents between and within folders, with automatic backlink rewriting.

**Phase Numbering:**
- Integer phases (6, 7, 8): Planned milestone work
- Decimal phases (6.1, 7.1): Urgent insertions if needed (marked INSERTED)

- [x] **Phase 6: Generic Index Updates** - Idempotent CRUD update functions for all three indexes
- [x] **Phase 7: Move API & Backlink Rewriting** - Server-side move operation with automatic wikilink rewriting
- [ ] **Phase 8: Move Surfaces** - lens-editor file tree UI and MCP move tool

## Phase Details

### Phase 6: Generic Index Updates
**Goal**: All three indexes (search, DocumentResolver, link index) handle document CRUD operations through generic, idempotent update functions -- not move-specific, but reusable for any document lifecycle event
**Depends on**: Phase 5 (v1.0 complete)
**Requirements**: LINK-02, LINK-03, LINK-04
**Success Criteria** (what must be TRUE):
  1. Calling the search index update function with a document's new metadata re-indexes it correctly, and calling it again with the same data is a no-op
  2. Calling the DocumentResolver update function with a changed path-UUID mapping reflects the new path in lookups, and calling it again with the same data is a no-op
  3. Calling the link index update function after a document's wikilink targets change updates backlink maps correctly, and stale entries self-heal on next update
  4. All three update functions work for creates, deletes, path changes, and content changes -- not just moves
**Plans**: 1 plan

Plans:
- [x] 06-01: DocumentResolver single-doc CRUD + SearchIndex idempotency tests + link index remove_doc_from_backlinks (TDD)

### Phase 7: Move API & Backlink Rewriting
**Goal**: Users can move documents within and across folders via a server API, with all wikilinks in other documents automatically rewritten to point to the new path
**Depends on**: Phase 6
**Requirements**: MOVE-01, MOVE-02, MOVE-03, LINK-01
**Success Criteria** (what must be TRUE):
  1. A document moved to a new path within the same folder is accessible at the new path, and the old path no longer resolves
  2. A document moved from Lens to Lens Edu (or vice versa) appears in the target folder's file tree and is removed from the source folder
  3. All wikilinks in other documents that pointed to the moved document's old path are rewritten to the new path
  4. An editor with the document open before the move remains connected and can continue editing without interruption
**Plans**: 2 plans

Plans:
- [x] 07-01: Core move_document function with TDD (filemeta_v0 update + index cascade + backlink rewriting)
- [x] 07-02: POST /doc/move HTTP endpoint + live verification

### Phase 8: Move Surfaces
**Goal**: Users can move files through the lens-editor UI, and AI assistants can move files via MCP -- both backed by the move API
**Depends on**: Phase 7
**Requirements**: UI-04, UI-05
**Success Criteria** (what must be TRUE):
  1. User can move a file in the lens-editor file tree via drag-and-drop or context menu, and the tree updates to reflect the new location
  2. AI assistant can call the MCP move tool to relocate a document and receives confirmation of the new path
  3. After a move via either surface, wikilinks in other documents are rewritten (the full pipeline works end-to-end)
**Plans**: 2 plans

Plans:
- [ ] 08-01-PLAN.md -- MCP move_document tool (Rust: tool definition, dispatch, core move call)
- [ ] 08-02-PLAN.md -- lens-editor file tree move UI (TypeScript: context menu, dialog, API call)

## Progress

**Execution Order:**
Phases execute in numeric order: 6 -> 7 -> 8

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Search Index | v1.0 | 2/2 | Complete | 2026-02-09 |
| 2. MCP Transport | v1.0 | 2/2 | Complete | 2026-02-09 |
| 3. MCP Read-Only Tools | v1.0 | 2/2 | Complete | 2026-02-10 |
| 4. MCP Search & Edit Tools | v1.0 | 2/2 | Complete | 2026-02-11 |
| 5. Search UI | v1.0 | 2/2 | Complete | 2026-02-11 |
| 6. Generic Index Updates | v1.1 | 1/1 | Complete | 2026-02-19 |
| 7. Move API & Backlink Rewriting | v1.1 | 2/2 | Complete | 2026-02-20 |
| 8. Move Surfaces | v1.1 | 0/2 | Not started | - |
