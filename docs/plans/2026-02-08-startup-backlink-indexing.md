# Startup Backlink Indexing — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** On server startup, load all documents from storage and reindex all backlinks so `backlinks_v0` is fully populated before the first client connects.

**Architecture:** Add a `load_all_docs()` method to `Server` that enumerates doc IDs from the storage backend and calls `load_doc()` for each. Then call the existing indexing pipeline (renamed to `reindex_all_backlinks()`) which iterates loaded docs and runs `index_document()` on each. Both methods are called in `main.rs` between server creation and `axum::serve`.

**Tech Stack:** Rust, yrs (Y.Doc CRDT), tokio (async), DashMap (concurrent map), y-sweet Store trait (filesystem/S3)

---

## Context for Implementer

### Storage Layout

Documents are stored as `{doc_id}/data.ysweet` in the Store backend. The Store trait has:
- `exists(key)` — check if a key exists
- `list(prefix)` — list files within a prefix directory

The filesystem store stores docs at `{base_path}/{doc_id}/data.ysweet`. The `list()` method lists *files* within a directory — so `list("")` returns top-level entries (which are directories, not files). We need a different approach.

### How to Enumerate Doc IDs

**Filesystem store:** Read the base directory, each subdirectory name is a doc_id. Verify by checking `{doc_id}/data.ysweet` exists.

**S3/R2 store:** `list("")` returns all objects. Keys look like `{doc_id}/data.ysweet`. Extract doc_id by stripping the suffix.

The cleanest approach: add a `list_doc_ids()` method to the `Store` trait with a default implementation that uses `exists()`, and override it in each store backend. But that's invasive.

**Simpler approach:** Add the enumeration to `Server` directly. The server already knows its store. For filesystem, read the directory. For S3, use the prefix listing. We can add a single method `list_doc_ids()` to the `Store` trait.

### Key Files

| File | What's There | What Changes |
|------|-------------|--------------|
| `crates/y-sweet-core/src/store/mod.rs:87-131` | `Store` trait definition | Add `list_doc_ids()` method |
| `crates/relay/src/stores/filesystem.rs:46-160` | Filesystem `Store` impl | Implement `list_doc_ids()` |
| `crates/y-sweet-core/src/store/s3.rs:340-502` | S3 `Store` impl | Implement `list_doc_ids()` |
| `crates/relay/src/server.rs:165-260` | `Server` struct + `new()` | Add `load_all_docs()` method |
| `crates/relay/src/main.rs:576-609` | Server startup + serve | Call load + reindex before serving |
| `crates/y-sweet-core/src/link_indexer.rs:496-518` | `rebuild_all()` | Rename to `reindex_all_backlinks()` |

---

## Task 1: Rename `rebuild_all` → `reindex_all_backlinks`

### Task 1.1: Rename the method in link_indexer.rs

**Files:**
- Modify: `crates/y-sweet-core/src/link_indexer.rs:495-518`

**Step 1: Rename the method**

Change `pub fn rebuild_all(` to `pub fn reindex_all_backlinks(` at line 496. Also update the doc comment and log messages to say "backlinks" explicitly.

```rust
    /// Reindex all backlinks by scanning every loaded document.
    ///
    /// Iterates all docs in the DashMap, indexes each content doc's wikilinks,
    /// and updates backlinks_v0 in the corresponding folder doc(s).
    /// Call after loading docs from storage on startup.
    pub fn reindex_all_backlinks(
        &self,
        docs: &DashMap<String, DocWithSyncKv>,
    ) -> anyhow::Result<()> {
        tracing::info!("Reindexing all backlinks...");
        let mut indexed = 0;
        let mut skipped = 0;

        for entry in docs.iter() {
            let doc_id = entry.key();
            match self.index_document(doc_id, docs) {
                Ok(()) => indexed += 1,
                Err(_) => skipped += 1, // Not all docs are content docs
            }
        }

        tracing::info!(
            "Backlink reindexing complete: {} content docs indexed, {} skipped",
            indexed,
            skipped
        );
        Ok(())
    }
```

