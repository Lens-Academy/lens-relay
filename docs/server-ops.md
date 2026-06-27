# Relay Server Operations

Production server operations for the relay infrastructure at `relay.lensacademy.org`.

## Server

- **IP:** 46.224.127.155
- **SSH:** `ssh -i ~/.ssh/hetzner_corec root@46.224.127.155`
- **Relay Server ID:** `cb696037-0f72-4e93-8717-4e433129d789`
- **Domain:** lensacademy.org (Cloudflare)

## Architecture

```
Internet → Cloudflare (HTTPS/443) ← cloudflared (outbound tunnel) → relay-server (HTTP/8080)
```

### Cloudflare Tunnel

- **Tunnel ID:** `78fd1b0b-09c6-460d-b9ab-672d3b337cac`
- Traffic routes through Cloudflare Tunnel (no inbound ports needed)
- cloudflared creates outbound-only connection to Cloudflare edge
- Configured in Cloudflare Zero Trust dashboard under Networks → Tunnels

### Docker Containers

1. **cloudflared** — Cloudflare Tunnel connector
   - Image: `cloudflare/cloudflared:latest`
   - Routes `relay.lensacademy.org` to `relay-server:8080`
   - Network: default compose network

2. **relay-server** — Main relay server (customized)
   - Image: `relay-server:custom` (built from modified source)
   - Port: 8080 (internal only, accessed via cloudflared)
   - Config: `/root/relay.toml`
   - Credentials: `/root/auth.env` (R2 access keys)
   - Storage: Cloudflare R2 bucket `lens-relay-storage`
   - Network: default compose network

3. **relay-git-sync** — Git synchronization service
   - Image: `docker.system3.md/relay-git-sync:latest` (with patched persistence.py)
   - Port: 8000 (internal only, receives webhooks from relay-server)
   - Config: `/root/relay-git-sync-data/git_connectors.toml`
   - Data: `/root/relay-git-sync-data/`
   - Network: `lens-relay_default` (joins the compose network)
   - **Started by `scripts/start-git-sync.sh`, NOT by compose.** Its SSH deploy
     key is multi-line and does not interpolate reliably through compose, so a
     compose-created container would start without the key and crash-loop
     (breaking GitHub sync). The script injects the key from file at runtime.
     Restart it — e.g. after a deploy that recreated containers — with
     `bash scripts/start-git-sync.sh`.

4. **lens-editor** — Web editor frontend + Discord bridge
   - Image: `lens-editor:custom` (built from lens-editor/)
   - Port: 3000 (internal, accessed via cloudflared)
   - Includes Discord API proxy (merged from discord-bridge sidecar)
   - Network: default compose network

## Cloudflare R2 Storage

- **Bucket:** `lens-relay-storage`
- **Account ID:** `a6d884b270b09f11bd79a048e42f88d2`
- **Endpoint:** `https://a6d884b270b09f11bd79a048e42f88d2.r2.cloudflarestorage.com`

**relay.toml storage configuration:**
```toml
[store]
type = "cloudflare"
account_id = "a6d884b270b09f11bd79a048e42f88d2"
bucket = "lens-relay-storage"
prefix = ""
```

**Credentials** in `/root/auth.env` (not in relay.toml for security):
```bash
AWS_ACCESS_KEY_ID=<access-key>
AWS_SECRET_ACCESS_KEY=<secret-key>
```

### R2 Storage Structure

Documents and attachments are stored separately with different UUIDs:

```
lens-relay-storage/
├── <relay-id>-<doc-uuid>/           # Documents
│   └── ...                          # CRDT data for each markdown file
└── files/
    └── <relay-id>-<attachment-uuid>/  # Attachments
        └── <filename>                 # Actual image/file data
```

**How attachments are linked:**
1. Markdown document has its own UUID (e.g., `076d2f81-...`)
2. Document content references attachment by filename: `![[my-image.webp]]`
3. `shared_folders.json` metadata maps filename → attachment UUID (e.g., `0c95356e-...`)
4. Attachment stored in R2 at `files/<relay-id>-<attachment-uuid>/`

