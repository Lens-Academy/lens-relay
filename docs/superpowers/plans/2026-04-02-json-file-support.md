# JSON File Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support reading, creating, and editing JSON files (binary blobs) through both the MCP server and the lens-editor UI.

**Architecture:** JSON files are stored as binary blobs in the object store (R2/filesystem), same as images. MCP tools detect file type by extension and branch: markdown uses Y.Text + CriticMarkup, JSON uses direct Store get/set. The editor renders JSON read-only in CodeMirror with JSON syntax highlighting.

**Tech Stack:** Rust (relay server MCP tools), TypeScript/React (lens-editor), CodeMirror `@codemirror/lang-json`, yrs Store trait

**Spec:** `docs/superpowers/specs/2026-04-02-json-file-support-design.md`

---

## File Structure

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `crates/relay/src/mcp/tools/blob.rs` | Shared blob read/write helpers for MCP tools |
| Modify | `crates/relay/src/mcp/tools/mod.rs` | Register blob module, update tool descriptions |
| Modify | `crates/relay/src/mcp/tools/create_doc.rs` | Lift `.md` restriction, branch on extension |
| Modify | `crates/relay/src/mcp/tools/read.rs` | Branch on extension for blob read |
| Modify | `crates/relay/src/mcp/tools/edit.rs` | Branch on extension for blob edit |
| Modify | `crates/relay/src/mcp/tools/grep.rs` | Also search blob content |
| Modify | `crates/relay/src/mcp/tools/test_helpers.rs` | Add blob test helpers |
| Modify | `lens-editor/src/components/Editor/Editor.tsx` | JSON language support, read-only blob rendering |
| Modify | `lens-editor/src/components/Layout/EditorArea.tsx` | Detect file type, pass to Editor |
| Modify | `lens-editor/src/App.tsx` | Route blob files to a blob viewer |
| Modify | `lens-editor/package.json` | Add `@codemirror/lang-json` dependency |

---

## Task 1: Blob read/write helpers (Rust)

Create shared helpers that MCP tools use to read/write binary blob content via the Store trait.

**Files:**
- Create: `crates/relay/src/mcp/tools/blob.rs`
- Modify: `crates/relay/src/mcp/tools/mod.rs` (add `pub mod blob;`)
- Modify: `crates/relay/src/mcp/tools/test_helpers.rs` (add blob helpers)

- [ ] **Step 1: Write failing test for blob round-trip**

In `crates/relay/src/mcp/tools/blob.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::Server;
    use std::sync::Arc;

    /// Build a test server WITH a store (in-memory) for blob operations.
    async fn build_blob_test_server() -> Arc<Server> {
        use async_trait::async_trait;
        use dashmap::DashMap;
        use std::sync::Arc as StdArc;
        use tokio_util::sync::CancellationToken;
        use y_sweet_core::store::Result as StoreResult;
        use y_sweet_core::store::Store;

        struct MemoryStore {
            data: StdArc<DashMap<String, Vec<u8>>>,
        }

        #[async_trait]
        impl Store for MemoryStore {
            async fn init(&self) -> StoreResult<()> { Ok(()) }
            async fn get(&self, key: &str) -> StoreResult<Option<Vec<u8>>> {
                Ok(self.data.get(key).map(|v| v.clone()))
            }
            async fn set(&self, key: &str, value: Vec<u8>) -> StoreResult<()> {
                self.data.insert(key.to_owned(), value);
                Ok(())
            }
            async fn remove(&self, key: &str) -> StoreResult<()> {
                self.data.remove(key);
                Ok(())
            }
            async fn exists(&self, key: &str) -> StoreResult<bool> {
                Ok(self.data.contains_key(key))
            }
        }

        let store = Box::new(MemoryStore {
            data: StdArc::new(DashMap::new()),
        });

        use std::time::Duration;
        let server = Server::new_without_workers(
            Some(store),
            Duration::from_secs(60),
            None, None, Vec::new(),
            CancellationToken::new(),
            false, None,
        ).await.unwrap();

        Arc::new(server)
    }

    #[tokio::test]
    async fn blob_write_then_read_roundtrip() {
        let server = build_blob_test_server().await;
        let doc_id = "test-doc-id";
        let content = r#"{"hello": "world"}"#;

        let hash = write_blob(&server, doc_id, content.as_bytes()).await.unwrap();
        let read_back = read_blob(&server, doc_id, &hash).await.unwrap();

        assert_eq!(read_back, content.as_bytes());
    }

    #[tokio::test]
    async fn blob_read_nonexistent_returns_error() {
        let server = build_blob_test_server().await;
        let result = read_blob(&server, "doc", "badhash").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn blob_write_no_store_returns_error() {
        let server = Server::new_for_test(); // no store
        let result = write_blob(&server, "doc", b"data").await;
        assert!(result.is_err());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml --lib mcp::tools::blob -- --nocapture 2>&1 | tail -20`
Expected: FAIL — `blob` module doesn't exist yet.

- [ ] **Step 3: Register blob module in mod.rs**

In `crates/relay/src/mcp/tools/mod.rs`, add after line 1:

```rust
pub mod blob;
```

- [ ] **Step 4: Implement blob helpers**

Create `crates/relay/src/mcp/tools/blob.rs`:

