# Codebase Structure

**Analysis Date:** 2026-02-08

## Directory Layout

```
lens-relay/
├── crates/                          # Rust monorepo (workspace root)
│   ├── relay/                       # Main CRDT sync server binary
│   ├── y-sweet-core/                # Core CRDT, auth, storage logic (library)
│   ├── y-sign/                      # Token signing CLI utility
│   ├── y-sweet-worker/              # Cloudflare Workers build (excluded from workspace)
│   ├── specs/                       # RFC-style architecture documents
│   ├── relay.toml                   # Server config (auth keys, storage backend)
│   ├── Dockerfile                   # Production Docker image
│   └── Cargo.toml                   # Workspace manifest
│
├── lens-editor/                     # React web editor (Node.js)
│   ├── src/
│   │   ├── main.tsx                 # Entry point
│   │   ├── App.tsx                  # Root component with routing
│   │   ├── components/              # Feature-based React components
│   │   ├── hooks/                   # Custom React hooks (metadata, sync, etc.)
│   │   ├── lib/                     # Utility functions (relay API, auth, parsing)
│   │   ├── contexts/                # React context providers
│   │   ├── providers/               # Higher-order providers (RelayProvider)
│   │   ├── test/                    # Test fixtures and helpers
│   │   └── assets/                  # Static assets (CSS, images)
│   ├── public/                      # Vite static files
│   ├── scripts/                     # Build and setup scripts
│   └── package.json                 # Dependencies and npm scripts
│
├── debugger/                        # Next.js Y.Doc inspection tool
│   ├── src/app/                     # Next.js pages
│   └── package.json
│
├── python/                          # Python SDK for server-to-server access
│   └── src/relay_sdk/               # DocumentManager, connection handling
│
├── docs/                            # Operational documentation
│   ├── relay-auth-customizations.md
│   └── server-ops.md
│
├── data/                            # Local development data directory (git ignored)
│
├── .github/workflows/               # GitHub Actions CI/CD
│
└── openapi.yaml                     # API specification
```

## Directory Purposes

**`crates/` (Rust Server):**
- Purpose: Backend document synchronization and persistence
- Contains: WebSocket handler, file storage, authentication, metrics
- Key files: `relay/src/server.rs` (router), `y-sweet-core/src/` (core logic)

**`crates/relay/src/`:**
- Purpose: HTTP/WebSocket API and file operations
- Contains:
  - `main.rs`: CLI parsing, server startup
  - `server.rs`: Axum router, document handlers, WebSocket upgrade
  - `cli.rs`: Token signing and verification commands
  - `webhook.rs`: Webhook config loading from store or env
  - `stores/`: Storage backend implementations
  - `convert.rs`: Data format conversions

**`crates/y-sweet-core/src/`:**
- Purpose: Reusable CRDT and authentication logic
- Contains:
  - `lib.rs`: Module exports
  - `auth.rs`: CWT token signing/verification, permission validation
  - `doc_sync.rs`: Document wrapper with SyncKv layer
  - `doc_connection.rs`: Per-client document state
  - `event.rs`: Event dispatcher for webhooks and metrics
  - `store/mod.rs`: Store trait definition; `s3.rs`: S3 implementation
  - `link_indexer.rs`: Wikilink extraction and backlink tracking
  - `sync_kv.rs`: Key-value storage for non-document state
  - `webhook.rs`: Webhook configuration and dispatch
  - `metrics.rs`: Prometheus metrics collection

