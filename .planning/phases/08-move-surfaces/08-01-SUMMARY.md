---
phase: 08-move-surfaces
plan: 01
subsystem: api
tags: [rust, mcp, move, wikilinks]

requires:
  - phase: 07-move-api-backlink-rewriting
    provides: move_document core function and POST /doc/move endpoint
provides:
  - MCP move_document tool (7th tool) for AI assistants
affects: []

tech-stack:
  added: []
  patterns: [sync block pattern for MCP tool matching HTTP handler]

key-files:
  created:
    - crates/relay/src/mcp/tools/move_doc.rs
  modified:
    - crates/relay/src/mcp/tools/mod.rs
    - crates/relay/src/mcp/router.rs
    - crates/relay/src/server.rs

key-decisions:
  - "Replicated sync block pattern from HTTP handler for consistency even though MCP dispatch is already sync"
  - "Made search_handle_content_update pub(crate) for MCP access"
  - "Added Server::search_index() accessor for MCP tool"

patterns-established:
  - "MCP tool pattern: resolve path → sync block with guards → call core function → update search index"

duration: 5min
completed: 2026-02-20
---

# Plan 08-01: MCP move_document Tool Summary

**MCP move_document tool enabling AI assistants to relocate documents with automatic backlink rewriting**

## Performance

- **Duration:** 5 min
- **Completed:** 2026-02-20
- **Tasks:** 2 (1 auto + 1 checkpoint)
- **Files modified:** 4

## Accomplishments
- MCP move_document tool registered as 7th tool alongside read/glob/grep/edit/get_links/create_session
- Within-folder moves, cross-folder moves, and error cases all handled
- Search index updated synchronously after move
- Tool count test updated from 6 to 7

## Task Commits

1. **Task 1: Implement MCP move_document tool** - `f3afb67` (feat)
2. **Task 2: Verify MCP move_document tool** - verified via curl (within-folder, cross-folder, error cases)

## Files Created/Modified
- `crates/relay/src/mcp/tools/move_doc.rs` - MCP move_document tool implementation
- `crates/relay/src/mcp/tools/mod.rs` - Tool definition and dispatch entry
- `crates/relay/src/mcp/router.rs` - Updated tool count test (6→7)
- `crates/relay/src/server.rs` - Made search_handle_content_update pub(crate), added search_index() accessor

## Decisions Made
- Replicated sync block pattern from HTTP handler for consistency
- Made search_handle_content_update pub(crate) for MCP access
- Added Server::search_index() accessor

## Deviations from Plan
None - plan executed as written.

## Issues Encountered
- Cosmetic double-slash in output formatting (paths stored with leading `/`), fixed by removing extra `/` in format string

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- MCP tool complete, ready for milestone completion

---
*Phase: 08-move-surfaces*
*Completed: 2026-02-20*
