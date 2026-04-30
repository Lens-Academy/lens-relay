#!/usr/bin/env bash
set -euo pipefail

STATE_FILE="${RELAY_WATCHDOG_STATE_FILE:-/var/lib/lens-relay-watchdog/state.env}"
RESTART_LOG="${RELAY_WATCHDOG_RESTART_LOG:-/var/log/lens-relay-watchdog/restarts.jsonl}"
SINCE_HOURS="${1:-24}"

usage() {
  echo "Usage: $0 [positive-hours-lookback]" >&2
  echo "error: hours lookback must be a positive base-10 integer without leading zeroes" >&2
}

if [[ ! "$SINCE_HOURS" =~ ^[1-9][0-9]*$ ]]; then
  usage
  exit 2
fi

fail_count=0
total_restarts=0
last_restart_at=""

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
  local value="$1"
  if [[ "$value" =~ ^(0|[1-9][0-9]*)$ ]]; then
    printf '%s' "$value"
  else
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
            fail_count="$(validate_state_number "$value")"
            ;;
          total_restarts)
            total_restarts="$(validate_state_number "$value")"
            ;;
          last_restart_at)
            last_restart_at="$value"
            ;;
        esac
        ;;
    esac
  done < "$STATE_FILE"
}

read_state

echo "Relay watchdog summary"
echo "State file: $STATE_FILE"
echo "Restart log: $RESTART_LOG"
echo "Current consecutive failures: $fail_count"
echo "Total auto-restarts: $total_restarts"
echo "Last auto-restart: ${last_restart_at:-never}"

if [[ ! -f "$RESTART_LOG" ]]; then
  echo "Recent auto-restarts in last ${SINCE_HOURS}h: 0"
  exit 0
fi

if command -v jq >/dev/null 2>&1; then
  cutoff_epoch="$(date -u -d "$SINCE_HOURS hours ago" +%s)"
  recent_count="$(
    jq -Rn --argjson cutoff "$cutoff_epoch" '
      [
        inputs
        | fromjson?
        | try select((.ts | fromdateiso8601) >= $cutoff) catch empty
      ]
      | length
    ' "$RESTART_LOG"
  )"
  echo "Recent auto-restarts in last ${SINCE_HOURS}h: $recent_count"
  echo
  echo "Recent restart events:"
  jq -Rcn --argjson cutoff "$cutoff_epoch" '
    inputs
    | fromjson?
    | try select((.ts | fromdateiso8601) >= $cutoff) catch empty
  ' "$RESTART_LOG" | tail -20
else
  echo "jq not installed; showing last 20 restart events without time filtering"
  tail -20 "$RESTART_LOG"
fi