**Step 2: Verify it compiles**

Run: `cargo build --manifest-path=crates/Cargo.toml 2>&1 | tail -5`

Expected: Compiles (method is currently unused, so no callers to break). Warnings about unused method are fine.

**Step 3: Commit**

```bash
jj desc -m "refactor: rename rebuild_all → reindex_all_backlinks for clarity"
jj new
```

---

## Task 2: Add `list_doc_ids()` to Store Trait

### Task 2.1: Add default method to Store trait

**Files:**
- Modify: `crates/y-sweet-core/src/store/mod.rs:87-131`

**Step 1: Add the method with a default implementation**

Add after the `list_versions` method (around line 124), before the `supports_direct_uploads` method:

```rust
    /// List all document IDs in storage.
    ///
    /// Returns doc_ids extracted from storage keys of the form `{doc_id}/data.ysweet`.
    /// Default implementation returns an error; backends should override.
    async fn list_doc_ids(&self) -> Result<Vec<String>> {
        Err(StoreError::UnsupportedOperation(
            "This store does not support listing document IDs".to_string(),
        ))
    }
```

**Step 2: Verify it compiles**

Run: `cargo build --manifest-path=crates/Cargo.toml 2>&1 | tail -5`

Expected: Compiles. Default impl means no existing backends break.

**Step 3: Commit**

```bash
jj desc -m "feat: add list_doc_ids() to Store trait with default impl"
jj new
```

### Task 2.2: Implement list_doc_ids for FileSystemStore

**Files:**
- Modify: `crates/relay/src/stores/filesystem.rs:46-160`

**Step 1: Implement the method**

Add inside the `impl Store for FileSystemStore` block, after `list()`:

```rust
    async fn list_doc_ids(&self) -> Result<Vec<String>> {
        let dir_entries = match read_dir(&self.base_path) {
            Ok(entries) => entries,
            Err(e) => {
                return Err(StoreError::ConnectionError(format!(
                    "Failed to read store directory: {}",
                    e
                )))
            }
        };

        let mut doc_ids = Vec::new();
        for entry in dir_entries {
            if let Ok(entry) = entry {
                let path = entry.path();
                if path.is_dir() {
                    // Check if this directory contains data.ysweet
                    if path.join("data.ysweet").exists() {
                        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                            doc_ids.push(name.to_string());
                        }
                    }
                }
            }
        }

        Ok(doc_ids)
    }
```

**Step 2: Verify it compiles**

Run: `cargo build --manifest-path=crates/Cargo.toml 2>&1 | tail -5`

Expected: Compiles clean.

**Step 3: Commit**

```bash
jj desc -m "feat: implement list_doc_ids for FileSystemStore"
jj new
```

### Task 2.3: Implement list_doc_ids for S3Store

**Files:**
- Modify: `crates/y-sweet-core/src/store/s3.rs`

There are two S3 Store impls in this file (one standard, one R2-compatible). Both need the method.

**Step 1: Implement for both S3 impls**

Add the method to each `impl Store for S3Store` block. The S3 `list()` method already does prefix listing. We can reuse it:

```rust
    async fn list_doc_ids(&self) -> Result<Vec<String>> {
        // List all objects and extract unique doc IDs from keys like "{doc_id}/data.ysweet"
        // We use the existing list mechanism but need the full key paths
        // For S3, listing with empty prefix returns all objects
        let files = self.list("").await.unwrap_or_default();

        let mut doc_ids: Vec<String> = files
            .iter()
            .filter_map(|f| {
                // Keys returned by list() are already stripped to filenames
                // We need the full path. Since list strips to filename, we need
                // a different approach for S3.
                // Actually, for S3 with prefix "", the returned keys include the full path.
                // Let's check...
                None
            })
            .collect();

        doc_ids
    }
```

