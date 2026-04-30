# Relay Watchdog Auto-Restart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production watchdog that detects a wedged-but-running `relay-server`, restarts it after repeated `/ready` failures, and records how often auto-restarts happen.

**Architecture:** Use a host-level watchdog script on the Hetzner production VPS, invoked by a systemd timer every minute. The script probes `relay-server` with a one-shot `curlimages/curl` container attached to the same Docker network, increments a persistent failure counter, restarts only `relay-server` after consecutive failures, and appends structured restart events to a local JSONL log plus syslog.

**Tech Stack:** Bash, Docker CLI, `curlimages/curl`, systemd service/timer, `logger`, `jq` for reporting, existing production Docker Compose.

---

## File Structure

- Create: `scripts/prod/relay-watchdog.sh`
  - Host-level watchdog script copied to `/usr/local/bin/relay-watchdog.sh` on production.
  - Probes `http://relay-server:8080/ready` from the production Docker network.
  - Maintains state in `/var/lib/lens-relay-watchdog/state.env`.
  - Appends restart events to `/var/log/lens-relay-watchdog/restarts.jsonl`.

- Create: `scripts/prod/relay-watchdog-report.sh`
  - Host-level report script copied to `/usr/local/bin/relay-watchdog-report.sh` on production.
  - Prints total restart count, recent restart count, last restart time, and recent JSONL entries.

- Create: `ops/systemd/relay-watchdog.service`
  - Oneshot systemd unit that runs the watchdog script.

- Create: `ops/systemd/relay-watchdog.timer`
  - Systemd timer that runs the service every minute.

- Modify: `docs/server-ops.md`
  - Document install, verification, logs, counters, and manual disable steps.

## Design Decisions

- The watchdog checks `/ready`, not `/health`, because `/ready` returned `HTTP 200 {"ok":true}` after recovery while `/health` returned `404`.
- The check runs outside the `relay-server` container so it catches Docker-network hangs similar to the observed cloudflared and lens-editor timeouts.
- The script requires 3 consecutive failures with a 5 second timeout before restarting. With a 1 minute timer, this restarts after roughly 2-3 minutes of confirmed outage.
- Restart frequency is logged two ways:
  - Machine-readable JSONL: `/var/log/lens-relay-watchdog/restarts.jsonl`
  - Human-readable syslog/journal: `journalctl -t relay-watchdog`
- The script restarts only `relay-server`. It does not restart `lens-editor`; the observed editor failures were downstream of relay timeouts and recovered after relay restarted.

---

### Task 1: Add Watchdog Script

**Files:**
- Create: `scripts/prod/relay-watchdog.sh`

- [ ] **Step 1: Create the script**

