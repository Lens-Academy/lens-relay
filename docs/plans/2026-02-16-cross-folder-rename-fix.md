# Cross-Folder Rename Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make 7 failing cross-folder rename tests pass by adding resolution-aware wikilink rename logic.

**Architecture:** Two-layer fix. (1) In `link_parser.rs`, make `compute_wikilink_rename_edits` handle path-qualified links by matching basenames and replacing only the basename portion. (2) In `link_indexer.rs`, make `update_wikilinks_in_doc` and `apply_renames_to_doc` resolution-aware: for each wikilink in a backlinker, resolve it against the virtual tree to confirm it points to the renamed file before editing. Reuses existing `resolve_in_virtual_tree`, `build_virtual_entries`, and `resolve_relative`.

**Tech Stack:** Rust, yrs, existing link_parser + link_indexer modules

**Failing tests (7 total):**
- `link_parser::tests::rename_edits_match_path_qualified_wikilink` (Bug 1)
- `cross_folder_rename_tests::cross_folder_rename_updates_path_qualified_link` (Bug 1)
- `cross_folder_rename_tests::cross_folder_rename_preserves_anchor` (Bug 1)
- `cross_folder_rename_tests::cross_folder_rename_preserves_alias` (Bug 1)
- `cross_folder_rename_tests::rename_same_name_only_updates_correct_links` (Bug 2)
- `cross_folder_rename_tests::rename_same_name_from_other_folder_perspective` (Bug 2)
- `cross_folder_rename_tests::cross_folder_rename_updates_relative_path_link` (Bug 1)

**Passing tests that must stay green (5):**
- `cross_folder_rename_tests::same_name_bare_link_resolves_within_own_folder`
- `cross_folder_rename_tests::same_name_cross_folder_explicit_link`
- `cross_folder_rename_tests::same_name_both_bare_and_cross_folder_links`
- `cross_folder_rename_tests::same_name_other_folder_bare_link`
- `cross_folder_rename_tests::rename_same_name_bare_link_updated_in_own_folder`

---

## Task 1: Fix `compute_wikilink_rename_edits` to handle path-qualified links (Bug 1 — parser layer)

**Files:**
- Modify: `crates/y-sweet-core/src/link_parser.rs` (the `compute_wikilink_rename_edits` function, lines 403-425)

**Context:**
Currently `compute_wikilink_rename_edits` filters occurrences with `occ.name.to_lowercase() == old_lower`. For `[[Relay Folder 2/Foo]]`, `occ.name` is `"Relay Folder 2/Foo"` which doesn't match `"Foo"`. For `[[../Relay Folder 2/Foo]]`, `occ.name` is `"../Relay Folder 2/Foo"`.

The fix: match on **basename** (last `/`-separated component) instead of full name. When matched, replace only the basename portion — adjust `offset` and `remove_len` to target the last segment.

`WikilinkOccurrence` already has `name_start` (byte offset of the content after `[[`) and `name_len` (byte length up to `#`, `|`, or `]]`). For `[[Relay Folder 2/Foo]]`:
- `name_start` = 2, `name_len` = 20 (full "Relay Folder 2/Foo")
- We need to compute the basename offset: `name_start + last_slash_pos + 1` and basename length: `name_len - last_slash_pos - 1`

**Step 1: Implement the fix**

Change `compute_wikilink_rename_edits` from:

```rust
let mut edits: Vec<TextEdit> = occurrences
    .into_iter()
    .filter(|occ| occ.name.to_lowercase() == old_lower)
    .map(|occ| TextEdit {
        offset: occ.name_start,
        remove_len: occ.name_len,
        insert_text: new_name.to_string(),
    })
    .collect();
```

To:

```rust
let mut edits: Vec<TextEdit> = occurrences
    .into_iter()
    .filter_map(|occ| {
        // Extract basename: last component after '/'
        let basename = occ.name.rsplit('/').next().unwrap_or(&occ.name);
        if basename.to_lowercase() != old_lower {
            return None;
        }

        // Compute offset/len targeting only the basename portion
        let basename_offset_in_name = occ.name.len() - basename.len();
        Some(TextEdit {
            offset: occ.name_start + basename_offset_in_name,
            remove_len: basename.len(),
            insert_text: new_name.to_string(),
        })
    })
    .collect();
```