**`lens-editor/src/`:**
- Purpose: Browser-based collaborative markdown editor
- Contains:
  - **components/**: Feature-based React components
    - `Editor/`: CodeMirror editor with Yjs binding and extensions
    - `Sidebar/`: File tree navigation
    - `Layout/`: Main layout and editor area
    - `PresencePanel/`: Active collaborators
    - `TableOfContents/`: Document outline
    - `BacklinksPanel/`: Wikilink reverse index
    - `CommentsPanel/`: CriticMarkup discussion tracking
    - `AwarenessInitializer/`: Presence sync setup
    - `ConnectionStatus/`: WebSocket state indicator
  - **hooks/**: Custom React hooks
    - `useFolderMetadata.ts`: Single folder state
    - `useMultiFolderMetadata.ts`: Multi-folder orchestration
    - `useSynced.ts`: Generic Yjs sync hook
    - `useCollaborators.ts`: Awareness presence tracking
  - **lib/**: Utility modules
    - `relay-api.ts`: HTTP API calls (document creation, token fetch)
    - `auth.ts`: Token generation and refresh
    - `document-resolver.ts`: Map doc UUID to file path
    - `link-extractor.ts`: Parse wikilinks from markdown
    - `multi-folder-utils.ts`: Handle multiple folder metadata
    - `criticmarkup-*.ts`: CriticMarkup parsing and actions
  - **contexts/**: React context
    - `NavigationContext.tsx`: Cross-component navigation state
  - **providers/**: HOC providers
    - `RelayProvider.tsx`: YDocProvider wrapper

**`lens-editor/scripts/`:**
- Purpose: Development automation
- Key: `setup-local-relay.mjs`: Create test documents and folder metadata for local dev
- Also: `start-local-relay.sh`: Spawn relay-server process

**`crates/specs/`:**
- Purpose: Architecture and design documentation
- Contains: RFC-style design docs for features (CWT auth, event architecture, webhooks)
- Pattern: One spec per feature; marked as DRAFT/ACCEPTED/IMPLEMENTED

**`python/src/relay_sdk/`:**
- Purpose: Python client library for server-to-server operations
- Contains:
  - `__init__.py`: DocumentManager class (high-level API)
  - `connection.py`: DocConnection (lower-level sync)
  - `error.py`: RelayServerError exception
  - `update.py`: Y.Update encoding/decoding

**`docs/`:**
- Purpose: Operational guides
- Key files:
  - `relay-auth-customizations.md`: HMAC auth fixes and service account support
  - `server-ops.md`: Docker deployment, git-sync webhook setup, monitoring

## Key File Locations

**Entry Points:**
- `crates/relay/src/main.rs`: Rust server startup
- `lens-editor/src/main.tsx`: React web app entry
- `lens-editor/src/App.tsx`: Root component with folder config
- `lens-editor/scripts/setup-local-relay.mjs`: Local dev setup

**Configuration:**
- `crates/relay.toml`: Server config (auth keys, storage)
- `lens-editor/vite.config.ts`: Build and dev server config
- `lens-editor/src/App.tsx`: Folder IDs and relay-server ID (hardcoded)
- `crates/Cargo.toml`: Rust workspace manifest

**Core Logic:**
- `crates/relay/src/server.rs`: HTTP/WebSocket routes (694-753 lines of router definition)
- `crates/y-sweet-core/src/auth.rs`: Token signing and verification
- `crates/y-sweet-core/src/doc_sync.rs`: Document persistence workers
- `lens-editor/src/lib/relay-api.ts`: Client API calls
- `lens-editor/src/hooks/useMultiFolderMetadata.ts`: Multi-folder state management

**Testing:**
- `lens-editor/src/**/*.test.tsx`: Component tests (co-located with source)
- `lens-editor/src/**/*.integration.test.ts`: Integration tests with relay-server
- `lens-editor/src/test/`: Test fixtures and setup helpers
- `lens-editor/src/test/fixtures/`: Mock folder metadata and documents

## Naming Conventions

**Files:**
- Rust: `snake_case.rs` (e.g., `doc_sync.rs`, `link_indexer.rs`)
- TypeScript: `camelCase.ts` (e.g., `relay-api.ts`, `document-resolver.ts`)
- React Components: `PascalCase.tsx` (e.g., `Editor.tsx`, `Sidebar.tsx`)
- Test files: `*.test.ts`, `*.test.tsx`, `*.integration.test.ts`

**Directories:**
- Rust modules: `snake_case` with module files in `mod.rs` (e.g., `src/store/mod.rs`)
- React feature folders: `PascalCase` with component file matching folder (e.g., `Editor/Editor.tsx`)
- Utility folders: `lowercase` (e.g., `lib/`, `hooks/`, `contexts/`)

**Types & Variables:**
- Rust: `PascalCase` structs/enums, `snake_case` functions/variables
- TypeScript: `camelCase` functions/variables, `PascalCase` types/interfaces
- React components: `PascalCase` exported functions (e.g., `export function Editor()`)

**URL Routes (Relay Server):**
- Modern: `/d/{docId}/as-update`, `/d/{docId}/update`, `/d/{docId}/ws/{docId}`
- Deprecated: `/doc/{docId}/as-update`, `/doc/ws/{docId}`
- Files: `/f/{docId}/upload`, `/f/{docId}/download`, `/f/{docId}/history`
- System: `/ready`, `/metrics`, `/webhook/reload`

## Where to Add New Code

**New Feature in Editor:**
- Component: `lens-editor/src/components/{FeatureName}/{FeatureName}.tsx`
- Tests: `lens-editor/src/components/{FeatureName}/{FeatureName}.test.tsx`
- Hooks (if needed): `lens-editor/src/hooks/use{FeatureName}.ts`
- Utilities: `lens-editor/src/lib/{feature-name}-utils.ts`

**New Server Endpoint:**
- Handler function: `crates/relay/src/server.rs` (add async fn)
- Route definition: `crates/relay/src/server.rs`, `routes()` method (line 694+)
- Auth check: Use `server_state.check_auth()` for token validation
- Storage: Use `server_state.store` for file operations

**New Core CRDT Feature:**
- Module: `crates/y-sweet-core/src/{feature_name}.rs`
- Export: Add `pub mod {feature_name}` to `crates/y-sweet-core/src/lib.rs`
- Tests: `{feature_name}.rs` with `#[cfg(test)] mod tests`

