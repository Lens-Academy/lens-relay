# Backlinks Phase 3: Server-Side Link Indexer (Rust)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement a server-side link indexer in relay-server that parses wikilinks from documents and populates the `backlinks_v0` Y.Map in folder documents.

**Architecture:**
- New `link_indexer` module in `y-sweet-core` crate
- Hooks into existing `observe_update_v1` callback
- Maintains in-memory folder-doc reverse index
- Debounced indexing (2 seconds after last edit)
- Writes to `backlinks_v0` Y.Map in folder doc

**Tech Stack:** Rust, yrs (Y.js), tokio (async), DashMap (concurrent HashMap)

**Codebase Location:** `/home/penguin/code-in-WSL/lens-relay-overview/relay-server/`

---

## Critical yrs API Notes

**These patterns differ from Y.js JavaScript API - verified against yrs 0.19.1 docs:**

| What you might expect | Actual yrs API |
|----------------------|----------------|
| `TransactOptions::with_origin("x")` | `doc.transact_mut_with("x")` - origin passed directly |
| `event.origin()` in observer | **Not available** - `UpdateEvent` only has `update: Vec<u8>` |
| `map.get().cast::<T>()` | Pattern match `Out` enum: `Out::Any(Any::String(s))` |
| `awareness.doc()` | `awareness.doc` - it's a field, not a method |
| `value.get("key")` on map entry | Entry is `Out::YMap`, call `.get(&txn, "key")` on it |

**Loop prevention:** Since we can't check origin in observers, use thread-local flag pattern (see Task 5).

---

## Prerequisites for Rust Newcomers

Before starting, understand these Rust patterns used in the codebase:

| Pattern | What it is | Why it's used |
|---------|------------|---------------|
| `Arc<T>` | Atomic Reference Counting | Share ownership across threads |
| `RwLock<T>` | Reader-Writer Lock | Multiple readers OR single writer |
| `DashMap<K,V>` | Concurrent HashMap | Lock-free concurrent access |
| `tokio::spawn` | Async task spawning | Background work without blocking |
| `observe_update_v1` | Y.Doc observer | Callback on every document change |

**Key Files to Read First:**
1. `crates/y-sweet-core/src/doc_sync.rs` (120 lines) - Y.Doc wrapping pattern
2. `crates/relay/src/server.rs:439-494` - Background worker pattern
3. `crates/y-sweet-core/src/event.rs` - Event dispatcher pattern

---

## Task 0: Setup and Verify Build

### Task 0.1: Verify Rust Environment

**Step 1: Check Rust installation**

```bash
cd /home/penguin/code-in-WSL/lens-relay-overview/relay-server
rustc --version
cargo --version
```

Expected: Rust 1.70+ installed

**Step 2: Build the project**

```bash
cargo build
```

Expected: Builds successfully (may take a few minutes first time)

**Step 3: Run existing tests**

```bash
cargo test
```

Expected: All tests pass

---

## Task 1: Link Parser Module

Create a pure function module for parsing wikilinks from markdown. This is the easiest part - no async, no state, just string processing.

### Task 1.1: Create Link Parser Test File

**Files:**
- Create: `crates/y-sweet-core/src/link_parser.rs`

**Step 1: Write failing tests first**

```rust
// crates/y-sweet-core/src/link_parser.rs

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_simple_wikilink() {
        let result = extract_wikilinks("[[Note]]");
        assert_eq!(result, vec!["Note"]);
    }

    #[test]
    fn returns_empty_for_no_links() {
        let result = extract_wikilinks("plain text");
        assert_eq!(result, Vec::<String>::new());
    }

    #[test]
    fn extracts_multiple_wikilinks() {
        let result = extract_wikilinks("[[One]] and [[Two]]");
        assert_eq!(result, vec!["One", "Two"]);
    }

    #[test]
    fn strips_anchor_from_link() {
        let result = extract_wikilinks("[[Note#Section]]");
        assert_eq!(result, vec!["Note"]);
    }

    #[test]
    fn strips_alias_from_link() {
        let result = extract_wikilinks("[[Note|Display Text]]");
        assert_eq!(result, vec!["Note"]);
    }

    #[test]
    fn handles_anchor_and_alias() {
        let result = extract_wikilinks("[[Note#Section|Display]]");
        assert_eq!(result, vec!["Note"]);
    }

    #[test]
    fn ignores_empty_brackets() {
        let result = extract_wikilinks("[[]]");
        assert_eq!(result, Vec::<String>::new());
    }

    #[test]
    fn ignores_links_in_code_blocks() {
        let markdown = "```\n[[CodeLink]]\n```\nOutside [[RealLink]]";
        let result = extract_wikilinks(markdown);
        assert_eq!(result, vec!["RealLink"]);
    }

    #[test]
    fn ignores_links_in_inline_code() {
        let result = extract_wikilinks("See `[[Fake]]` but [[Real]]");
        assert_eq!(result, vec!["Real"]);
    }
}

/// Extract wikilink targets from markdown text.
/// Returns page names only (strips anchors and aliases).
/// Ignores links inside code blocks and inline code.
pub fn extract_wikilinks(markdown: &str) -> Vec<String> {
    // TODO: Implement
    vec![]
}
```

**Step 2: Run tests to verify they fail**

```bash
cargo test link_parser
```

Expected: 8 of 9 tests fail (empty returns empty, so that passes)

**Step 3: Commit failing tests**

```bash
jj describe -m "test(RED): add link parser tests for wikilink extraction"
```

---

### Task 1.2: Implement Link Parser

**Files:**
- Modify: `crates/y-sweet-core/src/link_parser.rs`

**Step 1: Add regex dependency to Cargo.toml**

```bash
# Check if regex is already a dependency
grep -n "regex" crates/y-sweet-core/Cargo.toml
```

If not present, add to `crates/y-sweet-core/Cargo.toml`:

```toml
[dependencies]
regex = "1"
```

**Step 2: Implement the parser**