**IMPORTANT NOTE:** The S3 `list()` implementation strips keys to just the filename (line 476: `key_parts.last()`). This means we lose the doc_id. For S3, we need to preserve the full key path and extract the doc_id from it.

**Better approach for S3:** Instead of reusing `list()`, duplicate the prefix-listing logic but extract doc_ids from full key paths. Or, modify the existing `list()` to optionally return full paths.

**Simplest approach:** Add a dedicated S3 listing that searches for `data.ysweet` suffix:

```rust
    async fn list_doc_ids(&self) -> Result<Vec<String>> {
        use std::collections::HashSet;

        // List all objects with no prefix to get everything
        // Then extract doc_ids from keys like "doc_id/data.ysweet"
        // or "prefix/doc_id/data.ysweet" if storage prefix is set.
        self.init().await?;

        let prefixed = if let Some(path_prefix) = &self.prefix {
            if path_prefix.ends_with('/') {
                path_prefix.clone()
            } else {
                format!("{}/", path_prefix)
            }
        } else {
            String::new()
        };

        let head_action = self.bucket.head_bucket(Some(&self.credentials));
        let head_url = head_action.sign(Duration::from_secs(60));
        let url_str = head_url.to_string();
        let url = url_str
            .replace("?", "?list-type=2&prefix=")
            .replace("?list-type", "&list-type");
        let url = format!("{}{}", url, urlencoding::encode(&prefixed));

        let request = self.client.request(Method::GET, url);
        let response = request
            .send()
            .await
            .map_err(|e| StoreError::ConnectionError(e.to_string()))?;

        if !response.status().is_success() {
            return Err(StoreError::ConnectionError(format!(
                "Failed to list objects: HTTP {}",
                response.status()
            )));
        }

        let bytes = response
            .bytes()
            .await
            .map_err(|e| StoreError::ConnectionError(e.to_string()))?;
        let text = String::from_utf8_lossy(&bytes);

        let mut reader = quick_xml::Reader::from_str(&text);
        reader.trim_text(true);
        let mut buf = Vec::new();
        let mut doc_ids = HashSet::new();
        let mut in_contents = false;

        loop {
            match reader.read_event_into(&mut buf) {
                Ok(quick_xml::events::Event::Start(e)) => {
                    if e.name().as_ref() == b"Contents" {
                        in_contents = true;
                    } else if e.name().as_ref() == b"Key" && in_contents {
                        if let Ok(text) = reader.read_text(e.name()) {
                            let key = text.to_string();
                            // Strip storage prefix if present
                            let unprefixed = if !prefixed.is_empty() {
                                key.strip_prefix(&prefixed).unwrap_or(&key)
                            } else {
                                &key
                            };
                            // Extract doc_id from "doc_id/data.ysweet"
                            if let Some(doc_id) = unprefixed.strip_suffix("/data.ysweet") {
                                doc_ids.insert(doc_id.to_string());
                            }
                        }
                    }
                }
                Ok(quick_xml::events::Event::End(e)) => {
                    if e.name().as_ref() == b"Contents" {
                        in_contents = false;
                    }
                }
                Ok(quick_xml::events::Event::Eof) => break,
                Err(e) => {
                    return Err(StoreError::ConnectionError(format!(
                        "Error parsing S3 list response: {}",
                        e
                    )));
                }
                _ => {}
            }
            buf.clear();
        }

        Ok(doc_ids.into_iter().collect())
    }
```

**Note:** This duplicates some S3 listing logic. That's acceptable — `list_doc_ids()` has a fundamentally different purpose (extract doc_ids from full key paths) than `list()` (list files within a prefix).

**Step 2: Verify it compiles**

Run: `cargo build --manifest-path=crates/Cargo.toml 2>&1 | tail -5`

**Step 3: Commit**

```bash
jj desc -m "feat: implement list_doc_ids for S3Store"
jj new
```

---

## Task 3: Add `load_all_docs()` to Server

