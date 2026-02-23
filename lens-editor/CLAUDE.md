# Local Development

You can run the frontend against either production Relay or a local relay-server.

## Port Allocation (Multi-Workspace)

Ports are **auto-detected** from the directory name suffix (`-ws1`, `-ws2`, etc.):

| Service | Workspace 1 (ws1) | Workspace 2 (ws2) |
|---------|-------------------|-------------------|
| Vite dev server | 5173 | 5273 |
| Relay server | 8090 | 8190 |

**This is Workspace 2** - ports auto-configured to 5273 and 8190.

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

### 2. Local (in-memory)

```bash
# Terminal 1: Start relay + auto-populate test data
npm run relay:start

# Terminal 2: Start frontend
npm run dev:local
```

In-memory storage — starts fresh every time. Setup runs automatically after the server is ready. Uses test IDs (`local-test-folder`, `local-welcome`, etc.) with no interference with production.

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
# Requires local relay-server running (port 8190 for ws2)
npm run test:integration
```

Tests default to `http://localhost:8090`. Override with `RELAY_URL` env var. For production Relay, also set `RELAY_TOKEN`.

## Y.Doc Structure (Relay/Obsidian Format)

**Folder Document** has two Y.Maps for document metadata:

```javascript
doc.getMap('filemeta_v0')  // Modern format: Y.Map<path, { id, type, version, ... }>
doc.getMap('docs')         // Legacy format: Y.Map<path, guid>
```

**Important:** For markdown documents, entries must exist in BOTH maps. Obsidian's `SyncStore.getMeta()` treats documents that exist only in `filemeta_v0` as orphaned and deletes them. Always write to both:

```javascript
folderDoc.transact(() => {
  filemeta.set(path, { id, type: 'markdown', version: 0 });
  legacyDocs.set(path, id);  // Required for Obsidian compatibility!
}, origin);
```

**Content Document** (`contents` Y.Text):
```javascript
doc.getText('contents')  // Y.Text containing markdown
```

See `src/test/fixtures/folder-metadata/production-sample.json` for real production data.
