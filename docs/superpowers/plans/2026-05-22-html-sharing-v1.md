# HTML Sharing in Lens v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add support for `.html` files as Y.Text-backed collaborative documents in Lens, with a three-mode editor (source / preview / split) and a sandboxed iframe preview that executes user JS.

**Architecture:** `.html` files reuse the existing Markdown content shape (`Y.Text('contents')` in a content Y.Doc, `type: "file"` entry in folder `filemeta_v0`, no hash). The MCP `create_doc` tool routes `.html` paths through the server's existing `create_document_direct` (which already sets `type: "file"` for non-`.md`). The link indexer skips `.html` to avoid false wikilink hits. Lens routes `.html` paths to a new `HtmlEditor` component with a three-mode toggle: a CodeMirror source pane (with `@codemirror/lang-html` and yCollab) and an iframe preview (`sandbox="allow-scripts"`, srcdoc debounced 300ms). No comments, no postMessage bridge in v1.

**Tech Stack:** Rust (relay, y-sweet-core), TypeScript + React 19 (lens-editor), CodeMirror 6, Yjs / `y-codemirror.next`, `@y-sweet/react`, Vitest + happy-dom + Testing Library.

**Spec:** `docs/superpowers/specs/2026-05-22-html-sharing-v1-design.md`

---

## Repository quirks the implementer needs to know

- **Non-colocated jj repo.** Use `jj commit -m "..."` at the end of each task. Edits are auto-tracked in the working copy. Do not run `git` commands. Run `jj st` before and after each task.
- **Shared Cargo target.** Always prefix Rust commands with `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target` (or set in shell) — the workspace shares a single build cache. Manifest path: `crates/Cargo.toml`.
- **Tests:**
  - Rust: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path crates/Cargo.toml -p relay <filter>` (or `-p y-sweet-core` for core crate).
  - Lens editor: `cd lens-editor && npm run test:run -- <filter>` for one-shot vitest. `npm run test` is watch mode. Integration tests under `*integration*` require a local relay server.
- **CodeMirror is heavy in happy-dom.** Some tests render real `EditorView` instances and that works; if a test gets flaky, use `cleanup()` in `afterEach` and avoid asserting on layout-dependent things.
- **No backwards-compatibility shims.** Per project conventions, do not introduce dead-code re-exports or `// TODO remove later` comments. Make the change directly.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `crates/relay/src/mcp/tools/create_doc.rs` | Modify: route `.html` through `create_document_direct` (instead of rejecting); update error message; add tests |
| `crates/y-sweet-core/src/link_indexer.rs` | Modify: skip `.html` files in `index_document`; add test |
| `lens-editor/package.json` | Modify: add `@codemirror/lang-html` dependency |
| `lens-editor/src/lib/relay-api.ts` | Modify: extend `createDocument` to accept `'file'` type; skip legacy `docs` map for non-markdown |
| `lens-editor/src/lib/editor-selector.ts` | Create: pure function picking which editor component to render given a path + filemeta entry |
| `lens-editor/src/lib/editor-selector.test.ts` | Create: tests for editor-selector |
| `lens-editor/src/components/HtmlEditor/HtmlPreview.tsx` | Create: sandboxed iframe with debounced srcdoc from a Y.Text |
| `lens-editor/src/components/HtmlEditor/HtmlPreview.test.tsx` | Create: tests for HtmlPreview |
| `lens-editor/src/components/HtmlEditor/HtmlSourceEditor.tsx` | Create: CodeMirror + `lang-html` + yCollab bound to `Y.Text('contents')` |
| `lens-editor/src/components/HtmlEditor/HtmlSourceEditor.test.tsx` | Create: tests for HtmlSourceEditor |
| `lens-editor/src/components/HtmlEditor/HtmlEditor.tsx` | Create: three-mode toggle (source/preview/split) + layout |
| `lens-editor/src/components/HtmlEditor/HtmlEditor.test.tsx` | Create: tests for HtmlEditor mode switching + default |
| `lens-editor/src/components/HtmlEditor/index.ts` | Create: barrel export |
| `lens-editor/src/App.tsx` | Modify: use `editor-selector` to dispatch `.html` paths to `HtmlEditor` |
| `lens-editor/src/components/Sidebar/CreateMenu.tsx` | Modify: add "New HTML File" option |
| `lens-editor/src/components/Sidebar/Sidebar.tsx` | Modify: wire `handleInstantCreateHtml`; fix rename to preserve any existing extension |
| `lens-editor/src/components/Sidebar/Sidebar.test.tsx` (if exists, else inline-utility test) | Modify or create: tests for rename extension-preservation |

---

## Phase A — Server (Rust)

### Task 1: MCP `create_doc` accepts `.html` paths

`.html` should route through `Server::create_document_direct` (server.rs:1232), which already writes raw content to `Y.Text('contents')` and sets `type: "file"` for non-`.md` paths. The current MCP path only accepts `.md` through `create_document` (which wraps content in CriticMarkup — wrong for HTML) and `.json` through `create_blob_file`.

**Files:**
- Modify: `crates/relay/src/mcp/tools/create_doc.rs` (whole function + tests module)

- [ ] **Step 1: Read the current implementation**

Open `crates/relay/src/mcp/tools/create_doc.rs` and confirm its current structure:
- `blob::is_blob_file(file_path)` → `create_blob_file` path
- `.md` → `create_document` path (CriticMarkup-wrapped)
- Anything else → error

- [ ] **Step 2: Write the failing test**

Append to the `#[cfg(test)] mod tests` block at the bottom of `crates/relay/src/mcp/tools/create_doc.rs`:

```rust
    #[tokio::test]
    async fn create_html_uses_direct_path() {
        let server = build_blob_test_server_with_folder().await;
        let result = execute(
            &server,
            &json!({
                "file_path": "Lens/page.html",
                "content": "<h1>Hello</h1>",
            }),
        )
        .await;
        assert!(result.is_ok(), "HTML create should succeed: {:?}", result.err());
        assert!(result.unwrap().contains("Created Lens/page.html"));

        // Resolves to a doc with no hash (Y.Text-backed, not a blob)
        let info = server
            .doc_resolver()
            .resolve_path("Lens/page.html")
            .expect("path should resolve");
        assert!(info.hash.is_none(), "HTML files must not have a blob hash");

        // Content stored in Y.Text('contents') WITHOUT CriticMarkup wrapping
        let docs = server.docs();
        let doc_ref = docs.get(&info.doc_id).expect("content doc loaded");
        let awareness = doc_ref.awareness();
        let guard = awareness.read().unwrap();
        let txn = guard.doc.transact();
        let text = txn.get_text("contents").expect("contents text exists");
        let value = text.get_string(&txn);
        assert_eq!(value, "<h1>Hello</h1>", "content should be raw HTML, no CriticMarkup");
    }

    #[tokio::test]
    async fn create_unsupported_extension_rejected() {
        let server = build_blob_test_server_with_folder().await;
        let result = execute(
            &server,
            &json!({
                "file_path": "Lens/page.xyz",
                "content": "ignored",
            }),
        )
        .await;
        assert!(result.is_err(), "Unsupported extension should be rejected");
        let err = result.unwrap_err();
        assert!(err.contains(".html"), "Error message should list .html as supported, got: {}", err);
        assert!(err.contains(".md"),   "Error message should list .md as supported, got: {}", err);
    }
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target \
  cargo test --manifest-path crates/Cargo.toml -p relay \
  mcp::tools::create_doc::tests::create_html_uses_direct_path \
  mcp::tools::create_doc::tests::create_unsupported_extension_rejected
```

