#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${RELAY_WATCHDOG_CONTAINER:-relay-server}"
NETWORK="${RELAY_WATCHDOG_NETWORK:-lens-relay_default}"
PROBE_URL="${RELAY_WATCHDOG_PROBE_URL:-http://relay-server:8080/ready}"
CURL_IMAGE="${RELAY_WATCHDOG_CURL_IMAGE:-curlimages/curl:8.10.1}"
TIMEOUT_SECONDS="${RELAY_WATCHDOG_TIMEOUT_SECONDS:-5}"
FAILS_REQUIRED="${RELAY_WATCHDOG_FAILS_REQUIRED:-3}"
STATE_DIR="${RELAY_WATCHDOG_STATE_DIR:-/var/lib/lens-relay-watchdog}"
LOG_DIR="${RELAY_WATCHDOG_LOG_DIR:-/var/log/lens-relay-watchdog}"
STATE_FILE="$STATE_DIR/state.env"
RESTART_LOG="$LOG_DIR/restarts.jsonl"
TAG="relay-watchdog"

log_info() {
  logger -t "$TAG" "$*"
}

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

if ! is_positive_integer "$TIMEOUT_SECONDS"; then
  log_info "invalid configuration: RELAY_WATCHDOG_TIMEOUT_SECONDS must be a positive base-10 integer without leading zeros, got '$TIMEOUT_SECONDS'"
  exit 2
fi

if ! is_positive_integer "$FAILS_REQUIRED"; then
  log_info "invalid configuration: RELAY_WATCHDOG_FAILS_REQUIRED must be a positive base-10 integer without leading zeros, got '$FAILS_REQUIRED'"
  exit 2
fi

mkdir -p "$STATE_DIR" "$LOG_DIR"
chmod 0755 "$STATE_DIR" "$LOG_DIR"

fail_count=0
total_restarts=0
last_restart_at=""

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

strip_simple_shell_quoting() {
  local value="$1"
  if [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
    value="${value//\\\"/\"}"
    value="${value//\\\\/\\}"
  fi
  printf '%s' "$value"
}

validate_state_number() {
  local name="$1"
  local value="$2"
  if [[ "$value" =~ ^(0|[1-9][0-9]*)$ ]]; then
    printf '%s' "$value"
  else
    log_info "invalid state: $name must be a non-negative base-10 integer without leading zeros, got '$value'; resetting to 0"
    printf '0'
  fi
}

read_state() {
  local line key value
  if [[ ! -f "$STATE_FILE" ]]; then
    return 0
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      fail_count=* | total_restarts=* | last_restart_at=*)
        key="${line%%=*}"
        value="${line#*=}"
        value="$(strip_simple_shell_quoting "$value")"
        case "$key" in
          fail_count)
            fail_count="$(validate_state_number "$key" "$value")"
            ;;
          total_restarts)
            total_restarts="$(validate_state_number "$key" "$value")"
            ;;
          last_restart_at)
            last_restart_at="$value"
            ;;
        esac
        ;;
    esac
  done < "$STATE_FILE"
}

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read())[1:-1])'
}

probe() {
  local status
  if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
    log_info "probe infrastructure failure: docker network '$NETWORK' does not exist"
    return 2
  fi

  if ! docker image inspect "$CURL_IMAGE" >/dev/null 2>&1; then
    log_info "probe infrastructure failure: curl image '$CURL_IMAGE' is not present locally"
    return 2
  fi

  if docker run --rm --pull=never --network "$NETWORK" "$CURL_IMAGE" \
    -fsS --max-time "$TIMEOUT_SECONDS" "$PROBE_URL" >/dev/null; then
    return 0
  else
    status=$?
  fi

  if [[ "$status" == "125" ]]; then
    log_info "probe infrastructure failure: docker run exited 125 for image='$CURL_IMAGE' network='$NETWORK'"
    return 2
  fi

  return 1
}

container_running_state() {
  local running
  if ! running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)"; then
    log_info "container infrastructure failure: docker inspect failed for container='$CONTAINER'"
    return 2
  fi

  case "$running" in
    true)
      return 0
      ;;
    false)
      return 1
      ;;
    *)
      log_info "container infrastructure failure: unexpected State.Running='$running' for container='$CONTAINER'"
      return 2
      ;;
  esac
}

container_status=0
container_running_state || container_status=$?
if [[ "$container_status" == "2" ]]; then
  exit 0
fi

read_state

failure_reason=""
if [[ "$container_status" == "1" ]]; then
  failure_reason="container_not_running"
  fail_count=$((fail_count + 1))
  write_state "$fail_count" "$total_restarts" "$last_restart_at"
  log_info "probe failed: reason=$failure_reason fail_count=$fail_count required=$FAILS_REQUIRED"
else
  probe_status=0
  probe || probe_status=$?
  case "$probe_status" in
    0)
      if [[ "$fail_count" != "0" ]]; then
        log_info "probe recovered; resetting fail_count from $fail_count to 0"
      fi
      write_state 0 "$total_restarts" "$last_restart_at"
      exit 0
      ;;
    2)
      exit 0
      ;;
  esac

  failure_reason="ready_failed"
  fail_count=$((fail_count + 1))
  write_state "$fail_count" "$total_restarts" "$last_restart_at"
  log_info "probe failed: url=$PROBE_URL network=$NETWORK timeout=${TIMEOUT_SECONDS}s fail_count=$fail_count required=$FAILS_REQUIRED"
fi

if (( fail_count < FAILS_REQUIRED )); then
  exit 0
fi

now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
old_container_id="$(docker inspect -f '{{.Id}}' "$CONTAINER" 2>/dev/null || true)"
old_started_at="$(docker inspect -f '{{.State.StartedAt}}' "$CONTAINER" 2>/dev/null || true)"

log_info "restarting $CONTAINER after $fail_count consecutive failures reason=$failure_reason"
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

printf '{"ts":"%s","container":"%s","reason":"%s","consecutive_failures":%s,"total_restarts":%s,"old_container_id":"%s","new_container_id":"%s","old_started_at":"%s","new_started_at":"%s"}\n' \
  "$now" "$CONTAINER" "$failure_reason" "$FAILS_REQUIRED" "$total_restarts" \
  "$old_container_id_json" "$new_container_id_json" "$old_started_at_json" "$new_started_at_json" \
  >> "$RESTART_LOG"

log_info "restart complete: container=$CONTAINER total_restarts=$total_restarts started_at=$new_started_at"
