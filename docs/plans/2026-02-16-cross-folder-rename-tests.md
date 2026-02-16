# Cross-Folder Rename Backlink Tests

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Write failing tests that expose two bugs in cross-folder wikilink rename handling, without changing any production code.

**Architecture:** Add a new `mod cross_folder_rename_tests` submodule inside the existing `#[cfg(test)] mod tests` in `link_indexer.rs`. Uses the same test helpers already defined there (`create_folder_doc`, `set_folder_name`, `create_content_doc`, `read_backlinks`, `read_contents`, `index_content_into_folders`, `update_wikilinks_in_doc`, `read_backlinks_array`, `LinkIndexer`). Also adds one new test to `link_parser.rs` for the lowest-level matching behavior.

**Tech Stack:** Rust, yrs (Y.Doc CRDT), `#[test]` with existing helpers

**Bugs under test:**
- **Bug 1:** `compute_wikilink_rename_edits` compares bare basename against the full `occ.name`. For `[[Relay Folder 2/Foo]]`, `occ.name` = `"Relay Folder 2/Foo"` which doesn't equal `"Foo"`, so cross-folder links are silently skipped.
- **Bug 2:** When both folders have a file called "Foo" and folder B's Foo is renamed, the rename system calls `update_wikilinks_in_doc(notes_a, "Foo", "Qux")`. This incorrectly matches `[[Foo]]` in notes-a (which resolves to folder A's Foo via relative resolution), updating the wrong link.

---

## Shared Test Fixture

All tests in the new submodule use this two-folder setup with same-name files:

```
Relay Folder 1 (folder_a):
  /Foo.md       (uuid-foo-a)      ← same basename as folder B
  /Notes.md     (uuid-notes-a)

Relay Folder 2 (folder_b):
  /Foo.md       (uuid-foo-b)      ← same basename as folder A
  /Journal.md   (uuid-journal-b)
```

Build with existing helpers:

```rust
fn two_folder_fixture() -> (Doc, Doc) {
    let folder_a = create_folder_doc(&[
        ("/Foo.md", "uuid-foo-a"),
        ("/Notes.md", "uuid-notes-a"),
    ]);
    set_folder_name(&folder_a, "Relay Folder 1");

    let folder_b = create_folder_doc(&[
        ("/Foo.md", "uuid-foo-b"),
        ("/Journal.md", "uuid-journal-b"),
    ]);
    set_folder_name(&folder_b, "Relay Folder 2");

    (folder_a, folder_b)
}
```

---

## Task 1: link_parser — basename-suffix matching test

The lowest-level unit test proving Bug 1 exists.

**Files:**
- Modify: `crates/y-sweet-core/src/link_parser.rs` (add test at end of `#[cfg(test)]` module, around line 243)

**Step 1: Write the failing test**

Add inside the existing `mod tests` block at the bottom of `link_parser.rs`:

```rust
#[test]
fn rename_edits_match_path_qualified_wikilink() {
    // Cross-folder link: [[Relay Folder 2/Foo]] should match rename of "Foo"
    let md = "See [[Relay Folder 2/Foo]] for details";
    let edits = compute_wikilink_rename_edits(md, "Foo", "Qux");

    // Should find one edit — the "Foo" portion of "Relay Folder 2/Foo"
    assert_eq!(edits.len(), 1, "path-qualified link should match basename rename");

    // The edit should replace only "Foo" (3 bytes), not the whole path
    let edit = &edits[0];
    assert_eq!(edit.insert_text, "Qux");
    // After applying: "See [[Relay Folder 2/Qux]] for details"
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path=crates/Cargo.toml -p y-sweet-core rename_edits_match_path_qualified_wikilink -- --nocapture`

Expected: FAIL — `assert_eq!(edits.len(), 1, ...)` fails because `edits` is empty. The current code does exact full-name matching: `"Relay Folder 2/Foo".to_lowercase() == "Foo".to_lowercase()` → false.