```rust
use regex::Regex;
use std::sync::LazyLock;

// Compile regex once, reuse across calls
static WIKILINK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\[\[([^\]]+)\]\]").unwrap()
});

static FENCED_CODE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)```[^\n]*\n.*?```|~~~[^\n]*\n.*?~~~").unwrap()
});

static INLINE_CODE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"`[^`]*`").unwrap()
});

/// Extract wikilink targets from markdown text.
/// Returns page names only (strips anchors and aliases).
/// Ignores links inside code blocks and inline code.
pub fn extract_wikilinks(markdown: &str) -> Vec<String> {
    // Strip code blocks first
    let without_fenced = FENCED_CODE_RE.replace_all(markdown, "");
    let without_code = INLINE_CODE_RE.replace_all(&without_fenced, "");

    let mut links = Vec::new();

    for cap in WIKILINK_RE.captures_iter(&without_code) {
        let mut content = cap[1].to_string();

        // Skip empty
        if content.trim().is_empty() {
            continue;
        }

        // Strip alias (|) - take only the part before |
        if let Some(pipe_idx) = content.find('|') {
            content = content[..pipe_idx].to_string();
        }

        // Strip anchor (#) - take only the part before #
        if let Some(hash_idx) = content.find('#') {
            content = content[..hash_idx].to_string();
        }

        let trimmed = content.trim().to_string();
        if !trimmed.is_empty() {
            links.push(trimmed);
        }
    }

    links
}
```

**Step 3: Run tests to verify they pass**

```bash
cargo test link_parser
```

Expected: All 9 tests pass

**Step 4: Commit**

```bash
jj describe -m "feat(GREEN): implement wikilink extraction with code block handling"
jj new
```

---

### Task 1.3: Register Module in lib.rs

**Files:**
- Modify: `crates/y-sweet-core/src/lib.rs`

**Step 1: Add module declaration**

Find the module declarations in `lib.rs` and add:

```rust
pub mod link_parser;
```

**Step 2: Verify it compiles**

```bash
cargo build -p y-sweet-core
```

**Step 3: Commit**

```bash
jj describe -m "chore: register link_parser module"
jj new
```

---

## Task 2: Folder-Doc Reverse Index

The server currently has NO way to know which folder a content doc belongs to. We need to build an in-memory reverse index: `doc_uuid -> folder_id`.

### Task 2.1: Design the Reverse Index

**Key Insight:** When a content doc is edited, we need to:
1. Look up which folder it belongs to
2. Find the folder's `filemeta_v0` to resolve link names to UUIDs
3. Update that folder's `backlinks_v0`

**Data Structure:**

```rust
// Maps content doc UUID -> folder doc ID
// Example: "076d2f81-..." -> "fbd5eb54-..."
type DocFolderIndex = Arc<DashMap<String, String>>;
```

**Population Strategy:**
- When a folder doc loads, scan its `filemeta_v0` Y.Map
- For each entry, add `doc_uuid -> folder_id` to the index
- Watch `filemeta_v0` for changes (new docs, deletions)

---

### Task 2.2: Create Folder Index Module

**Files:**
- Create: `crates/y-sweet-core/src/folder_index.rs`

**Step 1: Write the module with tests**

```rust
// crates/y-sweet-core/src/folder_index.rs

use dashmap::DashMap;
use std::sync::Arc;

/// In-memory index mapping document UUIDs to their parent folder IDs.
///
/// This is needed because content doc IDs (e.g., "relay-id-doc-uuid") don't
/// contain the folder ID. When a content doc is updated, we need to know
/// which folder's backlinks_v0 to update.
#[derive(Clone)]
pub struct FolderIndex {
    // doc_uuid -> folder_id
    index: Arc<DashMap<String, String>>,
}

impl FolderIndex {
    pub fn new() -> Self {
        Self {
            index: Arc::new(DashMap::new()),
        }
    }

    /// Register a document as belonging to a folder.
    pub fn register(&self, doc_uuid: &str, folder_id: &str) {
        self.index.insert(doc_uuid.to_string(), folder_id.to_string());
    }

    /// Unregister a document (when deleted from folder).
    pub fn unregister(&self, doc_uuid: &str) {
        self.index.remove(doc_uuid);
    }

    /// Look up which folder a document belongs to.
    pub fn get_folder(&self, doc_uuid: &str) -> Option<String> {
        self.index.get(doc_uuid).map(|r| r.value().clone())
    }

    /// Get all documents in a folder.
    pub fn get_docs_in_folder(&self, folder_id: &str) -> Vec<String> {
        self.index
            .iter()
            .filter(|entry| entry.value() == folder_id)
            .map(|entry| entry.key().clone())
            .collect()
    }
}

impl Default for FolderIndex {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_and_retrieves_folder() {
        let index = FolderIndex::new();
        index.register("doc-123", "folder-abc");

        assert_eq!(index.get_folder("doc-123"), Some("folder-abc".to_string()));
    }

    #[test]
    fn returns_none_for_unknown_doc() {
        let index = FolderIndex::new();

        assert_eq!(index.get_folder("unknown"), None);
    }

    #[test]
    fn unregisters_doc() {
        let index = FolderIndex::new();
        index.register("doc-123", "folder-abc");
        index.unregister("doc-123");

        assert_eq!(index.get_folder("doc-123"), None);
    }

    #[test]
    fn gets_all_docs_in_folder() {
        let index = FolderIndex::new();
        index.register("doc-1", "folder-a");
        index.register("doc-2", "folder-a");
        index.register("doc-3", "folder-b");

        let mut docs = index.get_docs_in_folder("folder-a");
        docs.sort();

        assert_eq!(docs, vec!["doc-1", "doc-2"]);
    }
}
```

**Step 2: Run tests**

```bash
cargo test folder_index
```

Expected: All 4 tests pass

**Step 3: Register module in lib.rs**

Add to `crates/y-sweet-core/src/lib.rs`:

```rust
pub mod folder_index;
```

**Step 4: Commit**

```bash
jj describe -m "feat: add FolderIndex for doc-to-folder mapping"
jj new
```

---

### Task 2.3: Populate Index When Folder Doc Loads

**Challenge:** We need to hook into folder doc loading to populate the index.

**Files:**
- Modify: `crates/relay/src/server.rs`

**Step 0: Write failing test first (RED phase)**

```rust
#[cfg(test)]
mod folder_population_tests {
    use super::*;
    use yrs::{Doc, Map, Transact};

