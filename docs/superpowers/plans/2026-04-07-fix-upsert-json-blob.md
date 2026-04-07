# Fix /doc/upsert JSON Blob Storage

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `/doc/upsert` endpoint store `.json` files as R2 blobs (with hash in filemeta_v0) instead of Y.Docs, matching how the Obsidian Relay plugin stores them.

**Architecture:** Route `.json` requests in `handle_upsert_document` to `create_blob_file()` for creates and return 409 Conflict for updates (JSON files are create-only). Also add `mimetype` and `synctime` fields to `create_blob_file`'s filemeta_v0 entry to match Obsidian's format. Remove the now-dead `JsonDocumentView` fallback from the editor.

**Tech Stack:** Rust (relay server), TypeScript (lens-editor React app)

---

### Task 1: Add mimetype and synctime to `create_blob_file` filemeta entry

The Obsidian Relay plugin writes filemeta_v0 entries for blob files with `mimetype` and `synctime` fields. Our `create_blob_file` omits both. Add them so entries match Obsidian's format.

**Files:**
- Modify: `crates/relay/src/server.rs:1606-1627` (filemeta map construction in `create_blob_file`)
- Modify: `crates/relay/src/mcp/tools/test_helpers.rs:180-184` (blob test helper filemeta entry)

- [ ] **Step 1: Update `create_blob_file` filemeta entry**

In `crates/relay/src/server.rs`, find the filemeta map construction inside `create_blob_file` (around line 1622-1627). Add `mimetype` and `synctime`:

```rust
            let mut map = std::collections::HashMap::new();
            map.insert("id".to_string(), yrs::Any::String(uuid.clone().into()));
            map.insert("type".to_string(), yrs::Any::String("file".into()));
            map.insert("version".to_string(), yrs::Any::Number(0.0));
            map.insert("hash".to_string(), yrs::Any::String(hash.clone().into()));
            map.insert(
                "mimetype".to_string(),
                yrs::Any::String("application/json".into()),
            );
            map.insert(
                "synctime".to_string(),
                yrs::Any::Number(
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as f64,
                ),
            );
            filemeta.insert(&mut txn, in_folder_path, yrs::Any::Map(map.into()));
```

- [ ] **Step 2: Update test helper to include mimetype and synctime**

In `crates/relay/src/mcp/tools/test_helpers.rs`, update `build_blob_test_server_with_file` (around line 180-184) to include the new fields so tests match reality:

```rust
        map.insert("id".to_string(), Any::String(uuid.into()));
        map.insert("type".to_string(), Any::String("file".into()));
        map.insert("version".to_string(), Any::Number(0.0));
        map.insert("hash".to_string(), Any::String(hash.into()));
        map.insert(
            "mimetype".to_string(),
            Any::String("application/json".into()),
        );
        map.insert(
            "synctime".to_string(),
            Any::Number(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as f64,
            ),
        );
```

- [ ] **Step 3: Run existing tests to verify nothing breaks**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml -p relay 2>&1 | tail -20`
Expected: All existing tests pass.

- [ ] **Step 4: Commit**

```
feat: add mimetype and synctime to blob filemeta entries