**Step 3: Commit**

```
test: failing test for path-qualified wikilink rename matching

compute_wikilink_rename_edits does exact full-name comparison,
so [[Relay Folder 2/Foo]] doesn't match basename "Foo".
```

---

## Task 2: Backlink indexing — same-name files across folders

Verify that the indexing layer correctly disambiguates same-name files. These tests should **pass** with current code (they validate the foundation the rename tests build on).

**Files:**
- Modify: `crates/y-sweet-core/src/link_indexer.rs` (add new submodule before the closing `}` of `mod tests`, around line 2065)

**Step 1: Write the passing tests**

Add a new submodule inside `mod tests`:

```rust
mod cross_folder_rename_tests {
    use super::*;

    /// Shared fixture: two folders, each with a file named "Foo"
    fn two_folder_fixture() -> (Doc, Doc) {
        let folder_a = create_folder_doc(&[
            ("/Foo.md", "uuid-foo-a"),
            ("/Notes.md", "uuid-notes-a"),
        ]);
        set_folder_name(&folder_a, "Relay Folder 1");

        let folder_b = create_folder_doc(&[
            ("/Foo.md", "uuid-foo-b"),
            ("/Journal.md", "uuid-journal-b"),
        ]);
        set_folder_name(&folder_b, "Relay Folder 2");

        (folder_a, folder_b)
    }

    // --- Backlink indexing with same-name disambiguation ---

    #[test]
    fn same_name_bare_link_resolves_within_own_folder() {
        let (folder_a, folder_b) = two_folder_fixture();
        // Notes in folder A links to [[Foo]] — should resolve to folder A's Foo (relative)
        let notes_doc = create_content_doc("See [[Foo]]");

        index_content_into_folders(
            "uuid-notes-a", &notes_doc, &[&folder_a, &folder_b],
        ).unwrap();

        // Backlink on folder A's Foo (correct — same-folder relative resolution)
        assert_eq!(read_backlinks(&folder_a, "uuid-foo-a"), vec!["uuid-notes-a"]);
        // No backlink on folder B's Foo
        assert!(read_backlinks(&folder_b, "uuid-foo-b").is_empty());
    }

    #[test]
    fn same_name_cross_folder_explicit_link() {
        let (folder_a, folder_b) = two_folder_fixture();
        // Notes in folder A links to [[Relay Folder 2/Foo]] — explicit cross-folder
        let notes_doc = create_content_doc("See [[Relay Folder 2/Foo]]");

        index_content_into_folders(
            "uuid-notes-a", &notes_doc, &[&folder_a, &folder_b],
        ).unwrap();

        // Backlink on folder B's Foo
        assert_eq!(read_backlinks(&folder_b, "uuid-foo-b"), vec!["uuid-notes-a"]);
        // No backlink on folder A's Foo
        assert!(read_backlinks(&folder_a, "uuid-foo-a").is_empty());
    }

    #[test]
    fn same_name_both_bare_and_cross_folder_links() {
        let (folder_a, folder_b) = two_folder_fixture();
        // Notes links to BOTH Foos: bare resolves to own folder, explicit to other
        let notes_doc = create_content_doc("[[Foo]] and [[Relay Folder 2/Foo]]");

        index_content_into_folders(
            "uuid-notes-a", &notes_doc, &[&folder_a, &folder_b],
        ).unwrap();

        // folder A's Foo: backlinked by notes-a (bare [[Foo]])
        assert_eq!(read_backlinks(&folder_a, "uuid-foo-a"), vec!["uuid-notes-a"]);
        // folder B's Foo: backlinked by notes-a ([[Relay Folder 2/Foo]])
        assert_eq!(read_backlinks(&folder_b, "uuid-foo-b"), vec!["uuid-notes-a"]);
    }

    #[test]
    fn same_name_other_folder_bare_link() {
        let (folder_a, folder_b) = two_folder_fixture();
        // Journal in folder B links to [[Foo]] — resolves to folder B's Foo
        let journal_doc = create_content_doc("See [[Foo]]");

        index_content_into_folders(
            "uuid-journal-b", &journal_doc, &[&folder_a, &folder_b],
        ).unwrap();

        assert_eq!(read_backlinks(&folder_b, "uuid-foo-b"), vec!["uuid-journal-b"]);
        assert!(read_backlinks(&folder_a, "uuid-foo-a").is_empty());
    }
}
```

