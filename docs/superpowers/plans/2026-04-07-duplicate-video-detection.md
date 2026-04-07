# Duplicate Video Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject duplicate video submissions at the API boundary before any processing begins, with per-video status in the bookmarklet UI.

**Architecture:** Add a `POST /doc/check` endpoint to the Rust relay that batch-checks path existence in `filemeta_v0` without creating anything. The Node `POST /api/add-video` route calls this before queueing, partitioning videos into "queued" and "already_exists". The bookmarklet renders per-video results.

**Tech Stack:** Rust (axum), TypeScript (Hono), vanilla JS (bookmarklet)

---

### Task 1: Rust — Add `POST /doc/check` endpoint

**Files:**
- Modify: `crates/relay/src/server.rs`

This endpoint accepts a folder name and a list of paths, returning which ones already exist in `filemeta_v0`. No documents are created.

- [ ] **Step 1: Add request/response types and handler**

Add these types and the handler function after the `handle_upsert_document` function (after line ~3807 in `server.rs`):

```rust
#[derive(Deserialize)]
struct CheckDocsRequest {
    folder: String,
    paths: Vec<String>,
}

#[derive(Serialize)]
struct CheckDocsResponse {
    exists: std::collections::HashMap<String, bool>,
}

async fn handle_check_documents(
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
    State(server_state): State<Arc<Server>>,
    Json(body): Json<CheckDocsRequest>,
) -> Result<Json<CheckDocsResponse>, AppError> {
    server_state.check_auth(auth_header)?;

    let docs = server_state.docs();
    let folder_doc_ids = link_indexer::find_all_folder_docs(docs);

    // Find the matching folder doc
    let mut folder_doc_id: Option<String> = None;
    for fid in &folder_doc_ids {
        let awareness = {
            let Some(doc_ref) = docs.get(fid) else {
                continue;
            };
            doc_ref.awareness()
        };
        let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
        let name = y_sweet_core::doc_resolver::read_folder_name(&guard.doc, fid);
        if name == body.folder {
            folder_doc_id = Some(fid.clone());
            break;
        }
    }

    let Some(folder_doc_id) = folder_doc_id else {
        return Err(AppError(
            StatusCode::NOT_FOUND,
            anyhow!("Unknown folder '{}'", body.folder),
        ));
    };

    // Read filemeta_v0 once, check all paths
    let awareness = {
        let Some(doc_ref) = docs.get(&folder_doc_id) else {
            return Err(AppError(
                StatusCode::INTERNAL_SERVER_ERROR,
                anyhow!("Folder doc not loaded"),
            ));
        };
        doc_ref.awareness()
    };
    let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
    let txn = guard.doc.transact();

    let mut exists = std::collections::HashMap::new();
    let filemeta = txn.get_map("filemeta_v0");
    for path in &body.paths {
        let normalized = if path.starts_with('/') {
            path.clone()
        } else {
            format!("/{}", path)
        };
        let found = filemeta
            .as_ref()
            .map(|fm| fm.get(&txn, normalized.as_str()).is_some())
            .unwrap_or(false);
        exists.insert(path.clone(), found);
    }

    Ok(Json(CheckDocsResponse { exists }))
}
```

- [ ] **Step 2: Register the route**

In the `routes()` method (~line 2904), add after the `/doc/upsert` route:

```rust
            .route("/doc/check", post(handle_check_documents))
```

- [ ] **Step 3: Build and verify it compiles**

Run:
```bash
CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo build --manifest-path=crates/Cargo.toml --bin relay 2>&1 | tail -5
```
Expected: `Finished` with no errors.

- [ ] **Step 4: Commit**

```bash
jj new -m "feat(relay): add POST /doc/check endpoint for batch path existence checks"
# stage changes into the new commit by running jj st
```

---

### Task 2: Node — Add `checkRelayDocsExist()` in relay-docs.ts

