# Backlinks Architecture - Research Findings

Compiled from 7 parallel research agents on 2026-02-04.

---

## 1. Code Review Summary

**Agent:** Architecture document review + relay-server code verification

### Critical Gap
**Folder-doc relationship is undefined.** The server has no way to know which content doc belongs to which folder. This blocks the entire implementation.

### Edge Cases Identified
1. **Concurrent renames** - Two users rename same file simultaneously
2. **Circular references** - A links to B, B links to A, rename A
3. **Self-links** - Document linking to itself
4. **Link syntax variations** - `[[Note]]`, `[[Note#Section]]`, `[[Note|Alias]]` need different handling
5. **Deleted documents** - Links TO deleted docs become broken
6. **Renamed folders** - Path-based resolution implications

### Implementation Issues
1. **Proposed Rust code is incorrect** - API doesn't match actual codebase
2. **No origin tracking** - Server edits would trigger the indexer again (infinite loop risk)
3. **Startup full-scan could block** - Loading many docs takes time

### Recommended Phase Order
Original: Indexer → Rename → Display
Suggested: **Folder mapping → Indexer → Display → Rename** (rename is hardest, do last)

---

## 2. Folder-Doc Mapping

**Agent:** Research how to map content documents to parent folders

### Problem
- Folder docs: `{RELAY_ID}-{FOLDER_ID}` containing file metadata
- Content docs: `{RELAY_ID}-{DOC_UUID}` containing markdown
- **Missing:** No way to know which folder a content doc belongs to

### Three Solutions

| Solution | Approach | Lookup | Obsidian Safe |
|----------|----------|--------|---------------|
| **1. Embedded Parent** | Store `folder_id` in each content doc's metadata | O(1) | No - extra field |
| **2. Server-Side Registry** | Persistent index `doc_uuid → folder_id` | O(1) | Yes |
| **3. Lazy Cache** | On-demand cache with TTL | O(1) after first | Yes |

### Recommendation: Solution 2 (Server-Side Registry)

```json
// document_folder_index.json
{
  "076d2f81-...": "fbd5eb54-...",
  "0c95356e-...": "fbd5eb54-..."
}
```

**Why:**
- O(1) lookup guaranteed
- Obsidian compatible (no doc changes)
- Syncs when folder metadata changes
- Already have state files pattern in relay-git-sync

**Build trigger:** When folder metadata (`filemeta_v0`) changes, scan and update the index.

---

## 3. Wikilink Resolution Algorithm

**Agent:** Research how Obsidian resolves wikilinks

### Obsidian's Three-Tier Priority System

1. **Exact filename match** (case-insensitive)
   - `[[note]]`, `[[Note]]`, `[[NOTE]]` all match `Note.md`

2. **Normalized matching**
   - Spaces, hyphens, underscores treated as equivalent
   - `[[my-note]]` matches `my note.md`, `my_note.md`

3. **Path-based disambiguation**
   - `[[folder/Note]]` → matches `folder/Note.md`
   - **Root files have priority** over nested files
   - `[[A]]` with both `A.md` and `Folder/A.md` → resolves to root `A.md`

### Proposed Algorithm

```
RESOLVE_WIKILINK(linktext, source_path):
  1. Parse linktext:
     - Extract: [path/]basename[#anchor][^blockid][|alias]

  2. EXACT MATCH (case-insensitive)
     - Normalize: lowercase, trim whitespace
     - If exactly 1 match → return it
     - If 0 or >1 → continue

  3. PATH-BASED (if path provided in link)
     - Match normalized_path/normalized_basename
     - If exactly 1 match → return it

  4. NORMALIZED MATCH
     - Treat spaces/hyphens/underscores as equivalent
     - If exactly 1 match → return it

  5. DISAMBIGUATION
     - Among matches, prefer shallowest path (closest to root)
     - If still ambiguous → return UNRESOLVED

  6. ANCHOR VERIFICATION
     - If #anchor or ^blockid, verify exists in target
```

### Edge Cases to Handle
- `[[Note#Section]]` - heading anchors (preserve on rename)
- `[[Note|Display Text]]` - aliases (preserve on rename: `[[New|Display Text]]`)
- `[[Note^blockid]]` - block references
- Unicode, accents, special characters
- Case sensitivity varies by OS

