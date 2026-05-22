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
| `lens-editor/src/lib/relay-api.ts` | Modify: extract `writeFileMeta` helper (pure, testable); extend `createDocument` to accept `'file'` type via the helper; skip legacy `docs` map for non-markdown |
| `lens-editor/src/lib/relay-api.writeFileMeta.test.ts` | Create: tests for the `writeFileMeta` helper (real Y.Doc, no mocks) |
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
| `lens-editor/src/components/Sidebar/FileTreeContext.tsx` | Modify: extend `FileTreeContextValue` with `onCreateHtmlDocument?: (folderPath: string) => void` |
| `lens-editor/src/components/Sidebar/FileTreeNode.tsx` | Modify: forward `ctx.onCreateHtmlDocument` to `CreateMenu` |
| `lens-editor/src/components/Sidebar/Sidebar.tsx` | Modify: extract `nextUntitledHtmlName` to a testable module; wire `handleInstantCreateHtml`; provide it via `FileTreeProvider`; replace rename logic with `renamePreservingExtension` |
| `lens-editor/src/lib/untitled-name.ts` | Create: `nextUntitledHtmlName` helper (pure, testable) |
| `lens-editor/src/lib/untitled-name.test.ts` | Create: tests for `nextUntitledHtmlName` |
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

Append to the `#[cfg(test)] mod tests` block at the bottom of `crates/relay/src/mcp/tools/create_doc.rs`. The existing module's `use super::*` block re-exports `Server`, `Value`, `Arc`, and `blob`; you must add the yrs traits explicitly for `get_text`/`get_string`/`transact`:

```rust
    #[tokio::test]
    async fn create_html_uses_direct_path() {
        use yrs::{GetString, ReadTxn, Text, Transact};
        use y_sweet_core::link_indexer::extract_type_from_filemeta_entry;

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
        drop(guard);

        // Folder filemeta_v0 entry MUST have type="file" — this is the contract
        // that the frontend's pickEditor and the link indexer rely on.
        let folder_ref = docs.get(&info.folder_doc_id).expect("folder doc loaded");
        let folder_awareness = folder_ref.awareness();
        let folder_guard = folder_awareness.read().unwrap();
        let folder_txn = folder_guard.doc.transact();
        let filemeta = folder_txn.get_map("filemeta_v0").expect("filemeta_v0 exists");
        let entry = filemeta.get(&folder_txn, "/page.html").expect("entry exists");
        let file_type = extract_type_from_filemeta_entry(&entry, &folder_txn)
            .expect("type field present");
        assert_eq!(file_type, "file", "HTML files must have type=\"file\", not \"markdown\"");
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

Append to the `#[cfg(test)] mod tests` block at the bottom of `crates/y-sweet-core/src/link_indexer.rs`. The reference test `index_document_with_dashmap_and_awareness` at line 4686 shows the required doc-ID shape: `parse_doc_id` (line 24) requires `<36-char-uuid>-<36-char-uuid>` with a `-` at byte 36, so use full UUIDs, not short strings.

**Wikilink resolution note:** the link indexer's `resolve_in_virtual_tree` (link_indexer.rs:236) is **markdown-only** — it skips entries whose `entry_type != "markdown"` (line 247) and the absolute-fallback path it computes is hardcoded `/{link_name}.md` (line 240). So `[[anything]]` never resolves to a `.html` entry, regardless of whether we add the skip. The test below avoids this trap: the `.html` doc tries to wikilink to a sibling `.md` (which the resolver WOULD resolve if we indexed the .html — so the skip is observably preventing the backlink), and the `.md` sibling wikilinks to a SECOND `.md` file (which the resolver can resolve, so we can prove Markdown indexing still works).

