# Local Development

You can run the frontend against either production Relay or a local relay-server.

## Port Allocation (Multi-Workspace)

Ports are **auto-detected** from the directory name suffix (`-ws1`, `-ws2`, etc.) or the parent workspace directory (`ws1/lens-editor`, `ws2/lens-editor`, etc.):

| Service | Workspace 1 (ws1) | Workspace 2 (ws2) | Workspace 3 (ws3) |
|---------|-------------------|-------------------|-------------------|
| Vite dev server | 5173 | 5273 | 5373 |
| Relay server | 8090 | 8190 | 8290 |

Override with environment variables if needed:
```bash
VITE_PORT=5999 npm run dev
RELAY_PORT=8999 npm run relay:setup
```

## Three Server Modes

### 1. Production Relay (default)

```bash
npm run dev
```

Frontend connects directly to `relay.lensacademy.org`. No local server needed.

### 2. Local filesystem storage

```bash
# Terminal 1: Start relay + auto-populate test data
npm run relay:start

# Terminal 2: Start frontend
npm run dev:local
```

Filesystem-backed local storage at `/tmp/lens-relay-local-store`. Setup runs automatically after the server is ready and refreshes the test IDs (`local-test-folder`, `local-welcome`, etc.) with no interference with production. This is useful for quick isolated testing, but it has known gaps compared with production-shaped data; for workflows involving real folder metadata, blobs, backlinks, or other production-like behavior, use the Lens Relay dev R2 bucket instead. Developers can request dev R2 access from Luc Brinkman.

### 3. Local with R2 (copy of production data)

```bash
# Terminal 1: Start relay backed by R2
npm run relay:start:r2

# Terminal 2: Start frontend with production folder IDs
npm run dev:local:r2
```

Runs a local relay server against the **dev R2 bucket** (`lens-relay-dev`), a copy of production data safe to write to. No setup needed. Requires `crates/auth.local.env` (symlinked from parent dir, gitignored).

**R2 buckets:**
- `lens-relay-dev` — dev bucket, used by `relay:start:r2`
- `lens-relay-storage` — production bucket, used only by the prod server

## Integration Tests

```bash
# Requires local relay-server running (8090 for ws1, 8190 for ws2, 8290 for ws3)
npm run test:integration
```

Tests default to `http://localhost:8090`. Override with `RELAY_URL` env var. For production Relay, also set `RELAY_TOKEN`.

## Y.Doc Structure (Relay/Obsidian Format)

**Folder Document** has two Y.Maps for document metadata:

```javascript
doc.getMap('filemeta_v0')  // Modern format: Y.Map<path, { id, type, version, ... }>
doc.getMap('docs')         // Legacy format: Y.Map<path, guid>
```

Entries under `/_trash/` carry `trashed_at` (unix ms), written by the relay when a
file is deleted (`POST /doc/trash`) and cleared by a move out of the trash. The
relay purges them after `trash_retention_days`; the editor never removes filemeta
entries itself.

**Important:** For markdown documents, entries must exist in BOTH maps. Obsidian's `SyncStore.getMeta()` treats documents that exist only in `filemeta_v0` as orphaned and deletes them. Always write to both:

```javascript
folderDoc.transact(() => {
  filemeta.set(path, { id, type: 'markdown', version: 0 });
  legacyDocs.set(path, id);  // Required for Obsidian compatibility!
}, origin);
```

**Content Document** root types (all written by the relay or the editor, none of them content):

```javascript
doc.getText('contents')      // the markdown itself (CriticMarkup inline for pending suggestions)
doc.getMap('users')          // PermanentUserData: actor key → { ids, ds, meta } (provenance, src/lib/provenance.ts)
doc.getMap('activity_v0')    // direct AI edits: event id → { ts, actor, kind, old, new, client, clock_from, clock_to, anchor, … }
                             // written by the relay's MCP edit path, pruned after 7 days; read by src/lib/activity.ts
                             // for the editor's "Recent" authorship mode and served on /recent via GET /recent-changes
doc.getMap('comments_v0')    // HTML pages only: comment threads, thread id → Y.Map { anchor, status, createdAt,
                             // createdBy, resolvedAt?, resolvedBy?, seen?, originalQuote?, messages: Y.Map<id, {…}> }
                             // (src/components/HtmlEditor/comments/thread-store.ts; the relay's comments MCP tool)
```

See `src/test/fixtures/folder-metadata/production-sample.json` for real production data.

## HTML documents

`.html` files open in `HtmlEditor` (Source / Preview / Split, Desktop / Phone width). The preview's runtime contract
lives in `src/components/HtmlEditor/runtime/page-runtime.ts` (CSP, import map, `buildSrcDoc`) and the in-frame
services in `bridge/page-services.ts`; both are bundled into the bridge by `vite-plugin-bridge-bundle.ts`. Pages that
hang the preview can be opened with `?view=source`. The author-facing rules are the relay doc
`Lens/AI Guide/HTML Pages.md`.

Comments on HTML pages are stored out of band (`comments_v0`, above) and anchored to the rendered page:
- `anchoring/`: the page's visible-text index, describing a click/selection/element as an anchor, and resolving it
  again (exact quote + context → scope → fuzzy → between old context; `guessed` rather than confidently wrong).
- `bridge/comment-layer.ts`: runs in the preview frame; resolves on render and DOM changes, draws highlights and
  badges without touching the page's DOM, and implements Comment mode (button or `C`; Esc leaves).
- `comments/useHtmlComments.ts`: threads, document-order numbering, write-backs (refreshing drifted anchors,
  recording what editors saw for agents) and the one-time migration of old inline `<!--lens-comment-->` markers.
- The page can forge bridge messages: `HtmlPreview.tsx` accepts captures and descriptions only in reply to requests.
- `scripts/anchor-bench/run.ts <dir of .html>` benchmarks anchoring against edits on real pages.
