# Backlinks Feature - Testing Strategy

Companion document to `2026-02-03-backlinks-architecture.md`.

---

## Overview

Testing strategy following TDD principles: write failing tests first, implement minimal code to pass, refactor.

**Key constraints:**
- Tests must verify real behavior, not mock behavior
- Mock at the slow/external boundary (network, storage), not at direct dependencies
- Reuse existing code where possible (e.g., `document-resolver.ts`)

---

## Data Contract: `backlinks_v0` Y.Map

Both server (Rust) and client (TypeScript) must agree on this structure:

```typescript
// Y.Map<string, string[]>
// Key: target document UUID
// Value: array of source document UUIDs that link TO the target

{
  "target-doc-uuid-1": ["source-uuid-a", "source-uuid-b"],
  "target-doc-uuid-2": ["source-uuid-c"]
}
```

**Invariants:**
- Keys and values are UUIDs (not paths)
- Empty arrays may be omitted or present (both valid)
- Server is source of truth; client is read-only

---

## Test Structure

```
src/
├── lib/
│   ├── link-extractor.ts              # NEW: Pure function
│   ├── link-extractor.test.ts         # Unit tests
│   ├── document-resolver.ts           # EXISTING: Reuse for name→UUID
│   └── document-resolver.test.ts      # EXISTING: Already comprehensive
├── hooks/
│   ├── useLinkIndex.ts                # NEW: Reads backlinks_v0
│   └── useLinkIndex.test.tsx          # Tests with MockYSweetProvider
├── components/
│   └── BacklinksPanel/
│       ├── BacklinksPanel.tsx         # NEW
│       └── BacklinksPanel.test.tsx    # Component tests
└── test/
    ├── fixtures/
    │   └── documents/
    │       └── wikilinks-advanced.md  # NEW: anchors, aliases, edge cases
    └── MockRelayProvider.tsx          # EXTEND: Support backlinks_v0
```

---

## Testing Levels by Component

### 1. Link Extractor (Pure Function - Unit Tests)

**File:** `src/lib/link-extractor.ts`

**API:**
```typescript
function extractWikilinks(markdown: string): string[]
// Returns: ["Note", "Other"] - target names only, no anchors/aliases
```

**Why unit tests:** Pure function with no dependencies. Input string, output array.

**Key test categories:**
- Basic: `[[Note]]`, multiple links, no links
- Syntax variants: anchors (`#Section`), aliases (`|Display`), combined
- Edge cases: empty `[[]]`, unclosed `[[Note`
- Code contexts: inline code and fenced code blocks (should be ignored)
- Duplicates: same link twice (return both, no dedup)

**Decisions:**
- No deduplication at extraction - caller dedupes if needed
- Links inside code blocks/inline code are ignored
- Use simple regex with code-block stripping (not full markdown parser)

---

### 2. Link Resolver (Reuse Existing)

**File:** `src/lib/document-resolver.ts` (EXISTING)

The existing `resolvePageName()` function already handles name→UUID resolution with:
- Exact filename match (case-sensitive, preferred)
- Case-insensitive fallback
- Comprehensive tests in `document-resolver.test.ts`

**No new resolver needed.** The link extractor extracts names, existing resolver converts to UUIDs.

**Gap to address:** Current resolver takes `FolderMetadata` (plain object). Hooks already extract this from Y.Map, so no change needed.

---

### 3. useLinkIndex Hook (Mock YSweetProvider)

**File:** `src/hooks/useLinkIndex.ts`

**API:**
```typescript
function useLinkIndex(folderId: string): {
  getBacklinks: (docId: string) => string[];
  loading: boolean;
}
```

**Why mock provider:** Network connection is slow/external. Mock YSweetProvider, use real Y.Doc.

**Test pattern:** Follow existing `useFolderMetadata.test.tsx`.

**Key test categories:**

| Category | Tests |
|----------|-------|
| **Basic** | Returns backlinks, returns empty array, loading states |
| **Reactivity** | Updates when backlink added, updates when backlink removed |
| **Lifecycle** | Cleanup on unmount, reconnect on folderId change |
| **Errors** | Connection failure handling, missing Y.Map graceful fallback |

---

### 4. BacklinksPanel Component (Component Tests)

**File:** `src/components/BacklinksPanel/BacklinksPanel.tsx`

**Test approach:** Use MockRelayProvider with populated Y.Doc.

**Key test categories:**

| Category | Tests |
|----------|-------|
| **Rendering** | Shows backlink list, shows empty state, shows loading state |
| **UUID→Path** | Displays file names (from filemeta_v0), not raw UUIDs |
| **Interaction** | Click navigates to document |
| **Edge cases** | Handles deleted source docs (UUID in backlinks but not in filemeta) |

**Reverse lookup note:** Panel needs UUID→path mapping. This is a linear scan of `filemeta_v0` - acceptable for <1000 docs, optimize later if needed.

---

### 5. Integration Tests (Local Y-Sweet Server)

**File:** `src/lib/backlinks.integration.test.ts`

**Prerequisites:** Local Y-Sweet on port 8090 (`npx y-sweet serve --port 8090`)

**Why integration:** Validates full data flow without mocks. Catches client/server mismatches.

**Test scenarios:**
- Read backlinks from pre-populated folder doc
- Verify `useLinkIndex` returns correct data with real YSweetProvider
- Full component render with real network

**Note:** Server-side indexing (Rust) is tested separately. Integration tests validate the data contract between client and server.

---

## New Fixture Required

**File:** `src/test/fixtures/documents/wikilinks-advanced.md`

Should include: basic links, anchors (`#`), aliases (`|`), combined syntax, edge cases (empty, unclosed), code blocks (to verify ignored), duplicates, special characters.

---

## Implementation Order

Following architecture doc phases, with TDD for each:

### Phase 1: Link Extractor (Client Foundation)
1. `link-extractor.ts` + tests (pure function, easy TDD)
2. New fixture: `wikilinks-advanced.md`
3. Reuse existing `document-resolver.ts` (already tested)

### Phase 2: Backlinks Display (Client UI)
1. Extend `createDocFromFixture()` to support `backlinks_v0`
2. `useLinkIndex.ts` + tests (uses fixture data)
3. `BacklinksPanel.tsx` + tests
4. Integration tests with local Y-Sweet

**TDD note:** Phase 2 tests use manually-populated fixtures. The server populator comes in Phase 3, but client tests don't depend on it.

### Phase 3: Server-Side Indexer (relay-server)
- Tested separately in Rust codebase
- Client integration tests then validate end-to-end flow

---

## Mock Boundaries

| Component | Uses Real | Mocks |
|-----------|-----------|-------|
| link-extractor | Nothing (pure function) | Nothing |
| document-resolver | FolderMetadata object | Nothing |
| useLinkIndex | Y.Doc, Y.Map | YSweetProvider (network) |
| BacklinksPanel | useLinkIndex, filemeta | Nothing |
| Integration tests | Everything | Nothing |

**Principle:** Mock at the network boundary, not at Y.js data structures.

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Client/server data contract drift | Explicit contract documented above; integration tests |
| Mock diverges from real Y.Doc | Use real Y.Doc in unit+1 tests, mock only network |
| Code blocks not properly ignored | Dedicated fixture with code blocks |
| Server indexer bugs not caught | Rust tests (separate); client integration validates output |
