# Testing Patterns

**Analysis Date:** 2026-02-08

## Test Framework

**Runner:**
- Vitest 4.0.18
- Config: `vitest.config.ts` (TypeScript projects only)

**Assertion Library:**
- Vitest built-in expect API

**Run Commands:**
```bash
npm run test                          # Watch mode
npm run test:run                      # Run all tests once
npm run test:coverage                 # Coverage report
npm run test:integration              # Integration tests only
npm run test:integration:editor       # Editor integration tests
npm run test:integration:sidebar      # Sidebar integration tests
npm run test:integration:smoke        # Smoke integration tests
```

**Vitest Configuration** (`/home/penguin/code/lens-relay/ws3/lens-editor/vitest.config.ts`):
```typescript
export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'happy-dom',         // Lightweight DOM environment
    globals: true,                    // Global test functions (describe, it, expect)
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/lib/**', 'src/components/**/extensions/**', 'src/hooks/**'],
      exclude: ['**/*.test.ts', 'src/test/**'],
    },
  },
});
```

**Setup Files** (`/home/penguin/code/lens-relay/ws3/lens-editor/src/test/setup.ts`):
```typescript
import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

beforeEach(() => {
  vi.clearAllMocks();
});
```

## Test File Organization

**Location:**
- Co-located with source files: `relay-api.ts` → `relay-api.test.ts` (same directory)
- Integration tests next to unit tests: `relay-api.integration.test.ts`

**Naming:**
- Unit tests: `{filename}.test.ts` or `{filename}.test.tsx`
- Integration tests: `{filename}.integration.test.ts` or `{filename}.integration.test.tsx`
- 203 test files detected in `lens-editor/src/` directory

**Directory Structure:**
```
src/
├── lib/
│   ├── relay-api.ts
│   ├── relay-api.test.ts
│   ├── relay-api.integration.test.ts
│   ├── link-extractor.ts
│   ├── link-extractor.test.ts
│   ├── criticmarkup-parser.ts
│   ├── criticmarkup-parser.test.ts
│   └── ...
├── hooks/
│   ├── useFolderMetadata.ts
│   ├── useFolderMetadata.test.tsx
│   ├── useSynced.ts
│   ├── useSynced.test.tsx
│   └── ...
├── components/
│   ├── Editor/
│   │   ├── Editor.tsx
│   │   ├── Editor.integration.test.tsx
│   │   └── extensions/
│   │       ├── wikilinkParser.ts
│   │       ├── wikilinkParser.test.ts
│   │       └── ...
│   └── ...
├── test/
│   ├── setup.ts
│   ├── codemirror-helpers.ts
│   ├── MockRelayProvider.tsx
│   └── fixtures/
└── ...
```

## Test Structure

**Suite Organization:**
```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('relay-api', () => {
  let doc: Y.Doc;
  let filemeta: Y.Map<FileMetadata>;
  let legacyDocs: Y.Map<string>;

  beforeEach(() => {
    doc = new Y.Doc();
    filemeta = doc.getMap<FileMetadata>('filemeta_v0');
    legacyDocs = doc.getMap<string>('docs');
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true });
  });

  describe('createDocument', () => {
    it('creates document with valid UUID', async () => {
      const id = await createDocument(doc, '/New File.md');

      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it('adds entry to filemeta_v0 map', async () => {
      const id = await createDocument(doc, '/Test.md');
      const meta = filemeta.get('/Test.md');

      expect(meta).toBeDefined();
      expect(meta!.id).toBe(id);
      expect(meta!.type).toBe('markdown');
    });
  });
});
```

**Patterns Observed:**
- Nested `describe()` blocks for logical grouping
- `beforeEach()` for setup (mocks, Y.Doc creation, state reset)
- `afterEach()` for cleanup (mock clearing)
- Descriptive test names: `it('adds entry to filemeta_v0 map for Obsidian compatibility')`

## Mocking

**Framework:** Vitest's `vi` module for mocking, spying, and stubbing

**Network Boundary Mocking** (unit tests):
```typescript
// Mock fetch for server calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true });
});

// Override for specific test cases
it('handles 404 on missing document', async () => {
  mockFetch.mockResolvedValue({
    ok: false,
    status: 404,
    statusText: 'Not Found',
  });

  await expect(getClientToken('missing-doc')).rejects.toThrow('404');
});
```

**Y.Sweet Provider Mocking**:
```typescript
// Mock YSweetProvider and getClientToken to avoid real network
vi.mock('@y-sweet/client', () => ({
  YSweetProvider: class MockYSweetProvider {
    on(event: string, callback: () => void) {
      if (event === 'synced') {
        setTimeout(callback, 0);
      }
    }
    destroy() {}
  },
}));

vi.mock('./auth', () => ({
  getClientToken: vi.fn().mockResolvedValue({
    url: 'ws://localhost:8090',
    baseUrl: 'http://localhost:8090',
    docId: 'test-doc',
    token: 'test-token',
    authorization: 'full',
  }),
}));
```

