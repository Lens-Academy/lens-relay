# Folder Name Config Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `[[folders]]` config to `relay.toml` so the server writes folder display names into Y.Docs on startup.

**Architecture:** A new `FolderConfig` struct deserializes from `[[folders]]` in relay.toml. On startup, before backlink reindexing, the server matches configured UUIDs to loaded folder docs (by UUID suffix) and writes `folder_config.name` into each Y.Doc. Only writes if the value differs, to avoid CRDT churn. Persists changed docs to storage.

**Tech Stack:** Rust, serde, yrs (Y.Doc CRDT library), toml config

---

### Task 1: Add FolderConfig to config.rs

**Files:**
- Modify: `crates/y-sweet-core/src/config.rs:263-285` (Config struct)

**Step 1: Write the failing test**

Add to `crates/y-sweet-core/src/config.rs` at the end of the `tests` module:

```rust
#[test]
fn test_folders_config_deserializes() {
    let toml_content = r#"
[[folders]]
uuid = "b0000001-0000-4000-8000-000000000001"
name = "Lens"

[[folders]]
uuid = "b0000002-0000-4000-8000-000000000002"
name = "Lens Edu"
"#;
    let config: Config = toml::from_str(toml_content).unwrap();
    assert_eq!(config.folders.len(), 2);
    assert_eq!(config.folders[0].uuid, "b0000001-0000-4000-8000-000000000001");
    assert_eq!(config.folders[0].name, "Lens");
    assert_eq!(config.folders[1].name, "Lens Edu");
}

#[test]
fn test_empty_folders_config() {
    let toml_content = r#"
[server]
port = 8080
"#;
    let config: Config = toml::from_str(toml_content).unwrap();
    assert!(config.folders.is_empty());
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path=crates/Cargo.toml -p y-sweet-core test_folders_config`
Expected: FAIL — `Config` has no `folders` field.

**Step 3: Write minimal implementation**

Add the `FolderConfig` struct near the other config structs (after `MetricsConfig`, around line 320):

```rust
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FolderConfig {
    pub uuid: String,
    pub name: String,
}
```

Add the field to `Config` struct (after `metrics`):

```rust
#[serde(default)]
pub folders: Vec<FolderConfig>,
```

Add to `Config::default()` (after `metrics: None`):

```rust
folders: Vec::new(),
```

**Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path=crates/Cargo.toml -p y-sweet-core test_folders_config`
Expected: PASS

**Step 5: Commit**

```
feat: add [[folders]] config section to Config struct
```

---

### Task 2: Add apply_folder_names to server.rs

**Files:**
- Modify: `crates/relay/src/server.rs:975-990` (startup_reindex)

**Step 1: Write the apply_folder_names method**

Add a new method on `Server` (near `startup_reindex`, around line 975):

```rust
/// Write folder display names from config into folder Y.Docs.
///
/// For each configured folder, finds the folder doc whose doc_id ends with
/// the configured UUID, reads the current `folder_config.name` from the Y.Doc,
/// and writes the configured name if different. Persists changed docs to storage.
async fn apply_folder_names(&self, folders: &[y_sweet_core::config::FolderConfig]) -> Result<()> {
    if folders.is_empty() {
        return Ok(());
    }

    let folder_doc_ids = link_indexer::find_all_folder_docs(&self.docs);
    let mut applied = 0;

    for folder_config in folders {
        // Find the folder doc whose doc_id ends with this UUID
        let Some(folder_doc_id) = folder_doc_ids.iter().find(|id| {
            link_indexer::parse_doc_id(id)
                .map(|(_, uuid)| uuid == folder_config.uuid)
                .unwrap_or(false)
        }) else {
            tracing::warn!(
                "Folder config for '{}' (uuid={}) — no matching folder doc found",
                folder_config.name,
                folder_config.uuid
            );
            continue;
        };

        let Some(doc_ref) = self.docs.get(folder_doc_id) else {
            continue;
        };

        // Read current name and compare
        let needs_update = {
            let awareness = doc_ref.awareness();
            let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
            let current_name = y_sweet_core::doc_resolver::read_folder_name(&guard.doc, folder_doc_id);
            current_name != folder_config.name
        };

        if !needs_update {
            tracing::debug!(
                "Folder '{}' already has correct name, skipping",
                folder_config.name
            );
            continue;
        }

        // Write the folder name
        {
            let awareness = doc_ref.awareness();
            let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
            let mut txn = guard.doc.transact_mut();
            let config_map = txn.get_or_insert_map("folder_config");
            config_map.insert(&mut txn, "name", yrs::Any::String(folder_config.name.clone().into()));
        }

        // Persist to storage
        doc_ref.sync_kv().persist().await
            .map_err(|e| anyhow!("Failed to persist folder name for '{}': {:?}", folder_config.name, e))?;

        tracing::info!(
            "Applied folder name '{}' to doc {}",
            folder_config.name,
            folder_doc_id
        );
        applied += 1;
    }

    if applied > 0 {
        tracing::info!("Applied {} folder name(s) from config", applied);
    }

    Ok(())
}
```

**Step 2: Wire apply_folder_names into startup_reindex**

`startup_reindex` currently takes no config parameter. We need to pass the folders config in. Modify the signature and add the call.

Change `startup_reindex` signature from:
```rust
pub async fn startup_reindex(&self) -> Result<()> {
```
to:
```rust
pub async fn startup_reindex(&self, folders: &[y_sweet_core::config::FolderConfig]) -> Result<()> {
```

After `let loaded = self.load_all_docs().await?;` (line 984-985), before the backlink reindex, add:

```rust
// Apply folder names from config before reindexing
self.apply_folder_names(folders).await?;
```

**Step 3: Update the call site in main.rs**

Find the `startup_reindex()` call in `crates/relay/src/main.rs` (around line 591). Change from:
```rust
server.startup_reindex().await?;
```
to:
```rust
server.startup_reindex(&config.folders).await?;
```

The `config` variable is already in scope at this point (loaded at line ~454-476).

**Step 4: Build to verify compilation**

Run: `cargo build --manifest-path=crates/Cargo.toml`
Expected: Compiles successfully.

**Step 5: Commit**

```
feat: apply folder names from config on startup
```

---

### Task 3: Update relay.toml config files

**Files:**
- Modify: `crates/relay.toml`
- Modify: `crates/relay.toml.example`

**Step 1: Add folders to relay.toml**

Add at the end of `crates/relay.toml`:

```toml
# Folder display names
# Maps folder doc UUIDs to human-readable names for the link indexer,
# document resolver, and search index.
[[folders]]
uuid = "b0000001-0000-4000-8000-000000000001"
name = "Lens"

[[folders]]
uuid = "b0000002-0000-4000-8000-000000000002"
name = "Lens Edu"
```

**Step 2: Add folders example to relay.toml.example**

Add before the final blank line of `crates/relay.toml.example`:

```toml
# Folder display names (optional)
# Maps folder doc UUIDs to human-readable names used by the link indexer,
# document resolver, and search index. Without these, folders show as
# "Folder-{uuid-prefix}" placeholders.
#
# [[folders]]
# uuid = "b0000001-0000-4000-8000-000000000001"
# name = "Lens"
#
# [[folders]]
# uuid = "b0000002-0000-4000-8000-000000000002"
# name = "Lens Edu"
```

**Step 3: Commit**

```
config: add folder name mappings to relay.toml
```

---

### Task 4: Verify end-to-end

**Step 1: Run all tests**

Run: `cargo test --manifest-path=crates/Cargo.toml`
Expected: All tests pass.

**Step 2: Manual smoke test**

Start the relay server locally and check logs for folder name application:
```bash
cargo run --manifest-path=crates/Cargo.toml --bin relay -- serve --port 8190
```

Look for log lines like:
- `Applied folder name 'Lens' to doc cb696037-...-b0000001-...`
- `Applied 2 folder name(s) from config`

If no docs exist yet, should see:
- `Folder config for 'Lens' (uuid=...) — no matching folder doc found`

**Step 3: Final commit (if any fixups needed)**

```
fix: address any issues found in smoke testing
```
