# Coding Conventions

**Analysis Date:** 2026-02-08

## Naming Patterns

**Files (TypeScript):**
- Kebab-case for feature files: `relay-api.ts`, `link-extractor.ts`, `uuid-to-path.ts`
- Kebab-case with `.test` suffix for unit tests: `relay-api.test.ts`
- Kebab-case with `.integration.test` suffix for integration tests: `relay-api.integration.test.ts`
- Components use PascalCase: `Editor.tsx`, `BacklinksPanel.tsx`, `ContextMenu.tsx`
- Hooks use camelCase with use prefix: `useFolderMetadata.ts`, `useCollaborators.ts`, `useSynced.ts`

**Files (Rust):**
- snake_case for modules and functions: `filesystem.rs`, `generate_public_key_from_private()`
- PascalCase for types and structs: `AllowedHost`, `FileMetadata`, `SignInput`

**Functions (TypeScript):**
- camelCase: `extractWikilinks()`, `createDocument()`, `deleteDocument()`
- Async functions use same camelCase pattern: `createDocumentOnServer()`, `initializeContentDocument()`
- Helper/internal functions prefixed with underscore if truly private: none observed in codebase, prefer regular camelCase

**Variables (TypeScript):**
- camelCase: `mockFetch`, `filemeta`, `legacyDocs`, `mockProvider`, `testContext`
- Constants: UPPERCASE_SNAKE_CASE for module-level constants: `RELAY_ID`, `API_BASE`, `LENS_EDITOR_ORIGIN`
- Boolean prefixes: `is`, `has`, `can`: `synced`, `loading`, `error` (no prefix, obvious from context)

**Types (TypeScript):**
- Interfaces: PascalCase with type imports: `type FileMetadata`, `type FolderMetadata`, `interface MockProvider`
- Type assertions: Prefer `as` keyword for explicit casting: `filemeta.get('/Test.md')!` uses non-null assertion

**Functions (Rust):**
- snake_case: `validate_file_token()`, `current_time_epoch_millis()`, `load_webhook_configs()`
- Async functions same pattern: `sign_stdin()`, `verify_stdin()`

**Types (Rust):**
- PascalCase structs: `AllowedHost`, `SignInput`, `SignOutput`
- serde rename for API/JSON consistency:
  ```rust
  #[serde(rename = "docId")]
  doc_id: Option<String>,
  ```

## Code Style

**Formatting (TypeScript):**
- Tool: Prettier
- Configuration (`/home/penguin/code/lens-relay/ws3/debugger/.prettierrc`):
  - `singleQuote: true`
  - `trailingComma: "all"`
  - `printWidth: 100`
  - `semi: false` (no semicolons)

**Linting (TypeScript):**
- Tool: ESLint with TypeScript support
- Config: `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`
- Extends: `next/core-web-vitals`

**Formatting (Rust):**
- Tool: rustfmt (standard Rust formatter)
- Release profile optimizes for size: `opt-level = 'z'`, `lto = true`

## Import Organization

**TypeScript Pattern:**
```typescript
// 1. React/framework imports
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState, useEffect, useCallback, useRef } from 'react';

// 2. Third-party library imports
import * as Y from 'yjs';
import { YSweetProvider } from '@y-sweet/client';
import path from 'path';

// 3. Type imports
import type { FileMetadata } from '../hooks/useFolderMetadata';
import type { FolderMetadata } from '../../hooks/useFolderMetadata';

// 4. Local imports
import { createDocument, deleteDocument } from './relay-api';
import { getClientToken } from './auth';
```

**No path aliases detected** - uses relative paths throughout: `../`, `../../`

**Rust Pattern:**
```rust
use anyhow::{anyhow, Result};
use axum::extract::{Path, Query, State};
use std::sync::Arc;
use y_sweet_core::api_types::*;
use crate::stores::filesystem::FileSystemStore;
```

## Error Handling

**TypeScript Pattern:**
```typescript
// Throw with descriptive messages
throw new Error(`Failed to create document: ${response.status} ${response.statusText}`);

// Promise rejection in async functions
try {
  const result = await createDocumentOnServer(docId);
} catch (error) {
  throw new Error(`Failed to create document on server: ${error.message}`);
}

// Optional chaining and null coalescing common
const meta = filemeta.get('/Test.md');
expect(meta!.id).toBe(id);  // Non-null assertion after guard

// Network boundaries wrapped in try/catch
const response = await fetch(`${API_BASE}/doc/new`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ docId }),
});

if (!response.ok) {
  throw new Error(`Failed to create document on server: ${response.status}`);
}
```