Create `scripts/prod/relay-watchdog.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${RELAY_WATCHDOG_CONTAINER:-relay-server}"
PROBE_URL="${RELAY_WATCHDOG_PROBE_URL:-http://relay-server:8080/ready}"
CURL_IMAGE="${RELAY_WATCHDOG_CURL_IMAGE:-curlimages/curl:8.10.1}"
TIMEOUT_SECONDS="${RELAY_WATCHDOG_TIMEOUT_SECONDS:-5}"
FAILS_REQUIRED="${RELAY_WATCHDOG_FAILS_REQUIRED:-3}"
STATE_DIR="${RELAY_WATCHDOG_STATE_DIR:-/var/lib/lens-relay-watchdog}"
LOG_DIR="${RELAY_WATCHDOG_LOG_DIR:-/var/log/lens-relay-watchdog}"
STATE_FILE="$STATE_DIR/state.env"
RESTART_LOG="$LOG_DIR/restarts.jsonl"
TAG="relay-watchdog"

mkdir -p "$STATE_DIR" "$LOG_DIR"
chmod 0755 "$STATE_DIR" "$LOG_DIR"

fail_count=0
total_restarts=0
last_restart_at=""

if [[ -f "$STATE_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$STATE_FILE"
  fail_count="${fail_count:-0}"
  total_restarts="${total_restarts:-0}"
  last_restart_at="${last_restart_at:-}"
fi

write_state() {
  local new_fail_count="$1"
  local new_total_restarts="$2"
  local new_last_restart_at="$3"
  umask 022
  {
    printf 'fail_count=%q\n' "$new_fail_count"
    printf 'total_restarts=%q\n' "$new_total_restarts"
    printf 'last_restart_at=%q\n' "$new_last_restart_at"
  } > "$STATE_FILE.tmp"
  mv "$STATE_FILE.tmp" "$STATE_FILE"
}

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read())[1:-1])'
}

log_info() {
  logger -t "$TAG" "$*"
}

probe() {
  local network
  network="$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$CONTAINER" | head -1)"
  if [[ -z "$network" ]]; then
    return 1
  fi

  docker run --rm --network "$network" "$CURL_IMAGE" \
    -fsS --max-time "$TIMEOUT_SECONDS" "$PROBE_URL" >/dev/null
}

container_is_running() {
  docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -qx true
}

if ! container_is_running; then
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  reason="container_not_running"
  fail_count=$((fail_count + 1))
  write_state "$fail_count" "$total_restarts" "$last_restart_at"
  log_info "probe failed: $reason fail_count=$fail_count required=$FAILS_REQUIRED"
  exit 0
fi

if probe; then
  if [[ "$fail_count" != "0" ]]; then
    log_info "probe recovered; resetting fail_count from $fail_count to 0"
  fi
  write_state 0 "$total_restarts" "$last_restart_at"
  exit 0
fi

fail_count=$((fail_count + 1))
write_state "$fail_count" "$total_restarts" "$last_restart_at"
log_info "probe failed: url=$PROBE_URL timeout=${TIMEOUT_SECONDS}s fail_count=$fail_count required=$FAILS_REQUIRED"

if (( fail_count < FAILS_REQUIRED )); then
  exit 0
fi

now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
old_container_id="$(docker inspect -f '{{.Id}}' "$CONTAINER" 2>/dev/null || true)"
old_started_at="$(docker inspect -f '{{.State.StartedAt}}' "$CONTAINER" 2>/dev/null || true)"

log_info "restarting $CONTAINER after $fail_count consecutive readiness failures"
docker restart "$CONTAINER" >/dev/null

new_container_id="$(docker inspect -f '{{.Id}}' "$CONTAINER" 2>/dev/null || true)"
new_started_at="$(docker inspect -f '{{.State.StartedAt}}' "$CONTAINER" 2>/dev/null || true)"
total_restarts=$((total_restarts + 1))
last_restart_at="$now"
write_state 0 "$total_restarts" "$last_restart_at"

old_container_id_json="$(printf '%s' "$old_container_id" | json_escape)"
new_container_id_json="$(printf '%s' "$new_container_id" | json_escape)"
old_started_at_json="$(printf '%s' "$old_started_at" | json_escape)"
new_started_at_json="$(printf '%s' "$new_started_at" | json_escape)"

printf '{"ts":"%s","container":"%s","reason":"ready_failed","consecutive_failures":%s,"total_restarts":%s,"old_container_id":"%s","new_container_id":"%s","old_started_at":"%s","new_started_at":"%s"}\n' \
  "$now" "$CONTAINER" "$FAILS_REQUIRED" "$total_restarts" \
  "$old_container_id_json" "$new_container_id_json" "$old_started_at_json" "$new_started_at_json" \
  >> "$RESTART_LOG"

log_info "restart complete: container=$CONTAINER total_restarts=$total_restarts started_at=$new_started_at"
```

- [ ] **Step 2: Make it executable**

Run:

```bash
chmod +x scripts/prod/relay-watchdog.sh
```

Expected: no output.

- [ ] **Step 3: Run ShellCheck if available**

Run:

```bash
if command -v shellcheck >/dev/null 2>&1; then shellcheck scripts/prod/relay-watchdog.sh; else echo "shellcheck not installed; skipping"; fi
```

Expected: either no ShellCheck findings or `shellcheck not installed; skipping`.

- [ ] **Step 4: Commit**

Run:

```bash
jj describe -m "ops: add relay readiness watchdog script"
```

---

