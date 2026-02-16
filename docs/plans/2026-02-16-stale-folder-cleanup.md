# Stale Folder Doc Cleanup — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Delete 2 stale folder docs and their 57 orphaned content docs from production R2 storage, fix staging config, and verify backlinks work correctly in Lens Edu.

**Architecture:** The production R2 bucket (`lens-relay-storage`) contains 4 folder docs — 2 canonical (actively used by git-sync and Obsidian clients) and 2 stale (leftover from a previous vault share). The stale folder docs cause `find_all_folder_docs()` to return 4 folders instead of 2, creating duplicate folder names in the virtual tree and breaking backlink resolution for Lens Edu. Fix: stop prod server, delete stale docs from R2, start server, fix staging config, verify.

**Tech Stack:** rclone (R2 access), SSH (prod server), relay server (Rust), staging relay.toml

---

## Context

### The Problem

The relay server's `find_all_folder_docs()` detects folder docs by scanning for non-empty `filemeta_v0` maps — NOT by config. This means even though prod config only lists 2 canonical folder UUIDs, the server finds all 4 folder docs and builds a virtual tree with duplicate folder names. Link resolution breaks because two folders named "Lens Edu" (and two named "Lens") create ambiguous paths.

### Folder Doc Inventory

| UUID | Role | Filemeta entries | File size | In git-sync? |
|------|------|-----------------|-----------|-------------|
| `fbd5eb54-73cc-41b0-ac28-2b93d3b4244e` | **Lens (canonical)** | 123 | 70KB | Yes |
| `0cfaf813-05c4-471f-ad4a-f0d1593e7679` | Lens (stale) | 90 | 33KB | No |
| `ea4015da-24af-4d9d-ac49-8c902cb17121` | **Lens Edu (canonical)** | 193 | 83KB | Yes |
| `d538df48-98e8-4ac8-b4f6-6fac3d5ca571` | Lens Edu (stale) | 98 | 47KB | No |

### What Gets Deleted

- 2 stale folder docs (listed above)
- 57 orphaned content docs (referenced only by stale folder docs, zero overlap with canonical — see Task 2 for verification)
- Total: **59 objects** from R2 (each is a `<doc-id>/data.ysweet` file)

### Backups

