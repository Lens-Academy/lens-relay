#!/usr/bin/env bash
#
# Start (or restart) the relay-git-sync container on the production box.
#
# Why this is not in docker-compose.prod.yaml:
#   relay-git-sync needs its SSH deploy key as the SSH_PRIVATE_KEY env var. The
#   key is a multi-line value that does not interpolate reliably through compose
#   (${VAR} from a multi-line .env), so a compose-created container starts
#   without the key and crash-loops — which silently breaks GitHub sync. This
#   script injects the key (and the other secrets) at runtime instead, reading
#   them from files on the box. No secret is baked into the image or this file.
#
# Run on the box after a deploy that recreated containers, or any time
# relay-git-sync is down:
#   bash scripts/start-git-sync.sh
#
# It joins the same Docker network as relay-server and applies the same log cap
# as the compose services (json-file, 50m x 5).
set -euo pipefail

DATA_DIR=/root/relay-git-sync-data
KEY_FILE="$DATA_DIR/ssh/git_sync_key"
ENV_FILE=/root/lens-relay/.env
NETWORK=lens-relay_default
IMAGE=docker.system3.md/relay-git-sync:latest

[[ -r "$KEY_FILE" ]] || { echo "ERROR: SSH key not readable: $KEY_FILE" >&2; exit 1; }
[[ -r "$ENV_FILE" ]] || { echo "ERROR: env file not readable: $ENV_FILE" >&2; exit 1; }
docker network inspect "$NETWORK" >/dev/null 2>&1 \
  || { echo "ERROR: docker network '$NETWORK' not found (is the compose stack up?)" >&2; exit 1; }

# Pull just the two values this service needs out of .env, without sourcing the
# whole file (it also holds a multi-line SSH_PRIVATE_KEY that would break a
# naive `source`). Strips an optional pair of surrounding quotes.
read_env() {
  local val
  val=$(grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-)
  # Strip one pair of surrounding quotes only if both ends match.
  if [[ "$val" == \"*\" || "$val" == \'*\' ]]; then
    val=${val:1:${#val}-2}
  fi
  printf '%s' "$val"
}

RELAY_SERVER_API_KEY=$(read_env RELAY_SERVER_API_KEY)
WEBHOOK_SECRET=$(read_env WEBHOOK_SECRET)
[[ -n "$RELAY_SERVER_API_KEY" ]] || { echo "ERROR: RELAY_SERVER_API_KEY missing from $ENV_FILE" >&2; exit 1; }
[[ -n "$WEBHOOK_SECRET" ]] || { echo "ERROR: WEBHOOK_SECRET missing from $ENV_FILE" >&2; exit 1; }

# Remove any existing container (running or stopped) before recreating.
docker rm -f relay-git-sync 2>/dev/null || true

docker run -d \
  --name relay-git-sync \
  --restart unless-stopped \
  --network "$NETWORK" \
  -p 127.0.0.1:8001:8000 \
  --log-opt max-size=50m \
  --log-opt max-file=5 \
  -v "$DATA_DIR:/data" \
  -v "$DATA_DIR/webhook_handler.py:/app/webhook_handler.py" \
  -v "$DATA_DIR/persistence.py:/app/persistence.py" \
  -e RELAY_GIT_DATA_DIR=/data \
  -e RELAY_SERVER_URL=http://relay-server:8080 \
  -e RELAY_SERVER_API_KEY="$RELAY_SERVER_API_KEY" \
  -e WEBHOOK_SECRET="$WEBHOOK_SECRET" \
  -e SSH_PRIVATE_KEY="$(cat "$KEY_FILE")" \
  "$IMAGE"

echo "relay-git-sync started on network $NETWORK. Check: docker logs --tail 20 relay-git-sync"
