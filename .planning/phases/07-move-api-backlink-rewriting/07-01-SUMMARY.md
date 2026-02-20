---
phase: 07-move-api-backlink-rewriting
plan: 01
subsystem: api
tags: [yrs, crdt, backlinks, wikilinks, filemeta, move, document-resolver]

# Dependency graph
requires:
  - phase: 06-generic-index-updates
    provides: "upsert_doc, remove_doc, remove_doc_from_backlinks CRUD operations"
  - phase: 03-mcp-read-only-tools
    provides: "DocumentResolver, link_indexer, link_parser modules"
provides:
  - "move_document() core function for within-folder and cross-folder moves"
  - "MoveResult struct for move operation reporting"
  - "extract_filemeta_fields helper for reading metadata from YMap and Any::Map"
affects: [07-02-move-http-endpoint, 08-move-ui]

# Tech tracking
tech-stack:
  added: []
  patterns: ["Bare Y.Doc operations for testability without DocWithSyncKv/async"]

key-files:
  created: []
  modified:
    - crates/y-sweet-core/src/link_indexer.rs

key-decisions:
  - "move_document uses std::ptr::eq for same-folder detection (pointer equality of source/target Doc refs)"
  - "extract_filemeta_fields copies metadata as Any::Map for reinsertion, preserving all fields"
  - "Virtual tree patched to OLD paths before backlink resolution (same pattern as apply_rename_updates)"
  - "SearchIndex updates intentionally excluded from move_document (caller/HTTP handler responsibility)"

patterns-established:
  - "Bare Y.Doc function signature for move operations: accepts folder docs + resolver, returns MoveResult"
  - "Reuse build_virtual_entries + update_wikilinks_in_doc_resolved for move-triggered wikilink rewriting"

# Metrics
duration: 4min
completed: 2026-02-20
---

# Phase 7 Plan 1: move_document Core Function Summary

**Core move_document() function with filemeta path swap, DocumentResolver cascade, and resolution-aware wikilink rewriting in backlinker documents**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-20T12:29:54Z
- **Completed:** 2026-02-20T12:34:00Z
- **Tasks:** 2 (TDD RED + GREEN)
- **Files modified:** 1

## Accomplishments
- Implemented `move_document()` operating on bare Y.Docs for full testability
- Within-folder moves: single-transaction filemeta path key swap with metadata preservation
- Cross-folder moves: remove from source filemeta, insert into target filemeta
- Automatic wikilink rewriting in backlinker documents using resolution-aware disambiguation
- Re-indexes moved document's own backlinks at new location
- All 312 tests pass (306 existing + 6 new)

## Task Commits

Each task was committed atomically:

1. **RED: Failing tests** - `6f0e62c` (test) - 6 tests for move_document, stub returning error
2. **GREEN: Implementation** - `4f228cb` (feat) - Full move_document implementation passing all tests

**Plan metadata:** (pending docs commit)

## Files Created/Modified
- `crates/y-sweet-core/src/link_indexer.rs` - Added `MoveResult` struct, `move_document()` pub function, `extract_filemeta_fields()` helper, 6 tests in `move_document_tests` module

## Decisions Made
- Used `std::ptr::eq` for same-folder detection rather than comparing folder names (pointer equality is unambiguous)
- Metadata fields extracted as `HashMap<String, Any>` and reinserted as `Any::Map` to preserve all fields (id, type, version) during path key swap
- Virtual tree is patched with OLD paths before backlink resolution, matching the pattern established in `apply_rename_updates`
- SearchIndex updates excluded from `move_document` scope -- the HTTP endpoint (plan 07-02) will handle that since it has access to content doc text

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `move_document()` is ready to be called from the HTTP endpoint in plan 07-02
- Function signature accepts all needed context (folder docs, resolver, content docs)
- HTTP handler will need to: resolve folder doc_ids, load content docs, call move_document, update SearchIndex

## Self-Check: PASSED

- FOUND: crates/y-sweet-core/src/link_indexer.rs
- FOUND: .planning/phases/07-move-api-backlink-rewriting/07-01-SUMMARY.md
- FOUND: commit 6f0e62c (test RED)
- FOUND: commit 4f228cb (feat GREEN)
- FOUND: pub fn move_document (1 occurrence)
- FOUND: pub struct MoveResult (1 occurrence)

---
*Phase: 07-move-api-backlink-rewriting*
*Completed: 2026-02-20*