**Step 2: Run the link_parser test to verify it passes**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml -p y-sweet-core --lib -- link_parser::tests -v`

Expected: ALL link_parser tests pass, including `rename_edits_match_path_qualified_wikilink`.

**Step 3: Run the full link_parser + existing rename tests**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml -p y-sweet-core --lib -- "link_parser::tests|rename" -v`

Expected: `rename_edits_match_path_qualified_wikilink` passes. Some cross_folder_rename_tests may now pass too (the Bug 1 ones that only needed basename matching). The Bug 2 tests will still fail (disambiguation requires Task 2).

**Step 4: Commit**

```bash
jj new -m "fix: match path-qualified wikilinks by basename in rename edits"
```

Wait — we're in jj. After making edits, describe the current change:

```bash
jj describe -m "fix: match path-qualified wikilinks by basename in rename edits

compute_wikilink_rename_edits now extracts the basename (last path component)
from each wikilink occurrence for matching, and replaces only the basename
portion in the edit. This fixes [[Folder/Foo]] not being matched when
renaming Foo."
```

---

## Task 2: Make `update_wikilinks_in_doc` resolution-aware (Bug 2 — indexer layer)

**Files:**
- Modify: `crates/y-sweet-core/src/link_indexer.rs` — change `update_wikilinks_in_doc` signature and implementation (lines 429-460)
- Modify: `crates/y-sweet-core/src/link_parser.rs` — add new function `compute_wikilink_rename_edits_resolved`

**Context:**
After Task 1, `compute_wikilink_rename_edits` matches by basename. But it still matches ALL wikilinks with the same basename, regardless of which file they resolve to. For disambiguation (Bug 2), we need to filter: only edit a wikilink if it resolves to the renamed file's old virtual path.

The approach: add a new function `compute_wikilink_rename_edits_resolved` in `link_parser.rs` that takes a resolution callback. For each wikilink occurrence whose basename matches `old_name`, call the callback with the full `occ.name` to check if it resolves to the target. This keeps resolution logic in the caller (link_indexer) while keeping text editing logic in link_parser.

**Step 1: Add `compute_wikilink_rename_edits_resolved` to link_parser.rs**

Add after the existing `compute_wikilink_rename_edits` function (which stays unchanged for backward compat):

```rust
/// Like `compute_wikilink_rename_edits`, but with a resolution filter.
///
/// For each wikilink whose basename matches `old_name` (case-insensitive),
/// calls `should_edit(link_name)` to confirm this link actually points to
/// the renamed file. Only produces edits for links where `should_edit` returns true.
///
/// This enables disambiguation when multiple files share the same basename
/// across folders — only links that resolve to the specific renamed file
/// get updated.
pub fn compute_wikilink_rename_edits_resolved<F>(
    markdown: &str,
    old_name: &str,
    new_name: &str,
    should_edit: F,
) -> Vec<TextEdit>
where
    F: Fn(&str) -> bool,
{
    let occurrences = extract_wikilink_occurrences(markdown);
    let old_lower = old_name.to_lowercase();

    let mut edits: Vec<TextEdit> = occurrences
        .into_iter()
        .filter_map(|occ| {
            // Extract basename: last component after '/'
            let basename = occ.name.rsplit('/').next().unwrap_or(&occ.name);
            if basename.to_lowercase() != old_lower {
                return None;
            }

            // Ask caller if this specific link resolves to the renamed file
            if !should_edit(&occ.name) {
                return None;
            }

            // Compute offset/len targeting only the basename portion
            let basename_offset_in_name = occ.name.len() - basename.len();
            Some(TextEdit {
                offset: occ.name_start + basename_offset_in_name,
                remove_len: basename.len(),
                insert_text: new_name.to_string(),
            })
        })
        .collect();

    // Sort in reverse offset order for safe sequential application
    edits.sort_by(|a, b| b.offset.cmp(&a.offset));

    edits
}
```

**Step 2: Update `update_wikilinks_in_doc` in link_indexer.rs**

Change the signature to accept resolution context:

```rust
pub fn update_wikilinks_in_doc(
    content_doc: &Doc,
    old_name: &str,
    new_name: &str,
    source_virtual_path: Option<&str>,
    entries: &[VirtualEntry],
    old_target_virtual_path: &str,
) -> anyhow::Result<usize> {
```

Update the body to use `compute_wikilink_rename_edits_resolved`:

