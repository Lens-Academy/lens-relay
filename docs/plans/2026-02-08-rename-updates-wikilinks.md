# Plan: Rename Updates Wikilinks

## Context

When a document is renamed (e.g., "Foo" -> "Bar"), the client updates `filemeta_v0` metadata but all documents containing `[[Foo]]` still have stale wikilinks. These links break silently. We want the server to automatically update `[[Foo]]` -> `[[Bar]]` in all backlinkers.

## Reference: Y.Doc Map Dumps

Already extracted to `docs/ydoc-map-dumps.md`. Shows all three maps per folder doc:
- `filemeta_v0`: path -> `{ id, type, version }` (folders + files)
- `docs` (legacy): path -> UUID (files only, for Obsidian compat)
- `backlinks_v0`: target_uuid -> [source_uuid, ...] (bare UUIDs, effectively globally unique)

## Approach: Server-Side (Rust Link Indexer)

The server already has the backlinks index and all docs in memory. When it detects a rename in `filemeta_v0`, it uses `backlinks_v0` to find affected docs and updates their content. Works for both lens-editor and Obsidian renames.

```
Folder doc filemeta_v0 changes (path delete + add, same UUID)
  -> LinkIndexer detects rename via cached snapshot comparison
  -> Reads backlinks_v0[renamed_uuid] for list of source docs
  -> For each source doc: find [[OldName]] in Y.Text, replace with [[NewName]]
  -> Existing re-indexing then updates backlinks_v0 entries
```

## Implementation Steps

### Step 1: Position-Aware Wikilink Extraction

**File:** `crates/y-sweet-core/src/link_parser.rs`

Add `extract_wikilink_occurrences()` — like `extract_wikilinks()` but returns byte positions of the page-name portion. Instead of stripping code blocks (which destroys positions), builds a set of excluded byte ranges and skips matches within them.

```rust
pub struct WikilinkOccurrence {
    pub name: String,        // "Foo" from [[Foo#Section|Alias]]
    pub name_start: usize,   // byte offset of page name (after "[[")
    pub name_len: usize,     // byte length of page name
}

pub fn extract_wikilink_occurrences(markdown: &str) -> Vec<WikilinkOccurrence>
```

### Step 2: Compute Rename Edits

**File:** `crates/y-sweet-core/src/link_parser.rs`

Add `compute_wikilink_rename_edits()` — finds all wikilinks matching `old_name` (case-insensitive) and returns text edits to replace the page-name portion. Preserves anchors (`#Section`) and aliases (`|Display`). Returns edits in reverse offset order for safe sequential application.

```rust
pub struct TextEdit {
    pub offset: usize,       // byte offset in source
    pub remove_len: usize,   // bytes to remove
    pub insert_text: String,  // replacement text
}

pub fn compute_wikilink_rename_edits(markdown: &str, old_name: &str, new_name: &str) -> Vec<TextEdit>
```

Tests: simple rename, anchors/aliases preserved, case-insensitive, code blocks skipped, no false matches.

### Step 3: Apply Rename Edits to Y.Text

**File:** `crates/y-sweet-core/src/link_indexer.rs`

Add `update_wikilinks_in_doc()` — reads `getText("contents")`, computes rename edits, applies them in reverse order via Y.Text `remove_range`/`insert` within an `IndexingGuard`.

```rust
pub fn update_wikilinks_in_doc(content_doc: &Doc, old_name: &str, new_name: &str) -> anyhow::Result<usize>
```

Note: yrs uses character offsets (Utf32), regex returns byte offsets. Need `byte_offset_to_char_offset()` helper.

### Step 4: Filemeta Snapshot Cache + Rename Detection

**File:** `crates/y-sweet-core/src/link_indexer.rs`

Add `filemeta_cache: Arc<DashMap<String, HashMap<String, String>>>` to `LinkIndexer` (maps folder_doc_id -> uuid->path). Add `detect_renames()` method that diffs current filemeta state against cache, emitting `RenameEvent` when same UUID has different basename.

```rust
struct RenameEvent { uuid: String, old_name: String, new_name: String }

fn detect_renames(&self, folder_doc_id: &str, folder_doc: &Doc) -> Vec<RenameEvent>
```

First call (no cache entry) just seeds the cache, returns empty.