---

## 4. Atomic Rename Transactions

**Agent:** Research transaction patterns for multi-document CRDT updates

### Key Constraint: No Rollback in Y.js

> "Contrary to other databases that support transactions, Yjs' transactions can't be cancelled."

**You cannot build ACID transactions on CRDTs.** This is fundamental to their design.

### Recommended Strategy: Three-Stage Pipeline

```
Stage 1: METADATA RENAME (Atomic - single Y.js transaction)
├─ Rename file in filemeta_v0
├─ Update legacy docs map
├─ Fail-fast if this fails
└─ This is the source of truth

Stage 2: DISCOVERY (Async - read-only)
├─ Find all docs containing [[Old Name]]
├─ Build update list
└─ Can be done in parallel

Stage 3: LINK UPDATES (Best-effort - multiple transactions)
├─ Update each doc independently
├─ Collect successes/failures
├─ Report partial results
├─ Allow manual retry for failures
└─ Make each update idempotent
```

### Error Handling

| Stage | On Failure |
|-------|-----------|
| Stage 1 (metadata) | Fail completely, nothing changed |
| Stage 3 (links) | Continue, report failures, allow retry |

### Why Partial Success is OK
- **Metadata is consistent** - single source of truth for filename
- **Links converge eventually** - CRDT design handles this
- **Old links still work** - same doc UUID, just different display name
- **Failures are visible** - UI shows what failed, allows retry
- **Idempotent updates** - safe to retry

---

## 5. Index Bootstrapping

**Agent:** Research startup indexing patterns for ~105 documents

### Time Estimates

| Scenario | Time |
|----------|------|
| Sequential (worst case) | ~39 seconds |
| Sequential (realistic) | ~20-25 seconds |
| Parallel batches of 10 | ~25-35 seconds |

### Recommendation: Background Indexing with Hybrid Approach

**Don't block startup. Show partial results immediately.**

```
Timeline:
─────────────────────────────────────────────────────
T=0ms:     Page loads
T=100ms:   Folder metadata synced, file tree visible
T=500ms:   Editor ready, user can work
T=200ms:   Backlinks for CURRENT doc ready (lazy load)
T+25s:     Full index complete in background
```

### Three-Phase Strategy

**Phase 1: Quick Start (0-500ms)**
- Load folder metadata
- UI ready with file tree
- User can navigate immediately

**Phase 2: Hybrid Backlinks (immediate + background)**
```typescript
// Lazy-load backlinks for currently open doc (~200ms)
async function getBacklinksForCurrentDoc(docId: string) {
  if (cache.has(docId)) return cache.get(docId);
  const doc = await loadYDoc(docId);
  const backlinks = parseBacklinks(doc);
  cache.set(docId, backlinks);
  return backlinks;
}

// Background: process all docs in batches
startBackgroundIndexing(folderDoc, {
  batchSize: 5,
  concurrent: 3,
  onProgress: (completed, total) => {
    emit('backlinks:indexing-progress', { completed, total });
  }
});
```

**Phase 3: Event-Driven Updates**
- Watch `filemeta_v0` for changes
- Re-index affected documents
- Keep index fresh incrementally

### Progress Reporting
```typescript
window.dispatchEvent(new CustomEvent('backlinks:indexing-progress', {
  detail: { completed: 50, total: 105, percent: 48 }
}));
```

---

## 6. CRDT Edit Conflicts (Rename Race Condition)

**Agent:** Research concurrent edit safety for rename scenarios

### Scenario
1. User A renames file, server starts updating links in doc X
2. User B simultaneously edits doc X
3. Both changes need to merge correctly

### Verdict: MOSTLY SAFE (85% confidence)

Y.js CRDT guarantees prevent data loss. The merge will converge correctly.

### How Y.js Handles Concurrent Edits
- Each character has unique ID: `{client_id, clock}`
- Tie-breaking uses client ID ordering
- **Commutative**: `merge(A,B) = merge(B,A)` - order doesn't matter
- Result is deterministic regardless of network arrival order