Expected: both FAIL. `create_html_uses_direct_path` fails because the function returns an error like `"file_path must end with '.md' or '.json'"`. `create_unsupported_extension_rejected` fails because the current error message doesn't mention `.html`.

- [ ] **Step 4: Add the `.html` branch**

In `crates/relay/src/mcp/tools/create_doc.rs`, replace the body of `execute` to look like:

```rust
pub async fn execute(server: &Arc<Server>, arguments: &Value) -> Result<String, String> {
    let file_path = arguments
        .get("file_path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter: file_path".to_string())?;

    let content = arguments
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    // Blob files (.json) — different storage path
    if blob::is_blob_file(file_path) {
        return create_blob_file(server, file_path, content).await;
    }

    // HTML files — Y.Text-backed, raw content, no CriticMarkup
    if file_path.ends_with(".html") {
        return create_html_file(server, file_path, content).await;
    }

    // --- Markdown path (existing behavior) ---
    super::critic_markup::reject_if_contains_markup(content, "content")?;

    if !file_path.ends_with(".md") {
        return Err("file_path must end with one of: .md, .html, .json".to_string());
    }

    let md_content = if content.is_empty() { "_" } else { content };

    let slash_pos = file_path
        .find('/')
        .ok_or_else(|| "file_path must include a folder name (e.g. 'Lens/Doc.md')".to_string())?;

    let folder_name = &file_path[..slash_pos];
    let in_folder_path = format!("/{}", &file_path[slash_pos + 1..]);

    let _result = server
        .create_document(folder_name, &in_folder_path, md_content)
        .await
        .map_err(|e| e.to_string())?;

    Ok(format!("Created {}", file_path))
}

async fn create_html_file(
    server: &Arc<Server>,
    file_path: &str,
    content: &str,
) -> Result<String, String> {
    let slash_pos = file_path
        .find('/')
        .ok_or_else(|| "file_path must include a folder name (e.g. 'Lens/page.html')".to_string())?;
    let folder_name = &file_path[..slash_pos];
    let in_folder_path = format!("/{}", &file_path[slash_pos + 1..]);

    server
        .create_document_direct(folder_name, &in_folder_path, content)
        .await
        .map_err(|e| e.to_string())?;

    Ok(format!("Created {}", file_path))
}
```

Leave `create_blob_file` (already present below) unchanged.

- [ ] **Step 5: Run tests to verify they pass**

```bash
CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target \
  cargo test --manifest-path crates/Cargo.toml -p relay \
  mcp::tools::create_doc
```

Expected: all `create_doc::tests::*` pass, including the existing `create_json_*` and `create_md_*` tests.

- [ ] **Step 6: Commit**

```bash
jj st  # confirm only create_doc.rs changed
jj commit -m "Accept .html paths in MCP create_doc tool"
```

---

### Task 2: `link_indexer` skips `.html` files

`index_document` (line 1552) walks every loaded content doc and extracts wikilinks from its `Y.Text('contents')`. For `.html`, this would produce false-positive matches inside attributes, scripts, or styles. Skip `.html` files before doing any work.

We look up the file's path from any folder's `filemeta_v0` using the existing `find_path_for_uuid` helper.

**Files:**
- Modify: `crates/y-sweet-core/src/link_indexer.rs` (the `index_document` method, near line 1552)

- [ ] **Step 1: Read the current `index_document`**

Confirm signature at line 1552: `pub(crate) fn index_document(&self, doc_id: &str, docs: &DashMap<String, DocWithSyncKv>, folder_doc_ids: &[String]) -> anyhow::Result<()>`.

- [ ] **Step 2: Write the failing test**

Append to the `#[cfg(test)] mod tests` block at the bottom of `crates/y-sweet-core/src/link_indexer.rs` (find it; there is an existing module with helpers — the existing test `index_document_with_dashmap_and_awareness` at line 4686 is a good reference for shape):

```rust
    #[tokio::test]
    async fn index_document_skips_html_files() {
        use dashmap::DashMap;
        use yrs::{Map, Text, Transact, Any};
        use crate::doc_sync::DocWithSyncKv;
        use std::collections::HashMap;

        let docs: DashMap<String, DocWithSyncKv> = DashMap::new();

        let folder_doc_id = "relay-folder".to_string();
        let html_doc_id = "relay-htmluuid".to_string();
        let html_uuid = "htmluuid";

        // Folder doc with a single .html file in filemeta_v0
        let folder = DocWithSyncKv::new(&folder_doc_id, None, || (), None)
            .await
            .unwrap();
        {
            let awareness = folder.awareness();
            let mut guard = awareness.write().unwrap();
            let mut txn = guard.doc.transact_mut();
            let config = txn.get_or_insert_map("folder_config");
            config.insert(&mut txn, "name", Any::String("Lens".into()));
            let filemeta = txn.get_or_insert_map("filemeta_v0");
            let mut root = HashMap::new();
            root.insert("type".to_string(), Any::String("folder".into()));
            filemeta.insert(&mut txn, "/", Any::Map(root.into()));
            let mut entry = HashMap::new();
            entry.insert("id".to_string(), Any::String(html_uuid.into()));
            entry.insert("type".to_string(), Any::String("file".into()));
            entry.insert("version".to_string(), Any::Number(0.0));
            filemeta.insert(&mut txn, "/page.html", Any::Map(entry.into()));
        }
        docs.insert(folder_doc_id.clone(), folder);

        // Content doc with text that LOOKS like wikilinks
        let html = DocWithSyncKv::new(&html_doc_id, None, || (), None)
            .await
            .unwrap();
        {
            let awareness = html.awareness();
            let mut guard = awareness.write().unwrap();
            let mut txn = guard.doc.transact_mut();
            let text = txn.get_or_insert_text("contents");
            text.insert(&mut txn, 0, "<a href=\"[[Other Page]]\">Link</a>");
        }
        docs.insert(html_doc_id.clone(), html);

        let (indexer, _rx) = LinkIndexer::new();
        let folder_doc_ids = vec![folder_doc_id.clone()];

        // Should be a no-op for .html
        let result = indexer.index_document(&html_doc_id, &docs, &folder_doc_ids);
        assert!(result.is_ok(), "indexing .html should not error: {:?}", result.err());

        // No backlinks should have been written for the .html doc
        let doc_ref = docs.get(&folder_doc_id).unwrap();
        let awareness = doc_ref.awareness();
        let guard = awareness.read().unwrap();
        let txn = guard.doc.transact();
        if let Some(backlinks) = txn.get_map("backlinks_v0") {
            assert!(
                backlinks.get(&txn, html_uuid).is_none(),
                "backlinks_v0 must have no entry for .html files"
            );
        }
    }
```

