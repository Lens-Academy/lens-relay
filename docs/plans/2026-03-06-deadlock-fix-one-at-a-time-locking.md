# Deadlock Fix: One-at-a-Time Folder Locking

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate tokio thread starvation deadlock by refactoring `index_document` to acquire awareness locks on one folder doc at a time instead of all 54 simultaneously.

**Architecture:** The current `index_document` (link_indexer.rs:1367) acquires `std::sync::RwLock` write locks on ALL folder docs at lines 1412-1414 before processing. Under client reconnection pressure, this 54-way simultaneous lock competes with WebSocket handlers for the same locks, starving all 10 tokio worker threads. The fix splits the operation into 3 phases: (1) snapshot folder metadata with short-lived READ locks one-at-a-time, (2) resolve links in pure memory, (3) mutate backlinks with short-lived WRITE locks one-at-a-time.

**Tech Stack:** Rust, yrs (Y-CRDT), tokio, DashMap, std::sync::RwLock

**Key Insight:** `apply_rename_updates` (line 1116) already uses this one-at-a-time pattern correctly (lines 1148-1173). We're applying the same pattern to `index_document`.

**Unchanged:** `index_content_into_folders_from_text` and its callers (`index_content_into_folder`, `index_content_into_folders`) operate on bare `&Doc` refs without awareness locks — they stay as-is. All existing tests use these functions.

---

## Task 1: Extract `snapshot_folder_entries` helper

Extract the filemeta-reading logic from `build_virtual_entries` into a function that works on a single `&Doc`.

**Files:**
- Modify: `crates/y-sweet-core/src/link_indexer.rs`

**Step 1: Write the failing test**

Add to `mod tests` at the bottom of link_indexer.rs:

```rust
#[test]
fn snapshot_folder_entries_matches_build_virtual_entries() {
    let folder1 = create_folder_doc(&[("/Notes.md", "uuid-notes"), ("/Ideas.md", "uuid-ideas")]);
    set_folder_name(&folder1, "Lens");
    let folder2 = create_folder_doc(&[("/Welcome.md", "uuid-welcome")]);
    set_folder_name(&folder2, "Edu");

    // Snapshot one-at-a-time
    let mut snapshot_entries = Vec::new();
    let (name1, entries1) = snapshot_folder_entries(&folder1, "folder1", 0);
    snapshot_entries.extend(entries1);
    let (name2, entries2) = snapshot_folder_entries(&folder2, "folder2", 1);
    snapshot_entries.extend(entries2);

    // Batch (existing function)
    let folder_refs: Vec<&Doc> = vec![&folder1, &folder2];
    let names = vec![name1.as_str(), name2.as_str()];
    let batch_entries = build_virtual_entries(&folder_refs, &names);

    // Same number of entries
    assert_eq!(snapshot_entries.len(), batch_entries.len());

    // Same content (sort by id for deterministic comparison)
    let mut snap_sorted: Vec<_> = snapshot_entries.iter().map(|e| (&e.id, &e.virtual_path, e.folder_idx)).collect();
    snap_sorted.sort();
    let mut batch_sorted: Vec<_> = batch_entries.iter().map(|e| (&e.id, &e.virtual_path, e.folder_idx)).collect();
    batch_sorted.sort();
    assert_eq!(snap_sorted, batch_sorted);
}
```

**Step 2: Run test to verify it fails**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml -p y-sweet-core snapshot_folder_entries_matches`

Expected: FAIL with "cannot find function `snapshot_folder_entries`"

**Step 3: Write minimal implementation**

Add above `build_virtual_entries` (around line 254):

```rust
/// Snapshot a single folder doc's filemeta into VirtualEntry list.
///
/// Used by `index_document` to read folder metadata under a short-lived lock
/// without holding locks on other folders simultaneously.
/// Returns (folder_name, entries).
pub fn snapshot_folder_entries(
    folder_doc: &Doc,
    folder_doc_id: &str,
    folder_idx: usize,
) -> (String, Vec<VirtualEntry>) {
    let folder_name = read_folder_name(folder_doc, folder_doc_id);
    let txn = folder_doc.transact();
    let mut entries = Vec::new();
    if let Some(filemeta) = txn.get_map("filemeta_v0") {
        for (path, value) in filemeta.iter(&txn) {
            let entry_type = extract_type_from_filemeta_entry(&value, &txn)
                .unwrap_or_else(|| "unknown".to_string());
            let id = match extract_id_from_filemeta_entry(&value, &txn) {
                Some(id) => id,
                None => continue,
            };
            let virtual_path = format!("/{}{}", folder_name, path);
            entries.push(VirtualEntry {
                virtual_path,
                entry_type,
                id,
                folder_idx,
            });
        }
    }
    (folder_name, entries)
}
```

**Step 4: Run test to verify it passes**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml -p y-sweet-core snapshot_folder_entries_matches`