```rust
    #[tokio::test]
    async fn index_document_skips_html_files() {
        use dashmap::DashMap;
        use yrs::{Any, Map, ReadTxn, Text, Transact};
        use crate::doc_sync::DocWithSyncKv;
        use std::collections::HashMap;

        let relay_id = "cb696037-0f72-4e93-8717-4e433129d789";
        let folder_uuid = "b0000001-0000-4000-8000-000000000001";
        let html_uuid   = "a0000001-0000-4000-8000-000000000001";
        let notes_uuid  = "a0000002-0000-4000-8000-000000000002";
        let extra_uuid  = "a0000003-0000-4000-8000-000000000003";

        let folder_id = format!("{}-{}", relay_id, folder_uuid);
        let html_id   = format!("{}-{}", relay_id, html_uuid);
        let notes_id  = format!("{}-{}", relay_id, notes_uuid);
        let extra_id  = format!("{}-{}", relay_id, extra_uuid);

        let docs: DashMap<String, DocWithSyncKv> = DashMap::new();

        // Folder doc with three files: .html, .md ("notes"), and another .md ("extra")
        // which is the wikilink target of /notes.md.
        let folder = DocWithSyncKv::new(&folder_id, None, || (), None).await.unwrap();
        {
            let awareness = folder.awareness();
            let guard = awareness.write().unwrap();
            let mut txn = guard.doc.transact_mut();
            let config = txn.get_or_insert_map("folder_config");
            config.insert(&mut txn, "name", Any::String("Lens".into()));
            let filemeta = txn.get_or_insert_map("filemeta_v0");

            let mut html_entry = HashMap::new();
            html_entry.insert("id".to_string(), Any::String(html_uuid.into()));
            html_entry.insert("type".to_string(), Any::String("file".into()));
            html_entry.insert("version".to_string(), Any::Number(0.0));
            filemeta.insert(&mut txn, "/page.html", Any::Map(html_entry.into()));

            let mut notes_entry = HashMap::new();
            notes_entry.insert("id".to_string(), Any::String(notes_uuid.into()));
            notes_entry.insert("type".to_string(), Any::String("markdown".into()));
            notes_entry.insert("version".to_string(), Any::Number(0.0));
            filemeta.insert(&mut txn, "/notes.md", Any::Map(notes_entry.into()));

            let mut extra_entry = HashMap::new();
            extra_entry.insert("id".to_string(), Any::String(extra_uuid.into()));
            extra_entry.insert("type".to_string(), Any::String("markdown".into()));
            extra_entry.insert("version".to_string(), Any::Number(0.0));
            filemeta.insert(&mut txn, "/extra.md", Any::Map(extra_entry.into()));
        }
        docs.insert(folder_id.clone(), folder);

        // HTML doc wikilinks to the .md sibling. If .html were indexed, /notes.md's
        // backlinks would gain html_uuid (the resolver maps `[[notes]]` → `/notes.md`).
        // The skip must prevent that.
        let html = DocWithSyncKv::new(&html_id, None, || (), None).await.unwrap();
        {
            let awareness = html.awareness();
            let guard = awareness.write().unwrap();
            let mut txn = guard.doc.transact_mut();
            let text = txn.get_or_insert_text("contents");
            text.insert(&mut txn, 0, "<a href=\"[[notes]]\">Link</a>");
        }
        docs.insert(html_id.clone(), html);

        // /notes.md wikilinks to /extra.md — both markdown, so the resolver will
        // map `[[extra]]` → `/extra.md`. Proves Markdown indexing still runs after our skip.
        let notes = DocWithSyncKv::new(&notes_id, None, || (), None).await.unwrap();
        {
            let awareness = notes.awareness();
            let guard = awareness.write().unwrap();
            let mut txn = guard.doc.transact_mut();
            let text = txn.get_or_insert_text("contents");
            text.insert(&mut txn, 0, "See [[extra]] for details");
        }
        docs.insert(notes_id.clone(), notes);

        let extra = DocWithSyncKv::new(&extra_id, None, || (), None).await.unwrap();
        docs.insert(extra_id.clone(), extra);

        let (indexer, _rx) = LinkIndexer::new();
        let folder_doc_ids = vec![folder_id.clone()];

        let html_result = indexer.index_document(&html_id, &docs, &folder_doc_ids);
        assert!(html_result.is_ok(), "indexing .html should not error: {:?}", html_result.err());

        let notes_result = indexer.index_document(&notes_id, &docs, &folder_doc_ids);
        assert!(notes_result.is_ok(), "indexing .md should not error: {:?}", notes_result.err());

        let folder_ref = docs.get(&folder_id).unwrap();
        let folder_awareness = folder_ref.awareness();
        let guard = folder_awareness.read().unwrap();
        let txn = guard.doc.transact();
        let backlinks = txn.get_map("backlinks_v0").expect("backlinks_v0 should exist after indexing");

        // /extra.md MUST have notes_uuid as a backlink source. This proves the .md
        // indexing path still runs (i.e., the skip isn't too eager).
        let extra_backlinks = read_backlinks_array(&backlinks, &txn, extra_uuid);
        assert_eq!(
            extra_backlinks, vec![notes_uuid],
            "/notes.md's [[extra]] wikilink must produce a backlink on extra_uuid"
        );

        // /notes.md must NOT have html_uuid as a backlink source — the .html doc
        // was skipped, so its `[[notes]]` was never extracted.
        let notes_backlinks = read_backlinks_array(&backlinks, &txn, notes_uuid);
        assert!(
            notes_backlinks.is_empty(),
            "skipped .html doc must not produce a backlink on /notes.md (got {:?})",
            notes_backlinks
        );
    }
```

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

        // Skip .html files: we don't extract wikilinks from raw HTML in v1 because
        // attribute values, scripts, and style blocks produce false positives.
        // Each iteration takes a short folder lock just long enough to read the
        // filemeta path; we stop as soon as we find the entry (in any folder).
        let mut path_for_doc: Option<String> = None;
        for fid in folder_doc_ids {
            let awareness = match docs.get(fid) {
                Some(r) => r.awareness(),
                None => continue,
            };
            let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
            let txn = guard.doc.transact();
            if let Some(filemeta) = txn.get_map("filemeta_v0") {
                if let Some(path) = find_path_for_uuid(&filemeta, &txn, doc_uuid) {
                    path_for_doc = Some(path);
                    break;
                }
            }
        }
        // If we did find a path AND it's .html, skip indexing. If we didn't find a
        // path (transient state — filemeta not yet written), fall through to the
        // existing flow, which is the safer default.
        if path_for_doc.as_deref().is_some_and(|p| p.ends_with(".html")) {
            return Ok(());
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

The filemeta-write logic is mixed into a function that also performs three network calls (`createDocumentOnServer`, `waitForDocumentAccess`, `initializeContentDocument`) via module-private helpers. Testing those private helpers via `vi.spyOn(module, ...)` does not work (ESM namespace bindings cannot be reassigned). Instead, extract the pure filemeta-write into its own exported helper and test that directly — no mocks needed.

**Files:**
- Modify: `lens-editor/src/lib/relay-api.ts` — extract `writeFileMeta`, call it from `createDocument`, widen the `type` union
- Create: `lens-editor/src/lib/relay-api.writeFileMeta.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lens-editor/src/lib/relay-api.writeFileMeta.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { writeFileMeta } from './relay-api';

describe('writeFileMeta', () => {
  it('writes type:"file" and NO legacy docs entry for HTML files', () => {
    const folder = new Y.Doc();
    const filemeta = folder.getMap('filemeta_v0');
    const legacyDocs = folder.getMap<string>('docs');

    writeFileMeta(folder, '/page.html', 'uuid-html-1', 'file');

    const entry = filemeta.get('/page.html') as any;
    expect(entry).toBeDefined();
    expect(entry.type).toBe('file');
    expect(entry.id).toBe('uuid-html-1');
    expect(entry.version).toBe(0);
    expect(legacyDocs.has('/page.html')).toBe(false);
  });

  it('writes type:"markdown" AND legacy docs entry for markdown files', () => {
    const folder = new Y.Doc();
    const filemeta = folder.getMap('filemeta_v0');
    const legacyDocs = folder.getMap<string>('docs');

    writeFileMeta(folder, '/note.md', 'uuid-md-1', 'markdown');

    const entry = filemeta.get('/note.md') as any;
    expect(entry).toBeDefined();
    expect(entry.type).toBe('markdown');
    expect(entry.id).toBe('uuid-md-1');
    expect(legacyDocs.get('/note.md')).toBe('uuid-md-1');
  });

  it('writes type:"canvas" with NO legacy docs entry', () => {
    const folder = new Y.Doc();
    const filemeta = folder.getMap('filemeta_v0');
    const legacyDocs = folder.getMap<string>('docs');

    writeFileMeta(folder, '/board.canvas', 'uuid-canvas-1', 'canvas');

    const entry = filemeta.get('/board.canvas') as any;
    expect(entry?.type).toBe('canvas');
    expect(legacyDocs.has('/board.canvas')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd lens-editor && npm run test:run -- relay-api.writeFileMeta
```

Expected: FAIL — `writeFileMeta` is not exported from `./relay-api`.

- [ ] **Step 3: Extract `writeFileMeta` and have `createDocument` call it**

In `lens-editor/src/lib/relay-api.ts`:

1. Add the new exported helper alongside the existing `createDocument` (above it is fine):

```ts
/**
 * Write a filemeta_v0 entry (and legacy 'docs' entry for markdown) for a new file.
 * Pure with respect to the Y.Doc: no network, no UUID generation, no waits.
 *
 * Legacy "docs" map is required by the Obsidian Relay client for markdown files
 * (SyncStore.getMeta() will mark filemeta-only entries for deletion). Non-markdown
 * types do not appear in the legacy map.
 */
export function writeFileMeta(
  folderDoc: Y.Doc,
  path: string,
  id: string,
  type: 'markdown' | 'canvas' | 'file',
  version: number = 0,
): void {
  const filemeta = folderDoc.getMap<FileMetadata>('filemeta_v0');
  const legacyDocs = folderDoc.getMap<string>('docs');
  const meta: FileMetadata = { id, type, version };
  folderDoc.transact(() => {
    filemeta.set(path, meta);
    if (type === 'markdown') {
      legacyDocs.set(path, id);
    }
  }, LENS_EDITOR_ORIGIN);
}
```

2. Widen the `createDocument` signature: change `type: 'markdown' | 'canvas' = 'markdown'` to `type: 'markdown' | 'canvas' | 'file' = 'markdown'`.

3. Replace the inline `folderDoc.transact(() => { filemeta.set(...); legacyDocs.set(...); }, LENS_EDITOR_ORIGIN)` block in `createDocument` with a single call:

```ts
  writeFileMeta(folderDoc, path, id, type);
```

The "verification after set" debug-log block can be left intact; for non-markdown types its `legacyDocsExists` field will be `false`, which is correct.

4. **Gate the `initializeContentDocument` call by type.** The existing call seeds the new doc's `Y.Text('contents')` with the character `_` so Obsidian materializes the file. For HTML, Obsidian doesn't sync the file anyway, and the underscore would render as literal `_` in both source and preview panes. Find the existing block (around line 222):

```ts
  // Step 3: Initialize content document to trigger Obsidian sync
  // This adds an underscore so Obsidian creates the file immediately
  try {
    await initializeContentDocument(fullDocId);
  } catch (err) {
    // Don't fail the whole operation if content init fails
    ...
  }
```

Wrap the `try` block in a markdown-only conditional:

```ts
  // Step 3: Initialize content document to trigger Obsidian sync (markdown only).
  // For non-markdown types ('file', 'canvas') we leave the Y.Text empty — Obsidian
  // does not sync these as Y.Docs, so the "_" placeholder is not needed and would
  // appear as visible content in the editor/preview.
  if (type === 'markdown') {
    try {
      await initializeContentDocument(fullDocId);
    } catch (err) {
      // Don't fail the whole operation if content init fails
      ...
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd lens-editor && npm run test:run -- relay-api.writeFileMeta
```

Expected: all three tests PASS.

- [ ] **Step 5: Verify no regressions in adjacent tests**

```bash
cd lens-editor && npm run test:run -- relay-api
```

Expected: all `relay-api*` tests still pass (including the integration test, if a relay server is running).

- [ ] **Step 6: Commit**

```bash
jj st
jj commit -m "Extract writeFileMeta helper; support type:'file' for HTML/non-markdown"
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
import { render, cleanup, act } from '@testing-library/react';
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

  it('renders a sandboxed iframe with ONLY the allow-scripts token (no allow-same-origin)', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<h1>Hello</h1>');

    const { container } = render(<HtmlPreview ytext={ytext} />);
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    const sandbox = iframe!.getAttribute('sandbox') ?? '';
    expect(sandbox).toBe('allow-scripts');
    // Security-critical negative assertion: opaque origin requires NO allow-same-origin.
    // (If both were set, scripts in the iframe could reach parent.document.)
    expect(sandbox).not.toContain('allow-same-origin');
  });

  it('updates srcdoc after a Y.Text mutation, debounced by 300ms', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    // Start empty so the FIRST debounced write is observable (with content prefilled,
    // the component's initial render would already match, and the debounce timer
    // would be untested).

    const { container } = render(<HtmlPreview ytext={ytext} />);
    const iframe = () => container.querySelector('iframe')!;

    // Mutate Y.Text. Wrap in act() because Y.Text.observe synchronously fires
    // setState, which React 19 may batch into a microtask.
    await act(async () => {
      ytext.insert(0, '<p>first</p>');
    });

    // Before debounce: srcdoc is still the initial empty value.
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(iframe().getAttribute('srcdoc') ?? '').toBe('');

    // After debounce: srcdoc reflects the new content.
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(iframe().getAttribute('srcdoc')).toBe('<p>first</p>');

    // A second mutation must be debounced independently.
    await act(async () => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, '<p>second</p>');
    });
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(iframe().getAttribute('srcdoc')).toBe('<p>first</p>'); // still stale
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(iframe().getAttribute('srcdoc')).toBe('<p>second</p>');
  });
});
```

Note: the first test asserts both the positive sandbox attribute AND the absence of `allow-same-origin`. The second test is the load-bearing one — it starts with empty Y.Text so the debounce timing is actually exercised, and uses `act()` to handle React 19 batching around Y.Text observe callbacks.

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

  it('mounts a CodeMirror editor when given a Y.Text and Awareness', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<h1>Hi</h1>');
    const awareness = new Awareness(doc);

    const { container } = render(
      <HtmlSourceEditor ytext={ytext} awareness={awareness} />
    );

    // `.cm-editor` is added synchronously by the EditorView constructor; this
    // assertion fails if the component throws during mount (e.g. missing extension,
    // bad lang import, ytext not provided).
    expect(container.querySelector('.cm-editor')).not.toBeNull();
  });
});
```

We intentionally do NOT assert on `.cm-content` text or test "yCollab propagates later Y.Text mutations into CodeMirror's DOM." Those behaviors belong to CodeMirror's renderer and `y-codemirror.next`, both upstream-tested. Reproducing them in vitest+happy-dom means fighting microtask scheduling for a contract we don't own. The cross-pane Y.Text → preview path IS tested behaviorally in Task 7's `HtmlEditor` tests. End-to-end source-pane bidirectional editing is verified manually in Task 11.

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

Expected: PASS — the single test verifies CodeMirror mounts and renders the initial Y.Text content. No `onEditorReady` prop or DOM polling needed.

- [ ] **Step 5: Commit**

```bash
jj st
jj commit -m "Add HtmlSourceEditor: CodeMirror + lang-html bound to Y.Text via yCollab"
```

---

### Task 7: `HtmlEditor` component (three-mode toggle + layout)

The orchestrator. Owns the mode state (`source` | `preview` | `split`), renders an inline 3-button toggle, and composes `HtmlSourceEditor` + `HtmlPreview` according to the mode. Defaults to `preview`.

**Accepted v1 trade-off:** mode switching uses **conditional rendering** (the inactive pane is unmounted), not `display:none`. This means switching modes destroys CodeMirror state (selection, scroll position, undo stack scoped to the local UndoManager). For v1 this is acceptable — yCollab's Y.UndoManager state lives on the Y.Doc and is rebuilt on remount, and most editing happens in either source or split mode. Persisting CodeMirror state across mode switches is a v2-ish UX polish.

**Files:**
- Create: `lens-editor/src/components/HtmlEditor/HtmlEditor.tsx`
- Create: `lens-editor/src/components/HtmlEditor/HtmlEditor.test.tsx`
- Create: `lens-editor/src/components/HtmlEditor/index.ts`

- [ ] **Step 1: Write the failing test**

Create `lens-editor/src/components/HtmlEditor/HtmlEditor.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
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

  it('preview pane is bound to the SAME Y.Text instance the parent owns', async () => {
    // Behavioral test: if HtmlEditor accidentally created a fresh Y.Doc per child,
    // mutating the parent's ytext would not show up in the preview's iframe.
    vi.useFakeTimers();
    try {
      const doc = new Y.Doc();
      const ytext = doc.getText('contents');
      const awareness = new Awareness(doc);

      const { container } = render(<HtmlEditor ytext={ytext} awareness={awareness} />);
      // Default mode is preview, so the iframe is present.
      const iframe = () => container.querySelector('iframe')!;

      await act(async () => { ytext.insert(0, '<p>shared</p>'); });
      await act(async () => { vi.advanceTimersByTime(400); });

      expect(iframe().getAttribute('srcdoc')).toBe('<p>shared</p>');
    } finally {
      vi.useRealTimers();
    }
  });
});
```

(The other tests don't use fake timers; isolate `useFakeTimers()` inside the one test that needs it via try/finally so it doesn't leak into other tests.)

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
import type { FileMetadata } from '../hooks/useFolderMetadata';

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

`FileMetadata` is exported from `lens-editor/src/hooks/useFolderMetadata.ts:8` (relay-api.ts re-imports from there, but doesn't re-export). Import from the source, not the re-importer.

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

Add a third menu item to `CreateMenu` and a new `handleInstantCreateHtml` in `Sidebar`. The plumbing path is **Sidebar → FileTreeProvider value → FileTreeContext → FileTreeNode → CreateMenu** (callbacks come through React context, not direct props).

**Files:**
- Create: `lens-editor/src/lib/untitled-name.ts` — pure helper, testable
- Create: `lens-editor/src/lib/untitled-name.test.ts`
- Modify: `lens-editor/src/components/Sidebar/CreateMenu.tsx`
- Modify: `lens-editor/src/components/Sidebar/FileTreeContext.tsx` — add `onCreateHtmlDocument` field
- Modify: `lens-editor/src/components/Sidebar/FileTreeNode.tsx` — forward context callback to `CreateMenu`
- Modify: `lens-editor/src/components/Sidebar/Sidebar.tsx` — add `handleInstantCreateHtml`, pass via FileTreeProvider value

- [ ] **Step 1: Inspect the wiring**

Read these to confirm the context-mediated callback flow:
- `FileTreeContext.tsx` — defines `FileTreeContextValue` interface with the existing `onCreateDocument` / `onCreateFolder` fields.
- `FileTreeNode.tsx:5,19,218–223` — uses `useFileTreeContext()`, then passes `ctx.onCreateDocument` / `ctx.onCreateFolder` to `<CreateMenu>`.
- `Sidebar.tsx:344–353` — wraps the tree in `<FileTreeProvider value={{ ... onCreateDocument: handleInstantCreate, ... }}>`.

The Sticky-Scroll overlay (`StickyScrollOverlay.tsx`) ALSO reads `ctx.onCreateDocument` / `ctx.onCreateFolder` to render its hover icons. For v1 we are intentionally NOT adding an HTML quick-create icon to the sticky overlay — keep that overlay unchanged and accept that the "New HTML File" option is reachable only through the regular per-folder `+` menu.

- [ ] **Step 2: Write the failing test for `nextUntitledHtmlName`**

**Convention note:** `folderPath` here is a **prefixed virtual path** (e.g. `/Lens` or `/Lens/Notes`), matching the existing `generateUntitledName(folderPath, metadata)` helper at `lens-editor/src/lib/multi-folder-utils.ts:70`. The merged `metadata` object is also keyed by prefixed paths (e.g. `/Lens/foo.md`). We mirror that helper's algorithm so call sites in `Sidebar.tsx` can use both interchangeably.

Create `lens-editor/src/lib/untitled-name.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { nextUntitledHtmlName } from './untitled-name';

