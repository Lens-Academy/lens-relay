# Production Promotion From Lens Editor

## Goal

Editors should be able to promote selected course files from the autosynced `staging` branch to production `main` from inside Lens Editor. Promotion is file-based, not commit-based: the messy autosync history on `staging` is ignored, and the system creates a clean promotion branch from `main` containing only the selected file snapshots from the latest `staging` branch at promotion time.

## Context

Today the authoring path is:

1. Editors edit course content in Lens Editor.
2. Relay sync writes changes to GitHub `staging` roughly every 10 seconds.
3. The production platform pulls `staging` and validates content.
4. Humans open GitHub and create a PR from `staging` to `main` when ready.

This works for full-branch promotion, but not for promoting one course page or a small selected set of pages. Because `staging` history is autosync-driven, cherry-picking commits is the wrong abstraction. A single file may be spread across many commits, and one commit may touch several files.

## Product Design

### Document Page Status

Every editable document page should show whether the current file is equal to production:

- `Identical to production`: the file snapshot on `staging` matches `main`.
- `Different from production`: both branches have the file, but contents differ.
- `Not in production yet`: the file exists on `staging` but not on `main`.
- `Deleted in staging`: the file exists on `main` but not on `staging`.
- `Checking...`: status request is in flight.
- `Unable to check`: promotion backend cannot compute the status.

When the current file is different from production, the header shows a `Promote to production` control. The control offers:

- `This file`: open a confirmation modal for the current file.
- `Multiple files`: navigate to the promotion overview page with the current file preselected.

For document pages, “different from production” includes `modified`, `added`, and `renamed`. A document that has been deleted on `staging` normally cannot be opened in Lens Editor, so `Deleted in staging` is primarily an overview-page status.

When the file is identical, the control should be a passive status indicator and should not open a promotion action.

### Single-File Promotion

The single-file confirmation modal shows:

- file path
- status
- additions and deletions versus `main`
- a `View diff` action
- a confirm action that creates a promotion PR

On success, the modal shows the created PR URL and the branch name. The PR should have auto-merge enabled so it merges when CI and branch protection requirements pass.

### Multi-File Promotion Overview

The promotion overview route should be `/promote`.

The page lists only files that differ between `staging` and `main`. Files that are identical are excluded. The current document, when the page was opened from a document page, is preselected.

Each row shows:

- checkbox
- path
- status: added, modified, deleted, renamed when detectable
- additions and deletions
- `View diff`
- `Open in editor` when the file exists in Lens Editor metadata; this uses the existing path-to-document metadata lookup and `urlForDoc` navigation

The page has:

- search/filter by path
- selected count
- `Create promotion PR`
- refresh action that reloads the diff from the current `staging` and `main`

The create action sends selected paths to the backend. The backend fetches latest `main` and `staging` at promotion time, then promotes the selected file snapshots from the latest `staging`.

### Diff Viewing

Version 1 should expose text diffs inside Lens Editor but keep the implementation simple:

- `GET /api/promotion/diff?path={repoPath}`
- render unified diff text with additions and deletions styled
- for binary/blob/image files, show a non-text diff message with file status plus blob object IDs and file sizes before/after when Git can provide them

The GitHub PR remains the final review surface. Rich side-by-side rendering or read-only production document rendering is not required for the first implementation.

## Backend Design

The Lens Editor production server owns all GitHub and Git operations. The browser never receives GitHub credentials and never shells out.

### Storage

The backend keeps a scratch local Git clone of the course repo in a persistent writable directory, for example:

```txt
PROMOTION_REPO_DIR=/data/lens-editor/promotion-repos/lens-edu-relay
```

This clone is not the production platform's deployment checkout and is not the relay-git-sync checkout. It is only a workspace for computing diffs and creating promotion branches.

The clone must be safe to reuse across requests. Git operations are serialized with a process-local mutex so simultaneous promotions do not corrupt the checkout. The implementation can start with one process-local lock because the production Lens Editor server currently runs as a single Node process.