    #[test]
    fn populates_folder_index_from_filemeta() {
        let folder_index = FolderIndex::new();
        let doc = Doc::new();

        // Simulate filemeta_v0 structure
        {
            let mut txn = doc.transact_mut();
            let filemeta = txn.get_or_insert_map("filemeta_v0");

            // Create nested map for each entry
            let welcome_meta = txn.get_or_insert_map("_temp_welcome");
            welcome_meta.insert(&mut txn, "id", "uuid-welcome");
            welcome_meta.insert(&mut txn, "type", "markdown");
            // Move to filemeta (simplified - actual API may differ)
        }

        // After loading, folder_index should contain the mappings
        // This test will fail until we implement the population logic
        assert_eq!(
            folder_index.get_folder("uuid-welcome"),
            Some("folder-id".to_string())
        );
    }
}
```

Run to verify it fails: `cargo test folder_population_tests`

**Step 1: Identify the folder doc pattern**

Folder docs have IDs like `{relay_id}-{folder_id}`. They contain `filemeta_v0` Y.Map.

**Step 2: Add FolderIndex to Server struct**

In `server.rs`, find the `Server` struct definition and add:

```rust
use y_sweet_core::folder_index::FolderIndex;

pub struct Server {
    // ... existing fields ...
    folder_index: FolderIndex,
}
```

**Step 3: Initialize in Server::new()**

Find `Server::new()` and add initialization:

```rust
folder_index: FolderIndex::new(),
```

**Step 4: Populate index when folder doc loads**

Find where documents are loaded (likely in `load_doc` or `get_or_create_doc`). After loading, check if it's a folder doc by trying to read `filemeta_v0`:

```rust
use yrs::{Any, Out, Transact};

// After loading doc, check if it's a folder doc
if let Some(dwskv) = self.docs.get(doc_id) {
    let awareness_arc = dwskv.awareness();
    let awareness_guard = awareness_arc.read().unwrap();
    // NOTE: Awareness has a `doc` field, not a doc() method
    let txn = awareness_guard.doc.transact();

    // Try to get filemeta_v0 - if it exists, this is a folder doc
    if let Some(filemeta) = txn.get_map("filemeta_v0") {
        // Extract folder_id from doc_id using our parser
        if let Some((relay_id, folder_id)) = parse_doc_id(doc_id) {
            // Iterate entries and register each document
            // NOTE: iter() returns (&str, Out) tuples
            for (path, value) in filemeta.iter(&txn) {
                // filemeta_v0 values are nested Y.Maps: { id, type, version }
                if let Out::YMap(meta_map) = value {
                    if let Some(Out::Any(Any::String(ref doc_uuid))) = meta_map.get(&txn, "id") {
                        self.folder_index.register(doc_uuid, folder_id);
                    }
                }
            }
        }
    }
}
```

**Note:** The `filemeta_v0` entries are Y.Maps with structure `{ id: "uuid", type: "markdown", version: 0 }`. See `src/test/fixtures/folder-metadata/production-sample.json` for real examples.

**Step 5: Commit**

```bash
jj describe -m "feat: populate FolderIndex when folder docs load"
jj new
```

---

## Task 3: Link Indexer with Debouncing

### Task 3.1: Create Link Indexer Module

**Files:**
- Create: `crates/y-sweet-core/src/link_indexer.rs`

**Step 1: Define the structure**

```rust
// crates/y-sweet-core/src/link_indexer.rs

use crate::folder_index::FolderIndex;
use crate::link_parser::extract_wikilinks;
use dashmap::DashMap;
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::time::{Duration, Instant};

const DEBOUNCE_DURATION: Duration = Duration::from_secs(2);

/// Parse a doc_id into (relay_id, doc_uuid).
///
/// Format: "relay_id-doc_uuid" where both are UUIDs (36 chars: 8-4-4-4-12)
/// Example: "cb696037-0f72-4e93-8717-4e433129d789-f7c85d0f-8bb4-4a03-80b5-408498d77c52"
///
/// Returns None if the format is invalid.
fn parse_doc_id(doc_id: &str) -> Option<(&str, &str)> {
    // UUID is 36 chars: 8-4-4-4-12 with hyphens
    // Full doc_id is: 36 (relay_id) + 1 (hyphen) + 36 (doc_uuid) = 73 chars
    if doc_id.len() >= 73 && doc_id.chars().nth(36) == Some('-') {
        let relay_id = &doc_id[..36];
        let doc_uuid = &doc_id[37..];
        Some((relay_id, doc_uuid))
    } else {
        None
    }
}

#[cfg(test)]
mod parse_tests {
    use super::*;

    #[test]
    fn parses_valid_doc_id() {
        let doc_id = "cb696037-0f72-4e93-8717-4e433129d789-f7c85d0f-8bb4-4a03-80b5-408498d77c52";
        let result = parse_doc_id(doc_id);
        assert_eq!(result, Some((
            "cb696037-0f72-4e93-8717-4e433129d789",
            "f7c85d0f-8bb4-4a03-80b5-408498d77c52"
        )));
    }

    #[test]
    fn returns_none_for_invalid_format() {
        assert_eq!(parse_doc_id("too-short"), None);
        assert_eq!(parse_doc_id(""), None);
    }
}

/// Indexes wikilinks across documents and maintains backlinks index.
///
/// When a document is updated:
/// 1. Debounce for 2 seconds (wait for user to stop typing)
/// 2. Parse the document for [[wikilinks]]
/// 3. Resolve link names to UUIDs using folder's filemeta_v0
/// 4. Update backlinks_v0 Y.Map in the folder doc
pub struct LinkIndexer {
    folder_index: FolderIndex,

    // Pending updates: doc_id -> last_update_time
    pending: Arc<DashMap<String, Instant>>,

    // Channel to trigger indexing
    index_tx: mpsc::Sender<String>,
}