### Task 2: Add Restart Report Script

**Files:**
- Create: `scripts/prod/relay-watchdog-report.sh`

- [ ] **Step 1: Create the report script**

Create `scripts/prod/relay-watchdog-report.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

STATE_FILE="${RELAY_WATCHDOG_STATE_FILE:-/var/lib/lens-relay-watchdog/state.env}"
RESTART_LOG="${RELAY_WATCHDOG_RESTART_LOG:-/var/log/lens-relay-watchdog/restarts.jsonl}"
SINCE_HOURS="${1:-24}"

fail_count=0
total_restarts=0
last_restart_at=""

if [[ -f "$STATE_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$STATE_FILE"
fi

echo "Relay watchdog summary"
echo "State file: $STATE_FILE"
echo "Restart log: $RESTART_LOG"
echo "Current consecutive failures: ${fail_count:-0}"
echo "Total auto-restarts: ${total_restarts:-0}"
echo "Last auto-restart: ${last_restart_at:-never}"

if [[ ! -f "$RESTART_LOG" ]]; then
  echo "Recent auto-restarts in last ${SINCE_HOURS}h: 0"
  exit 0
fi

if command -v jq >/dev/null 2>&1; then
  cutoff_epoch="$(date -u -d "$SINCE_HOURS hours ago" +%s)"
  recent_count="$(
    jq -r --argjson cutoff "$cutoff_epoch" '
      select((.ts | fromdateiso8601) >= $cutoff) | .ts
    ' "$RESTART_LOG" | wc -l
  )"
  echo "Recent auto-restarts in last ${SINCE_HOURS}h: $recent_count"
  echo
  echo "Recent restart events:"
  jq -c --argjson cutoff "$cutoff_epoch" '
    select((.ts | fromdateiso8601) >= $cutoff)
  ' "$RESTART_LOG" | tail -20
else
  echo "jq not installed; showing last 20 restart events without time filtering"
  tail -20 "$RESTART_LOG"
fi
```

- [ ] **Step 2: Make it executable**

Run:

```bash
chmod +x scripts/prod/relay-watchdog-report.sh
```

Expected: no output.

- [ ] **Step 3: Run ShellCheck if available**

Run:

```bash
if command -v shellcheck >/dev/null 2>&1; then shellcheck scripts/prod/relay-watchdog-report.sh; else echo "shellcheck not installed; skipping"; fi
```

Expected: either no ShellCheck findings or `shellcheck not installed; skipping`.

- [ ] **Step 4: Commit**

Run:

```bash
jj describe -m "ops: add relay watchdog restart report"
```

---

### Task 3: Add systemd Unit and Timer

**Files:**
- Create: `ops/systemd/relay-watchdog.service`
- Create: `ops/systemd/relay-watchdog.timer`

- [ ] **Step 1: Create service unit**

Create `ops/systemd/relay-watchdog.service`:

```ini
[Unit]
Description=Lens Relay readiness watchdog
Wants=docker.service
After=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/relay-watchdog.sh
User=root
Group=root
```

- [ ] **Step 2: Create timer unit**

Create `ops/systemd/relay-watchdog.timer`:

```ini
[Unit]
Description=Run Lens Relay readiness watchdog every minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
AccuracySec=10s
Persistent=true
Unit=relay-watchdog.service

[Install]
WantedBy=timers.target
```

- [ ] **Step 3: Validate unit files locally if systemd-analyze is available**

Run:

```bash
if command -v systemd-analyze >/dev/null 2>&1; then systemd-analyze verify ops/systemd/relay-watchdog.service ops/systemd/relay-watchdog.timer; else echo "systemd-analyze not installed; skipping"; fi
```

Expected: either no output from `systemd-analyze verify` or `systemd-analyze not installed; skipping`.

- [ ] **Step 4: Commit**

Run:

```bash
jj describe -m "ops: add relay watchdog systemd timer"
```

---

### Task 4: Document Production Install and Operations

**Files:**
- Modify: `docs/server-ops.md`

- [ ] **Step 1: Add watchdog section after “Common Commands”**