```rust
use crate::server::Server;
use sha2::{Digest, Sha256};
use std::sync::Arc;

/// Compute SHA256 hex hash of content.
pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

/// Read a blob from the object store by doc_id and file hash.
pub async fn read_blob(
    server: &Arc<Server>,
    doc_id: &str,
    file_hash: &str,
) -> Result<Vec<u8>, String> {
    let store = server
        .store
        .as_ref()
        .ok_or_else(|| "No object store configured — blob operations require R2 or filesystem store".to_string())?;

    let key = format!("files/{}/{}", doc_id, file_hash);
    store
        .get(&key)
        .await
        .map_err(|e| format!("Store read error: {}", e))?
        .ok_or_else(|| format!("Blob not found: {}/{}", doc_id, file_hash))
}

/// Write a blob to the object store. Returns the SHA256 hash.
pub async fn write_blob(
    server: &Arc<Server>,
    doc_id: &str,
    data: &[u8],
) -> Result<String, String> {
    let store = server
        .store
        .as_ref()
        .ok_or_else(|| "No object store configured — blob operations require R2 or filesystem store".to_string())?;

    let hash = sha256_hex(data);
    let key = format!("files/{}/{}", doc_id, hash);
    store
        .set(&key, data.to_vec())
        .await
        .map_err(|e| format!("Store write error: {}", e))?;

    Ok(hash)
}

/// Check if a path is a blob file (non-markdown text file we handle as blob).
pub fn is_blob_file(path: &str) -> bool {
    path.ends_with(".json")
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml --lib mcp::tools::blob -- --nocapture 2>&1 | tail -20`
Expected: 3 tests pass.

- [ ] **Step 6: Check `store` field visibility**

The `server.store` field is currently `store: Option<Arc<Box<dyn Store>>>` (not `pub`). If it's private, add a getter method. Check with:

```bash
grep -n "pub.*store\|store:" crates/relay/src/server.rs | head -5
```

If private, add to the `impl Server` block (near the other getters like `docs()`, `doc_resolver()`):

```rust
pub fn store(&self) -> Option<&Arc<Box<dyn Store>>> {
    self.store.as_ref()
}
```

And update `blob.rs` to use `server.store()` instead of `server.store`.

- [ ] **Step 7: Commit**

```bash
jj new -m "feat(mcp): add blob read/write helpers for binary file support"
```

Wait — we should commit current work first:

```bash
jj describe -m "feat(mcp): add blob read/write helpers for binary file support"
jj new
```

---

## Task 2: MCP `read` tool — blob support

Extend the read tool to detect `.json` files and read blob content from the store instead of Y.Text.

**Files:**
- Modify: `crates/relay/src/mcp/tools/read.rs`
- Modify: `crates/relay/src/mcp/tools/test_helpers.rs` (add `build_blob_test_server_with_docs`)

- [ ] **Step 1: Write failing test for JSON read**

Add to `crates/relay/src/mcp/tools/read.rs` in the `mod tests` block:

```rust
#[cfg(test)]
mod blob_read_tests {
    use super::*;
    use crate::mcp::tools::blob;
    use crate::mcp::tools::test_helpers::*;
    use serde_json::json;

    #[tokio::test]
    async fn read_json_file_returns_blob_content() {
        let server = build_blob_test_server_with_file(
            "/data.json",
            "uuid-json",
            r#"{"key": "value"}"#,
        ).await;

        let sid = setup_session_no_reads(&server);
        let result = execute(
            &server,
            &sid,
            &json!({
                "file_path": "Lens/data.json",
                "session_id": sid,
            }),
        ).await.unwrap();

        assert!(result.contains(r#""key": "value""#), "Should contain JSON content, got: {}", result);
        // Should have line numbers (cat -n format)
        assert!(result.contains("1\t"), "Should have line numbers, got: {}", result);
    }

    #[tokio::test]
    async fn read_json_records_doc_as_read() {
        let server = build_blob_test_server_with_file(
            "/data.json",
            "uuid-json",
            r#"{"key": "value"}"#,
        ).await;

        let sid = setup_session_no_reads(&server);
        let doc_id = format!("{}-uuid-json", RELAY_ID);

        // Before read: doc not in read set
        {
            let session = server.mcp_sessions.get_session(&sid).unwrap();
            assert!(!session.read_docs.contains(&doc_id));
        }

        execute(&server, &sid, &json!({
            "file_path": "Lens/data.json", "session_id": sid,
        })).await.unwrap();

        // After read: doc is in read set
        let session = server.mcp_sessions.get_session(&sid).unwrap();
        assert!(session.read_docs.contains(&doc_id));
    }
}
```

- [ ] **Step 2: Add `build_blob_test_server_with_file` helper to test_helpers.rs**

Add to `crates/relay/src/mcp/tools/test_helpers.rs`:

```rust
/// Create a test server with a store and a single blob file in filemeta.
/// The file content is stored as a blob in the store, and filemeta has type "file" with hash.
pub(crate) async fn build_blob_test_server_with_file(
    path: &str,
    uuid: &str,
    content: &str,
) -> Arc<Server> {
    use async_trait::async_trait;
    use dashmap::DashMap;
    use std::sync::Arc as StdArc;
    use std::time::Duration;
    use tokio_util::sync::CancellationToken;
    use y_sweet_core::store::Result as StoreResult;
    use y_sweet_core::store::Store;

    struct MemoryStore {
        data: StdArc<DashMap<String, Vec<u8>>>,
    }

    #[async_trait]
    impl Store for MemoryStore {
        async fn init(&self) -> StoreResult<()> { Ok(()) }
        async fn get(&self, key: &str) -> StoreResult<Option<Vec<u8>>> {
            Ok(self.data.get(key).map(|v| v.clone()))
        }
        async fn set(&self, key: &str, value: Vec<u8>) -> StoreResult<()> {
            self.data.insert(key.to_owned(), value);
            Ok(())
        }
        async fn remove(&self, key: &str) -> StoreResult<()> {
            self.data.remove(key);
            Ok(())
        }
        async fn exists(&self, key: &str) -> StoreResult<bool> {
            Ok(self.data.contains_key(key))
        }
    }

    let store_data = StdArc::new(DashMap::new());

    // Write blob content to store
    let hash = crate::mcp::tools::blob::sha256_hex(content.as_bytes());
    let doc_id = format!("{}-{}", RELAY_ID, uuid);
    let key = format!("files/{}/{}", doc_id, hash);
    store_data.insert(key, content.as_bytes().to_vec());

    let store = Box::new(MemoryStore {
        data: store_data,
    });

    let server = Arc::new(
        Server::new_without_workers(
            Some(store),
            Duration::from_secs(60),
            None, None, Vec::new(),
            CancellationToken::new(),
            false, None,
        ).await.unwrap()
    );

    // Create folder doc with filemeta entry (type "file" with hash)
    let folder_doc = {
        let doc = Doc::new();
        {
            let mut txn = doc.transact_mut();
            let filemeta = txn.get_or_insert_map("filemeta_v0");
            let mut map = HashMap::new();
            map.insert("id".to_string(), Any::String(uuid.into()));
            map.insert("type".to_string(), Any::String("file".into()));
            map.insert("version".to_string(), Any::Number(0.0));
            map.insert("hash".to_string(), Any::String(hash.into()));
            filemeta.insert(&mut txn, path, Any::Map(map.into()));
        }
        doc
    };
    set_folder_name(&folder_doc, "Lens");
    server.doc_resolver().update_folder_from_doc(&folder0_id(), &folder_doc);

    server
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml --lib mcp::tools::read::blob_read_tests -- --nocapture 2>&1 | tail -20`
Expected: FAIL — read tool doesn't handle blob files yet.

- [ ] **Step 4: Implement blob read path in read.rs**

Modify `crates/relay/src/mcp/tools/read.rs`. The key change: after resolving the path, check if the file is a blob (by checking filemeta type or extension). If so, read from store instead of Y.Text.

First, add to the imports at the top:

```rust
use super::blob;
```

Then modify `execute()`. After resolving `doc_info` (around line 35), add a branch:

```rust
    // Check if this is a blob file (e.g. .json) — read from store instead of Y.Text
    if blob::is_blob_file(file_path) {
        let hash = server
            .doc_resolver()
            .get_file_hash(file_path)
            .ok_or_else(|| format!("Error: No file hash for blob: {}", file_path))?;

        let data = blob::read_blob(server, &doc_info.doc_id, &hash).await?;
        let content = String::from_utf8(data)
            .map_err(|_| format!("Error: {} is not valid UTF-8", file_path))?;

        // Record as read for edit enforcement
        if let Some(mut session) = server.mcp_sessions.get_session_mut(session_id) {
            session.read_docs.insert(doc_info.doc_id.clone());
        }

        // No CriticMarkup processing for blobs
        return Ok(format_cat_n(&content, offset, limit));
    }
```

This requires `doc_resolver().get_file_hash()` — a new method that reads the hash from filemeta. See step 5.

- [ ] **Step 5: Add `get_file_hash` to DocumentResolver**

The DocumentResolver needs to be able to look up the hash from filemeta for a given path. Check how `DocInfo` is structured and where filemeta data is stored. The resolver already tracks `DocInfo` per path. Options:

a) Store `hash` in `DocInfo` when building from filemeta (cleanest).
b) Read filemeta from the folder Y.Doc at read time.

Option (a) is better. Modify `DocInfo` in `crates/y-sweet-core/src/doc_resolver.rs` to include `hash: Option<String>`. Update `update_folder_from_doc()` to extract the hash when building entries.

Check the current `DocInfo`:

```bash
grep -A 10 "pub struct DocInfo" crates/y-sweet-core/src/doc_resolver.rs
```

Add `pub hash: Option<String>` to `DocInfo`. Update the builder in `update_folder_from_doc()` to read the hash from filemeta. Add accessor:

```rust
pub fn get_file_hash(&self, path: &str) -> Option<String> {
    self.resolve_path(path).and_then(|info| info.hash.clone())
}
```

Update all existing `DocInfo { ... }` constructions to include `hash: None` for markdown docs.