impl LinkIndexer {
    pub fn new(folder_index: FolderIndex) -> (Self, mpsc::Receiver<String>) {
        let (index_tx, index_rx) = mpsc::channel(1000);

        (
            Self {
                folder_index,
                pending: Arc::new(DashMap::new()),
                index_tx,
            },
            index_rx,
        )
    }

    /// Called when a document is updated.
    /// Debounces and queues for indexing.
    pub async fn on_document_update(&self, doc_id: &str) {
        self.pending.insert(doc_id.to_string(), Instant::now());

        // Notify the worker
        let _ = self.index_tx.send(doc_id.to_string()).await;
    }

    /// Check if a document is ready to be indexed (debounce elapsed).
    pub fn is_ready(&self, doc_id: &str) -> bool {
        if let Some(entry) = self.pending.get(doc_id) {
            entry.elapsed() >= DEBOUNCE_DURATION
        } else {
            false
        }
    }

    /// Mark a document as indexed (remove from pending).
    pub fn mark_indexed(&self, doc_id: &str) {
        self.pending.remove(doc_id);
    }
}

// NOTE: Debounce mechanism tests (is_ready, timer reset) removed in v3.
// Debouncing is an implementation detail. The real behavior is tested via
// unit+1 tests in Task 7 that verify indexing outcomes with real Y.Docs.
```

**Step 2: Run tests**

```bash
cargo test link_indexer
```

**Step 3: Commit**

```bash
jj describe -m "feat: add LinkIndexer with debouncing"
jj new
```

---

### Task 3.2: Implement Index Worker and Testable Core

The index worker runs as a background task. The core indexing logic is extracted into
a function that takes bare `&Doc` references — this makes it directly testable with
real Y.Docs without needing the full server stack (unit+1 approach).

**Design principle:** Separate "unwrap server types" from "do the indexing." The server
glue extracts `Doc` from `DocWithSyncKv`; the core function works with plain Y.Docs.

**Files:**
- Modify: `crates/y-sweet-core/src/link_indexer.rs`

**Step 1: Add the testable core function**

```rust
/// Core indexing logic — operates on bare Y.Docs for testability.
///
/// This is the function that unit+1 tests exercise directly.
/// The server worker unwraps DocWithSyncKv → Doc before calling this.
pub fn index_content_into_folder(
    source_uuid: &str,
    content_doc: &Doc,    // has Y.Text("contents")
    folder_doc: &Doc,     // has filemeta_v0 and backlinks_v0
) -> anyhow::Result<()> {
    use yrs::{Any, Out, Transact};

    // 1. Extract markdown content
    let markdown = {
        let txn = content_doc.transact();
        if let Some(contents) = txn.get_text("contents") {
            contents.get_string(&txn)
        } else {
            return Ok(()); // No content, nothing to index
        }
    };

    // 2. Parse wikilinks
    let link_names = extract_wikilinks(&markdown);

    // 3. Resolve link names to UUIDs using filemeta_v0
    let target_uuids = {
        let txn = folder_doc.transact();
        let filemeta = txn.get_map("filemeta_v0")
            .ok_or_else(|| anyhow::anyhow!("No filemeta_v0 in folder doc"))?;
        resolve_links_to_uuids(&link_names, &filemeta, &txn)
    };

    // 4. Diff-update backlinks_v0 (add new, remove stale)
    let _guard = IndexingGuard::new();
    let mut txn = folder_doc.transact_mut_with("link-indexer");
    let backlinks = txn.get_or_insert_map("backlinks_v0");

    let new_targets: HashSet<&str> = target_uuids.iter().map(|s| s.as_str()).collect();

    // Add source to each target's backlinks
    for target_uuid in &target_uuids {
        let current: Vec<String> = read_backlinks_array(&backlinks, &txn, target_uuid);

        if !current.contains(&source_uuid.to_string()) {
            let mut updated = current;
            updated.push(source_uuid.to_string());
            let arr: Vec<Any> = updated.into_iter().map(|s| Any::String(s.into())).collect();
            backlinks.insert(&mut txn, target_uuid.as_str(), arr);
        }
    }

    // Remove source from targets it no longer links to (stale cleanup)
    let all_keys: Vec<String> = backlinks.keys(&txn).map(|k| k.to_string()).collect();
    for key in all_keys {
        if new_targets.contains(key.as_str()) {
            continue; // Still linked, skip
        }
        let current: Vec<String> = read_backlinks_array(&backlinks, &txn, &key);
        if current.contains(&source_uuid.to_string()) {
            let updated: Vec<String> = current.into_iter()
                .filter(|s| s != source_uuid)
                .collect();
            if updated.is_empty() {
                backlinks.remove(&mut txn, &key);
            } else {
                let arr: Vec<Any> = updated.into_iter().map(|s| Any::String(s.into())).collect();
                backlinks.insert(&mut txn, key.as_str(), arr);
            }
        }
    }

    Ok(())
}
```

**Step 2: Add the server worker that delegates to the core function**

```rust
impl LinkIndexer {
    // ... existing methods ...

    /// Background worker that processes the indexing queue.
    pub async fn run_worker(
        self: Arc<Self>,
        mut rx: mpsc::Receiver<String>,
        docs: Arc<DashMap<String, DocWithSyncKv>>,
    ) {
        loop {
            match rx.recv().await {
                Some(doc_id) => {
                    tokio::time::sleep(DEBOUNCE_DURATION).await;

                    if self.is_ready(&doc_id) {
                        if let Err(e) = self.index_document(&doc_id, &docs) {
                            tracing::error!("Failed to index {}: {:?}", doc_id, e);
                        }
                        self.mark_indexed(&doc_id);
                    }
                }
                None => break,
            }
        }
    }

