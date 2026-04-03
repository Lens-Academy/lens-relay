# MCP Server Access Control

**Date:** 2026-04-03
**Status:** Design

## Problem

The MCP server has a single `MCP_API_KEY` that grants full access to all tools and all folders. There's no way to give an LLM read-only access or restrict it to a specific folder.

## Solution

Reuse HMAC-signed share tokens as MCP API keys. The server decodes the token to determine access level (full vs read-only) and folder scope (specific folder vs all folders).

## Access Levels

| Level | Tools Available | Description |
|-------|----------------|-------------|
| Full + all folders | read, glob, grep, get_links, edit, create, move | Unrestricted |
| Full + single folder | read, glob, grep, get_links, edit, create, move | File paths restricted to one folder |
| Read-only + all folders | read, glob, grep, get_links | No write tools registered |
| Read-only + single folder | read, glob, grep, get_links | No write tools, paths restricted to one folder |

`create_session` is always available (it's session management, not document access).

## Token Format

Same binary format as browser share tokens: `base64url(role:1 + folder_uuid:16 + expiry:4 + hmac:8)`.

Role mapping to MCP access:
- `edit` (byte 1) → full MCP access
- `suggest` (byte 2) → full MCP access
- `view` (byte 3) → read-only MCP access

Folder UUID `00000000-0000-0000-0000-000000000000` = all folders sentinel (no restriction).

Tokens are generated with the same `generate-share-link.ts` script. For long-lived MCP keys, use `--expires 365d`.

## Authentication Flow

Both auth methods (bearer header and path key) use the same decoding logic:

1. Receive token from bearer header (`Authorization: Bearer <token>`) or URL path (`/mcp/<token>`)
2. Attempt to decode as HMAC-signed share token using `SHARE_TOKEN_SECRET`
3. If valid: extract role → map to MCP access level, extract folder UUID → set folder scope
4. If decode fails: compare raw string against `MCP_API_KEY` env var. If match, treat as full + all folders (backward compatibility)
5. If neither: 401 Unauthorized

This means existing `MCP_API_KEY` plain strings continue to work unchanged.

## Tool Filtering

Read-only tokens see a reduced `tools/list` response. Write tools (`edit`, `create`, `move`) are not registered — the LLM never sees them and never wastes tokens trying to call them.

Implementation: `tool_definitions()` in `tools/mod.rs` accepts an access level parameter and filters the returned tool list.

## Folder Scoping

Enforced at tool dispatch time in `dispatch_tool()`:

- **read, edit**: Check `file_path` argument starts with the allowed folder name
- **glob, grep**: If `path` argument is provided, verify it matches. If omitted, auto-scope to the allowed folder
- **get_links**: Check `file_path` starts with allowed folder name
- **create**: Check `file_path` starts with allowed folder name
- **move**: Check both `file_path` and `new_path` start with allowed folder name. Block cross-folder moves.

When a tool call is rejected for folder scope, return a clear error: "Access denied: this key only has access to [folder name]"

## Server Description

The MCP server's `serverInfo` description is set dynamically based on the decoded token:

- Full + all: "Lens Relay MCP — full read/write access to all folders"
- Full + folder: "Lens Relay MCP — full read/write access to [Lens Edu]"
- Read-only + all: "Lens Relay MCP — read-only access to all folders. You can search, read, and browse documents but cannot edit, create, or move them."
- Read-only + folder: "Lens Relay MCP — read-only access to [Lens Edu]. You can search, read, and browse documents but cannot edit, create, or move them."

The folder display name is resolved from the folder UUID via the server's folder config.

## Implementation Scope

**Changes to Rust code (`crates/relay/src/mcp/`):**
- `transport.rs`: Decode share token in auth middleware, store access level + folder scope in request state
- `tools/mod.rs`: `tool_definitions()` accepts access level, filters tools. `dispatch_tool()` checks folder scope.
- `session.rs`: Store access level + folder scope on the MCP session (decoded once at `initialize`, reused for all tool calls)
- `router.rs`: Pass access level to `tool_definitions()` when handling `tools/list`

**Changes to shared code (`crates/y-sweet-core/`):**
- Add share token verification to y-sweet-core (currently only in the Node.js lens-editor server). The HMAC verification logic needs a Rust equivalent, or the token can be decoded without signature verification and the signature checked with the existing `SHARE_TOKEN_SECRET`.

**No changes to:**
- Token format
- `generate-share-link.ts` script
- Frontend/browser share token handling
- `MCP_API_KEY` env var (kept for backward compat)

## New Environment Variable

`SHARE_TOKEN_SECRET` must be available to the relay server for token verification. This is the same secret used by the lens-editor Node.js server. In production, both containers share it via the `.env` file.

For local dev without `SHARE_TOKEN_SECRET`, the same dev fallback secret is used (matching `lens-editor/server/share-token.ts`).