**Inspecting storage:**
```bash
# List document folders
rclone lsd r2:lens-relay-storage/ | grep -v files

# List attachment folders
rclone lsd r2:lens-relay-storage/files/

# Check attachment metadata
cat /root/relay-git-sync-data/state/cb696037-0f72-4e93-8717-4e433129d789/shared_folders.json | python3 -c "
import sys,json
d = json.load(sys.stdin)
for folder_id, files in d.items():
    for path, meta in files.items():
        if meta.get('type') == 'image':
            print(f'{path}: {meta.get(\"id\")}')" | head -10
```

## Key Files

| File | Purpose |
|------|---------|
| `/root/relay.toml` | Relay server configuration |
| `/root/auth.env` | Cloudflare R2 credentials |
| `/root/relay-git-sync-data/git_connectors.toml` | Maps shared folders to GitHub repos |
| `/root/relay-git-sync-data/webhook_handler.py` | Patched webhook handler (mounted volume) |
| `/root/relay-git-sync-data/persistence.py` | Patched persistence.py for SSH config support |
| `/root/relay-git-sync-data/ssh/config` | SSH config with host aliases for multiple deploy keys |
| `/root/relay-git-sync-data/ssh/git_sync_key` | SSH key for lens-relay repo |
| `/root/relay-git-sync-data/ssh/educational_key` | SSH key for lens-educational-content repo |
| `/root/relay-git-sync-data/ssh/edu_private_key` | SSH key for lens-edu-private-relay repo |

## Git Sync

### Synced Folders