**Step 2: Run tests to verify they pass**

Run: `cargo test --manifest-path=crates/Cargo.toml -p y-sweet-core cross_folder_rename_tests -- --nocapture`

Expected: All 4 PASS. These validate the indexing foundation.

**Step 3: Commit**

```
test: backlink indexing with same-name files across folders

Validates that [[Foo]] resolves within own folder while
[[Relay Folder 2/Foo]] correctly resolves cross-folder.
Foundation for cross-folder rename tests.
```

---

## Task 3: Cross-folder rename — path-qualified links (Bug 1)

The core failing tests proving that `update_wikilinks_in_doc` misses path-qualified cross-folder links.

**Files:**
- Modify: `crates/y-sweet-core/src/link_indexer.rs` (add to `cross_folder_rename_tests` submodule)

**Step 1: Write the failing tests**

Add inside `cross_folder_rename_tests`:

```rust
// --- Cross-folder rename: path-qualified links (Bug 1) ---

/// Helper: seed indexer cache, rename a file in filemeta, detect renames.
/// Returns the detected renames.
fn rename_in_folder(
    indexer: &LinkIndexer,
    folder_doc: &Doc,
    folder_cache_key: &str,
    old_path: &str,
    new_path: &str,
    uuid: &str,
) -> Vec<RenameEvent> {
    // Seed cache on first call
    indexer.detect_renames(folder_cache_key, folder_doc);

    // Rename: remove old path, add new path with same UUID
    {
        let mut txn = folder_doc.transact_mut();
        let filemeta = txn.get_or_insert_map("filemeta_v0");
        filemeta.remove(&mut txn, old_path);
        let mut map = HashMap::new();
        map.insert("id".to_string(), Any::String(uuid.into()));
        map.insert("type".to_string(), Any::String("markdown".into()));
        map.insert("version".to_string(), Any::Number(0.0));
        filemeta.insert(&mut txn, new_path, Any::Map(map.into()));
    }

    indexer.detect_renames(folder_cache_key, folder_doc)
}

/// Helper: apply renames to a content doc using backlinks from a folder doc.
/// Maps source UUIDs to content docs via the provided lookup.
fn apply_renames_to_doc(
    renames: &[RenameEvent],
    folder_doc: &Doc,
    source_uuid: &str,
    content_doc: &Doc,
) {
    for rename in renames {
        let txn = folder_doc.transact();
        if let Some(backlinks) = txn.get_map("backlinks_v0") {
            let source_uuids = read_backlinks_array(&backlinks, &txn, &rename.uuid);
            drop(txn);

            if source_uuids.contains(&source_uuid.to_string()) {
                update_wikilinks_in_doc(content_doc, &rename.old_name, &rename.new_name)
                    .unwrap();
            }
        }
    }
}

#[test]
fn cross_folder_rename_updates_path_qualified_link() {
    let (folder_a, folder_b) = two_folder_fixture();
    let notes_doc = create_content_doc("See [[Relay Folder 2/Foo]] for details");

    // Index: notes-a links to folder B's Foo
    index_content_into_folders(
        "uuid-notes-a", &notes_doc, &[&folder_a, &folder_b],
    ).unwrap();
    assert_eq!(read_backlinks(&folder_b, "uuid-foo-b"), vec!["uuid-notes-a"]);

    // Rename folder B's Foo -> Qux
    let (indexer, _rx) = LinkIndexer::new();
    let renames = rename_in_folder(
        &indexer, &folder_b, "folder-b", "/Foo.md", "/Qux.md", "uuid-foo-b",
    );
    assert_eq!(renames.len(), 1);
    assert_eq!(renames[0].old_name, "Foo");
    assert_eq!(renames[0].new_name, "Qux");

    // Apply rename to backlinkers
    apply_renames_to_doc(&renames, &folder_b, "uuid-notes-a", &notes_doc);

    // BUG 1: [[Relay Folder 2/Foo]] should become [[Relay Folder 2/Qux]]
    assert_eq!(
        read_contents(&notes_doc),
        "See [[Relay Folder 2/Qux]] for details",
    );
}

#[test]
fn cross_folder_rename_preserves_anchor() {
    let (folder_a, folder_b) = two_folder_fixture();
    let notes_doc = create_content_doc("See [[Relay Folder 2/Foo#Section]]");

    index_content_into_folders(
        "uuid-notes-a", &notes_doc, &[&folder_a, &folder_b],
    ).unwrap();

    let (indexer, _rx) = LinkIndexer::new();
    let renames = rename_in_folder(
        &indexer, &folder_b, "folder-b", "/Foo.md", "/Qux.md", "uuid-foo-b",
    );

    apply_renames_to_doc(&renames, &folder_b, "uuid-notes-a", &notes_doc);

    assert_eq!(
        read_contents(&notes_doc),
        "See [[Relay Folder 2/Qux#Section]]",
    );
}

#[test]
fn cross_folder_rename_preserves_alias() {
    let (folder_a, folder_b) = two_folder_fixture();
    let notes_doc = create_content_doc("See [[Relay Folder 2/Foo|Display]]");

    index_content_into_folders(
        "uuid-notes-a", &notes_doc, &[&folder_a, &folder_b],
    ).unwrap();

    let (indexer, _rx) = LinkIndexer::new();
    let renames = rename_in_folder(
        &indexer, &folder_b, "folder-b", "/Foo.md", "/Qux.md", "uuid-foo-b",
    );

    apply_renames_to_doc(&renames, &folder_b, "uuid-notes-a", &notes_doc);

    assert_eq!(
        read_contents(&notes_doc),
        "See [[Relay Folder 2/Qux|Display]]",
    );
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path=crates/Cargo.toml -p y-sweet-core cross_folder_rename -- --nocapture`

