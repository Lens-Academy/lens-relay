# Folder-Scoped Share Tokens

**Date:** 2026-04-03
**Status:** Design

## Problem

Share tokens encode a folder UUID but it is never enforced. Any token grants access to all documents regardless of folder. A user with a Lens EDU suggest token can access Lens folder documents by requesting their doc IDs directly.

## Goal

Server-side enforcement of folder scoping in share tokens, so a token scoped to Lens EDU cannot be used to access Lens documents. Suggestion-only enforcement remains frontend-only (acceptable per threat model).

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Folder enforcement | Server-side (adversarial-secure) | Token holder must not access other folders |
| Suggest vs edit enforcement | Frontend-only (current behavior) | Acceptable threat model |
| All-folders token | Sentinel UUID `00000000-0000-0000-0000-000000000000` | Simplest approach; HMAC prevents forgery |
| Cross-folder links | Show link exists, block navigation | "Access denied" on click; no content leakage |
| Sidebar for scoped users | Only show accessible folders | No information leakage about other folder structure |
| Multi-folder tokens | One token per folder, or all-folders sentinel | No arbitrary folder combinations needed |
| MCP tools | Unscoped (trusted internal) | No change |
| Backward compatibility | Enforce immediately | Existing tokens already have correct folder UUIDs |

## Token Format

No change to the binary format. The 16-byte folder UUID field (bytes 1-16) gains enforcement:

```
base64url(role:1 + folder_uuid:16 + expiry:4 + hmac:8)
                   ^^^^^^^^^^^
                   Now enforced server-side
```

- Regular folder UUID (e.g., `ea4015da-24af-4d9d-ac49-8c902cb17121`) = access to that folder only
- Sentinel UUID `00000000-0000-0000-0000-000000000000` = access to all folders

The HMAC covers the entire payload, so the folder UUID cannot be tampered with.

## Architecture

### Where enforcement happens

Folder scoping is enforced in **two places** on the lens-editor server:

1. **Auth middleware** (`server/auth-middleware.ts`) — validates folder scope when minting relay doc tokens via `POST /api/auth/token`
2. **Relay proxy auth** (`server/relay-proxy-auth.ts`) — validates folder scope on the `/api/relay/` proxy, which the browser uses for doc creation, move, search, UUID resolution, and suggestions

```
Browser                    lens-editor server              relay-server
  │                              │                              │
  │ POST /api/auth/token         │                              │
  │ { token, docId }             │  Auth middleware:             │
  │ ─────────────────────────>   │  1. verify share token       │
  │                              │  2. check folder scope       │
  │                              │  3. proxy to relay ─────────>│
  │                              │                              │
  │ /api/relay/* + X-Share-Token │  Proxy auth:                 │
  │ ─────────────────────────>   │  1. verify share token       │
  │                              │  2. check endpoint access    │
  │                              │  3. proxy to relay ─────────>│
```

The relay server itself does not need changes. It already trusts the lens-editor server (which authenticates via `RELAY_SERVER_TOKEN`). The lens-editor server is the access control gate.

**Why two enforcement points:** The `/api/relay/` proxy injects the relay server's auth token into requests, giving browser code server-level access to the relay. Without validation, an adversary with a folder-scoped token could call `/api/relay/doc/move` to move documents between folders, `/api/relay/search` to search across all folders, etc.

### Folder membership lookup

The auth middleware needs to answer: "does doc ID X belong to folder UUID Y?"

**Approach:** The lens-editor server loads folder metadata (the same `filemeta_v0` Y.Maps it already syncs for the sidebar) and maintains an in-memory map of `docUuid -> folderUuid`. This map is already effectively maintained by the frontend's `useMultiFolderMetadata` hook; the server side needs an equivalent.

**Implementation options (in order of preference):**

1. **Relay server API endpoint** (preferred): Add a lightweight `GET /doc/{docId}/folder` endpoint to the relay server that returns the folder UUID for a document. The auth middleware calls this during token validation. Leverages the existing `DocumentResolver` which already has this mapping.

2. **Server-side folder doc sync**: The lens-editor prod server connects to folder Y.Docs via WebSocket (like the frontend does) and maintains its own folder-membership index. More complex, but avoids per-request latency.

3. **Encode doc-to-folder in the relay auth response**: When the auth middleware calls `POST /doc/{docId}/auth`, have the relay return the folder UUID alongside the client token. Simple but couples the check to the auth proxy step.

**Recommendation: Option 1.** The relay's `DocumentResolver` already maps doc IDs to `DocInfo` which contains `folder_doc_id`. Exposing this as a simple GET endpoint is minimal work and keeps the auth middleware stateless.

### New relay server endpoint

```
GET /doc/{docId}/folder

Response 200:
{
  "folderUuid": "ea4015da-24af-4d9d-ac49-8c902cb17121"
}

Response 404: document not found in any folder
```

This endpoint requires server-level auth (same as `/doc/{docId}/auth`). The lens-editor server already has the `RELAY_SERVER_TOKEN` for this.

### Auth middleware changes

`server/auth-middleware.ts` — `createAuthHandler()`:

```typescript
// After verifyShareToken succeeds:
const payload = verifyShareToken(token);

// NEW: Folder scope check
const ALL_FOLDERS_SENTINEL = '00000000-0000-0000-0000-000000000000';
if (payload.folder !== ALL_FOLDERS_SENTINEL) {
  // Look up which folder this doc belongs to
  const folderRes = await fetch(`${relayServerUrl}/doc/${docId}/folder`, {
    headers: config.relayServerToken
      ? { Authorization: `Bearer ${config.relayServerToken}` }
      : {},
  });

  if (!folderRes.ok) {
    throw new AuthError(403, 'Document not found or access denied');
  }

  const { folderUuid } = await folderRes.json();

  // Extract folder UUID from the token's folder field
  // The token stores the folder doc ID format: relay_id-folder_uuid
  // But we encode just the folder UUID in the token
  if (folderUuid !== payload.folder) {
    throw new AuthError(403, 'Access denied: document is not in your authorized folder');
  }
}

// Continue with existing relay proxy logic...
```

### Frontend changes

#### 1. Decode folder UUID from token (browser-side)

Add to `src/lib/auth-share.ts`:

```typescript
export function decodeFolderFromToken(token: string): string | null {
  try {
    const bytes = base64urlToBytes(token);
    if (bytes.length < 17) return null;
    const hex = Array.from(bytes.slice(1, 17))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  } catch {
    return null;
  }
}

const ALL_FOLDERS_SENTINEL = '00000000-0000-0000-0000-000000000000';

export function isAllFoldersToken(folderUuid: string): boolean {
  return folderUuid === ALL_FOLDERS_SENTINEL;
}
```

#### 2. Filter FOLDERS list in App.tsx

Before passing `FOLDERS` to `useMultiFolderMetadata`, filter to only the folders the token grants access to:

```typescript
const tokenFolderUuid = shareToken ? decodeFolderFromToken(shareToken) : null;
const isAllFolders = tokenFolderUuid && isAllFoldersToken(tokenFolderUuid);

const accessibleFolders = isAllFolders
  ? FOLDERS
  : FOLDERS.filter(f => f.id === tokenFolderUuid);
```

Pass `accessibleFolders` to `useMultiFolderMetadata` instead of `FOLDERS`. This means:
- Sidebar only shows files from accessible folders (no folder doc sync for inaccessible folders)
- Quick switcher only searches accessible documents
- No WebSocket connections opened for inaccessible folders

#### 3. Cross-folder link behavior

When a wikilink points to a document outside the accessible folders, the link target won't exist in the metadata (since we never synced that folder). The existing "document not found" behavior handles this naturally.

To improve UX, detect cross-folder links and show "access denied" instead of "not found":

- In the editor's link click handler, if a resolved link target is not in metadata, check if the link text contains a folder prefix that doesn't match the token's folder
- Show a toast: "This document is in the Lens folder. Your access link only covers Lens Edu."

#### 4. AuthContext expansion

Add folder scope to `AuthContext` so components can check access:

```typescript
interface AuthContextValue {
  role: UserRole;
  canEdit: boolean;
  canSuggest: boolean;
  canWrite: boolean;
  folderUuid: string | null;     // NEW
  isAllFolders: boolean;          // NEW
}
```

### Token generation

`scripts/generate-share-link.ts` already accepts `--folder`. No changes needed for folder-scoped tokens.

For all-folders tokens, pass the sentinel:

```bash
npx tsx scripts/generate-share-link.ts \
  --role edit \
  --folder 00000000-0000-0000-0000-000000000000 \
  --base-url http://dev.vps:5173
```

Consider adding a `--all-folders` flag as sugar:

```bash
npx tsx scripts/generate-share-link.ts \
  --role edit \
  --all-folders \
  --base-url http://dev.vps:5173
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Token folder UUID doesn't match any configured folder | Frontend shows empty sidebar (no folder docs synced). Server returns 403 on doc access. |
| Document not found in any folder (relay returns 404) | Auth middleware returns 403 "Document not found or access denied" |
| All-folders sentinel | Bypass folder check entirely |
| Folder doc sync fails for accessible folder | Existing partial-failure handling in `useMultiFolderMetadata` (shows error, other folders still work) |

## Testing

### Server-side (auth-middleware)

1. Token with folder A + doc in folder A = 200 (access granted)
2. Token with folder A + doc in folder B = 403 (access denied)
3. Token with all-folders sentinel + doc in any folder = 200
4. Token with folder A + nonexistent doc = 403
5. Expired token = 401 (existing behavior, unchanged)
6. Tampered folder UUID = 401 (HMAC verification fails, existing behavior)

### Relay server endpoint

1. Known doc ID returns correct folder UUID
2. Unknown doc ID returns 404
3. Folder doc ID (not a content doc) returns 404 or appropriate response
4. Requires server auth token

### Frontend

1. Folder-scoped token only syncs accessible folder docs
2. Sidebar shows only accessible folders
3. Quick switcher only shows accessible documents
4. Cross-folder link click shows access denied message
5. All-folders token shows all folders (existing behavior)

## Migration

No migration needed. All existing tokens already contain a folder UUID. Once server-side enforcement is enabled:

- Existing Lens folder tokens will be restricted to Lens
- Existing Lens EDU tokens will be restricted to Lens EDU
- To create an all-folders token, generate one with the sentinel UUID

Verify existing deployed tokens have the correct folder UUIDs before deploying. Check via `decodeShareTokenPayload()` on any active tokens.

## Scope Exclusions

- No token revocation mechanism (out of scope)
- No per-document tokens (current folder-level granularity is sufficient)
- No server-side suggest/edit enforcement (frontend-only per decision)
- No MCP tool scoping (trusted internal)
- No arbitrary folder combinations (one folder or all folders)