**New Utility Function (shared across clients):**
- TypeScript: `lens-editor/src/lib/{function-name}.ts`
- Python: `python/src/relay_sdk/{module_name}.py`
- Rust: `crates/y-sweet-core/src/{module_name}.rs`

**New Test:**
- Unit: Co-locate with source file as `*.test.ts` or `*.test.tsx`
- Integration: `lens-editor/src/lib/{feature}.integration.test.ts`
- Run: `npm run test` (vitest watch), `npm run test:run` (single run), `npm run test:coverage`

## Special Directories

**`.jj/` (Jujutsu VCS):**
- Purpose: Non-colocated jj repository (version control)
- Generated: Yes (by jj)
- Committed: No (but `.jj/` exists in repo)

**`data/` (Local Dev Only):**
- Purpose: Relay server data directory for local development
- Generated: Yes (by `npm run relay:start`)
- Committed: No (git ignored)

**`.planning/codebase/` (GSD Analysis):**
- Purpose: Codebase documentation for AI planning
- Generated: Yes (by `/gsd:map-codebase` command)
- Committed: Yes (but may be overwritten by GSD)
- Contents: ARCHITECTURE.md, STRUCTURE.md, STACK.md, TESTING.md, CONVENTIONS.md, CONCERNS.md

**`lens-editor/node_modules/` (npm Dependencies):**
- Purpose: Installed packages
- Generated: Yes (by npm install)
- Committed: No (but package-lock.json committed)

**`crates/target/` (Rust Build):**
- Purpose: Compiled artifacts (overridden to shared `.cargo-target` directory)
- Generated: Yes (by cargo build)
- Committed: No
- Note: Shared across workspaces via `CARGO_TARGET_DIR` env var

---

*Structure analysis: 2026-02-08*