Expected: All 3 FAIL. The content remains unchanged because `compute_wikilink_rename_edits("...", "Foo", "Qux")` produces zero edits — `"Relay Folder 2/Foo" != "Foo"`.

**Step 3: Commit**

```
test: failing tests for cross-folder rename (Bug 1)

Path-qualified links like [[Relay Folder 2/Foo]] are not updated
when Foo is renamed because compute_wikilink_rename_edits does
exact name matching, not basename-suffix matching.
```

---

## Task 4: Same-name disambiguation on rename (Bug 2)

The critical edge case: both folders have "Foo", only one is renamed, and the rename system must not touch the other folder's bare `[[Foo]]` links.

**Files:**
- Modify: `crates/y-sweet-core/src/link_indexer.rs` (add to `cross_folder_rename_tests` submodule)

**Step 1: Write the failing tests**

Add inside `cross_folder_rename_tests`:

```rust
// --- Same-name disambiguation on rename (Bug 2) ---

#[test]
fn rename_same_name_only_updates_correct_links() {
    // notes-a links to BOTH Foos: [[Foo]] (-> foo-a) and [[Relay Folder 2/Foo]] (-> foo-b)
    let (folder_a, folder_b) = two_folder_fixture();
    let notes_doc = create_content_doc("[[Foo]] and [[Relay Folder 2/Foo]]");

    index_content_into_folders(
        "uuid-notes-a", &notes_doc, &[&folder_a, &folder_b],
    ).unwrap();

    // Verify both backlinks exist
    assert_eq!(read_backlinks(&folder_a, "uuid-foo-a"), vec!["uuid-notes-a"]);
    assert_eq!(read_backlinks(&folder_b, "uuid-foo-b"), vec!["uuid-notes-a"]);

    // Rename folder B's Foo -> Qux
    let (indexer, _rx) = LinkIndexer::new();
    let renames = rename_in_folder(
        &indexer, &folder_b, "folder-b", "/Foo.md", "/Qux.md", "uuid-foo-b",
    );
    assert_eq!(renames.len(), 1);

    // Apply rename: only folder B's backlinkers should be updated
    apply_renames_to_doc(&renames, &folder_b, "uuid-notes-a", &notes_doc);

    // Expected: [[Foo]] UNCHANGED (points to folder A's Foo),
    //           [[Relay Folder 2/Foo]] -> [[Relay Folder 2/Qux]]
    assert_eq!(
        read_contents(&notes_doc),
        "[[Foo]] and [[Relay Folder 2/Qux]]",
    );
}

#[test]
fn rename_same_name_from_other_folder_perspective() {
    // journal-b links to [[Foo]] (-> foo-b) and [[Relay Folder 1/Foo]] (-> foo-a)
    let (folder_a, folder_b) = two_folder_fixture();
    let journal_doc = create_content_doc("[[Foo]] and [[Relay Folder 1/Foo]]");

    index_content_into_folders(
        "uuid-journal-b", &journal_doc, &[&folder_a, &folder_b],
    ).unwrap();

    assert_eq!(read_backlinks(&folder_b, "uuid-foo-b"), vec!["uuid-journal-b"]);
    assert_eq!(read_backlinks(&folder_a, "uuid-foo-a"), vec!["uuid-journal-b"]);

    // Rename folder A's Foo -> Baz
    let (indexer, _rx) = LinkIndexer::new();
    let renames = rename_in_folder(
        &indexer, &folder_a, "folder-a", "/Foo.md", "/Baz.md", "uuid-foo-a",
    );
    assert_eq!(renames.len(), 1);

    apply_renames_to_doc(&renames, &folder_a, "uuid-journal-b", &journal_doc);

    // Expected: [[Foo]] UNCHANGED (points to folder B's Foo),
    //           [[Relay Folder 1/Foo]] -> [[Relay Folder 1/Baz]]
    assert_eq!(
        read_contents(&journal_doc),
        "[[Foo]] and [[Relay Folder 1/Baz]]",
    );
}

#[test]
fn rename_same_name_bare_link_updated_in_own_folder() {
    // journal-b links to [[Foo]] which resolves to folder B's Foo (same-folder)
    let (folder_a, folder_b) = two_folder_fixture();
    let journal_doc = create_content_doc("See [[Foo]]");

    index_content_into_folders(
        "uuid-journal-b", &journal_doc, &[&folder_a, &folder_b],
    ).unwrap();

    assert_eq!(read_backlinks(&folder_b, "uuid-foo-b"), vec!["uuid-journal-b"]);

    // Rename folder B's Foo -> Qux
    let (indexer, _rx) = LinkIndexer::new();
    let renames = rename_in_folder(
        &indexer, &folder_b, "folder-b", "/Foo.md", "/Qux.md", "uuid-foo-b",
    );

    apply_renames_to_doc(&renames, &folder_b, "uuid-journal-b", &journal_doc);

    // Bare [[Foo]] in folder B's own doc SHOULD be updated (same-folder rename)
    assert_eq!(read_contents(&journal_doc), "See [[Qux]]");
}
```

