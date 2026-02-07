# Backlinks & Link Management Architecture

## Summary

Two related features sharing infrastructure:
1. **Link updating on rename** - When a document is renamed, update all `[[wikilinks]]` pointing to it
2. **Backlinks display** - Show which documents link to the currently open document

**Implementation order:** Indexer → Display → Rename (validate infrastructure before tackling hardest part).

---

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Index storage | **Same Y.Doc** as folder metadata | ✅ Tested: Obsidian ignores unknown Y.Maps |
| Index location | `Y.Map("backlinks_v0")` in folder doc | Reuses existing WebSocket connection |
| Indexing runs | Server-side (relay-server) | Catches edits from Obsidian + Lens Editor |
| Update trigger | Internal hook + debounce | No external webhook complexity |
| Doc manipulation | Direct Y.Doc edits (surgical) | Changes auto-sync; preserves CRDT history |
| Folder-doc mapping | In-memory reverse index | Built from `filemeta_v0` when folder loads |
| Origin tracking | Check `transaction.origin` | Skip re-indexing when origin is "link-indexer" |
| Wikilink syntax | Handle `#` anchors and `|` aliases | Parse: extract target. Rename: preserve suffix |

---

## Architecture Overview

### Storage Structure

```
R2 Storage
├── Folder doc: {RELAY_ID}-{FOLDER_ID}
│   ├── Y.Map("filemeta_v0")   ← file paths → doc UUIDs
│   ├── Y.Map("docs")          ← legacy format
│   └── Y.Map("backlinks_v0")  ← NEW: target UUID → [source UUIDs]
│
└── Content docs: {RELAY_ID}-{DOC_UUID}  (one per file)
    └── Y.Text("contents")     ← markdown content
```

### Backlinks Index Structure

```
Y.Map("backlinks_v0")
├── "target-uuid-1" → ["source-uuid-a", "source-uuid-b"]
├── "target-uuid-2" → ["source-uuid-c"]
└── ...
```

- **Keys**: Document UUIDs (stable across renames)
- **Values**: Arrays of document UUIDs that link TO the key document
- **Lookup**: path → UUID via `filemeta_v0`, then query index

### Folder-Doc Mapping (In-Memory Reverse Index)

**Problem:** Content doc IDs are `{RELAY_ID}-{DOC_UUID}` - no folder ID embedded. When a content doc changes, how does the server know which folder's `backlinks_v0` to update?

**Solution:** Build reverse index in memory when folder docs load.

```
When folder doc loads:
  filemeta_v0 contains: { "Note.md": {id: "abc..."}, "Other.md": {id: "def..."} }
                                    ↓
  Server builds reverse index:  { "abc...": folder_id, "def...": folder_id }

When content doc "abc..." changes:
  Lookup folder_id from reverse index → update that folder's backlinks_v0
```

**Why this works:**
- If someone edits a content doc, they connected to its folder doc first (to see file list)
- Folder doc is already in memory → reverse index already exists
- No separate registry file needed, just in-memory map
- Rebuilt automatically on server restart when folders reconnect

---

## Data Flow

### 1. Index Updates (on document edit)

```
User edits document (Lens Editor or Obsidian)
              ↓
relay-server: observe_update_v1 fires
              ↓
Check transaction.origin:
  - If "link-indexer" → skip (prevents infinite loop)
  - Otherwise → continue
              ↓
Reset debounce timer (2 seconds)
              ↓
... user stops typing ...
              ↓
Timer fires → Link Indexer runs:
  1. text = doc.getText("contents").toString()
  2. links = regex_find_all(r"\[\[([^\]]+)\]\]", text)
  3. Resolve link names → UUIDs via filemeta_v0
  4. Diff against previous links for this doc
  5. Update backlinks_v0 in folder doc
              ↓
Folder doc change syncs to all clients
```

### 2. Link Updating on Rename

