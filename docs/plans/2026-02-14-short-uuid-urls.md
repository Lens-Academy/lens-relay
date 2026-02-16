# Short UUID URLs Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Shorten document UUIDs in URLs from 36 characters to 8 characters, with server-side resolution for cold page loads.

**Architecture:** URLs use the first 8 characters of the doc UUID (`/{8-char}/path`). For in-app navigation, the full UUID is already known from loaded metadata — resolution is instant and client-side. For cold page loads (shared links, bookmarks, refresh), the frontend calls a new `/api/relay/doc/resolve/{prefix}` endpoint on the relay server, which prefix-matches against its in-memory document store. The resolved full UUID is passed to `RelayProvider`, which proceeds with the existing auth+WebSocket flow unchanged. The y-sweet client library's `validateClientToken` check is never violated because `RelayProvider` always receives the full 73-char compound ID.

**Tech Stack:** Rust (relay server, axum), TypeScript (React frontend, Vite dev middleware, Hono prod server)

---

### Task 1: Add `resolve_doc_id` method and HTTP endpoint to relay server

**Files:**
- Modify: `crates/relay/src/server.rs:648` (add method after `doc_exists`)
- Modify: `crates/relay/src/server.rs:1242` (add route)
- Modify: `crates/relay/src/server.rs:2997` (add tests)

**Step 1: Write the failing test**

Add to the `#[cfg(test)] mod test` block at `crates/relay/src/server.rs:2997`:

```rust
#[tokio::test]
async fn test_resolve_doc_id_exact_match() {
    let server_state = Server::new(
        None,
        Duration::from_secs(60),
        None,
        None,
        vec![],
        CancellationToken::new(),
        true,
        None,
    )
    .await
    .unwrap();

    let doc_id = server_state.create_doc().await.unwrap();
    let server = Arc::new(server_state);

    // Exact match should resolve
    let resolved = server.resolve_doc_id(&doc_id).await;
    assert_eq!(resolved, Some(doc_id.clone()));
}

#[tokio::test]
async fn test_resolve_doc_id_prefix_match() {
    let server_state = Server::new(
        None,
        Duration::from_secs(60),
        None,
        None,
        vec![],
        CancellationToken::new(),
        true,
        None,
    )
    .await
    .unwrap();

    let doc_id = server_state.create_doc().await.unwrap();
    let prefix = &doc_id[..8];
    let server = Arc::new(server_state);

    // 8-char prefix should resolve to full ID
    let resolved = server.resolve_doc_id(prefix).await;
    assert_eq!(resolved, Some(doc_id));
}

#[tokio::test]
async fn test_resolve_doc_id_compound_prefix_match() {
    // Test with production-format compound IDs (RELAY_ID-DOC_UUID)
    let server_state = Server::new(
        None,
        Duration::from_secs(60),
        None,
        None,
        vec![],
        CancellationToken::new(),
        true,
        None,
    )
    .await
    .unwrap();

    let full_compound = "a0000000-0000-4000-8000-000000000000-c0000001-0000-4000-8000-000000000001";
    server_state.load_doc(full_compound, None).await.unwrap();

    // Short compound prefix: RELAY_ID + first 8 chars of doc UUID
    let short_compound = "a0000000-0000-4000-8000-000000000000-c0000001";

    let server = Arc::new(server_state);
    let resolved = server.resolve_doc_id(short_compound).await;
    assert_eq!(resolved, Some(full_compound.to_string()));
}

#[tokio::test]
async fn test_resolve_doc_id_no_match() {
    let server_state = Server::new(
        None,
        Duration::from_secs(60),
        None,
        None,
        vec![],
        CancellationToken::new(),
        true,
        None,
    )
    .await
    .unwrap();

    let server = Arc::new(server_state);

    let resolved = server.resolve_doc_id("nonexistent").await;
    assert_eq!(resolved, None);
}
```

