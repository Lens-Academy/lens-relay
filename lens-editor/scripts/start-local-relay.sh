#!/bin/bash
# Start local relay-server with workspace-specific port
#
# Port auto-detection:
#   - lens-editor-ws1 (or no suffix): port 8090
#   - lens-editor-ws2: port 8190
#   - lens-editor-ws3: port 8290
#
# Storage mode (RELAY_STORAGE env var):
#   - "memory" (default): in-memory, data lost on restart
#   - "r2": Cloudflare R2 dev bucket (persistent)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RELAY_CRATES_DIR="$(dirname "$PROJECT_DIR")/crates"

# Extract workspace number from directory name (e.g., "lens-editor-ws2")
# or parent directory (e.g., "ws2/lens-editor")
DIR_NAME=$(basename "$PROJECT_DIR")
PARENT_NAME=$(basename "$(dirname "$PROJECT_DIR")")
if [[ "$DIR_NAME" =~ -ws([0-9]+)$ ]]; then
    WS_NUM="${BASH_REMATCH[1]}"
elif [[ "$PARENT_NAME" =~ ^ws([0-9]+)$ ]]; then
    WS_NUM="${BASH_REMATCH[1]}"
else
    WS_NUM=1
fi

# Calculate port offset
PORT_OFFSET=$(( (WS_NUM - 1) * 100 ))
RELAY_PORT=${RELAY_PORT:-$((8090 + PORT_OFFSET))}

# Select config based on storage mode
RELAY_STORAGE=${RELAY_STORAGE:-memory}
case "$RELAY_STORAGE" in
    r2)
        CONFIG_FILE="relay.local-r2.toml"
        STORAGE_LABEL="R2 dev bucket"
        ;;
    memory|*)
        CONFIG_FILE="relay.local.toml"
        STORAGE_LABEL="in-memory"
        ;;
esac

if [ ! -f "$RELAY_CRATES_DIR/$CONFIG_FILE" ]; then
    echo "Error: Config file not found: $RELAY_CRATES_DIR/$CONFIG_FILE"
    exit 1
fi

# Load R2 credentials from env file if using R2 storage
if [ "$RELAY_STORAGE" = "r2" ] && [ -f "$RELAY_CRATES_DIR/auth.local.env" ]; then
    set -a
    source "$RELAY_CRATES_DIR/auth.local.env"
    set +a
fi

echo "Workspace $WS_NUM: Starting relay-server on port $RELAY_PORT ($STORAGE_LABEL storage)"
echo ""

cd "$RELAY_CRATES_DIR"

PORT=$RELAY_PORT \
RELAY_SERVER_URL="http://localhost:$RELAY_PORT" \
cargo run -p relay -- serve --config "$CONFIG_FILE"