Add this section to `docs/server-ops.md` after the Common Commands block:

````markdown
## Relay Readiness Watchdog

The production relay can occasionally wedge while the Docker container remains `Up`.
Docker's restart policy does not help in that failure mode because the process has not exited.
The relay watchdog checks `http://relay-server:8080/ready` once per minute from the production
Docker network and restarts only `relay-server` after 3 consecutive failures.

### Install or Update

From the production checkout:

```bash
cd /root/lens-relay
install -m 0755 scripts/prod/relay-watchdog.sh /usr/local/bin/relay-watchdog.sh
install -m 0755 scripts/prod/relay-watchdog-report.sh /usr/local/bin/relay-watchdog-report.sh
install -m 0644 ops/systemd/relay-watchdog.service /etc/systemd/system/relay-watchdog.service
install -m 0644 ops/systemd/relay-watchdog.timer /etc/systemd/system/relay-watchdog.timer
systemctl daemon-reload
systemctl enable --now relay-watchdog.timer
```

### Verify

```bash
systemctl status relay-watchdog.timer
systemctl list-timers relay-watchdog.timer
systemctl start relay-watchdog.service
journalctl -u relay-watchdog.service -n 50 --no-pager
/usr/local/bin/relay-watchdog-report.sh 24
```

Expected healthy output:

```text
Relay watchdog summary
Current consecutive failures: 0
Total auto-restarts: 0
Last auto-restart: never
Recent auto-restarts in last 24h: 0
```

### Logs and Counters

| Path | Purpose |
|------|---------|
| `/var/lib/lens-relay-watchdog/state.env` | Current consecutive failure count, total auto-restarts, last restart timestamp |
| `/var/log/lens-relay-watchdog/restarts.jsonl` | One JSON object per automatic restart |
| `journalctl -t relay-watchdog` | Human-readable probe failures and restart events |

Report restart frequency:

```bash
/usr/local/bin/relay-watchdog-report.sh 24   # last 24 hours
/usr/local/bin/relay-watchdog-report.sh 168  # last 7 days
```

### Disable

```bash
systemctl disable --now relay-watchdog.timer
```

Run a one-off check without enabling the timer:

```bash
/usr/local/bin/relay-watchdog.sh
```
````

- [ ] **Step 2: Commit**

Run:

```bash
jj describe -m "docs: document relay readiness watchdog"
```

---

### Task 5: Production Deployment

**Files:**
- Deploy from local repo to `/root/lens-relay` on `relay-prod`
- Install host files under `/usr/local/bin` and `/etc/systemd/system`

- [ ] **Step 1: Check production state**

Run:

```bash
ssh relay-prod 'cd /root/lens-relay && git status --short && docker ps --format "table {{.Names}}\t{{.Status}}"'
```

Expected:
- Only known untracked local backup files, such as `scripts/r2-backup.sh.bak`.
- `relay-server`, `lens-editor`, `cloudflared`, and `relay-git-sync` are running.

- [ ] **Step 2: Copy files to production checkout**

Run from local workspace:

```bash
rsync -av \
  scripts/prod/relay-watchdog.sh \
  scripts/prod/relay-watchdog-report.sh \
  relay-prod:/root/lens-relay/scripts/prod/

rsync -av \
  ops/systemd/relay-watchdog.service \
  ops/systemd/relay-watchdog.timer \
  relay-prod:/root/lens-relay/ops/systemd/
```

Expected: rsync reports the four files transferred.

- [ ] **Step 3: Pull the probe image and install scripts and units on production**

Run:

```bash
ssh relay-prod 'set -euo pipefail
cd /root/lens-relay
docker pull curlimages/curl:8.10.1
install -m 0755 scripts/prod/relay-watchdog.sh /usr/local/bin/relay-watchdog.sh
install -m 0755 scripts/prod/relay-watchdog-report.sh /usr/local/bin/relay-watchdog-report.sh
install -m 0644 ops/systemd/relay-watchdog.service /etc/systemd/system/relay-watchdog.service
install -m 0644 ops/systemd/relay-watchdog.timer /etc/systemd/system/relay-watchdog.timer
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/relay-watchdog.service /etc/systemd/system/relay-watchdog.timer
'
```