**Hoisted Mock Classes** (advanced pattern for complex mocks):
```typescript
// Use vi.hoisted to define mock class before vi.mock hoisting
const { MockYSweetProvider, mockProviderInstances, resetMockProviders } = vi.hoisted(() => {
  const instances = [];

  class MockYSweetProviderClass {
    private listeners: Map<string, Set<(...args: unknown[]) => void>> = new Map();
    public synced = false;
    public doc: Y.Doc;

    on(event: string, handler: (...args: unknown[]) => void) {
      if (!this.listeners.has(event)) {
        this.listeners.set(event, new Set());
      }
      this.listeners.get(event)!.add(handler);
    }

    emitSynced() {
      this.synced = true;
      this.listeners.get('synced')?.forEach((h) => h());
    }

    destroy() {
      this.listeners.clear();
    }
  }

  return {
    MockYSweetProvider: MockYSweetProviderClass,
    mockProviderInstances: instances,
    resetMockProviders: () => { instances.length = 0; },
  };
});

vi.mock('@y-sweet/client', () => ({
  YSweetProvider: MockYSweetProvider,
}));
```

**What to Mock:**
- Network calls (fetch, axios)
- External library connections (YSweetProvider, auth endpoints)
- Browser APIs (window, localStorage)
- Timers (setTimeout, setInterval) with `vi.useFakeTimers()` when needed

**What NOT to Mock:**
- Y.js library itself (use real Y.Doc, Y.Map for accurate CRDT behavior)
- Test utilities and helpers
- Core framework libraries (React, unless testing a specific integration)

## Fixtures and Factories

**Test Data Pattern:**
```typescript
// Helper to create test context
function createTestContext(metadata: FolderMetadata, backlinks: Record<string, string[]>) {
  const doc = new Y.Doc();
  const backlinksMap = doc.getMap<string[]>('backlinks_v0');
  for (const [targetId, sourceIds] of Object.entries(backlinks)) {
    backlinksMap.set(targetId, sourceIds);
  }
  const folderDocs = new Map([['Test Folder', doc]]);
  return {
    metadata,
    folderDocs,
    folderNames: ['Test Folder'],
    errors: new Map(),
    onNavigate: vi.fn(),
  };
}

// Usage in test
const ctx = createTestContext(
  { '/Note.md': { id: 'uuid-1', type: 'markdown', version: 0 } },
  {}
);
```

**Mock Provider Factory:**
```typescript
interface MockProvider {
  synced: boolean;
  listeners: Map<string, Set<(...args: unknown[]) => void>>;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  off: (event: string, handler: (...args: unknown[]) => void) => void;
  emit: (event: string) => void;
}

function createMockProvider(initialSynced = false): MockProvider {
  const provider: MockProvider = {
    synced: initialSynced,
    listeners: new Map(),
    on(event: string, handler: (...args: unknown[]) => void) {
      if (!this.listeners.has(event)) {
        this.listeners.set(event, new Set());
      }
      this.listeners.get(event)!.add(handler);
    },
    off(event: string, handler: (...args: unknown[]) => void) {
      this.listeners.get(event)?.delete(handler);
    },
    emit(event: string) {
      this.listeners.get(event)?.forEach((h) => h());
    },
  };
  return provider;
}
```

**Location:**
- `src/test/MockRelayProvider.tsx` - Mock Relay provider component
- `src/test/codemirror-helpers.ts` - CodeMirror test utilities
- `src/test/setup.ts` - Global test setup
- `src/test/fixtures/` - Static test data files

## Coverage

**Requirements:** Not enforced by CI (no explicit target stated)

**View Coverage:**
```bash
npm run test:coverage
```

**Included Areas:**
- `src/lib/**` - All utilities and API layers
- `src/components/**/extensions/**` - CodeMirror extensions
- `src/hooks/**` - All React hooks

**Excluded:**
- `**/*.test.ts` - Test files themselves
- `src/test/**` - Test infrastructure

## Test Types

**Unit Tests:**
- Scope: Individual functions, hooks, components in isolation
- Approach: Mock all external dependencies (network, context, providers)
- Examples:
  - `link-extractor.test.ts` - Tests `extractWikilinks()` with various markdown inputs
  - `uuid-to-path.test.ts` - Tests path lookup utility
  - `criticmarkup-parser.test.ts` - Tests markup parsing logic
  - `useSynced.test.tsx` - Tests hook state with mock provider
  - `BacklinksPanel.test.tsx` - Component rendering with mock context