    /// Server glue: unwraps DocWithSyncKv, delegates to core function.
    fn index_document(
        &self,
        doc_id: &str,
        docs: &DashMap<String, DocWithSyncKv>,
    ) -> anyhow::Result<()> {
        let (relay_id, doc_uuid) = parse_doc_id(doc_id)
            .ok_or_else(|| anyhow::anyhow!("Invalid doc_id format: {}", doc_id))?;

        let folder_id = self.folder_index.get_folder(doc_uuid)
            .ok_or_else(|| anyhow::anyhow!("No folder found for doc: {}", doc_uuid))?;

        let dwskv = docs.get(doc_id)
            .ok_or_else(|| anyhow::anyhow!("Document not found: {}", doc_id))?;
        let folder_doc_id = format!("{}-{}", relay_id, folder_id);
        let folder_dwskv = docs.get(&folder_doc_id)
            .ok_or_else(|| anyhow::anyhow!("Folder doc not found: {}", folder_doc_id))?;

        // Unwrap server types → bare Y.Docs → call testable core
        let content_awareness = dwskv.awareness();
        let content_guard = content_awareness.read().unwrap();
        let folder_awareness = folder_dwskv.awareness();
        let folder_guard = folder_awareness.read().unwrap();

        index_content_into_folder(doc_uuid, &content_guard.doc, &folder_guard.doc)
    }

    /// Update backlinks_v0 Y.Map in the folder doc.
    async fn update_backlinks(
        &self,
        source_uuid: &str,
        link_names: &[String],
        folder_dwskv: &DocWithSyncKv,
    ) -> anyhow::Result<()> {
        use yrs::{Any, Out, Transact};

        // Set flag to prevent re-indexing our own writes
        let _guard = IndexingGuard::new();

        let awareness = folder_dwskv.awareness();
        let guard = awareness.write().unwrap();
        // NOTE: Awareness has a `doc` field, not a doc() method
        let doc = &guard.doc;

        // Resolve link names to UUIDs using filemeta_v0
        let target_uuids = {
            let txn = doc.transact();
            let filemeta = txn.get_map("filemeta_v0")
                .ok_or_else(|| anyhow::anyhow!("No filemeta_v0 in folder doc"))?;

            self.resolve_links_to_uuids(&link_names, &filemeta, &txn)
        };

        // Update backlinks_v0
        // NOTE: transact_mut_with() takes origin directly, not TransactOptions
        let mut txn = doc.transact_mut_with("link-indexer");
        let backlinks = txn.get_or_insert_map("backlinks_v0");

        for target_uuid in target_uuids {
            // Get current backlinks for this target
            // NOTE: yrs returns Out enum, must pattern match
            let current: Vec<String> = backlinks
                .get(&txn, &target_uuid)
                .and_then(|v| {
                    if let Out::Any(Any::Array(arr)) = v {
                        Some(arr.iter().filter_map(|item| {
                            if let Any::String(s) = item {
                                Some(s.to_string())
                            } else {
                                None
                            }
                        }).collect())
                    } else {
                        None
                    }
                })
                .unwrap_or_default();

            // Add source if not already present
            if !current.contains(&source_uuid.to_string()) {
                let mut updated = current;
                updated.push(source_uuid.to_string());
                // Convert Vec<String> to yrs-compatible value
                let arr: Vec<Any> = updated.into_iter().map(|s| Any::String(s.into())).collect();
                backlinks.insert(&mut txn, target_uuid, arr);
            }
        }

        Ok(())
    }

    /// Resolve link names (e.g., "Note") to UUIDs using filemeta_v0.
    ///
    /// filemeta_v0 structure:
    /// ```json
    /// {
    ///   "/Welcome.md": { "id": "uuid-here", "type": "markdown", "version": 0 },
    ///   "/Notes/Ideas.md": { "id": "other-uuid", "type": "markdown", "version": 0 }
    /// }
    /// ```
    fn resolve_links_to_uuids(
        &self,
        link_names: &[String],
        filemeta: &MapRef,
        txn: &Transaction,
    ) -> Vec<String> {
        use yrs::{Any, Out};

        let mut uuids = Vec::new();

        for name in link_names {
            // Try exact match: "/{name}.md"
            let path = format!("/{}.md", name);

            // NOTE: filemeta_v0 values are nested Y.Maps, must handle Out::YMap
            if let Some(Out::YMap(meta_map)) = filemeta.get(txn, &path) {
                if let Some(Out::Any(Any::String(ref id))) = meta_map.get(txn, "id") {
                    uuids.push(id.to_string());
                    continue;
                }
            }

            // Try case-insensitive match
            // NOTE: iter() returns (&str, Out) tuples
            for (entry_path, entry_value) in filemeta.iter(txn) {
                let entry_name = entry_path
                    .strip_prefix('/')
                    .and_then(|s| s.strip_suffix(".md"))
                    .unwrap_or(entry_path);

                if entry_name.to_lowercase() == name.to_lowercase() {
                    // Handle nested Y.Map
                    if let Out::YMap(meta_map) = entry_value {
                        if let Some(Out::Any(Any::String(ref id))) = meta_map.get(txn, "id") {
                            uuids.push(id.to_string());
                            break;
                        }
                    }
                }
            }
        }

        uuids
    }
}
```

**Note:** This code has TODOs and may need adjustment based on actual Y.Doc API. The yrs crate API may differ slightly.

**Step 2: Commit**

```bash
jj describe -m "feat: implement link indexer worker with backlinks update"
jj new
```

---

## Task 4: Hook into Document Updates

### Task 4.1: Add Indexer to Server

**Files:**
- Modify: `crates/relay/src/server.rs`

**Step 1: Add LinkIndexer to Server struct**

```rust
use y_sweet_core::link_indexer::LinkIndexer;

pub struct Server {
    // ... existing fields ...
    folder_index: FolderIndex,
    link_indexer: Arc<LinkIndexer>,
}
```

**Step 2: Initialize in Server::new() and spawn worker**

```rust
// In Server::new():
let folder_index = FolderIndex::new();
let (link_indexer, index_rx) = LinkIndexer::new(folder_index.clone());
let link_indexer = Arc::new(link_indexer);

