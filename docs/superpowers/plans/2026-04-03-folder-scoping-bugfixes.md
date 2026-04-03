# Folder-Scoping Bugfixes Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three bugs discovered during manual testing of folder-scoped share tokens.

**Failing tests already committed:** `surpukup` — tests for all three bugs exist and fail for the right reasons.

**Spec:** `docs/superpowers/specs/2026-04-03-folder-scoped-tokens-design.md`

---

### Bug 1: Accept/reject buttons visible to non-edit users

**Root cause:** `criticMarkupExtension()` takes no options and always renders `AcceptRejectWidget` / `BulkAcceptRejectWidget`. No role check gates the buttons.

**Failing test:** `src/components/Editor/extensions/criticmarkup-roles.test.ts` — expects `canAcceptReject=false` to suppress buttons.

**Files:**
- Modify: `lens-editor/src/components/Editor/extensions/criticmarkup.ts`
- Modify: `lens-editor/src/components/Editor/Editor.tsx`
- Modify: `lens-editor/src/components/Layout/EditorArea.tsx`

- [ ] **Step 1: Add `canAcceptReject` Facet to criticmarkup extension**

In `criticmarkup.ts`, add a Facet near the top (after imports):

```typescript
import { Facet } from '@codemirror/state';

/** Facet controlling whether accept/reject buttons are shown. Defaults to true. */
export const canAcceptRejectFacet = Facet.define<boolean, boolean>({
  combine: (values) => values.length > 0 ? values[0] : true,
});
```

- [ ] **Step 2: Check the facet in the decoration builder**

In the `criticMarkupPlugin` ViewPlugin's `buildDecorations` method, find where `AcceptRejectWidget` and `BulkAcceptRejectWidget` are created. Before creating them, check the facet:

```typescript
const canAcceptReject = view.state.facet(canAcceptRejectFacet);
```

Wrap the widget creation in `if (canAcceptReject)` — if false, skip creating the accept/reject button decorations entirely. The CriticMarkup highlighting (colors, strikethrough) should still render.

Also gate the keyboard shortcuts (`Ctrl+Enter` for accept, `Ctrl+Backspace` for reject) — in the `criticMarkupKeymap`, check the facet before executing.

- [ ] **Step 3: Update `criticMarkupExtension()` to accept options**

```typescript
interface CriticMarkupOptions {
  canAcceptReject?: boolean;
}

export function criticMarkupExtension(options: CriticMarkupOptions = {}) {
  const { canAcceptReject = true } = options;
  return [
    canAcceptRejectFacet.of(canAcceptReject),
    criticMarkupField,
    suggestionModeField,
    focusedThreadField,
    suggestionModeFilter,
    criticMarkupCompartment.of(criticMarkupPlugin),
    keymap.of(criticMarkupKeymap),
  ];
}
```

- [ ] **Step 4: Pass `canEdit` from EditorArea to Editor**

In `EditorArea.tsx`, the component already calls `useAuth()` and has `canWrite`. Add:

```typescript
const { canWrite, canEdit } = useAuth();
```

Pass `canEdit` to Editor as a new prop (e.g., `canAcceptReject={canEdit}`).

In `Editor.tsx`, accept the new prop and pass it to `criticMarkupExtension`:

```typescript
criticMarkupExtension({ canAcceptReject }),
```

Add `canAcceptReject` to the `useEffect` dependency array for the editor state creation.

- [ ] **Step 5: Run the failing test**

Run: `cd lens-editor && npx vitest run src/components/Editor/extensions/criticmarkup-roles.test.ts`

Expected: BOTH tests pass.

- [ ] **Step 6: Commit**

```bash
jj describe -m "fix: hide accept/reject buttons for non-edit roles via canAcceptReject facet"
jj new
```

---

### Bug 2: Empty file tree for folder-scoped tokens

**Root cause:** When `useMultiFolderMetadata` connects to the folder doc (ID: `relay_id-folder_uuid`), it calls `getClientToken(folderDocId)` which hits `POST /api/auth/token`. The auth middleware calls `GET /doc/:doc_id/folder` on the relay — but the folder doc itself is NOT a content doc, so the relay returns 404. The middleware then throws 403.

**Failing test:** `server/auth-middleware.test.ts` — `should allow access to folder doc itself with matching folder-scoped token`

**Files:**
- Modify: `lens-editor/server/auth-middleware.ts`

- [ ] **Step 1: Add folder doc detection to auth middleware**

In `auth-middleware.ts`, after the folder lookup fails (the `if (!folderRes.ok)` block), check if the requested doc ID ends with the token's folder UUID. If so, this IS the folder doc and access should be allowed:

```typescript
if (!folderRes.ok) {
  // Check if this is the folder doc itself (format: relay_id-folder_uuid)
  // Folder docs aren't content docs, so folder lookup returns 404,
  // but a token scoped to this folder should be able to access its own folder doc.
  if (docId.endsWith('-' + payload.folder)) {
    // This is the folder doc for the token's authorized folder — allow access
  } else {
    throw new AuthError(403, 'Access denied: document not found');
  }
}
```

The key insight: the folder doc ID format is `relay_id-folder_uuid`, and the token's folder field is the `folder_uuid`. If the docId ends with `-folder_uuid`, it's the token's own folder doc.

- [ ] **Step 2: Run the failing test**