Expected: PASS

**Step 5: Commit**

```bash
jj describe -m "refactor: extract snapshot_folder_entries helper for one-at-a-time locking"
```

---

## Task 2: Extract `compute_backlink_targets` helper

Extract link resolution + per-folder grouping from `index_content_into_folders_from_text` into a pure function.

**Files:**
- Modify: `crates/y-sweet-core/src/link_indexer.rs`

**Step 1: Write the failing test**

```rust
#[test]
fn compute_backlink_targets_groups_by_folder() {
    // Two folders: Lens has Notes and Ideas, Edu has Welcome
    let entries = vec![
        VirtualEntry {
            virtual_path: "/Lens/Notes.md".to_string(),
            entry_type: "markdown".to_string(),
            id: "uuid-notes".to_string(),
            folder_idx: 0,
        },
        VirtualEntry {
            virtual_path: "/Lens/Ideas.md".to_string(),
            entry_type: "markdown".to_string(),
            id: "uuid-ideas".to_string(),
            folder_idx: 0,
        },
        VirtualEntry {
            virtual_path: "/Edu/Welcome.md".to_string(),
            entry_type: "markdown".to_string(),
            id: "uuid-welcome".to_string(),
            folder_idx: 1,
        },
    ];

    let link_names = vec!["Ideas".to_string(), "Welcome".to_string()];
    let targets = compute_backlink_targets(
        "uuid-notes",
        &link_names,
        &entries,
        2, // 2 folders
    );

    assert_eq!(targets.len(), 2);
    // Folder 0 (Lens): Ideas resolved
    assert!(targets[0].contains("uuid-ideas"));
    assert_eq!(targets[0].len(), 1);
    // Folder 1 (Edu): Welcome resolved
    assert!(targets[1].contains("uuid-welcome"));
    assert_eq!(targets[1].len(), 1);
}

#[test]
fn compute_backlink_targets_empty_links() {
    let entries = vec![
        VirtualEntry {
            virtual_path: "/Lens/Notes.md".to_string(),
            entry_type: "markdown".to_string(),
            id: "uuid-notes".to_string(),
            folder_idx: 0,
        },
    ];

    let targets = compute_backlink_targets("uuid-notes", &[], &entries, 1);
    assert_eq!(targets.len(), 1);
    assert!(targets[0].is_empty());
}
```

**Step 2: Run test to verify it fails**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml -p y-sweet-core compute_backlink_targets`

Expected: FAIL with "cannot find function `compute_backlink_targets`"

**Step 3: Write minimal implementation**

Add after `build_virtual_entries`:

```rust
/// Resolve wikilinks against virtual entries and group target UUIDs by folder index.
///
/// Pure computation — no Doc access or locks needed.
/// Returns a Vec of HashSets, one per folder, containing target UUIDs.
pub fn compute_backlink_targets(
    source_uuid: &str,
    link_names: &[String],
    entries: &[VirtualEntry],
    num_folders: usize,
) -> Vec<HashSet<String>> {
    let source_virtual_path: Option<String> = entries
        .iter()
        .find(|e| e.id == source_uuid)
        .map(|e| e.virtual_path.clone());

    let mut resolved: Vec<(String, usize)> = Vec::new();
    for name in link_names {
        if let Some(entry) = resolve_in_virtual_tree(name, source_virtual_path.as_deref(), entries) {
            resolved.push((entry.id.clone(), entry.folder_idx));
        }
    }

    let mut targets_per_folder: Vec<HashSet<String>> = vec![HashSet::new(); num_folders];
    for (uuid, fi) in &resolved {
        targets_per_folder[*fi].insert(uuid.clone());
    }
    targets_per_folder
}
```

**Step 4: Run test to verify it passes**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml -p y-sweet-core compute_backlink_targets`

Expected: PASS

**Step 5: Commit**

```bash
jj new
jj describe -m "refactor: extract compute_backlink_targets pure function"
```

---

## Task 3: Extract `apply_backlink_diff` helper

Extract the per-folder backlink mutation loop (lines 424-457 of `index_content_into_folders_from_text`) into a function that operates on a single `&Doc`.