// Spawn the worker
let docs_clone = docs.clone();
let indexer_clone = link_indexer.clone();
tokio::spawn(async move {
    indexer_clone.run_worker(index_rx, docs_clone).await;
});
```

**Step 3: Hook into document update callback**

Find where the webhook callback is set up (around line 315-339 in server.rs). Add indexer notification:

```rust
// In the webhook callback closure:
if let Some(ref link_indexer) = link_indexer {
    // Clone doc_key for the async block
    let doc_key = doc_key.clone();
    let indexer = link_indexer.clone();
    tokio::spawn(async move {
        indexer.on_document_update(&doc_key).await;
    });
}
```

**Step 4: Commit**

```bash
jj describe -m "feat: hook link indexer into document update events"
jj new
```

---

## Task 5: Loop Prevention (Flag-Based)

### Task 5.1: Prevent Infinite Indexing Loop

When the link indexer updates `backlinks_v0`, it triggers `observe_update_v1`. We need to skip re-indexing when the update came from the indexer itself.

**CRITICAL:** The yrs `UpdateEvent` struct only contains `update: Vec<u8>` - there is **no way to access the transaction origin** from within the observer callback. We must use a flag-based approach instead.

**Files:**
- Modify: `crates/y-sweet-core/src/link_indexer.rs`

**Step 1: Add thread-local flag for loop prevention**

```rust
use std::sync::atomic::{AtomicBool, Ordering};
use std::cell::RefCell;

thread_local! {
    /// Flag to prevent infinite loop when indexer writes trigger observer
    static INDEXING_IN_PROGRESS: RefCell<bool> = RefCell::new(false);
}

/// Check if we should index this update (not from our own write)
pub fn should_index() -> bool {
    INDEXING_IN_PROGRESS.with(|flag| !*flag.borrow())
}

/// Guard that sets flag during indexer writes
pub struct IndexingGuard;

impl IndexingGuard {
    pub fn new() -> Self {
        INDEXING_IN_PROGRESS.with(|flag| *flag.borrow_mut() = true);
        Self
    }
}

impl Drop for IndexingGuard {
    fn drop(&mut self) {
        INDEXING_IN_PROGRESS.with(|flag| *flag.borrow_mut() = false);
    }
}
```

**Step 2: Use guard when writing backlinks**

In `update_backlinks()`, wrap the write operation:

```rust
async fn update_backlinks(
    &self,
    source_uuid: &str,
    link_names: &[String],
    folder_dwskv: &DocWithSyncKv,
) -> anyhow::Result<()> {
    // Set flag to prevent re-indexing our own writes
    let _guard = IndexingGuard::new();

    // ... rest of implementation ...
}
```

**Step 3: Check flag before indexing**

In the observer callback or webhook handler:

```rust
// Before calling on_document_update:
if should_index() {
    indexer.on_document_update(&doc_key).await;
}
```

**Step 4: Commit**

```bash
jj describe -m "fix: use flag-based loop prevention for link indexer"
jj new
```

---

## Task 6: Startup Full Scan

### Task 6.1: Rebuild Index on Server Start

**Files:**
- Modify: `crates/relay/src/main.rs` or `server.rs`

**Step 1: Add rebuild method to LinkIndexer**

```rust
impl LinkIndexer {
    /// Rebuild the entire backlinks index.
    /// Called on server startup.
    pub async fn rebuild_all(
        &self,
        docs: &DashMap<String, DocWithSyncKv>,
    ) -> anyhow::Result<()> {
        tracing::info!("Rebuilding backlinks index...");

        for entry in docs.iter() {
            let doc_id = entry.key();
            if let Err(e) = self.index_document(doc_id, docs).await {
                tracing::warn!("Failed to index {}: {:?}", doc_id, e);
            }
        }

        tracing::info!("Backlinks index rebuild complete");
        Ok(())
    }
}
```

**Step 2: Call rebuild after server initialization**

In `main.rs`, after the server is created but before accepting connections:

```rust
// After loading existing docs from storage
server.link_indexer.rebuild_all(&server.docs).await?;
```

**Step 3: Commit**

```bash
jj describe -m "feat: rebuild backlinks index on server startup"
jj new
```

---

## Task 7: Unit+1 Tests (Shallow Integration)

**Testing philosophy:** Use real direct dependencies (Y.Doc, link_parser, FolderIndex),
mock only at the slow/external boundary (storage, network). These tests exercise the
actual indexing flow — not isolated mechanisms — catching integration bugs that pure
unit tests miss.

**What's real vs mocked:**

| Layer | Real or Mock? | Why |
|-------|--------------|-----|
| Y.Doc, Y.Map, Y.Text (yrs) | **Real** | Direct dependency — the whole point |
| `link_parser` | **Real** | Direct dependency, fast |
| `FolderIndex` | **Real** | Direct dependency, in-memory |
| `DocWithSyncKv` / Server | **Skipped** | Core function takes `&Doc` directly |
| R2 storage / network | **Skipped** | Slow, external |

### Task 7.1: Test Helper — Build Realistic Doc Fixtures

**Files:**
- Modify: `crates/y-sweet-core/src/link_indexer.rs` (in `#[cfg(test)]` module)

**Step 1: Write the test helper**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{Doc, Map, Text, Transact, Any};

    /// Create a folder Y.Doc with filemeta_v0 populated.
    /// entries: &[("/path.md", "uuid")]
    fn create_folder_doc(entries: &[(&str, &str)]) -> Doc {
        let doc = Doc::new();
        {
            let mut txn = doc.transact_mut();
            let filemeta = txn.get_or_insert_map("filemeta_v0");
            for (path, uuid) in entries {
                // filemeta_v0 values are nested Y.Maps: { id, type, version }
                let meta = MapPrelim::from([
                    ("id".to_string(), Any::String((*uuid).into())),
                    ("type".to_string(), Any::String("markdown".into())),
                    ("version".to_string(), Any::Number(0.0)),
                ]);
                filemeta.insert(&mut txn, *path, meta);
            }
        }
        doc
    }

    /// Create a content Y.Doc with Y.Text("contents").
    fn create_content_doc(markdown: &str) -> Doc {
        let doc = Doc::new();
        {
            let mut txn = doc.transact_mut();
            let text = txn.get_or_insert_text("contents");
            text.insert(&mut txn, 0, markdown);
        }
        doc
    }

    /// Read backlinks_v0 for a given target UUID from a folder doc.
    fn read_backlinks(folder_doc: &Doc, target_uuid: &str) -> Vec<String> {
        let txn = folder_doc.transact();
        if let Some(backlinks) = txn.get_map("backlinks_v0") {
            read_backlinks_array(&backlinks, &txn, target_uuid)
        } else {
            vec![]
        }
    }
