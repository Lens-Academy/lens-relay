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

No `jq`? python3 works too:

```bash
python3 -c 'import json,sys;print(json.dumps({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create","arguments":{"session_id":sys.argv[1],"file_path":sys.argv[2],"content":sys.stdin.read()}}}))' \
  <session_id> "Lens Edu/Doc.md" < local-file.md | curl -sS -X POST "$MCP_URL" -H 'Content-Type: application/json' -d @-
```

Works for any tool, not just `create`. Markdown still lands as pending
suggestions (CriticMarkup) like a normal MCP create. Verified against
production with a 1MB body.

## Images: `import_attachment` with `content_base64`

An image the agent has on disk (a rasterised chart, a screenshot, a figure
extracted from a PDF) goes through `import_attachment`. Base64-encode it in
the shell so the bytes never become model tokens:

```bash
# png/jpeg/gif/webp only (sniffed from the bytes; SVG is rejected — rasterise
# first). 5 MiB soft limit (warning), 20 MiB hard limit. The /mcp body limit
# is 30 MiB, enough for a 20 MiB image after base64 inflation.
jq -n --arg sid <session_id> --arg stem "turner-power-fig1"   --rawfile b64 <(base64 < figure.png | tr -d '\n')   '{jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"import_attachment",arguments:{session_id:$sid,stem:$stem,content_base64:$b64}}}'   | curl -sS -X POST "$MCP_URL" -H 'Content-Type: application/json' -d @-
```

python3 variant:

```bash
python3 -c 'import base64,json,sys;print(json.dumps({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"import_attachment","arguments":{"session_id":sys.argv[1],"stem":sys.argv[2],"content_base64":base64.b64encode(sys.stdin.buffer.read()).decode()}}}))'   <session_id> turner-power-fig1 < figure.png | curl -sS -X POST "$MCP_URL" -H 'Content-Type: application/json' -d @-
```

The result text is JSON: `path` (`Lens Edu/attachments/<stem>-<sha256 first
8>.png`), `public_url` (raw GitHub URL, live once git-sync has pushed,
typically 10-30 s), `sha256`, `bytes`, `mimetype`, `created`, `overwritten`,
`deduplicated_from` (set when the folder already had identical bytes — nothing
is uploaded twice) and `note`. Embed with `![alt](public_url)`; the platform
renders only absolute image URLs. Pass `file_path` instead of `stem` for an
exact name, and `overwrite: true` to replace the bytes at an existing path
(same file id; the CDN may serve the old bytes for up to 5 minutes).

For an image that is already on the web, skip the base64 step and pass `url`
— the editor fetches it server-side.