**Files:**
- Modify: `crates/y-sweet-core/src/link_indexer.rs`

**Step 1: Write the failing test**

```rust
#[test]
fn apply_backlink_diff_adds_new_targets() {
    let folder_doc = create_folder_doc(&[
        ("/Notes.md", "uuid-notes"),
        ("/Ideas.md", "uuid-ideas"),
    ]);

    let mut targets = HashSet::new();
    targets.insert("uuid-ideas".to_string());

    apply_backlink_diff(&folder_doc, "uuid-notes", &targets);

    let backlinks = read_backlinks(&folder_doc, "uuid-ideas");
    assert_eq!(backlinks, vec!["uuid-notes"]);
}

#[test]
fn apply_backlink_diff_removes_stale_targets() {
    let folder_doc = create_folder_doc(&[
        ("/Notes.md", "uuid-notes"),
        ("/Ideas.md", "uuid-ideas"),
        ("/Other.md", "uuid-other"),
    ]);

    // First: add backlinks to both Ideas and Other
    let mut targets1 = HashSet::new();
    targets1.insert("uuid-ideas".to_string());
    targets1.insert("uuid-other".to_string());
    apply_backlink_diff(&folder_doc, "uuid-notes", &targets1);

    assert_eq!(read_backlinks(&folder_doc, "uuid-ideas"), vec!["uuid-notes"]);
    assert_eq!(read_backlinks(&folder_doc, "uuid-other"), vec!["uuid-notes"]);

    // Second: remove Other, keep Ideas
    let mut targets2 = HashSet::new();
    targets2.insert("uuid-ideas".to_string());
    apply_backlink_diff(&folder_doc, "uuid-notes", &targets2);

    assert_eq!(read_backlinks(&folder_doc, "uuid-ideas"), vec!["uuid-notes"]);
    assert!(read_backlinks(&folder_doc, "uuid-other").is_empty());
}

#[test]
fn apply_backlink_diff_preserves_other_sources() {
    let folder_doc = create_folder_doc(&[
        ("/Notes.md", "uuid-notes"),
        ("/Projects.md", "uuid-projects"),
        ("/Ideas.md", "uuid-ideas"),
    ]);

    // Two sources link to Ideas
    let mut targets_notes = HashSet::new();
    targets_notes.insert("uuid-ideas".to_string());
    apply_backlink_diff(&folder_doc, "uuid-notes", &targets_notes);

    let mut targets_projects = HashSet::new();
    targets_projects.insert("uuid-ideas".to_string());
    apply_backlink_diff(&folder_doc, "uuid-projects", &targets_projects);

    let mut backlinks = read_backlinks(&folder_doc, "uuid-ideas");
    backlinks.sort();
    assert_eq!(backlinks, vec!["uuid-notes", "uuid-projects"]);

    // Remove Notes' link — Projects should remain
    apply_backlink_diff(&folder_doc, "uuid-notes", &HashSet::new());

    let backlinks = read_backlinks(&folder_doc, "uuid-ideas");
    assert_eq!(backlinks, vec!["uuid-projects"]);
}
```

**Step 2: Run test to verify it fails**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml -p y-sweet-core apply_backlink_diff`

Expected: FAIL with "cannot find function `apply_backlink_diff`"

**Step 3: Write minimal implementation**

Add after `compute_backlink_targets`:

```rust
/// Apply a backlink diff to a single folder doc's backlinks_v0 map.
///
/// For `source_uuid`, ensures exactly `new_targets` are listed in backlinks.
/// Adds source_uuid to targets that don't have it, removes from targets that
/// are no longer linked. Preserves other sources' backlinks.
pub fn apply_backlink_diff(folder_doc: &Doc, source_uuid: &str, new_targets: &HashSet<String>) {
    let mut txn = folder_doc.transact_mut_with("link-indexer");
    let backlinks = txn.get_or_insert_map("backlinks_v0");

    // Add source to new targets
    for target_uuid in new_targets {
        let current: Vec<String> = read_backlinks_array(&backlinks, &txn, target_uuid);
        if !current.contains(&source_uuid.to_string()) {
            let mut updated = current;
            updated.push(source_uuid.to_string());
            let arr: Vec<Any> = updated.into_iter().map(|s| Any::String(s.into())).collect();
            backlinks.insert(&mut txn, target_uuid.as_str(), arr);
        }
    }

    // Remove source from targets no longer linked
    let all_keys: Vec<String> = backlinks.keys(&txn).map(|k| k.to_string()).collect();
    for key in all_keys {
        if new_targets.contains(&key) {
            continue;
        }
        let current: Vec<String> = read_backlinks_array(&backlinks, &txn, &key);
        if current.contains(&source_uuid.to_string()) {
            let updated: Vec<String> = current.into_iter().filter(|s| s != source_uuid).collect();
            if updated.is_empty() {
                backlinks.remove(&mut txn, &key);
            } else {
                let arr: Vec<Any> = updated.into_iter().map(|s| Any::String(s.into())).collect();
                backlinks.insert(&mut txn, key.as_str(), arr);
            }
        }
    }
}
```

**Step 4: Run test to verify it passes**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml -p y-sweet-core apply_backlink_diff`