- [ ] **Step 6: Run tests to verify they pass**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml --lib mcp::tools::read -- --nocapture 2>&1 | tail -30`
Expected: All read tests pass (both existing markdown and new blob tests).

- [ ] **Step 7: Commit**

```bash
jj describe -m "feat(mcp): read tool supports JSON blob files"
jj new
```

---

## Task 3: MCP `create` tool — blob support

Extend the create tool to create JSON files as blobs.

**Files:**
- Modify: `crates/relay/src/mcp/tools/create_doc.rs`
- Modify: `crates/relay/src/mcp/tools/mod.rs` (update tool description)

- [ ] **Step 1: Write failing test for JSON create**

Add to `crates/relay/src/mcp/tools/create_doc.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tools::blob;
    use crate::mcp::tools::test_helpers::*;
    use serde_json::json;

    #[tokio::test]
    async fn create_json_file_stores_blob() {
        // Need a server with a store AND a folder doc loaded
        let server = build_blob_test_server_with_folder().await;

        let result = execute(
            &server,
            &json!({
                "file_path": "Lens/data.json",
                "content": r#"{"hello": "world"}"#,
            }),
        ).await;

        assert!(result.is_ok(), "Create should succeed: {:?}", result.err());
        assert!(result.unwrap().contains("Created Lens/data.json"));

        // Verify the blob was stored
        let hash = server.doc_resolver().get_file_hash("Lens/data.json");
        assert!(hash.is_some(), "Should have hash in resolver");
    }

    #[tokio::test]
    async fn create_json_file_no_criticmarkup() {
        let server = build_blob_test_server_with_folder().await;

        execute(
            &server,
            &json!({
                "file_path": "Lens/test.json",
                "content": r#"{"key": "value"}"#,
            }),
        ).await.unwrap();

        // Read the blob back — should NOT contain CriticMarkup wrapping
        let hash = server.doc_resolver().get_file_hash("Lens/test.json").unwrap();
        let doc_id = server.doc_resolver().resolve_path("Lens/test.json").unwrap().doc_id;
        let data = blob::read_blob(&server, &doc_id, &hash).await.unwrap();
        let content = String::from_utf8(data).unwrap();

        assert_eq!(content, r#"{"key": "value"}"#);
        assert!(!content.contains("{++"), "Should not contain CriticMarkup");
    }

    #[tokio::test]
    async fn create_md_still_works() {
        let server = build_blob_test_server_with_folder().await;

        let result = execute(
            &server,
            &json!({
                "file_path": "Lens/Doc.md",
                "content": "Hello world",
            }),
        ).await;

        assert!(result.is_ok());
    }
}
```

- [ ] **Step 2: Add `build_blob_test_server_with_folder` helper**

Add to `test_helpers.rs` — creates a server with a store AND a folder doc already loaded (needed for `create_document` to work):

```rust
/// Create a test server with a store and a loaded folder doc (for create operations).
pub(crate) async fn build_blob_test_server_with_folder() -> Arc<Server> {
    use async_trait::async_trait;
    use dashmap::DashMap;
    use std::sync::Arc as StdArc;
    use std::time::Duration;
    use tokio_util::sync::CancellationToken;
    use y_sweet_core::doc_sync::DocWithSyncKv;
    use y_sweet_core::store::Result as StoreResult;
    use y_sweet_core::store::Store;

    struct MemoryStore {
        data: StdArc<DashMap<String, Vec<u8>>>,
    }

    #[async_trait]
    impl Store for MemoryStore {
        async fn init(&self) -> StoreResult<()> { Ok(()) }
        async fn get(&self, key: &str) -> StoreResult<Option<Vec<u8>>> {
            Ok(self.data.get(key).map(|v| v.clone()))
        }
        async fn set(&self, key: &str, value: Vec<u8>) -> StoreResult<()> {
            self.data.insert(key.to_owned(), value);
            Ok(())
        }
        async fn remove(&self, key: &str) -> StoreResult<()> {
            self.data.remove(key);
            Ok(())
        }
        async fn exists(&self, key: &str) -> StoreResult<bool> {
            Ok(self.data.contains_key(key))
        }
    }

    let store = Box::new(MemoryStore {
        data: StdArc::new(DashMap::new()),
    });

    let server = Arc::new(
        Server::new_without_workers(
            Some(store),
            Duration::from_secs(60),
            None, None, Vec::new(),
            CancellationToken::new(),
            false, None,
        ).await.unwrap()
    );

    // Create and load a folder doc so create_document can find it
    let folder_doc_id = folder0_id();
    let dwskv = DocWithSyncKv::new(&folder_doc_id, None, || (), None)
        .await
        .expect("create folder doc");

    // Set folder name and filemeta
    {
        let awareness = dwskv.awareness();
        let mut guard = awareness.write().unwrap();
        let mut txn = guard.doc.transact_mut();
        let config = txn.get_or_insert_map("folder_config");
        config.insert(&mut txn, "name", Any::String("Lens".into()));
        // Initialize empty filemeta and docs maps
        txn.get_or_insert_map("filemeta_v0");
        txn.get_or_insert_map("docs");
    }

    // Register in resolver
    {
        let awareness = dwskv.awareness();
        let guard = awareness.read().unwrap();
        server.doc_resolver().update_folder_from_doc(&folder_doc_id, &guard.doc);
    }

    server.docs().insert(folder_doc_id, dwskv);

    server
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml --lib mcp::tools::create_doc::tests -- --nocapture 2>&1 | tail -20`
Expected: FAIL — create tool still rejects `.json` files.

- [ ] **Step 4: Implement blob create path**

Modify `crates/relay/src/mcp/tools/create_doc.rs`:

```rust
use crate::server::Server;
use serde_json::Value;
use std::sync::Arc;

use super::blob;

/// Execute the `create` tool: create a new document at the specified path.
pub async fn execute(server: &Arc<Server>, arguments: &Value) -> Result<String, String> {
    let file_path = arguments
        .get("file_path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter: file_path".to_string())?;

    let content = arguments
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    // Branch: blob files vs markdown
    if blob::is_blob_file(file_path) {
        return create_blob_file(server, file_path, content).await;
    }

    // --- Markdown path (existing behavior) ---

    // Reject if AI included CriticMarkup in content
    super::critic_markup::reject_if_contains_markup(content, "content")?;

    // Validate: must end with .md
    if !file_path.ends_with(".md") {
        return Err("file_path must end with '.md' or '.json'".to_string());
    }

    // Default content for markdown if empty
    let md_content = if content.is_empty() { "_" } else { content };

    // Split at first '/' into folder name + in-folder path
    let slash_pos = file_path
        .find('/')
        .ok_or_else(|| "file_path must include a folder name (e.g. 'Lens/Doc.md')".to_string())?;

    let folder_name = &file_path[..slash_pos];
    let in_folder_path = format!("/{}", &file_path[slash_pos + 1..]);

    let _result = server
        .create_document(folder_name, &in_folder_path, md_content)
        .await
        .map_err(|e| e.to_string())?;

    Ok(format!("Created {}", file_path))
}

/// Create a blob file: write content to store, update filemeta with hash.
async fn create_blob_file(
    server: &Arc<Server>,
    file_path: &str,
    content: &str,
) -> Result<String, String> {
    let slash_pos = file_path
        .find('/')
        .ok_or_else(|| "file_path must include a folder name (e.g. 'Lens/data.json')".to_string())?;

    let folder_name = &file_path[..slash_pos];
    let in_folder_path = format!("/{}", &file_path[slash_pos + 1..]);

    // Create the blob file via a new server method
    server
        .create_blob_file(folder_name, &in_folder_path, content.as_bytes())
        .await
        .map_err(|e| e.to_string())?;

    Ok(format!("Created {}", file_path))
}
```

- [ ] **Step 5: Implement `Server::create_blob_file`**

Add a new method to `Server` in `crates/relay/src/server.rs` (near `create_document`). This method:
1. Finds the folder doc
2. Checks path doesn't already exist
3. Generates UUID
4. Writes blob to store
5. Updates filemeta_v0 with `type: "file"` and `hash`
6. Does NOT create a content Y.Doc (no Y.Text)
7. Does NOT write to legacy `docs` map (only markdown goes there — see CLAUDE.md note about Obsidian compatibility)
8. Updates doc_resolver

Model it closely on `create_document` but skip steps 4-5 (content doc + CriticMarkup) and use `type: "file"` + `hash` in filemeta.

```rust
pub async fn create_blob_file(
    &self,
    folder_name: &str,
    in_folder_path: &str,
    data: &[u8],
) -> Result<CreateDocumentResult, CreateDocumentError> {
    // 1. Find folder doc (same as create_document)
    let folder_doc_id = self
        .doc_resolver()
        .find_folder_doc_id(folder_name)
        .ok_or_else(|| {
            CreateDocumentError::NotFound(format!("Folder '{}' not found", folder_name))
        })?;

    let docs = self.docs();

    // 2. Check path doesn't already exist
    {
        let awareness = {
            let Some(doc_ref) = docs.get(&folder_doc_id) else {
                return Err(CreateDocumentError::Internal("Folder doc not loaded".into()));
            };
            doc_ref.awareness()
        };
        let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
        let txn = guard.doc.transact();
        if let Some(filemeta) = txn.get_map("filemeta_v0") {
            if filemeta.get(&txn, in_folder_path).is_some() {
                return Err(CreateDocumentError::Conflict(format!(
                    "Path '{}' already exists in folder '{}'",
                    in_folder_path, folder_name
                )));
            }
        }
    }

    // 3. Generate UUID and doc_id
    let uuid = uuid::Uuid::new_v4().to_string();
    let relay_id = crate::link_indexer::parse_doc_id(&folder_doc_id)
        .map(|(r, _)| r.to_string())
        .unwrap_or_default();
    let full_doc_id = if relay_id.is_empty() {
        uuid.clone()
    } else {
        format!("{}-{}", relay_id, uuid)
    };

    // 4. Write blob to store
    let hash = crate::mcp::tools::blob::write_blob(self, &full_doc_id, data)
        .await
        .map_err(|e| CreateDocumentError::Internal(e))?;

    // 5. Update filemeta_v0 (type "file" with hash, no legacy docs entry)
    {
        let awareness = {
            let doc_ref = docs
                .get(&folder_doc_id)
                .ok_or_else(|| CreateDocumentError::Internal("Folder doc not loaded".into()))?;
            doc_ref.awareness()
        };
        let guard = awareness.write().unwrap_or_else(|e| e.into_inner());
        let mut txn = guard.doc.transact_mut_with("mcp");

        let filemeta = txn.get_or_insert_map("filemeta_v0");

        crate::link_indexer::ensure_ancestor_folders(
            &filemeta,
            &txn.get_or_insert_map("docs"),
            &mut txn,
            in_folder_path,
        );

        let mut map = std::collections::HashMap::new();
        map.insert("id".to_string(), yrs::Any::String(uuid.clone().into()));
        map.insert("type".to_string(), yrs::Any::String("file".into()));
        map.insert("version".to_string(), yrs::Any::Number(0.0));
        map.insert("hash".to_string(), yrs::Any::String(hash.into()));
        filemeta.insert(&mut txn, in_folder_path, yrs::Any::Map(map.into()));
        // Note: do NOT add to legacy "docs" map — only markdown docs go there
    }

    // 6. Update doc_resolver
    let file_path = format!("{}{}", folder_name, in_folder_path);
    self.doc_resolver().upsert_doc(
        &uuid,
        &file_path,
        y_sweet_core::doc_resolver::DocInfo {
            uuid: uuid.clone(),
            relay_id: relay_id.clone(),
            folder_doc_id: folder_doc_id.clone(),
            folder_name: folder_name.to_string(),
            doc_id: full_doc_id.clone(),
            hash: Some(crate::mcp::tools::blob::sha256_hex(data)),
        },
    );

    // 7. Persist folder doc
    {
        let folder_sync_kv = docs.get(&folder_doc_id).map(|r| r.sync_kv());
        if let Some(sync_kv) = folder_sync_kv {
            if let Err(e) = sync_kv.persist().await {
                tracing::error!("Failed to persist folder doc {}: {:?}", folder_doc_id, e);
            }
        }
    }

    Ok(CreateDocumentResult {
        uuid,
        full_doc_id,
        folder_name: folder_name.to_string(),
        in_folder_path: in_folder_path.to_string(),
    })
}
```

- [ ] **Step 6: Update tool description in mod.rs**

In `crates/relay/src/mcp/tools/mod.rs`, update the `create` tool description and `file_path` description:

```json
{
    "name": "create",
    "description": "Create a new document or file at the specified path. Supports .md (markdown) and .json files.",
    ...
    "file_path": {
        "description": "Path for the new file (e.g. 'Lens/NewDoc.md', 'Lens Edu/data.json')"
    },
    "content": {
        "description": "Initial content for the file. For markdown: content with CriticMarkup review. For JSON: raw JSON content."
    }
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml --lib mcp::tools::create_doc -- --nocapture 2>&1 | tail -30`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
jj describe -m "feat(mcp): create tool supports JSON blob files"
jj new
```

---

## Task 4: MCP `edit` tool — blob support

Extend the edit tool to do old_string/new_string replacement on blob content.

**Files:**
- Modify: `crates/relay/src/mcp/tools/edit.rs`

- [ ] **Step 1: Write failing test for JSON edit**

Add to `crates/relay/src/mcp/tools/edit.rs` tests:

```rust
#[cfg(test)]
mod blob_edit_tests {
    use super::*;
    use crate::mcp::tools::blob;
    use crate::mcp::tools::test_helpers::*;
    use serde_json::json;

    #[tokio::test]
    async fn edit_json_replaces_text_in_blob() {
        let server = build_blob_test_server_with_file(
            "/data.json",
            "uuid-json",
            r#"{"key": "old_value"}"#,
        ).await;

        let sid = setup_session_with_read(
            &server,
            &format!("{}-uuid-json", RELAY_ID),
        );

        let result = execute(
            &server,
            &sid,
            &json!({
                "file_path": "Lens/data.json",
                "old_string": "old_value",
                "new_string": "new_value",
                "session_id": sid,
            }),
        ).await;

        assert!(result.is_ok(), "Edit should succeed: {:?}", result.err());

        // Read back and verify
        let new_hash = server.doc_resolver().get_file_hash("Lens/data.json").unwrap();
        let data = blob::read_blob(&server, &format!("{}-uuid-json", RELAY_ID), &new_hash).await.unwrap();
        let content = String::from_utf8(data).unwrap();
        assert_eq!(content, r#"{"key": "new_value"}"#);
    }

    #[tokio::test]
    async fn edit_json_requires_read_first() {
        let server = build_blob_test_server_with_file(
            "/data.json",
            "uuid-json",
            r#"{"key": "value"}"#,
        ).await;

        let sid = setup_session_no_reads(&server);

        let result = execute(
            &server,
            &sid,
            &json!({
                "file_path": "Lens/data.json",
                "old_string": "value",
                "new_string": "changed",
                "session_id": sid,
            }),
        ).await;

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("must read"));
    }

    #[tokio::test]
    async fn edit_json_no_criticmarkup() {
        let server = build_blob_test_server_with_file(
            "/data.json",
            "uuid-json",
            r#"{"key": "value"}"#,
        ).await;

        let sid = setup_session_with_read(
            &server,
            &format!("{}-uuid-json", RELAY_ID),
        );

        execute(
            &server,
            &sid,
            &json!({
                "file_path": "Lens/data.json",
                "old_string": "value",
                "new_string": "changed",
                "session_id": sid,
            }),
        ).await.unwrap();

        let new_hash = server.doc_resolver().get_file_hash("Lens/data.json").unwrap();
        let data = blob::read_blob(&server, &format!("{}-uuid-json", RELAY_ID), &new_hash).await.unwrap();
        let content = String::from_utf8(data).unwrap();
        // Should NOT contain CriticMarkup
        assert!(!content.contains("{++"), "Should not wrap in CriticMarkup: {}", content);
        assert!(!content.contains("{--"), "Should not wrap in CriticMarkup: {}", content);
    }

    #[tokio::test]
    async fn edit_json_old_string_not_found() {
        let server = build_blob_test_server_with_file(
            "/data.json",
            "uuid-json",
            r#"{"key": "value"}"#,
        ).await;

        let sid = setup_session_with_read(
            &server,
            &format!("{}-uuid-json", RELAY_ID),
        );

        let result = execute(
            &server,
            &sid,
            &json!({
                "file_path": "Lens/data.json",
                "old_string": "nonexistent",
                "new_string": "changed",
                "session_id": sid,
            }),
        ).await;

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml --lib mcp::tools::edit::blob_edit_tests -- --nocapture 2>&1 | tail -20`
Expected: FAIL — edit tool doesn't handle blob files.

- [ ] **Step 3: Implement blob edit path**

In `crates/relay/src/mcp/tools/edit.rs`, add a blob branch at the top of `execute()`, after parameter parsing and read-before-edit check but before the Y.Doc access:

```rust
    // --- Blob edit path (e.g. .json) ---
    if blob::is_blob_file(file_path) {
        return edit_blob_file(server, &doc_info, file_path, old_string, new_string).await;
    }

    // --- Markdown path (existing behavior below) ---
```

Add the helper function:

```rust
/// Edit a blob file: read current content, apply text replacement, write back.
async fn edit_blob_file(
    server: &Arc<Server>,
    doc_info: &y_sweet_core::doc_resolver::DocInfo,
    file_path: &str,
    old_string: &str,
    new_string: &str,
) -> Result<String, String> {
    use super::blob;

    // 1. Read current blob
    let hash = doc_info
        .hash
        .as_ref()
        .ok_or_else(|| format!("Error: No file hash for blob: {}", file_path))?;

    let data = blob::read_blob(server, &doc_info.doc_id, hash).await?;
    let content = String::from_utf8(data)
        .map_err(|_| format!("Error: {} is not valid UTF-8", file_path))?;

    // 2. Find and replace old_string
    let matches: Vec<usize> = content.match_indices(old_string).map(|(i, _)| i).collect();
    match matches.len() {
        0 => return Err(format!(
            "Error: old_string not found in {}. Make sure it matches exactly.",
            file_path
        )),
        1 => {} // good
        n => return Err(format!(
            "Error: old_string is not unique in {} ({} occurrences found). \
             Include more surrounding context to make it unique.",
            file_path, n
        )),
    }

    let new_content = content.replacen(old_string, new_string, 1);

    // 3. Write new blob
    let new_hash = blob::write_blob(server, &doc_info.doc_id, new_content.as_bytes()).await?;

    // 4. Update hash in filemeta_v0
    server
        .update_blob_hash(&doc_info.folder_doc_id, &doc_info.doc_id, &file_path, &new_hash)
        .await
        .map_err(|e| format!("Error updating filemeta: {}", e))?;

    // 5. Update hash in doc_resolver
    server.doc_resolver().update_hash(file_path, &new_hash);

    Ok(format!(
        "Edited {}: replaced {} characters.",
        file_path,
        old_string.len()
    ))
}
```

Add `use super::blob;` to imports.

- [ ] **Step 4: Implement `Server::update_blob_hash` and `DocumentResolver::update_hash`**

`update_blob_hash` updates the hash field in filemeta_v0 for an existing blob file:

```rust
pub async fn update_blob_hash(
    &self,
    folder_doc_id: &str,
    _doc_id: &str,
    file_path: &str,
    new_hash: &str,
) -> Result<(), String> {
    // Extract in_folder_path from file_path (strip folder name prefix)
    let slash_pos = file_path.find('/').ok_or("Invalid file path")?;
    let in_folder_path = &file_path[slash_pos..];

    let awareness = {
        let doc_ref = self.docs().get(folder_doc_id)
            .ok_or("Folder doc not loaded")?;
        doc_ref.awareness()
    };
    let guard = awareness.write().unwrap_or_else(|e| e.into_inner());
    let mut txn = guard.doc.transact_mut_with("mcp");
    let filemeta = txn.get_or_insert_map("filemeta_v0");

    if let Some(entry) = filemeta.get(&txn, in_folder_path) {
        if let yrs::Value::YMap(map) = entry {
            map.insert(&mut txn, "hash", yrs::Any::String(new_hash.into()));
        }
    }

    Ok(())
}
```

`DocumentResolver::update_hash` updates the cached hash in DocInfo:

```rust
pub fn update_hash(&self, path: &str, new_hash: &str) {
    if let Some(mut info) = self.path_to_doc.get_mut(path) {
        info.hash = Some(new_hash.to_string());
    }
}
```

- [ ] **Step 5: Update tool description in mod.rs**

Update the `edit` tool description to mention JSON support:

```json
"description": "Edit a document by replacing old_string with new_string. For markdown: wrapped in CriticMarkup for human review. For JSON: direct text replacement. You must read the document first."
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml --lib mcp::tools::edit -- --nocapture 2>&1 | tail -30`
Expected: All edit tests pass (both markdown and blob).

- [ ] **Step 7: Commit**

```bash
jj describe -m "feat(mcp): edit tool supports JSON blob files"
jj new
```

---

## Task 5: MCP `grep` tool — blob support

Extend grep to search blob file content in addition to Y.Text content.

**Files:**
- Modify: `crates/relay/src/mcp/tools/grep.rs`

- [ ] **Step 1: Write failing test for grep matching JSON content**

Add to `crates/relay/src/mcp/tools/grep.rs` tests:

```rust
#[tokio::test]
async fn grep_searches_blob_files() {
    // Build server with both a markdown doc and a JSON blob
    let server = build_mixed_test_server(&[
        ("/Doc.md", "uuid-md", "markdown content"),
    ], &[
        ("/data.json", "uuid-json", r#"{"searchable": "found_me"}"#),
    ]).await;

    let result = execute(
        &server,
        &json!({
            "pattern": "found_me",
            "session_id": "ignored",
        }),
    ).await.unwrap();

    assert!(result.contains("data.json"), "Should find match in JSON: {}", result);
}
```

This requires a new `build_mixed_test_server` helper that creates both markdown docs and blob files. Add it to the test module.

- [ ] **Step 2: Run test to verify it fails**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml --lib mcp::tools::grep::tests::grep_searches_blob_files -- --nocapture 2>&1 | tail -20`
Expected: FAIL — grep only reads Y.Text, not blobs.

- [ ] **Step 3: Implement blob read fallback in grep**

In `crates/relay/src/mcp/tools/grep.rs`, modify the `read_doc_content` function to fall back to blob read when Y.Text is empty/missing and the file has a blob extension:

```rust
async fn read_doc_content(server: &Arc<Server>, doc_id: &str, path: &str) -> Option<String> {
    // Try blob path first for known blob extensions
    if super::blob::is_blob_file(path) {
        if let Some(hash) = server.doc_resolver().get_file_hash(path) {
            if let Ok(data) = super::blob::read_blob(server, doc_id, &hash).await {
                return String::from_utf8(data).ok();
            }
        }
        return None;
    }

    // Markdown path: read Y.Text
    server.ensure_doc_loaded(doc_id).await.ok()?;
    let doc_ref = server.docs().get(doc_id)?;
    let awareness = doc_ref.awareness();
    let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
    let txn = guard.doc.transact();
    match txn.get_text("contents") {
        Some(text) => Some(text.get_string(&txn)),
        None => Some(String::new()),
    }
}
```

Update the call site to pass `path`:

```rust
let content = match read_doc_content(server, &doc_info.doc_id, path).await {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml --lib mcp::tools::grep -- --nocapture 2>&1 | tail -30`
Expected: All grep tests pass.

- [ ] **Step 5: Commit**

```bash
jj describe -m "feat(mcp): grep tool searches JSON blob content"
jj new
```

---

## Task 6: Lens Editor — JSON read-only viewer

Add JSON rendering support to the lens-editor frontend.

**Files:**
- Modify: `lens-editor/package.json` (add `@codemirror/lang-json`)
- Modify: `lens-editor/src/components/Editor/Editor.tsx` (JSON language, read-only for blobs)
- Modify: `lens-editor/src/components/Layout/EditorArea.tsx` (pass file type info)
- Modify: `lens-editor/src/App.tsx` (handle blob files in DocumentView)

- [ ] **Step 1: Install @codemirror/lang-json**

```bash
cd lens-editor && npm install @codemirror/lang-json
```

- [ ] **Step 2: Modify Editor.tsx to support JSON**

Add to imports:

```typescript
import { json as jsonLang } from '@codemirror/lang-json';
```

Add a `fileType` prop to `EditorProps`:

```typescript
interface EditorProps {
  readOnly?: boolean;
  fileType?: 'markdown' | 'json';
  blobContent?: string;  // Pre-fetched content for blob files
  // ... existing props
}
```

In the `useEffect` that creates `EditorState`, branch on `fileType`:

For JSON files:
- Use `jsonLang()` instead of `markdown(...)` 
- Force read-only: `EditorView.editable.of(false)`, `EditorState.readOnly.of(true)`
- Skip yCollab, undoManager, CriticMarkup, livePreview, wikilink extensions
- Initialize with `blobContent` as static doc content instead of Y.Text

The JSON editor is essentially a stripped-down CodeMirror with:
- `jsonLang()`
- Read-only extensions
- Syntax highlighting
- Line wrapping
- Same theme

- [ ] **Step 3: Modify EditorArea.tsx to detect file type**

In `EditorArea.tsx`, determine if the current doc is a JSON file. Use the `metadata` from useFolderMetadata to check the file extension of the current path.

Pass `fileType` and `blobContent` to `<Editor>`.

For blob files, fetch content from the relay download endpoint instead of relying on Y.Text sync.

- [ ] **Step 4: Implement blob content fetching**

Create a hook or utility that:
1. Gets the doc_id and hash from filemeta metadata
2. Calls the relay server's download endpoint to get blob content
3. Returns the content as a string

This can be a `useBlobContent(docId, hash)` hook that fetches once and caches.

- [ ] **Step 5: Test manually**

Start servers and verify:

```bash
# Terminal 1: Start relay with R2 (to access real JSON blobs)
cd lens-editor && npm run relay:start:r2

# Terminal 2: Start frontend
cd lens-editor && npm run dev:local:r2
```

Navigate to a JSON file in the Lens Edu folder tree. Verify:
- JSON renders with syntax highlighting
- Editor is read-only (can't type)
- No errors in console

- [ ] **Step 6: Commit**

```bash
jj describe -m "feat(editor): read-only JSON file viewer with syntax highlighting"
jj new
```

---

## Task 7: Integration test

Write an end-to-end test that creates, reads, edits, and reads a JSON file via MCP tools.

**Files:**
- Modify: Add integration test in `crates/relay/src/mcp/tools/` (new test module or extend existing)

- [ ] **Step 1: Write integration test**

```rust
#[tokio::test]
async fn json_file_create_read_edit_roundtrip() {
    let server = build_blob_test_server_with_folder().await;
    let sid = setup_session_no_reads(&server);

    // 1. Create JSON file
    let create_result = create_doc::execute(
        &server,
        &json!({
            "file_path": "Lens/config.json",
            "content": r#"{"version": 1, "name": "test"}"#,
        }),
    ).await.unwrap();
    assert!(create_result.contains("Created"));

    // 2. Glob finds it
    let glob_result = glob::execute(
        &server,
        &json!({ "pattern": "**/*.json", "session_id": sid }),
    ).unwrap();
    assert!(glob_result.contains("config.json"));

    // 3. Read it
    let read_result = read::execute(
        &server,
        &sid,
        &json!({ "file_path": "Lens/config.json", "session_id": sid }),
    ).await.unwrap();
    assert!(read_result.contains(r#""version": 1"#));

    // 4. Edit it
    let edit_result = edit::execute(
        &server,
        &sid,
        &json!({
            "file_path": "Lens/config.json",
            "old_string": r#""version": 1"#,
            "new_string": r#""version": 2"#,
            "session_id": sid,
        }),
    ).await.unwrap();
    assert!(edit_result.contains("Edited"));

    // 5. Read again to verify edit
    let read_result2 = read::execute(
        &server,
        &sid,
        &json!({ "file_path": "Lens/config.json", "session_id": sid }),
    ).await.unwrap();
    assert!(read_result2.contains(r#""version": 2"#));
    assert!(!read_result2.contains(r#""version": 1"#));

    // 6. Grep finds content
    let grep_result = grep::execute(
        &server,
        &json!({ "pattern": "test", "session_id": sid }),
    ).await.unwrap();
    assert!(grep_result.contains("config.json"));
}
```

- [ ] **Step 2: Run test**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml --lib json_file_create_read_edit_roundtrip -- --nocapture 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
jj describe -m "test: JSON file CRUD integration test"
jj new
```
