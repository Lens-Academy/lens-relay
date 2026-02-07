# Collaborative Wiki Editor: Architecture Decisions

This document captures the key architectural considerations for building a collaborative wiki editor with AI-powered suggestions, track changes, and real-time sync.

---

## 1. Yjs Sync Backend

### Options Evaluated

| Backend | Protocol | Multiplexing | Persistence | License | Notes |
|---------|----------|--------------|-------------|---------|-------|
| **y-sweet** | Standard y-websocket | ❌ 1 WS per doc | S3 | MIT | Simple, Rust-based, Jamsocket-maintained |
| **Hocuspocus v2** | Proprietary | ✅ Many docs per WS | Extensible | MIT | Tiptap ecosystem, more complex |
| **y-websocket** | Standard | ❌ | In-memory only | MIT | Reference implementation, single-node |
| **y-redis / yhub** | Standard | ✅ | Redis | AGPL | Scalable but license concerns |
| **Liveblocks** | Proprietary | ✅ | Managed | Proprietary | No self-hosting option |

### Decision: y-sweet

**Rationale:**
- MIT licensed, fully self-hostable
- S3 persistence built-in (Cloudflare R2, Backblaze B2)
- Simpler than Hocuspocus, fewer moving parts
- Standard y-websocket protocol = swappable later if needed
- Same foundation as Relay (Obsidian sync plugin)

**Trade-off accepted:** One WebSocket per document. For reasonable scale (tens of users, not hundreds simultaneously with dozens of docs each), this is manageable. Browser connection limits (6-256 per origin) could become a concern at scale.

**Fallback:** Hocuspocus v2 if multiplexing becomes necessary, though this locks us into their proprietary protocol.

---

## 2. Yjs Data Format

### Y.Text vs Y.XmlFragment

| Aspect | Y.Text | Y.XmlFragment |
|--------|--------|---------------|
| **Model** | Linear character sequence | Tree of nodes |
| **Maps to** | Plain markdown | ProseMirror/Tiptap document |
| **LLM output** | Native (LLMs produce text) | Requires parsing layer |
| **Git-friendly** | ✅ Human-readable export | ❌ Schema-dependent |
| **Editor options** | CodeMirror, Monaco | Tiptap, ProseMirror, BlockNote |
| **Suggestion tracking** | CriticMarkup syntax | Custom marks/nodes in schema |
| **Complexity** | Lower | Higher |

### Decision: Y.Text with Plain Markdown

**Rationale:**
- Maximum compatibility — any text editor works
- LLMs produce text natively, no parsing/conversion needed
- Human-readable, git-friendly exports
- CriticMarkup for suggestions: `{++added++}` `{--deleted--}` `{~~old~>new~~}`
- No schema lock-in

**Trade-offs accepted:**
- Less polished UX (not Notion-like WYSIWYG)
- Concurrent formatting can conflict: `**hello **world** today**`
- Tables, embeds, complex blocks are harder
- Cursor position mapping between raw and rendered views

**When to reconsider:** If target users expect Notion/Google Docs polish and are not technical, Y.XmlFragment + Tiptap would be better.

---

## 3. LLM Integration

### The Core Problem

LLMs produce full text output, not Yjs operations. Need to bridge this gap.

### Approach: Claude Code-style Tool Calls

Inspired by Claude Code's battle-tested `Edit` tool (models are fine-tuned on this schema):

```typescript
interface EditTool {
  file_path: string      // or doc_id for wiki
  old_string: string     // Exact match, must be unique
  new_string: string     // Replacement (empty = delete)
  replace_all?: boolean  // Default false
}
```

**Operations:**
- Replace: `old_string: "foo"`, `new_string: "bar"`
- Delete: `old_string: "foo"`, `new_string: ""`
- Insert: `old_string: "anchor"`, `new_string: "anchor + new content"`

**Conflict handling:** If `old_string` not found (doc changed since LLM read), return error, LLM re-reads and retries. No locking needed — optimistic concurrency.

