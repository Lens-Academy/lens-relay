# Technology Stack

**Analysis Date:** 2026-02-08

## Languages

**Primary:**
- Rust 1.89.0 - Relay server, WebSocket sync server (CRDT), cryptographic operations
- TypeScript 5.9.3 - Web-based editor frontend (React + CodeMirror)
- JavaScript (Node.js 24.13.0) - Build tooling, test scripts, development utilities

**Secondary:**
- TOML - Configuration files (`relay.toml`)
- Bash - Deployment and startup scripts, local dev automation

## Runtime

**Backend:**
- Rust compiler (native binary compiled to `target/release/relay`)
- Server: Tokio async runtime with multi-threaded executor

**Frontend:**
- Node.js 24.13.0 - Development server, build tools, test runner
- Browser (React 19.2.0 + DOM APIs) - Client-side document editing

**Package Manager:**
- npm 11.6.2 - JavaScript dependencies (primary)
- Cargo (Rust 1.93.0) - Rust dependencies

## Frameworks

**Backend:**
- Axum 0.7.4 - HTTP server with WebSocket support (`features: ["ws", "multipart"]`)
- Tokio 1.29.1 - Async runtime (features: macros, rt-multi-thread, signal handling)
- Y-sweet (custom fork) - CRDT document sync server (WebSocket provider)

**Frontend:**
- React 19.2.0 - UI component framework
- Vite 7.2.4 - Development server & build tool (configured in `lens-editor/vite.config.ts`)
- CodeMirror 6.39.11 - Text editor component with Markdown language support
- TailwindCSS 4.1.18 - Utility-first CSS framework

**Client CRDT:**
- yjs 13.6.29 - Shared document data structure
- @y-sweet/client 0.9.1 - WebSocket provider for yjs collaboration
- @y-sweet/react 0.9.1 - React hooks for y-sweet documents
- y-codemirror.next 0.3.5 - CodeMirror + yjs integration

**Testing:**
- Vitest 4.0.18 - Test runner for frontend
- @testing-library/react 16.3.2 - Component testing utilities
- happy-dom 20.4.0 - DOM environment for tests (lightweight alternative to jsdom)

**Build/Dev:**
- TypeScript 5.9.3 - Type checking and compilation (`tsc -b`)
- Tailwind CSS Vite plugin 4.1.18 - CSS framework integration
- ESLint 9.39.1 - Linting configuration (with typescript-eslint)
- Prettier 3.0.0 (declared in debugger only) - Code formatting
- cross-env 10.1.0 - Cross-platform environment variables

## Key Dependencies

**Relay Server (Rust):**

**Critical:**
- `y-sweet-core 0.8.2` (path dep) - Core CRDT sync, authentication, webhook dispatch
- `yrs 0.19.1` - Rust implementation of yjs (CRDT library)
- `yrs-kvstore 0.3.0` - Key-value store adapter for yrs
- `axum 0.7.4` - HTTP framework with WebSocket support
- `tokio 1.29.1` - Async runtime
- `serde_json 1.0.103` - JSON serialization/deserialization

**Authentication & Crypto:**
- `ed25519-dalek 2.1.1` - EdDSA signature verification (features: pkcs8, pem)
- `p256 0.13.2` - P-256 elliptic curve for ECDSA
- `sha2 0.10` - SHA-256 hashing
- `hmac 0.12.1` - HMAC authentication (service account tokens)

**Storage & Cloud:**
- `rusty-s3 0.7.0` (patched from dtkav fork) - S3-compatible object storage client
- `reqwest 0.12.5` - HTTP client (features: rustls-tls, JSON)

**Serialization:**
- `bincode 1.3.3` - Binary encoding for CRDT state
- `toml 0.8` - Configuration file parsing
- `serde 1.0.171` - Serialization framework

**Utilities:**
- `tracing 0.1.37` + `tracing-subscriber 0.3.17` - Logging & observability
- `prometheus 0.13` - Metrics exposition
- `anyhow 1.0.72` - Error handling
- `async-trait 0.1.71` - Async trait support

**Frontend Dependencies:**

**Critical:**
- `@y-sweet/client 0.9.1` - WebSocket provider for real-time sync
- `@y-sweet/react 0.9.1` - React hooks for y-sweet
- `yjs 13.6.29` - Shared CRDT library
- `react-dom 19.2.0` - React DOM rendering
- `codemirror 6.0.2` - Editor component
- `react-arborist 3.4.3` - File tree component

**UI Components:**
- `@radix-ui/react-alert-dialog 1.1.15` - Dialog component
- `@radix-ui/react-context-menu 2.2.16` - Right-click context menu