```rust
    // 1. Read plain text
    let plain_text = {
        let txn = content_doc.transact();
        match txn.get_text("contents") {
            Some(text) => text.get_string(&txn),
            None => return Ok(0),
        }
    };

    let old_target_lower = old_target_virtual_path.to_lowercase();

    // 2. Compute edits with resolution filter
    let edits = compute_wikilink_rename_edits_resolved(
        &plain_text,
        old_name,
        new_name,
        |link_name| {
            // Resolve this link in the virtual tree and check if it matches the renamed file
            resolve_in_virtual_tree(link_name, source_virtual_path, entries)
                .map(|e| e.virtual_path.to_lowercase() == old_target_lower)
                .unwrap_or(false)
        },
    );
    if edits.is_empty() {
        return Ok(0);
    }

    // 3. Apply edits in reverse offset order
    let mut txn = content_doc.transact_mut_with("link-indexer");
    let text = txn.get_or_insert_text("contents");

    for edit in &edits {
        text.remove_range(&mut txn, edit.offset as u32, edit.remove_len as u32);
        text.insert(&mut txn, edit.offset as u32, &edit.insert_text);
    }

    Ok(edits.len())
```

**Step 3: Update `apply_rename_updates` in link_indexer.rs to pass resolution context**

The method at line 602 currently calls `update_wikilinks_in_doc(&guard.doc, &rename.old_name, &rename.new_name)`. It needs to:
1. Build the virtual tree from all folder docs
2. Look up the source doc's virtual path
3. Compute the renamed file's old virtual path: `"/{folder_name}{old_filemeta_path}"`

This requires changing `RenameEvent` to carry the full filemeta path (not just basename), plus the folder name. Update the struct:

```rust
pub(crate) struct RenameEvent {
    pub uuid: String,
    pub old_name: String,       // basename, e.g. "Foo"
    pub new_name: String,       // basename, e.g. "Qux"
    pub old_path: String,       // full filemeta path, e.g. "/Foo.md"
    pub folder_name: String,    // e.g. "Relay Folder 2"
}
```

Update `detect_renames` to populate these new fields. The current code already has the full path (the filemeta key) but discards it in favor of the basename. We need to keep both.

Update `apply_rename_updates` to build virtual entries and pass them through:

In the "for each rename" loop, the key changes:
- Build virtual entries: `let entries = build_virtual_entries(...)` from all loaded folder docs
- Compute old virtual path: `format!("/{}{}", rename.folder_name, rename.old_path.strip_suffix(".md").unwrap_or(&rename.old_path))` — wait, that's wrong. The virtual path format is `"/{folder_name}{filemeta_path}"` where filemeta_path already starts with `/` and ends with `.md`. So: `format!("/{}{}", rename.folder_name, rename.old_path)` gives e.g. `/Relay Folder 2/Foo.md`.
- Find source's virtual path from entries by matching its UUID.

**Step 4: Update the test helper `apply_renames_to_doc`**

The test helper in `cross_folder_rename_tests` must be updated to pass resolution context. It needs access to all folder docs so it can build the virtual tree:

```rust
fn apply_renames_to_doc(
    renames: &[RenameEvent],
    folder_docs: &[&Doc],
    folder_names: &[&str],
    source_uuid: &str,
    content_doc: &Doc,
    rename_folder_doc: &Doc,
) {
    let entries = build_virtual_entries(folder_docs, folder_names);
    let source_virtual_path: Option<String> = entries.iter()
        .find(|e| e.id == source_uuid)
        .map(|e| e.virtual_path.clone());

    for rename in renames {
        let txn = rename_folder_doc.transact();
        if let Some(backlinks) = txn.get_map("backlinks_v0") {
            let source_uuids = read_backlinks_array(&backlinks, &txn, &rename.uuid);
            drop(txn);

            if source_uuids.contains(&source_uuid.to_string()) {
                let old_virtual_path = format!("/{}{}", rename.folder_name, rename.old_path);
                update_wikilinks_in_doc(
                    content_doc,
                    &rename.old_name,
                    &rename.new_name,
                    source_virtual_path.as_deref(),
                    &entries,
                    &old_virtual_path,
                ).unwrap();
            }
        }
    }
}
```

**Step 5: Update all test call sites**

Each test that calls `apply_renames_to_doc` or `update_wikilinks_in_doc` needs the new arguments. There are 6 tests in `cross_folder_rename_tests` that call `apply_renames_to_doc`, plus 2 tests in the main `tests` module that call `update_wikilinks_in_doc` directly (the existing rename tests that currently pass).

