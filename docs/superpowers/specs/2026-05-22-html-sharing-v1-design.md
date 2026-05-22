# HTML Sharing in Lens (v1)

**Date:** 2026-05-22

## Context

The team wants to share HTML pages with each other in the same way they share Markdown documents — collaboratively, with live preview, through Lens. The first concrete use case is sharing exported Claude/Codex conversation transcripts (see `/home/penguin/code/incoming-files/jsonl2html.py`), but the design is not specific to that exporter — we expect to share other kinds of HTML over time (reports, dashboards, mockups, etc.).

Today the relay supports two storage shapes:

- **Y.Text-backed content documents** — `.md` files. The folder's `filemeta_v0` entry has `type: "file"` with no hash, and content lives in a `Y.Text('contents')` in a content Y.Doc. Real-time multi-user collaborative editing works via yCollab; CriticMarkup comments/suggestions live inline in the text.
- **Blobs** — currently `.json` files. The folder entry has `type: "file"` with a `hash` pointing to R2 content. Read-only viewer in Lens, no collaborative editing.

HTML *could* be stored either way. We chose Y.Text because:

1. We want collaborative edits and shared cursors, just like Markdown.
2. We want a foundation that comments and suggestions can build on later (v2/v3 of this work).
3. The relay-git-sync container already syncs Y.Text content files to GitHub as plain text — `.html` files will sync for free.

This spec covers **v1 only**: storage, editor UI, preview rendering, and creation flows. Comments and suggestions are explicitly deferred to v2/v3 and are sketched at the end as future work, but v1 must not paint v2 into a corner.

## Design

### Storage model

`.html` files use the same shape as `.md` files. No new shapes are introduced.

- Folder Y.Doc `filemeta_v0` entry:
  ```json
  "/page.html": { "id": "<uuid>", "type": "file", "version": 0 }
  ```
  No `hash`. The absence of `hash` is the existing marker that distinguishes Y.Text-backed files from blobs.
- Content Y.Doc: `Y.Text('contents')` contains the full HTML string as plain text.
- `.html` extension on the path is the routing signal throughout the stack (consistent with how `.md` is detected today).

### Server changes (`crates/relay/`)

Three small changes:

#### `mcp/tools/create_doc.rs`

Today the tool branches on `blob::is_blob_file(file_path)`: `.json` paths go through `create_blob_file` (R2 blob); everything else falls into the Markdown path, which then rejects anything not ending in `.md` (line 27: `if !file_path.ends_with(".md")`).

For `.html`, route through the **Markdown path**, not the blob path. The change is to broaden the extension check to allow `.html` as well as `.md`, and use the same `server.create_document(...)` call. The resulting document has a `Y.Text('contents')` and a `filemeta_v0` entry with `type: "file"` (no hash). No CriticMarkup wrapping — CriticMarkup is a Markdown-only concern.

Also update the error message on the extension check to list all accepted extensions.

#### `link_indexer.rs`

Skip `.html` files in v1. Reason: wikilink extraction over raw HTML would produce false-positive matches inside attribute values, script bodies, and style blocks. We can revisit in a later phase with an HTML-aware extractor that only walks text nodes. Filter at the entry point of the per-file indexing routine.

#### `server.rs` `/doc/upsert`

Verify that the existing `create_document_direct` path correctly handles `.html` (it already creates a `Y.Text` content doc and `type: "file"` filemeta entry for non-`.md` paths). Add a regression test for the `.html` extension end-to-end.

The doc resolver, search index, blob handling, watchdog, and webhook paths require no changes — they are extension-agnostic.

### Lens editor changes (`lens-editor/`)

#### Routing (`src/App.tsx`)

Current routing logic (around line 249):

```ts
const isBlobFile = fileEntry?.type === 'file' && fileEntry?.hash;
// ...
if (isBlobFile && fileEntry?.hash && filePath) { return <BlobDocumentView ... /> }
// otherwise → Markdown editor
```