Expected: `docker pull` succeeds and `systemd-analyze verify` emits no errors.

- [ ] **Step 4: Run one manual healthy check**

Run:

```bash
ssh relay-prod '/usr/local/bin/relay-watchdog.sh && /usr/local/bin/relay-watchdog-report.sh 24'
```

Expected:

```text
Relay watchdog summary
Current consecutive failures: 0
```

The `Total auto-restarts` value may be `0` on first install or higher if the script has already restarted relay in a later test.

- [ ] **Step 5: Enable timer**

Run:

```bash
ssh relay-prod 'systemctl enable --now relay-watchdog.timer && systemctl list-timers relay-watchdog.timer --no-pager'
```

Expected: `relay-watchdog.timer` appears with a next run time roughly one minute away.

- [ ] **Step 6: Verify no false restart after 3 minutes**

Run:

```bash
ssh relay-prod 'sleep 190; /usr/local/bin/relay-watchdog-report.sh 1; journalctl -u relay-watchdog.service -n 80 --no-pager'
```

Expected:
- `Current consecutive failures: 0`
- No new restart JSONL event unless relay was genuinely unhealthy.
- `relay-server` remains running.

---

### Task 6: Optional Failure-Mode Test in a Maintenance Window

**Files:**
- No repo file changes
- Production state only

- [ ] **Step 1: Lower threshold temporarily for a fast test**

Run:

```bash
ssh relay-prod 'SYSTEMD_EDITOR=tee systemctl edit relay-watchdog.service >/dev/null <<EOF
[Service]
Environment=RELAY_WATCHDOG_PROBE_URL=http://relay-server:8080/definitely-not-ready
Environment=RELAY_WATCHDOG_FAILS_REQUIRED=1
EOF
systemctl daemon-reload
'
```

Expected: no output.

- [ ] **Step 2: Trigger the service once**

Run:

```bash
ssh relay-prod 'before=$(docker inspect -f "{{.State.StartedAt}}" relay-server); systemctl start relay-watchdog.service; after=$(docker inspect -f "{{.State.StartedAt}}" relay-server); echo "before=$before"; echo "after=$after"; /usr/local/bin/relay-watchdog-report.sh 1'
```

Expected:
- `after` is newer than `before`.
- `Total auto-restarts` increased by 1.
- `Recent auto-restarts in last 1h` is at least 1.

- [ ] **Step 3: Remove test override**

Run:

```bash
ssh relay-prod 'rm -f /etc/systemd/system/relay-watchdog.service.d/override.conf
systemctl daemon-reload
systemctl restart relay-watchdog.timer
systemctl start relay-watchdog.service
/usr/local/bin/relay-watchdog-report.sh 1
'
```

Expected:
- `Current consecutive failures: 0`
- Timer is active again with the real `/ready` URL.

---

## Verification Checklist

- [ ] `jj st` was run before and after edits.
- [ ] `scripts/prod/relay-watchdog.sh` is executable.
- [ ] `scripts/prod/relay-watchdog-report.sh` is executable.
- [ ] ShellCheck was run or explicitly unavailable.
- [ ] `systemd-analyze verify` passed locally or explicitly unavailable.
- [ ] Production manual watchdog check passed without restarting healthy relay.
- [ ] Production timer is enabled and listed by `systemctl list-timers relay-watchdog.timer`.
- [ ] Restart frequency is visible through `/usr/local/bin/relay-watchdog-report.sh`.
- [ ] `docs/server-ops.md` documents install, verify, logs, report, and disable commands.

## Key Uncertainties

- The first watchdog run may need to pull `curlimages/curl:8.10.1` if the deployment step did not already pull it. Pull it during installation to avoid a slow first timer run.
- The script auto-detects the first Docker network attached to `relay-server`. If the container is attached to multiple networks later, set `RELAY_WATCHDOG_PROBE_URL` and update `probe()` to choose the intended network explicitly.
- The optional failure-mode test intentionally restarts production relay once. Run it only when a brief reconnect is acceptable.
