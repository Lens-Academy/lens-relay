# Filemeta Corruption Analysis — 2026-02-23

## Summary

The **Lens** folder's filemeta_v0 Y.Map contained corrupted entries that caused the Obsidian Relay plugin to enter an infinite `moveFolder` loop, crashing Obsidian via OOM. The corruption has been cleaned up, but **6 files in the `/Chris/` subfolder were destroyed** by the crash loop before cleanup could run. These files need to be restored.

## Timeline

| Time (UTC) | Event |
|------------|-------|
| Unknown | Bogus `"/"` and `"//"` folder entries written to Lens filemeta (root cause unknown) |
| ~15:51 | Obsidian plugin syncs Lens folder, sees `"//"` folder, starts moveFolder loop |
| 15:51:27 | Last git-sync commit with `/Chris/` folder intact |
| 15:52:09 | First git-sync commit with `/Chris/` files moved to root — crash loop in action |
| 15:52–17:51 | Rapid auto-sync commits (every ~12s) as crash loop oscillates files |
| 17:13:19 | Obsidian log shows continuous `moveFolder` calls (log start we have) |
| ~17:20 | Cleanup script removes `//` and `///` entries from production R2 |
| ~17:25 | Hetzner relay restarted with clean data |
| ~17:50 | User opens editor.lensacademy.org — `/Chris/` folder missing |
| Post-cleanup | Filemeta has 69 clean entries, 0 path issues, but 6 Chris/ files gone |

## What We Found

### Corrupted data in production R2 (Lens folder)

Dumped via `scripts/dump-filemeta.mjs` against production R2 data (`lens-relay-storage` bucket, copied into `lens-relay-dev` for safe inspection).

**85 total entries** in filemeta_v0 before cleanup. **15 were corrupted** — 7 files each duplicated at corrupted path depths, plus 2 bogus folder entries.

**Two bogus folder entries at vault root:**

```
"/"  → { type: "folder", version: 0, id: "6c968d63-7529-4f50-b568-bfba1246320d" }
"//" → { type: "folder", version: 0, id: "6c968d63-7529-4f50-b568-bfba1246320d" }
```

**7 files with corrupted duplicate paths** (the files originally lived under `/Chris/` — see "Data Loss" below):

| Original path | Corrupted copy 1 | Corrupted copy 2 |
|---|---|---|
| `/Chris's log.md` | `//Chris's log.md` | `///Chris's log.md` |
| `/LLM prompts.md` | `//LLM prompts.md` | `///LLM prompts.md` |
| `/meeting notes - week 3 materials.md` | `//meeting notes...` | `///meeting notes...` |
| `/project management.md` | `//project management.md` | `///project management.md` |
| `/testN.md` | `//testN.md` | `///testN.md` |
| `/Week 2 meeting export.md` | `//Week 2...` | `///Week 2...` |
| `/Week 3 meeting import.md` | `//Week 3...` | `///Week 3...` |

Note: by the time we dumped, these files had already been moved from `/Chris/X.md` to `/X.md` by the crash loop. The `//` and `///` entries are cascade damage from the oscillation.

### The `/Chris/` folder was real

The `/Chris/` subfolder in the Lens vault was a **legitimate folder with 6 files**, confirmed by the `Lens-Academy/lens-folder-relay` git history:

```
Chris/
  Chris's log.md
  LLM prompts.md
  Week 2 meeting export.md
  Week 3 meeting import.md
  meeting notes - week 3 materials.md
  project management.md
```

Last intact commit: `42213a82ac2a` (2026-02-23 15:51:27 UTC).

The folder UUID `6c968d63-7529-4f50-b568-bfba1246320d` is shared with the `/Chris` folder in Lens Edu. Whether this was intentional (same folder in both vaults) or a data leak is unclear — but the files under it in the Lens vault were real and actively used.

### The crash mechanism

1. Plugin sees `"//"` folder entry, normalizes it to `"/"` via `moveFolder`
2. `moveFolder` moves every child file: `/Chris/X.md` → `/X.md` (writing to filemeta Y.Map)
3. Each Y.Map `set()` triggers the observer
4. Observer sees path change, calls `moveFolder` in the opposite direction
5. Infinite loop: `// → /` then `/ → //` then `// → /` ...
6. Each cycle writes files × 2 maps Y.Map mutations, growing memory until OOM

