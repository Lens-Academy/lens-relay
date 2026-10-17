# Relay Watchdog
Detects when `relay-server` is still running but `/ready` is unresponsive, then restarts only that container.
A container that has not yet answered since its current start is left alone for `RELAY_WATCHDOG_STARTUP_GRACE_SECONDS` (default 300), so a slow startup is not restarted into a loop; see `docs/server-ops.md`.
The source files live in `scripts/prod/relay-watchdog*.sh` and `ops/systemd/relay-watchdog.*`.
On production they are installed as host-level systemd files under `/usr/local/bin/` and `/etc/systemd/system/`, separate from Docker Compose, so a deploy does not update them: reinstall after changing them (`docs/server-ops.md`).
Check status with `systemctl status relay-watchdog.timer` and `systemctl list-timers relay-watchdog.timer`.
Check restart frequency with `/usr/local/bin/relay-watchdog-report.sh 24` or `168`.
Restart events are stored in `/var/log/lens-relay-watchdog/restarts.jsonl`; state is in `/var/lib/lens-relay-watchdog/state.env`.
Disable with `systemctl disable --now relay-watchdog.timer`.
