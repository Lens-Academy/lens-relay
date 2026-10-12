#!/usr/bin/env bash
# Tests relay-watchdog.sh against a stub `docker` and `logger`.
# Run: scripts/prod/relay-watchdog.test.sh
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/relay-watchdog.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"

cat > "$T/bin/docker" <<'EOF'
#!/usr/bin/env bash
d="$WD_STUB"
case "$1" in
  inspect)
    [[ -f "$d/inspect_fails" ]] && exit 1
    case "$3" in
      *State.Running*) cat "$d/running" ;;
      *State.StartedAt*) cat "$d/started_at" ;;
      *.Id*) echo "cid" ;;
    esac ;;
  network | image) exit 0 ;;
  run) exit "$(cat "$d/probe_rc")" ;;
  restart)
    echo restart >> "$d/restarts"
    date -u +%Y-%m-%dT%H:%M:%S.%NZ > "$d/started_at" ;;
esac
EOF
cat > "$T/bin/logger" <<'EOF'
#!/usr/bin/env bash
shift 2
echo "$*" >> "$WD_STUB/log"
EOF
chmod +x "$T/bin/docker" "$T/bin/logger"

failures=0
ago() { date -u -d "$1 seconds ago" +%Y-%m-%dT%H:%M:%S.%NZ; }

# setup <container started N seconds ago> <probe exit code: 0 ok, 28 timeout>
setup() {
  rm -rf "$T/stub" "$T/state" "$T/logs"
  mkdir -p "$T/stub"
  echo true > "$T/stub/running"
  : > "$T/stub/restarts"
  : > "$T/stub/log"
  ago "$1" > "$T/stub/started_at"
  echo "$2" > "$T/stub/probe_rc"
}

# run <times> [VAR=value ...]
run() {
  local n="$1"
  shift
  for _ in $(seq "$n"); do
    env WD_STUB="$T/stub" PATH="$T/bin:$PATH" RELAY_WATCHDOG_STATE_DIR="$T/state" \
      RELAY_WATCHDOG_LOG_DIR="$T/logs" "$@" bash "$SCRIPT" || last_rc=$?
  done
}

restarts() { wc -l < "$T/stub/restarts" | tr -d ' '; }
fail_count() { sed -n 's/^fail_count=//p' "$T/state/state.env"; }

expect() {
  local what="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    echo "ok   $what"
  else
    echo "FAIL $what: got '$got', want '$want'"
    failures=$((failures + 1))
  fi
}

# The 2026-10-11 outage: startup outlasts the failure budget.
setup 60 28
run 6
expect "slow startup, never ready: no restart" "$(restarts)" 0
expect "slow startup, never ready: failures not counted" "$(fail_count)" 0

setup 60 0
run 1
echo 28 > "$T/stub/probe_rc"
run 2
expect "hang after a good probe, inside the grace window: counted" "$(fail_count)" 2
run 1
expect "hang after a good probe: restarted on the third failure" "$(restarts)" 1

setup 700 28
run 3
expect "startup that never finishes: restarted once the grace is over" "$(restarts)" 1
run 5
expect "the restarted container gets its own grace" "$(restarts)" 1

setup 60 28
run 3 RELAY_WATCHDOG_STARTUP_GRACE_SECONDS=0
expect "grace disabled: restarted on the third failure" "$(restarts)" 1

setup 172800 28
mkdir -p "$T/state"
printf 'fail_count=0\ntotal_restarts=15\nlast_restart_at=2026-10-11T14:44:00Z\n' > "$T/state/state.env"
run 3
expect "state file from before the grace, hung old container: restarted" "$(restarts)" 1
expect "state file from before the grace: restart total carried on" \
  "$(sed -n 's/^total_restarts=//p' "$T/state/state.env")" 16

setup 60 28
echo garbage > "$T/stub/started_at"
run 3
expect "unreadable start time: no grace, restarted" "$(restarts)" 1

setup 172800 0
run 1
echo 28 > "$T/stub/probe_rc"
run 2
ago 5 > "$T/stub/started_at"
run 4
expect "redeploy while failures were being counted: no restart" "$(restarts)" 0
expect "redeploy while failures were being counted: count reset" "$(fail_count)" 0

setup 60 28
echo false > "$T/stub/running"
run 3
expect "container not running: restarted on the third check" "$(restarts)" 1

setup 60 28
touch "$T/stub/inspect_fails"
run 5
expect "docker inspect failing: nothing done" "$(restarts)" 0

setup 60 0
last_rc=0
run 1 RELAY_WATCHDOG_STARTUP_GRACE_SECONDS=abc
expect "invalid grace value: exit 2" "$last_rc" 2

if ((failures > 0)); then
  echo "$failures failed"
  exit 1
fi
echo "all passed"