For the existing passing tests (`rename_updates_wikilinks_in_doc`, `rename_updates_multiple_links`, etc.) that use `update_wikilinks_in_doc`: pass `None` for `source_virtual_path`, empty slice for `entries`, and an empty string for `old_target_virtual_path`. Since there are no entries, `resolve_in_virtual_tree` will return `None` for every link, and `should_edit` will return `false` — meaning zero edits.

**Wait — that would break existing tests.** We need a different approach: when no resolution context is provided, fall back to the old behavior (match all basenames). Two options:
1. Keep `compute_wikilink_rename_edits` unchanged (no resolution filter) and only use `compute_wikilink_rename_edits_resolved` in the new code path.
2. Make the old `update_wikilinks_in_doc` a thin wrapper that passes a `|_| true` callback.

**Option 2 is cleaner.** Keep the old signature as a convenience wrapper:

```rust
/// Update wikilinks in a Y.Doc — matches all occurrences of old_name (no resolution filter).
/// Use `update_wikilinks_in_doc_resolved` for disambiguation in multi-folder setups.
pub fn update_wikilinks_in_doc(
    content_doc: &Doc,
    old_name: &str,
    new_name: &str,
) -> anyhow::Result<usize> {
    update_wikilinks_in_doc_resolved(content_doc, old_name, new_name, None, &[], "")
}
```

And the new function:

```rust
/// Update wikilinks in a Y.Doc with resolution-based disambiguation.
///
/// For each wikilink whose basename matches `old_name`, resolves it against
/// the virtual tree. Only edits links that resolve to `old_target_virtual_path`.
pub fn update_wikilinks_in_doc_resolved(
    content_doc: &Doc,
    old_name: &str,
    new_name: &str,
    source_virtual_path: Option<&str>,
    entries: &[VirtualEntry],
    old_target_virtual_path: &str,
) -> anyhow::Result<usize> {
    // ... implementation with resolution filter
}
```

When `entries` is empty (old code path), `resolve_in_virtual_tree` returns None for everything. But we want the old behavior to match everything. So the `should_edit` callback should be `|_| true` when no resolution context is given. Check: if `old_target_virtual_path` is empty, skip resolution and match all:

```rust
let edits = if old_target_virtual_path.is_empty() {
    // No resolution context — match all basenames (legacy behavior)
    compute_wikilink_rename_edits(&plain_text, old_name, new_name)
} else {
    // Resolution-aware — only edit links that resolve to the renamed file
    let old_target_lower = old_target_virtual_path.to_lowercase();
    compute_wikilink_rename_edits_resolved(
        &plain_text,
        old_name,
        new_name,
        |link_name| {
            resolve_in_virtual_tree(link_name, source_virtual_path, entries)
                .map(|e| e.virtual_path.to_lowercase() == old_target_lower)
                .unwrap_or(false)
        },
    )
};
```

This keeps all existing tests passing unchanged while adding disambiguation for the new code path.

**Step 6: Run all tests**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml -p y-sweet-core --lib -v`

Expected: All 7 previously-failing tests now pass. All previously-passing tests still pass.

**Step 7: Commit**

```bash
jj describe -m "fix: resolution-aware wikilink rename for cross-folder disambiguation

update_wikilinks_in_doc_resolved resolves each wikilink against the virtual
tree before editing, so only links that actually point to the renamed file
are updated. Fixes same-name disambiguation across folders.