**Dev Tools:**
- `@vitejs/plugin-react 5.1.1` - React JSX support in Vite
- `typescript-eslint 8.46.4` - TypeScript linting
- `@types/react 19.2.5` - React type definitions
- `@types/react-dom 19.2.3` - React DOM type definitions

## Configuration

**Backend Configuration (`crates/relay.toml`):**

Server settings:
- `[server]` - URL, host (0.0.0.0), port (default 8080)
- `[metrics]` - Prometheus metrics port (default 9090)
- `[logging]` - Level (env: RUST_LOG), format (json or pretty)

Storage options (environment-based):
- `[store]` - Type selector: `filesystem`, `memory`, `s3`, `cloudflare`, `backblaze`, `minio`, `tigris`
- For S3-compatible: bucket, region, access_key_id, secret_access_key, optional path prefix

Authentication:
- `[[auth]]` - Multiple public keys for Relay.md client verification (key_id, public_key)
- Server tokens use HMAC signed tokens (Bearer token in Authorization header)

Webhooks:
- `[[webhooks]]` - External webhook receivers (url, optional auth_token, prefix filter, timeout_ms)
- Also read from `RELAY_SERVER_WEBHOOK_CONFIG` env var (JSON array format)

**Frontend Configuration (`lens-editor/vite.config.ts`):**

- Port auto-detection: workspace suffix (-ws1, -ws2, etc.) → 5173 + offset
- Relay endpoint selection: `VITE_LOCAL_RELAY=true` → localhost:8090 (or offset)
- Vite proxy: `/api/relay/*` routed to relay server (avoids CORS)
- allowedHosts: includes `dev.vps` for SSH tunnel access
- Build output: default Vite config (dist/)

**Environment Variables:**

Frontend (Vite):
- `VITE_LOCAL_RELAY` - 'true' for local development, routes to localhost
- `VITE_PORT` - Override Vite dev server port (default 5173 + offset)
- `VITE_USE_FIXTURES` - 'true' for test fixtures mode
- `RELAY_URL` - Override relay server URL (integration tests)
- `RELAY_TOKEN` - Bearer token for production relay (integration tests)

Backend:
- `PORT` - Relay server port (default 8080)
- `RELAY_SERVER_URL` - Public server URL (required for auth token generation)
- `RELAY_SERVER_HOST` - Bind address (default 0.0.0.0)
- `RELAY_SERVER_STORAGE` - Cloud storage URL (s3://bucket/prefix format)
- `RUST_LOG` - Tracing level (info, debug, etc.)
- `RELAY_SERVER_LOG_FORMAT` - 'json' or 'pretty'
- `RELAY_SERVER_WEBHOOK_CONFIG` - Webhook configs (JSON array)
- `METRICS_PORT` - Prometheus metrics port
- Storage credentials: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, etc.
- For Cloudflare R2: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
- `TAILSCALE_AUTHKEY` - For container VPN setup (optional)

## Build & Deployment

**Backend Build:**

Development:
```bash
cargo run --manifest-path=crates/Cargo.toml --bin relay -- serve --port 8090
```

Production (Docker):
- Dockerfile: `crates/Dockerfile` (multi-stage)
- Builder: Rust 1.89-slim-trixie
- Runtime: Debian trixie-slim with Tailscale included
- Binary: `/app/relay` + `run.sh` entrypoint
- Startup: `./run.sh` validates config, handles Tailscale setup

**Frontend Build:**

Development:
```bash
npm install && npm run dev
# with local relay:
VITE_LOCAL_RELAY=true npm run dev
```

Production:
```bash
npm run build
```
- TypeScript compilation: `tsc -b`
- Vite bundling: outputs to `dist/`

## Platform Requirements

**Development:**
- Rust 1.89+ with Cargo
- Node.js 24.13.0, npm 11.6.2
- Cargo target directory: shared at `~/.cargo-target` or `$CARGO_TARGET_DIR` (optional shared workspace build)

**Production:**
- Docker (Buildkit recommended)
- Container orchestration (Fly.io, Docker Swarm, Kubernetes, etc.)
- Cloud storage (AWS S3, Cloudflare R2, Backblaze B2, MinIO, Tigris, or local filesystem)
- Network connectivity: Outbound HTTPS for webhooks, optional Tailscale VPN

## Dependencies at Risk / Notable Patches

**Custom Patches:**
- `rusty-s3` patched from `dtkav/rusty-s3#main` (upstream fork used for S3 compatibility layer)

**Notable Choices:**
- Tokio with multi-threaded runtime for high concurrency (relay connections)
- Axum chosen over Actix/Rocket for minimal dependencies + strong async trait support
- Happy-dom instead of jsdom for faster test execution (lighter memory footprint)
- Tailwind CSS for zero-runtime utility-first styling

---

*Stack analysis: 2026-02-08*