Matches Obsidian Relay plugin format for file-type filemeta_v0 entries.
```

---

### Task 2: Route `.json` files in `/doc/upsert` to blob storage

The core fix. `handle_upsert_document` currently always calls `create_document_direct` which creates a Y.Doc. For `.json` files, it should call `create_blob_file` instead, and reject updates (return 409).

**Files:**
- Modify: `crates/relay/src/server.rs:3728-3770` (`handle_upsert_document`)

- [ ] **Step 1: Write the failing test**

Add a test at the bottom of the `mod test` block in `crates/relay/src/server.rs` (after the existing tests, around line 5580+). This test needs the blob test infrastructure from `mcp/tools/test_helpers`, but since `handle_upsert_document` is an axum handler (not a public method), we test at the `Server` method level instead. The key behavior to verify: calling `create_blob_file` stores blob content in R2 and sets hash in filemeta, while `create_document_direct` for `.json` creates a Y.Doc without hash.

Actually, the upsert handler is private, so we test the routing decision indirectly. Add an integration-style unit test that verifies the public methods work correctly for blob files. In `crates/relay/src/mcp/tools/create_doc.rs`, add a test that verifies blob files created via `create_blob_file` have hash in the resolver:

This is already tested by the existing `create_json_stores_blob` test. The real test needed is for the upsert handler routing. Since the handler is private and uses axum extractors, the simplest approach is to modify `handle_upsert_document` and verify with the existing integration test suite.

Skip to step 2.

- [ ] **Step 2: Modify `handle_upsert_document` to route `.json` to blob storage**

In `crates/relay/src/server.rs`, replace `handle_upsert_document` (lines 3728-3770):

```rust
async fn handle_upsert_document(
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
    State(server_state): State<Arc<Server>>,
    Json(body): Json<UpsertDocRequest>,
) -> Result<Json<UpsertDocResponse>, AppError> {
    server_state.check_auth(auth_header)?;

    // Ensure path starts with /
    let path = if body.path.starts_with('/') {
        body.path.clone()
    } else {
        format!("/{}", body.path)
    };

    let is_blob = path.to_ascii_lowercase().ends_with(".json");

    if is_blob {
        // JSON files → blob storage (create-only, no updates)
        match server_state
            .create_blob_file(&body.folder, &path, body.content.as_bytes())
            .await
        {
            Ok(result) => Ok(Json(UpsertDocResponse {
                doc_id: result.full_doc_id,
                path: format!("{}{}", body.folder, path),
                created: true,
            })),
            Err(CreateDocumentError::Conflict(msg)) => {
                Err(AppError(StatusCode::CONFLICT, anyhow!("{}", msg)))
            }
            Err(CreateDocumentError::NotFound(msg)) => {
                Err(AppError(StatusCode::NOT_FOUND, anyhow!("{}", msg)))
            }
            Err(e) => Err(AppError(StatusCode::INTERNAL_SERVER_ERROR, anyhow!("{}", e))),
        }
    } else {
        // Markdown/other → Y.Doc (existing behavior with upsert semantics)
        match server_state
            .create_document_direct(&body.folder, &path, &body.content)
            .await
        {
            Ok(result) => Ok(Json(UpsertDocResponse {
                doc_id: result.full_doc_id,
                path: format!("{}{}", body.folder, path),
                created: true,
            })),
            Err(CreateDocumentError::Conflict(_)) => {
                // Already exists — update content instead
                server_state
                    .write_document_content(&body.folder, &path, &body.content)
                    .await
                    .map_err(|e| {
                        AppError(StatusCode::INTERNAL_SERVER_ERROR, anyhow!("{}", e))
                    })?;
                Ok(Json(UpsertDocResponse {
                    doc_id: String::new(),
                    path: format!("{}{}", body.folder, path),
                    created: false,
                }))
            }
            Err(CreateDocumentError::NotFound(msg)) => {
                Err(AppError(StatusCode::NOT_FOUND, anyhow!("{}", msg)))
            }
            Err(e) => Err(AppError(StatusCode::INTERNAL_SERVER_ERROR, anyhow!("{}", e))),
        }
    }
}
```

Key changes:
- `.json` files route to `create_blob_file()` (blob in R2, hash in filemeta)
- `.json` Conflict returns 409 error (no update path — create-only)
- Non-`.json` files keep existing upsert behavior

- [ ] **Step 3: Run tests**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml -p relay 2>&1 | tail -20`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```
fix: route .json files in /doc/upsert to blob storage

Previously, /doc/upsert stored .json files as Y.Docs without a hash,
causing relay-git-sync to skip them and the editor to use a fallback
viewer. Now .json files are stored as R2 blobs with proper filemeta_v0
entries (type "file", hash, mimetype, synctime), matching Obsidian's
format. JSON files are create-only via this endpoint (409 on conflict).
```

---

### Task 3: Handle 409 in add-video pipeline

The pipeline calls `createRelayDoc` for the timestamps.json file via `/doc/upsert`. Now that `.json` conflicts return 409 instead of silently updating, the pipeline should surface this as a clear error.

**Files:**
- Modify: `lens-editor/server/add-video/relay-docs.ts:11-40`

- [ ] **Step 1: Update error message in `upsertRelayDoc` to surface 409**

In `lens-editor/server/add-video/relay-docs.ts`, the existing error handling already throws on non-ok responses. The 409 will be caught and thrown with the status code. No code change needed — the existing `throw new Error(\`Relay upsert failed: ${resp.status} ${text}\`)` already handles it.

Verify by reading the code — skip to step 2.

- [ ] **Step 2: Update relay-docs test for .json conflict**

In `lens-editor/server/add-video/relay-docs.test.ts`, add a test that verifies 409 is surfaced:

```typescript
  it('throws on 409 conflict for .json files', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      text: async () => 'Path already exists',
    });

    await expect(
      createRelayDoc(
        'Lens Edu/video_transcripts/test.timestamps.json',
        '[{"text":"hello","start":"0:00.00"}]'
      )
    ).rejects.toThrow('Relay upsert failed: 409');
  });
```

- [ ] **Step 3: Run tests**

Run: `cd lens-editor && npx vitest run server/add-video/relay-docs.test.ts 2>&1`
Expected: All tests pass including the new one.

- [ ] **Step 4: Commit**

