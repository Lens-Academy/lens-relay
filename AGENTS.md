# Lens Relay Server (Monorepo)

Fork of [No-Instructions/relay-server](https://github.com/No-Instructions/relay-server) with custom HMAC auth fixes, link indexer, and the lens-editor web client.

## Architecture

```
                    ┌─────────────────────┐
                    │   Cloudflare R2     │
                    │ (lens-relay-storage) │
                    └────────┬────────────┘
                             │
Internet ── Cloudflare ── cloudflared ─┬─ relay-server (Rust, port 8080)
               Tunnel                  │       │
                                       │       │ webhooks
                                       │       ▼
                                       │  relay-git-sync
                                       │   │         │
                                       │   ▼         ▼
                                       │ lens-relay  lens-edu-relay
                                       │ (GitHub)    (GitHub)
                                       │
                                       └─ lens-editor (Node, port 3000)
                                              │
                                              ├─ Static frontend (React + CodeMirror)
                                              └─ Discord API proxy ── Discord API

Clients:
  - Obsidian + Relay.md plugin (real-time collaborative editing)
  - lens-editor (web-based editor, React + CodeMirror)
```

See `lens-editor/AGENTS.md` for Y.Doc structure documentation and editor-specific development guidance.

### Monorepo Layout

```
crates/               # Relay server (Rust, upstream y-sweet fork)
  relay/              #   Main server binary
  y-sweet-core/       #   Core CRDT/auth logic
  y-sign/             #   Token signing CLI
  Dockerfile          #   Production Docker build
lens-editor/          # Web editor (React + CodeMirror + yjs)
docs/                 # Operational documentation
```

## Components

| Component | Location | Description |
|-----------|----------|-------------|
| **relay-server** | `crates/` | Rust-based CRDT sync server (y-sweet). Custom HMAC auth fixes for service accounts. |
| **lens-editor** | `lens-editor/` | Web-based editor for relay documents. React + CodeMirror + yjs. Connects to relay-server via WebSocket. Includes Discord API proxy bridge (Express backend). |
| **relay-git-sync** | External: `No-Instructions/relay-git-sync` | Syncs relay shared folders to GitHub repos via webhooks. Runs as Docker container on production server. |
| **Relay.md plugin** | External: `No-Instructions/Relay` | Obsidian plugin for real-time collaboration via relay-server. |

## Infrastructure

- **Relay server URL:** https://relay.lensacademy.org
- **Production server:** Hetzner VPS (46.224.127.155), Docker containers
- **Storage:** Cloudflare R2 bucket `lens-relay-storage`
- **Tunnel:** Cloudflare Tunnel (no inbound ports needed)
- **Relay ID:** `cb696037-0f72-4e93-8717-4e433129d789`
- **Relay watchdog:** Detects when `relay-server` is running but unresponsive and automatically restarts it; see `docs/relay-watchdog.md`.

## Running The Stack
### Production

```bash
docker compose -f docker-compose.prod.yaml build
docker compose -f docker-compose.prod.yaml up -d
```

Production uses `docker-compose.prod.yaml` to manage relay-server, lens-editor, and cloudflared.
`relay-git-sync` is **not** in compose (its multi-line SSH key won't interpolate reliably); it is started by `scripts/start-git-sync.sh`. A bare `docker compose up -d` therefore won't disturb git-sync.
See `.env.example` for required environment variables and `docs/server-ops.md` for full operational details.

For production share links, the token must be signed with the production secret. Without it, tokens are signed with a dev-only key and will be rejected with 401 "Invalid or expired share token":

```bash
SHARE_TOKEN_SECRET=$(ssh relay-prod 'grep SHARE_TOKEN_SECRET /root/lens-relay/.env | cut -d= -f2') \
  npx tsx scripts/generate-share-link.ts --role edit --folder b0000001-0000-4000-8000-000000000001 --base-url https://editor.lensacademy.org
```

### Deploying to production

The relay binary is built for **x86_64 Linux** (prod's arch) on a developer's own
machine, then shipped to prod and swapped in via `Dockerfile.prebuilt` — a fast copy,
so **prod never compiles**. SSH uses the `relay-prod` alias (host/key setup lives in
local overrides).

**Prod is a small 2-vCPU box.** Don't run heavy processes on it — long builds, or an
agent / Claude Code session — they starve the relay's async runtime and cause the
intermittent slowness / `/review` failures we've hit before. Access prod over SSH from
your own machine and keep builds off the box.

```bash
# 1. Build the x86_64-linux release binary on your machine.
#    On an x86_64 Linux host, a plain release build works:
CARGO_TARGET_DIR=~/.cargo-target-relay cargo build --manifest-path=crates/Cargo.toml --release --bin relay
#    On an arm64 Mac (Apple Silicon), a native build produces an arm64-macOS binary that
#    won't run on prod — cross-compile instead, e.g. with cargo-zigbuild:
#      brew install zig && cargo install cargo-zigbuild
#      rustup target add x86_64-unknown-linux-gnu
#      cargo zigbuild --manifest-path=crates/Cargo.toml --release --bin relay --target x86_64-unknown-linux-gnu

# 2. Push code changes to GitHub, pull on prod (keep source in sync with the binary)
ssh relay-prod 'cd /root/lens-relay && git pull'

# 3. Copy the binary to prod
scp <path-to-built>/relay relay-prod:/root/lens-relay/crates/relay-binary

# 4. Rebuild Docker image (fast — just copies binary, no compilation) and restart
ssh relay-prod 'cd /root/lens-relay && docker compose -f docker-compose.prod.yaml build relay-server && docker compose -f docker-compose.prod.yaml up -d --force-recreate relay-server'
```

If you genuinely can't build off-prod, the last-resort fallback is a CPU-capped build in
a container on prod (`docker run --rm --cpus=1.5 -v /root/lens-relay:/build -w
/build/crates rust:1.89-slim-trixie cargo build --release --bin relay`, then `cp
crates/target/release/relay crates/relay-binary`) — but this loads the box, so prefer a
quiet window.

For lens-editor changes (no Rust), skip steps 1 and 3 and replace `relay-server` with `lens-editor`.

Source code lives at `/root/lens-relay` on prod (git clone from `Lens-Academy/lens-relay`).

### Local Dev 
In local dev, the backend can either use local file storage, or connect to a remote R2 storage that that more closely resembles the production setup.

Use local file storage for most tests and quick tests. Local filesystem storage has known gaps compared with production-shaped data, so use dev R2 for workflows involving real folder metadata, blobs, backlinks, or other production-like behavior.

Always start the relay server and lens-editor together for local development. The npm scripts live in `lens-editor/`, but `npm run relay:start*` starts the Rust relay from `crates/` under the hood.

#### local dev with local file storage
```bash
cd lens-editor
npm install

# Terminal 1: start local relay backend with filesystem-backed test storage
npm run relay:start

# Terminal 2: start Vite frontend against the local relay
npm run dev:local
```

`relay:start` chooses the workspace-specific relay port and runs `relay:setup` automatically after the server is reachable. `relay:setup` initializes the local filesystem with some sample markdown documents that can be used for testing. When adding new features, it can be useful to expand the `relay:setup` script.

After setup, generate an editor share link so the user can open the editor immediately:

```bash
cd lens-editor && npx tsx scripts/generate-share-link.ts --role edit --folder b0000001-0000-4000-8000-000000000001 --base-url http://localhost:5173
```

#### Local Dev With Dev R2
```bash
cd lens-editor
npm install

# Terminal 1: start local relay backed by the dev R2 bucket
npm run relay:start:r2

# Terminal 2: start Vite frontend against the local relay using production-shaped folder IDs
npm run dev:local:r2
```

This uses the dev R2 bucket (`lens-relay-dev`), a copy of production data safe to write to and experiment with. No setup script is needed. Requires `crates/auth.local.env`; developers can request dev R2 access from Luc Brinkman.

## Upstream Sync

The `upstream` remote tracks `No-Instructions/relay-server`. Our additions (`lens-editor/`, `docs/`) don't exist upstream, so merges are clean.

```bash
# Fetch upstream changes
jj git fetch --remote upstream

# Rebase our work on top
jj rebase -s <our-first-custom-change> -d upstream/main
```

## Custom Relay Server Changes

Our fork adds two categories of changes on top of upstream:

**HMAC auth fixes** (enables service accounts to coexist with Relay.md client auth):
- `gen_doc_token_auto()` / `gen_file_token_auto()` — auto-detect key type for token generation
- File token generation for server/prefix tokens in download URLs

See [docs/relay-auth-customizations.md](docs/relay-auth-customizations.md) for full details.

**Link indexer:**
- Wikilink extraction from Y.Doc content
- Backlink tracking
- Folder-content mapping for multi-folder support

## Git Sync

Two shared folders are synced to GitHub:

| Obsidian Folder | GitHub Repo | Branch |
|-----------------|-------------|--------|
| Lens | [Lens-Academy/lens-relay](https://github.com/Lens-Academy/lens-relay) | main |
| Lens Edu | [Lens-Academy/lens-edu-staging](https://github.com/Lens-Academy/lens-edu-staging) | staging |

See [docs/server-ops.md](docs/server-ops.md) for git connector config, SSH key setup, and operational details.

**NEVER push directly to [Lens-Academy/lens-edu-staging](https://github.com/Lens-Academy/lens-edu-staging)** (not via `git push`, `gh api`, or any other method). The `relay-git-sync` container continuously pushes to the `staging` branch of that repo. Any external push will cause divergence, breaking relay-git-sync until manually fixed on the production server.

Edu content CI workflow files live in that repo (`.github/workflows/validate.yml`). To modify them, ask the user for instructions on cloning the repo on the Hetzner relay production server (46.224.127.155) and pushing from there, so relay-git-sync stays in sync.

## Known Issues

- **Production relay hangs** — the relay-server occasionally stops accepting inbound connections while background tasks (GC, saves, webhooks) continue running. Do NOT assume the cause is FD/socket exhaustion; CLOSE-WAIT accumulation is normal and the server handles thousands of leaked FDs fine. Diagnose before restarting: check logs for deadlock signs (no new log output from tokio workers), thread states, and accept queue depth. Past confirmed causes include lock ordering deadlocks (see `docs/plans/2026-03-08-debounce-deadlock-fix.md`).
- **WebSocket FD leak** in relay-server (sockets accumulate in CLOSE-WAIT). This is cosmetically ugly but NOT the cause of hangs. Workaround: `--ulimit nofile=65536:524288` provides headroom.

## Regression Detector

Use `docs/regression-detector.md` when asked to check relay-synced GitHub repos for accidental content reversions.