**Files:**
- Modify: `lens-editor/server/add-video/relay-docs.ts`

- [ ] **Step 1: Add the check function**

Add this export at the end of `relay-docs.ts`:

```typescript
/**
 * Check which paths already exist in a relay folder.
 * Returns a map of path → boolean.
 */
export async function checkRelayDocsExist(
  paths: string[]
): Promise<Record<string, boolean>> {
  if (paths.length === 0) return {};

  const { url, token } = getRelayConfig();

  // All paths share the same folder prefix — extract from first path
  const slashIdx = paths[0].indexOf('/');
  if (slashIdx === -1) {
    throw new Error(`Invalid file path (no folder): ${paths[0]}`);
  }
  const folder = paths[0].slice(0, slashIdx);

  // Strip folder prefix from all paths, add leading /
  const relPaths = paths.map((p) => {
    const idx = p.indexOf('/');
    return '/' + p.slice(idx + 1);
  });

  const resp = await fetch(`${url}/doc/check`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ folder, paths: relPaths }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Relay check failed: ${resp.status} ${text}`);
  }

  const data = (await resp.json()) as { exists: Record<string, boolean> };

  // Re-map back to full paths (folder/path)
  const result: Record<string, boolean> = {};
  for (let i = 0; i < paths.length; i++) {
    result[paths[i]] = data.exists[relPaths[i]] ?? false;
  }
  return result;
}
```

- [ ] **Step 2: Commit**

```bash
jj new -m "feat(add-video): add checkRelayDocsExist() for batch path existence checks"
```

---

### Task 3: Node — Add duplicate check to POST /api/add-video

**Files:**
- Modify: `lens-editor/server/add-video/routes.ts`

- [ ] **Step 1: Add imports**

Add to the imports at the top of `routes.ts`:

```typescript
import { generateFilenameBase } from './export';
import { checkRelayDocsExist } from './relay-docs';
```

- [ ] **Step 2: Replace the queueing logic in the POST handler**

Replace the current POST handler body (lines 82-113) with duplicate checking and per-video results:

```typescript
  router.post('/', async (c) => {
    const body = await c.req.json<{ videos?: VideoPayload[] }>();

    if (!body.videos || !Array.isArray(body.videos) || body.videos.length === 0) {
      return c.json({ error: 'videos array is required and must not be empty' }, 400);
    }

    // Validate each video payload
    for (const video of body.videos) {
      if (!video.video_id || !video.title || !video.channel || !video.url) {
        return c.json({ error: 'Each video must have video_id, title, channel, and url' }, 400);
      }
      if (video.transcript_type !== 'word_level' && video.transcript_type !== 'sentence_level') {
        return c.json({ error: 'transcript_type must be "word_level" or "sentence_level"' }, 400);
      }
      if (!video.transcript_raw?.events || !Array.isArray(video.transcript_raw.events)) {
        return c.json({ error: 'transcript_raw must have an events array' }, 400);
      }
    }

    // Check for existing documents on the relay
    const relayFolder = process.env.RELAY_TRANSCRIPT_FOLDER || 'Lens Edu/video_transcripts';
    const editorBase = process.env.EDITOR_BASE_URL || 'https://editor.lensacademy.org';

    const pathsByVideo = body.videos.map((video) => {
      const filenameBase = generateFilenameBase(video.channel, video.title, video.video_id);
      return `${relayFolder}/${filenameBase}.md`;
    });

    let existsMap: Record<string, boolean> = {};
    try {
      existsMap = await checkRelayDocsExist(pathsByVideo);
    } catch (err) {
      // If the relay is unreachable, log and proceed (don't block on check failure)
      console.error('Duplicate check failed, proceeding without check:', err);
    }

    // Partition into queued vs already_exists
    const results: Array<{
      video_id: string;
      title: string;
      status: 'queued' | 'already_exists';
      id?: string;
      relay_url: string;
    }> = [];

    for (let i = 0; i < body.videos.length; i++) {
      const video = body.videos[i];
      const mdPath = pathsByVideo[i];

      if (existsMap[mdPath]) {
        results.push({
          video_id: video.video_id,
          title: video.title,
          status: 'already_exists',
          relay_url: `${editorBase}/open/${encodeURI(mdPath)}`,
        });
      } else {
        const job = queue.add(video);
        results.push({
          video_id: job.video_id,
          title: job.title,
          status: 'queued',
          id: job.id,
          relay_url: job.relay_url!,
        });
      }
    }

    return c.json({ results });
  });
