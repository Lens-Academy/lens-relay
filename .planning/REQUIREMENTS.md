# Requirements: Lens Relay Search & MCP

**Defined:** 2026-02-08
**Core Value:** AI assistants can find and work with the right documents across the knowledge base

## v1 Requirements

### Search Index

- [ ] **SRCH-01**: Full-text keyword search across all documents in Lens and Lens Edu folders
- [ ] **SRCH-02**: Search results include relevance ranking (BM25)
- [ ] **SRCH-03**: Search results include text snippets showing matching content
- [ ] **SRCH-04**: Index automatically updates when documents are edited (debounced)
- [ ] **SRCH-05**: Search available via HTTP API endpoint on the relay server
- [ ] **SRCH-06**: Search index uses tantivy with MmapDirectory (memory-safe for 4GB VPS)

### MCP Server

- [ ] **MCP-01**: MCP endpoint mounted on relay server (e.g. `/mcp`), accessible via URL
- [ ] **MCP-02**: Custom Streamable HTTP transport (JSON-RPC over HTTP POST, no rmcp dependency)
- [ ] **MCP-03**: Session management via Mcp-Session-Id header (server-assigned on initialize)
- [ ] **MCP-04**: Read-before-edit enforcement: server tracks which documents each session has read, rejects edits on unread documents
- [ ] **MCP-05**: MCP tool: list all documents with metadata (name, folder, last modified)
- [ ] **MCP-06**: MCP tool: read document content (returns markdown text)
- [ ] **MCP-07**: MCP tool: keyword search across documents (queries shared search index)
- [ ] **MCP-08**: MCP tool: get backlinks and forward links for a document (single-hop)
- [ ] **MCP-09**: MCP tool: edit document via old_string/new_string interface (MCP server wraps in CriticMarkup transparently)

### Search UI

- [ ] **UI-01**: Search bar in lens-editor
- [ ] **UI-02**: Search results list with document names and text snippets
- [ ] **UI-03**: Clicking a search result opens that document in the editor

## v2 Requirements

### Search Enhancements

- **SRCH-V2-01**: Folder-scoped search (Lens only, Lens Edu only, or both)
- **SRCH-V2-02**: Field-scoped search (title vs body vs frontmatter)
- **SRCH-V2-03**: Semantic/vector search with embeddings

### MCP Enhancements

- **MCP-V2-01**: Multi-hop graph traversal (N degrees deep BFS)
- **MCP-V2-02**: Context bundles (fetch document + linked neighbors in one call)
- **MCP-V2-03**: MCP Prompts for common workflows
- **MCP-V2-04**: Discord bot integration
- **MCP-V2-05**: Auth integration (when custom AuthZ ships)

### Search UI Enhancements

- **UI-V2-01**: Search highlighting in document after navigation
- **UI-V2-02**: Search filters (folder, date range)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Semantic/vector search | Adds complexity (embedding model, vector DB); keyword search covers primary use case |
| Direct document writes from MCP | No AuthZ yet; CriticMarkup wrapping provides safety |
| Document creation from MCP | Dangerous without permission model |
| Bulk operations from MCP | Risk of mass changes without review |
| Discord bot integration | Requires separate codebase, defer to future milestone |
| Custom AuthZ / OAuth | Being handled separately |
| rmcp / external MCP SDK | Custom implementation is simpler for 5 tools + gives control over session state |
| Axum 0.7 → 0.8 upgrade | Not needed without rmcp; avoids touching all existing handler signatures |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SRCH-01 | TBD | Pending |
| SRCH-02 | TBD | Pending |
| SRCH-03 | TBD | Pending |
| SRCH-04 | TBD | Pending |
| SRCH-05 | TBD | Pending |
| SRCH-06 | TBD | Pending |
| MCP-01 | TBD | Pending |
| MCP-02 | TBD | Pending |
| MCP-03 | TBD | Pending |
| MCP-04 | TBD | Pending |
| MCP-05 | TBD | Pending |
| MCP-06 | TBD | Pending |
| MCP-07 | TBD | Pending |
| MCP-08 | TBD | Pending |
| MCP-09 | TBD | Pending |
| UI-01 | TBD | Pending |
| UI-02 | TBD | Pending |
| UI-03 | TBD | Pending |

**Coverage:**
- v1 requirements: 18 total
- Mapped to phases: 0
- Unmapped: 18 ⚠️

---
*Requirements defined: 2026-02-08*
*Last updated: 2026-02-08 after discussion on MCP architecture*
