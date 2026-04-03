# Relay Sync Regression Detector

## Problem

The relay-git-sync service auto-commits Y.Doc content to GitHub repos every ~10-20 seconds. Sometimes sync errors, merge conflicts, or user accidents cause content regressions: changes introduced over many commits are later undone by a subsequent commit. Two confirmed cases:

- `Navigator Training Course.md` — 2,067 bytes of content built over 25 commits, wiped to `_` in a single commit ~29 hours later
- `adam-magyar-stainless-alexanderplatz.md` — 309 bytes built over several commits, wiped to `_` ~22 minutes later

Regressions aren't always full wipes. They can be partial: a few lines added over several commits, then those same lines removed days later.

## Solution

A standalone Python CLI script that analyzes git history to detect content regressions.

## Detection Algorithm

For each file touched within the lookback window:

1. Collect all commits that modified the file, ordered chronologically.
2. For each commit, record the file's git blob hash.
3. Run three detectors:

### Detector 1: Exact Reversion (blob hash match)

If the same blob hash appears at two points in the timeline (commit M and later commit N), and different blob hashes existed in between, the file reverted to a previous exact state.

Cost: hash comparison only — essentially free.

### Detector 2: Near-Exact Reversion (line-set similarity)

For each pair of snapshots (M, N) where N is later than M:

1. Build a set of normalized lines (stripped whitespace) for each snapshot.
2. Compute similarity: `|lines(N) ∩ lines(M)| / |lines(M)|`
3. If similarity ≥ 0.9 (N is ~identical to M), check whether any snapshot between M and N had lines not present in M (i.e., content was added then removed).
4. If yes, flag as a near-exact reversion.

To keep cost manageable:
- Skip pairs where M and N have the same blob hash (already caught by detector 1).
- Only compare N against "distant" snapshots — skip adjacent commits (which are just normal incremental edits).
- Use a minimum gap: only compare snapshots separated by at least N other commits or T time.

### Detector 3: Full Wipe

Special case of detectors 1/2 but with a simpler heuristic:
- File had >50 bytes of content at some point in the window.
- File now has <10 bytes or matches a known empty pattern (`_`, empty, whitespace-only).

This catches wipes even if the file never had this exact empty state before (so blob hash won't match any prior snapshot).

## CLI Interface

```
python detect-regressions.py <repo-path> [options]

Options:
  --days N          Lookback window in days (default: 7)
  --output FORMAT   Output format: text (default), json
  --verbose         Show detailed diff information for each regression
```

## Output Format

### Text (default)

```
Regression detected in: Navigator Training Course.md
  Type: full-wipe
  Reverted at: a6d4fe33 (2026-03-28 15:03:54)
  Content peak: 5fa99787 (2026-03-27 10:16:38) — 2,067 bytes
  Current: 1 byte
  Confidence: high

Regression detected in: Some Other File.md
  Type: exact-reversion
  Reverted at: abc123 (2026-03-25 12:00:00)
  Reverted to state from: def456 (2026-03-20 08:00:00)
  Changes lost: 15 lines added over 23 commits between def456..abc123~1
  Confidence: high
```

### JSON

Array of regression objects with the same fields, for programmatic consumption.

## Target Repos

- `Lens-Academy/lens-folder-relay`
- `Lens-Academy/lens-edu-relay`

Works on any git repo — no relay-specific logic required.

## Performance Considerations

- The lookback window (default 7 days) bounds the analysis. At ~750 commits/week and 112 files, most files have 10-50 commits in the window.
- Detector 1 (blob hash) is O(n) per file where n is commits touching that file — just checking for duplicate hashes.
- Detector 2 (line-set) is the expensive one. Bounded by only running it when detector 1 doesn't fire and only comparing non-adjacent snapshots with a minimum gap.
- Detector 3 (full wipe) is O(1) per file — just check current size vs max size.
- Full file content is only read for detector 2 candidates. Git blob hashes and sizes come from `git ls-tree` which is fast.

## Non-Goals

- Real-time detection or blocking commits
- Partial undo detection (where only a subset of a prior commit's additions are removed as part of normal editing)
- Automatic restoration of reverted content
- Integration with relay-git-sync internals
