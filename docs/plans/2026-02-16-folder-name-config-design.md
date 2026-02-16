# Folder Name Config in relay.toml

## Problem

The link indexer, document resolver, and search index need folder display names (e.g. "Lens", "Lens Edu"). These come from `folder_config.name` in each folder's Y.Doc, but nothing in the upstream Relay ecosystem writes that field. The `folder_config` Y.Map is our invention. Without it, everything falls back to placeholders like `Folder-b0000001`.

The canonical folder name lives in the Relay Control Plane (PocketBase), which our self-hosted server doesn't have access to.

## Solution

Add a `[[folders]]` section to `relay.toml` mapping folder doc UUIDs to display names. On startup, before reindexing, the server writes `folder_config.name` into each folder's Y.Doc.

### Config format

```toml
[[folders]]
uuid = "b0000001-0000-4000-8000-000000000001"
name = "Lens"

[[folders]]
uuid = "b0000002-0000-4000-8000-000000000002"
name = "Lens Edu"
```

### Data flow

1. Server loads `relay.toml` including `folders` config
2. `startup_reindex()` calls `apply_folder_names()` **before** backlink reindex
3. For each configured folder, find the matching folder doc (by UUID suffix in doc ID)
4. Write `folder_config.name` into the Y.Doc only if different from current value (avoids CRDT churn)
5. Checkpoint the doc if changed (persists to storage)
6. Proceed with existing reindex flow (backlinks, resolver, search)

### Changes

- **`config.rs`**: Add `FolderConfig` struct and `folders: Vec<FolderConfig>` to `Config`
- **`server.rs`**: Add `apply_folder_names()` method, call at start of `startup_reindex()`
- **`relay.toml`** / **`relay.toml.example`**: Add `[[folders]]` examples
- **`config.rs` tests**: Deserialization test for folders config
