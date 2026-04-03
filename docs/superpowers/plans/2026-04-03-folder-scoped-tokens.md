# Folder-Scoped Tokens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce folder scoping in share tokens so a token for Lens EDU cannot access Lens documents, with an all-folders sentinel UUID for admin tokens.

**Architecture:** Add a `GET /doc/:doc_id/folder` endpoint to the relay server (Rust) that returns the folder UUID for any document. The lens-editor auth middleware calls this endpoint during token validation and rejects requests where the document's folder doesn't match the token's folder. The `/api/relay/` proxy (which bypasses the auth middleware) is secured with share-token validation and folder-scope checking for all doc-specific operations. The frontend filters the FOLDERS list to only folders the token grants access to, preventing sidebar/metadata sync for inaccessible folders. Token format is unchanged.

**Security note:** The `/api/relay/` proxy in both `prod-server.ts` and `vite.config.ts` adds the relay server token server-side, giving browser requests server-level access to the relay. Without Task 3.5, an adversary with a folder-scoped token could bypass folder enforcement by calling `/api/relay/doc/move`, `/api/relay/search`, etc. directly.

**Tech Stack:** Rust (axum) for relay endpoint, TypeScript (Node.js) for auth middleware, React for frontend filtering.

**Spec:** `docs/superpowers/specs/2026-04-03-folder-scoped-tokens-design.md`

---

### Task 1: Add `folder_uuid_for_doc` method to DocumentResolver

Add a method that goes directly from a content document's UUID to the folder UUID it belongs to, without the intermediate path lookup.

**Files:**
- Modify: `crates/y-sweet-core/src/doc_resolver.rs`

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `doc_resolver.rs`:

```rust
#[test]
fn folder_uuid_for_doc_returns_correct_folder() {
    let folder0 = create_folder_doc(&[("/Photosynthesis.md", "uuid-photo")]);
    set_folder_name(&folder0, "Lens");
    let folder1 = create_folder_doc(&[("/Welcome.md", "uuid-welcome")]);
    set_folder_name(&folder1, "Lens Edu");

    let resolver = build_resolver(&[(&folder0_id(), &folder0), (&folder1_id(), &folder1)]);

    // uuid-photo is in folder0 (Lens), whose folder UUID is FOLDER0_UUID
    assert_eq!(
        resolver.folder_uuid_for_doc("uuid-photo"),
        Some(FOLDER0_UUID.to_string()),
    );
    // uuid-welcome is in folder1 (Lens Edu), whose folder UUID is FOLDER1_UUID
    assert_eq!(
        resolver.folder_uuid_for_doc("uuid-welcome"),
        Some(FOLDER1_UUID.to_string()),
    );
    // unknown uuid
    assert_eq!(resolver.folder_uuid_for_doc("nonexistent"), None);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml -p y-sweet-core -- doc_resolver::tests::folder_uuid_for_doc_returns_correct_folder`

Expected: FAIL — `folder_uuid_for_doc` method does not exist.

- [ ] **Step 3: Write minimal implementation**

Add this method to `impl DocumentResolver` in `crates/y-sweet-core/src/doc_resolver.rs`, after the `path_for_uuid` method:

```rust
/// Get the folder UUID for a content document UUID.
///
/// Returns the folder portion of the folder_doc_id (i.e., the part after
/// the relay_id dash). Returns None if the UUID is not in any folder.
pub fn folder_uuid_for_doc(&self, uuid: &str) -> Option<String> {
    let path = self.uuid_to_path.get(uuid)?;
    let info = self.path_to_doc.get(path.value())?;
    // folder_doc_id format: "relay_id-folder_uuid"
    parse_doc_id(&info.folder_doc_id).map(|(_, folder_uuid)| folder_uuid.to_string())
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml -p y-sweet-core -- doc_resolver::tests::folder_uuid_for_doc_returns_correct_folder`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
jj new -m "feat: add folder_uuid_for_doc to DocumentResolver"
```

Wait — we need to commit the current working copy first, then start new work. Use jj workflow:

```bash
jj describe -m "feat: add folder_uuid_for_doc to DocumentResolver"
jj new
```

---

### Task 2: Add `GET /doc/:doc_id/folder` relay server endpoint

Expose the folder UUID lookup as an HTTP endpoint that the lens-editor auth middleware can call.

**Files:**
- Modify: `crates/relay/src/server.rs`

- [ ] **Step 1: Write the endpoint handler**

Add this handler function near the other endpoint handlers (after `resolve_doc` around line 3347) in `crates/relay/src/server.rs`:

```rust
async fn get_doc_folder(
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
    State(server_state): State<Arc<Server>>,
    Path(doc_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    server_state.check_auth(auth_header)?;

    // Extract the UUID portion from compound doc_id (relay_id-uuid)
    let uuid = parse_doc_id(&doc_id)
        .map(|(_, uuid)| uuid)
        .ok_or_else(|| AppError(StatusCode::BAD_REQUEST, anyhow!("Invalid doc_id format")))?;

    match server_state.doc_resolver().folder_uuid_for_doc(uuid) {
        Some(folder_uuid) => Ok(Json(serde_json::json!({ "folderUuid": folder_uuid }))),
        None => Err(AppError(
            StatusCode::NOT_FOUND,
            anyhow!("Document not found in any folder"),
        )),
    }
}
```

- [ ] **Step 2: Add the import for `parse_doc_id` at the top of server.rs**

Check if `parse_doc_id` is already imported. If not, add it to the existing `use` statement for `link_indexer`. Look for the existing import near line 49:

```rust
use y_sweet_core::{
    doc_resolver::DocumentResolver,
    // ... other imports
};
```

Add `link_indexer::parse_doc_id` to the imports if not already present. The function is already used elsewhere in the file via `crate::...` paths — find how other call sites reference it and use the same pattern.

- [ ] **Step 3: Register the route**

In the `routes()` method (around line 2261), add the new route after the existing `/doc/:doc_id/auth` route:

```rust
.route("/doc/:doc_id/folder", get(get_doc_folder))
```

- [ ] **Step 4: Build to verify compilation**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo build --manifest-path=crates/Cargo.toml`

Expected: Compiles successfully.

- [ ] **Step 5: Manual smoke test**

Start the relay server and test the endpoint:

```bash
# Start relay (if not running)
CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo run --manifest-path=crates/Cargo.toml --bin relay -- serve --port 8090 &

# Wait for server ready, then test with a known doc UUID
# Use the local test folder doc ID format
curl -s http://localhost:8090/doc/a0000000-0000-4000-8000-000000000000-c0000001-0000-4000-8000-000000000001/folder | jq .
```

Expected: Either `{"folderUuid": "..."}` (200) or `{"error": "Document not found in any folder"}` (404) depending on whether test data is loaded.

- [ ] **Step 6: Commit**

```bash
jj describe -m "feat: add GET /doc/:doc_id/folder endpoint to relay server"
jj new
```

---

### Task 3: Add folder scope check to auth middleware

This is the security-critical change. The auth middleware validates that the requested document belongs to the token's authorized folder before proxying to the relay server.

**Files:**
- Modify: `lens-editor/server/auth-middleware.ts`
- Modify: `lens-editor/server/auth-middleware.test.ts`

- [ ] **Step 1: Write failing tests for folder scope enforcement**

Add these tests to `lens-editor/server/auth-middleware.test.ts`, inside the existing `describe('auth-middleware', ...)` block:

```typescript
const ALL_FOLDERS_SENTINEL = '00000000-0000-0000-0000-000000000000';
const FOLDER_A = 'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e';
const FOLDER_B = 'ea4015da-24af-4d9d-ac49-8c902cb17121';

describe('folder scope enforcement', () => {
  it('should allow access when doc is in token folder', async () => {
    const token = signShareToken({ role: 'edit', folder: FOLDER_A, expiry: Math.floor(Date.now() / 1000) + 3600 });

    // First call: folder lookup returns matching folder
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ folderUuid: FOLDER_A }),
    });
    // Second call: relay auth proxy
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: 'ws://localhost:8190/d/doc123/ws', docId: 'doc123', token: 'relay-token' }),
    });

    const result = await handler({ token, docId: 'doc123' });
    expect(result.role).toBe('edit');

    // Verify folder lookup was called
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8190/doc/doc123/folder',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-server-token' }),
      }),
    );
  });

  it('should reject access when doc is in different folder', async () => {
    const token = signShareToken({ role: 'suggest', folder: FOLDER_A, expiry: Math.floor(Date.now() / 1000) + 3600 });

    // Folder lookup returns a different folder
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ folderUuid: FOLDER_B }),
    });

    await expect(handler({ token, docId: 'doc-in-folder-b' }))
      .rejects.toThrow(AuthError);
    await expect(handler({ token, docId: 'doc-in-folder-b' }))
      .rejects.toThrow('Access denied');

    // Should NOT have called relay auth (rejected before proxy)
    // mockFetch called once (folder lookup), not twice (no relay auth)
  });

  it('should reject access when folder lookup returns 404', async () => {
    const token = signShareToken({ role: 'edit', folder: FOLDER_A, expiry: Math.floor(Date.now() / 1000) + 3600 });

    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    await expect(handler({ token, docId: 'unknown-doc' }))
      .rejects.toThrow(AuthError);
  });

  it('should bypass folder check for all-folders sentinel token', async () => {
    const token = signShareToken({ role: 'edit', folder: ALL_FOLDERS_SENTINEL, expiry: Math.floor(Date.now() / 1000) + 3600 });

    // Only one fetch call: relay auth proxy (no folder lookup)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: 'ws://localhost:8190/d/doc123/ws', docId: 'doc123', token: 'relay-token' }),
    });

    const result = await handler({ token, docId: 'doc123' });
    expect(result.role).toBe('edit');

    // Verify only ONE fetch was made (relay auth, not folder lookup)
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8190/doc/doc123/auth',
      expect.any(Object),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lens-editor && npx vitest run server/auth-middleware.test.ts`

Expected: FAIL — folder scope tests fail because the middleware doesn't check folders yet.

- [ ] **Step 3: Implement folder scope check in auth middleware**

Modify `createAuthHandler` in `lens-editor/server/auth-middleware.ts`:

```typescript
const ALL_FOLDERS_SENTINEL = '00000000-0000-0000-0000-000000000000';

export function createAuthHandler(config: AuthHandlerConfig) {
  return async (body: { token: string; docId: string }): Promise<AuthResponse> => {
    const { token, docId } = body;

    // 1. Verify share token
    const payload = verifyShareToken(token);
    if (!payload) {
      throw new AuthError(401, 'Invalid or expired share token');
    }

    // 2. Folder scope check (skip for all-folders sentinel)
    if (payload.folder !== ALL_FOLDERS_SENTINEL) {
      const folderHeaders: Record<string, string> = {};
      if (config.relayServerToken) {
        folderHeaders['Authorization'] = `Bearer ${config.relayServerToken}`;
      }

      const folderRes = await fetch(`${config.relayServerUrl}/doc/${docId}/folder`, {
        headers: folderHeaders,
      });

      if (!folderRes.ok) {
        throw new AuthError(403, 'Access denied: document not found');
      }

      const { folderUuid } = await folderRes.json() as { folderUuid: string };
      if (folderUuid !== payload.folder) {
        throw new AuthError(403, 'Access denied: document is not in your authorized folder');
      }
    }

    // 3. Determine relay authorization level
    const relayAuth = payload.role === 'view' ? 'read-only' : 'full';

    // 4. Mint relay doc token by proxying to relay server
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (config.relayServerToken) {
      headers['Authorization'] = `Bearer ${config.relayServerToken}`;
    }

    const relayResponse = await fetch(`${config.relayServerUrl}/doc/${docId}/auth`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ authorization: relayAuth }),
    });

    if (!relayResponse.ok) {
      throw new AuthError(502, `Relay server error: ${relayResponse.status}`);
    }

    const relayData = await relayResponse.json() as Record<string, unknown>;

    const clientToken: ClientToken = {
      url: relayData.url as string,
      baseUrl: (relayData.baseUrl as string) || config.relayServerUrl,
      docId: relayData.docId as string,
      token: relayData.token as string | undefined,
      authorization: relayAuth,
    };

    return { clientToken, role: payload.role };
  };
}
```

- [ ] **Step 4: Fix existing tests that don't account for folder lookup**

The existing tests use `FOLDER_A` (`fbd5eb54-73cc-41b0-ac28-2b93d3b4244e`) which is NOT the all-folders sentinel, so they now need a folder lookup mock before the relay auth mock. Update each existing test that uses `validPayload` (which has `folder: 'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e'`).

For each existing test that calls `handler({ token, docId })`, add a folder lookup mock before the relay auth mock:

```typescript
// Add before the existing mockFetch.mockResolvedValueOnce for relay auth:
mockFetch.mockResolvedValueOnce({
  ok: true,
  json: async () => ({ folderUuid: 'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e' }),
});
```

Update these existing tests:
- `'should return clientToken and role for valid edit token'` — add folder mock before relay mock
- `'should request read-only relay token for view role'` — add folder mock before relay mock
- `'should request full relay token for suggest role'` — add folder mock before relay mock
- `'should throw AuthError 502 when relay returns error'` — add folder mock (success) before relay mock (error)
- `'should include Authorization header when relayServerToken is set'` — add folder mock before relay mock
- `'should call the correct relay URL for the given docId'` — add folder mock before relay mock

- [ ] **Step 5: Run all auth middleware tests**

Run: `cd lens-editor && npx vitest run server/auth-middleware.test.ts`

Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
jj describe -m "feat: enforce folder scope in auth middleware with all-folders sentinel"
jj new
```

---

### Task 3.5: Secure `/api/relay/` proxy with share token validation

**CRITICAL SECURITY FIX.** The `/api/relay/` proxy in both `prod-server.ts` (production) and `vite.config.ts` (dev) forwards browser requests to the relay server with the server auth token injected. This bypasses the auth middleware entirely. An adversary with any share token can call relay endpoints directly:

- `POST /api/relay/doc/move` — move docs between folders
- `GET /api/relay/search` — search across all folders
- `GET /api/relay/doc/resolve/{prefix}` — resolve doc IDs from any folder
- `POST /api/relay/doc/new` — create docs (if token has write access)
- `GET /api/relay/suggestions` — read suggestions from any folder

**Approach:** Replace the open proxy with a validated proxy that checks the share token and enforces folder scope. Extract the share token from a custom header (`X-Share-Token`) that the browser sends with every `/api/relay/` request, then validate it and filter by folder.

**Files:**
- Create: `lens-editor/server/relay-proxy-auth.ts`
- Modify: `lens-editor/server/prod-server.ts`
- Modify: `lens-editor/vite.config.ts`
- Modify: `lens-editor/src/lib/relay-api.ts`

- [ ] **Step 1: Create relay proxy auth module**

Create `lens-editor/server/relay-proxy-auth.ts`:

```typescript
import { verifyShareToken } from './share-token.ts';
import type { ShareTokenPayload } from './share-token.ts';

const ALL_FOLDERS_SENTINEL = '00000000-0000-0000-0000-000000000000';

export interface ProxyAuthResult {
  payload: ShareTokenPayload;
  isAllFolders: boolean;
}

/**
 * Validate a share token from a proxy request.
 * Returns the decoded payload if valid, null if invalid.
 */
export function validateProxyToken(token: string | undefined | null): ProxyAuthResult | null {
  if (!token) return null;
  const payload = verifyShareToken(token);
  if (!payload) return null;
  return {
    payload,
    isAllFolders: payload.folder === ALL_FOLDERS_SENTINEL,
  };
}

/**
 * Check if a relay proxy request should be allowed based on the share token's folder scope.
 *
 * Rules:
 * - All-folders tokens: allow everything
 * - Folder-scoped tokens:
 *   - /doc/new: allow (doc creation is gated by which folder doc the frontend can write to)
 *   - /doc/move: block (could move docs between folders)
 *   - /doc/resolve/{prefix}: allow (returns doc IDs; the doc content is still gated by auth middleware)
 *   - /search: allow but the relay server should filter by folder (handled in a later step)
 *   - /suggestions: allow only if folder_id param matches token folder
 *   - All other endpoints: block by default
 */
export function checkProxyAccess(
  method: string,
  path: string,
  query: string,
  auth: ProxyAuthResult,
): { allowed: boolean; reason?: string } {
  if (auth.isAllFolders) return { allowed: true };

  const folder = auth.payload.folder;

  // POST /doc/new — allowed (folder assignment happens via filemeta, not this endpoint)
  if (method === 'POST' && path === '/doc/new') {
    return { allowed: true };
  }

  // POST /doc/move — blocked for folder-scoped tokens (could move cross-folder)
  if (method === 'POST' && path === '/doc/move') {
    return { allowed: false, reason: 'Document move not allowed with folder-scoped token' };
  }

  // GET /doc/resolve/{prefix} — allowed (just UUID resolution, content still gated)
  if (method === 'GET' && path.startsWith('/doc/resolve/')) {
    return { allowed: true };
  }

  // GET /search — allowed (results may include cross-folder docs but content is still gated)
  // TODO: In a future task, pass folder filter to relay search endpoint
  if (method === 'GET' && path === '/search') {
    return { allowed: true };
  }

  // GET /suggestions — allowed only if folder_id matches token folder
  if (method === 'GET' && path === '/suggestions') {
    const params = new URLSearchParams(query);
    const requestedFolders = params.getAll('folder_id');
    // Allow if all requested folder_ids contain the token's folder UUID
    const allMatch = requestedFolders.every(fid => fid.includes(folder));
    if (!allMatch) {
      return { allowed: false, reason: 'Suggestions access denied for this folder' };
    }
    return { allowed: true };
  }

  // Default: block unknown endpoints for folder-scoped tokens
  return { allowed: false, reason: 'Endpoint not allowed with folder-scoped token' };
}
```

- [ ] **Step 2: Write tests for relay proxy auth**

Create `lens-editor/server/relay-proxy-auth.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { validateProxyToken, checkProxyAccess, type ProxyAuthResult } from './relay-proxy-auth.ts';
import { signShareToken } from './share-token.ts';

const FOLDER_A = 'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e';
const FOLDER_B = 'ea4015da-24af-4d9d-ac49-8c902cb17121';
const ALL_FOLDERS = '00000000-0000-0000-0000-000000000000';
const RELAY_ID = 'cb696037-0f72-4e93-8717-4e433129d789';

function makeAuth(folder: string): ProxyAuthResult {
  return {
    payload: { role: 'edit', folder, expiry: Math.floor(Date.now() / 1000) + 3600 },
    isAllFolders: folder === ALL_FOLDERS,
  };
}

describe('validateProxyToken', () => {
  it('returns payload for valid token', () => {
    const token = signShareToken({ role: 'edit', folder: FOLDER_A, expiry: Math.floor(Date.now() / 1000) + 3600 });
    const result = validateProxyToken(token);
    expect(result).not.toBeNull();
    expect(result!.payload.folder).toBe(FOLDER_A);
    expect(result!.isAllFolders).toBe(false);
  });

  it('returns null for invalid token', () => {
    expect(validateProxyToken('garbage')).toBeNull();
    expect(validateProxyToken(null)).toBeNull();
    expect(validateProxyToken(undefined)).toBeNull();
  });

  it('detects all-folders sentinel', () => {
    const token = signShareToken({ role: 'edit', folder: ALL_FOLDERS, expiry: Math.floor(Date.now() / 1000) + 3600 });
    const result = validateProxyToken(token);
    expect(result!.isAllFolders).toBe(true);
  });
});

describe('checkProxyAccess', () => {
  const allFoldersAuth = makeAuth(ALL_FOLDERS);
  const scopedAuth = makeAuth(FOLDER_A);

  it('all-folders token allows everything', () => {
    expect(checkProxyAccess('POST', '/doc/move', '', allFoldersAuth).allowed).toBe(true);
    expect(checkProxyAccess('GET', '/search', '', allFoldersAuth).allowed).toBe(true);
    expect(checkProxyAccess('GET', '/suggestions', `folder_id=${RELAY_ID}-${FOLDER_B}`, allFoldersAuth).allowed).toBe(true);
  });

  it('folder-scoped token blocks /doc/move', () => {
    const result = checkProxyAccess('POST', '/doc/move', '', scopedAuth);
    expect(result.allowed).toBe(false);
  });

  it('folder-scoped token allows /doc/new', () => {
    expect(checkProxyAccess('POST', '/doc/new', '', scopedAuth).allowed).toBe(true);
  });

  it('folder-scoped token allows /doc/resolve', () => {
    expect(checkProxyAccess('GET', '/doc/resolve/abc123', '', scopedAuth).allowed).toBe(true);
  });

  it('folder-scoped token allows /search', () => {
    expect(checkProxyAccess('GET', '/search', 'q=test', scopedAuth).allowed).toBe(true);
  });

  it('folder-scoped token allows /suggestions for matching folder', () => {
    const result = checkProxyAccess('GET', '/suggestions', `folder_id=${RELAY_ID}-${FOLDER_A}`, scopedAuth);
    expect(result.allowed).toBe(true);
  });

  it('folder-scoped token blocks /suggestions for wrong folder', () => {
    const result = checkProxyAccess('GET', '/suggestions', `folder_id=${RELAY_ID}-${FOLDER_B}`, scopedAuth);
    expect(result.allowed).toBe(false);
  });

  it('folder-scoped token blocks unknown endpoints', () => {
    expect(checkProxyAccess('DELETE', '/doc/abc/something', '', scopedAuth).allowed).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `cd lens-editor && npx vitest run server/relay-proxy-auth.test.ts`

Expected: ALL PASS

- [ ] **Step 4: Add `X-Share-Token` header to browser relay API calls**

Modify `lens-editor/src/lib/relay-api.ts`. The browser needs to send its share token with every `/api/relay/` request so the proxy can validate it.

Add at the top of the file:

```typescript
/**
 * Get share token for relay proxy auth.
 * Uses the same token stored by auth-share.ts in localStorage.
 */
function getShareToken(): string | null {
  return localStorage.getItem('lens-share-token');
}

/** Build headers that include the share token for proxy auth. */
function relayHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const token = getShareToken();
  if (token) {
    headers['X-Share-Token'] = token;
  }
  return headers;
}
```

Update `createDocumentOnServer`:

```typescript
async function createDocumentOnServer(docId: string): Promise<void> {
  const response = await fetch('/api/relay/doc/new', {
    method: 'POST',
    headers: relayHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ docId }),
  });
  if (!response.ok) {
    throw new Error(`Failed to create document on server: ${response.status} ${response.statusText}`);
  }
}
```

Update `moveDocument`:

```typescript
export async function moveDocument(
  uuid: string,
  newPath: string,
  targetFolder?: string
): Promise<MoveDocumentResponse> {
  const body: Record<string, string> = { uuid, new_path: newPath };
  if (targetFolder) {
    body.target_folder = targetFolder;
  }
  const response = await fetch('/api/relay/doc/move', {
    method: 'POST',
    headers: relayHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Move failed: ${response.status}`);
  }
  return response.json();
}
```

Update `searchDocuments`:

```typescript
export async function searchDocuments(
  query: string,
  limit: number = 20,
  signal?: AbortSignal
): Promise<SearchResponse> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const response = await fetch(`/api/relay/search?${params}`, {
    headers: relayHeaders(),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Search failed: ${response.status}`);
  }
  return response.json();
}
```

Also update `useResolvedDocId.ts` (`lens-editor/src/hooks/useResolvedDocId.ts`) to send the header:

```typescript
fetch(`/api/relay/doc/resolve/${compoundId}`, {
  headers: (() => {
    const h: Record<string, string> = {};
    const token = localStorage.getItem('lens-share-token');
    if (token) h['X-Share-Token'] = token;
    return h;
  })(),
})
```

And update `useSuggestions.ts` — find where it calls `/api/relay/suggestions` and add the header similarly.

- [ ] **Step 5: Add proxy auth to production server**

Modify `lens-editor/server/prod-server.ts`. Replace the open `/api/relay/` proxy block with one that validates the share token:

```typescript
import { validateProxyToken, checkProxyAccess } from './relay-proxy-auth.ts';
```

Replace the existing `/api/relay/` handling (lines 62-66):

```typescript
if (url.startsWith('/api/relay/') || url === '/api/relay') {
  // Validate share token from X-Share-Token header
  const shareToken = req.headers['x-share-token'] as string | undefined;
  const auth = validateProxyToken(shareToken);
  if (!auth) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid or expired share token' }));
    return;
  }

  // Check folder-scoped access for this endpoint
  const relayPath = url.replace(/^\/api\/relay/, '') || '/';
  const queryIdx = relayPath.indexOf('?');
  const pathOnly = queryIdx >= 0 ? relayPath.slice(0, queryIdx) : relayPath;
  const query = queryIdx >= 0 ? relayPath.slice(queryIdx + 1) : '';
  const access = checkProxyAccess(req.method || 'GET', pathOnly, query, auth);
  if (!access.allowed) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: access.reason || 'Access denied' }));
    return;
  }

  req.url = relayPath;
  if (relayServerToken) {
    req.headers['authorization'] = `Bearer ${relayServerToken}`;
  }
  // Remove share token header before proxying to relay
  delete req.headers['x-share-token'];
  proxy.web(req, res, { target: relayUrl, changeOrigin: true });
}
```

- [ ] **Step 6: Add proxy auth to Vite dev server**

Modify `lens-editor/vite.config.ts`. The Vite proxy config doesn't support per-request auth checks as easily as the Node server. Add a Vite plugin that intercepts `/api/relay/` before the proxy:

Add a new plugin function inside `defineConfig`:

```typescript
function relayProxyAuthPlugin(): Plugin {
  return {
    name: 'relay-proxy-auth',
    configureServer(server) {
      // This middleware runs BEFORE Vite's built-in proxy
      server.middlewares.use('/api/relay', async (req, res, next) => {
        const { validateProxyToken, checkProxyAccess } = await import('./server/relay-proxy-auth.ts');

        const shareToken = req.headers['x-share-token'] as string | undefined;
        const auth = validateProxyToken(shareToken);
        if (!auth) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid or expired share token' }));
          return;
        }

        // req.url at this point is the path after /api/relay (because of the use() prefix)
        const fullUrl = req.url || '/';
        const queryIdx = fullUrl.indexOf('?');
        const pathOnly = queryIdx >= 0 ? fullUrl.slice(0, queryIdx) : fullUrl;
        const query = queryIdx >= 0 ? fullUrl.slice(queryIdx + 1) : '';
        const access = checkProxyAccess(req.method || 'GET', pathOnly, query, auth);
        if (!access.allowed) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: access.reason || 'Access denied' }));
          return;
        }

        // Remove share token header before proxying
        delete req.headers['x-share-token'];
        next(); // Let Vite's proxy handle the actual forwarding
      });
    },
  };
}
```

Add it to the plugins array (BEFORE `shareTokenAuthPlugin` so it registers first):

```typescript
plugins: [react(), tailwindcss(), relayProxyAuthPlugin(), shareTokenAuthPlugin()],
```

- [ ] **Step 7: Run all tests**

Run: `cd lens-editor && npx vitest run`

Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
jj describe -m "security: validate share token on /api/relay/ proxy to prevent folder bypass"
jj new
```

---

### Task 4: Add `decodeFolderFromToken` to frontend auth-share

Extract the folder UUID from a share token on the browser side (no signature verification needed — same pattern as `decodeRoleFromToken`).

**Files:**
- Modify: `lens-editor/src/lib/auth-share.ts`
- Modify: `lens-editor/src/lib/auth-share.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `lens-editor/src/lib/auth-share.test.ts`:

```typescript
import { getShareTokenFromUrl, stripShareTokenFromUrl, decodeRoleFromToken, decodeFolderFromToken, isAllFoldersToken } from './auth-share';

// ... existing makeFakeBinaryToken ...

/** Build a fake binary token with a specific folder UUID */
function makeFakeTokenWithFolder(roleByte: number, folderUuid: string): string {
  const bytes = new Uint8Array(29); // 1 + 16 + 4 + 8
  bytes[0] = roleByte;
  // Pack UUID into bytes 1-16
  const hex = folderUuid.replace(/-/g, '');
  for (let i = 0; i < 16; i++) {
    bytes[1 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  // Fill expiry + sig with arbitrary data
  for (let i = 17; i < 29; i++) bytes[i] = i;
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
```

Add a new `describe` block:

```typescript
describe('decodeFolderFromToken', () => {
  it('should decode folder UUID from token', () => {
    const folder = 'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e';
    const token = makeFakeTokenWithFolder(1, folder);
    expect(decodeFolderFromToken(token)).toBe(folder);
  });

  it('should decode all-folders sentinel', () => {
    const sentinel = '00000000-0000-0000-0000-000000000000';
    const token = makeFakeTokenWithFolder(1, sentinel);
    expect(decodeFolderFromToken(token)).toBe(sentinel);
  });

  it('should return null for empty string', () => {
    expect(decodeFolderFromToken('')).toBeNull();
  });

  it('should return null for too-short token', () => {
    // Only 10 bytes — not enough for role + full UUID
    const bytes = new Uint8Array(10);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    const token = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    expect(decodeFolderFromToken(token)).toBeNull();
  });
});

describe('isAllFoldersToken', () => {
  it('should return true for all-zeros UUID', () => {
    expect(isAllFoldersToken('00000000-0000-0000-0000-000000000000')).toBe(true);
  });

  it('should return false for a real folder UUID', () => {
    expect(isAllFoldersToken('fbd5eb54-73cc-41b0-ac28-2b93d3b4244e')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lens-editor && npx vitest run src/lib/auth-share.test.ts`

Expected: FAIL — `decodeFolderFromToken` and `isAllFoldersToken` don't exist.

- [ ] **Step 3: Implement `decodeFolderFromToken` and `isAllFoldersToken`**

Add to `lens-editor/src/lib/auth-share.ts`:

```typescript
const ALL_FOLDERS_SENTINEL = '00000000-0000-0000-0000-000000000000';

/**
 * Decode the folder UUID from a compact binary share token (no signature verification).
 * Token format: base64url(role:1 + uuid:16 + expiry:4 + hmac:8)
 * UUID is bytes 1-16.
 */
export function decodeFolderFromToken(token: string): string | null {
  try {
    const bytes = base64urlToBytes(token);
    if (bytes.length < 17) return null;
    const hex = Array.from(bytes.slice(1, 17))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch {
    return null;
  }
}

/**
 * Check if a folder UUID is the all-folders sentinel (grants access to all folders).
 */
export function isAllFoldersToken(folderUuid: string): boolean {
  return folderUuid === ALL_FOLDERS_SENTINEL;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lens-editor && npx vitest run src/lib/auth-share.test.ts`

Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
jj describe -m "feat: add decodeFolderFromToken and isAllFoldersToken to browser auth"
jj new
```

---

### Task 5: Filter accessible folders in App.tsx

Use the token's folder UUID to determine which folders to sync and display.

**Files:**
- Modify: `lens-editor/src/App.tsx`
- Modify: `lens-editor/src/contexts/AuthContext.tsx`

- [ ] **Step 1: Add folder scope to AuthContext**

Modify `lens-editor/src/contexts/AuthContext.tsx`:

```typescript
import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

export type UserRole = 'edit' | 'suggest' | 'view';

interface AuthContextValue {
  role: UserRole;
  canEdit: boolean;
  canSuggest: boolean;
  canWrite: boolean;
  folderUuid: string | null;
  isAllFolders: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface AuthProviderProps {
  role: UserRole;
  folderUuid: string | null;
  isAllFolders: boolean;
  children: ReactNode;
}

export function AuthProvider({ role, folderUuid, isAllFolders, children }: AuthProviderProps) {
  const value: AuthContextValue = {
    role,
    canEdit: role === 'edit',
    canSuggest: role === 'suggest',
    canWrite: role === 'edit' || role === 'suggest',
    folderUuid,
    isAllFolders,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    return { role: 'edit', canEdit: true, canSuggest: false, canWrite: true, folderUuid: null, isAllFolders: true };
  }
  return context;
}
```

- [ ] **Step 2: Filter folders and update AuthProvider usage in App.tsx**

At the top of `lens-editor/src/App.tsx`, after the existing `shareRole` / `shareExpired` declarations (around line 66-67), add:

```typescript
import { decodeFolderFromToken, isAllFoldersToken } from './lib/auth-share';
```

(Add `decodeFolderFromToken` and `isAllFoldersToken` to the existing import from `'./lib/auth-share'`.)

Then after the existing `shareExpired` line:

```typescript
const shareFolderUuid: string | null = shareToken ? decodeFolderFromToken(shareToken) : null;
const shareIsAllFolders: boolean = shareFolderUuid ? isAllFoldersToken(shareFolderUuid) : false;
```

In the `AuthenticatedApp` component, change the function signature to accept the new props:

```typescript
function AuthenticatedApp({ role, folderUuid, isAllFolders }: { role: UserRole; folderUuid: string | null; isAllFolders: boolean }) {
```

Filter the FOLDERS constant:

```typescript
// Filter folders based on token scope
const accessibleFolders = isAllFolders
  ? FOLDERS
  : FOLDERS.filter(f => f.id === folderUuid);

// Use accessibleFolders instead of FOLDERS for metadata sync
const { metadata, folderDocs, errors } = useMultiFolderMetadata(accessibleFolders);
const folderNames = accessibleFolders.map(f => f.name);
```

Update the `<AuthProvider>` to pass the new props:

```tsx
<AuthProvider role={role} folderUuid={folderUuid} isAllFolders={isAllFolders}>
```

Update the ReviewPage route to use `accessibleFolders`:

```tsx
<Route path="/review" element={
  <ReviewPageWithActions
    folderIds={accessibleFolders.map(f => `${RELAY_ID}-${f.id}`)}
    folders={accessibleFolders.map(f => ({ id: `${RELAY_ID}-${f.id}`, name: f.name }))}
    relayId={RELAY_ID}
  />
} />
```

In the `App` component, update the `AuthenticatedApp` call:

```tsx
return <AuthenticatedApp role={shareRole} folderUuid={shareFolderUuid} isAllFolders={shareIsAllFolders} />;
```

- [ ] **Step 3: Build to verify compilation**

Run: `cd lens-editor && npx tsc --noEmit`

Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
jj describe -m "feat: filter accessible folders based on share token scope"
jj new
```

---

### Task 6: Add `--all-folders` flag to generate-share-link script

Add a convenience flag so admins don't need to remember the sentinel UUID.

**Files:**
- Modify: `lens-editor/scripts/generate-share-link.ts`

- [ ] **Step 1: Add the flag**

In `lens-editor/scripts/generate-share-link.ts`, update the argument parsing:

Add `--all-folders` to the usage text in `printUsage()`:

```typescript
function printUsage() {
  console.log(`Usage: npx tsx scripts/generate-share-link.ts [options]

Options:
  --role <edit|suggest|view>  Access level (required)
  --folder <id>               Folder ID (required unless --all-folders)
  --all-folders               Grant access to all folders
  --expires <duration>         Token lifetime: e.g. "24h", "7d", "2w" (default: "7d")
  --base-url <url>            Base URL for the editor (default: http://localhost:5173)

Examples:
  npx tsx scripts/generate-share-link.ts --role edit --all-folders
  npx tsx scripts/generate-share-link.ts --role suggest --folder ea4015da-24af-4d9d-ac49-8c902cb17121
  npx tsx scripts/generate-share-link.ts --role view --folder fbd5eb54-73cc-41b0-ac28-2b93d3b4244e --base-url https://editor.example.com`);
}
```

Update the folder argument parsing:

```typescript
const ALL_FOLDERS_SENTINEL = '00000000-0000-0000-0000-000000000000';
const allFolders = args.includes('--all-folders');
const folder = allFolders ? ALL_FOLDERS_SENTINEL : getArg('--folder');
```

Update the validation:

```typescript
if (!folder) {
  console.error('Error: --folder or --all-folders is required');
  printUsage();
  process.exit(1);
}
```

Update the output to show "All folders" when using sentinel:

```typescript
console.log(`Folder:  ${folder === ALL_FOLDERS_SENTINEL ? 'All folders' : folder}`);
```

- [ ] **Step 2: Test manually**

Run: `cd lens-editor && npx tsx scripts/generate-share-link.ts --role edit --all-folders --expires 1h`

Expected: Output shows `Folder: All folders` and generates a valid URL.

Run: `cd lens-editor && npx tsx scripts/generate-share-link.ts --role suggest --folder ea4015da-24af-4d9d-ac49-8c902cb17121 --expires 1h`

Expected: Output shows the Lens EDU folder UUID and generates a valid URL.

Run: `cd lens-editor && npx tsx scripts/generate-share-link.ts --role edit`

Expected: Error message: `--folder or --all-folders is required`

- [ ] **Step 3: Commit**

```bash
jj describe -m "feat: add --all-folders flag to generate-share-link script"
jj new
```

---

### Task 7: End-to-end integration test

Verify the complete flow works with a running local relay server.

**Files:**
- No new files — manual verification

- [ ] **Step 1: Start local relay server and populate test data**

```bash
cd lens-editor && npm run relay:start
```

Wait for the server to be ready and test data to be populated.

- [ ] **Step 2: Generate a folder-scoped token for Relay Folder 1**

```bash
cd lens-editor && npx tsx scripts/generate-share-link.ts --role suggest --folder b0000001-0000-4000-8000-000000000001 --base-url http://dev.vps:5173
```

Copy the generated URL.

- [ ] **Step 3: Generate an all-folders token**

```bash
cd lens-editor && npx tsx scripts/generate-share-link.ts --role edit --all-folders --base-url http://dev.vps:5173
```

Copy the generated URL.

- [ ] **Step 4: Start the dev server**

```bash
cd lens-editor && npm run dev:local
```

- [ ] **Step 5: Test folder-scoped token**

Open the folder-scoped URL in a browser. Verify:
- Only "Relay Folder 1" files appear in the sidebar
- "Relay Folder 2" files do not appear
- Attempting to navigate directly to a Relay Folder 2 document (by editing the URL) shows an error

- [ ] **Step 6: Test all-folders token**

Open the all-folders URL in a browser. Verify:
- Both "Relay Folder 1" and "Relay Folder 2" files appear in the sidebar
- Documents from both folders are accessible

- [ ] **Step 7: Test server-side enforcement (auth middleware)**

With the folder-scoped token active in the browser, open dev tools Network tab and attempt to call `/api/auth/token` with a doc ID from Relay Folder 2:

```javascript
// In browser console:
fetch('/api/auth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: localStorage.getItem('lens-share-token'), docId: '<folder-2-doc-id>' })
}).then(r => r.json()).then(console.log).catch(console.error);
```

Expected: 403 response with "Access denied" message.

- [ ] **Step 8: Test proxy bypass prevention**

With the folder-scoped token, verify the `/api/relay/` proxy also enforces folder scope:

```javascript
// Should be blocked — move is not allowed for folder-scoped tokens:
fetch('/api/relay/doc/move', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Share-Token': localStorage.getItem('lens-share-token') },
  body: JSON.stringify({ uuid: 'any-uuid', new_path: '/stolen.md', target_folder: 'Lens' })
}).then(r => console.log(r.status, r.statusText)).catch(console.error);
// Expected: 403

// Should be blocked — suggestions for wrong folder:
fetch('/api/relay/suggestions?folder_id=<relay-id>-<folder-2-uuid>', {
  headers: { 'X-Share-Token': localStorage.getItem('lens-share-token') }
}).then(r => console.log(r.status, r.statusText)).catch(console.error);
// Expected: 403

// Should be blocked — missing token:
fetch('/api/relay/search?q=test')
  .then(r => console.log(r.status, r.statusText)).catch(console.error);
// Expected: 401
```

- [ ] **Step 9: Commit (if any fixes were needed)**

```bash
jj describe -m "test: verify folder-scoped token end-to-end"
jj new
```