```

### Task 7.2: Test — Edit Triggers Correct Backlinks

```rust
    #[test]
    fn indexes_wikilink_into_backlinks() {
        // Setup: folder with two docs, content doc links to the other
        let folder_doc = create_folder_doc(&[
            ("/Notes.md", "uuid-notes"),
            ("/Ideas.md", "uuid-ideas"),
        ]);
        let content_doc = create_content_doc("See [[Ideas]] for more");

        // Act: index the content doc
        let result = index_content_into_folder("uuid-notes", &content_doc, &folder_doc);
        assert!(result.is_ok());

        // Assert: Ideas' backlinks contain Notes
        let backlinks = read_backlinks(&folder_doc, "uuid-ideas");
        assert_eq!(backlinks, vec!["uuid-notes"]);
    }
```

**Run:** `cargo test indexes_wikilink_into_backlinks` — should FAIL (function not implemented yet)

### Task 7.3: Test — Adding a Link Updates Backlinks

```rust
    #[test]
    fn reindex_after_adding_link() {
        let folder_doc = create_folder_doc(&[
            ("/Notes.md", "uuid-notes"),
            ("/Ideas.md", "uuid-ideas"),
            ("/Other.md", "uuid-other"),
        ]);
        let content_doc = create_content_doc("See [[Ideas]]");

        // First index
        index_content_into_folder("uuid-notes", &content_doc, &folder_doc).unwrap();

        // Edit: add another link
        {
            let mut txn = content_doc.transact_mut();
            let text = txn.get_or_insert_text("contents");
            let len = text.get_string(&txn).len();
            text.insert(&mut txn, len as u32, " and [[Other]]");
        }

        // Re-index
        index_content_into_folder("uuid-notes", &content_doc, &folder_doc).unwrap();

        // Assert: both targets have Notes as backlink
        assert_eq!(read_backlinks(&folder_doc, "uuid-ideas"), vec!["uuid-notes"]);
        assert_eq!(read_backlinks(&folder_doc, "uuid-other"), vec!["uuid-notes"]);
    }
```

### Task 7.4: Test — Removing a Link Cleans Up Stale Backlinks

**This test reveals the design gap:** The original plan only added backlinks, never
removed stale ones. This test will fail RED and force implementing diff-based cleanup
in `index_content_into_folder`.

```rust
    #[test]
    fn reindex_after_removing_link_cleans_stale() {
        let folder_doc = create_folder_doc(&[
            ("/Notes.md", "uuid-notes"),
            ("/Ideas.md", "uuid-ideas"),
            ("/Other.md", "uuid-other"),
        ]);
        let content_doc = create_content_doc("[[Ideas]] and [[Other]]");

        // First index: both targets have backlinks
        index_content_into_folder("uuid-notes", &content_doc, &folder_doc).unwrap();
        assert_eq!(read_backlinks(&folder_doc, "uuid-ideas"), vec!["uuid-notes"]);
        assert_eq!(read_backlinks(&folder_doc, "uuid-other"), vec!["uuid-notes"]);

        // Edit: remove the Other link
        {
            let mut txn = content_doc.transact_mut();
            let text = txn.get_or_insert_text("contents");
            // Replace entire content
            let len = text.get_string(&txn).len();
            text.remove_range(&mut txn, 0, len as u32);
            text.insert(&mut txn, 0, "[[Ideas]] only now");
        }

        // Re-index
        index_content_into_folder("uuid-notes", &content_doc, &folder_doc).unwrap();

        // Assert: Ideas still has backlink, Other's backlink is gone
        assert_eq!(read_backlinks(&folder_doc, "uuid-ideas"), vec!["uuid-notes"]);
        assert!(read_backlinks(&folder_doc, "uuid-other").is_empty());
    }
```

### Task 7.5: Test — Multiple Sources Link to Same Target

```rust
    #[test]
    fn multiple_sources_to_same_target() {
        let folder_doc = create_folder_doc(&[
            ("/Notes.md", "uuid-notes"),
            ("/Projects.md", "uuid-projects"),
            ("/Ideas.md", "uuid-ideas"),
        ]);
        let notes_doc = create_content_doc("See [[Ideas]]");
        let projects_doc = create_content_doc("Related: [[Ideas]]");

        // Index both source docs
        index_content_into_folder("uuid-notes", &notes_doc, &folder_doc).unwrap();
        index_content_into_folder("uuid-projects", &projects_doc, &folder_doc).unwrap();

        // Assert: Ideas has both as backlinks
        let mut backlinks = read_backlinks(&folder_doc, "uuid-ideas");
        backlinks.sort();
        assert_eq!(backlinks, vec!["uuid-notes", "uuid-projects"]);
    }
```

### Task 7.6: Test — Unresolvable Link is Gracefully Skipped

```rust
    #[test]
    fn unresolvable_link_skipped() {
        let folder_doc = create_folder_doc(&[
            ("/Notes.md", "uuid-notes"),
        ]);
        let content_doc = create_content_doc("See [[NoSuchDoc]]");

        // Should not crash
        let result = index_content_into_folder("uuid-notes", &content_doc, &folder_doc);
        assert!(result.is_ok());

        // Assert: no backlinks created for non-existent target
        let txn = folder_doc.transact();
        let backlinks = txn.get_map("backlinks_v0");
        // backlinks_v0 should either not exist or be empty
        assert!(backlinks.is_none() || backlinks.unwrap().len(&txn) == 0);
    }
```

### Task 7.7: Test — Code Block Links Are Ignored

```rust
    #[test]
    fn ignores_links_in_code_blocks() {
        let folder_doc = create_folder_doc(&[
            ("/Notes.md", "uuid-notes"),
            ("/Fake.md", "uuid-fake"),
            ("/Real.md", "uuid-real"),
        ]);
        let content_doc = create_content_doc("```\n[[Fake]]\n```\n[[Real]]");

        index_content_into_folder("uuid-notes", &content_doc, &folder_doc).unwrap();

        // Assert: Real has backlink, Fake does not
        assert_eq!(read_backlinks(&folder_doc, "uuid-real"), vec!["uuid-notes"]);
        assert!(read_backlinks(&folder_doc, "uuid-fake").is_empty());
    }