New routing:

- `type === 'file' && hash` → `BlobDocumentView` (unchanged)
- `path.endsWith('.html')` → `HtmlEditor` (new)
- otherwise → Markdown editor (unchanged)

#### New component: `HtmlEditor`

Lives at `src/components/HtmlEditor/`. Three subcomponents:

- **`HtmlEditor.tsx`** — owns the three-mode state (`'source' | 'preview' | 'split'`), renders a mode toggle, and lays out the chosen panes. Default mode on open is `preview`. Mode state is in-memory; not persisted across reloads in v1.
- **`HtmlSourceEditor.tsx`** — CodeMirror 6 with `@codemirror/lang-html`, bound to `Y.Text('contents')` via yCollab. Mirrors the existing Markdown editor's setup but swaps the language extension and drops Markdown-specific decorations (CriticMarkup parser, comment margin, etc.).
- **`HtmlPreview.tsx`** — single `<iframe sandbox="allow-scripts">` whose `srcdoc` is set from `Y.Text('contents')`. Debounced regeneration: srcdoc is updated 300ms after the last edit to avoid re-running user scripts on every keystroke. No bridge script is injected in v1 (the bridge becomes relevant in v2).

#### Preview sandbox and scripts

The preview iframe uses `sandbox="allow-scripts"` and **no other tokens** — in particular, no `allow-same-origin`, no `allow-top-navigation`, no `allow-popups`, no `allow-modals`, no `allow-forms`.

Consequences:

- User scripts execute (jsonl2html.py output works as designed).
- Iframe runs in an opaque origin: cannot read parent DOM, cannot access cookies/localStorage of the Lens editor, cannot redirect the top window, cannot open popups, cannot display modals.
- External resources (CSS, images, fonts, CDN scripts) load normally.
- Communication with the parent is only possible via `postMessage` (unused in v1; reserved for v2).

Trust model: HTML is authored by trusted teammates. Scripts inside the iframe can read iframe DOM and `fetch()` arbitrary external origins (potential exfiltration / network abuse) but cannot escalate into the Lens editor's session.

#### Mode toggle

A segmented control with `Source | Preview | Split` buttons. The existing `SegmentedToggle` component (`src/components/SegmentedToggle/`) should be reused if its API fits; otherwise model after the existing `SourceModeToggle` / `SuggestionModeToggle` components.

#### Split layout

Vertical divider, source on the left, preview on the right, resizable. Use whatever resizable-panels primitive is already present in lens-editor (or a small wrapper around it); do not introduce a new dependency if an existing one works.

#### Sidebar changes

- **`CreateMenu.tsx`** — add an "HTML file" option that creates `Untitled.html`.
- **`Sidebar.tsx`** — the rename path currently auto-appends `.md` to typed names without an extension. Change it to **preserve the existing file's extension** when the user does not supply one (so renaming `page.html` to `page2` yields `page2.html`, and renaming `notes.md` to `notes2` yields `notes2.md`). If the user types an extension, use what they typed.
- **File-tree icon** — pick a visually distinct icon for `.html` files. `FileCode` from lucide-react is a good default.

#### Dependencies

Add `@codemirror/lang-html` to `lens-editor/package.json`. No HTML sanitizer is needed — the iframe sandbox handles isolation.

### Data flow

```
User edits source pane
  → CodeMirror updates Y.Text('contents')
  → yCollab broadcasts CRDT delta over relay WebSocket
  → All peers' source panes update via yCollab
  → All peers' preview panes debounce 300ms, then regenerate iframe srcdoc
  → User's scripts re-execute in fresh sandboxed context (opaque origin)
```

Preview rebuilds are full reloads of the iframe (set `srcdoc` to a new string). Stateful scripts (timers, animations, scroll position inside the iframe) reset on every rebuild. This is acceptable for v1; see "Future work" for mitigations.

### Error handling