Run: `cd lens-editor && npx vitest run server/auth-middleware.test.ts`

Expected: ALL 12 tests pass.

- [ ] **Step 3: Commit**

```bash
jj describe -m "fix: allow folder-scoped tokens to access their own folder doc"
jj new
```

---

### Bug 3: Folder 2 token stuck on loading (wrong default doc)

**Root cause:** Two issues:
1. `DEFAULT_DOC_UUID` is hardcoded to `c0000001` (a folder 1 doc). Folder 2 tokens redirect to it, get 403.
2. The auth error callback in `auth.ts` only fires on 401, not 403. So the 403 results in an infinite "Loading document..." spinner.

**Files:**
- Modify: `lens-editor/src/App.tsx`
- Modify: `lens-editor/src/lib/auth.ts`

- [ ] **Step 1: Handle 403 in auth error callback**

In `lens-editor/src/lib/auth.ts`, update the error handling in `getClientToken()`:

```typescript
if (!response.ok) {
  if ((response.status === 401 || response.status === 403) && !_authErrorFired && _onAuthError) {
    _authErrorFired = true;
    _onAuthError();
  }
  const text = await response.text().catch(() => '');
  throw new Error(`Share token auth failed: ${response.status} ${text}`);
}
```

This ensures 403 (folder access denied) triggers the same error state as 401 (invalid token), showing the user an error page instead of infinite loading.

- [ ] **Step 2: Pick default doc from accessible folders**

In `lens-editor/src/App.tsx`, the root route currently does:

```tsx
<Route path="/" element={<Navigate to={`/${DEFAULT_DOC_UUID}`} replace />} />
```

Replace with a component that picks the first doc from accessible metadata:

```tsx
function DefaultRedirect() {
  const { metadata } = useNavigation();
  const navigate = useNavigate();

  useEffect(() => {
    // Wait for metadata to load, then navigate to first available doc
    const docIds = Object.values(metadata).map(m => m.id);
    if (docIds.length > 0) {
      navigate(`/${docIds[0].slice(0, 8)}`, { replace: true });
    }
  }, [metadata, navigate]);

  // While waiting for metadata, check if hardcoded default might work
  // (it will for all-folders tokens)
  return <Navigate to={`/${DEFAULT_DOC_UUID}`} replace />;
}
```

Actually, a simpler approach: the `DefaultRedirect` should wait for metadata and then redirect. If the hardcoded default is in the accessible folders, use it. Otherwise use the first available doc.

```tsx
function DefaultRedirect() {
  const { metadata } = useNavigation();

  // If metadata has loaded and the default doc is available, use it
  const defaultCompoundId = `${RELAY_ID}-${DEFAULT_DOC_UUID}`;
  const defaultInMetadata = Object.values(metadata).some(
    m => m.id.startsWith(DEFAULT_DOC_UUID)
  );

  if (defaultInMetadata || Object.keys(metadata).length === 0) {
    // Either default is accessible, or metadata hasn't loaded yet (optimistic)
    return <Navigate to={`/${DEFAULT_DOC_UUID}`} replace />;
  }

  // Default not accessible — pick first available doc
  const firstDoc = Object.values(metadata)[0];
  if (firstDoc) {
    return <Navigate to={`/${firstDoc.id.slice(0, 8)}`} replace />;
  }

  // No docs at all
  return <Navigate to={`/${DEFAULT_DOC_UUID}`} replace />;
}
```

Replace the route:
```tsx
<Route path="/" element={<DefaultRedirect />} />
```

Note: `DefaultRedirect` must be inside `NavigationContext.Provider` (it already is — Routes are inside the provider).

- [ ] **Step 3: Build to verify compilation**

Run: `cd lens-editor && npx tsc --noEmit`

Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
jj describe -m "fix: handle 403 in auth error callback and pick default doc from accessible folders"
jj new
```

---

### Manual Testing with Chrome DevTools MCP

After all three fixes are implemented:

- [ ] **Step 1: Restart Vite dev server**

Kill and restart: `lsof -ti:5173 | xargs kill && cd lens-editor && VITE_LOCAL_RELAY=true npm run dev`

- [ ] **Step 2: Test folder 1 suggest token**

Use Chrome DevTools MCP to:
1. Navigate to the folder 1 suggest URL
2. Verify file tree shows only Relay Folder 1 files
3. Open a document containing CriticMarkup suggestions
4. Verify accept/reject buttons are NOT visible
5. Verify the "Suggesting" badge is shown (not "Editing" toggle)

- [ ] **Step 3: Test folder 2 view token**

1. Navigate to the folder 2 view URL
2. Verify file tree shows only Relay Folder 2 files
3. Verify default doc opens (should be first doc from folder 2, not stuck loading)
4. Verify "Read-Only" badge is shown
5. Verify no accept/reject buttons visible

- [ ] **Step 4: Test all-folders edit token**

1. Navigate to the all-folders edit URL
2. Verify both folders appear in file tree
3. Verify accept/reject buttons ARE visible on CriticMarkup
4. Navigate to `/review` — should load (edit + all-folders)

- [ ] **Step 5: Test folder 1 edit token with cross-folder doc**

1. Navigate to folder 1 edit URL
2. Verify file tree shows only folder 1
3. Manually change URL to a folder 2 doc UUID
4. Verify error state (not infinite loading)
