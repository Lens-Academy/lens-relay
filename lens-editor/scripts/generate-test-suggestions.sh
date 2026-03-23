#!/bin/bash
# Generate ~100 CriticMarkup suggestions via MCP edit tool for testing bulk accept.
# Uses the local relay server's MCP endpoint.

set -e

API_KEY="${MCP_API_KEY:-test-key-123}"
BASE_URL="${RELAY_URL:-http://localhost:8090}"
MCP_URL="$BASE_URL/mcp/$API_KEY"

echo "=== Initializing MCP session ==="
SESSION_ID=$(curl -s -X POST "$MCP_URL" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","clientInfo":{"name":"test","version":"1.0"},"capabilities":{}}}' \
  -D - 2>/dev/null | grep -i "mcp-session-id" | tr -d '\r' | awk '{print $2}')

echo "Session ID: $SESSION_ID"

# Send initialized notification
curl -s -X POST "$MCP_URL" \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' > /dev/null

# Create editing session
curl -s -X POST "$MCP_URL" \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: $SESSION_ID" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"create_session\",\"arguments\":{}}}" > /dev/null

echo "=== Creating test files with content ==="

# Create 20 test files, each with ~5 lines we can edit (= ~100 suggestions)
SUCCESS=0
FAIL=0

for i in $(seq 1 20); do
  FILE_PATH="Lens/test-persist-$i.md"

  # Create the file with known content
  RESULT=$(curl -s -X POST "$MCP_URL" \
    -H "Content-Type: application/json" \
    -H "mcp-session-id: $SESSION_ID" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":$((100+i)),\"method\":\"tools/call\",\"params\":{\"name\":\"create\",\"arguments\":{\"session_id\":\"$SESSION_ID\",\"file_path\":\"$FILE_PATH\",\"content\":\"# Test File $i\n\nLine alpha for file $i.\nLine bravo for file $i.\nLine charlie for file $i.\nLine delta for file $i.\nLine echo for file $i.\"}}}")

  if echo "$RESULT" | grep -q '"isError": true\|"error"'; then
    echo "  SKIP $FILE_PATH (already exists or error)"
    FAIL=$((FAIL+1))
  else
    echo "  Created $FILE_PATH"
    SUCCESS=$((SUCCESS+1))
  fi
done

echo "=== Created $SUCCESS files ($FAIL skipped) ==="
echo ""
echo "=== Making edits (each becomes a CriticMarkup suggestion) ==="

EDIT_COUNT=0

for i in $(seq 1 20); do
  FILE_PATH="Lens/test-persist-$i.md"

  # Make 5 edits per file = 100 total suggestions
  for word in alpha bravo charlie delta echo; do
    EDIT_COUNT=$((EDIT_COUNT+1))
    NEW_WORD="${word}-EDITED"

    RESULT=$(curl -s -X POST "$MCP_URL" \
      -H "Content-Type: application/json" \
      -H "mcp-session-id: $SESSION_ID" \
      -d "{\"jsonrpc\":\"2.0\",\"id\":$((200+EDIT_COUNT)),\"method\":\"tools/call\",\"params\":{\"name\":\"edit\",\"arguments\":{\"session_id\":\"$SESSION_ID\",\"file_path\":\"$FILE_PATH\",\"old_string\":\"$word\",\"new_string\":\"$NEW_WORD\"}}}")

    if echo "$RESULT" | grep -q '"isError": true\|"error"'; then
      echo "  FAIL edit #$EDIT_COUNT ($FILE_PATH: $word -> $NEW_WORD)"
      echo "  $RESULT" | python3 -m json.tool 2>/dev/null || echo "  $RESULT"
    else
      echo "  OK edit #$EDIT_COUNT ($FILE_PATH: $word -> $NEW_WORD)"
    fi
  done
done

echo ""
echo "=== Done: $EDIT_COUNT edits made ==="
echo "Open http://dev.vps:5173/?t=<token>#/review to see suggestions"