| Obsidian Folder | Shared Folder ID | GitHub Repo | Branch |
|-----------------|------------------|-------------|--------|
| Lens | `fbd5eb54-73cc-41b0-ac28-2b93d3b4244e` | [Lens-Academy/lens-folder-relay](https://github.com/Lens-Academy/lens-folder-relay) | main |
| Lens Edu | `ea4015da-24af-4d9d-ac49-8c902cb17121` | [Lens-Academy/lens-edu-relay](https://github.com/Lens-Academy/lens-edu-relay) | staging |
| Lens Edu Private | `24027431-24c0-42c2-9f8f-04ed0dd458aa` | [Lens-Academy/lens-edu-private-relay](https://github.com/Lens-Academy/lens-edu-private-relay) | main |

- **Sync interval:** Changes committed every ~10 seconds
- **Webhook endpoint:** https://relay.lensacademy.org/git-sync/webhooks

### Git Connector Config

`/root/relay-git-sync-data/git_connectors.toml`:
```toml
[[git_connector]]
shared_folder_id = "fbd5eb54-73cc-41b0-ac28-2b93d3b4244e"
relay_id = "cb696037-0f72-4e93-8717-4e433129d789"
url = "git@github.com:Lens-Academy/lens-folder-relay.git"
branch = "main"
remote_name = "origin"
prefix = ""

[[git_connector]]
shared_folder_id = "ea4015da-24af-4d9d-ac49-8c902cb17121"
relay_id = "cb696037-0f72-4e93-8717-4e433129d789"
url = "git@github.com-educational:Lens-Academy/lens-edu-relay.git"
branch = "staging"
remote_name = "origin"
prefix = ""

[[git_connector]]
shared_folder_id = "24027431-24c0-42c2-9f8f-04ed0dd458aa"
relay_id = "cb696037-0f72-4e93-8717-4e433129d789"
url = "git@github.com-edu-private:Lens-Academy/lens-edu-private-relay.git"
branch = "main"
remote_name = "origin"
prefix = ""
```

### SSH Config for Multiple Repos

GitHub deploy keys can only be used for one repository. To sync multiple folders to different repos, we use SSH host aliases with separate keys.

`/root/relay-git-sync-data/ssh/config`:
```
# Default GitHub (lens-relay)
Host github.com
    HostName github.com
    User git
    IdentityFile /data/ssh/git_sync_key
    IdentitiesOnly yes

# Educational content repo
Host github.com-educational
    HostName github.com
    User git
    IdentityFile /data/ssh/educational_key
    IdentitiesOnly yes

# Private educational content repo
Host github.com-edu-private
    HostName github.com
    User git
    IdentityFile /data/ssh/edu_private_key
    IdentitiesOnly yes
```

**Adding a new repo:**
1. Generate a new SSH key: `ssh-keygen -t ed25519 -f /root/relay-git-sync-data/ssh/<new_key_name> -N ''`
2. Add the public key as a deploy key to the new GitHub repo (with write access)
3. Add a new Host block to `/root/relay-git-sync-data/ssh/config`
4. Add a new `[[git_connector]]` entry using the host alias (e.g., `git@github.com-newrepo:user/repo.git`)
5. Reload the container: `docker restart relay-git-sync` (or, if it isn't running, `bash scripts/start-git-sync.sh`)

**Patched persistence.py:** The stock relay-git-sync image hardcodes a single SSH key. We mount a patched `persistence.py` that uses `-F /data/ssh/config` instead, allowing SSH config-based key selection.

## Common Commands

```bash
# View logs
docker logs -f relay-server
docker logs -f cloudflared
docker logs -f relay-git-sync

# Restart services (restart reuses the existing container)
docker restart relay-server
docker restart cloudflared
docker restart relay-git-sync   # if the container was removed, recreate it: bash scripts/start-git-sync.sh

# Check running containers
docker ps -a

# View relay config
cat /root/relay.toml

# Test SSH connections from git-sync container
docker exec relay-git-sync ssh -F /data/ssh/config -T git@github.com
docker exec relay-git-sync ssh -F /data/ssh/config -T git@github.com-educational
docker exec relay-git-sync ssh -F /data/ssh/config -T git@github.com-edu-private

# Manual sync of a specific folder
docker exec relay-git-sync uv run python cli.py sync \
  --relay-id cb696037-0f72-4e93-8717-4e433129d789 \
  --folder-id <folder-uuid>
```

## Relay Readiness Watchdog

A host-level systemd timer runs `/usr/local/bin/relay-watchdog.sh` every minute. It probes `http://relay-server:8080/ready` from Docker network `lens-relay_default` with `curlimages/curl:8.10.1`. After repeated readiness failures, it restarts only the `relay-server` container.

```bash
# Install or update watchdog files
docker pull curlimages/curl:8.10.1
install -m 0755 scripts/prod/relay-watchdog.sh /usr/local/bin/relay-watchdog.sh
install -m 0755 scripts/prod/relay-watchdog-report.sh /usr/local/bin/relay-watchdog-report.sh
install -m 0644 ops/systemd/relay-watchdog.service /etc/systemd/system/relay-watchdog.service
install -m 0644 ops/systemd/relay-watchdog.timer /etc/systemd/system/relay-watchdog.timer
systemctl daemon-reload
systemctl enable --now relay-watchdog.timer

# Check timer and recent runs
systemctl status relay-watchdog.timer
journalctl -u relay-watchdog.service -n 50
journalctl -t relay-watchdog -n 50

# Restart summaries
/usr/local/bin/relay-watchdog-report.sh 24
/usr/local/bin/relay-watchdog-report.sh 168

# Disable auto-restarts
systemctl disable --now relay-watchdog.timer
```

Counters are stored in `/var/lib/lens-relay-watchdog/state.env`. Restart events are appended to `/var/log/lens-relay-watchdog/restarts.jsonl`, and human-readable events are logged under `journalctl -t relay-watchdog`.

Environment overrides are supported by the watchdog script, including `RELAY_WATCHDOG_NETWORK`, `RELAY_WATCHDOG_FAILS_REQUIRED`, `RELAY_WATCHDOG_TIMEOUT_SECONDS`, and `RELAY_WATCHDOG_CURL_IMAGE`.

## Content Validation

Educational content is validated using a TypeScript parser/validator published as an npm package.

- **Package:** [lens-content-processor](https://www.npmjs.com/package/lens-content-processor) (v0.1.0)
- **Source:** Part of the lens-platform repo (`content_processor/`)

```bash
# Validate a content directory
npx lens-content-processor ./path/to/content --output result.json
```

### GitHub Actions Workflow

The `lens-edu-relay` repository has automated validation via `.github/workflows/validate.yml`:
- Pull requests to `main`, manual dispatch, scheduled every 5 minutes (validates `staging` branch)
- Skips if commit is < 5 minutes old or already validated

**Modifying the workflow** — never push directly to the educational content repo. Edit via the relay server:
```bash
ssh -i ~/.ssh/hetzner_corec root@46.224.127.155

vim /root/relay-git-sync-data/repos/cb696037-0f72-4e93-8717-4e433129d789/ea4015da-24af-4d9d-ac49-8c902cb17121/.github/workflows/validate.yml

docker exec relay-git-sync bash -c 'cd /data/repos/cb696037-0f72-4e93-8717-4e433129d789/ea4015da-24af-4d9d-ac49-8c902cb17121 && git add -A && git commit -m "Update workflow" && GIT_SSH_COMMAND="ssh -F /data/ssh/config" git push origin staging'
```

## Lens Editor Production Promotion

The Lens Editor promotion feature lets editors compare `staging` and `main` for
`Lens-Academy/lens-edu-relay`, select specific changed files, and create a
promotion pull request. The feature uses its own scratch clone and GitHub token;
it must not reuse or modify the `relay-git-sync` checkout, container, or keys.

### Environment

Add these variables to the production `.env` used by
`docker-compose.prod.yaml`:

```bash
PROMOTION_ENABLED=true
PROMOTION_REPO_HOST_DIR=/root/lens-editor-promotion-data/repositories
PROMOTION_SSH_DIR=/root/lens-editor-promotion-data/ssh
PROMOTION_REPO_URL=git@github.com-lens-editor-promotion:Lens-Academy/lens-edu-relay.git
PROMOTION_REPO_DIR=/data/lens-editor/promotion-repos/lens-edu-relay
PROMOTION_MAIN_BRANCH=main
PROMOTION_STAGING_BRANCH=staging
PROMOTION_BRANCH_PREFIX=promote/lens-editor
PROMOTION_MERGE_METHOD=SQUASH
PROMOTION_GITHUB_OWNER=Lens-Academy
PROMOTION_GITHUB_REPO=lens-edu-relay
GITHUB_TOKEN=github_pat_with_pull_request_and_automerge_permissions
```

`PROMOTION_ENABLED=false` disables the routes. With
`PROMOTION_ENABLED=true`, all required variables above must be present or the
promotion API returns a configuration error.

`PROMOTION_REPO_HOST_DIR` is mounted into the Lens Editor container at
`/data/lens-editor/promotion-repos`. `PROMOTION_REPO_DIR` is the container path
for the scratch clone and should stay under that mount.

Create a dedicated promotion SSH key and config, separate from relay-git-sync:

```bash
mkdir -p /root/lens-editor-promotion-data/ssh /root/lens-editor-promotion-data/repositories
ssh-keygen -t ed25519 -f /root/lens-editor-promotion-data/ssh/promotion_key -N ''
ssh-keyscan github.com > /root/lens-editor-promotion-data/ssh/known_hosts
cat >/root/lens-editor-promotion-data/ssh/config <<'EOF'
Host github.com-lens-editor-promotion
    HostName github.com
    User git
    IdentityFile /data/lens-editor-promotion-ssh/promotion_key
    UserKnownHostsFile /data/lens-editor-promotion-ssh/known_hosts
    IdentitiesOnly yes
EOF
chmod 700 /root/lens-editor-promotion-data/ssh
chmod 600 /root/lens-editor-promotion-data/ssh/promotion_key /root/lens-editor-promotion-data/ssh/config
chmod 644 /root/lens-editor-promotion-data/ssh/known_hosts
```

Verify GitHub's SSH host key fingerprint out of band before rollout; do not
blindly trust a stale or unexpected `ssh-keyscan` result.

Add `promotion_key.pub` as a write-enabled deploy key for
`Lens-Academy/lens-edu-relay`. This key is only for promotion branches and must
not be one of the relay-git-sync keys. The Lens Editor image includes `git` and
`openssh-client`; compose sets `GIT_SSH_COMMAND=ssh -F
/data/lens-editor-promotion-ssh/config` for promotion Git operations.

The GitHub token is for GitHub API operations: creating pull requests and
enabling auto-merge. It is not used by `git clone`/`git push` while the remote
uses SSH. The promotion service never pushes to `staging`; it only pushes
short-lived branches whose names begin with `PROMOTION_BRANCH_PREFIX`. Keep
GitHub branch protection or rulesets enabled for `main` and `staging`; a
write-enabled deploy key cannot enforce branch-prefix restrictions by itself.

Let the promotion service create the scratch clone on first use. It marks that
checkout with local git config and rejects existing checkouts without that
marker, even when the origin URL matches, so it cannot accidentally clean or
reset a relay-git-sync checkout. If `PROMOTION_REPO_DIR` already contains a
manual or old promotion clone, delete that scratch directory before enabling
promotion and let Lens Editor recreate it.

### Rollout Gates

Before setting `PROMOTION_ENABLED=true` in production, confirm whether pushing
short-lived promotion branches to `Lens-Academy/lens-edu-relay` is acceptable.
If same-repo promotion branches are not allowed, configure a GitHub App or fork
push target first and update the promotion remote/head handling accordingly.

Verify relay-git-sync isolation before rollout:

- `PROMOTION_REPO_HOST_DIR` and `PROMOTION_SSH_DIR` must not be inside
  relay-git-sync's data directory.
- The promotion service must not mount or reuse relay-git-sync's working
  checkout.
- The promotion service must not reuse relay-git-sync's SSH private key.
- The promotion service must not restart, signal, inspect, or modify the
  `relay-git-sync` container.
- Do not run `scripts/start-git-sync.sh` or any Docker command targeting
  `relay-git-sync` as part of promotion setup.
- The only Git writes allowed from promotion are pushes of branches matching
  `PROMOTION_BRANCH_PREFIX`; never `staging`.

Run these checks on the production server:

```bash
set -euo pipefail
set -a
. ./.env
set +a
: "${PROMOTION_REPO_HOST_DIR:?set PROMOTION_REPO_HOST_DIR in .env}"
: "${PROMOTION_SSH_DIR:?set PROMOTION_SSH_DIR in .env}"
test -d "$PROMOTION_REPO_HOST_DIR"
test -d "$PROMOTION_SSH_DIR"
docker inspect relay-git-sync --format '{{json .Mounts}}'
case "$(realpath -e "$PROMOTION_REPO_HOST_DIR")/" in
  /root/relay-git-sync-data/*)
    echo "PROMOTION_REPO_HOST_DIR must not be inside relay-git-sync data" >&2
    exit 1
    ;;
esac
case "$(realpath -e "$PROMOTION_SSH_DIR")/" in
  /root/relay-git-sync-data/*)
    echo "PROMOTION_SSH_DIR must not be inside relay-git-sync data" >&2
    exit 1
    ;;
esac
```

Then manually confirm `PROMOTION_REPO_HOST_DIR` and `PROMOTION_SSH_DIR` are
separate persistent directories owned by the Lens Editor service, not by
relay-git-sync.

## Known Issues

### WebSocket File Descriptor Leak

The relay-server leaks socket file descriptors when WebSocket connections close. Sockets accumulate in CLOSE-WAIT state (~70/hour).

**Root cause:** Bug in relay-server (y-sweet) code — doesn't call close() on its end of TCP connections when the remote side closes.

**Workaround:** Increased FD limit to 65536 (from default 1024). Extends time-to-crash from ~14 hours to ~39 days.

### FD Monitoring

A cron job monitors FD usage every 5 minutes.

- **Log:** `/var/log/relay-fd-monitor.log`
- **Scripts:** `/usr/local/bin/relay-fd-monitor.sh`, `/usr/local/bin/relay-fd-report.sh`

```bash
# Quick report with trends
/usr/local/bin/relay-fd-report.sh

# Watch in real-time
tail -f /var/log/relay-fd-monitor.log
```

## Deploying / Updating

cloudflared, relay-server, and lens-editor are managed via
`docker-compose.prod.yaml` at the repo root. `relay-git-sync` is started
separately (see below):

```bash
# Deploy/update the compose-managed services
docker compose -f docker-compose.prod.yaml build
docker compose -f docker-compose.prod.yaml up -d

# Rebuild a single service
docker compose -f docker-compose.prod.yaml build relay-server
docker compose -f docker-compose.prod.yaml up -d relay-server

# relay-git-sync is NOT in compose — (re)start it with its own script.
# Safe to run any time; required after anything that recreated containers.
bash scripts/start-git-sync.sh
```

Because `relay-git-sync` is not in compose, `docker compose down` stops only
cloudflared, relay-server, and lens-editor — it leaves git-sync running. Stop it
explicitly with `docker stop relay-git-sync` when tearing the stack down.

See `.env.example` for required environment variables.

## Troubleshooting

- **FD exhaustion:** Run `/usr/local/bin/relay-fd-report.sh`. If high, `docker restart relay-server`.
- **Container not starting:** Check `docker logs <container>`.
- **Connectivity:** `curl -v https://relay.lensacademy.org`. Check tunnel status in Cloudflare Zero Trust dashboard.
- **Git sync not working:** Check `docker logs --tail 50 relay-git-sync`. Test SSH keys from container. Verify deploy keys have write access on GitHub.
