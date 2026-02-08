# External Integrations

**Analysis Date:** 2026-02-08

## APIs & External Services

**Relay.md Network:**
- Relay.md clients (Obsidian plugin, Relay app) - Real-time document collaboration
  - Auth: ECDSA public key verification (configured in `relay.toml` under `[[auth]]`)
  - Protocol: WebSocket at `/y/` endpoint with auth token in query string
  - Server token: Pre-signed service account token for relay-git-sync integration

**Git Sync (relay-git-sync):**
- Webhook receiver: `https://relay-git-connector-staging.fly.dev/` (production: `https://relay-git-sync.fly.dev/`)
  - Trigger: Document changes published to relay-server
  - Config: `crates/webhooks.json.example` defines webhook receivers
  - Data: Document events (sync, push, pull) sent as JSON POST requests
  - Timeout: Configurable per webhook (default 5000ms)
  - Purpose: Syncs relay folder changes to GitHub repositories

**GitHub (via relay-git-sync):**
- Two synced repositories:
  - `Lens-Academy/lens-relay` (main branch) - Syncs from Lens folder
  - `Lens-Academy/lens-edu-relay` (staging branch) - Syncs from Lens Edu folder
  - Auth: SSH key setup required on git-sync connector
  - Mechanism: Bi-directional sync triggered by webhooks

## Data Storage

**Databases:**
- None. Relay uses document-centric storage (no SQL/NoSQL database).

**File Storage:**

**Production (Cloud S3-compatible):**
- Cloudflare R2 bucket: `lens-relay-storage`
  - Endpoint: `https://{account_id}.r2.cloudflarestorage.com`
  - Client library: `rusty-s3` (Rust)
  - Auth: R2 API token (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)
  - Use case: CRDT document snapshots, attachments, metadata

**Alternative Storage Backends:**
- AWS S3 (endpoint: `https://s3.{region}.amazonaws.com`)
  - Auth: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, region
- Backblaze B2 (S3-compatible endpoint)
  - Auth: key_id, application_key
- MinIO (self-hosted S3-compatible)
  - Auth: access_key, secret_key (custom endpoint URL)
- Tigris (Vercel S3-compatible)
  - Auth: access_key_id, secret_access_key
- Filesystem (local dev only)
  - Path: `./data/` directory
  - Not suitable for production (no attachments support)

**In-Memory Storage:**
- Used for local development (`relay.local.toml` config)
- Data lost on server restart
- No attachment support
- Populated by `npm run relay:setup` (test fixtures)

**Configuration Storage:**
- Webhook config stored as `.config/webhooks.json` in main storage backend
- Fallback: reads from `RELAY_SERVER_WEBHOOK_CONFIG` environment variable

## Document Format (Y.js CRDT)

**Folder Document Structure:**
```javascript
// Metadata maps (must both exist for Obsidian compatibility)
doc.getMap('filemeta_v0')  // Modern: Y.Map<path, { id, type, version, ... }>
doc.getMap('docs')         // Legacy: Y.Map<path, guid> - REQUIRED for Obsidian

// Content documents (separate doc per file)
doc.getText('contents')    // Y.Text containing markdown content
```

**Storage Format:**
- Encoded as y-sweet update messages (binary CRDT protocol)
- Stored as snapshots + incremental updates in S3/R2
- CRDT provides conflict-free merge on concurrent edits

## Authentication & Identity

**Auth Provider:**
- Custom ed25519-based implementation (no external provider)
- Two auth types:

**Client Auth (Relay.md clients):**
- Public key verification: ECDSA public keys listed in `relay.toml`
- Token request: POST to `/doc/{docId}/auth` with public key signature
- Response: JWT token + sync endpoint URL
- Implementation: `src/lib/auth.ts` (frontend), `y-sweet-core/src/auth.rs` (backend)

**Server Auth (Service accounts):**
- Bearer token format: custom HMAC-signed token
- Used for: relay-git-sync integration, backend API calls
- Token generation: `y-sign` CLI tool (Rust binary)
- Key type auto-detection: `gen_doc_token_auto()` / `gen_file_token_auto()`
- Implementation: `crates/y-sign/src/main.rs`

**Token Storage (Frontend):**
- Server token hardcoded: `SERVER_TOKEN` in `lens-editor/src/lib/auth.ts` (for relay-git-sync integration)
- Client tokens obtained via auth endpoint, not stored (ephemeral session)
- Local storage: Not used (tokens obtained on demand)

## Monitoring & Observability

**Metrics:**
- Prometheus format exposed on port 9090 (configurable via `METRICS_PORT`)
- Metrics collected: connection counts, document sync times, webhook dispatch timings
- Implementation: `prometheus 0.13` Rust crate
- Scrape endpoint: `http://relay:9090/metrics`

**Logging:**
- Framework: Rust `tracing` + `tracing-subscriber` crates
- Levels: Configurable via `RUST_LOG` environment variable (e.g., `info`, `debug`)
- Format: `pretty` (human-readable) or `json` (structured logging)
- Config: `[logging]` section in `relay.toml`

**Error Tracking:**
- None detected in codebase
- Errors logged via tracing framework only

