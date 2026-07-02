# Suggestions Index

## Problem

`GET /suggestions?folder_id=...` loads **every** content doc in the folder
sequentially (`ensure_doc_loaded` per doc, cold docs from R2) just to scan for
CriticMarkup. Lens Edu has ~1,400 docs; a cold scan takes minutes, spikes
memory on the 4 GB prod box, and preceded the 2026-07-02 relay hang
(mass doc load at 08:41–42 UTC, `/ready` timeouts from 08:44, watchdog
restart 08:46:57). The `/review` page in lens-editor blocks on this endpoint
with no timeout.

## Design

Maintain an incremental in-memory index, mirroring the existing search-index
pattern (`startup_reindex` + debounced search worker):

- `y_sweet_core::suggestions_index::SuggestionsIndex` — a
  `DashMap<doc_uuid, Vec<Suggestion>>` holding only docs with non-empty
  suggestions. `update()` with an empty vec removes the entry.
- **Startup:** `startup_reindex` already loads all docs; scan each content
  doc's `contents` text with `critic_scanner::scan_suggestions` and populate
  the index. Set `suggestions_ready` when done.
- **Incremental:** `search_handle_content_update` (called by the search worker
  for every debounced content-doc update) also rescans and updates the index.
  Staleness is bounded by the search debounce (seconds).
- **Query:** `handle_suggestions` loads only the folder doc, reads
  `filemeta_v0`, and looks up each UUID in the index. Zero content-doc loads.
  Deleted docs disappear naturally: response only includes UUIDs present in
  filemeta. Before `suggestions_ready`, return 503 (boot window, ~1–2 min).

## Trade-offs

- Suggestions index rides the search worker: if `SearchIndex` creation fails
  (error-logged, rare), incremental updates stop and the index is
  startup-frozen — same degradation mode as search itself.
- Docs never GC'd from the index while alive in filemeta; memory is bounded
  by docs-with-suggestions (small).

## Frontend (lens-editor)

`useSuggestions`: fetch folders in parallel (`Promise.all`), 30 s
`AbortSignal.timeout` per request, keep partial results and surface
per-folder errors instead of spinning forever.