**Why snapshot cache over Y.Map observer:** We considered attaching `filemeta_v0.observe()` to detect delete+insert directly. However, the snapshot approach is more robust: if a rename arrives as multiple transactions (unlikely but possible), the 2-second debounce ensures both operations have landed before diffing. The observer would need its own buffering/correlation logic, essentially recreating the debounce. Snapshot is simpler and self-contained within the existing worker loop.

### Step 5: Wire Into Worker Loop

**File:** `crates/y-sweet-core/src/link_indexer.rs`

Restructure `run_worker()` to **skip debounce for folder docs** (metadata changes are discrete events, not typing). Check `is_folder_doc()` before the debounce loop:

```rust
let folder_content = is_folder_doc(&doc_id, &docs);
if folder_content.is_none() {
    // Content doc — debounce as before (2s)
    loop { tokio::time::sleep(DEBOUNCE_DURATION).await; ... }
}
// Folder doc — process immediately
```

Then in the `is_folder_doc()` branch, **before** re-queuing content docs:
1. Call `detect_renames()`
2. If renames found, call `apply_rename_updates()` which iterates backlinkers and calls `update_wikilinks_in_doc()` for each

### Step 6: Seed Cache on Startup

**File:** `crates/y-sweet-core/src/link_indexer.rs`

In `reindex_all_backlinks()`, after indexing, iterate all folder docs and call `detect_renames()` to populate the cache. Prevents false renames on first folder doc update.

## Key Files

| File | Changes |
|------|---------|
| `crates/y-sweet-core/src/link_parser.rs` | Add `WikilinkOccurrence`, `extract_wikilink_occurrences()`, `TextEdit`, `compute_wikilink_rename_edits()` + tests |
| `crates/y-sweet-core/src/link_indexer.rs` | Add `filemeta_cache` to `LinkIndexer`, `RenameEvent`, `detect_renames()`, `apply_rename_updates()`, `update_wikilinks_in_doc()`, modify `run_worker()` and `reindex_all_backlinks()` + tests |

No changes needed to `server.rs` or client-side TypeScript.

## Edge Cases

- **Infinite loops:** `IndexingGuard` prevents server's content edits from triggering re-indexing (same pattern as existing backlinks writes)
- **Rapid renames (Foo->Bar->Baz):** Folder docs skip debounce, so each rename is processed individually. The second rename's `detect_renames` diff catches Bar->Baz correctly since the cache was updated after Foo->Bar.
- **Folder moves (same basename):** `detect_renames` only fires when basename changes, not when parent path changes
- **Unloaded docs:** Logged as warning; will have stale links until manually fixed
- **Unicode names:** `byte_offset_to_char_offset()` conversion handles non-ASCII

## Testing Strategy (TDD — tests first at each step)

Follow Red-Green-Refactor. Every test must fail before writing implementation code.

Existing test helpers to reuse (`link_indexer.rs` tests module):
- `create_folder_doc(entries: &[(&str, &str)]) -> Doc` — folder doc with filemeta_v0
- `create_content_doc(markdown: &str) -> Doc` — content doc with Y.Text("contents")
- `read_backlinks(folder_doc: &Doc, target_uuid: &str) -> Vec<String>`

### Step 1 tests: `link_parser.rs` (pure functions, no Y.Doc)

```rust
// extract_wikilink_occurrences — positions of page names
fn returns_byte_positions_of_page_name()
  // "See [[Foo]] here" -> name="Foo", name_start=6, name_len=3

fn positions_with_anchor()
  // "[[Foo#Section]]" -> name="Foo", name_start=2, name_len=3

fn positions_with_alias()
  // "[[Foo|Display]]" -> name="Foo", name_start=2, name_len=3

fn positions_with_anchor_and_alias()
  // "[[Foo#Sec|Display]]" -> name="Foo", name_start=2, name_len=3

fn skips_occurrences_inside_fenced_code()
  // "```\n[[Foo]]\n```\n[[Bar]]" -> only Bar returned

fn skips_occurrences_inside_inline_code()
  // "`[[Foo]]` and [[Bar]]" -> only Bar returned

fn multiple_occurrences_positions()
  // "[[A]] then [[B]]" -> two entries with correct positions
```

### Step 2 tests: `link_parser.rs` (rename edit computation)

