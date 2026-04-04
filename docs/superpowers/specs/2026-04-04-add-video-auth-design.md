# Add-Video Auth

Protect the add-video bookmarklet installer and API behind share token auth with a purpose-scoped token.

## Problem

`/add-video.html` is a static file served to anyone. The `/api/add-video` POST endpoint has no auth — anyone who knows the URL can submit video transcripts that get written to the relay.

## Design

### Token format — purpose byte

Add a purpose byte at position 0 of the share token binary format:

| Byte offset | Field | Size |
|---|---|---|
| 0 | purpose | 1 byte |
| 1 | role | 1 byte |
| 2–17 | folder UUID | 16 bytes |
| 18–21 | expiry (big-endian uint32) | 4 bytes |
| 22–29 | truncated HMAC-SHA256 | 8 bytes |

Purpose values:
- `0x00` = share (editor access)
- `0x01` = add-video (bookmarklet API access)

`PAYLOAD_LEN` becomes 22 (was 21). Total token = 30 bytes (was 29). **This is a breaking change** — all existing share links must be regenerated.

`ShareTokenPayload` gains a required `purpose: 'share' | 'add-video'` field.

### React route `/add-video`

Delete `public/add-video.html`. Add `<AddVideoPage>` component at route `/add-video` inside `AuthenticatedApp`, gated by:

```ts
role === 'edit' && (isAllFolders || folder === EDU_FOLDER_UUID)
```

Where `EDU_FOLDER_UUID = 'ea4015da-24af-4d9d-ac49-8c902cb17121'`.

If the gate fails, render `<DefaultLanding />` (same pattern as `/review`).

The component contains the same content as the current static page: install instructions, bookmarklet drag link.

### Bookmarklet token flow

On mount, `<AddVideoPage>` calls `POST /api/add-video/install-token`. The server:

1. Verifies the caller's share token (from the existing auth flow — `Authorization` header with the user's share token)
2. Checks it has edit role and Edu folder (or all-folders) scope
3. Mints a new token with `purpose: 'add-video'`, same folder and expiry as the caller's share token
4. Returns `{ token: "<add-video-token>" }`

The component builds the bookmarklet `javascript:` URL with the token baked in as a string constant. The bookmarklet sends it as `Authorization: Bearer <token>` on API calls.

Visiting `/add-video` again produces a fresh bookmarklet with a fresh token.

### API auth on `/api/add-video`

Add auth middleware to `POST /api/add-video` and `GET /api/add-video/status`:

1. Read `Authorization: Bearer <token>` header
2. `verifyShareToken(token)` — rejects expired/tampered tokens
3. Check `purpose === 'add-video'` — rejects regular share tokens
4. Check `role === 'edit'` and folder is Edu folder UUID or all-folders sentinel
5. Reject with 401 (missing/invalid token) or 403 (wrong purpose/role/folder)

CORS stays `origin: '*'` — the bookmarklet legitimately runs cross-origin from youtube.com.

### Bookmarklet JS serving

Move `public/add-video-bookmarklet.js` to `server/add-video/bookmarklet.js` (or inline it). It is no longer served as a static file — the `<AddVideoPage>` component fetches it via the existing endpoint, replaces `__LENS_SERVER_URL__` with the origin, and injects the add-video token.

The bookmarklet JS changes:
- Add `__LENS_ADD_VIDEO_TOKEN__` placeholder
- Send `Authorization: Bearer <token>` header on the `POST /api/add-video` fetch call

### generate-share-link.ts changes

Add `--purpose <share|add-video>` flag (default: `share`). The purpose is included in the `ShareTokenPayload` passed to `signShareToken()`.

### Client-side token decoding

`auth-share.ts` functions (`decodeRoleFromToken`, `isTokenExpired`, `decodeFolderFromToken`) shift byte offsets by 1 to account for the new purpose byte at position 0. Add `decodePurposeFromToken()`.

### Vite dev middleware

The `addVideoPlugin` in `vite.config.ts` gains the same auth check as the production Hono routes.

## Files changed

| File | Change |
|---|---|
| `server/share-token.ts` | Add purpose byte to pack/unpack, update PAYLOAD_LEN to 22 |
| `server/add-video/routes.ts` | Add auth middleware, add `POST /install-token` endpoint |
| `src/components/AddVideoPage/AddVideoPage.tsx` | New — React component (converted from static HTML) |
| `src/App.tsx` | Add `/add-video` route gated like `/review` |
| `src/lib/auth-share.ts` | Shift byte offsets, add `decodePurposeFromToken()` |
| `public/add-video.html` | Delete |
| `public/add-video-bookmarklet.js` | Move to `server/add-video/`, add token placeholder |
| `scripts/generate-share-link.ts` | Add `--purpose` flag |
| `vite.config.ts` | Add auth to add-video dev middleware |
| `server/share-token.test.ts` (if exists) | Update for new format |
| `src/lib/auth-share.test.ts` (if exists) | Update for new format |