**Integration Tests:**
- Scope: Multiple components working together with actual relay-server
- Approach: No mocking of relay-server; requires running instance
- Setup: Requires `npm run relay:start` (port auto-detected from workspace: 8090/8190)
- Examples:
  - `relay-api.integration.test.ts` - Creates actual documents on relay-server
  - `Editor.integration.test.tsx` - Full editor loading flow with real sync
  - `Sidebar.integration.test.tsx` - Sidebar with real folder metadata
  - `smoke.integration.test.ts` - Basic connectivity checks
  - `backlinks-sync.integration.test.ts` - Backlink syncing end-to-end

**E2E Tests:**
- Not detected; no dedicated E2E framework (Cypress, Playwright)
- Could add playwright tests for browser-based workflows

## Common Patterns

**Async Testing:**
```typescript
// Using async/await
it('creates document with valid UUID', async () => {
  const id = await createDocument(doc, '/New File.md');
  expect(id).toMatch(/^[0-9a-f]{8}/);
});

// Using renderHook + waitFor for hook state
it('updates metadata when provider syncs', async () => {
  const { result } = renderHook(() => useFolderMetadata('test-folder'));

  await waitFor(() => {
    expect(result.current.metadata).toBeDefined();
  });
});

// Using act() for state updates
it('updates provider state', () => {
  let callback;
  mockProvider.on = vi.fn((event, cb) => {
    if (event === 'synced') callback = cb;
  });

  act(() => {
    callback?.();
  });

  expect(result.current.synced).toBe(true);
});
```

**Error Testing:**
```typescript
// Testing error throws
it('throws when fetch fails', async () => {
  mockFetch.mockResolvedValue({
    ok: false,
    status: 500,
    statusText: 'Internal Server Error',
  });

  await expect(createDocumentOnServer('doc-id')).rejects.toThrow(
    'Failed to create document: 500'
  );
});

// Testing error messages
it('includes context in error message', async () => {
  mockFetch.mockResolvedValue({
    ok: false,
    status: 404,
    statusText: 'Not Found',
  });

  try {
    await getClientToken('missing-doc');
  } catch (error) {
    expect((error as Error).message).toContain('404');
    expect((error as Error).message).toContain('Not Found');
  }
});
```

**Component Testing:**
```typescript
// Rendering with context
render(
  <NavigationContext.Provider value={ctx}>
    <BacklinksPanel currentDocId="target-uuid" />
  </NavigationContext.Provider>
);

// Checking text presence
expect(screen.getByText('Source1')).toBeInTheDocument();
expect(screen.getByText(/no backlinks/i)).toBeInTheDocument();

// User interaction
fireEvent.click(screen.getByText('Save'));

// Async state updates with waitFor
await waitFor(() => {
  expect(screen.queryByText('Loading')).not.toBeInTheDocument();
});
```

**Integration Test Pattern:**
```typescript
// Auto-detect workspace from directory name
const projectDir = path.basename(path.resolve(import.meta.dirname, '../..'));
const workspaceMatch = projectDir.match(/-ws(\d+)$/);
const wsNum = workspaceMatch ? parseInt(workspaceMatch[1], 10) : 1;
const defaultPort = 8090 + (wsNum - 1) * 100;

const SERVER_URL = process.env.RELAY_URL || `http://localhost:${defaultPort}`;
const SERVER_TOKEN = process.env.RELAY_TOKEN || '';

// Create document on server
const response = await fetch(`${SERVER_URL}/doc/new`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ docId }),
});

// Verify with real connection
const provider = new YSweetProvider(authEndpoint, docId, doc, { connect: true });
// ... wait for sync, verify data
```

## Rust Testing

**Test Location and Naming:**
- Co-located tests in same file at end: `#[cfg(test)] mod tests { ... }`
- Integration tests in `tests/` directory at crate root

**Test Macro:**
```rust
#[tokio::test]
async fn test_token_expiration_integration() {
    // Create a test authenticator with a valid 32-byte base64 key
    let mut auth = Authenticator::new("dGhpcy1pcy1leGFjdGx5LTMyLWJ5dGVzLWZvci10ZXN0")
        .expect("Failed to create authenticator");

    // Create token that expires in 1 second
    let short_expiration = ExpirationTimeEpochMillis(current_time + 1000);

    let token = auth
        .gen_doc_token_cwt(
            "test-doc",
            Authorization::Full,
            short_expiration,
            None,
            None,
        )
        .expect("Failed to generate token");

    // Verify token is valid initially
    let result = auth.verify_doc_token(&token, "test-doc", verification_time);
    assert!(result.is_ok(), "Token should be valid initially");

    // Wait for expiration
    sleep(Duration::from_millis(1100)).await;

    // Verify token is expired
    assert!(result.is_err(), "Token should be expired");
}
```

**Patterns:**
- `#[tokio::test]` for async tests
- `#[test]` for synchronous tests
- `assert!()`, `assert_eq!()` for assertions
- `.expect()` for test setup failures
- Descriptive assertion messages: `assert!(result.is_ok(), "Token should be valid initially")`

---

*Testing analysis: 2026-02-08*