**Step 2: Run tests to verify failures**

Run: `cargo test --manifest-path=crates/Cargo.toml -p y-sweet-core cross_folder_rename -- --nocapture`

Expected failures:
- `rename_same_name_only_updates_correct_links` — **DOUBLE FAIL**: `[[Foo]]` gets wrongly changed to `[[Qux]]` (Bug 2) AND `[[Relay Folder 2/Foo]]` stays unchanged (Bug 1). Result: `"[[Qux]] and [[Relay Folder 2/Foo]]"` instead of `"[[Foo]] and [[Relay Folder 2/Qux]]"`
- `rename_same_name_from_other_folder_perspective` — Same double failure from opposite direction
- `rename_same_name_bare_link_updated_in_own_folder` — **PASS** (same-folder bare link, basename matches correctly)

**Step 3: Commit**

```
test: failing tests for same-name disambiguation on rename (Bug 2)

When both folders have "Foo" and one is renamed, the bare [[Foo]]
link in the other folder's doc gets wrongly updated because
update_wikilinks_in_doc matches by basename without considering
which folder the link actually resolves to.
```

---

## Task 5: Cross-folder rename with relative path links

Test the `../` relative path syntax for cross-folder links.

**Files:**
- Modify: `crates/y-sweet-core/src/link_indexer.rs` (add to `cross_folder_rename_tests` submodule)