Adds compute_wikilink_rename_edits_resolved with a should_edit callback.
Keeps old update_wikilinks_in_doc as convenience wrapper for single-folder."
```

---

## Task 3: Update `apply_rename_updates` production code path

**Files:**
- Modify: `crates/y-sweet-core/src/link_indexer.rs` — `RenameEvent` struct, `detect_renames`, `apply_rename_updates`

**Context:**
Task 2 makes the test helper `apply_renames_to_doc` call `update_wikilinks_in_doc_resolved`. But the production code path in `apply_rename_updates` (lines 602-688) still calls the old `update_wikilinks_in_doc`. This task updates the production code to use resolution.

**Step 1: Update `RenameEvent` struct**

At line 471, add `old_path` and `folder_name` fields:

```rust
pub(crate) struct RenameEvent {
    pub uuid: String,
    pub old_name: String,
    pub new_name: String,
    pub old_path: String,      // full filemeta path, e.g. "/Foo.md"
    pub folder_name: String,   // e.g. "Relay Folder 2"
}
```

**Step 2: Update `detect_renames` to populate new fields**

The current code (line 546-558) builds `HashMap<String, String>` mapping `uuid -> basename`. We need to keep the full path too. Change to `uuid -> (basename, path)`:

```rust
let current: HashMap<String, (String, String)> = {
    let txn = folder_doc.transact();
    let Some(filemeta) = txn.get_map("filemeta_v0") else {
        return Vec::new();
    };

    let mut map = HashMap::new();
    for (path, value) in filemeta.iter(&txn) {
        if let Some(uuid) = extract_id_from_filemeta_entry(&value, &txn) {
            let basename = path
                .strip_prefix('/')
                .unwrap_or(&path)
                .strip_suffix(".md")
                .unwrap_or(&path)
                .rsplit('/')
                .next()
                .unwrap_or(&path)
                .to_string();
            map.insert(uuid, (basename, path.to_string()));
        }
    }
    map
};
```

And the comparison loop:

```rust
for (uuid, (new_basename, _new_path)) in &current {
    if let Some((old_basename, old_path)) = old.get(uuid) {
        if old_basename != new_basename {
            renames.push(RenameEvent {
                uuid: uuid.clone(),
                old_name: old_basename.clone(),
                new_name: new_basename.clone(),
                old_path: old_path.clone(),
                folder_name: String::new(), // populated by caller
            });
        }
    }
}
```

Actually, `detect_renames` doesn't have access to the folder name. The caller `apply_rename_updates` does. So either:
- Pass folder_name into `detect_renames`, or
- Set it in `apply_rename_updates` after calling `detect_renames`.

Cleaner: have `apply_rename_updates` set it after. Read the folder name from the folder doc, then set it on each rename event.

**Step 3: Update `apply_rename_updates` to use resolution**

The key changes to `apply_rename_updates`:

1. Read folder name from the folder doc being processed.
2. Collect all loaded folder docs to build the virtual tree.
3. For each rename, compute `old_virtual_path = "/{folder_name}{old_path}"`.
4. For each backlinker, find its virtual path in the entries.
5. Call `update_wikilinks_in_doc_resolved` instead of `update_wikilinks_in_doc`.

This is the most complex change. The current code iterates through the DashMap to find content docs. We need to also build the virtual tree from all folder docs, which requires collecting them.

The function already receives `docs: &DashMap<String, DocWithSyncKv>`. We can call `find_all_folder_docs(&docs)` (existing function) to get folder doc IDs, then build virtual entries from those.

```rust
fn apply_rename_updates(&self, folder_doc_id: &str, docs: &DashMap<String, DocWithSyncKv>) -> bool {
    // 1. Get the folder doc, detect renames, read folder name
    let (renames, folder_name) = {
        let Some(doc_ref) = docs.get(folder_doc_id) else {
            return false;
        };
        let awareness = doc_ref.awareness();
        let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
        let renames = self.detect_renames(folder_doc_id, &guard.doc);
        let folder_name = read_folder_name(&guard.doc, "");
        (renames, folder_name)
    };

    if renames.is_empty() {
        return false;
    }

    let Some((relay_id, _)) = parse_doc_id(folder_doc_id) else {
        return false;
    };

    // 2. Build virtual tree from all folder docs
    let folder_doc_ids = find_all_folder_docs(docs);
    let entries = {
        // Collect folder docs and names
        let mut f_docs: Vec<Doc> = Vec::new();
        let mut f_names: Vec<String> = Vec::new();
        for fid in &folder_doc_ids {
            if let Some(doc_ref) = docs.get(fid) {
                let awareness = doc_ref.awareness();
                let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
                // We need to clone the doc data for building entries outside the lock.
                // Instead, build entries inside the lock scope.
                // Actually, build_virtual_entries takes &[&Doc] which requires the Docs
                // to outlive the call. We need a different approach.
                f_names.push(read_folder_name(&guard.doc, ""));
                // We can't hold all the locks simultaneously without risking deadlock
                // with the content doc locks below. Let's build entries per-folder.
            }
        }
        // Alternative: since build_virtual_entries just reads filemeta_v0,
        // we can snapshot the entries we need.
        // For now, collect the data we need without holding locks.
        let mut entries = Vec::new();
        for (i, fid) in folder_doc_ids.iter().enumerate() {
            if let Some(doc_ref) = docs.get(fid) {
                let awareness = doc_ref.awareness();
                let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
                let fname = read_folder_name(&guard.doc, "");
                let txn = guard.doc.transact();
                if let Some(filemeta) = txn.get_map("filemeta_v0") {
                    for (path, value) in filemeta.iter(&txn) {
                        if let Some(uuid) = extract_id_from_filemeta_entry(&value, &txn) {
                            let entry_type = extract_type_from_filemeta_entry(&value, &txn)
                                .unwrap_or_default();
                            entries.push(VirtualEntry {
                                virtual_path: format!("/{}{}", fname, path),
                                entry_type,
                                id: uuid,
                                folder_idx: i,
                            });
                        }
                    }
                }
            }
        }
        entries
    };

    // 3. For each rename, update backlinkers with resolution
    for rename in &renames {
        let old_virtual_path = format!("/{}{}", folder_name, rename.old_path);

        let source_uuids = {
            let Some(doc_ref) = docs.get(folder_doc_id) else { continue; };
            let awareness = doc_ref.awareness();
            let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
            let txn = guard.doc.transact();
            if let Some(backlinks) = txn.get_map("backlinks_v0") {
                read_backlinks_array(&backlinks, &txn, &rename.uuid)
            } else {
                Vec::new()
            }
        };

        if source_uuids.is_empty() { continue; }

        for source_uuid in &source_uuids {
            let content_doc_id = format!("{}-{}", relay_id, source_uuid);
            let Some(content_ref) = docs.get(&content_doc_id) else { continue; };

            let source_virtual_path = entries.iter()
                .find(|e| e.id == *source_uuid)
                .map(|e| e.virtual_path.clone());

            let awareness = content_ref.awareness();
            let guard = awareness.write().unwrap_or_else(|e| e.into_inner());
            match update_wikilinks_in_doc_resolved(
                &guard.doc,
                &rename.old_name,
                &rename.new_name,
                source_virtual_path.as_deref(),
                &entries,
                &old_virtual_path,
            ) {
                Ok(count) => {
                    tracing::info!("Updated {} wikilink(s) in {}", count, content_doc_id);
                }
                Err(e) => {
                    tracing::error!("Failed to update wikilinks in {}: {:?}", content_doc_id, e);
                }
            }
        }
    }
    true
}
```

Note: `build_virtual_entries` requires `&[&Doc]` references, but we can't hold all DashMap read guards simultaneously (deadlock risk with content doc write locks). Instead, we inline the entry-building logic to snapshot entries one folder at a time, releasing locks between folders.

**Step 4: Run all tests**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml -p y-sweet-core --lib -v`