Expected: PASS

**Step 5: Commit**

```bash
jj new
jj describe -m "refactor: extract apply_backlink_diff for single-folder mutation"
```

---

## Task 4: Refactor `index_document` to one-at-a-time locking

Replace the 54-way simultaneous write lock with 3-phase one-at-a-time approach using the helpers from Tasks 1-3.

**Files:**
- Modify: `crates/y-sweet-core/src/link_indexer.rs` (method `index_document`, ~line 1367)

**Step 1: Write integration test with real `DocWithSyncKv` + `DashMap`**

This test exercises the actual `index_document` method through the real code path: DashMap lookup, awareness lock acquisition, backlink writes. This is a unit+1 test — uses real `DocWithSyncKv` and `DashMap`, no mocking needed.

```rust
#[tokio::test]
async fn index_document_with_dashmap_and_awareness() {
    use crate::doc_sync::DocWithSyncKv;

    let relay_id = "cb696037-0f72-4e93-8717-4e433129d789";

    // Create DocWithSyncKv instances (store: None = in-memory only)
    let folder_dswk = DocWithSyncKv::new(
        &format!("{}-uuid-folder", relay_id), None, || {}, None
    ).await.unwrap();
    let content_dswk = DocWithSyncKv::new(
        &format!("{}-uuid-notes", relay_id), None, || {}, None
    ).await.unwrap();

    // Populate folder doc with filemeta
    {
        let awareness = folder_dswk.awareness();
        let guard = awareness.write().unwrap();
        let mut txn = guard.doc.transact_mut();
        let filemeta = txn.get_or_insert_map("filemeta_v0");
        let mut notes_meta = HashMap::new();
        notes_meta.insert("id".to_string(), Any::String("uuid-notes".into()));
        notes_meta.insert("type".to_string(), Any::String("markdown".into()));
        filemeta.insert(&mut txn, "/Notes.md", Any::Map(notes_meta.into()));
        let mut ideas_meta = HashMap::new();
        ideas_meta.insert("id".to_string(), Any::String("uuid-ideas".into()));
        ideas_meta.insert("type".to_string(), Any::String("markdown".into()));
        filemeta.insert(&mut txn, "/Ideas.md", Any::Map(ideas_meta.into()));
        let config = txn.get_or_insert_map("folder_config");
        config.insert(&mut txn, "name", Any::String("Lens".into()));
    }

    // Populate content doc with wikilinks
    {
        let awareness = content_dswk.awareness();
        let guard = awareness.write().unwrap();
        let mut txn = guard.doc.transact_mut();
        let text = txn.get_or_insert_text("contents");
        text.insert(&mut txn, 0, "See [[Ideas]] for more");
    }

    // Insert into DashMap
    let docs: DashMap<String, DocWithSyncKv> = DashMap::new();
    let folder_id = format!("{}-uuid-folder", relay_id);
    let content_id = format!("{}-uuid-notes", relay_id);
    docs.insert(folder_id.clone(), folder_dswk);
    docs.insert(content_id.clone(), content_dswk);

    // Call index_document
    let (indexer, _rx) = LinkIndexer::new();
    let folder_doc_ids = vec![folder_id.clone()];
    let result = indexer.index_document(&content_id, &docs, &folder_doc_ids);
    assert!(result.is_ok(), "index_document failed: {:?}", result.err());

    // Verify backlinks written through awareness lock path
    let folder_ref = docs.get(&folder_id).unwrap();
    let awareness = folder_ref.awareness();
    let guard = awareness.read().unwrap();
    let txn = guard.doc.transact();
    let backlinks = txn.get_map("backlinks_v0").expect("backlinks_v0 should exist");
    let ideas_backlinks = read_backlinks_array(&backlinks, &txn, "uuid-ideas");
    assert_eq!(ideas_backlinks, vec!["uuid-notes"]);
}
```