```

### Task 7.8: Test — Document With No Links Produces No Backlinks

```rust
    #[test]
    fn no_links_no_backlinks() {
        let folder_doc = create_folder_doc(&[
            ("/Notes.md", "uuid-notes"),
            ("/Other.md", "uuid-other"),
        ]);
        let content_doc = create_content_doc("Just plain text, no links");

        let result = index_content_into_folder("uuid-notes", &content_doc, &folder_doc);
        assert!(result.is_ok());

        // Assert: no backlinks_v0 entries
        assert!(read_backlinks(&folder_doc, "uuid-other").is_empty());
    }

} // end #[cfg(test)] mod tests
```

**Step 2: Run all unit+1 tests**

```bash
cargo test link_indexer::tests
```

**Step 3: Commit**

```bash
jj describe -m "test(RED): add unit+1 tests for link indexer with real Y.Docs"
jj new
```

---

## Summary: Commit Sequence

1. `test(RED): add link parser tests for wikilink extraction`
2. `feat(GREEN): implement wikilink extraction with code block handling`
3. `chore: register link_parser module`
4. `feat: add FolderIndex for doc-to-folder mapping`
5. `feat: populate FolderIndex when folder docs load`
6. `test(RED): add unit+1 tests for link indexer with real Y.Docs`
7. `feat(GREEN): implement index_content_into_folder core function`
8. `feat: add LinkIndexer worker with debouncing`
9. `feat: hook link indexer into document update events`
10. `fix: use flag-based loop prevention for link indexer`
11. `feat: rebuild backlinks index on server startup`

---

## Rust Gotchas for Newcomers

1. **Ownership**: You can't use a value after moving it. Use `.clone()` to make copies.

2. **Arc<T>**: Wrap shared data in `Arc<>` to share between threads. Clone the Arc, not the data.

3. **RwLock poisoning**: If a thread panics while holding a lock, the lock is "poisoned". Use `.unwrap()` carefully.

4. **Async/await**: Functions marked `async` return Futures. Call `.await` to execute them.

5. **Error handling**: Use `?` to propagate errors. Return `Result<T, E>` from fallible functions.

6. **Lifetimes**: References have lifetimes. The compiler enforces that references don't outlive their data.

7. **Traits**: Like interfaces. `impl Trait for Type` to implement. `dyn Trait` for runtime polymorphism.

---

## Testing Strategy (Unit+1)

**Principle:** Use real direct dependencies, mock at the slow/external boundary.

| Component | Test Style | What's Real | What's Skipped | How to Run |
|-----------|-----------|-------------|----------------|------------|
| `link_parser` | Pure unit | Nothing to integrate | N/A | `cargo test link_parser` |
| `folder_index` | Pure unit | Data structure only | N/A | `cargo test folder_index` |
| `parse_doc_id` | Pure unit | String parsing | N/A | `cargo test parse_tests` |
| `index_content_into_folder` | **Unit+1** | Y.Doc, Y.Map, Y.Text, link_parser, FolderIndex | DocWithSyncKv, storage, network | `cargo test link_indexer::tests` |

**Why unit+1 for the indexer:**
- Pure unit tests (testing debounce timers, `is_ready()`) verify mechanism, not behavior
- Unit+1 tests verify the actual outcome: "editing `[[Note]]` produces the right `backlinks_v0` entry"
- Real Y.Docs catch yrs API mismatches that mocks would hide
- Still fast — no storage or network involved

**Design for testability:**
- Core logic in `index_content_into_folder(source_uuid, &Doc, &Doc)` — takes bare Y.Docs
- Server glue in `LinkIndexer::index_document()` — unwraps DocWithSyncKv, delegates to core
- Tests call the core function directly with fixture Y.Docs

**TDD Cycle:**
1. Write failing test (RED) — `cargo test link_indexer::tests` — verify it fails correctly
2. Implement minimal code (GREEN) — just enough to pass
3. Refactor — clean up, keep tests green
4. Commit

---

## Next Steps After Implementation

1. **Deploy to staging** - Test with real Obsidian clients
2. **Monitor performance** - Check indexing latency with metrics
3. **Handle edge cases** - Circular links, deleted docs, renamed docs
4. **Phase 4: Link updating on rename** - Use the backlinks index to update links when files are renamed

---

## Revision History

**2026-02-06 (v3):** Rewrote testing strategy from pure unit to unit+1 (shallow integration):

| Change | Before (v2) | After (v3) |
|--------|------------|------------|
| Indexer tests | Debounce timing (`is_ready` after sleep) | Real Y.Docs: edit content → verify backlinks_v0 |
| Integration tests | Trivial (`extract_wikilinks` + concurrent DashMap) | 7 unit+1 tests covering indexing flow, stale cleanup, edge cases |
| Core function | Coupled to `DocWithSyncKv` | Extracted `index_content_into_folder(&Doc, &Doc)` for testability |
| Stale cleanup | **Missing** — only added backlinks, never removed | Diff-based: removes source from targets no longer linked |
| Test boundary | Mocked everything | Real Y.Doc/Y.Map/Y.Text, skip storage/network only |

**2026-02-05 (v2):** Fixed critical API errors identified in code review:

| Issue | Original (Incorrect) | Fixed |
|-------|---------------------|-------|
| Transaction origin | `TransactOptions::with_origin("x")` | `doc.transact_mut_with("x")` |
| Loop prevention | `event.origin()` check | Thread-local `IndexingGuard` flag |
| Y.Map value access | `.cast::<Vec<String>>()` | Pattern match `Out::Any(Any::Array(...))` |
| Nested map access | `value.get("id")` | `Out::YMap(map)` then `map.get(&txn, "id")` |
| Awareness doc access | `guard.doc()` | `guard.doc` (field, not method) |
| doc_id parsing | `split('-').last()` | Fixed-position parsing for UUIDs |

Added missing RED phase test for Task 2.3.