```

- [ ] **Step 3: Commit**

```bash
jj new -m "feat(add-video): check for duplicate videos before queueing"
```

---

### Task 4: Bookmarklet — Show per-video results with duplicate handling

**Files:**
- Modify: `lens-editor/public/add-video-bookmarklet.js`

- [ ] **Step 1: Update the confirm button handler**

Replace the `.then(function(data) { ... })` success handler inside the confirm button onclick (lines 342-357) with per-video status rendering:

```javascript
    .then(function(data) {
      var queued = 0;
      var dupes = 0;
      var statusDiv = document.getElementById('lens-av-status');
      statusDiv.innerHTML = safeHTML('');

      (data.results || data.jobs || []).forEach(function(r) {
        var div = document.createElement('div');
        div.className = 'lens-av-job ' + (r.status === 'already_exists' ? 'error' : 'done');
        var titleEl = document.createElement('div');
        titleEl.className = 'lens-av-job-title';
        titleEl.textContent = r.title;
        div.appendChild(titleEl);

        var detailEl = document.createElement('div');
        detailEl.className = 'lens-av-job-detail';

        if (r.status === 'already_exists') {
          detailEl.textContent = 'Already exists — ';
          var link = document.createElement('a');
          link.href = r.relay_url || '#';
          link.target = '_blank';
          link.style.color = '#4ecdc4';
          link.textContent = 'open in Lens';
          detailEl.appendChild(link);
          dupes++;
        } else {
          detailEl.textContent = 'Queued — ';
          var link = document.createElement('a');
          link.href = r.relay_url || '#';
          link.target = '_blank';
          link.style.color = '#4ecdc4';
          link.textContent = 'view in Lens';
          detailEl.appendChild(link);
          queued++;
        }
        div.appendChild(detailEl);
        statusDiv.appendChild(div);
      });

      if (dupes > 0 && queued === 0) {
        btn.textContent = 'All videos already exist';
        btn.style.background = '#f0ad4e';
      } else if (dupes > 0) {
        btn.textContent = 'Sent ' + queued + ', ' + dupes + ' already existed';
        btn.style.background = '#f0ad4e';
      } else {
        btn.textContent = 'Sent!';
        btn.style.background = '#5cb85c';
      }
    })
```

- [ ] **Step 2: Commit**

```bash
jj new -m "feat(bookmarklet): show per-video duplicate status after submission"
```

---

### Task 5: Integration test

**Files:**
- Modify: `lens-editor/server/add-video/routes.ts` (response shape changed)

- [ ] **Step 1: Start local relay + editor and manually test**

```bash
# Terminal 1: start relay server
cd lens-editor && npm run relay:start

# Terminal 2: start editor
cd lens-editor && npm run dev:local
```

- [ ] **Step 2: Test duplicate detection end-to-end**

1. Use the bookmarklet to add a video (should succeed, status "queued")
2. Use the bookmarklet to add the same video again (should show "Already exists" with link)
3. Add a batch with one new + one duplicate video (should show mixed results — partial success)

- [ ] **Step 3: Test relay-down graceful degradation**

Stop the relay server, then submit a video via the API. The duplicate check should fail gracefully and the video should still be queued (logged warning, no error to user).

- [ ] **Step 4: Final commit with any fixes**

```bash
jj new -m "fix(add-video): address issues found during integration testing"
```