**Rust Pattern:**
```rust
// Result types with anyhow
fn validate_file_token(
    server_state: &Arc<Server>,
    token: &str,
    doc_id: &str,
) -> Result<Permission, AppError> {
    let authenticator = server_state.authenticator.as_ref().ok_or_else(|| {
        AppError(
            StatusCode::INTERNAL_SERVER_ERROR,
            anyhow!("No authenticator configured"),
        )
    })?;

    // map_err for context preservation
    sync_kv
        .push_update(DOC_NAME, doc_as_update)
        .map_err(|_| anyhow::anyhow!("Failed to push update"))?;
}

// Custom error types via anyhow::anyhow!
anyhow::anyhow!("Failed to create document: invalid doc ID")
```

## Logging

**Framework:** `console` for TypeScript; `tracing` crate for Rust

**TypeScript Pattern:**
```typescript
// Debug helper function pattern
function debug(operation: string, ...args: unknown[]) {
  console.log(`[relay-api] ${operation}:`, ...args);
}

// Usage
debug('initializeContentDocument', 'connecting to content doc...', { fullDocId });
debug('initializeContentDocument', 'synced, adding initial content...');

// Direct console.log in hooks
console.log('[DEBUG] Y.Doc created and exposed as window.__folderDoc');
```

**Rust Pattern:**
```rust
use tracing::{span, Instrument, Level};

// Tracing with instrumentation
let span = span!(Level::DEBUG, "sync_operation");
async fn sync_doc() -> Result<()> {
    // Code inside span
}
```

## Comments

**When to Comment:**
- Document complex algorithms: See `stripCode()` in `link-extractor.ts` explaining regex logic
- Explain non-obvious behavior: "Obsidian's SyncStore.getMeta() requires documents to exist in BOTH filemeta_v0 AND the legacy 'docs' Y.Map"
- Network boundaries and mocking: "Mock fetch for server calls"
- Important constraints: "This must be called BEFORE adding to filemeta, otherwise the document won't be accessible"

**JSDoc/TSDoc Pattern:**
```typescript
/**
 * Create a document on the Relay server.
 * This must be called BEFORE adding to filemeta, otherwise the document
 * won't be accessible (auth endpoint returns 404 for non-existent docs).
 */
async function createDocumentOnServer(docId: string): Promise<void> {

/**
 * Extract wikilink targets from markdown text.
 * Returns the page names only (strips anchors and aliases).
 * Ignores links inside code blocks and inline code.
 */
export function extractWikilinks(markdown: string): string[] {
```

**Rust Doc Comments:**
```rust
/// Convert a Yjs document (encoded as a v1 update) to a .ysweet store.
pub async fn convert(store: Box<dyn Store>, doc_as_update: &[u8], doc_id: &str) -> Result<()> {
```

## Function Design

**Size:** Functions should be cohesive, typically under 50 lines for complex logic; 100+ lines for very involved operations like full server loops

**Parameters:**
- Keep under 5 parameters; use structs/objects for complex configurations
- TypeScript: Use destructuring and optional fields
- Rust: Use builder pattern for complex initialization

**Return Values:**
- TypeScript: Explicit Promise return types for async: `Promise<void>`, `Promise<FileMetadata>`, `Promise<string[]>`
- Rust: Use Result<T> or Option<T> for fallible operations

**Async Patterns:**
- Use Promise callbacks for event handling: `provider.on('synced', () => { ... })`
- Use async/await for sequential operations
- Use renderHook + waitFor for async state updates in tests

## Module Design

**Exports:**
- Each file exports one primary function/class: `export function extractWikilinks()`, `export class MockYSweetProvider`
- Helper functions kept internal unless widely reused
- Type exports explicit: `export type FileMetadata = Record<string, FileMetadataEntry>`

**Barrel Files:**
- `/home/penguin/code/lens-relay/ws3/lens-editor/src/hooks/index.ts` exports all hooks for convenience imports
- Path-based organization clear from file locations

**Module boundaries:**
- `/lib/` - utility functions and helpers
- `/hooks/` - React hooks
- `/components/` - React components
- `/contexts/` - Context providers and consumers
- `/test/` - test utilities and fixtures
- `crates/relay/src/` - Rust server code
- `crates/y-sweet-core/src/` - CRDT auth logic

---

*Convention analysis: 2026-02-08*