```
test: verify add-video pipeline surfaces 409 on duplicate .json
```

---

### Task 4: Remove `JsonDocumentView` dead code from editor

With all `.json` files now stored as proper blobs (with hash in filemeta), the `JsonDocumentView` fallback (which syncs a Y.Doc and renders Y.Text content) is dead code. The `isBlobFile` check in `DocumentView` will always match for `.json` files.

**Files:**
- Modify: `lens-editor/src/App.tsx:24-26,180-215,266-308`

- [ ] **Step 1: Remove `JsonDocumentView` component and its routing**

In `lens-editor/src/App.tsx`:

1. Remove the `useYDoc` import (line 26) — only used by `JsonDocumentView`. Check first that no other component in this file uses it.

2. Remove the `isJsonFile` variable and `JsonDocumentView` routing block. Replace lines 184-215 with:

```typescript
  const isBlobFile = fileEntry?.type === 'file' && fileEntry?.hash;

  if (!docUuid) return <DocumentNotFound />;

  // Show loading while resolving short UUID on cold page load
  if (!activeDocId) {
    return (
      <main className="flex-1 flex items-center justify-center bg-gray-50">
        <div className="text-sm text-gray-500">Loading document...</div>
      </main>
    );
  }

  // Blob files (type "file" with hash) — render read-only viewer, no Y.Doc sync
  if (isBlobFile && fileEntry?.hash && filePath) {
    const fileName = filePath.split('/').pop() ?? undefined;
    const folderName = filePath.split('/').filter(Boolean)[0];
    const folderConfig = FOLDERS.find(f => f.name === folderName);
    const folderDocId = folderConfig ? `${RELAY_ID}-${folderConfig.id}` : '';
    return <BlobDocumentView docId={activeDocId} hash={fileEntry.hash} folderDocId={folderDocId} fileName={fileName} />;
  }

  return (
    <RelayProvider key={activeDocId} docId={activeDocId}>
      <AwarenessInitializer />
      <EditorArea currentDocId={activeDocId} />
      <DisconnectionModal />
    </RelayProvider>
  );
```

This removes: `isJsonFile` variable, the `if (isJsonFile)` block, and the `BlobViewer` import (line 25) since `BlobDocumentView` already imports it internally.

3. Remove the entire `JsonDocumentView` component (lines 266-308).

4. Remove unused imports: `BlobViewer` from line 25 (keep `BlobDocumentView` on line 24), and `useYDoc` from line 26.

- [ ] **Step 2: Verify the editor builds**

Run: `cd lens-editor && npx tsc --noEmit 2>&1 | head -20`
Expected: No type errors.

- [ ] **Step 3: Commit**

```
refactor: remove JsonDocumentView dead code

All .json files now go through blob storage with hash in filemeta_v0,
so they always match the isBlobFile check and render via BlobDocumentView.
The Y.Doc-based JsonDocumentView fallback is no longer reachable.
```

---

### Task 5: Delete and recreate broken timestamps.json entries on production

The existing timestamps.json files on production were created via the old `/doc/upsert` path — stored as Y.Docs without hash. They need to be deleted and recreated as proper blobs.

**Files:**
- No code changes — operational steps only

- [ ] **Step 1: Deploy the updated relay server**

Follow the deployment steps in CLAUDE.md/CLAUDE.local.md:

```bash
# Build release binary
CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo build --manifest-path=crates/Cargo.toml --release --bin relay

# Push code, pull on prod
ssh relay-prod 'cd /root/lens-relay && git pull'

# Copy binary
scp ~/code/lens-relay/.cargo-target/release/relay relay-prod:/root/lens-relay/crates/relay-binary

# Rebuild and restart relay-server
ssh relay-prod 'cd /root/lens-relay && docker compose -f docker-compose.prod.yaml build relay-server && docker compose -f docker-compose.prod.yaml up -d --force-recreate relay-server'
```

- [ ] **Step 2: Deploy the updated lens-editor**

```bash
ssh relay-prod 'cd /root/lens-relay && docker compose -f docker-compose.prod.yaml build lens-editor && docker compose -f docker-compose.prod.yaml up -d --force-recreate lens-editor'
```

- [ ] **Step 3: Identify broken timestamps.json entries**

Use Lens Relay MCP to list all `.timestamps.json` files in Lens Edu:

```
mcp glob "Lens Edu/**/*.timestamps.json"
```

- [ ] **Step 4: Delete broken entries and resubmit videos**

For each broken timestamps.json: delete the filemeta_v0 entry (and the orphaned Y.Doc), then resubmit the video via the add-video bookmarklet to recreate it as a proper blob.

The exact deletion method depends on available tooling — may need a one-off script or MCP delete tool. Coordinate with user on approach.