**Why this works:**
- Claude models are fine-tuned on this schema
- No character positions (LLMs are bad at counting)
- Natural anchoring ("find this text, replace with that")
- Automatic stale-read detection

### AI as Suggestion Author

LLM edits can be wrapped in CriticMarkup for human review rather than applied directly:

```javascript
// Instead of applying edit directly:
// ytext.delete(...); ytext.insert(...)

// Wrap in CriticMarkup for review:
function applyAssuggestion(oldString, newString) {
  if (newString === '') {
    return `{--${oldString}--}`  // Deletion
  } else if (oldString === newString.slice(0, oldString.length)) {
    // Insertion after anchor
    const added = newString.slice(oldString.length)
    return `${oldString}{++${added}++}`
  } else {
    // Replacement
    return `{~~${oldString}~>${newString}~~}`
  }
}
```

Human accepts/rejects suggestions via UI, which then performs the actual Y.Text edit.

### AI Worker Architecture

```
y-sweet server
    ↑     ↑      ↑
    │     │      │
  Human Human  AI Worker
  Browser Browser (Node.js)

AI worker connects as normal Yjs client, applies edits, syncs automatically.
```

---

## 4. Frontend Editor

### Why Not Just Use Hocuspocus + Tiptap?

Tiptap requires Y.XmlFragment (a document tree), not Y.Text (plain text). This means schemas, structured operations, and LLMs needing to output parsed document nodes instead of plain markdown. It's the right choice for Notion-style apps, but we're building something closer to Obsidian.

> **Note:** The entire architecture flows from the **Y.Text vs Y.XmlFragment** decision. Once you choose Y.Text (plain markdown), CodeMirror becomes the natural editor, CriticMarkup becomes the natural suggestion format, and LLM integration becomes trivial. Choose Y.XmlFragment, and you're in Tiptap/ProseMirror territory with schemas, marks, and structured operations.

### What About Hocuspocus + CodeMirror?

This is actually a valid option! Hocuspocus is just a Yjs sync server — it doesn't care whether you use Y.Text or Y.XmlFragment on top.

| | y-sweet | Hocuspocus |
|--|---------|------------|
| Works with Y.Text + CodeMirror | ✅ | ✅ |
| Protocol | Standard y-websocket | Proprietary (v2) |
| Multiplexing | ❌ 1 WS per doc | ✅ Many docs per WS |
| Complexity | Simple (single Rust binary) | More setup (Node.js, extensions) |
| Swap later | Easy (standard protocol) | Harder (locked to Hocuspocus clients) |

**Why we chose y-sweet over Hocuspocus:**
- Simpler deployment
- Standard protocol means we could switch backends later without changing clients
- Multiplexing isn't critical for our expected scale
- If we outgrow y-sweet, we can reassess — migrating to Hocuspocus is possible but would require client changes

### Decision: No Separate Reading Mode

Live preview is sufficient — when cursor is elsewhere, syntax is hidden and it looks rendered. No need to maintain two rendering systems like Obsidian does.

### Options for Y.Text + Markdown

| Editor | Live Preview | Y.Text Support | Extensibility | Notes |
|--------|--------------|----------------|---------------|-------|
| **CodeMirror 6** | Build it | y-codemirror.next | Excellent | Obsidian uses this |
| **Monaco** | ❌ | y-monaco | Good | VS Code engine, heavier |
| **Milkdown** | Built-in | Via y-prosemirror | Plugin system | Markdown-first but uses ProseMirror |

### Decision: CodeMirror 6

**Rationale:**
- Natural fit for Y.Text (plain text model)
- Obsidian proves the live preview pattern works
- Excellent extension system
- Active development, battle-tested

### Obsidian-style Live Preview

Obsidian uses CodeMirror 6 with decorations that hide/show syntax based on cursor position:

```
Cursor away:    "Hello"     (rendered bold)
Cursor on it:   "**Hello**" (syntax visible)
```

