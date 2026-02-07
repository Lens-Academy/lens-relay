#!/bin/bash
# Start local relay-server with workspace-specific port
#
# Port auto-detection:
#   - lens-editor-ws1 (or no suffix): port 8090
#   - lens-editor-ws2: port 8190
#   - lens-editor-ws3: port 8290

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RELAY_CRATES_DIR="$(dirname "$PROJECT_DIR")/relay-server/crates"

# Extract workspace number from directory name
DIR_NAME=$(basename "$PROJECT_DIR")
if [[ "$DIR_NAME" =~ -ws([0-9]+)$ ]]; then
    WS_NUM="${BASH_REMATCH[1]}"
else
    WS_NUM=1
fi

# Calculate port offset
PORT_OFFSET=$(( (WS_NUM - 1) * 100 ))
RELAY_PORT=${RELAY_PORT:-$((8090 + PORT_OFFSET))}

echo "Workspace $WS_NUM: Starting relay-server on port $RELAY_PORT (in-memory storage)"
echo ""

cd "$RELAY_CRATES_DIR"

# Run relay-server with port and URL overrides (in-memory storage, no persistence)
# Note: relay.local.toml sets port 8090, we override via env
# RELAY_SERVER_URL must match the actual port so auth responses have correct websocket URL
PORT=$RELAY_PORT \
RELAY_SERVER_URL="http://localhost:$RELAY_PORT" \
cargo run -p relay -- serve --config relay.local.toml