**Step 2: Run tests to verify they fail**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path crates/Cargo.toml -p relay -- test::test_resolve_doc_id`
Expected: FAIL — `resolve_doc_id` method doesn't exist yet

**Step 3: Implement the `resolve_doc_id` method**

Add to `impl Server` in `crates/relay/src/server.rs`, right after `doc_exists` (around line 664):

```rust
/// Resolve a (possibly prefix-shortened) doc ID to a full doc ID.
/// Tries exact match first, then prefix match against in-memory docs.
/// Returns None if no match or multiple matches (ambiguous prefix).
///
/// Note: Prefix matching only works for docs loaded in memory. Docs that have
/// been garbage-collected but still exist in the store require an exact match.
/// In practice, the frontend's client-side resolution (from metadata) handles
/// the common case; this endpoint is only for cold page loads where the doc
/// is typically still warm in memory.
pub async fn resolve_doc_id(&self, input: &str) -> Option<String> {
    // Exact match — fast path (checks both in-memory and store)
    if self.docs.contains_key(input) {
        return Some(input.to_string());
    }

    // Prefix match against in-memory docs
    let matches: Vec<String> = self
        .docs
        .iter()
        .filter(|entry| entry.key().starts_with(input))
        .map(|entry| entry.key().clone())
        .collect();

    if matches.len() == 1 {
        Some(matches.into_iter().next().unwrap())
    } else {
        None // No match or ambiguous
    }
}
```

**Step 4: Run tests to verify they pass**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path crates/Cargo.toml -p relay -- test::test_resolve_doc_id`
Expected: All 3 tests PASS

**Step 5: Add the HTTP endpoint handler**

Add the handler function near the other doc handlers (after `auth_doc`, around line 2166):

```rust
async fn resolve_doc(
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
    State(server_state): State<Arc<Server>>,
    Path(prefix): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    server_state.check_auth(auth_header)?;

    match server_state.resolve_doc_id(&prefix).await {
        Some(doc_id) => Ok(Json(serde_json::json!({ "docId": doc_id }))),
        None => Err(AppError(
            StatusCode::NOT_FOUND,
            anyhow!("No unique doc matching prefix '{}'", prefix),
        )),
    }
}
```

Add the route in `fn routes()` (around line 1248, after the auth route):

```rust
.route("/doc/resolve/:prefix", get(resolve_doc))
```

**Step 6: Add integration-style test for the HTTP handler**

Add to the test module:

```rust
#[tokio::test]
async fn test_resolve_doc_handler() {
    let server_state = Server::new(
        None,
        Duration::from_secs(60),
        None,
        None,
        vec![],
        CancellationToken::new(),
        true,
        None,
    )
    .await
    .unwrap();

    let doc_id = server_state.create_doc().await.unwrap();
    let prefix = doc_id[..8].to_string();

    let result = resolve_doc(
        None,
        State(Arc::new(server_state)),
        Path(prefix),
    )
    .await
    .unwrap();

    let resolved_id = result.0["docId"].as_str().unwrap();
    assert_eq!(resolved_id, doc_id);
}

#[tokio::test]
async fn test_resolve_doc_handler_not_found() {
    let server_state = Server::new(
        None,
        Duration::from_secs(60),
        None,
        None,
        vec![],
        CancellationToken::new(),
        true,
        None,
    )
    .await
    .unwrap();

    let result = resolve_doc(
        None,
        State(Arc::new(server_state)),
        Path("nonexistent".to_string()),
    )
    .await;

    assert!(result.is_err());
}
```

**Step 7: Run all relay tests**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path crates/Cargo.toml -p relay`
Expected: All tests PASS

**Step 8: Commit**

```bash
jj new -m "feat(relay): add doc ID prefix resolution endpoint"
```

(Then `jj st` to verify clean state)

---

### Task 2: Update `url-utils.ts` to use 8-char UUIDs

**Files:**
- Modify: `lens-editor/src/lib/url-utils.ts`
- Modify: `lens-editor/src/lib/url-utils.test.ts`

**Step 1: Update tests to expect 8-char UUIDs**

Replace the entire test file `lens-editor/src/lib/url-utils.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  docUuidFromCompoundId,
  compoundIdFromDocUuid,
  urlForDoc,
  docIdFromUrlParam,
  shortUuid,
} from './url-utils';

