# MCP: uploading large content without model tokens

The MCP endpoint is plain HTTP JSON-RPC. An agent importing an existing local
file (transcript, article, export) should not regenerate its bytes as tool-call
tokens — build the request with `jq` and POST it with `curl`:

```bash
MCP_URL=https://relay.lensacademy.org/mcp/<token>   # from the MCP client config

# 1. Get a session id
curl -sS -X POST "$MCP_URL" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_session","arguments":{"name":"<first name>"}}}'
# first line of result text = session_id

# 2. Create a doc from a local file (content never passes through the model)
jq -Rs --arg sid <session_id> \
  '{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"create",arguments:{session_id:$sid,file_path:"Lens Edu/Doc.md",content:.}}}' \
  local-file.md | curl -sS -X POST "$MCP_URL" -H 'Content-Type: application/json' -d @-
```

Works for any tool, not just `create`. Markdown still lands as pending
suggestions (CriticMarkup) like a normal MCP create.
