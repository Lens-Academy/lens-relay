# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-08)

**Core value:** AI assistants can find and work with the right documents across the knowledge base
**Current focus:** Phase 3 - MCP Read-Only Tools -- COMPLETE

## Current Position

Phase: 3 of 5 (MCP Read-Only Tools) -- COMPLETE
Plan: 2 of 2 in current phase (done)
Status: Complete
Last activity: 2026-02-10 -- Completed Phase 3 (all MCP read-only tools verified live)

Progress: [######....] 60%

## Performance Metrics

**Velocity:**
- Total plans completed: 6
- Average duration: 11m
- Total execution time: 1.1 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01-search-index | 2/2 | 36m | 18m |
| 02-mcp-transport | 2/2 | 12m | 6m |
| 03-mcp-read-only-tools | 2/2 | 21m | 10.5m |

**Recent Trend:**
- Last 5 plans: 5m, 7m, 6m, 6m, 15m
- Trend: consistent ~6m for focused plans, 15m for integration plans

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- Custom MCP transport (no rmcp) -- avoids Axum upgrade, gives control over session state
- Search index uses tantivy with MmapDirectory -- memory-safe for 4GB VPS
- MCP endpoint embedded in relay server (/mcp) -- direct access to Y.Docs and search index
- Parse JSON-RPC Request vs Notification by id field presence (not serde untagged)
- Always negotiate MCP protocol version 2025-03-26
- Require initialized session only for tools/call, not ping or tools/list
- HTTP 400 for missing session ID, HTTP 404 for unknown session ID (MCP spec)
- JSON parse errors return HTTP 200 with JSON-RPC error body (protocol-level, not transport-level)
- Test DocumentResolver against bare Y.Docs to avoid DocWithSyncKv async dependency
- Dual update API: update_folder (server) + update_folder_from_doc (testable)
- derive_folder_name centralizes folder naming convention
- Lazy resolver rebuild on first tool call for in-memory mode
- Router dispatch_request takes &Arc<Server> for tool access to docs/resolver
- Forward links resolved via case-insensitive basename matching

### Pending Todos

None.

### Blockers/Concerns

None.

## Session Continuity

Last session: 2026-02-10 13:00 UTC
Stopped at: Completed Phase 3 (MCP Read-Only Tools) - all tools verified live via MCP Inspector
Resume file: None
