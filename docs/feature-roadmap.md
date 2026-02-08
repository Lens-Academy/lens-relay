# Lens Editor Feature Roadmap

> Summary of planned features and their integration requirements with relay-server.

## Decision Context

Given that **Custom AuthZ** requires forking relay-server, most features will be implemented natively in Rust rather than as webhook consumers/sidecars. This simplifies architecture and enables atomic transactions.

---

## 1. Backlinks

**Goal:** Display which documents link to the currently open document.

**Status:** Phase 1-2 complete (client-side UI). Phase 3 (server-side indexer) in planning.

**How it works:**
- Server observes document changes
- Extracts wikilinks from markdown content (`[[Page Name]]`, `[[Page#Section]]`, `[[Page|Alias]]`)
- Maintains `backlinks_v0` Y.Map in each document's folder doc
- Client subscribes to `backlinks_v0` for real-time updates

**Integration:** Native (relay-server fork)
- Needs atomic writes across Y.Docs
- Benefits from real-time observer pattern
- Already have TypeScript link extractor to port to Rust

**Open questions:**
- Debounce strategy for rapid edits
- Performance with large vaults (1000+ documents)

---

## 2. Content Validation for Course Creators

**Goal:** Fast feedback on content formatting. Shorter feedback loop than current GitHub Actions workflow.

**How it works:**
- Validate markdown structure, frontmatter, required sections
- Single-file validation (instant, client-side possible)
- Cross-file validation (references, UUID uniqueness, excerpts - requires all files)

**Integration:** Hybrid
- **Client-side:** Instant single-file checks (CodeMirror linting)
- **Server-side:** On-demand full validation (button trigger, not continuous)

**Key constraints:**
- Current validator is batch/top-down (load all → validate all)
- Real-time incremental validation would require rewrite (1-2 weeks)
- 4GB Hetzner box could strain under frequent full-vault validation

**Open questions:**
- How much value does partial (single-file) validation provide?
- Acceptable latency for full validation (seconds? minutes?)
- Which source of truth: Relay (R2), GitHub, or Obsidian local?

---

## 3. Search Indexing

**Goal:** Enable keyword search and semantic search across all documents.

**How it works:**
- **Keyword search:** Full-text index of document content
- **Semantic search:** Vector embeddings stored in Pinecone (or similar)
- Index updates when documents change

**Integration:** Sidecar recommended
- Keeps Pinecone SDK / ML dependencies out of relay-server
- Search is read-only, doesn't need atomic transactions
- Can tolerate seconds of index lag

**Architecture:**
```
relay-server → webhook → search-indexer-service → Pinecone
                                                → local full-text index
```

**Open questions:**
- Self-hosted vs. managed vector DB
- Embedding model choice
- Index granularity (whole doc vs. paragraphs vs. headings)

---

## 4. MCP Server

**Goal:** Expose Lens Editor documents to AI assistants via Model Context Protocol.

**How it works:**
- MCP server connects to relay-server via websocket or HTTP
- Exposes tools for reading/searching/editing documents
- AI assistants can query and modify content

**Integration:** Client-like (websocket/HTTP)
- No fork required
- Authenticates like any other client
- Could leverage search indexing for context retrieval

**Open questions:**
- Which MCP tools to expose (read, write, search, list?)
- Permission model for AI access
- Rate limiting / token budgets

---

## 5. Custom AuthZ with Discord OAuth

**Goal:** Fine-grained access control with Discord-based identity.

**How it works:**
- Discord OAuth for user authentication
- File or folder-level permissions with role hierarchy:
  - **View only** - Read access
  - **View + comments** - Read + annotation
  - **View + comments + suggestions** - Read + annotation + proposed edits
  - **Full write** - Complete edit access

**Integration:** Native (relay-server fork) - **REQUIRED**
- Must intercept every read/write request
- Cannot be implemented via webhooks
- This is the forcing function for forking

**Architecture considerations:**
- Permission checks on document access (not just at connection time)
- Folder-level permissions cascade to children
- Need to store permission mappings (Discord role → document access level)

**Open questions:**
- Permission storage: in Y.Doc metadata? External DB? Config file?
- How to handle permission changes mid-session?
- Admin UI for managing permissions
- Guest/anonymous access policy

---

## Integration Summary

| Feature | Integration Type | Reason |
|---------|-----------------|--------|
| Backlinks | Native | Atomic transactions, real-time |
| Content Validation | Hybrid | Client for instant, server for batch |
| Search Indexing | Sidecar | Keep dependencies isolated |
| MCP Server | Client-like | Standard API access |
| Custom AuthZ | Native (required) | Must intercept all requests |

---

## Implementation Order (Suggested)

1. **Backlinks** - High visibility, already partially implemented (Phase 1-2 done)
2. **Search Indexing** - Enables discovery in large vaults
3. **Content Validation** - Quality-of-life for course creators
4. **MCP Server** - AI integration
5. **Custom AuthZ** - When multi-user access needed (currently bypassed with token)

*Note: AuthZ was originally first but is deferred since current token-based bypass is acceptable for now.*

---

## Technical Decisions Pending

1. **Rust learning curve** - User has no Rust experience. LLM assistance mitigates but doesn't eliminate.

2. **Fork maintenance strategy** - How to track upstream relay-server changes and merge selectively.

3. **Deployment architecture** - Single binary with all features vs. relay-server + sidecars.

4. **Testing strategy** - Integration tests against real Y-Sweet/Relay vs. mocked Y.Docs.