**Three-stage approach** (Y.js doesn't support rollback, so use best-effort):

```
Stage 1: METADATA RENAME (Atomic - single transaction)
  User renames "Notes.md" → "My Notes.md"
              ↓
  relay-server: updates filemeta_v0 path
  (Fail-fast: if this fails, nothing changed)

Stage 2: DISCOVERY (Read-only)
              ↓
  Query backlinks_v0: who links to this doc?
  Returns: [doc-A, doc-B, doc-C]

Stage 3: LINK UPDATES (Best-effort - multiple transactions)
              ↓
  For each source doc:
    1. Load Y.Doc (from memory or R2)
    2. Find [[Notes...]] using text search (not positions!)
       - Match [[Notes]], [[Notes#Section]], [[Notes|Alias]], etc.
    3. Surgical replace: [[Notes...]] → [[My Notes...]]
       - Preserve #anchor and |alias suffixes
    4. Changes auto-sync to connected clients
    5. Collect successes/failures
              ↓
  Report results to user (toast/notification)
  Allow retry for failures
```

**Why best-effort:** If updating 10 docs and #7 fails, continue with #8-10. Old links still work (same UUID). User can retry failures. Periodic full reindex catches any stragglers.

### 3. Backlinks Display (client-side)

```
Lens Editor opens document
              ↓
Already connected to folder doc (existing connection)
              ↓
Read backlinks_v0.get(currentDocId)
Returns: ["source-uuid-1", "source-uuid-2"]
              ↓
Resolve UUIDs → paths via filemeta_v0
              ↓
Display in BacklinksPanel
```

---

## Server-Side Implementation (relay-server)

### Components to Add

1. **Link Parser**
   - Regex: `\[\[([^\]]+)\]\]`
   - Extract wikilink targets from markdown
   - Handle `#` anchors: `[[Note#Section]]` → extract "Note"
   - Handle `|` aliases: `[[Note|Display]]` → extract "Note"
   - Combined: `[[Note#Section|Display]]` → extract "Note"
   - Split on `#` or `|`, take the first part

2. **Link Resolver**
   - Convert page names to document UUIDs
   - Uses `filemeta_v0` from folder doc
   - Match logic: exact path match → basename match → case-insensitive

3. **Link Indexer**
   - Debounced update on content doc changes (2 sec)
   - Full reparse (simple, fast enough for typical doc sizes)
   - Diff old vs new links, update backlinks_v0

4. **Rename Detector**
   - Watch `filemeta_v0` for path changes (same UUID, different path)
   - Trigger link updates in affected documents

### Trigger Points

| Event | Action |
|-------|--------|
| Server startup | Full scan of all docs, rebuild index |
| Content doc changes | Debounced reparse + index update |
| Path changes in filemeta_v0 | Detect rename, update links in source docs |
| Doc deleted | Remove from index (as target and source) |

### Direct Y.Doc Manipulation (Surgical Edits)

Server edits documents directly using **surgical find-replace** to preserve CRDT history:

```rust
// Load doc (from memory if active, else from R2)
let dwskv = server.get_or_create_doc(&doc_id).await?;
let awareness = dwskv.awareness();
let guard = awareness.write().unwrap();
let doc = &guard.doc;

// Surgical edit: find and replace specific text (preserves authorship)
let mut txn = doc.transact_mut_with_origin("link-indexer");
let text = txn.get_or_insert_text("contents");
let content = text.get_string(&txn);

// Find each occurrence and replace surgically
let old_link = "[[Old Name]]";
let new_link = "[[New Name]]";
if let Some(pos) = content.find(old_link) {
    text.delete(&mut txn, pos as u32, old_link.len() as u32);
    text.insert(&mut txn, pos as u32, new_link);
}
// Changes auto-sync to connected clients
```

**Why surgical edits matter:**
- Full replace (`remove_range(0, len)` + `insert(0, new)`) loses all CRDT authorship info
- Surgical edit only touches the specific characters, preserving history
- Use `transact_mut_with_origin("link-indexer")` to identify server-generated changes

---

## Client-Side Implementation (Lens Editor)

### Components

1. **useLinkIndex hook**
   ```typescript
   function useLinkIndex(folderId: string): {
     getBacklinks: (docId: string) => string[];
     loading: boolean;
   }
   ```
   - Reads from existing folder doc connection
   - Subscribes to `backlinks_v0` Y.Map changes

2. **BacklinksPanel component**
   - Displays document names linking to current doc (no preview snippets)
   - Clickable items for navigation
   - Shows "No backlinks" when empty

### Integration

```
EditorArea
├── Editor
├── TableOfContents (existing)
└── BacklinksPanel (new)
```

---

## Implementation Phases

### Phase 0: Test Obsidian Y.Map Behavior ✅ COMPLETE

- Added `test_backlinks_v0` Y.Map to folder doc via Debug panel
- Observed: Obsidian ignores it
- Decision: Use same Y.Doc for backlinks index

### Phase 1: Server-Side Link Indexer

1. Add link parser module to relay-server
2. Add debounced observer hook on content doc updates
3. Check `transaction.origin` to skip "link-indexer" changes (prevent infinite loop)
4. Implement `backlinks_v0` Y.Map updates in folder doc
5. Add startup full-scan to rebuild index
6. Test: verify index updates when editing in Lens Editor and Obsidian

### Phase 2: Backlinks Display in Lens Editor

1. Add `useLinkIndex` hook (reads `backlinks_v0` from folder doc)
2. Add BacklinksPanel component (document names only, no snippets)
3. Integrate into EditorArea
4. Style and UX polish
5. Test: validates indexing infrastructure works before tackling rename

### Phase 3: Link Updating on Rename

1. Add rename detector (watch `filemeta_v0` for path changes)
2. Query backlinks index for affected documents
3. Implement batch find-replace via direct Y.Doc manipulation
4. Handle edge cases:
   - Partial matches (`[[Note]]` shouldn't match `[[Notebook]]`)
   - Case sensitivity
   - Anchors: `[[old#section]]` → `[[new#section]]`
   - Aliases: `[[old|display]]` → `[[new|display]]`
5. Notify user of results (success count, failures with retry option)
6. Test: rename file, verify all links update

---

## Open Questions

1. ~~**Folder-doc relationship**~~: ✅ Resolved - in-memory reverse index built from `filemeta_v0`
2. ~~**Unresolved links**~~: Deferred - periodic full reindex catches them once target doc exists
3. ~~**Link context**~~: Deferred - just show document names for now, no preview snippets
4. ~~**Undo support**~~: No - cross-doc undo is complex; rely on CRDT history instead
5. ~~**Circular references**~~: No special handling needed - rename just updates the link text

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Index out of sync | Startup full-scan; periodic full reindex |
| Infinite indexer loop | Check `transaction.origin`, skip "link-indexer" |
| Performance with large docs | Debouncing; regex is fast |
| Concurrent rename conflicts | Lock mechanism during rename |
| Partial rename failures | Notify user; periodic reindex catches stragglers |
| Server restart | Index persisted in folder Y.Doc on R2 |

---

## Background: How Y.Doc Storage Works

For context on the underlying system:

- **Y.Doc** is a CRDT containing operation history, not plain text
- **Storage**: Binary CRDT format in R2, not readable as markdown
- **Y.Text("contents")**: Interface to access text, derived from operations
- **Server and clients**: All hold identical Y.Doc structure
- **Edits anywhere**: Automatically sync via Y.js CRDT merge
- **relay-git-sync**: Extracts plain markdown for GitHub commits