const RELAY_ID = 'cb696037-0f72-4e93-8717-4e433129d789';
const DOC_UUID = '76c3e654-0e77-4538-962f-1b419647206e';
const COMPOUND_ID = `${RELAY_ID}-${DOC_UUID}`;
const SHORT = DOC_UUID.slice(0, 8); // '76c3e654'

describe('docUuidFromCompoundId', () => {
  it('extracts the doc UUID from a compound ID', () => {
    expect(docUuidFromCompoundId(COMPOUND_ID)).toBe(DOC_UUID);
  });
});

describe('compoundIdFromDocUuid', () => {
  it('builds compound ID from relay ID and doc UUID', () => {
    expect(compoundIdFromDocUuid(RELAY_ID, DOC_UUID)).toBe(COMPOUND_ID);
  });
});

describe('shortUuid', () => {
  it('returns first 8 chars of a full UUID', () => {
    expect(shortUuid(DOC_UUID)).toBe('76c3e654');
  });

  it('returns input unchanged if already 8 chars or shorter', () => {
    expect(shortUuid('abcd1234')).toBe('abcd1234');
  });
});

describe('urlForDoc', () => {
  it('builds URL with short UUID and file path from metadata', () => {
    const metadata = {
      '/Lens/Welcome.md': { id: DOC_UUID, type: 'markdown' as const, version: 0 },
    };
    expect(urlForDoc(COMPOUND_ID, metadata)).toBe(`/${SHORT}/Lens/Welcome.md`);
  });

  it('returns URL with just short UUID when metadata has no matching doc', () => {
    expect(urlForDoc(COMPOUND_ID, {})).toBe(`/${SHORT}`);
  });

  it('replaces spaces with dashes in file paths', () => {
    const metadata = {
      '/Lens Edu/My Notes.md': { id: DOC_UUID, type: 'markdown' as const, version: 0 },
    };
    expect(urlForDoc(COMPOUND_ID, metadata)).toBe(`/${SHORT}/Lens-Edu/My-Notes.md`);
  });
});