describe('nextUntitledHtmlName', () => {
  it('returns "Untitled.html" when no collision', () => {
    expect(nextUntitledHtmlName('/Lens', {})).toBe('Untitled.html');
    expect(nextUntitledHtmlName('/Lens/Notes', {})).toBe('Untitled.html');
  });

  it('returns "Untitled 1.html" when "Untitled.html" already exists in the folder', () => {
    expect(
      nextUntitledHtmlName('/Lens', { '/Lens/Untitled.html': {} as any })
    ).toBe('Untitled 1.html');
  });

  it('returns "Untitled 2.html" when both "Untitled.html" and "Untitled 1.html" exist', () => {
    expect(
      nextUntitledHtmlName('/Lens', {
        '/Lens/Untitled.html':   {} as any,
        '/Lens/Untitled 1.html': {} as any,
      })
    ).toBe('Untitled 2.html');
  });

  it('ignores collisions in other folders (prefix-scoped)', () => {
    expect(
      nextUntitledHtmlName('/Lens/Notes', {
        '/Lens/Untitled.html':       {} as any,  // different folder, irrelevant
        '/Lens/Notes/Untitled.html': {} as any,  // collision in target folder
      })
    ).toBe('Untitled 1.html');
  });

  it('ignores entries in deeper subfolders (only direct children count)', () => {
    expect(
      nextUntitledHtmlName('/Lens', {
        '/Lens/Notes/Untitled.html': {} as any,  // subfolder child, not a sibling
      })
    ).toBe('Untitled.html');
  });

  it('ignores collisions on differently-suffixed files (e.g. .md)', () => {
    expect(nextUntitledHtmlName('/Lens', { '/Lens/Untitled.md': {} as any })).toBe('Untitled.html');
  });

  it('handles folderPath with trailing slash', () => {
    expect(
      nextUntitledHtmlName('/Lens/', { '/Lens/Untitled.html': {} as any })
    ).toBe('Untitled 1.html');
  });

  it('returns "Untitled.html" when only "Untitled 1.html" exists (fills lowest gap)', () => {
    // Matches existing generateUntitledName convention: take next-sequential from 0,
    // don't fill gaps higher up.
    expect(
      nextUntitledHtmlName('/Lens', { '/Lens/Untitled 1.html': {} as any })
    ).toBe('Untitled.html');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd lens-editor && npm run test:run -- untitled-name
```

Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement `nextUntitledHtmlName`**

Create `lens-editor/src/lib/untitled-name.ts`:

```ts
/**
 * Find the next available "Untitled.html" name in `folderPath`, avoiding
 * collisions with direct-child entries in `metadata`. Mirrors `generateUntitledName`
 * (multi-folder-utils.ts) but with the `.html` extension.
 *
 * @param folderPath - The PREFIXED folder path, e.g. "/Lens" or "/Lens/Notes".
 * @param metadata   - Merged folder metadata, keyed by prefixed virtual paths.
 * @returns Just the basename, e.g. "Untitled.html" or "Untitled 1.html".
 *          Callers join it onto folderPath to produce the full path.
 */
export function nextUntitledHtmlName(
  folderPath: string,
  metadata: Record<string, unknown>,
): string {
  const prefix = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;

  // Only direct children of folderPath (no nested descendants).
  const existing = new Set(
    Object.keys(metadata)
      .filter((p) => p.startsWith(prefix))
      .map((p) => p.slice(prefix.length).split('/')[0])
  );

  if (!existing.has('Untitled.html')) return 'Untitled.html';
  for (let i = 1; ; i++) {
    const candidate = `Untitled ${i}.html`;
    if (!existing.has(candidate)) return candidate;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd lens-editor && npm run test:run -- untitled-name
```

Expected: all six tests PASS.

- [ ] **Step 6: Extend `FileTreeContextValue`**

In `lens-editor/src/components/Sidebar/FileTreeContext.tsx`, add one field to the interface (alongside the existing `onCreateDocument` / `onCreateFolder`):

```ts
export interface FileTreeContextValue {
  // ... existing fields unchanged ...
  onCreateDocument?: (folderPath: string) => void;
  onCreateHtmlDocument?: (folderPath: string) => void;  // NEW
  onCreateFolder?: (folderPath: string) => void;
  // ... existing fields unchanged ...
}
```

- [ ] **Step 7: Forward the new callback in `FileTreeNode.tsx`**

In `lens-editor/src/components/Sidebar/FileTreeNode.tsx`, find the `<CreateMenu ... />` invocation around line 220 and add a third prop:

```tsx
<CreateMenu
  folderName={node.data.name}
  onCreateDocument={ctx.onCreateDocument ? () => ctx.onCreateDocument!(node.data.path) : undefined}
  onCreateHtmlDocument={ctx.onCreateHtmlDocument ? () => ctx.onCreateHtmlDocument!(node.data.path) : undefined}
  onCreateFolder={ctx.onCreateFolder ? () => ctx.onCreateFolder!(node.data.path) : undefined}
/>
```

Also update the guard that wraps the menu (currently `{isFolder && (ctx.onCreateDocument || ctx.onCreateFolder) && (...)}` at line 218) to include the new callback:

```tsx
{isFolder && (ctx.onCreateDocument || ctx.onCreateHtmlDocument || ctx.onCreateFolder) && (
  <CreateMenu ... />
)}
```

- [ ] **Step 8: Extend `CreateMenu` props and UI**

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

- [ ] **Step 9: Add `handleInstantCreateHtml` to `Sidebar.tsx`**

In `lens-editor/src/components/Sidebar/Sidebar.tsx`:

1. Add the import at the top:

```tsx
import { nextUntitledHtmlName } from '../../lib/untitled-name';
```

2. After the existing `handleInstantCreate` (around line 145–175), add this — note that `nextUntitledHtmlName` takes the **prefixed** `folderPath` (just like `generateUntitledName` does in `handleInstantCreate`), while the actual filesystem path is built from `originalFolderPath`:

```tsx
const handleInstantCreateHtml = useCallback(async (folderPath: string) => {
  const folderName = getFolderNameFromPath(folderPath, folderNames);
  if (!folderName) return;
  const doc = folderDocs.get(folderName);
  if (!doc) return;

  const originalFolderPath = getOriginalPath(folderPath, folderName);
  const baseName = nextUntitledHtmlName(folderPath, metadata);  // PREFIXED, not original
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

3. Pass the new handler through `FileTreeProvider`. Find the `<FileTreeProvider value={{ ... }}>` block (around line 344) and add one field to the value object:

```tsx
<FileTreeProvider
  value={{
    editingPath,
    onEditingChange: setEditingPath,
    onRequestRename: (path) => setEditingPath(path),
    onRequestDelete: (path, name) => setDeleteTarget({ path, name }),
    onRequestMove: handleMoveRequest,
    onRenameSubmit: handleRenameSubmit,
    onCreateDocument: handleInstantCreate,
    onCreateHtmlDocument: handleInstantCreateHtml,  // NEW
    onCreateFolder: handleCreateFolder,
    onOpenNewTab: handleOpenNewTab,
    activeDocId,
  }}
>
```

- [ ] **Step 10: Verify end-to-end wiring**

```bash
cd lens-editor && npm run build 2>&1 | tail -20
```

Expected: clean TypeScript build. There is no unit test for the wiring chain (existing `handleInstantCreate` is also untested; we test the pure pieces — `nextUntitledHtmlName`, `writeFileMeta`, `pickEditor` — and verify the wiring manually in Task 11's smoke test).

- [ ] **Step 11: Commit**

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

  it('treats only the last segment of a multi-dot extension', () => {
    // 'archive.tar.gz' has ext '.gz' under lastIndexOf semantics. We document this:
    // the user gets 'backup.gz', not 'backup.tar.gz'. That matches Finder/Explorer rename
    // behavior on most platforms and is acceptable for v1.
    expect(renamePreservingExtension('archive.tar.gz', 'backup')).toBe('backup.gz');
  });

  it('the typed extension wins even if it differs from the old extension', () => {
    expect(renamePreservingExtension('page.html', 'page2.md')).toBe('page2.md');
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