### Data loss from the crash loop

The moveFolder loop moved all 6 `/Chris/` files to root (`/Chris's log.md` → root-level `Chris's log.md`). Subsequent oscillations then deleted or overwrote the filemeta entries. After our cleanup of `//` and `///` entries, these 6 files have **no filemeta entry at all** — neither at `/Chris/X.md` nor at `/X.md`.

The `/Chris/` folder entry itself was also destroyed (it was at path `"/"` which our cleanup correctly removed, and the correct `/Chris` path was never written).

**`/testN.md` was the sole survivor** — it already existed at root level, so the crash loop's move was a no-op for it.

### Obsidian log analysis

The user provided the start of the Obsidian log. Key finding: the crash loop starts **immediately on sync** at 17:13:19 UTC. No external trigger visible — the corrupted data was pre-existing in R2 when the plugin connected. The loop was already running by the first log entries.

### `move_document` code review

A code review of `link_indexer.rs` found:
- The HTTP handler validates `new_path` starts with `/` and ends with `.md` — this blocks `"/"` as a path for file moves
- But `move_document` core function has no internal path validation
- `extract_filemeta_fields()` copies ALL fields including `type: "folder"`, enabling folder entries to be moved as files
- Cross-folder moves use two separate Y.Doc transactions (not atomic)

**Conclusion:** `move_document` is probably NOT the direct cause (HTTP validation blocks it), but has defense-in-depth gaps. Most likely origin is the Obsidian plugin writing directly to the Y.Map via CRDT sync.

### Lens Edu folder is clean

230 entries, zero path issues.

## Cleanup Performed

### Production R2 cleanup (2026-02-23 ~17:20 UTC)

Ran `scripts/cleanup-filemeta.mjs` against production R2 with `--commit`:
- Removed 8 corrupted entries from filemeta_v0 (2 folder entries + 6 file duplicates)
- Removed 7 corrupted entries from docs legacy map
- Verified zero path issues remain

Sequence: stop Hetzner relay → run cleanup via local relay with prod R2 → verify clean → restart Hetzner relay.

**Post-cleanup state:** 69 entries in filemeta_v0, 63 in docs legacy, 0 path issues. But 6 `/Chris/` files are missing (no filemeta entries, though their Y.Doc content documents may still exist in R2).

## Still To Do

### Restore `/Chris/` folder and 6 files

The filemeta entries for the `/Chris/` folder and its 6 files need to be re-created. File content Y.Docs likely still exist in R2 (keyed by their UUIDs). The file UUIDs and content can be recovered from:

- **Git history:** `Lens-Academy/lens-folder-relay` commit `42213a82ac2a` has the file contents
- **R2:** Content Y.Docs keyed by `<relay-id>-<file-uuid>` may still exist

Approach: write a restore script that creates the filemeta + legacy docs entries, pointing at the existing content Y.Doc UUIDs (if still in R2) or creating new content docs from git history.

### Preventive: validate paths before writing

Add path validation in `move_document` (Rust) and `renameDocument`/`createDocument` (TypeScript) to reject paths that:
- Start with `//`
- Equal `"/"`
- Contain empty path segments

## Tools Created

- `lens-editor/scripts/dump-filemeta.mjs` — connects to running relay via WebSocket, dumps filemeta_v0 and legacy docs with path issue detection
- `lens-editor/scripts/cleanup-filemeta.mjs` — connects via WebSocket, finds and removes corrupted entries (dry-run by default, `--commit` to apply)
- `lens-editor/scripts/dump-filemeta-file.mjs` — reads `data.ysweet` files directly; handles CBOR format

## R2 State

- Production R2 (`lens-relay-storage`) — cleaned, 6 `/Chris/` files need restoration
- Dev R2 (`lens-relay-dev`) — copy of production (may be stale)
- Previous dev R2 backup: `~/code/lens-relay/r2-backup-dev-20260223/`
- Feb 12 production backup: `~/backups/r2-lens-relay-storage-20260212/`
- Feb 23 dev R2 backup: `~/code/lens-relay/r2-backup-20260223/`