This is achievable with CM6's decoration API:
- Parse syntax tree (lezer-markdown)
- Apply `Decoration.replace()` to hide syntax when cursor elsewhere
- Apply `Decoration.mark()` for styling

---

## 5. Features to Build

### Core (MVP)

| Feature | Approach |
|---------|----------|
| Collaborative editing | y-sweet + y-codemirror |
| Live preview (Obsidian-style) | CM6 decorations |
| File browser | React sidebar, file tree from API |
| Basic CRUD | Create/rename/delete docs |

### Suggestions & Review

| Feature | Approach |
|---------|----------|
| CriticMarkup parsing | Regex-based parser (inspired by [Obsidian Commentator plugin](https://github.com/Fevol/obsidian-criticmarkup)) |
| Suggestions pane UI | React panel, click to accept/reject |
| CriticMarkup live preview | CM6 extension (highlight, reveal on cursor) |
| AI suggestions | LLM tool calls → CriticMarkup |

### Navigation & Linking

| Feature | Approach |
|---------|----------|
| Table of Contents | Extract headings from Y.Text |
| `@filename` linking | CM6 autocomplete extension |
| UUID-based links | `@[Display Name](file:uuid)` format |
| Link resolution | Store filename→UUID mapping |

### Search

| Feature | Approach |
|---------|----------|
| Filename search | Simple filter on file list |
| Full-text search | Meilisearch or SQLite FTS |
| Vector search (RAG) | Embed chunks → Qdrant/Pinecone |

**Indexing strategy:** On doc update (debounced), extract text from Y.Text, upsert to search index and vector DB.

### Export

| Feature | Approach |
|---------|----------|
| GitHub sync | Periodic export of all docs as `.md` files to configured git repo |

### Permissions

| Level | Can Do |
|-------|--------|
| Read | View only |
| Comment | Add `{>>comments<<}` |
| Suggest | Add CriticMarkup |
| Edit | Direct edits |
| Admin | Change permissions, delete |

**Enforcement:**
- Client-side: UI restrictions based on permission level
- Server-side: y-sweet token includes permission, read-only enforced at protocol level

---

## 6. Recommended Tech Stack

```
┌─────────────────────────────────────────────────────────┐
│                    React App (Vite)                      │
├──────────┬──────────────────────────┬───────────────────┤
│  Sidebar │      Editor Area         │  Right Panel      │
│          │                          │                   │
│  File    │  ┌──────────────────┐   │  Suggestions      │
│  Browser │  │  CodeMirror 6    │   │  (CriticMarkup)   │
│          │  │  + y-codemirror  │   │                   │
│  ToC     │  │  + live preview  │   │  Comments         │
│          │  └──────────────────┘   │                   │
│  Search  │                          │  AI Chat?         │
└──────────┴──────────────────────────┴───────────────────┘

Backend:
├── y-sweet (self-hosted, fly.io or Railway)
├── S3-compatible storage (Cloudflare R2)
├── Meilisearch (full-text search)
├── Qdrant (vector search, optional)
└── Postgres (users, permissions, metadata)
```

---

## 7. Scope Decisions

- **No offline support** — Requires internet connection
- **No version history UI** — Yjs maintains history internally, but no user-facing interface
- **No mobile support** — Desktop/web only
- **GitHub sync** — Periodic export of all docs as `.md` files to a git repo for backup and portability

---

## References

- [y-sweet docs](https://docs.jamsocket.com/y-sweet)
- [CodeMirror 6 docs](https://codemirror.net/docs/)
- [Yjs docs](https://docs.yjs.dev/)
- [CriticMarkup spec](https://criticmarkup.com/)
- [Obsidian Commentator plugin](https://github.com/Fevol/obsidian-criticmarkup) — CriticMarkup implementation for Obsidian
- [Claude Code tools analysis](https://gist.github.com/wong2/e0f34aac66caf890a332f7b6f9e2ba8f)
- [Obsidian developer docs](https://docs.obsidian.md/)