```rust
// compute_wikilink_rename_edits — text edits for renaming
fn simple_rename_edit()
  // "See [[Foo]] here", old="Foo", new="Bar"
  // -> 1 edit: offset=6, remove_len=3, insert="Bar"

fn preserves_anchor_in_rename()
  // "[[Foo#Section]]", old="Foo", new="Bar"
  // -> edit replaces only "Foo", result: "[[Bar#Section]]"

fn preserves_alias_in_rename()
  // "[[Foo|Display]]", old="Foo", new="Bar"
  // -> edit replaces only "Foo", result: "[[Bar|Display]]"

fn case_insensitive_rename()
  // "[[foo]] and [[FOO]]", old="Foo", new="Bar"
  // -> 2 edits

fn no_edits_for_non_matching()
  // "[[Other]]", old="Foo", new="Bar" -> 0 edits

fn skips_code_blocks_in_rename()
  // "```\n[[Foo]]\n```\n[[Foo]]", old="Foo", new="Bar"
  // -> 1 edit (only the one outside code block)

fn edits_in_reverse_offset_order()
  // "[[Foo]] and [[Foo]]" -> second edit has higher offset
  // verify edits[0].offset > edits[1].offset (reverse sorted)

fn multiple_rename_with_different_formats()
  // "[[Foo]] and [[Foo#Sec]] and [[Foo|Alias]]"
  // -> 3 edits, each replacing only "Foo"
```

### Step 3 tests: `link_indexer.rs` (Y.Text mutation)

```rust
// update_wikilinks_in_doc — applies rename to Y.Text
fn replaces_simple_wikilink_in_ydoc()
  // doc with "See [[Foo]] here" -> after update: "See [[Bar]] here"

fn replaces_wikilink_with_anchor_in_ydoc()
  // "[[Foo#Section]]" -> "[[Bar#Section]]"

fn replaces_wikilink_with_alias_in_ydoc()
  // "[[Foo|Display]]" -> "[[Bar|Display]]"

fn replaces_multiple_wikilinks_in_ydoc()
  // "[[Foo]] and [[Foo#Sec]]" -> "[[Bar]] and [[Bar#Sec]]"

fn returns_zero_for_no_matches()
  // "[[Other]]", old="Foo" -> returns 0, content unchanged

fn skips_code_blocks_in_ydoc()
  // "```\n[[Foo]]\n```\n[[Foo]]" -> only second replaced
```

### Step 4 tests: `link_indexer.rs` (rename detection)

```rust
// detect_renames — snapshot cache diffing
fn first_call_seeds_cache_returns_empty()
  // Create indexer, call detect_renames once -> empty Vec
  // (no prior cache to diff against)

fn detects_basename_rename()
  // Seed cache with "/Foo.md" -> "uuid-1"
  // Change filemeta to "/Bar.md" -> "uuid-1"
  // detect_renames -> RenameEvent { uuid: "uuid-1", old: "Foo", new: "Bar" }

fn ignores_folder_move_same_basename()
  // Seed: "/Notes/Foo.md" -> "uuid-1"
  // Change: "/Archive/Foo.md" -> "uuid-1"
  // detect_renames -> empty (basename unchanged)

fn detects_multiple_renames()
  // Two files renamed in same transaction

fn ignores_new_files()
  // Add new entry with new UUID -> not a rename

fn ignores_deleted_files()
  // Remove entry -> not a rename (UUID absent from new state)
```

### Step 5-6: Integration-level tests

```rust
// Full rename flow: rename in filemeta -> wikilinks updated in backlinkers
fn rename_updates_wikilinks_in_backlinkers()
  // Setup: folder with Foo and Notes, Notes links to [[Foo]]
  // Index Notes -> backlinks_v0[uuid-foo] = [uuid-notes]
  // Rename Foo -> Bar in filemeta (same UUID, different path)
  // Call detect_renames + apply_rename_updates
  // Assert: Notes content now has [[Bar]] instead of [[Foo]]

fn rename_preserves_anchors_and_aliases_in_backlinkers()
  // Notes has [[Foo#Section]] and [[Foo|Display]]
  // Rename Foo -> Bar
  // Assert: [[Bar#Section]] and [[Bar|Display]]

fn rename_with_no_backlinkers_is_noop()
  // Rename a file with no backlinks -> no errors, no content changes

fn rename_leaves_unrelated_links_untouched()
  // Notes has [[Foo]] and [[Other]]
  // Rename Foo -> Bar
  // Assert: [[Bar]] and [[Other]] (Other unchanged)
```

### Verification after all steps

1. `cargo test -p y-sweet-core` — all existing + new tests pass
2. Manual: start local relay + setup, rename a doc in lens-editor, verify backlinker content updated in real-time
3. `npm run test:integration` — existing backlinks integration tests still pass