Expected: All tests pass, including all 7 previously-failing cross-folder rename tests and all previously-passing tests.

**Step 5: Commit**

```bash
jj describe -m "fix: use resolution-aware rename in production apply_rename_updates

RenameEvent now carries old_path and folder_name. apply_rename_updates builds
the virtual tree from all folder docs and passes resolution context to
update_wikilinks_in_doc_resolved for proper cross-folder disambiguation."
```

---

## Task 4: Clean up experiment tests

**Files:**
- Modify: `crates/y-sweet-core/src/link_indexer.rs` — remove experiment tests

**Context:**
Two experiment tests were added during investigation: `experiment_crdt_rename_events` and `experiment_crdt_history_after_roundtrip`. These were exploratory and should be removed now that the investigation is complete.

**Step 1: Remove the experiment tests**

Search for and remove both `experiment_crdt_rename_events` and `experiment_crdt_history_after_roundtrip` test functions from the `tests` module.

**Step 2: Run all tests to verify nothing broke**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml -p y-sweet-core --lib -v`

Expected: All tests pass (two fewer tests total).

**Step 3: Commit**

```bash
jj describe -m "chore: remove exploratory CRDT experiment tests"
```

---

## Summary

| Task | What | Tests Fixed |
|------|------|-------------|
| 1 | `compute_wikilink_rename_edits` matches basenames, replaces only basename portion | 1 (link_parser) |
| 2 | `compute_wikilink_rename_edits_resolved` + `update_wikilinks_in_doc_resolved` with resolution filter | 6 (link_indexer) |
| 3 | Production `apply_rename_updates` uses resolution | 0 (production parity) |
| 4 | Remove experiment tests | 0 (cleanup) |

Tasks 1 and 2 are the core fixes. Task 3 ensures the production code path (not just tests) uses the new logic. Task 4 is housekeeping.