**Step 2: Run test to verify it fails**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml -p y-sweet-core index_document_with_dashmap`

Expected: FAIL — `index_document` is currently a private method (`fn index_document`). The test needs it accessible. If it fails because of visibility, make `index_document` `pub(crate)` (it's already only called from within the crate).

Note: This test exercises the REAL lock acquisition path that the deadlock fix changes. It validates that the refactored `index_document` correctly acquires locks one-at-a-time, reads through DashMap, and writes backlinks through awareness guards.

**Step 2b: If visibility issue, make `index_document` pub(crate)**

Change `fn index_document(` to `pub(crate) fn index_document(` (line 1367). This is not test-only pollution — `index_document` is a legitimate internal API within the crate.

**Step 3: Rewrite `index_document` method**

Replace the body of `index_document` (line 1367) with:

```rust
fn index_document(
    &self,
    doc_id: &str,
    docs: &DashMap<String, DocWithSyncKv>,
    folder_doc_ids: &[String],
) -> anyhow::Result<()> {
    let (_relay_id, doc_uuid) = parse_doc_id(doc_id)
        .ok_or_else(|| anyhow::anyhow!("Invalid doc_id format: {}", doc_id))?;

    if folder_doc_ids.is_empty() {
        return Err(anyhow::anyhow!("No folder docs found for indexing"));
    }

    // Phase 1: Extract content text under a short-lived read lock.
    let markdown = {
        let content_ref = docs
            .get(doc_id)
            .ok_or_else(|| anyhow::anyhow!("Content doc not found: {}", doc_id))?;
        let awareness = content_ref.awareness();
        let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
        let txn = guard.doc.transact();
        if let Some(contents) = txn.get_text("contents") {
            contents.get_string(&txn)
        } else {
            return Ok(()); // No content, nothing to index
        }
    }; // content read lock + DashMap guard dropped here

    let link_names = extract_wikilinks(&markdown);
    tracing::info!(
        "Doc {}: content length={}, wikilinks={:?}",
        doc_uuid,
        markdown.len(),
        link_names
    );

    // Phase 2: Snapshot folder metadata (read locks, one at a time).
    // Each lock is held only long enough to read filemeta + folder name.
    // Lock ordering: DashMap shard read -> awareness read. This matches the
    // existing code (lines 1407-1416) so no new deadlock risk is introduced.
    // DashMap guard is dropped before the next iteration.
    let mut entries: Vec<VirtualEntry> = Vec::new();
    for (fi, fid) in folder_doc_ids.iter().enumerate() {
        let doc_ref = match docs.get(fid) {
            Some(r) => r,
            None => continue,
        };
        let awareness = doc_ref.awareness();
        let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
        let (_name, folder_entries) = snapshot_folder_entries(&guard.doc, fid, fi);
        entries.extend(folder_entries);
        // guard dropped here — read lock released before next folder
    }

    // Phase 3: Resolve links (pure computation, no locks).
    let targets_per_folder =
        compute_backlink_targets(doc_uuid, &link_names, &entries, folder_doc_ids.len());

    tracing::info!(
        "Doc {}: resolved {} links across {} folders",
        doc_uuid,
        link_names.len(),
        folder_doc_ids.len()
    );

    // Phase 4: Write backlinks (write locks, one at a time).
    // Each lock is held only for the duration of one folder's backlink update.
    // Note: Folder state may have changed between Phase 2 and Phase 4, making
    // snapshots stale. This is tolerable because the debounce/re-queue pipeline
    // self-corrects: any concurrent folder change triggers a new indexing pass.
    // Staleness self-correction is covered by debounce pipeline tests
    // (new_updates_after_indexing_requeue), not by a dedicated staleness test.
    for (fi, fid) in folder_doc_ids.iter().enumerate() {
        let doc_ref = match docs.get(fid) {
            Some(r) => r,
            None => continue,
        };
        let awareness = doc_ref.awareness();
        let guard = awareness.write().unwrap_or_else(|e| e.into_inner());
        apply_backlink_diff(&guard.doc, doc_uuid, &targets_per_folder[fi]);
        // guard dropped here — write lock released before next folder
    }

    Ok(())
}
```

**Step 4: Run ALL existing tests to verify nothing breaks**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml`

Expected: ALL PASS. The existing tests use `index_content_into_folder` (bare Docs), which is unchanged. The `index_document` method is only called from `run_worker` and `reindex_all_backlinks`, which aren't tested directly.

**Step 5: Commit**

```bash
jj new
jj describe -m "fix: eliminate 54-way deadlock — index_document locks one folder at a time"
```

---

## Task 4.5: DRY up `apply_rename_updates` to use `snapshot_folder_entries`

`apply_rename_updates` (line 1148-1173) has an inline loop that does exactly what `snapshot_folder_entries` does. Refactor to use the new helper.

**Files:**
- Modify: `crates/y-sweet-core/src/link_indexer.rs` (method `apply_rename_updates`, ~line 1148)

**Step 1: No new test needed**

Existing rename tests cover this path. This is a pure refactoring (same behavior, less code).

**Step 2: Replace the inline loop**

Replace lines 1148-1173 (the "Build virtual entries from all folder docs" section) with:

```rust
// 2. Build virtual entries from all folder docs
//    Snapshot entries one folder at a time to avoid holding multiple locks.
let folder_doc_ids = find_all_folder_docs(docs);
let mut entries: Vec<VirtualEntry> = Vec::new();
for (fi, fid) in folder_doc_ids.iter().enumerate() {
    if let Some(doc_ref) = docs.get(fid) {
        let awareness = doc_ref.awareness();
        let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
        let (_name, folder_entries) = snapshot_folder_entries(&guard.doc, fid, fi);
        entries.extend(folder_entries);
    }
}
```

Note: `folder_idx` is not used for resolution in rename updates (it's set to 0 in the current code), but using the real index is harmless and more correct.

**Step 3: Run tests**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml -p y-sweet-core`

Expected: ALL PASS

**Step 4: Commit**

```bash
jj new
jj describe -m "refactor: DRY apply_rename_updates using snapshot_folder_entries"
```

---

## Task 5: Add `yield_now` between batch items in `run_worker`

Belt-and-suspenders: yield to the tokio scheduler between processing each doc in the batch loop. This prevents the link indexer from monopolizing a worker thread even with the one-at-a-time locking.

**Files:**
- Modify: `crates/y-sweet-core/src/link_indexer.rs` (method `run_worker`, ~line 1309)

**Step 1: No separate failing test needed**

This is a single-line addition to an async loop. The behavioral tests are the existing debounce/pipeline tests which should still pass.

**Step 2: Add yield_now**

In `run_worker`, at line 1309 (the `for doc_id in ready` loop), add at the end of each iteration:

```rust
// Yield to tokio scheduler between batch items to prevent
// monopolizing a worker thread during large batches.
tokio::task::yield_now().await;
```

Add it just before the closing `}` of the `for doc_id in ready` loop (after `self.mark_indexed(&doc_id);` at line 1360).

**Step 3: Run tests**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml -p y-sweet-core`

Expected: ALL PASS

**Step 4: Commit**

```bash
jj new
jj describe -m "fix: yield_now between batch items in link indexer worker"
```

---

## Deferred: Search worker buffered writes

> **Not part of this plan.** The search worker's `std::sync::Mutex<IndexWriter>` hold time is a separate latency concern, not part of the awareness RwLock deadlock. Create a separate plan for switching `search_handle_content_update` and `search_handle_folder_update` to `add_document_buffered` + `flush()` pattern.

---

## Task 6: Verify fix and deploy

**Step 1: Run full test suite**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml`

Expected: ALL PASS

**Step 2: Build release binary**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo build --manifest-path=crates/Cargo.toml --release --bin relay`

Expected: Compiles clean

**Step 3: Deploy to production**

Follow the deployment steps from CLAUDE.local.md:
1. Push code to GitHub, pull on prod
2. Copy binary to prod
3. Rebuild Docker + restart

**Step 4: Monitor for deadlock recurrence**

After deploy, monitor production logs. The deadlock manifested within ~2 minutes under client reconnection pressure. If the server stays responsive for 10+ minutes under load, the fix is working.

---

## Summary of Changes

| File | Change | Purpose |
|------|--------|---------|
| `link_indexer.rs` | New `snapshot_folder_entries()` | Read single folder metadata without holding other locks |
| `link_indexer.rs` | New `compute_backlink_targets()` | Pure link resolution + per-folder grouping |
| `link_indexer.rs` | New `apply_backlink_diff()` | Mutate single folder's backlinks |
| `link_indexer.rs` | Rewrite `index_document()` | 3-phase one-at-a-time locking (core deadlock fix) |
| `link_indexer.rs` | DRY `apply_rename_updates()` | Use `snapshot_folder_entries` instead of inline loop |
| `link_indexer.rs` | Add `yield_now` in `run_worker` | Prevent worker thread monopolization |