(Use the existing reference test `index_document_with_dashmap_and_awareness` at line 4686 to confirm the exact imports and `LinkIndexer::new()` shape if anything in the snippet above does not match local types.)

- [ ] **Step 3: Run test to verify it fails**

```bash
CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target \
  cargo test --manifest-path crates/Cargo.toml -p y-sweet-core \
  link_indexer::tests::index_document_skips_html_files
```

Expected: FAIL — without the skip, `index_document` will extract `[[Other Page]]` from the HTML text and try to write a backlink.

- [ ] **Step 4: Add the skip at the top of `index_document`**

In `crates/y-sweet-core/src/link_indexer.rs`, modify `index_document` (around line 1552) so the body starts with an extension check:

```rust
    pub(crate) fn index_document(
        &self,
        doc_id: &str,
        docs: &DashMap<String, DocWithSyncKv>,
        folder_doc_ids: &[String],
    ) -> anyhow::Result<()> {
        let (_relay_id, doc_uuid) = parse_doc_id(doc_id)
            .ok_or_else(|| anyhow::anyhow!("Invalid doc_id format: {}", doc_id))?;

        if folder_doc_ids.is_empty() {
            return Err(anyhow::anyhow!("No folder docs found for indexing"));
        }

        // Skip non-Markdown files. We currently support wikilink extraction only
        // from .md content. Probing the path requires a short folder lock per
        // folder until we find the entry.
        for fid in folder_doc_ids {
            let awareness = match docs.get(fid) {
                Some(r) => r.awareness(),
                None => continue,
            };
            let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
            let txn = guard.doc.transact();
            if let Some(filemeta) = txn.get_map("filemeta_v0") {
                if let Some(path) = find_path_for_uuid(&filemeta, &txn, doc_uuid) {
                    if path.ends_with(".html") {
                        return Ok(());
                    }
                    break;  // path found and is not html; proceed
                }
            }
        }

        // ... rest of existing function unchanged ...
```

- [ ] **Step 5: Run test to verify it passes**

```bash
CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target \
  cargo test --manifest-path crates/Cargo.toml -p y-sweet-core \
  link_indexer::tests
```

Expected: the new test passes, all existing link_indexer tests still pass.

- [ ] **Step 6: Commit**

```bash
jj st
jj commit -m "Skip .html files in link indexer to avoid false wikilink hits"
```

---

## Phase B — Editor data layer (TypeScript)

### Task 3: Add `@codemirror/lang-html` dependency

The lens-editor has `@codemirror/lang-markdown` and `@codemirror/lang-json` already; we need the HTML language extension for the source pane.

**Files:**
- Modify: `lens-editor/package.json`
- Modify: `lens-editor/package-lock.json` (generated by `npm install`)

- [ ] **Step 1: Install the package**

```bash
cd lens-editor && npm install --save @codemirror/lang-html
```

This both adds the dependency to `package.json` and updates `package-lock.json`.

- [ ] **Step 2: Verify the install**

```bash
cd lens-editor && node -e "console.log(require('@codemirror/lang-html').html().language.name)"
```

Expected output: `html`

- [ ] **Step 3: Verify nothing else broke**

```bash
cd lens-editor && npm run test:run -- --reporter=basic 2>&1 | tail -20
```

Expected: no test failures attributable to the new dependency (pre-existing failures are out of scope).

- [ ] **Step 4: Commit**

```bash
jj st
jj commit -m "Add @codemirror/lang-html dependency"
```

---

### Task 4: Extend `createDocument` helper to support `'file'` type

The editor-side `createDocument` (`lens-editor/src/lib/relay-api.ts:165`) currently accepts `type: 'markdown' | 'canvas'` and always writes a legacy `docs` Y.Map entry (for Obsidian compatibility with `.md`). For HTML we need `type: 'file'` and we must NOT write to the legacy `docs` map.

**Files:**
- Modify: `lens-editor/src/lib/relay-api.ts` around the `createDocument` function
- Create: `lens-editor/src/lib/relay-api.createDocument.test.ts` (new — colocated unit test)

- [ ] **Step 1: Write the failing test**

Create `lens-editor/src/lib/relay-api.createDocument.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Y from 'yjs';

// Stub the network bits so we can focus on the filemeta logic.
vi.mock('./relay-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./relay-api')>();
  return {
    ...actual,
    // The pieces we don't want to actually run during the test.
    // We replace them below per-test via spyOn for clarity.
  };
});

import * as relayApi from './relay-api';

describe('createDocument', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Stub network/server-touching helpers so the test stays hermetic.
    vi.spyOn(relayApi as any, 'createDocumentOnServer').mockResolvedValue(undefined);
    vi.spyOn(relayApi as any, 'waitForDocumentAccess').mockResolvedValue(undefined);
    vi.spyOn(relayApi as any, 'initializeContentDocument').mockResolvedValue(undefined);
  });

  it('writes type:"file" and NO legacy docs entry for HTML files', async () => {
    const folder = new Y.Doc();
    const filemeta = folder.getMap('filemeta_v0');
    const legacyDocs = folder.getMap('docs');

    const id = await relayApi.createDocument(folder, '/page.html', 'file');

    const entry = filemeta.get('/page.html') as any;
    expect(entry).toBeDefined();
    expect(entry.type).toBe('file');
    expect(entry.id).toBe(id);
    expect(legacyDocs.has('/page.html')).toBe(false);
  });

  it('writes type:"markdown" AND legacy docs entry for markdown files', async () => {
    const folder = new Y.Doc();
    const filemeta = folder.getMap('filemeta_v0');
    const legacyDocs = folder.getMap('docs');

    const id = await relayApi.createDocument(folder, '/note.md', 'markdown');

    const entry = filemeta.get('/note.md') as any;
    expect(entry).toBeDefined();
    expect(entry.type).toBe('markdown');
    expect(legacyDocs.get('/note.md')).toBe(id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd lens-editor && npm run test:run -- relay-api.createDocument
```