The promotion system must not touch the existing `relay-git-sync` service. It must not read from or write to the relay-git-sync data directory, reuse its working checkout, reuse its SSH key material, restart or signal its container, or push to the `staging` branch it owns. Promotion uses its own scratch clone and credentials only.

### Configuration

Required environment variables:

```txt
PROMOTION_ENABLED=true
PROMOTION_REPO_URL=git@github.com:Lens-Academy/lens-edu-relay.git
PROMOTION_REPO_DIR=/data/lens-editor/promotion-repos/lens-edu-relay
PROMOTION_MAIN_BRANCH=main
PROMOTION_STAGING_BRANCH=staging
PROMOTION_BRANCH_PREFIX=promote/lens-editor
PROMOTION_MERGE_METHOD=SQUASH
PROMOTION_GITHUB_OWNER=Lens-Academy
PROMOTION_GITHUB_REPO=lens-edu-relay
GITHUB_TOKEN=github_pat_with_pull_request_and_automerge_permissions
```

If `PROMOTION_ENABLED` is not true, all promotion endpoints return JSON `404` so the UI can hide the feature. If `PROMOTION_ENABLED=true` but required configuration is missing or invalid, endpoints return JSON `503` with a user-facing configuration error so operators can distinguish disabled promotion from a broken rollout.

`PROMOTION_MERGE_METHOD` defaults to `SQUASH` but should be configurable as `SQUASH`, `MERGE`, or `REBASE` to match repository policy.

### API

All endpoints require a valid Lens Editor share token with edit access. View-only users cannot see or execute promotion actions.

#### `GET /api/promotion/changes`

Fetches `main` and `staging`, computes changed files, and returns:

```json
{
  "mainSha": "abc123...",
  "generatedAt": "2026-06-27T12:00:00.000Z",
  "files": [
    {
      "path": "Courses/Intro.md",
      "oldPath": null,
      "status": "modified",
      "additions": 12,
      "deletions": 4,
      "isBinary": false
    }
  ]
}
```

Files identical between branches are omitted.

#### `GET /api/promotion/status?path={repoPath}`

Fetches the branch heads and returns status for one path:

```json
{
  "path": "Courses/Intro.md",
  "mainSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "status": "modified",
  "additions": 12,
  "deletions": 4,
  "isBinary": false
}
```

If the path is identical, status is `identical`.

#### `GET /api/promotion/diff?path={repoPath}`

Fetches the branch heads and returns a unified diff for one file from current `main` to current `staging`:

```json
{
  "path": "Courses/Intro.md",
  "mainSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "status": "modified",
  "isBinary": false,
  "diff": "@@ -1,3 +1,4 @@\n-old\n+new\n"
}
```

#### `POST /api/promotion/pr`

Creates a promotion branch and PR:

```json
{
  "paths": ["Courses/Intro.md", "Courses/Second.md"],
  "title": "Promote selected course files"
}
```

Response:

```json
{
  "branch": "promote/lens-editor/20260627-120000-a1b2c3",
  "prNumber": 42,
  "prUrl": "https://github.com/Lens-Academy/lens-edu-relay/pull/42",
  "mainSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "autoMergeEnabled": true
}
```

The backend:

1. Fetches `main` and `staging`.
2. Records the fetched `origin/staging` commit SHA for audit in the PR body and API response.
3. Creates a new local branch from latest `origin/main`.
4. For each selected path:
   - if the file exists at latest `origin/staging`, restore that path from `origin/staging`;
   - if the file does not exist at latest `origin/staging` but exists on `main`, remove it;
   - if the path is a rename, the selected row promotes both the old-path deletion and new-path addition together.
5. Verifies that only requested paths changed.
6. Commits with a message that records the source staging SHA used by the backend.
7. Pushes the promotion branch.
8. Opens a PR against `main`.
9. Enables GitHub auto-merge.