**Performance:**
- Document sync latency via metrics
- Webhook dispatch timing per request
- No APM (Application Performance Monitoring) integration

## CI/CD & Deployment

**Hosting:**
- Production: Hetzner VPS (46.224.127.155)
- Docker containers orchestrated via command-line or Docker Compose
- Cloudflare Tunnel (no inbound ports) routes `relay.lensacademy.org` to server

**Domain & Network:**
- Public URL: `https://relay.lensacademy.org`
- Relay ID: `cb696037-0f72-4e93-8717-4e433129d789`
- Tunnel: Cloudflare managed (automatic failover)

**Deployment Method:**
- Docker build: `docker build -t relay-server:custom -f crates/Dockerfile crates/`
- Runtime: `docker run` with environment variables and volume mounts
- Config mount: `/root/relay.toml` (read-only)
- Auth env: `/root/auth.env` (cloud storage credentials)
- Data volume: Optional persistent storage for file/memory backends
- Entrypoint: `./run.sh` (handles Tailscale setup, config validation)

**Database Migrations:**
- Not applicable (no SQL database)
- Y.Doc format migration: handled by CRDT merge logic (transparent)

**Reverse Proxy:**
- Cloudflare Tunnel (transparent to application)
- Relay server listens on 0.0.0.0:8080 internally
- HTTPS termination: Cloudflare edge

## Environment Configuration

**Required Environment Variables (Production):**

Relay Server:
```
RELAY_SERVER_URL=https://relay.lensacademy.org   # Public URL (for auth tokens)
RELAY_SERVER_STORAGE=s3://lens-relay-storage      # Storage backend URL
RUST_LOG=info                                      # Logging level
```

For Cloudflare R2:
```
R2_ACCOUNT_ID=abc123...
R2_ACCESS_KEY_ID=token_value
R2_SECRET_ACCESS_KEY=token_secret
```

For AWS S3:
```
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=secret...
AWS_REGION=us-east-1
```

**Optional:**
```
PORT=8080                                  # Override bind port
RELAY_SERVER_HOST=0.0.0.0                  # Bind address
METRICS_PORT=9090                          # Prometheus metrics port
RELAY_SERVER_LOG_FORMAT=json                # Logging format (pretty|json)
RELAY_SERVER_WEBHOOK_CONFIG=[...]          # Webhook configs (JSON array)
TAILSCALE_AUTHKEY=...                      # VPN setup
```

**Development:**
```
VITE_LOCAL_RELAY=true                      # Route frontend to local server
VITE_PORT=5173                             # Frontend port override
RELAY_PORT=8090                            # Backend port override
RELAY_SERVER_URL=http://localhost:8090     # Local relay URL
CARGO_TARGET_DIR=~/.cargo-target           # Shared build cache
```

**Secrets Storage:**
- Local dev: `.env` files (gitignored), `auth.local.env`
- Production: Environment variables injected at container runtime
- Relay tokens: Pre-signed tokens embedded in code (service account token for git-sync)
- R2/S3 credentials: Environment variables only, never in code

## Webhooks & Callbacks

**Incoming Webhooks:**
- None. Relay server is a pull-based sync server (clients connect via WebSocket).

**Outgoing Webhooks:**

**Document Sync Events:**
- Triggered by: Y.Doc updates on relay-server
- Receivers: Configured in `relay.toml` or `RELAY_SERVER_WEBHOOK_CONFIG`
- Payload: JSON containing:
  - `relay_id` - Document identifier
  - `event_type` - 'sync', 'push', 'pull', etc.
  - `timestamp` - Event time
  - Document state/delta (optional)
- Auth: Optional Bearer token per webhook
- Retry: No automatic retry logic (fire-and-forget)
- Timeout: Configurable (default 5000ms)
- Filtering: Optional prefix match (send only events matching document prefix)

**Example Webhook Config:**
```json
{
  "configs": [
    {
      "relay_id": "cb696037-0f72-4e93-8717-4e433129d789",
      "url": "https://relay-git-connector.fly.dev/",
      "timeout_ms": 5000
    },
    {
      "prefix": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "url": "https://custom-webhook.example.com/relay",
      "auth_token": "Bearer secret_token"
    }
  ]
}
```

**Real-Time Sync (WebSocket):**
- Endpoint: `wss://relay.lensacademy.org/y/{docId}`
- Protocol: y-sweet WebSocket (binary CRDT updates)
- Auth: Bearer token in query string
- Bidirectional: Client → server and server → client updates
- Clients: Obsidian plugin, lens-editor web app, any y-sweet client

## Integration Points Summary

| Integration | Type | Direction | Protocol | Purpose |
|------------|------|-----------|----------|---------|
| Relay.md clients | Real-time sync | Bi-directional | WebSocket | Live document collaboration |
| relay-git-sync | Webhook consumer | Outbound | HTTPS POST | Sync to GitHub |
| GitHub | Remote storage | Via git-sync | HTTPS/SSH | Backup, version control |
| Cloudflare R2 | File storage | Bi-directional | S3 API | Document snapshots, attachments |
| Prometheus | Monitoring | Outbound | HTTP | Metrics scraping |

---

*Integration audit: 2026-02-08*
