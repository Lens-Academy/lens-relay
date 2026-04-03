# JSON File Support

**Date:** 2026-04-02

## Context

The Lens Edu relay folder contains 49+ JSON files (`video_transcripts/*.timestamps.json`). These are stored as binary blobs in R2 (type `"file"` in filemeta_v0, with `hash` pointing to R2 content). They sync to GitHub via relay-git-sync's full folder sync.

Currently: no way to view them in lens-editor, and MCP tools are hardcoded to markdown only.

## Design

### Storage model

JSON files remain binary blobs. No Y.Text, no CriticMarkup. Content lives in R2, accessed via `/f/:doc_id/download-url` (read) and `/f/:doc_id/upload-url` (write). The hash in filemeta_v0 is updated on every write.

### Lens Editor: read-only JSON viewer

- Detect file type from filemeta_v0 `type` field + file extension
- When opening a `.json` file: fetch blob via download URL, render in CodeMirror with `@codemirror/lang-json` in read-only mode
- Same editor pane as markdown, just different language extension and editing disabled
- File tree already shows all filemeta entries; just make JSON files clickable/openable

### MCP `create` tool changes

- Lift the `.md`-only restriction on `file_path`
- For `.json` files:
  - Upload content as blob to R2 via the file upload API
  - Set filemeta_v0 entry with `type: "file"`, computed SHA256 `hash`
  - No Y.Doc `contents` Y.Text created
  - No CriticMarkup wrapping
- For `.md` files: behavior unchanged

### MCP `read` tool changes

- Detect file extension
- For `.json`: fetch blob content from R2, return in cat -n format
- No CriticMarkup processing (no accepted view, no pending summary)
- Still records doc as "read" in session for edit enforcement

### MCP `edit` tool changes

- Detect file extension
- For `.json`:
  - Fetch current blob content from R2
  - Apply `old_string` / `new_string` text replacement on raw content
  - Upload entire new blob to R2
  - Update hash in filemeta_v0
  - No CriticMarkup
- Still enforces read-before-edit

### MCP `move` tool

Already type-agnostic (updates filemeta path + legacy docs map). No changes needed.

### MCP `glob` tool

Already matches all filemeta paths. No changes needed.

### MCP `grep` tool

Currently only searches Y.Text content. Needs to also fetch blob content for non-markdown files to search against regex patterns. Performance consideration: blob fetch is an HTTP round-trip per file, so grep across many blob files will be slower than Y.Text grep.

### What this does NOT include

- No real-time collaborative editing (blobs, not CRDTs)
- No JSON validation or schema enforcement
- No explicit `type: "json"` in filemeta (uses existing `type: "file"`)
- No new file types beyond JSON (but the plumbing generalizes to any text-based blob)

## Key implementation details

### Blob read path (used by editor, MCP read, MCP edit)

1. Resolve path via DocumentResolver to get doc_id + filemeta metadata
2. Get file hash from filemeta_v0
3. Call `/f/:doc_id/download-url` to get presigned R2 URL
4. Fetch content from presigned URL
5. Return as string

### Blob write path (used by MCP create, MCP edit)

1. Compute SHA256 of new content
2. Call `/f/:doc_id/upload-url` with hash + content type
3. Upload content to presigned URL
4. Update filemeta_v0 entry with new hash

### File type detection

Branch on file extension: `.md` = markdown path (Y.Text + CriticMarkup), `.json` = blob path. The filemeta `type` field stays `"file"` for JSON (matching Obsidian's behavior).
