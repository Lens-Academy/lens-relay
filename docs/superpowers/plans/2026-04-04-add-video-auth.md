# Add-Video Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Protect the add-video bookmarklet installer and API behind share-token auth with a purpose-scoped token.

**Architecture:** Add a purpose byte to the share token binary format (breaking change). Move the static `add-video.html` page into the React SPA as a gated route. The bookmarklet gets an add-video-purpose token baked in at install time; the API verifies this token on every request.

**Tech Stack:** TypeScript, Hono, React, Vitest, HMAC-SHA256

**Spec:** `docs/superpowers/specs/2026-04-04-add-video-auth-design.md`

---

### Task 1: Add purpose byte to share token format

**Files:**
- Modify: `lens-editor/server/share-token.ts`
- Modify: `lens-editor/server/share-token.test.ts`

- [ ] **Step 1: Update test file for new format**

Replace the entire test file. Key changes: all `ShareTokenPayload` objects gain `purpose` field, token length assertions change from 29→30 bytes / ~39→~40 chars, and new tests for purpose field:

```ts
// lens-editor/server/share-token.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { signShareToken, verifyShareToken, decodeShareTokenPayload } from './share-token.ts';
import type { ShareTokenPayload } from './share-token.ts';

describe('share-token', () => {
  const validPayload: ShareTokenPayload = {
    purpose: 'share',
    role: 'edit',
    folder: 'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e',
    expiry: Math.floor(Date.now() / 1000) + 3600,
  };

  describe('signShareToken + verifyShareToken', () => {
    it('should sign and verify a valid share token', () => {
      const token = signShareToken(validPayload);
      const result = verifyShareToken(token);
      expect(result).toEqual(validPayload);
    });

    it('should sign and verify an add-video token', () => {
      const payload: ShareTokenPayload = { ...validPayload, purpose: 'add-video' };
      const token = signShareToken(payload);
      const result = verifyShareToken(token);
      expect(result).toEqual(payload);
    });

    it('should produce a compact token (~40 chars)', () => {
      const token = signShareToken(validPayload);
      // 30 bytes base64url → ceil(30*4/3) = 40 chars
      expect(token.length).toBeLessThanOrEqual(40);
    });

    it('should return null for tampered token', () => {
      const token = signShareToken(validPayload);
      const mid = Math.floor(token.length / 2);
      const c = token[mid] === 'A' ? 'B' : 'A';
      const tampered = token.slice(0, mid) + c + token.slice(mid + 1);
      expect(verifyShareToken(tampered)).toBeNull();
    });

    it('should return null for truncated token', () => {
      const token = signShareToken(validPayload);
      expect(verifyShareToken(token.slice(0, -4))).toBeNull();
    });

    it('should return null for expired token', () => {
      const expired: ShareTokenPayload = {
        ...validPayload,
        expiry: Math.floor(Date.now() / 1000) - 1,
      };
      const token = signShareToken(expired);
      expect(verifyShareToken(token)).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(verifyShareToken('')).toBeNull();
    });

    it('should return null for garbage input', () => {
      expect(verifyShareToken('not-a-valid-token')).toBeNull();
    });

    it('should handle all three roles', () => {
      for (const role of ['edit', 'suggest', 'view'] as const) {
        const payload: ShareTokenPayload = { ...validPayload, role };
        const token = signShareToken(payload);
        const result = verifyShareToken(token);
        expect(result?.role).toBe(role);
      }
    });

    it('should handle both purposes', () => {
      for (const purpose of ['share', 'add-video'] as const) {
        const payload: ShareTokenPayload = { ...validPayload, purpose };
        const token = signShareToken(payload);
        const result = verifyShareToken(token);
        expect(result?.purpose).toBe(purpose);
      }
    });

    it('share and add-video tokens should be different', () => {
      const shareToken = signShareToken({ ...validPayload, purpose: 'share' });
      const addVideoToken = signShareToken({ ...validPayload, purpose: 'add-video' });
      expect(shareToken).not.toBe(addVideoToken);
    });
  });

  describe('decodeShareTokenPayload', () => {
    it('should decode payload without verification', () => {
      const token = signShareToken(validPayload);
      const payload = decodeShareTokenPayload(token);
      expect(payload).toEqual(validPayload);
    });

    it('should decode even with tampered signature', () => {
      const token = signShareToken(validPayload);
      const c = token[token.length - 1] === 'A' ? 'B' : 'A';
      const tampered = token.slice(0, -1) + c;
      const payload = decodeShareTokenPayload(tampered);
      expect(payload?.role).toBe('edit');
      expect(payload?.purpose).toBe('share');
      expect(payload?.folder).toBe(validPayload.folder);
    });

    it('should return null for malformed token', () => {
      expect(decodeShareTokenPayload('garbage')).toBeNull();
    });
  });

  describe('production secret enforcement', () => {
    const origEnv = process.env.NODE_ENV;
    const origSecret = process.env.SHARE_TOKEN_SECRET;

    afterEach(() => {
      process.env.NODE_ENV = origEnv;
      if (origSecret !== undefined) {
        process.env.SHARE_TOKEN_SECRET = origSecret;
      } else {
        delete process.env.SHARE_TOKEN_SECRET;
      }
    });

    it('should throw in production without SHARE_TOKEN_SECRET', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.SHARE_TOKEN_SECRET;
      expect(() => signShareToken(validPayload)).toThrow('SHARE_TOKEN_SECRET is required in production');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lens-editor && npx vitest run server/share-token.test.ts`