Expected: FAIL — TypeScript will complain that `'file'` is not assignable to `'markdown' | 'canvas'`. Even if type-checking is lenient, the legacy `docs` map will contain the entry (current implementation always writes it).

- [ ] **Step 3: Update `createDocument` signature and body**

In `lens-editor/src/lib/relay-api.ts`, change the `createDocument` function:

1. Broaden the `type` parameter union: `type: 'markdown' | 'canvas' | 'file' = 'markdown'`.
2. Only write to the legacy `docs` map when `type === 'markdown'`.

The exact change inside the `folderDoc.transact(() => { ... })` block:

```ts
  folderDoc.transact(() => {
    // Add to modern filemeta_v0
    filemeta.set(path, meta);
    // Legacy "docs" map is only used by Obsidian Relay client for markdown files.
    // Non-markdown files (file type) live only in filemeta_v0.
    if (type === 'markdown') {
      legacyDocs.set(path, id);
    }
  }, LENS_EDITOR_ORIGIN);
```

Also update the post-transact verification logging block: the "legacyDocsExists" assertion is only meaningful when `type === 'markdown'`, so guard the `legacyDocs.get(path)` lookup or keep it but ignore the value for non-markdown — leave the existing `debug(...)` call intact, no functional changes needed beyond the type widening and the conditional write.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd lens-editor && npm run test:run -- relay-api.createDocument
```

Expected: PASS.

- [ ] **Step 5: Verify no regressions in adjacent tests**

```bash
cd lens-editor && npm run test:run -- relay-api
```

Expected: all `relay-api*` tests still pass.

- [ ] **Step 6: Commit**

```bash
jj st
jj commit -m "Extend createDocument to support type:'file' for HTML/non-markdown"
```

---

## Phase C — Editor UI (React)

### Task 5: `HtmlPreview` component

A sandboxed iframe that mirrors a Y.Text into its `srcdoc`, debounced 300ms after the last edit.

**Files:**
- Create: `lens-editor/src/components/HtmlEditor/HtmlPreview.tsx`
- Create: `lens-editor/src/components/HtmlEditor/HtmlPreview.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `lens-editor/src/components/HtmlEditor/HtmlPreview.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import * as Y from 'yjs';
import { HtmlPreview } from './HtmlPreview';

describe('HtmlPreview', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders a sandboxed iframe with allow-scripts but no other tokens', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<h1>Hello</h1>');

    const { container } = render(<HtmlPreview ytext={ytext} />);
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute('sandbox')).toBe('allow-scripts');
  });

  it('initial srcdoc reflects Y.Text content after the debounce', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>initial</p>');

    const { container } = render(<HtmlPreview ytext={ytext} />);

    // Advance past the 300ms debounce
    vi.advanceTimersByTime(350);

    const iframe = container.querySelector('iframe')!;
    expect(iframe.getAttribute('srcdoc')).toBe('<p>initial</p>');
  });

  it('updates srcdoc after a Y.Text edit and the debounce elapses', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>old</p>');

    const { container } = render(<HtmlPreview ytext={ytext} />);
    vi.advanceTimersByTime(350);

    ytext.delete(0, ytext.length);
    ytext.insert(0, '<p>new</p>');

    // Before debounce: stale
    vi.advanceTimersByTime(100);
    const iframe = container.querySelector('iframe')!;
    expect(iframe.getAttribute('srcdoc')).toBe('<p>old</p>');

    // After debounce: fresh
    vi.advanceTimersByTime(300);
    expect(iframe.getAttribute('srcdoc')).toBe('<p>new</p>');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd lens-editor && npm run test:run -- HtmlPreview
```

Expected: FAIL — module `./HtmlPreview` does not exist.

- [ ] **Step 3: Implement `HtmlPreview.tsx`**

Create `lens-editor/src/components/HtmlEditor/HtmlPreview.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';

interface HtmlPreviewProps {
  ytext: Y.Text;
  /** Debounce in ms before regenerating srcdoc. Default 300ms. */
  debounceMs?: number;
}

/**
 * Sandboxed iframe preview of HTML content stored in a Y.Text.
 *
 * The iframe runs in an opaque origin (sandbox="allow-scripts" only, no
 * allow-same-origin), so user scripts execute but cannot reach the parent.
 */
export function HtmlPreview({ ytext, debounceMs = 300 }: HtmlPreviewProps) {
  const [content, setContent] = useState(() => ytext.toString());
  const [debounced, setDebounced] = useState(content);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Subscribe to Y.Text changes
  useEffect(() => {
    const sync = () => setContent(ytext.toString());
    sync();
    ytext.observe(sync);
    return () => ytext.unobserve(sync);
  }, [ytext]);

  // Debounce content into the value we actually feed to srcdoc
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(content), debounceMs);
    return () => clearTimeout(handle);
  }, [content, debounceMs]);

  return (
    <iframe
      ref={iframeRef}
      title="HTML preview"
      sandbox="allow-scripts"
      srcDoc={debounced}
      className="w-full h-full border-0 bg-white"
    />
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd lens-editor && npm run test:run -- HtmlPreview
```

Expected: PASS for all three tests.

- [ ] **Step 5: Commit**

```bash
jj st
jj commit -m "Add HtmlPreview component: sandboxed iframe mirrored from Y.Text"
```

---

### Task 6: `HtmlSourceEditor` component

CodeMirror 6 with `@codemirror/lang-html` and yCollab binding to `Y.Text('contents')`. This is the source pane the user types HTML into.

**Files:**
- Create: `lens-editor/src/components/HtmlEditor/HtmlSourceEditor.tsx`
- Create: `lens-editor/src/components/HtmlEditor/HtmlSourceEditor.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `lens-editor/src/components/HtmlEditor/HtmlSourceEditor.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { HtmlSourceEditor } from './HtmlSourceEditor';

