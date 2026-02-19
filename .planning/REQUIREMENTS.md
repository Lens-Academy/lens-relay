# Requirements: Lens Relay v1.1

**Defined:** 2026-02-19
**Core Value:** AI assistants can find and work with the right documents across the knowledge base

## v1.1 Requirements

Requirements for v1.1 File Move & Backlink Updates. Each maps to roadmap phases.

### File Operations

- [ ] **MOVE-01**: User can move a document to a different path within the same folder
- [ ] **MOVE-02**: User can move a document from one folder to another (Lens ↔ Lens Edu)
- [ ] **MOVE-03**: Active editors remain connected during a move (UUID-based connections unaffected)

### Backlink Updates

- [ ] **LINK-01**: All wikilinks pointing to a moved document are automatically rewritten to the new path
- [ ] **LINK-02**: Search index provides generic, idempotent update functions that handle moves, renames, and other document CRUD operations
- [ ] **LINK-03**: DocumentResolver provides generic, idempotent update functions for path-UUID mapping changes (not move-specific)
- [ ] **LINK-04**: Link index provides generic, self-healing update functions for wikilink target changes across all CRUD operations

### User Interfaces

- [ ] **UI-04**: User can move files in the lens-editor file tree (drag-and-drop and/or context menu, based on implementation complexity)
- [ ] **UI-05**: AI assistants can move documents via a new MCP move tool

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Advanced File Operations

- **MOVE-04**: User can move multiple documents at once (batch move)
- **MOVE-05**: User can undo a file move within a time window

## Out of Scope

| Feature | Reason |
|---------|--------|
| Directory/folder creation | Folders are fixed (Lens, Lens Edu); subfolder structure is path-based |
| File copy/duplicate | Different operation semantics; defer |
| Move history/audit log | Adds complexity; defer |
| Conflict resolution for concurrent moves | UUID-based connections make this a non-issue |
| Drag-and-drop between folders in UI | Cross-folder moves use a dialog/picker, not drag between trees |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| MOVE-01 | — | Pending |
| MOVE-02 | — | Pending |
| MOVE-03 | — | Pending |
| LINK-01 | — | Pending |
| LINK-02 | — | Pending |
| LINK-03 | — | Pending |
| LINK-04 | — | Pending |
| UI-04 | — | Pending |
| UI-05 | — | Pending |

**Coverage:**
- v1.1 requirements: 9 total
- Mapped to phases: 0
- Unmapped: 9

---
*Requirements defined: 2026-02-19*
*Last updated: 2026-02-19 after initial definition*