### Task 3.1: Add the method

**Files:**
- Modify: `crates/relay/src/server.rs`

**Step 1: Add load_all_docs method to Server impl**

Add after the `load_doc_with_user` method (after line 444):

```rust
    /// Load all documents from storage into memory.
    ///
    /// Enumerates all doc IDs in the store and calls `load_doc()` for each.
    /// Used on startup to populate the in-memory doc map before reindexing backlinks.
    pub async fn load_all_docs(&self) -> Result<usize> {
        let store = self.store.as_ref()
            .ok_or_else(|| anyhow!("No store configured — cannot load docs from storage"))?;

        let doc_ids = store.list_doc_ids().await
            .map_err(|e| anyhow!("Failed to list doc IDs from storage: {:?}", e))?;

        let total = doc_ids.len();
        tracing::info!("Loading {} documents from storage...", total);

        let mut loaded = 0;
        let mut failed = 0;

        for (i, doc_id) in doc_ids.iter().enumerate() {
            if self.docs.contains_key(doc_id) {
                loaded += 1;
                continue; // Already loaded
            }

            match self.load_doc(doc_id, None).await {
                Ok(()) => {
                    loaded += 1;
                    if (i + 1) % 50 == 0 || i + 1 == total {
                        tracing::info!("  Loaded {}/{} documents", i + 1, total);
                    }
                }
                Err(e) => {
                    tracing::warn!("  Failed to load doc {}: {:?}", doc_id, e);
                    failed += 1;
                }
            }
        }

        tracing::info!(
            "Document loading complete: {} loaded, {} failed, {} total in storage",
            loaded, failed, total
        );
        Ok(loaded)
    }
```

**Step 2: Verify it compiles**

Run: `cargo build --manifest-path=crates/Cargo.toml 2>&1 | tail -5`

Expected: Compiles with possible warning about unused method.

**Step 3: Commit**

```bash
jj desc -m "feat: add Server::load_all_docs() to load all docs from storage"
jj new
```

---

## Task 4: Call Load + Reindex on Startup

### Task 4.1: Add startup reindexing to main.rs

**Files:**
- Modify: `crates/relay/src/main.rs:586-609`

**Step 1: Add the startup calls**

After `let server = Arc::new(server);` (line 589) and before the `let main_handle = tokio::spawn({` (line 591), add:

```rust
            let server = Arc::new(server);

            // Load all documents and reindex backlinks before accepting connections
            if server.store.is_some() {
                match server.load_all_docs().await {
                    Ok(count) => {
                        tracing::info!("Loaded {} documents from storage", count);
                        if let Some(ref indexer) = server.link_indexer {
                            if let Err(e) = indexer.reindex_all_backlinks(&server.docs) {
                                tracing::warn!("Backlink reindexing failed: {:?}", e);
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!("Failed to load docs from storage: {:?}", e);
                        // Continue anyway — docs will be loaded on-demand
                    }
                }
            }

            let main_handle = tokio::spawn({
```

**Note:** `server.store` is `Option<Arc<Box<dyn Store>>>` and is a private field. You'll need to either:
- Make it accessible via a method: `pub fn has_store(&self) -> bool { self.store.is_some() }`
- Or access `link_indexer` and `docs` directly

Check if these fields are accessible from `main.rs`. If `Server` fields are private, add accessor methods. Alternatively, add a `pub async fn startup_reindex(&self)` method to `Server` that encapsulates the entire load + reindex flow.

**Better approach — add a single method to Server:**

```rust
    /// Load all documents from storage and reindex all backlinks.
    ///
    /// Called once on startup, before accepting connections.
    /// No-op if no store is configured (in-memory mode).
    pub async fn startup_reindex(&self) -> Result<()> {
        if self.store.is_none() {
            tracing::info!("No store configured, skipping startup reindex");
            return Ok(());
        }

        let loaded = self.load_all_docs().await?;
        tracing::info!("Loaded {} documents, now reindexing backlinks...", loaded);

        if let Some(ref indexer) = self.link_indexer {
            indexer.reindex_all_backlinks(&self.docs)?;
        }

        Ok(())
    }
```

