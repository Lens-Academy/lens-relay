---
phase: 07-move-api-backlink-rewriting
verified: 2026-02-20T13:05:22Z
status: passed
score: 4/4 must-haves verified
---

# Phase 7: Move API + Backlink Rewriting Verification Report

**Phase Goal:** Users can move documents within and across folders via a server API, with all wikilinks in other documents automatically rewritten to point to the new path
**Verified:** 2026-02-20T13:05:22Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A document moved to a new path within the same folder is accessible at the new path, and the old path no longer resolves | VERIFIED | `move_within_folder_updates_filemeta_path` and `move_preserves_uuid_in_resolver` tests confirm: old filemeta key removed, new key inserted with same UUID, DocumentResolver resolves new path and rejects old |
| 2 | A document moved from Lens to Lens Edu (or vice versa) appears in the target folder's filemeta and is removed from the source | VERIFIED | `move_cross_folder_updates_filemeta_in_both` test confirms: source filemeta entry absent, target filemeta entry present with preserved UUID; HTTP handler routes source→target folder docs correctly |
| 3 | All wikilinks in other documents that pointed to the moved document's old path are rewritten to the new path | VERIFIED | `move_within_folder_rename_rewrites_backlinks` and `move_rename_preserves_anchors_and_aliases` tests confirm: backlink index consulted, `update_wikilinks_in_doc_resolved` called per backlinker, anchors (#Section) and aliases (\|Display) preserved |
| 4 | An editor with the document open before the move remains connected and can continue editing without interruption | VERIFIED | WebSocket connections are keyed by `doc_id` = `relay_id + uuid`; `move_document` only modifies filemeta path keys, never the UUID or the content doc itself; connection continuity is structural |

**Score:** 4/4 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `crates/y-sweet-core/src/link_indexer.rs` | `move_document()` core function + `MoveResult` struct | VERIFIED | `pub fn move_document` at line 483, `pub struct MoveResult` at line 458; 665 lines of implementation including `extract_filemeta_fields` helper |
| `crates/relay/src/server.rs` | `handle_move_document` handler + route registration | VERIFIED | `async fn handle_move_document` at line 2144; `MoveDocRequest`/`MoveDocResponse` structs at lines 180-193; route registered at line 1477 |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `move_document` | `filemeta_v0` Y.Map | `transact_mut_with("link-indexer")` to remove old path key and insert new | WIRED | Lines 519-537: within-folder single-transaction swap; cross-folder remove-from-source + insert-to-target |
| `move_document` | `update_wikilinks_in_doc_resolved` | backlink lookup + per-backlinker wikilink rewriting | WIRED | Lines 607-648: reads `backlinks_v0` for UUID, calls `update_wikilinks_in_doc_resolved` with old/new basename and virtual tree context |
| `move_document` | `DocumentResolver::upsert_doc` | index cascade after filemeta update | WIRED | Line 572: `doc_resolver.upsert_doc(uuid, &new_full_path, doc_info)` |
| `handle_move_document` | `link_indexer::move_document` | unwraps DocWithSyncKv via awareness write locks, calls core function | WIRED | Lines 2373-2384: all folder and content docs unwrapped into bare `&yrs::Doc` refs inside sync block, then `link_indexer::move_document` called |
| `routes()` | `handle_move_document` | axum `.route()` registration | WIRED | Line 1477: `.route("/doc/move", post(handle_move_document))` |
| `handle_move_document` | `search_handle_content_update` | search re-index after move | WIRED | Lines 2406-2413: called synchronously for immediate search consistency |

### Requirements Coverage

| Requirement | Status | Notes |
|-------------|--------|-------|
| MOVE-01: Within-folder move | SATISFIED | Tested and implemented; HTTP endpoint accepts `{uuid, new_path}` with no `target_folder` |
| MOVE-02: Cross-folder move (Lens <-> Lens Edu) | SATISFIED | `target_folder` parameter routes to different folder doc; filemeta transferred; tested in `move_cross_folder_updates_filemeta_in_both` |
| MOVE-03: Active editors remain connected | SATISFIED | UUID unchanged by design; WebSocket keyed on `relay_id-uuid` doc_id |
| LINK-01: Wikilinks auto-rewritten on move | SATISFIED | Backlinks read from `backlinks_v0`, `update_wikilinks_in_doc_resolved` called per backlinker; anchors and aliases preserved |

### Anti-Patterns Found

None. No TODO/FIXME/placeholder/unimplemented! markers found in the implementation files. No empty handlers or stub returns.

### Human Verification Required

#### 1. Live within-folder move via curl

**Test:** Start relay server with `npm run relay:setup`, then POST to `/doc/move` with a real UUID from search results and a new path within the same folder.
**Expected:** 200 response with old_path/new_path/folder info; subsequent search shows updated path; document still loads in editor.
**Why human:** Requires a running relay server with real data to verify the full persistence pipeline (persist + on_document_update trigger).

#### 2. Live cross-folder move (Lens to Lens Edu)

**Test:** POST to `/doc/move` with `target_folder: "Lens Edu"` and a UUID from the Lens folder.
**Expected:** Source folder file tree no longer shows document; target folder shows it; search index updated.
**Why human:** Requires two real folder docs loaded in server state; can't verify filemeta transfer across live DashMap without running server.

Note: These human verification items are for production confidence. The automated test suite (312 tests, 6 move-specific) provides strong assurance that the logic is correct.

### Gaps Summary

No gaps. All must-have truths are verified at all three levels (exists, substantive, wired). The full test suite passes (312 tests). The relay binary builds cleanly. The only noted code comment (cross-folder `folder_doc_id` not updated in the core function for cross-folder moves) is mitigated by: (a) the link indexer background worker re-indexes from filemeta after the move, and (b) the field is not used for path resolution or WebSocket routing. This does not block goal achievement.

---

_Verified: 2026-02-20T13:05:22Z_
_Verifier: Claude (gsd-verifier)_