- **Malformed HTML:** browsers are tolerant; preview renders best-effort. No validation in Lens.
- **Scripts that crash:** errors land in iframe DevTools console; not surfaced to Lens UI.
- **External resource failures:** visible in iframe network tab; not surfaced.
- **yCollab conflicts:** handled by Yjs CRDT, same as Markdown.
- **Preview reload mid-script-execution:** stateful scripts reset on every debounced reload; acceptable in v1.

### Testing

**Server (`crates/relay/`):**

- Unit: `create_doc.rs` accepts `.html` and produces a Y.Text-backed `type: "file"` entry (no hash).
- Unit: `link_indexer.rs` does not attempt wikilink extraction on `.html` files.
- Integration: create `.html` via MCP, read back via API, verify Y.Text contents round-trip through the relay.

**Lens editor (`lens-editor/`):**

- Component test: mode toggle state transitions cover all three modes.
- Component test: `App.tsx` routing picks `HtmlEditor` for `.html` paths and `BlobDocumentView` for hashed files.
- Smoke test: create an `.html` file from the sidebar, type into source pane, observe preview update after debounce.

**Manual / security:**

- Open the output of `jsonl2html.py` as an `.html` file in Lens. Verify:
  - The page renders structurally (turns, `<details>`/`<summary>`).
  - The CDN `marked.js` script loads and the `div.md` blocks render as Markdown.
  - Inline `onclick` handlers (expand/collapse buttons) work.
- Inject a `<script>` into an `.html` file that attempts `window.parent.document`. Verify it throws (cross-origin), confirming the sandbox is in effect.
- Open the same `.html` doc in two browser tabs. Edit in one; verify the other's source and preview both update.

## Out of scope (v1) / Future work

The following are deliberately deferred to keep v1 small. None of them should require rework of v1 architecture.

- **v2: Comments on HTML.** Comments stored as HTML-native marker pairs in the source (`<!--lens-comment-start:id-->...<!--lens-comment-end:id-->`). A Lens-controlled bridge script is injected at the top of `srcdoc` and exposes a `postMessage` RPC for parent ↔ iframe DOM queries (find selection, highlight range, report scroll position). New comments are placed via a best-guess-plus-probe-verification flow with a split-source confirmation fallback (see prior brainstorming in this thread for the full sketch).
- **v3: Suggestions on HTML.** Either a marker-pair scheme parallel to comments, or a separate metadata Y.Map. Out of scope here.
- **Transform plugins.** A pre-render pipeline for known document types (e.g., pre-rendering Markdown blocks in `jsonl2html.py` output) so they render even if scripts are blocked. Useful if we ever add a "render without scripts" toggle.
- **HTML link indexer.** Walk text nodes only and extract `[[wikilinks]]`, so HTML files can participate in backlinks.
- **Scroll sync.** Requires the bridge script; defer to v2.
- **Persisted per-document mode preference.** v1 always opens in preview.
- **Search snippet cleanup.** `.html` files will show up in full-text search with raw tag noise in snippets. Acceptable in v1; cleaner stripping is a polish item.
- **Obsidian / Relay.md plugin compatibility.** The server supports `type: "file"` without a hash, so `.html` Y.Text docs should not break sync, but we have not verified how Relay.md renders them. Investigate when there is demand.

## Key decisions (locked)

- **Storage:** Y.Text (not blob).
- **Preview isolation:** `<iframe sandbox="allow-scripts">`, no other tokens.
- **Scripts:** allowed (user's choice, given trusted-team trust model).
- **Editor layout:** three-mode toggle (source / preview / split).
- **Default mode on open:** preview.
- **Preview debounce:** 300ms after last edit.
- **File icon:** lucide-react `FileCode`.
- **Rename behavior:** preserve existing extension if user types no extension.
- **External resources in preview:** allowed.
- **Obsidian compatibility:** out of scope for v1.
- **Link indexer:** skips `.html` in v1.
