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

## Production Relay (default)

```bash
npm run dev
```

Connects to `relay.lensacademy.org` with the shared Lens folder.

## Local Relay Server (isolated testing)

```bash
# Terminal 1: Start local relay-server (port auto-detected: 8190 for ws2)
npm run relay:start

# Terminal 2: Setup test documents (in-memory, need to re-run after each server restart)
npm run relay:setup

# Terminal 3: Run frontend (port auto-detected: 5273 for ws2)
npm run dev:local
```

Local mode uses test IDs (`local-test-folder`, `local-welcome`, etc.) so there's no interference with production data.

**In-memory storage:** Local relay-server uses in-memory storage — data is lost on server restart. Run `npm run relay:setup` after each restart. Production uses S3/R2 cloud storage (see top-level CLAUDE.md).

**Manual startup alternative:**
```bash
cd ../relay-server/crates
PORT=8190 RELAY_SERVER_URL="http://localhost:8190" cargo run -p relay -- serve --config relay.local.toml
```

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
