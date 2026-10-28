# Purging text from relay-git-sync history: what git-sync already does (Strata, 2026-10-23)

Context: Luc (standup 2026-10-20) blocks editor history for the Lens folder because transcripts are
sometimes uploaded before scrubbing, so the text stays in git. Lauren's question: can a history
rewrite happen without git-sync downtime or relay changes?

## Facts (checked 2026-10-23)
- relay-server never touches git. relay-git-sync (container `relay-git-sync`, patched Python mounted
  from `/root/relay-git-sync-data/*.py`) owns one checkout per folder under
  `repos/<relay-id>/<folder-id>/` and pushes it.
- git-sync stores NO commit shas: `state/<relay>/` holds per-doc content hashes, state vectors,
  per-path bookkeeping. Rewritten commits do not confuse its state.
- Each cycle (`persistence.py` `_pull_from_remote`, ~line 1068): fetch; if behind>0 and ahead>0,
  `git pull --rebase origin <branch>`; on conflict, `_resolve_conflicts_in_our_favor` then
  `rebase --continue`; if that fails, `rebase --abort` and MERGE.
- The Lens folder checkout has `core.logAllRefUpdates=true` and a live reflog on `origin/main`
  (`update by push` entries).

## Experiment (`docs/plans/2026-10-23-git-rewrite-sim.sh`; run it in an empty directory)
Remote rewritten by filter-branch to drop a SECRET line from every commit; git-sync's clone meanwhile
made one new local commit; then git-sync's own sequence (fetch, `pull --rebase origin main`).
Result: only the new local commit was replayed onto the rewritten history; SECRET count in
`git log -p main` = 0. git's fork-point (reflog of the remote-tracking ref) recognised the old
commits as already upstream.

## So
1. A rewrite = rewrite GitHub (force-push), nothing else. git-sync's next cycle rebases onto it with no
   downtime and no code change, as long as its reflog of `origin/<branch>` covers the old tip.
2. The hole is the MERGE fallback (line ~1136): a merge joins the old history back in and the next
   push re-publishes the text. Lauren's proposed fallback (undo rebase, force-push local) has the same
   effect: it reverts the purge.
3. Proposed fallback instead: `git reset --hard origin/<branch>`, then commit the relay's current files
   on top. The relay is the source of truth, so only the per-commit granularity of unpushed local
   commits is lost. Never merge, never force-push from git-sync.
4. Copies a purge must still reach: GitHub's cached unreachable commits (GitHub Support,
   "removing sensitive data"), other clones (e.g. stale `~/lens/lens-folder-relay` on flowerbox),
   R2 backups (`lens-relay-backups`, hourly/daily/weekly doc snapshots).
5. Cheaper first: close the upload-then-scrub paths. Luc's Fireflies agent and Hamza's Team call
   recordings both scrub BEFORE upload; the leak needs a path that uploads first.

Not tested: the conflict path (a local-only commit touching a rewritten line), GitPython's fetch vs
CLI fetch for reflog updates (the live reflog shows push updates; fetch updates not yet observed).
