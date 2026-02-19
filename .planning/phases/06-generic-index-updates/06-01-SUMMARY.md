---
phase: 06-generic-index-updates
plan: 01
subsystem: api
tags: [dashmap, tantivy, yrs, crdt, backlinks, idempotent]

# Dependency graph
requires:
  - phase: 03-mcp-read-only-tools
    provides: "DocumentResolver, SearchIndex, link_indexer modules"
provides:
  - "DocumentResolver.upsert_doc and remove_doc for single-doc CRUD"
  - "SearchIndex idempotency proof (add_document_twice, remove_nonexistent)"
  - "remove_doc_from_backlinks function for document deletion cleanup"
affects: [07-move-api, 08-move-ui]

# Tech tracking
tech-stack:
  added: []
  patterns: ["Idempotent single-doc CRUD on all three index types"]

key-files:
  created: []
  modified:
    - crates/y-sweet-core/src/doc_resolver.rs
    - crates/y-sweet-core/src/search_index.rs
    - crates/y-sweet-core/src/link_indexer.rs

key-decisions:
  - "upsert_doc handles old-path cleanup internally rather than requiring caller to pass old path"
  - "remove_doc_from_backlinks returns count of modified arrays for observability"

patterns-established:
  - "Idempotent CRUD: all index operations safe to call multiple times with same inputs"
  - "Single-doc operations: upsert_doc/remove_doc avoid full-folder rebuild for individual changes"

# Metrics
duration: 3min
completed: 2026-02-19
---

# Phase 6 Plan 1: Generic Index Updates Summary

**Idempotent single-document CRUD operations on DocumentResolver (upsert/remove), SearchIndex (idempotency proof), and link index (backlink cleanup for deleted docs)**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-19T20:51:06Z
- **Completed:** 2026-02-19T20:54:26Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- DocumentResolver gains upsert_doc and remove_doc for O(1) single-document updates without full-folder rebuild
- SearchIndex idempotency explicitly proven with 2 edge-case tests (remove nonexistent, add duplicate)
- Link index gains remove_doc_from_backlinks to clean up all backlink references when a document is deleted
- All three indexes now have complete, tested CRUD: create/update (idempotent upsert), delete (idempotent remove)

## Task Commits

Each task was committed atomically:

1. **Task 1: DocumentResolver single-doc CRUD methods** - `97faa40` (feat)
2. **Task 2: SearchIndex idempotency tests + remove_doc_from_backlinks** - `dc85fbc` (feat)

**Plan metadata:** (this commit) (docs: complete plan)

## Files Created/Modified
- `crates/y-sweet-core/src/doc_resolver.rs` - Added upsert_doc and remove_doc methods with 6 new tests
- `crates/y-sweet-core/src/search_index.rs` - Added 2 idempotency edge-case tests
- `crates/y-sweet-core/src/link_indexer.rs` - Added remove_doc_from_backlinks function with 4 new tests

## Decisions Made
- upsert_doc handles old-path cleanup internally: it looks up the existing path for a UUID and removes it if different from the new path, so callers don't need to track the old path
- remove_doc_from_backlinks returns a count of modified arrays rather than void, enabling callers to log/observe changes

## Deviations from Plan

None - plan executed exactly as written.

Note: Plan said 11 existing doc_resolver tests, actual count was 13. This did not affect execution.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All three index types now have idempotent single-document CRUD operations
- Phase 7 (Move API) can call upsert_doc for path changes, remove_doc for deletions, and remove_doc_from_backlinks for backlink cleanup
- Full test suite passes: 306 tests (12 new across 3 files)

## Self-Check: PASSED

- All 3 source files verified present
- SUMMARY.md verified present
- Commit 97faa40 (Task 1) verified in log
- Commit dc85fbc (Task 2) verified in log

---
*Phase: 06-generic-index-updates*
*Completed: 2026-02-19*