**Step 1: Write the failing test**

```rust
// --- Cross-folder rename: relative path links ---

#[test]
fn cross_folder_rename_updates_relative_path_link() {
    let (folder_a, folder_b) = two_folder_fixture();
    // Relative cross-folder link: ../Relay Folder 2/Foo
    let notes_doc = create_content_doc("See [[../Relay Folder 2/Foo]]");

    index_content_into_folders(
        "uuid-notes-a", &notes_doc, &[&folder_a, &folder_b],
    ).unwrap();
    assert_eq!(read_backlinks(&folder_b, "uuid-foo-b"), vec!["uuid-notes-a"]);

    let (indexer, _rx) = LinkIndexer::new();
    let renames = rename_in_folder(
        &indexer, &folder_b, "folder-b", "/Foo.md", "/Qux.md", "uuid-foo-b",
    );

    apply_renames_to_doc(&renames, &folder_b, "uuid-notes-a", &notes_doc);

    assert_eq!(
        read_contents(&notes_doc),
        "See [[../Relay Folder 2/Qux]]",
    );
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path=crates/Cargo.toml -p y-sweet-core cross_folder_rename_updates_relative -- --nocapture`

Expected: FAIL — same root cause as Bug 1 (`"../Relay Folder 2/Foo" != "Foo"`).

**Step 3: Commit**

```
test: failing test for relative cross-folder rename

[[../Relay Folder 2/Foo]] is also missed by rename matching
because the full occ.name includes the relative path prefix.
```

---

## Summary: Expected Test Results

| Test | Expected | Bug |
|------|----------|-----|
| `rename_edits_match_path_qualified_wikilink` (parser) | FAIL | Bug 1 |
| `same_name_bare_link_resolves_within_own_folder` | PASS | — |
| `same_name_cross_folder_explicit_link` | PASS | — |
| `same_name_both_bare_and_cross_folder_links` | PASS | — |
| `same_name_other_folder_bare_link` | PASS | — |
| `cross_folder_rename_updates_path_qualified_link` | FAIL | Bug 1 |
| `cross_folder_rename_preserves_anchor` | FAIL | Bug 1 |
| `cross_folder_rename_preserves_alias` | FAIL | Bug 1 |
| `rename_same_name_only_updates_correct_links` | FAIL | Bug 1 + Bug 2 |
| `rename_same_name_from_other_folder_perspective` | FAIL | Bug 1 + Bug 2 |
| `rename_same_name_bare_link_updated_in_own_folder` | PASS | — |
| `cross_folder_rename_updates_relative_path_link` | FAIL | Bug 1 |

6 PASS, 6 FAIL. All failures are expected and expose the two identified bugs.

## Run Command

```bash
# All new tests
cargo test --manifest-path=crates/Cargo.toml -p y-sweet-core cross_folder_rename -- --nocapture
cargo test --manifest-path=crates/Cargo.toml -p y-sweet-core rename_edits_match_path_qualified -- --nocapture

# Full suite (verify no regressions from test additions)
cargo test --manifest-path=crates/Cargo.toml -p y-sweet-core -- --nocapture
```
