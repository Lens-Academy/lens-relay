---
phase: 07-move-api-backlink-rewriting
plan: 02
subsystem: api
tags: [axum, http, move, endpoint, filemeta, search-index, dashmap, awareness]

# Dependency graph
requires:
  - phase: 07-move-api-backlink-rewriting
    plan: 01
    provides: "move_document() core function, MoveResult struct"
  - phase: 01-search-index
    provides: "SearchIndex for post-move re-indexing"
  - phase: 06-generic-index-updates
    provides: "search_handle_content_update for synchronous search re-index"
provides:
  - "POST /doc/move HTTP endpoint for within-folder and cross-folder document moves"
  - "MoveDocRequest/MoveDocResponse JSON types"
  - "Full pipeline: path validation, UUID lookup, conflict check, move, persist, search update"
affects: [08-move-ui]

# Tech tracking
tech-stack:
  added: []
  patterns: ["Sync block isolation for DashMap+awareness guards to keep handler future Send"]

key-files:
  created: []
  modified:
    - crates/relay/src/server.rs

key-decisions:
  - "All synchronous work (DashMap refs, awareness write locks, move_document call) isolated in a non-async block to keep the handler future Send"
  - "Persist folder and content docs after move to ensure durability"
  - "Trigger link indexer on_document_update for both source and target folder docs"
  - "Search index updated synchronously via search_handle_content_update (not waiting for background worker)"

patterns-established:
  - "Sync block pattern: wrap DashMap + awareness guard acquisition in a block that returns only Send-safe values before .await"
  - "Error status mapping: 400 (validation), 404 (not found), 409 (conflict), 500 (internal)"

# Metrics
duration: 7min
completed: 2026-02-20
---

# Phase 7 Plan 2: POST /doc/move HTTP Endpoint Summary

**POST /doc/move endpoint wiring move_document core into HTTP with path validation, conflict detection, persistence, and search index update**

## Performance

- **Duration:** 7 min (execution) + 15 min (checkpoint verification)
- **Started:** 2026-02-20T12:37:13Z
- **Completed:** 2026-02-20T12:59:00Z
- **Tasks:** 2 (1 auto + 1 checkpoint)
- **Files modified:** 1

## Accomplishments
- POST /doc/move endpoint accepts JSON `{uuid, new_path, target_folder?}` and returns `{old_path, new_path, old_folder, new_folder, links_rewritten}`
- Within-folder moves, cross-folder moves, and renames all verified via curl
- Error cases return proper HTTP status codes: 400 (bad path format, unknown target folder), 404 (UUID not found), 409 (path already exists)
- Search index updated synchronously after move; link indexer notified for background cache refresh
- All 312 existing tests pass (no regressions)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add POST /doc/move endpoint** - `0544337` (feat) - handler, types, route registration
2. **Task 2: Verify move endpoint with live server** - checkpoint (human-verified)

**Plan metadata:** (pending docs commit)

## Files Created/Modified
- `crates/relay/src/server.rs` - Added `MoveDocRequest`/`MoveDocResponse` structs, `handle_move_document` async handler, route `/doc/move` registration; added `Serialize` and `Array` to imports

## Decisions Made
- Isolated all DashMap guard and awareness lock acquisition inside a synchronous block to avoid non-Send futures crossing .await points (axum Handler trait requirement)
- Persists both folder docs and content docs (backlinkers with rewritten wikilinks) after move
- Calls `search_handle_content_update` synchronously for immediate search index consistency, plus `on_document_update` for background link indexer cache refresh
- Content UUID collection scans both filemeta_v0 (all docs) and backlinks_v0 (backlinkers of moved UUID) to ensure all potentially-mutated content docs get write locks

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added `Array` trait import for yrs**
- **Found during:** Task 1 (compilation)
- **Issue:** `ArrayRef::iter()` requires `yrs::Array` trait in scope
- **Fix:** Added `Array` to the `use yrs::{...}` import
- **Files modified:** crates/relay/src/server.rs
- **Verification:** Build succeeds

**2. [Rule 1 - Bug] Restructured handler to isolate non-Send guards**
- **Found during:** Task 1 (compilation)
- **Issue:** DashMap `Ref` guards held across `.await` points made handler future non-Send, failing axum's `Handler` trait bound
- **Fix:** Wrapped all DashMap access and awareness lock acquisition in a synchronous block that returns only Send-safe values (MoveResult, Arc<SyncKv>, Strings)
- **Files modified:** crates/relay/src/server.rs
- **Verification:** Build succeeds, handler compiles as valid axum Handler

---

**Total deviations:** 2 auto-fixed (1 blocking import, 1 bug/Send-safety)
**Impact on plan:** Both fixes required for compilation. No scope creep.

## Issues Encountered

None beyond the auto-fixed compilation issues above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- POST /doc/move is ready to be called from lens-editor UI (phase 08)
- MCP move_document tool can also call this endpoint
- The endpoint is unauthenticated (same as search) -- add auth when needed for production

## Self-Check: PASSED

- FOUND: crates/relay/src/server.rs
- FOUND: .planning/phases/07-move-api-backlink-rewriting/07-02-SUMMARY.md
- FOUND: commit 0544337 (feat: add POST /doc/move endpoint)
- FOUND: handle_move_document (1 occurrence in route registration)
- FOUND: MoveDocRequest (1 struct definition)
- FOUND: MoveDocResponse (1 struct definition)

---
*Phase: 07-move-api-backlink-rewriting*
*Completed: 2026-02-20*