Both stale docs exist in backups on the prod server:
- `/root/backups/r2-lens-relay-storage-20260216-145445/` (today's backup, 329 docs)
- `/root/r2-backup-20260211-123132/` (Feb 11 backup, 285 docs)

### Files

- **Delete from R2:** 59 doc directories listed in `/tmp/stale-docs-in-r2.txt` on dev VPS
- **Modify:** `crates/relay.staging.toml` (remove 2 stale UUIDs)
- **No changes to:** prod `/root/relay.toml` (already only has 2 canonical UUIDs)
- **Remove after verification:** diagnostic logging in `crates/relay/src/server.rs` (the `for folder_doc_id` block in `startup_reindex`)
- **Keep (bug fix):** channel drain in `spawn_workers()` and `clear_pending()` in `link_indexer.rs` — these are legitimate fixes for the startup message backlog, not diagnostic code

### Dependencies

- `relay-git-sync` is NOT affected — it reads from the relay server via HTTP API and only touches canonical folder UUIDs (`fbd5eb54`, `ea4015da`). No need to stop it.

---

### Task 1: Verify backup integrity

**Step 1: Verify all 59 stale docs exist in backup**

```bash
scp /tmp/stale-docs-in-r2.txt relay-prod:/tmp/stale-docs-to-delete.txt

ssh relay-prod 'missing=0; present=0; while read doc_id; do
  if [ -f "/root/backups/r2-lens-relay-storage-20260216-145445/${doc_id}/data.ysweet" ]; then
    present=$((present+1))
  else
    echo "MISSING: $doc_id"
    missing=$((missing+1))
  fi
done < /tmp/stale-docs-to-delete.txt
echo "Present: $present, Missing: $missing"'
```

Expected: "Present: 59, Missing: 0". If any are missing, assess risk before proceeding — the backup may have been taken before those docs were created.

**Step 2: Confirm backup is a full snapshot**

```bash
ssh relay-prod 'ls /root/backups/r2-lens-relay-storage-20260216-145445/ | wc -l'
```

Expected: 329

---

### Task 2: Verify zero overlap between stale and canonical content

This is the critical safety check. The 57 orphaned content docs must NOT appear in any canonical folder doc's `filemeta_v0`.

**Step 1: Record current R2 object count (baseline)**

```bash
ssh relay-prod 'rclone ls r2:lens-relay-storage/ | wc -l'
```

Expected: 436

**Step 2: Cross-check content UUIDs**

On the dev VPS (where the local relay is running with all docs loaded), verify that the stale content doc IDs have no overlap with canonical docs:

```bash
# All R2 doc IDs
rclone ls r2:lens-relay-storage/ | awk '{print $2}' | sed 's|/data.ysweet||' | sort > /tmp/r2-all-docs.txt

# Remove the 59 stale docs from the full list = canonical docs
grep -v -F -f /tmp/stale-docs-in-r2.txt /tmp/r2-all-docs.txt > /tmp/canonical-docs.txt

# Check overlap: any stale doc IDs that also appear in canonical list?
grep -c -F -f /tmp/stale-docs-in-r2.txt /tmp/canonical-docs.txt
```

Expected: 0 (zero overlap). If non-zero, STOP — some stale docs are also canonical and must not be deleted.

---

### Task 3: Stop production relay server and delete stale docs

The relay server must be stopped BEFORE deleting from R2. Each loaded doc has a `doc_persistence_worker` that calls `sync_kv.persist()` on changes. If the backlink indexer writes to a stale folder doc while the server is running, it will re-create the deleted R2 object.

**Step 1: Stop the relay-server container**

```bash
ssh relay-prod 'cd /root/lens-relay && docker compose -f docker-compose.prod.yaml stop relay-server'
```

Expected: `relay-server` stopped. Other services (cloudflared, relay-git-sync, lens-editor) keep running.

**Step 2: Verify the deletion list on prod**

```bash
ssh relay-prod 'wc -l /tmp/stale-docs-to-delete.txt && head -5 /tmp/stale-docs-to-delete.txt'
```

Expected: 59 lines, all starting with `cb696037-`

**Step 3: Dry run — verify all 59 docs exist in R2 before deleting**

```bash
ssh relay-prod 'found=0; while read doc_id; do
  if rclone ls "r2:lens-relay-storage/${doc_id}/" >/dev/null 2>&1; then
    found=$((found+1))
  else
    echo "NOT IN R2: $doc_id"
  fi
done < /tmp/stale-docs-to-delete.txt
echo "Found in R2: $found of 59"'
```

Expected: "Found in R2: 59 of 59"

**Step 4: Delete from R2**

```bash
ssh relay-prod 'while read doc_id; do
  echo "Deleting: ${doc_id}"
  rclone purge "r2:lens-relay-storage/${doc_id}/"
done < /tmp/stale-docs-to-delete.txt'
```

**Step 5: Verify deletion**

```bash
ssh relay-prod 'rclone ls r2:lens-relay-storage/ | grep -c "0cfaf813\|d538df48"'
```

Expected: 0

```bash
ssh relay-prod 'rclone ls r2:lens-relay-storage/ | wc -l'
```

Expected: 377 (was 436, minus 59)

---

### Task 4: Start production relay server and verify

**Step 1: Start the relay-server container**

```bash
ssh relay-prod 'cd /root/lens-relay && docker compose -f docker-compose.prod.yaml start relay-server'
```

**Step 2: Check startup logs**

```bash
ssh relay-prod 'sleep 15 && docker logs relay-server --since 30s 2>&1 | grep -E "folder doc|Found.*folder|Background workers|Listening"'
```

Expected:
- "Found **2** folder docs for indexing" (was 4 before)
- "Background workers started"
- "Listening on ws://0.0.0.0:8080"

No CRITICAL errors.

---

### Task 5: Fix staging config and sync dev bucket

**File:** `crates/relay.staging.toml`

**Step 1: Remove the 2 stale folder entries**

Remove these blocks:
```toml
[[folders]]
uuid = "0cfaf813-05c4-471f-ad4a-f0d1593e7679"
name = "Lens"

[[folders]]
uuid = "d538df48-98e8-4ac8-b4f6-6fac3d5ca571"
name = "Lens Edu"
```

Keep only:
```toml
[[folders]]
uuid = "fbd5eb54-73cc-41b0-ac28-2b93d3b4244e"
name = "Lens"

[[folders]]
uuid = "ea4015da-24af-4d9d-ac49-8c902cb17121"
name = "Lens Edu"
```

**Step 2: Sync dev R2 bucket from prod (clean copy post-cleanup)**

```bash
rclone sync r2:lens-relay-storage/ r2:lens-relay-dev/ --progress
```

Expected: ~377 objects synced (post-cleanup count). `rclone sync` deletes extraneous files in the destination automatically.

**Step 3: Restart local relay server**

```bash
lsof -ti:8190 | xargs kill 2>/dev/null
sleep 2
CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo run --manifest-path=crates/Cargo.toml --bin relay -- serve -c crates/relay.staging.toml --port 8190 > /tmp/relay-ws2.log 2>&1 &
```

**Step 4: Verify local startup**

```bash
sleep 15 && grep -E 'Folder doc|Found.*folder|Background workers' /tmp/relay-ws2.log
```

Expected:
- Only 2 "Folder doc" lines (Lens with 123 entries, Lens Edu with 193 entries)
- "Found 2 folder docs for indexing"

---

### Task 6: Verify backlinks work in Lens Edu

**Step 1: Check startup backlink resolution**

```bash
grep 'resolved.*links.*targets' /tmp/relay-ws2.log | grep -v '0 targets' | head -10
```

Expected: Lens Edu docs now resolve targets (previously many resolved to 0 targets due to duplicate folder names)

**Step 2: Generate share link and test in browser**

```bash
cd lens-editor && npx tsx scripts/generate-share-link.ts --role edit --folder ea4015da-24af-4d9d-ac49-8c902cb17121 --base-url http://dev.vps:5273
```

Open the link, navigate to a Lens Edu doc with wikilinks, verify the backlinks panel shows entries.

**Step 3: Test live backlink update**

In the editor:
1. Open a Lens Edu doc
2. Add a wikilink to another Lens Edu doc (e.g., `[[Some Article]]`)
3. Open the target doc — verify the backlink appears in the backlinks panel within ~5 seconds

---

### Task 7: Clean up code and commit

**Step 1: Remove the folder doc diagnostic logging**

In `crates/relay/src/server.rs`, remove the `// Log folder doc details for debugging` block inside `startup_reindex()` (the `for folder_doc_id in &folder_doc_ids { ... }` loop that logs folder name and filemeta count).

**Step 2: Rebuild and verify tests pass**

```bash
CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml
```

Expected: 294 tests pass

**Step 3: Commit code changes**

The code changes to commit are:
- Channel drain in `spawn_workers()` (bug fix: prevents 10-minute startup backlog)
- `clear_pending()` method in `link_indexer.rs` (supports the drain fix)
- Staging config fix (2 stale UUIDs removed)
- Diagnostic logging removal

```bash
jj describe -m "fix: drain startup channel backlog and remove stale folder UUIDs from staging config

spawn_workers() now drains buffered link indexer and search index messages
before starting workers. These messages accumulate during doc loading and
startup_reindex but are redundant (startup_reindex already indexes everything
synchronously). Without draining, the worker spent ~10 minutes processing
stale messages before handling live edits.

Also removed 2 stale folder UUIDs from staging config (0cfaf813, d538df48).
The corresponding stale folder docs were deleted from production R2 —
they caused find_all_folder_docs() to return 4 folders instead of 2,
breaking backlink resolution for Lens Edu."
```

---

## Rollback Plan

If anything goes wrong:

**Restore all 59 docs from backup:**
```bash
ssh relay-prod 'while read doc_id; do
  rclone copy "/root/backups/r2-lens-relay-storage-20260216-145445/${doc_id}/" "r2:lens-relay-storage/${doc_id}/"
done < /tmp/stale-docs-to-delete.txt'
```

**Restore just the 2 stale folder docs (minimal):**
```bash
ssh relay-prod 'for doc_id in \
  cb696037-0f72-4e93-8717-4e433129d789-0cfaf813-05c4-471f-ad4a-f0d1593e7679 \
  cb696037-0f72-4e93-8717-4e433129d789-d538df48-98e8-4ac8-b4f6-6fac3d5ca571; do
  rclone copy "/root/backups/r2-lens-relay-storage-20260216-145445/${doc_id}/" "r2:lens-relay-storage/${doc_id}/"
done'
```

Then restart the relay-server container.

**Note:** The deletion list is stored in `/tmp/stale-docs-to-delete.txt` on prod (volatile). For long-term reference, the stale UUIDs are documented in this plan file.