describe('docIdFromUrlParam', () => {
  it('builds compound ID from full URL param UUID', () => {
    expect(docIdFromUrlParam(DOC_UUID, RELAY_ID)).toBe(COMPOUND_ID);
  });

  it('builds short compound ID from short URL param UUID', () => {
    expect(docIdFromUrlParam(SHORT, RELAY_ID)).toBe(`${RELAY_ID}-${SHORT}`);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/penguin/code/lens-relay/ws1/lens-editor && npx vitest run src/lib/url-utils.test.ts`
Expected: FAIL — `shortUuid` doesn't exist, `urlForDoc` returns full UUID

**Step 3: Update `url-utils.ts`**

Replace `lens-editor/src/lib/url-utils.ts`:

```typescript
import type { FolderMetadata } from '../hooks/useFolderMetadata';

/** Length of the short UUID prefix used in URLs. */
export const SHORT_UUID_LENGTH = 8;

/**
 * Extract the doc UUID (last 36 chars) from a compound doc ID.
 * Compound ID format: {RELAY_ID (36)}-{DOC_UUID (36)}
 */
export function docUuidFromCompoundId(compoundId: string): string {
  return compoundId.slice(37);
}

/**
 * Build a compound doc ID from relay ID + doc UUID.
 */
export function compoundIdFromDocUuid(relayId: string, docUuid: string): string {
  return `${relayId}-${docUuid}`;
}

/**
 * Return the first 8 characters of a UUID for use in URLs.
 */
export function shortUuid(uuid: string): string {
  return uuid.slice(0, SHORT_UUID_LENGTH);
}

/**
 * Build a URL path for a document using a short UUID.
 * Format: /{shortUuid}/{folder}/{path}
 * The path after the UUID is decorative (for human readability in shared links).
 * Falls back to just /{shortUuid} if no metadata match found.
 */
export function urlForDoc(compoundDocId: string, metadata: FolderMetadata): string {
  const docUuid = docUuidFromCompoundId(compoundDocId);
  const short = shortUuid(docUuid);

  // Find the file path in metadata by matching the doc UUID
  for (const [path, meta] of Object.entries(metadata)) {
    if (meta.id === docUuid) {
      // Replace spaces with dashes for readability
      // (the path is decorative — the UUID is the canonical identifier)
      const encodedPath = path
        .split('/')
        .map((segment) => segment.replace(/ /g, '-'))
        .join('/');
      return `/${short}${encodedPath}`;
    }
  }

  return `/${short}`;
}

/**
 * Build a compound doc ID from a URL param doc UUID.
 * This is a pure string operation — no metadata lookup needed.
 * Works with both full UUIDs and short prefixes.
 */
export function docIdFromUrlParam(docUuid: string, relayId: string): string {
  return compoundIdFromDocUuid(relayId, docUuid);
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /home/penguin/code/lens-relay/ws1/lens-editor && npx vitest run src/lib/url-utils.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
jj new -m "feat(url-utils): use 8-char short UUIDs in URL generation"
```

---

### Task 3: Add `useResolvedDocId` hook

This hook resolves short doc UUIDs (from URLs) to full compound IDs. It uses two strategies: client-side resolution from loaded metadata (instant, for in-app navigation), and server-side resolution via the relay API (for cold page loads when metadata isn't loaded yet).

**Files:**
- Create: `lens-editor/src/hooks/useResolvedDocId.ts`
- Create: `lens-editor/src/hooks/useResolvedDocId.test.ts`

**Step 1: Write the failing test**

Create `lens-editor/src/hooks/useResolvedDocId.test.ts`:

```typescript
/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useResolvedDocId } from './useResolvedDocId';

const RELAY_ID = 'a0000000-0000-4000-8000-000000000000';
const FULL_DOC_UUID = 'c0000001-0000-4000-8000-000000000001';
const SHORT_PREFIX = 'c0000001';
const FULL_COMPOUND = `${RELAY_ID}-${FULL_DOC_UUID}`;
const SHORT_COMPOUND = `${RELAY_ID}-${SHORT_PREFIX}`;

// Mock fetch for server-side resolution
const mockFetch = vi.fn();
global.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

describe('useResolvedDocId', () => {
  it('returns null for empty input', () => {
    const { result } = renderHook(() =>
      useResolvedDocId('', {})
    );
    expect(result.current).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns full compound ID immediately when input is already full-length', () => {
    const { result } = renderHook(() =>
      useResolvedDocId(FULL_COMPOUND, {})
    );
    expect(result.current).toBe(FULL_COMPOUND);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('resolves short compound ID from metadata (client-side)', () => {
    const metadata = {
      '/Lens/Welcome.md': { id: FULL_DOC_UUID, type: 'markdown' as const, version: 0 },
    };
    const { result } = renderHook(() =>
      useResolvedDocId(SHORT_COMPOUND, metadata)
    );
    expect(result.current).toBe(FULL_COMPOUND);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('resolves short compound ID from server when metadata is empty', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ docId: FULL_COMPOUND }),
    });

    const { result } = renderHook(() =>
      useResolvedDocId(SHORT_COMPOUND, {})
    );

    // Initially null (loading)
    expect(result.current).toBeNull();

    await waitFor(() => {
      expect(result.current).toBe(FULL_COMPOUND);
    });

    expect(mockFetch).toHaveBeenCalledWith(`/api/relay/doc/resolve/${SHORT_COMPOUND}`);
  });

  it('returns null when server resolution fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    const { result } = renderHook(() =>
      useResolvedDocId(SHORT_COMPOUND, {})
    );

    // Wait for the fetch to complete
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });

    expect(result.current).toBeNull();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/penguin/code/lens-relay/ws1/lens-editor && npx vitest run src/hooks/useResolvedDocId.test.ts`
Expected: FAIL — module doesn't exist

**Step 3: Implement the hook**

Create `lens-editor/src/hooks/useResolvedDocId.ts`:

```typescript
import { useState, useEffect, useMemo } from 'react';
import type { FolderMetadata } from './useFolderMetadata';
import { compoundIdFromDocUuid } from '../lib/url-utils';

/**
 * Resolve a possibly-short compound doc ID to a full compound doc ID.
 *
 * Strategy:
 * 1. If empty, return null immediately (no doc selected).
 * 2. If already full-length (73 chars), return immediately.
 * 3. Try client-side prefix match against loaded metadata (instant).
 * 4. Fall back to server-side resolution via /api/relay/doc/resolve/ (cold page loads).
 *
 * Returns the full compound ID, or null while resolving / for invalid input.
 */
export function useResolvedDocId(
  compoundId: string,
  metadata: FolderMetadata,
): string | null {
  // Empty or too-short input — no doc to resolve
  const isValid = compoundId.length > 37; // At minimum: 36-char relay ID + dash + 1 char
  // Full-length compound IDs need no resolution (73 = 36 relay + 1 dash + 36 doc)
  const isShort = isValid && compoundId.length < 73;

  // Extract the short doc UUID prefix (everything after the relay ID + dash)
  const docPrefix = isShort ? compoundId.slice(37) : '';
  const relayId = isValid ? compoundId.slice(0, 36) : '';

  // 1. Client-side resolution from loaded metadata
  const clientResolved = useMemo(() => {
    if (!isValid) return null;
    if (!isShort) return compoundId;

    for (const meta of Object.values(metadata)) {
      if (meta.id.startsWith(docPrefix)) {
        return compoundIdFromDocUuid(relayId, meta.id);
      }
    }
    return null;
  }, [isValid, isShort, compoundId, docPrefix, relayId, metadata]);

  // 2. Server-side fallback for cold page loads
  const [serverResolved, setServerResolved] = useState<string | null>(null);

  useEffect(() => {
    // Skip server resolution if not needed
    if (!isValid || !isShort || clientResolved) return;

    let cancelled = false;

    fetch(`/api/relay/doc/resolve/${compoundId}`)
      .then((res) => {
        if (!res.ok) return null;
        return res.json();
      })
      .then((data) => {
        if (!cancelled && data?.docId) {
          setServerResolved(data.docId);
        }
      })
      .catch(() => {
        // Resolution failed — leave as null
      });

    return () => {
      cancelled = true;
    };
  }, [isValid, isShort, clientResolved, compoundId]);

  return clientResolved ?? serverResolved;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /home/penguin/code/lens-relay/ws1/lens-editor && npx vitest run src/hooks/useResolvedDocId.test.ts`
Expected: All 4 tests PASS

**Step 5: Commit**

```bash
jj new -m "feat: add useResolvedDocId hook with client+server resolution"
```

---

### Task 4: Update `DocumentView` to resolve short UUIDs

**Files:**
- Modify: `lens-editor/src/App.tsx:81-108` (DocumentView component)
- Modify: `lens-editor/src/App.tsx:39-41` (DEFAULT_DOC_UUID → short)

**Context:** `DocumentView` currently constructs the full compound ID directly from the URL param: `const activeDocId = \`${RELAY_ID}-${docUuid}\``. With short UUIDs, the URL param is only 8 chars, so we need to resolve it first. The `useResolvedDocId` hook handles this. While resolving (cold page load), we show a loading state. Once resolved, `RelayProvider` receives the full 73-char compound ID as before.

**Important:** The y-sweet `YDocProvider` validates that `clientToken.docId` matches the `docId` prop. Since `RelayProvider` always receives the full resolved compound ID, this validation passes unchanged. No y-sweet library modifications needed.

**Step 1: Update `DocumentView` in `App.tsx`**

Replace the `DocumentView` function (lines 81-108) and `DEFAULT_DOC_UUID` (lines 38-41):

The `DEFAULT_DOC_UUID` constant should use the short form:

```typescript
// Default document short UUID (first 8 chars — used only in URL redirect)
const DEFAULT_DOC_UUID = USE_LOCAL_RELAY
  ? 'c0000001'
  : '76c3e654';
```

The `DocumentView` component:

```typescript
/**
 * Document view — reads docUuid from URL params, resolves short UUIDs, renders editor.
 * Lives inside NavigationContext so it can access metadata and onNavigate.
 *
 * IMPORTANT: All hooks must be called before any early returns (Rules of Hooks).
 */
function DocumentView() {
  const { docUuid, '*': splatPath } = useParams<{ docUuid: string; '*': string }>();
  const { metadata } = useNavigation();
  const navigate = useNavigate();

  // Build compound ID from URL param (may be short: RELAY_ID + 8-char prefix)
  // Empty string when docUuid is missing — hook handles this gracefully
  const shortCompoundId = docUuid ? `${RELAY_ID}-${docUuid}` : '';

  // Resolve short UUID to full compound ID (instant from metadata, or server fetch)
  // Returns null for empty input or while resolving
  const activeDocId = useResolvedDocId(shortCompoundId, metadata);

  // Update URL to use short UUID + decorative path when metadata loads
  useEffect(() => {
    if (!activeDocId || !docUuid || Object.keys(metadata).length === 0) return;
    const expectedUrl = urlForDoc(activeDocId, metadata);
    const currentPath = `/${docUuid}${splatPath ? `/${splatPath}` : ''}`;
    if (currentPath !== expectedUrl) {
      navigate(expectedUrl, { replace: true });
    }
  }, [metadata, activeDocId, docUuid, splatPath, navigate]);

  if (!docUuid) return <DocumentNotFound />;

  // Show loading while resolving short UUID on cold page load
  if (!activeDocId) {
    return (
      <main className="flex-1 flex items-center justify-center bg-gray-50">
        <div className="text-sm text-gray-500">Loading document...</div>
      </main>
    );
  }

  return (
    <RelayProvider key={activeDocId} docId={activeDocId}>
      <AwarenessInitializer />
      <EditorArea currentDocId={activeDocId} />
      <DisconnectionModal />
    </RelayProvider>
  );
}
```

Add the import at the top of `App.tsx`:

```typescript
import { useResolvedDocId } from './hooks/useResolvedDocId';
```

**Step 2: Update `Sidebar.tsx` to handle short UUIDs in URL**

In `lens-editor/src/components/Sidebar/Sidebar.tsx:19-22`, the Sidebar derives the active doc ID from the URL. With short UUIDs in the URL, it needs the same resolution logic. However, since the Sidebar always has metadata loaded (it's inside `NavigationContext`), client-side resolution will always succeed for in-app navigation. For cold page loads, it's OK if the Sidebar doesn't highlight until resolution completes.

Replace lines 19-22:

Add imports at the top of `Sidebar.tsx`:

```typescript
import { useResolvedDocId } from '../../hooks/useResolvedDocId';
```

And access `metadata` from the navigation context — it's already available via `useNavigation()` on line 41. Move the destructure earlier so `metadata` is available for the resolution hook:

```typescript
  const { metadata, folderDocs, folderNames, onNavigate } = useNavigation();

  // Derive active doc ID from URL path (first segment is the doc UUID — may be short)
  const location = useLocation();
  const docUuidFromUrl = location.pathname.split('/')[1] || '';
  const shortCompoundId = docUuidFromUrl ? `${RELAY_ID}-${docUuidFromUrl}` : '';
  // Resolve short UUID to full compound ID (empty string = no active doc)
  const activeDocId = useResolvedDocId(shortCompoundId, metadata) || '';
```

**Step 3: Run TypeScript check**

Run: `cd /home/penguin/code/lens-relay/ws1/lens-editor && npx tsc --noEmit`
Expected: No type errors

**Step 4: Run unit tests**

Run: `cd /home/penguin/code/lens-relay/ws1/lens-editor && npx vitest run`
Expected: All tests PASS (some Sidebar tests may need URL updates — see Task 5)

**Step 5: Commit**

```bash
jj new -m "feat: resolve short UUIDs in DocumentView and Sidebar"
```

---

### Task 5: Update tests for short UUID URLs

**Files:**
- Modify: `lens-editor/src/components/Sidebar/Sidebar.test.tsx`
- Modify: `lens-editor/src/components/Sidebar/Sidebar.integration.test.tsx` (if it exists and uses URLs)

**Context:** The `MemoryRouter` in `Sidebar.test.tsx` currently uses full UUIDs in `initialEntries`. These need to use 8-char short UUIDs to match the new URL format. The `useResolvedDocId` hook will need to be either mocked or satisfied via the metadata in the test's `NavigationContext`.

**Step 1: Update `Sidebar.test.tsx`**

In `lens-editor/src/components/Sidebar/Sidebar.test.tsx:33`, change the `MemoryRouter` initial entry to use the short UUID:

```typescript
// Old: initialEntries={['/c0000001-0000-4000-8000-000000000001/Lens/Welcome.md']}
// New: use 8-char short UUID
<MemoryRouter initialEntries={['/c0000001/Lens/Welcome.md']}>
```

The metadata in the test already contains `id: 'welcome'` which doesn't match the URL UUID anyway (this test doesn't test active state highlighting — just rendering). The `useResolvedDocId` hook needs to be satisfied. Since the test provides metadata via `NavigationContext`, we need to mock the `useResolvedDocId` hook or ensure it has access to the metadata.

Since `Sidebar` calls `useNavigation()` internally and we provide metadata through context, and the `useResolvedDocId` hook takes metadata as a parameter, we need to mock the hook in this test:

Add the mock at the top of the test file (after imports):

```typescript
// Mock the resolution hook — Sidebar tests don't test doc resolution
vi.mock('../../hooks/useResolvedDocId', () => ({
  useResolvedDocId: (compoundId: string) => compoundId || null,
}));
```

**Step 2: Run tests**

Run: `cd /home/penguin/code/lens-relay/ws1/lens-editor && npx vitest run src/components/Sidebar/Sidebar.test.tsx`
Expected: PASS

**Step 3: Run all tests to check for other breakage**

Run: `cd /home/penguin/code/lens-relay/ws1/lens-editor && npx vitest run`
Expected: All tests PASS. Fix any remaining test failures from the short UUID change.

**Step 4: Commit**

```bash
jj new -m "test: update tests for short UUID URLs"
```

---

### Task 6: Smoke test end-to-end

**Files:** None (manual testing)

**Step 1: Start the relay server**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo run --manifest-path /home/penguin/code/lens-relay/ws1/crates/Cargo.toml --bin relay -- serve --port 8090`

**Step 2: Set up test data**

Run: `cd /home/penguin/code/lens-relay/ws1/lens-editor && npm run relay:setup`

**Step 3: Start the dev server**

Run: `cd /home/penguin/code/lens-relay/ws1/lens-editor && npm run dev:local`

**Step 4: Verify the resolve endpoint works**

Run: `curl http://localhost:8090/doc/resolve/a0000000-0000-4000-8000-000000000000-c0000001`
Expected: JSON response with full compound doc ID: `{"docId":"a0000000-0000-4000-8000-000000000000-c0000001-0000-4000-8000-000000000001"}`

**Step 5: Verify in browser**

1. Open `http://dev.vps:5173/` — should redirect to `/{8-char}/...` URL
2. Click a file in sidebar — URL should update with 8-char UUID + decorative path
3. Copy URL, open in new tab — document should load (cold page load resolution)
4. Use browser back/forward — should navigate between documents
5. Check that the URL bar always shows 8-char UUIDs, never full 36-char UUIDs

**Step 6: Verify TypeScript is clean**

Run: `cd /home/penguin/code/lens-relay/ws1/lens-editor && npx tsc --noEmit`
Expected: No type errors

**Step 7: Commit if any fixes were needed**

```bash
jj new -m "fix: smoke test fixes for short UUID URLs"
```