If selected paths produce no diff against latest `main`, the API returns `409` with a message explaining that there is nothing to promote.

### Git Commands

The local Git implementation should use non-interactive commands through `child_process.spawnFile` or an equivalent safe wrapper. Shell interpolation must not be used for paths.

Core commands:

```bash
git fetch origin main staging --prune
git rev-parse origin/main
git rev-parse origin/staging
git diff --name-status --find-renames origin/main..origin/staging
git diff --numstat origin/main..origin/staging
git diff -- path
git switch -C branch origin/main
git restore --source=origin/staging -- path
git rm -- path
git status --porcelain
git commit -m "Promote selected course files"
git push origin branch
```

The GitHub API is used for PR creation and auto-merge. Auto-merge requires repository branch protection and a token with permission to enable it.

## Safety And Permissions

Promotion endpoints must require edit access. The frontend should also hide promotion controls for view-only users, but backend authorization is authoritative.

The server must validate all requested paths:

- non-empty relative paths only
- no absolute paths
- no `..` path segments
- path must be present in the latest diff between `main` and `staging`
- path count capped, initially 100

The server must never push to `staging`. It may push only branches matching `PROMOTION_BRANCH_PREFIX`.

Repository policy note: project docs say not to push directly to `Lens-Academy/lens-edu-relay` because `relay-git-sync` owns `staging`. This feature does not mutate `staging`; it creates short-lived promotion branches from `main`. Before production rollout, confirm that pushing promotion branches to the same repo is allowed. If not, use a GitHub App or fork as the push target while still opening PRs against `main`. This decision is a rollout gate, not an implementation afterthought.

Operational isolation from `relay-git-sync` is a hard requirement. Promotion deployment must use separate environment variables, separate filesystem paths, and separate credentials. Any implementation path that shells into or modifies the `relay-git-sync` container is out of scope.

## UI Integration

The feature fits existing Lens Editor structure:

- `App.tsx` adds a `/promote` route.
- `EditorArea.tsx` renders the document status and promotion action in the existing header controls portal.
- A new client API module wraps `/api/promotion/*`.
- A new promotion page component owns multi-file selection and PR creation.
- A compact diff component renders unified diff text.

The UI should avoid blocking editing. Status checks can be stale for a short period. The backend re-fetches branches on promotion and uses the latest `staging` contents at the moment the PR is created.

## Error Handling

Expected user-facing errors:

- promotion disabled
- user lacks edit access
- GitHub token missing or insufficient
- selected files no longer differ from `main`
- path validation failure
- promotion enabled but server configuration is incomplete
- CI auto-merge could not be enabled

When PR creation succeeds but auto-merge fails, the API returns success with `autoMergeEnabled: false` and a warning. The PR link remains the recovery path.

## Testing

Server tests should use temporary Git repositories with local remotes to verify:

- changed-file listing excludes identical files
- single-file status returns identical, modified, added, and deleted
- diff endpoint uses the latest fetched `staging`
- promotion branch contains only selected files
- delete promotion removes selected files
- path validation blocks traversal and unrelated paths
- auto-merge failure still returns the PR URL when PR creation succeeded

Client tests should verify:

- document status renders correct labels
- promote action is hidden for view-only users
- single-file flow sends the current path only
- overview page lists only changed files
- current file is preselected from route state or query param
- PR success state links to GitHub

## Out Of Scope

- hunk-level promotion inside a file
- editing production/main content from Lens Editor
- replacing GitHub PR review
- moving relay-git-sync or production platform deployment logic
- changing autosync cadence from Lens Editor to GitHub
- creating a branch-per-editor authoring model

## Key Decisions

- Promotion is whole-file only in version 1.
- Backend uses a local scratch Git clone for simplicity and debuggability.
- The backend promotes from latest `staging` at PR creation time.
- Auto-merge is enabled automatically after PR creation.
- The first diff UI is unified text diff, not a rich rendered document comparison.
