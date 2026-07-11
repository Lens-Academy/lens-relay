# Asana Autonomous Task Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and launch a local browser application where Luc can review Codex's classifications of all 33 `Dev::Relay&editor` Asana tasks, change selections, and save comments Codex can read.

**Architecture:** A dependency-light Node HTTP server serves a polished static frontend and JSON API. A tracked Asana snapshot/classification file is immutable input; a gitignored review-state file stores Luc's mutable selections and comments through validated atomic writes.

**Tech Stack:** Node.js built-in HTTP/test modules, HTML, CSS, browser JavaScript, Asana MCP, jj.

---

### Task 1: Snapshot and classification

**Files:**
- Create: `tools/asana-task-review/data/tasks.json`

- [ ] Fetch full task details for the 33 matching task GIDs.
- [ ] Classify every task for autonomous fit, visual validation, likely repository, size, confidence, verification, and delivery mode.
- [ ] Validate that the snapshot has 33 unique GIDs and every required classification field.

### Task 2: Review-state service

**Files:**
- Create: `tools/asana-task-review/server.mjs`
- Create: `tools/asana-task-review/server.test.mjs`
- Modify: `.gitignore`

- [ ] Write failing tests for default state, saved selection/comment round trips, unknown GIDs, and invalid payloads.
- [ ] Run tests and confirm the expected failures.
- [ ] Implement the JSON API, static serving, validation, and atomic persistence.
- [ ] Run tests and confirm they pass.
- [ ] Ignore `tools/asana-task-review/data/review-state.json`.

### Task 3: Review interface

**Files:**
- Create: `tools/asana-task-review/public/index.html`
- Create: `tools/asana-task-review/public/styles.css`
- Create: `tools/asana-task-review/public/app.js`

- [ ] Build the dense editorial/operations interface with clear task hierarchy.
- [ ] Add selection, comments, search, filters, counts, bulk recommendation selection, and saved/error status.
- [ ] Preserve accessibility, responsive layout, and keyboard usability.

### Task 4: Verification and launch

- [ ] Run server unit tests and snapshot validation.
- [ ] Start the server on the first free ws1 utility port at or above 9103, bound to `0.0.0.0`.
- [ ] Use browser verification to change and persist a selection and comment across refresh.
- [ ] Restore the initial review state after verification.
- [ ] Run `jj st` and inspect the final diff.
- [ ] Share both localhost and dev.vps URLs.