describe('HtmlSourceEditor', () => {
  afterEach(() => cleanup());

  it('renders a CodeMirror editor showing the Y.Text content', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<h1>Hi</h1>');
    const awareness = new Awareness(doc);

    const { container } = render(
      <HtmlSourceEditor ytext={ytext} awareness={awareness} />
    );

    const cm = container.querySelector('.cm-editor');
    expect(cm).not.toBeNull();
    // CodeMirror renders content into .cm-content
    const content = container.querySelector('.cm-content');
    expect(content?.textContent).toContain('<h1>Hi</h1>');
  });

  it('reflects later Y.Text changes in the rendered editor', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    const awareness = new Awareness(doc);

    const { container } = render(
      <HtmlSourceEditor ytext={ytext} awareness={awareness} />
    );

    ytext.insert(0, '<p>new</p>');
    // CodeMirror updates synchronously via yCollab transactions
    const content = container.querySelector('.cm-content');
    expect(content?.textContent).toContain('<p>new</p>');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd lens-editor && npm run test:run -- HtmlSourceEditor
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `HtmlSourceEditor.tsx`**

Create `lens-editor/src/components/HtmlEditor/HtmlSourceEditor.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import { EditorView } from 'codemirror';
import {
  keymap,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
} from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap } from '@codemirror/commands';
import {
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
  foldKeymap,
} from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { html } from '@codemirror/lang-html';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';

interface HtmlSourceEditorProps {
  ytext: Y.Text;
  awareness: Awareness;
  readOnly?: boolean;
}

export function HtmlSourceEditor({ ytext, awareness, readOnly = false }: HtmlSourceEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!containerRef.current || viewRef.current) return;

    const undoManager = new Y.UndoManager(ytext, {
      captureTimeout: 500,
      trackedOrigins: new Set([]),
    });

    const state = EditorState.create({
      extensions: [
        ...(readOnly
          ? [EditorView.editable.of(false), EditorState.readOnly.of(true)]
          : []),
        indentUnit.of('  '),
        EditorState.tabSize.of(2),
        highlightSpecialChars(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        bracketMatching(),
        closeBrackets(),
        rectangularSelection(),
        crosshairCursor(),
        highlightSelectionMatches(),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...yUndoManagerKeymap,
          ...foldKeymap,
          ...completionKeymap,
        ]),
        html(),
        yCollab(ytext, awareness, { undoManager }),
        EditorView.lineWrapping,
        EditorView.theme({
          '&': {
            height: '100%',
            fontSize: '14px',
            color: '#222222',
            outline: 'none',
          },
          '&.cm-focused': { outline: 'none' },
          '.cm-scroller': {
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            overflow: 'auto',
            lineHeight: '1.5',
          },
          '.cm-content': { padding: '16px 24px' },
          '.cm-gutters': { display: 'none' },
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // ytext, awareness, readOnly are captured at mount; remount on doc change happens via key in parent
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className="w-full h-full overflow-hidden" />;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd lens-editor && npm run test:run -- HtmlSourceEditor
```

Expected: PASS. The second test relies on yCollab propagating Y.Text changes into the CodeMirror DOM synchronously in happy-dom; if that does not hold, change the assertion to inspect CodeMirror's state directly: expose the view via an `onEditorReady` callback prop (modeled on `Editor.tsx`'s prop), then assert `view.state.doc.toString().includes('<p>new</p>')` instead of querying `.cm-content`. The behavior under test (Y.Text → editor) is the same; only the assertion target changes.

- [ ] **Step 5: Commit**

```bash
jj st
jj commit -m "Add HtmlSourceEditor: CodeMirror + lang-html bound to Y.Text via yCollab"
```

---

### Task 7: `HtmlEditor` component (three-mode toggle + layout)

The orchestrator. Owns the mode state (`source` | `preview` | `split`), renders an inline 3-button toggle, and composes `HtmlSourceEditor` + `HtmlPreview` according to the mode. Defaults to `preview`.

**Files:**
- Create: `lens-editor/src/components/HtmlEditor/HtmlEditor.tsx`
- Create: `lens-editor/src/components/HtmlEditor/HtmlEditor.test.tsx`
- Create: `lens-editor/src/components/HtmlEditor/index.ts`

- [ ] **Step 1: Write the failing test**

Create `lens-editor/src/components/HtmlEditor/HtmlEditor.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { HtmlEditor } from './HtmlEditor';

function renderWithDoc() {
  const doc = new Y.Doc();
  const ytext = doc.getText('contents');
  ytext.insert(0, '<h1>Test</h1>');
  const awareness = new Awareness(doc);
  return render(<HtmlEditor ytext={ytext} awareness={awareness} />);
}

describe('HtmlEditor', () => {
  afterEach(() => cleanup());

  it('defaults to preview mode (iframe visible, source pane hidden)', () => {
    const { container } = renderWithDoc();
    expect(container.querySelector('iframe')).not.toBeNull();
    expect(container.querySelector('.cm-editor')).toBeNull();
  });

  it('switching to source mode shows the source pane and hides preview', async () => {
    const { container } = renderWithDoc();
    await userEvent.click(screen.getByRole('button', { name: /source/i }));
    expect(container.querySelector('.cm-editor')).not.toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('switching to split mode shows both source and preview', async () => {
    const { container } = renderWithDoc();
    await userEvent.click(screen.getByRole('button', { name: /split/i }));
    expect(container.querySelector('.cm-editor')).not.toBeNull();
    expect(container.querySelector('iframe')).not.toBeNull();
  });

  it('toggle highlights the active mode', async () => {
    renderWithDoc();
    const sourceBtn = screen.getByRole('button', { name: /source/i });
    const previewBtn = screen.getByRole('button', { name: /preview/i });

    expect(previewBtn.getAttribute('aria-pressed')).toBe('true');
    expect(sourceBtn.getAttribute('aria-pressed')).toBe('false');

    await userEvent.click(sourceBtn);

    expect(previewBtn.getAttribute('aria-pressed')).toBe('false');
    expect(sourceBtn.getAttribute('aria-pressed')).toBe('true');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd lens-editor && npm run test:run -- HtmlEditor
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `HtmlEditor.tsx`**

Create `lens-editor/src/components/HtmlEditor/HtmlEditor.tsx`:

```tsx
import { useState } from 'react';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { HtmlSourceEditor } from './HtmlSourceEditor';
import { HtmlPreview } from './HtmlPreview';

type Mode = 'source' | 'preview' | 'split';

interface HtmlEditorProps {
  ytext: Y.Text;
  awareness: Awareness;
}

export function HtmlEditor({ ytext, awareness }: HtmlEditorProps) {
  const [mode, setMode] = useState<Mode>('preview');

  return (
    <div className="flex flex-col h-full w-full">
      <div className="border-b border-gray-200 px-3 py-1.5 flex items-center justify-end">
        <ModeToggle value={mode} onChange={setMode} />
      </div>
      <div className="flex-1 flex min-h-0">
        {mode !== 'preview' && (
          <div className={mode === 'split' ? 'flex-1 min-w-0 border-r border-gray-200' : 'flex-1 min-w-0'}>
            <HtmlSourceEditor ytext={ytext} awareness={awareness} />
          </div>
        )}
        {mode !== 'source' && (
          <div className="flex-1 min-w-0">
            <HtmlPreview ytext={ytext} />
          </div>
        )}
      </div>
    </div>
  );
}

interface ModeToggleProps {
  value: Mode;
  onChange: (m: Mode) => void;
}

function ModeToggle({ value, onChange }: ModeToggleProps) {
  const options: { value: Mode; label: string }[] = [
    { value: 'source',  label: 'Source'  },
    { value: 'preview', label: 'Preview' },
    { value: 'split',   label: 'Split'   },
  ];

  const baseClass = 'px-3 py-1 text-xs font-medium transition-colors rounded';
  const activeClass = 'bg-white text-gray-900 shadow-sm';
  const inactiveClass = 'text-gray-500 hover:text-gray-700';

  return (
    <div role="group" aria-label="HTML view mode" className="inline-flex items-center bg-gray-200 rounded p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-pressed={value === opt.value}
          onClick={() => value !== opt.value && onChange(opt.value)}
          className={`${baseClass} ${value === opt.value ? activeClass : inactiveClass}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Create `index.ts`**

Create `lens-editor/src/components/HtmlEditor/index.ts`:

```ts
export { HtmlEditor } from './HtmlEditor';
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd lens-editor && npm run test:run -- HtmlEditor
```

Expected: all four tests PASS.

- [ ] **Step 6: Commit**

```bash
jj st
jj commit -m "Add HtmlEditor with three-mode toggle (source/preview/split)"
```

---

### Task 8: Route `.html` paths to `HtmlEditor` in App.tsx

Extract a small `pickEditor()` helper so we can unit-test the routing decision, then call it in `App.tsx`.

**Files:**
- Create: `lens-editor/src/lib/editor-selector.ts`
- Create: `lens-editor/src/lib/editor-selector.test.ts`
- Modify: `lens-editor/src/App.tsx`
- Modify: `lens-editor/src/components/Layout/EditorArea.tsx` (only if it owns the per-doc content render; otherwise wire from App)

- [ ] **Step 1: Write the failing test**

Create `lens-editor/src/lib/editor-selector.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { pickEditor } from './editor-selector';

describe('pickEditor', () => {
  it('returns "blob" when the entry has a hash', () => {
    expect(pickEditor('/data.json', { type: 'file', id: 'x', version: 0, hash: 'abc' } as any))
      .toBe('blob');
  });

  it('returns "html" for .html paths with type "file" (no hash)', () => {
    expect(pickEditor('/page.html', { type: 'file', id: 'x', version: 0 } as any))
      .toBe('html');
  });

  it('returns "markdown" for .md paths', () => {
    expect(pickEditor('/note.md', { type: 'markdown', id: 'x', version: 0 } as any))
      .toBe('markdown');
  });

  it('returns "markdown" when path is unknown extension and no hash (fallback)', () => {
    expect(pickEditor('/noext', { type: 'markdown', id: 'x', version: 0 } as any))
      .toBe('markdown');
  });

  it('returns "markdown" when filePath is null (no entry yet — default editor)', () => {
    expect(pickEditor(null, null)).toBe('markdown');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd lens-editor && npm run test:run -- editor-selector
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `editor-selector.ts`**

Create `lens-editor/src/lib/editor-selector.ts`:

```ts
import type { FileMetadata } from './relay-api';

export type EditorKind = 'blob' | 'html' | 'markdown';

/**
 * Decide which editor component should render a given file.
 *
 * - 'blob'     — type="file" with hash (R2-backed binary, e.g. .json today)
 * - 'html'     — .html paths (Y.Text-backed, sandboxed-iframe preview)
 * - 'markdown' — default (Y.Text-backed, CodeMirror markdown editor)
 */
export function pickEditor(filePath: string | null, entry: FileMetadata | null): EditorKind {
  if (entry?.type === 'file' && entry?.hash) return 'blob';
  if (filePath?.endsWith('.html')) return 'html';
  return 'markdown';
}
```

If `FileMetadata` is not exported from `relay-api.ts`, locate the existing type definition (search for `interface FileMetadata` or `type FileMetadata`) and import from the right module. If it's defined inline somewhere, define a minimal local interface in `editor-selector.ts` and avoid coupling.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd lens-editor && npm run test:run -- editor-selector
```

Expected: all five tests PASS.

- [ ] **Step 5: Wire `pickEditor` into App.tsx**

In `lens-editor/src/App.tsx`, find the section around line 247–270 (the blob check + `EditorArea` render). Replace the `isBlobFile` check with a `pickEditor()` call:

```tsx
import { pickEditor } from './lib/editor-selector';
import { HtmlEditor } from './components/HtmlEditor';
import { useYDoc, useYjsProvider } from '@y-sweet/react';
// ... existing imports

// inside the component:
const uuid = activeDocId ? activeDocId.slice(RELAY_ID.length + 1) : null;
const filePath = uuid ? findPathByUuid(uuid, metadata) : null;
const fileEntry = filePath ? metadata[filePath] : null;
const editorKind = pickEditor(filePath, fileEntry);

if (!docUuid) return <DocumentNotFound />;
if (!activeDocId) {
  return (
    <main className="flex-1 flex items-center justify-center bg-gray-50">
      <div className="text-sm text-gray-500">Loading document...</div>
    </main>
  );
}

if (editorKind === 'blob' && fileEntry?.hash && filePath) {
  const fileName = filePath.split('/').pop() ?? undefined;
  const folderName = filePath.split('/').filter(Boolean)[0];
  const folderConfig = FOLDERS.find(f => f.name === folderName);
  const folderDocId = folderConfig ? `${RELAY_ID}-${folderConfig.id}` : '';
  return <BlobDocumentView docId={activeDocId} hash={fileEntry.hash} folderDocId={folderDocId} fileName={fileName} />;
}

if (editorKind === 'html') {
  return (
    <RelayProvider key={activeDocId} docId={activeDocId}>
      <AwarenessInitializer />
      <HtmlEditorMount />
      <DisconnectionModal />
    </RelayProvider>
  );
}

return (
  <RelayProvider key={activeDocId} docId={activeDocId}>
    <AwarenessInitializer />
    <EditorArea currentDocId={activeDocId} />
    <DisconnectionModal />
  </RelayProvider>
);
```

`HtmlEditorMount` is a tiny adapter that pulls `Y.Doc` + provider out of the `@y-sweet/react` context and passes the right `ytext` / `awareness` down. Add it at the bottom of `App.tsx`:

```tsx
function HtmlEditorMount() {
  const ydoc = useYDoc();
  const provider = useYjsProvider();
  const ytext = ydoc.getText('contents');
  return <HtmlEditor ytext={ytext} awareness={provider.awareness} />;
}
```

(The Markdown `Editor.tsx` does the same dance at Editor.tsx:230–260; this is the established pattern.)

- [ ] **Step 6: Verify the build still type-checks**

```bash
cd lens-editor && npm run build 2>&1 | tail -20
```

Expected: clean TypeScript build. If errors appear, inspect them; common ones are missing imports or a wrong shape for `FileMetadata`.

- [ ] **Step 7: Commit**

```bash
jj st
jj commit -m "Route .html paths to HtmlEditor via editor-selector helper"
```

---

## Phase D — Sidebar integration

### Task 9: "New HTML File" option in sidebar

Add a third menu item to `CreateMenu` and a new `handleInstantCreateHtml` in `Sidebar` that calls `createDocument(folderDoc, path, 'file')` and uses an `.html` filename.

**Files:**
- Modify: `lens-editor/src/components/Sidebar/CreateMenu.tsx`
- Modify: `lens-editor/src/components/Sidebar/Sidebar.tsx`
- Modify: `lens-editor/src/components/Sidebar/FileTreeNode.tsx` (pass-through if it forwards the callback)

- [ ] **Step 1: Inspect call sites**

Read `lens-editor/src/components/Sidebar/FileTreeNode.tsx` around line 219 — that's the `<CreateMenu ... />` call site. Confirm what props it currently passes (`onCreateDocument`, `onCreateFolder`). The new `onCreateHtmlDocument` callback needs to be plumbed from `Sidebar.tsx` → `FileTreeNode.tsx` → `CreateMenu.tsx`.

- [ ] **Step 2: Extend `CreateMenu` props and UI**

In `lens-editor/src/components/Sidebar/CreateMenu.tsx`:

```tsx
interface CreateMenuProps {
  folderName: string;
  onCreateDocument?: () => void;
  onCreateHtmlDocument?: () => void;
  onCreateFolder?: () => void;
}

export function CreateMenu({ folderName, onCreateDocument, onCreateHtmlDocument, onCreateFolder }: CreateMenuProps) {
  // ... existing state/refs/effects unchanged ...
  return (
    <div ref={menuRef} className="ml-auto flex-shrink-0 relative">
      <button /* existing trigger button */ />
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-white rounded shadow-lg border border-gray-200 py-1 min-w-[140px] z-50">
          {onCreateDocument && (
            <button
              className="w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
              onClick={(e) => { e.stopPropagation(); onCreateDocument(); handleClose(); }}
            >New File</button>
          )}
          {onCreateHtmlDocument && (
            <button
              className="w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
              onClick={(e) => { e.stopPropagation(); onCreateHtmlDocument(); handleClose(); }}
            >New HTML File</button>
          )}
          {onCreateFolder && (
            <button
              className="w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
              onClick={(e) => { e.stopPropagation(); onCreateFolder(); handleClose(); }}
            >New Folder</button>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add `handleInstantCreateHtml` to `Sidebar.tsx`**

In `lens-editor/src/components/Sidebar/Sidebar.tsx`, after the existing `handleInstantCreate` (around line 145–175), add:

```tsx
const handleInstantCreateHtml = useCallback(async (folderPath: string) => {
  const folderName = getFolderNameFromPath(folderPath, folderNames);
  if (!folderName) return;
  const doc = folderDocs.get(folderName);
  if (!doc) return;

  const originalFolderPath = getOriginalPath(folderPath, folderName);

  // Generate an untitled name with .html extension. generateUntitledName is
  // markdown-specific (adds .md); for HTML we mirror the same logic but use .html.
  const baseName = nextUntitledHtmlName(originalFolderPath, metadata);
  const path = originalFolderPath === '' || originalFolderPath === '/'
    ? `/${baseName}`
    : `${originalFolderPath}/${baseName}`;

  try {
    const id = await createDocument(doc, path, 'file');
    justCreatedRef.current = true;
    const compoundDocId = `${RELAY_ID}-${id}`;
    onNavigate(compoundDocId);
  } catch (error) {
    console.error('Failed to create HTML document:', error);
  }
}, [folderDocs, folderNames, metadata, onNavigate]);
```

Add the `nextUntitledHtmlName` helper at the top of `Sidebar.tsx` (or inline if trivial):

```tsx
function nextUntitledHtmlName(folderPath: string, metadata: Record<string, unknown>): string {
  const base = 'Untitled';
  const prefix = folderPath === '' || folderPath === '/' ? '/' : `${folderPath}/`;
  if (!metadata[`${prefix}${base}.html`]) return `${base}.html`;
  for (let i = 2; i < 1000; i++) {
    const name = `${base} ${i}.html`;
    if (!metadata[`${prefix}${name}`]) return name;
  }
  return `${base} ${Date.now()}.html`;
}
```

Pass the new callback through to `FileTreeNode`'s `CreateMenu`. Find the `<CreateMenu ... />` invocation in `FileTreeNode.tsx` around line 219 and add `onCreateHtmlDocument={...}` similarly to the existing `onCreateDocument`.

- [ ] **Step 4: Manually verify creation**

There is no unit test for this wiring (the existing `handleInstantCreate` is also untested). Verify manually after Phase E. Skip ahead to the smoke test if you want immediate feedback.

- [ ] **Step 5: Commit**

```bash
jj st
jj commit -m "Add 'New HTML File' option to sidebar create menu"
```

---

### Task 10: Sidebar rename preserves existing extension

Current behavior (Sidebar.tsx around `handleRenameSubmit`): auto-appends `.md` if the new name doesn't end in `.md`. New behavior: if the user types no extension, preserve the existing file's extension (so `page.html` → `page2` becomes `page2.html`; `note.md` → `note2` becomes `note2.md`).

**Files:**
- Modify: `lens-editor/src/components/Sidebar/Sidebar.tsx` (handleRenameSubmit, around line 119)
- Create: `lens-editor/src/lib/filename-utils.ts` (new — pure helper for testability)
- Create: `lens-editor/src/lib/filename-utils.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lens-editor/src/lib/filename-utils.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { renamePreservingExtension } from './filename-utils';

describe('renamePreservingExtension', () => {
  it('preserves .md extension when the user types no extension', () => {
    expect(renamePreservingExtension('note.md', 'note2')).toBe('note2.md');
  });

  it('preserves .html extension when the user types no extension', () => {
    expect(renamePreservingExtension('page.html', 'page2')).toBe('page2.html');
  });

  it('uses the typed extension when the user supplies one', () => {
    expect(renamePreservingExtension('note.md', 'note2.html')).toBe('note2.html');
  });

  it('returns the new name verbatim if neither old nor new has an extension', () => {
    expect(renamePreservingExtension('readme', 'changelog')).toBe('changelog');
  });

  it('ignores leading dots in dotfiles (treats them as no extension)', () => {
    // .gitignore renamed to .npmignore: leading-dot files don't have a separate "extension"
    expect(renamePreservingExtension('.gitignore', '.npmignore')).toBe('.npmignore');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd lens-editor && npm run test:run -- filename-utils
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `filename-utils.ts`**

Create `lens-editor/src/lib/filename-utils.ts`:

```ts
/**
 * Rename a file, preserving the old name's extension when the new name has none.
 *
 * - oldName="note.md",   newName="note2"        → "note2.md"
 * - oldName="page.html", newName="page2"        → "page2.html"
 * - oldName="note.md",   newName="note2.html"   → "note2.html"  (typed wins)
 * - oldName="readme",    newName="changelog"    → "changelog"   (no ext either side)
 * - oldName=".gitignore",newName=".npmignore"   → ".npmignore"  (leading dot is not an ext)
 */
export function renamePreservingExtension(oldName: string, newName: string): string {
  const oldExt = extensionOf(oldName);
  const newExt = extensionOf(newName);
  if (oldExt && !newExt) return `${newName}${oldExt}`;
  return newName;
}

function extensionOf(name: string): string {
  const idx = name.lastIndexOf('.');
  // No dot, or leading dot (dotfile) — treat as no extension.
  if (idx <= 0) return '';
  return name.slice(idx);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd lens-editor && npm run test:run -- filename-utils
```

Expected: all five tests PASS.

- [ ] **Step 5: Use the helper in Sidebar.tsx**

In `lens-editor/src/components/Sidebar/Sidebar.tsx`, find `handleRenameSubmit` (around line 119). Replace this:

```tsx
parts[parts.length - 1] = isFolder
  ? newName
  : oldName.endsWith('.md') && !newName.endsWith('.md') ? `${newName}.md` : newName;
```

with:

```tsx
parts[parts.length - 1] = isFolder
  ? newName
  : renamePreservingExtension(oldName, newName);
```

Add the import at the top of `Sidebar.tsx`:

```tsx
import { renamePreservingExtension } from '../../lib/filename-utils';
```

- [ ] **Step 6: Verify nothing regresses**

```bash
cd lens-editor && npm run test:run -- Sidebar filename-utils
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
jj st
jj commit -m "Rename: preserve existing extension when user types no extension"
```

---

## Phase E — Verification

### Task 11: Manual smoke test with `jsonl2html.py` output

End-to-end check that the whole pipeline works. This is not automated; the user (or implementer) drives the browser.

- [ ] **Step 1: Start the local relay and Lens editor**

```bash
cd lens-editor
npm run relay:start     # Terminal 1
npm run dev:local       # Terminal 2
```

Open the URL printed by Vite — should be `http://dev.vps:5173` (or `5273` on ws2, `5373` on ws3, etc.).

- [ ] **Step 2: Create an HTML file from the sidebar**

- Click the "+" in any folder header → "New HTML File"
- Confirm a file `Untitled.html` appears in the tree and the editor opens it.
- Default mode should be **Preview** (iframe visible, source pane hidden).
- Toggle to **Source**, type `<h1>Hello world</h1>`.
- Toggle back to **Preview** (wait the 300ms debounce); page should show "Hello world" as a heading.
- Toggle to **Split**, edit on the left, watch the right update after debounce.

- [ ] **Step 3: Verify scripts execute in the sandbox**

In Source mode, paste:

```html
<button onclick="this.innerText='clicked at ' + new Date().toLocaleTimeString()">click me</button>
```

Switch to Preview, click the button, confirm the text changes.

- [ ] **Step 4: Verify sandbox isolation**

In Source mode, paste:

```html
<script>
  try {
    window.parent.document.title = 'PWNED';
    document.body.innerText = 'ESCAPED (BAD)';
  } catch (e) {
    document.body.innerText = 'sandbox holds: ' + e.message;
  }
</script>
```

Switch to Preview. The iframe should show `sandbox holds: ...` (a SecurityError) and the host page title should be unchanged.

- [ ] **Step 5: Test with jsonl2html.py output**

```bash
# From any directory with a Claude/Codex jsonl session log:
python3 /home/penguin/code/incoming-files/jsonl2html.py <session.jsonl> --out /tmp/session.html
```

Copy the contents of `/tmp/session.html`. Create a new HTML file in Lens, paste the content into Source mode, switch to Preview. Expected:
- The page renders with `<details>` expand/collapse for turns.
- The CDN `marked.js` script loads and renders the inline Markdown blocks.
- Inline `onclick` expand/collapse buttons work.

- [ ] **Step 6: Test multi-user sync**

Open the same HTML file in two browser tabs. Edit in one (source mode). Verify the other tab's source pane updates immediately and the preview updates after the 300ms debounce.

- [ ] **Step 7: Test rename extension preservation**

Right-click the `.html` file in the sidebar → rename → type a name with no extension (e.g., `notes-export`). Confirm the resulting file is `notes-export.html`, not `notes-export.md`.

- [ ] **Step 8: If everything passes, mark v1 complete**

```bash
jj st  # should be clean if no test edits were needed
jj log -r 'main..@' --no-graph  # review all v1 commits
```

If anything fails, file the specific behavior + reproduction steps, then fix and add a regression test.

---

## Out of scope for v1 (reminders)

These are explicitly NOT in this plan. Do not implement them now:

- Comments on HTML
- Suggestions on HTML
- HTML link indexer (wikilink extraction)
- Markdown-block transform plugins for `jsonl2html.py` output
- Scroll sync between source and preview
- Per-document mode persistence
- Resizable split divider (50/50 is fine for v1)
- Obsidian / Relay.md compatibility verification
- postMessage bridge script (v2)
- **File-tree icon for `.html` files** — the spec called for a `FileCode` icon, but `FileTreeNode.tsx` currently renders NO per-file icon for any extension (only a 5px spacer). Adding an icon only for `.html` would be visually inconsistent, and `lucide-react` is not yet a dependency. The `.html` suffix in the filename is sufficient visual distinction in v1. Revisit if/when we add per-extension icons systematically.

If you find yourself wanting to add any of these, stop and add them to `docs/superpowers/specs/2026-05-22-html-sharing-v1-design.md` "Future work" section instead.
