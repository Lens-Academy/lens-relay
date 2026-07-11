#!/bin/bash
# Start local relay-server with workspace-specific port
#
# Port auto-detection:
#   - ws1 (or no suffix): port 8090
#   - ws1a: port 8091, ws1b: port 8092, etc.
#   - ws2: port 8190, ws2a: port 8191, etc.
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
WS_SUFFIX=""
if [[ "$DIR_NAME" =~ -ws([0-9]+)([a-z]?)$ ]]; then
    WS_NUM="${BASH_REMATCH[1]}"
    WS_SUFFIX="${BASH_REMATCH[2]}"
elif [[ "$PARENT_NAME" =~ ^ws([0-9]+)([a-z]?)$ ]]; then
    WS_NUM="${BASH_REMATCH[1]}"
    WS_SUFFIX="${BASH_REMATCH[2]}"
else
    WS_NUM=1
fi

# Calculate port offset
PORT_OFFSET=$(( (WS_NUM - 1) * 100 ))
SUFFIX_OFFSET=0
if [[ -n "$WS_SUFFIX" ]]; then
    printf -v SUFFIX_CODE '%d' "'$WS_SUFFIX"
    SUFFIX_OFFSET=$((SUFFIX_CODE - 96))
fi
RELAY_PORT=${RELAY_PORT:-$((8090 + PORT_OFFSET + SUFFIX_OFFSET))}

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

# Auto-create the gitignored local filesystem config from the committed
# template on first run, so `npm run relay:start` works out of the box.
if [ ! -f "$RELAY_CRATES_DIR/$CONFIG_FILE" ] \
    && [ "$RELAY_STORAGE" != "r2" ] \
    && [ -f "$RELAY_CRATES_DIR/$CONFIG_FILE.example" ]; then
    echo "Creating $CONFIG_FILE from $CONFIG_FILE.example (first run)"
    cp "$RELAY_CRATES_DIR/$CONFIG_FILE.example" "$RELAY_CRATES_DIR/$CONFIG_FILE"
fi

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

echo "Workspace ws${WS_NUM}${WS_SUFFIX}: Starting relay-server on port $RELAY_PORT ($STORAGE_LABEL storage)"
echo ""

cd "$RELAY_CRATES_DIR"

# For in-memory mode, auto-run setup once the server is ready
if [ "$RELAY_STORAGE" != "r2" ]; then
    (
        # Wait for server to accept connections
        for i in $(seq 1 30); do
            if curl -sf "http://localhost:$RELAY_PORT" >/dev/null 2>&1; then
                echo ""
                echo "Server ready — running relay:setup..."
                cd "$PROJECT_DIR" && node scripts/setup-local-relay.mjs
                echo "Setup complete."
                break
            fi
            sleep 1
        done
    ) &
    SETUP_PID=$!
fi

PORT=$RELAY_PORT \
RELAY_SERVER_URL="http://localhost:$RELAY_PORT" \
cargo run -p relay -- serve --config "$CONFIG_FILE"