Then in `main.rs`, just add one line after `let server = Arc::new(server);`:

```rust
            let server = Arc::new(server);

            // Reindex backlinks for all stored documents before accepting connections
            if let Err(e) = server.startup_reindex().await {
                tracing::warn!("Startup reindex failed: {:?}", e);
            }

            let main_handle = tokio::spawn({
```

**Step 2: Verify it compiles and starts**

Run: `cargo build --manifest-path=crates/Cargo.toml --bin relay 2>&1 | tail -5`

Expected: Compiles clean.

**Step 3: Manual smoke test**

Start the server with filesystem store and pre-existing data:

```bash
cargo run --manifest-path=crates/Cargo.toml --bin relay -- serve --port 8090
```

Expected log output should show:
```
Loading N documents from storage...
Loaded N documents, now reindexing backlinks...
Backlink reindexing complete: X content docs indexed, Y skipped
Listening on ws://0.0.0.0:8090
```

**Step 4: Commit**

```bash
jj desc -m "feat: reindex all backlinks on startup from stored documents"
jj new
```

---

## Task 5: Verify End-to-End

### Task 5.1: Run setup + restart + check backlinks

This is a manual verification, not an automated test.

**Step 1: Start server with filesystem storage**

```bash
cargo run --manifest-path=crates/Cargo.toml --bin relay -- serve --port 8090
```

**Step 2: Run setup script to populate test data**

```bash
cd lens-editor && npm run relay:setup
```

**Step 3: Stop and restart server**

Kill the server (Ctrl+C), then restart:

```bash
cargo run --manifest-path=crates/Cargo.toml --bin relay -- serve --port 8090
```

**Step 4: Verify logs show reindexing**

Expected output includes lines like:
```
Loading N documents from storage...
  Loaded N/N documents
Loaded N documents, now reindexing backlinks...
Doc c0000001-...: content length=XXX, wikilinks=["Getting Started", "Notes/Ideas"]
Backlink reindexing complete: X content docs indexed, Y skipped
```

**Step 5: Run integration tests**

```bash
cd lens-editor && npm run test:integration
```

Expected: All 50 tests pass (same as before — live indexing still works, now with startup indexing too).

**Step 6: Start frontend and verify backlinks panel**

```bash
cd lens-editor && npm run dev:local
```

Open browser, navigate to a document that's linked to by other docs. Backlinks panel should show entries immediately (no need to edit anything first).

---

## Summary: Commit Sequence

1. `refactor: rename rebuild_all → reindex_all_backlinks for clarity`
2. `feat: add list_doc_ids() to Store trait with default impl`
3. `feat: implement list_doc_ids for FileSystemStore`
4. `feat: implement list_doc_ids for S3Store`
5. `feat: add Server::load_all_docs() to load all docs from storage`
6. `feat: reindex all backlinks on startup from stored documents`

---

## Caveats and Edge Cases

**In-memory mode (no store):** `startup_reindex()` is a no-op. The server starts with empty docs, and backlinks accumulate as clients connect and edit. This is the current behavior and is correct for dev mode without `relay.toml`.

**Filesystem store with no data yet:** `list_doc_ids()` returns empty list. No docs to load, no backlinks to index. First run after setup will index via live-edit callbacks (current behavior).

**Document load failures:** Individual docs that fail to load are warned and skipped. The server still starts and serves the docs it could load. Backlinks for the failed docs will be missing.

**Large vaults (1000+ docs):** All docs are loaded into memory. This is the same as what would happen if all clients connected simultaneously. If memory becomes a concern, we could add lazy loading — but that's a separate feature.

**Race condition — clients connecting during startup:** The startup reindex runs before `axum::serve`, so no clients can connect until it completes. No race.