### Example That Works
```
Original: "[[Old.md]] some text"

Server applies:    "[[New.md]] some text"
User B applies:    "[[Old.md]] some text here"

Merged result: "[[New.md]] some text here"  ✓
```

### Key Risks & Mitigations

| Risk | Problem | Mitigation |
|------|---------|------------|
| **Position drift** | Server's position 0 is now position 500 | Search by text pattern, not absolute position |
| **Delete-then-insert race** | Concurrent delete + insert can diverge | Wrap in `transact()` for atomicity |
| **Stale server state** | Server has old doc version | Re-read doc, retry if anchor text not found |
| **Partial multi-doc update** | Some links updated, others not | Metadata rename is atomic; link updates are best-effort |

### Critical Recommendation: Use Text Search, Not Positions

```rust
// UNSAFE - position can drift if doc changed
text.delete(txn, 0, 8);

// SAFE - find the actual text first
let content = text.get_string(&txn);
if let Some(pos) = content.find("[[Old.md]]") {
    text.delete(txn, pos as u32, 10);
    text.insert(txn, pos as u32, "[[New.md]]");
}
```

---

## 7. Surgical Y.Text Edits

**Agent:** Research how to edit Y.Text without losing CRDT history

### The Problem

```rust
// LOSES ALL CRDT HISTORY - every character becomes "from server"
text.remove_range(txn, 0, content.len());
text.insert(txn, 0, &updated);
```

This blanks out authorship info for the entire document.

### Solution: Surgical Delta Operations

Y.js supports targeted insert/delete that preserves surrounding CRDT history:

**Rust (yrs):**
```rust
fn surgical_replace(text: &TextRef, txn: &mut Transaction,
                   old: &str, new: &str) {
    let content = text.get_string(&txn);
    if let Some(index) = content.find(old) {
        // Only affects the specific characters
        text.delete(txn, index as u32, old.len() as u32);
        text.insert(txn, index as u32, new);
    }
}
```

**TypeScript (Delta format):**
```typescript
// Replace [[Old]] with [[New]] at specific position
ytext.applyDelta([
  { retain: startPos },      // Skip unchanged text
  { delete: oldLength },     // Remove [[Old]]
  { insert: '[[New]]' }      // Insert replacement
]);
```

### Why This Preserves History
- Only touches the specific characters being replaced
- Surrounding text keeps original authorship attribution
- CRDT tombstones track deletions properly
- Each character retains its `{client_id, clock}` identity

### API Summary

| API | Purpose | CRDT-Safe |
|-----|---------|-----------|
| `text.insert(pos, str)` | Insert at position | ✅ Single point |
| `text.delete(pos, len)` | Delete range | ✅ Single range |
| `ytext.applyDelta([...])` | Quill Delta operations | ✅ Surgical |
| `text.remove_range(0, len)` + `insert(0, new)` | Full replace | ❌ Loses history |

---

## Summary: Key Decisions

| Topic | Decision |
|-------|----------|
| **Folder-doc mapping** | Server-side registry (`doc_uuid → folder_id`) |
| **Wikilink resolution** | Obsidian-compatible: exact → normalized → path-based → root priority |
| **Transaction strategy** | Metadata atomic, link updates best-effort with retry |
| **Index bootstrapping** | Background indexing, lazy-load current doc immediately |
| **CRDT safety** | Safe if using text search (not positions) and `transact()` |
| **Surgical edits** | Use targeted `delete()` + `insert()`, not full replace |

## Updated Implementation Order

Based on research findings:

1. **Folder-doc registry** - Prerequisite for everything
2. **Link parser + resolver** - Obsidian-compatible algorithm
3. **Debounced indexer** - Background, event-driven
4. **Backlinks display** - Client reads index (validates infra)
5. **Rename detection** - Watch `filemeta_v0` for path changes
6. **Link updating** - Surgical edits, best-effort with retry

---

## Sources

Research compiled from:
- Y.js documentation and source code
- Obsidian forum discussions and API docs
- CRDT academic literature (Kleppmann, Jahns)
- Distributed systems patterns (Saga pattern)
- relay-server codebase analysis
- Production examples (Notion, Roam, Logseq, Dendron, Zed)