Expected: FAIL — `purpose` field not in `ShareTokenPayload` type, length mismatches.

- [ ] **Step 3: Update share-token.ts implementation**

In `lens-editor/server/share-token.ts`, make these changes:

1. Add `purpose` to the type and lookup maps:

```ts
export type TokenPurpose = 'share' | 'add-video';

export interface ShareTokenPayload {
  purpose: TokenPurpose;
  role: UserRole;
  folder: string;   // UUID string
  expiry: number;    // unix seconds
}

const PURPOSE_TO_BYTE: Record<TokenPurpose, number> = { 'share': 0, 'add-video': 1 };
const BYTE_TO_PURPOSE: Record<number, TokenPurpose> = { 0: 'share', 1: 'add-video' };
```

2. Update `PAYLOAD_LEN` from 21 to 22:

```ts
const PAYLOAD_LEN = 22;  // 1 purpose + 1 role + 16 uuid + 4 expiry
```

3. Update `packPayload` — purpose at byte 0, role at byte 1, uuid at byte 2, expiry at byte 18:

```ts
function packPayload(payload: ShareTokenPayload): Buffer {
  const buf = Buffer.alloc(PAYLOAD_LEN);
  buf[0] = PURPOSE_TO_BYTE[payload.purpose];
  buf[1] = ROLE_TO_BYTE[payload.role];
  uuidToBytes(payload.folder).copy(buf, 2);
  buf.writeUInt32BE(payload.expiry, 18);
  return buf;
}
```

4. Update `unpackPayload` — read purpose from byte 0, role from byte 1, uuid from bytes 2–17, expiry from byte 18:

```ts
function unpackPayload(buf: Buffer): ShareTokenPayload | null {
  if (buf.length < PAYLOAD_LEN) return null;
  const purpose = BYTE_TO_PURPOSE[buf[0]];
  if (!purpose) return null;
  const role = BYTE_TO_ROLE[buf[1]];
  if (!role) return null;
  const folder = bytesToUuid(buf.subarray(2, 18));
  const expiry = buf.readUInt32BE(18);
  return { purpose, role, folder, expiry };
}
```

No changes needed to `signShareToken`, `verifyShareToken`, or `decodeShareTokenPayload` — they use `packPayload`/`unpackPayload` and `PAYLOAD_LEN` which now handle the new layout.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lens-editor && npx vitest run server/share-token.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
jj new -m "feat: add purpose byte to share token format (breaking)"
```

---

### Task 2: Update client-side token decoding for new format

**Files:**
- Modify: `lens-editor/src/lib/auth-share.ts`
- Modify: `lens-editor/src/lib/auth-share.test.ts`

- [ ] **Step 1: Update tests for new byte offsets**

The fake token builders need to produce 30-byte tokens (was 29), with purpose at byte 0, role at byte 1, folder at bytes 2–17. Update `makeFakeBinaryToken` and `makeFakeTokenWithFolder`:

```ts
/** Build a fake binary token: base64url(purposeByte + roleByte + 16 uuid bytes + 4 expiry bytes + 8 sig bytes) */
function makeFakeBinaryToken(roleByte: number, purposeByte: number = 0): string {
  const bytes = new Uint8Array(30); // 1 purpose + 1 role + 16 uuid + 4 expiry + 8 sig
  bytes[0] = purposeByte;
  bytes[1] = roleByte;
  for (let i = 2; i < 30; i++) bytes[i] = i;
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** Build a fake binary token with a specific folder UUID */
function makeFakeTokenWithFolder(roleByte: number, folderUuid: string, purposeByte: number = 0): string {
  const bytes = new Uint8Array(30);
  bytes[0] = purposeByte;
  bytes[1] = roleByte;
  const hex = folderUuid.replace(/-/g, '');
  for (let i = 0; i < 16; i++) {
    bytes[2 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  for (let i = 18; i < 30; i++) bytes[i] = i;
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
```

Add tests for `decodePurposeFromToken`:

```ts
describe('decodePurposeFromToken', () => {
  it('should decode share purpose (byte 0)', () => {
    expect(decodePurposeFromToken(makeFakeBinaryToken(1, 0))).toBe('share');
  });

  it('should decode add-video purpose (byte 1)', () => {
    expect(decodePurposeFromToken(makeFakeBinaryToken(1, 1))).toBe('add-video');
  });

  it('should return null for unknown purpose byte', () => {
    expect(decodePurposeFromToken(makeFakeBinaryToken(1, 99))).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(decodePurposeFromToken('')).toBeNull();
  });
});
```

Update existing `decodeRoleFromToken` tests to use `makeFakeBinaryToken(roleByte, 0)` (add explicit purpose=0). The existing calls like `makeFakeBinaryToken(1)` still work since purposeByte defaults to 0.

Update `isTokenExpired` internal byte offset expectation: expiry is now at byte 18 (was 17), minimum length check is 22 (was 21).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lens-editor && npx vitest run src/lib/auth-share.test.ts`
Expected: FAIL — `decodePurposeFromToken` not exported, byte offset changes cause wrong values.

- [ ] **Step 3: Update auth-share.ts implementation**

In `lens-editor/src/lib/auth-share.ts`:

1. Add purpose decoding and export:

```ts
const BYTE_TO_PURPOSE: Record<number, string> = { 0: 'share', 1: 'add-video' };

export function decodePurposeFromToken(token: string): string | null {
  try {
    const bytes = base64urlToBytes(token);
    if (bytes.length < 1) return null;
    return BYTE_TO_PURPOSE[bytes[0]] ?? null;
  } catch {
    return null;
  }
}
```

2. Shift `decodeRoleFromToken` — role is now at byte 1 (was byte 0):

```ts
export function decodeRoleFromToken(token: string): UserRole | null {
  try {
    const bytes = base64urlToBytes(token);
    if (bytes.length < 2) return null;
    return BYTE_TO_ROLE[bytes[1]] ?? null;
  } catch {
    return null;
  }
}
```

3. Shift `isTokenExpired` — expiry is now at byte 18 (was byte 17), minimum length 22 (was 21):

```ts
export function isTokenExpired(token: string): boolean {
  try {
    const bytes = base64urlToBytes(token);
    if (bytes.length < 22) return true;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const expiry = view.getUint32(18, false);
    return expiry < Math.floor(Date.now() / 1000);
  } catch {
    return true;
  }
}
```

4. Shift `decodeFolderFromToken` — UUID is now at bytes 2–17 (was 1–16):

```ts
export function decodeFolderFromToken(token: string): string | null {
  try {
    const bytes = base64urlToBytes(token);
    if (bytes.length < 18) return null;
    const hex = Array.from(bytes.slice(2, 18))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lens-editor && npx vitest run src/lib/auth-share.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
jj new -m "feat: update client-side token decoding for purpose byte"
```

---

### Task 3: Update generate-share-link.ts for purpose field

**Files:**
- Modify: `lens-editor/scripts/generate-share-link.ts`

- [ ] **Step 1: Add `--purpose` flag**

Add purpose parsing after the existing arg parsing:

```ts
const purpose = (getArg('--purpose') || 'share') as 'share' | 'add-video';

if (!['share', 'add-video'].includes(purpose)) {
  console.error('Error: --purpose must be "share" or "add-video"');
  printUsage();
  process.exit(1);
}
```

Update the payload construction:

```ts
const payload: ShareTokenPayload = {
  purpose,
  role,
  folder,
  expiry: parseExpiry(expires),
};
```

Add `--purpose` to `printUsage()`:

```
  --purpose <share|add-video>  Token purpose (default: "share")
```

Add purpose to the output:

```ts
console.log(`Purpose: ${purpose}`);
```

- [ ] **Step 2: Test manually**

Run: `cd lens-editor && npx tsx scripts/generate-share-link.ts --role edit --all-folders --purpose add-video`
Expected: Prints a share link with `Purpose: add-video`. Token should be ~40 chars.

Run: `cd lens-editor && npx tsx scripts/generate-share-link.ts --role edit --all-folders`
Expected: Prints a share link with `Purpose: share` (default).

- [ ] **Step 3: Commit**

```bash
jj new -m "feat: add --purpose flag to generate-share-link"
```

---

### Task 4: Add auth middleware to add-video API routes

**Files:**
- Modify: `lens-editor/server/add-video/routes.ts`
- Modify: `lens-editor/server/add-video/routes.test.ts`

- [ ] **Step 1: Write failing tests for auth on routes**

Add auth tests to `routes.test.ts`. The route now requires an `Authorization: Bearer <token>` header with a valid add-video purpose token. Import `signShareToken`:

```ts
import { signShareToken } from '../share-token';
import type { ShareTokenPayload } from '../share-token';

const EDU_FOLDER = 'ea4015da-24af-4d9d-ac49-8c902cb17121';

function makeAddVideoToken(overrides: Partial<ShareTokenPayload> = {}): string {
  return signShareToken({
    purpose: 'add-video',
    role: 'edit',
    folder: EDU_FOLDER,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  });
}

function validHeaders(token?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token ?? makeAddVideoToken()}`,
  };
}
```

Add these test cases inside `describe('POST /api/add-video', ...)`:

```ts
  it('rejects request with no auth header', async () => {
    const resp = await app.request('/api/add-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videos: [validVideo] }),
    });
    expect(resp.status).toBe(401);
  });

  it('rejects request with invalid token', async () => {
    const resp = await app.request('/api/add-video', {
      method: 'POST',
      headers: validHeaders('garbage-token'),
      body: JSON.stringify({ videos: [validVideo] }),
    });
    expect(resp.status).toBe(401);
  });

  it('rejects share-purpose token (wrong purpose)', async () => {
    const shareToken = signShareToken({
      purpose: 'share',
      role: 'edit',
      folder: EDU_FOLDER,
      expiry: Math.floor(Date.now() / 1000) + 3600,
    });
    const resp = await app.request('/api/add-video', {
      method: 'POST',
      headers: validHeaders(shareToken),
      body: JSON.stringify({ videos: [validVideo] }),
    });
    expect(resp.status).toBe(403);
  });

  it('rejects view-role token', async () => {
    const resp = await app.request('/api/add-video', {
      method: 'POST',
      headers: validHeaders(makeAddVideoToken({ role: 'view' })),
      body: JSON.stringify({ videos: [validVideo] }),
    });
    expect(resp.status).toBe(403);
  });

  it('rejects token for wrong folder', async () => {
    const resp = await app.request('/api/add-video', {
      method: 'POST',
      headers: validHeaders(makeAddVideoToken({ folder: 'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e' })),
      body: JSON.stringify({ videos: [validVideo] }),
    });
    expect(resp.status).toBe(403);
  });

  it('accepts all-folders token', async () => {
    const resp = await app.request('/api/add-video', {
      method: 'POST',
      headers: validHeaders(makeAddVideoToken({ folder: '00000000-0000-0000-0000-000000000000' })),
      body: JSON.stringify({ videos: [validVideo] }),
    });
    expect(resp.status).toBe(200);
  });
```

Extract a `validVideo` constant used by both old and new tests:

```ts
const validVideo = {
  video_id: 'abc',
  title: 'Test',
  channel: 'Ch',
  url: 'https://youtube.com/watch?v=abc',
  transcript_type: 'word_level' as const,
  transcript_raw: { events: [] },
};
```

Update the existing passing test to include the auth header — change the `'Content-Type'` header to `validHeaders()`.

Also add auth test for status endpoint:

```ts
describe('GET /api/add-video/status', () => {
  it('rejects request with no auth header', async () => {
    // ... setup app ...
    const resp = await app.request('/api/add-video/status');
    expect(resp.status).toBe(401);
  });

  it('returns jobs with valid token', async () => {
    // ... setup app ...
    const resp = await app.request('/api/add-video/status', {
      headers: { 'Authorization': `Bearer ${makeAddVideoToken()}` },
    });
    expect(resp.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lens-editor && npx vitest run server/add-video/routes.test.ts`
Expected: FAIL — new auth tests fail (no auth checking in routes), existing tests may also fail (if they already send no auth header and we haven't added middleware yet).

- [ ] **Step 3: Add auth middleware to routes.ts**

In `lens-editor/server/add-video/routes.ts`, add auth middleware:

```ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { verifyShareToken } from '../share-token';
import type { JobQueue } from './queue';
import type { VideoPayload } from './types';

const EDU_FOLDER = 'ea4015da-24af-4d9d-ac49-8c902cb17121';
const ALL_FOLDERS = '00000000-0000-0000-0000-000000000000';

export function createAddVideoRoutes(queue: JobQueue): Hono {
  const router = new Hono();

  // CORS: bookmarklet runs on youtube.com and POSTs cross-origin
  router.use('/*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }));

  // Auth middleware: verify add-video purpose token
  router.use('/*', async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Authorization header required' }, 401);
    }
    const token = authHeader.slice(7);
    const payload = verifyShareToken(token);
    if (!payload) {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }
    if (payload.purpose !== 'add-video') {
      return c.json({ error: 'Token purpose must be add-video' }, 403);
    }
    if (payload.role !== 'edit') {
      return c.json({ error: 'Edit access required' }, 403);
    }
    if (payload.folder !== EDU_FOLDER && payload.folder !== ALL_FOLDERS) {
      return c.json({ error: 'Access denied: wrong folder scope' }, 403);
    }
    await next();
  });

  // ... rest of routes unchanged (POST /, GET /status) ...
```

Also add `'Authorization'` to the CORS `allowHeaders` array (needed for the bookmarklet to send the header cross-origin).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lens-editor && npx vitest run server/add-video/routes.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
jj new -m "feat: add auth middleware to add-video API routes"
```

---

### Task 5: Add install-token endpoint

**Files:**
- Modify: `lens-editor/server/add-video/routes.ts`
- Modify: `lens-editor/server/add-video/routes.test.ts`

- [ ] **Step 1: Write failing tests for install-token**

Add to `routes.test.ts` a new describe block. This endpoint uses a regular **share** token (the user's editor token) to mint an **add-video** token:

```ts
describe('POST /api/add-video/install-token', () => {
  let app: Hono;

  beforeEach(() => {
    const mockQueue = { add: vi.fn(), status: vi.fn(() => []) };
    app = new Hono();
    app.route('/api/add-video', createAddVideoRoutes(mockQueue as any));
  });

  function makeShareToken(overrides: Partial<ShareTokenPayload> = {}): string {
    return signShareToken({
      purpose: 'share',
      role: 'edit',
      folder: EDU_FOLDER,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      ...overrides,
    });
  }

  it('mints add-video token from valid share token', async () => {
    const shareToken = makeShareToken();
    const resp = await app.request('/api/add-video/install-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${shareToken}`,
      },
    });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.token).toBeDefined();
    expect(typeof data.token).toBe('string');

    // The minted token should be verifiable as add-video purpose
    const payload = verifyShareToken(data.token);
    expect(payload?.purpose).toBe('add-video');
    expect(payload?.role).toBe('edit');
    expect(payload?.folder).toBe(EDU_FOLDER);
  });

  it('mints token from all-folders share token scoped to edu folder', async () => {
    const shareToken = makeShareToken({ folder: '00000000-0000-0000-0000-000000000000' });
    const resp = await app.request('/api/add-video/install-token', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${shareToken}` },
    });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    const payload = verifyShareToken(data.token);
    // All-folders users get an add-video token scoped to edu folder
    expect(payload?.folder).toBe(EDU_FOLDER);
  });

  it('rejects non-edit role', async () => {
    const resp = await app.request('/api/add-video/install-token', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${makeShareToken({ role: 'view' })}` },
    });
    expect(resp.status).toBe(403);
  });

  it('rejects wrong folder', async () => {
    const resp = await app.request('/api/add-video/install-token', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${makeShareToken({ folder: 'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e' })}` },
    });
    expect(resp.status).toBe(403);
  });

  it('rejects add-video purpose token (must be share)', async () => {
    const addVideoToken = signShareToken({
      purpose: 'add-video',
      role: 'edit',
      folder: EDU_FOLDER,
      expiry: Math.floor(Date.now() / 1000) + 3600,
    });
    const resp = await app.request('/api/add-video/install-token', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${addVideoToken}` },
    });
    expect(resp.status).toBe(403);
  });

  it('rejects no auth header', async () => {
    const resp = await app.request('/api/add-video/install-token', { method: 'POST' });
    expect(resp.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lens-editor && npx vitest run server/add-video/routes.test.ts`
Expected: FAIL — `/install-token` route doesn't exist yet, and requests without add-video tokens hit the existing auth middleware.

- [ ] **Step 3: Implement install-token endpoint**

The `/install-token` endpoint needs **different** auth than the other routes — it accepts a **share** purpose token, not an **add-video** token. So it must be registered **before** the add-video auth middleware, or use its own auth logic.

Restructure `routes.ts`: move the add-video auth middleware to only apply to `POST /` and `GET /status`, and add `/install-token` with its own auth:

```ts
export function createAddVideoRoutes(queue: JobQueue): Hono {
  const router = new Hono();

  // CORS for all routes (bookmarklet is cross-origin)
  router.use('/*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }));

  // --- Install token endpoint (uses share token, not add-video token) ---
  router.post('/install-token', async (c) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Authorization header required' }, 401);
    }
    const payload = verifyShareToken(authHeader.slice(7));
    if (!payload) {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }
    if (payload.purpose !== 'share') {
      return c.json({ error: 'Share token required' }, 403);
    }
    if (payload.role !== 'edit') {
      return c.json({ error: 'Edit access required' }, 403);
    }
    if (payload.folder !== EDU_FOLDER && payload.folder !== ALL_FOLDERS) {
      return c.json({ error: 'Access denied: wrong folder scope' }, 403);
    }

    const addVideoToken = signShareToken({
      purpose: 'add-video',
      role: 'edit',
      folder: EDU_FOLDER,
      expiry: payload.expiry,
    });

    return c.json({ token: addVideoToken });
  });

  // --- Add-video auth middleware (for POST / and GET /status) ---
  router.use('/*', async (c, next) => {
    // Skip install-token (already handled above)
    if (c.req.path.endsWith('/install-token')) {
      await next();
      return;
    }
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Authorization header required' }, 401);
    }
    const payload = verifyShareToken(authHeader.slice(7));
    if (!payload) {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }
    if (payload.purpose !== 'add-video') {
      return c.json({ error: 'Token purpose must be add-video' }, 403);
    }
    if (payload.role !== 'edit') {
      return c.json({ error: 'Edit access required' }, 403);
    }
    if (payload.folder !== EDU_FOLDER && payload.folder !== ALL_FOLDERS) {
      return c.json({ error: 'Access denied: wrong folder scope' }, 403);
    }
    await next();
  });

  // POST / and GET /status unchanged ...
```

Add `signShareToken` to the imports:

```ts
import { verifyShareToken, signShareToken } from '../share-token';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lens-editor && npx vitest run server/add-video/routes.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
jj new -m "feat: add install-token endpoint for minting add-video tokens"
```

---

### Task 6: Create AddVideoPage React component

**Files:**
- Create: `lens-editor/src/components/AddVideoPage/AddVideoPage.tsx`
- Modify: `lens-editor/src/App.tsx`

- [ ] **Step 1: Create AddVideoPage component**

Create `lens-editor/src/components/AddVideoPage/AddVideoPage.tsx`. This converts the static `add-video.html` into a React component that:
1. On mount, calls `POST /api/add-video/install-token` with the user's share token
2. Fetches the bookmarklet JS from `/add-video-bookmarklet.js`
3. Replaces `__LENS_SERVER_URL__` and `__LENS_ADD_VIDEO_TOKEN__` placeholders
4. Renders the install page with the bookmarklet drag link

```tsx
import { useState, useEffect } from 'react';

export function AddVideoPage({ shareToken }: { shareToken: string }) {
  const [bookmarkletHref, setBookmarkletHref] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function setup() {
      try {
        // 1. Get add-video token from server
        const tokenResp = await fetch('/api/add-video/install-token', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${shareToken}` },
        });
        if (!tokenResp.ok) {
          const data = await tokenResp.json().catch(() => ({}));
          throw new Error(data.error || `Failed to get install token: ${tokenResp.status}`);
        }
        const { token } = await tokenResp.json();

        // 2. Fetch bookmarklet JS
        const jsResp = await fetch('/add-video-bookmarklet.js');
        if (!jsResp.ok) throw new Error('Failed to load bookmarklet script');
        let js = await jsResp.text();

        // 3. Inject server URL and token
        js = js.replaceAll('__LENS_SERVER_URL__', window.location.origin);
        js = js.replaceAll('__LENS_ADD_VIDEO_TOKEN__', token);

        if (!cancelled) {
          setBookmarkletHref('javascript:' + encodeURIComponent(js));
        }
      } catch (e: any) {
        if (!cancelled) setError(e.message);
      }
    }

    setup();
    return () => { cancelled = true; };
  }, [shareToken]);

  useEffect(() => {
    document.title = 'Add Video to Lens';
    return () => { document.title = 'Editor'; };
  }, []);

  return (
    <main className="flex-1 overflow-y-auto bg-[#1a1a2e] text-[#e0e0e0]"
          style={{ fontFamily: 'system-ui, sans-serif', lineHeight: 1.6 }}>
      <div className="max-w-[600px] mx-auto px-5 py-16">
        <h1 className="text-white text-2xl font-bold mb-4">Add Video to Lens</h1>
        <p>Add YouTube video transcripts to the Lens library with one click.</p>

        <h2 className="text-white text-xl font-semibold mt-8 mb-3">Install</h2>
        <p className="mb-4">Drag this button to your bookmarks bar:</p>

        {error && (
          <div className="bg-[#2a1a0e] border-l-[3px] border-[#d9534f] rounded p-3 mb-4 text-sm">
            Error: {error}
          </div>
        )}

        {bookmarkletHref ? (
          <a
            className="inline-block bg-[#4361ee] text-white px-6 py-3 rounded-lg text-base font-medium no-underline cursor-grab hover:bg-[#3a56d4]"
            href={bookmarkletHref}
            onClick={(e) => e.preventDefault()}
          >
            Add to Lens
          </a>
        ) : !error ? (
          <div className="text-sm text-gray-400">Loading bookmarklet...</div>
        ) : null}

        <div className="bg-[#2a1a0e] border-l-[3px] border-[#f0ad4e] rounded p-3 mt-4 text-sm">
          If your bookmarks bar is hidden, press{' '}
          <code className="bg-[#0f0f23] px-1.5 py-0.5 rounded text-xs">Ctrl+Shift+B</code> (Windows/Linux) or{' '}
          <code className="bg-[#0f0f23] px-1.5 py-0.5 rounded text-xs">Cmd+Shift+B</code> (Mac) to show it.
        </div>

        <h2 className="text-white text-xl font-semibold mt-8 mb-3">Usage</h2>

        {[
          'Go to any YouTube page (a video, your homepage, etc.)',
          'Click the "Add to Lens" bookmark in your bookmarks bar',
          'A panel opens on the right. Paste one or more YouTube video URLs (one per line), or leave it pre-filled with the current video.',
          'Click "Fetch Transcripts" — the bookmarklet extracts transcripts with word-level timestamps directly from YouTube.',
          'Review the results, then click "Send to Lens" to queue them for processing.',
        ].map((text, i) => (
          <div key={i} className="bg-[#16213e] rounded-lg p-4 my-3">
            <span className="inline-block bg-[#4361ee] text-white w-7 h-7 rounded-full text-center leading-7 font-bold mr-2">
              {i + 1}
            </span>
            {text}
          </div>
        ))}

        <div className="bg-[#2a1a0e] border-l-[3px] border-[#f0ad4e] rounded p-3 mt-4 text-sm">
          Transcripts are queued for processing on the server. You can check status at{' '}
          <code className="bg-[#0f0f23] px-1.5 py-0.5 rounded text-xs">/api/add-video/status</code>.
        </div>
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Add route in App.tsx**

Import the component at the top of `App.tsx`:

```ts
import { AddVideoPage } from './components/AddVideoPage/AddVideoPage';
```

Add the route next to the `/review` route inside `AuthenticatedApp`, in the `<Routes>` block (around line 457):

```tsx
<Route path="/add-video" element={
  role === 'edit' && (isAllFolders || folderUuid === 'ea4015da-24af-4d9d-ac49-8c902cb17121')
    ? <AddVideoPage shareToken={_shareToken!} />
    : <DefaultLanding />
} />
```

This requires access to `_shareToken` inside `AuthenticatedApp`. It's a module-level variable already (set at line 77), so reference it directly. Add a non-null assertion since `AuthenticatedApp` only renders when `shareToken` is truthy.

Note: `_shareToken` is in `src/lib/auth.ts`, not directly accessible. Instead, pass it from `App()` through the component tree. Add a `shareToken` prop to `AuthenticatedApp`:

In `App()` (around line 242):
```tsx
return <AuthenticatedApp role={shareRole} folderUuid={shareFolderUuid} isAllFolders={shareIsAllFolders} shareToken={shareToken!} />;
```

Update `AuthenticatedApp` signature:
```tsx
function AuthenticatedApp({ role, folderUuid, isAllFolders, shareToken }: { role: UserRole; folderUuid: string | null; isAllFolders: boolean; shareToken: string }) {
```

Then in the route:
```tsx
<Route path="/add-video" element={
  role === 'edit' && (isAllFolders || folderUuid === 'ea4015da-24af-4d9d-ac49-8c902cb17121')
    ? <AddVideoPage shareToken={shareToken} />
    : <DefaultLanding />
} />
```

- [ ] **Step 3: Verify it builds**

Run: `cd lens-editor && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
jj new -m "feat: add AddVideoPage React component and /add-video route"
```

---

### Task 7: Update bookmarklet to send auth header

**Files:**
- Modify: `lens-editor/public/add-video-bookmarklet.js`

- [ ] **Step 1: Add token placeholder and Authorization header**

In `lens-editor/public/add-video-bookmarklet.js`, add a token variable near the top of the IIFE (after the YouTube hostname check):

```js
var addVideoToken = '__LENS_ADD_VIDEO_TOKEN__';
```

Update the `fetch` call in the confirm/send button handler (around line 328) to include the auth header:

```js
fetch(serverUrl, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + addVideoToken
  },
  body: JSON.stringify({ videos: payload })
})
```

- [ ] **Step 2: Verify placeholder is present**

Run: `cd lens-editor && grep '__LENS_ADD_VIDEO_TOKEN__' public/add-video-bookmarklet.js`
Expected: Two matches — the variable declaration and nowhere else (the fetch uses the variable).

- [ ] **Step 3: Commit**

```bash
jj new -m "feat: bookmarklet sends Authorization header with add-video token"
```

---

### Task 8: Update Vite dev middleware for auth

**Files:**
- Modify: `lens-editor/vite.config.ts`

- [ ] **Step 1: Add auth and install-token to dev middleware**

In the `addVideoPlugin()` function in `vite.config.ts`, update the middleware to:

1. Add `Authorization` to the CORS `Access-Control-Allow-Headers`
2. Add `/install-token` sub-path handler (before the auth check)
3. Add auth verification for `POST /` and `GET /status`

Update the CORS header line:
```ts
res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
```

After the OPTIONS handler and lazy queue init, add the install-token and auth logic:

```ts
// Install-token endpoint: mint add-video token from share token
if (req.method === 'POST' && subPath === '/install-token') {
  const { verifyShareToken, signShareToken } = await import('./server/share-token.ts');
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Authorization header required' }));
    return;
  }
  const payload = verifyShareToken(authHeader.slice(7));
  if (!payload || payload.purpose !== 'share' || payload.role !== 'edit') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Edit share token required' }));
    return;
  }
  const EDU_FOLDER = 'ea4015da-24af-4d9d-ac49-8c902cb17121';
  const ALL_FOLDERS = '00000000-0000-0000-0000-000000000000';
  if (payload.folder !== EDU_FOLDER && payload.folder !== ALL_FOLDERS) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Access denied: wrong folder scope' }));
    return;
  }
  const addVideoToken = signShareToken({
    purpose: 'add-video',
    role: 'edit',
    folder: EDU_FOLDER,
    expiry: payload.expiry,
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ token: addVideoToken }));
  return;
}

// Auth check for other endpoints
const { verifyShareToken: verifyToken } = await import('./server/share-token.ts');
const authHeader = req.headers.authorization;
if (!authHeader?.startsWith('Bearer ')) {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Authorization header required' }));
  return;
}
const authPayload = verifyToken(authHeader.slice(7));
if (!authPayload || authPayload.purpose !== 'add-video' || authPayload.role !== 'edit') {
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Valid add-video token required' }));
  return;
}
```

- [ ] **Step 2: Verify dev server starts**

Run: `cd lens-editor && npx vite --host --port 5373 &` (use a throwaway port), then kill it.
Expected: Server starts without errors.

- [ ] **Step 3: Commit**

```bash
jj new -m "feat: add auth to add-video Vite dev middleware"
```

---

### Task 9: Delete static add-video.html

**Files:**
- Delete: `lens-editor/public/add-video.html`

- [ ] **Step 1: Delete the static file**

```bash
rm lens-editor/public/add-video.html
```

- [ ] **Step 2: Verify no remaining references to the static page**

Run: `cd lens-editor && grep -r 'add-video\.html' src/ server/ vite.config.ts`
Expected: No matches. (The bookmarklet JS file stays in `public/` since the React component fetches it.)

- [ ] **Step 3: Commit**

```bash
jj new -m "chore: remove static add-video.html (replaced by React route)"
```

---

### Task 10: Regenerate share links and manual test

- [ ] **Step 1: Generate a new share token**

```bash
cd lens-editor && npx tsx scripts/generate-share-link.ts --role edit --all-folders --base-url http://dev.vps:5173
```

Expected: Prints a URL with `Purpose: share`. Token is ~40 chars.

- [ ] **Step 2: Start dev servers and test the editor**

Start relay + Vite, open the share link, verify the editor loads and documents are accessible.

- [ ] **Step 3: Navigate to /add-video**

Navigate to `/add-video` in the browser. Expected: the bookmarklet install page loads, "Add to Lens" drag link appears after a moment (install-token + bookmarklet JS fetch).

- [ ] **Step 4: Test the bookmarklet on YouTube**

Drag the bookmarklet to the bookmark bar. Go to a YouTube video page. Click the bookmarklet. Paste a video URL. Click "Fetch Transcripts", then "Send to Lens". Expected: succeeds with 200.

- [ ] **Step 5: Test access denied cases**

Generate a view-only token: `npx tsx scripts/generate-share-link.ts --role view --all-folders`
Open the editor with it, navigate to `/add-video`. Expected: shows default landing page (no access).

- [ ] **Step 6: Update CLAUDE.md share link generation examples**

If the share link generation command in `CLAUDE.md` doesn't include `--purpose`, it still defaults to `share` which is correct. No change needed unless the output format changed.
