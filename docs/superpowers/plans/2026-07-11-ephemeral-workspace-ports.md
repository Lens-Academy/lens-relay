# Ephemeral Workspace Ports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give ephemeral Lens Relay workspaces collision-free automatic dev ports and expose the convention to both Claude and Codex.

**Architecture:** A small JavaScript module is the source of truth for workspace-name parsing and service-port calculation used by Node/Vite code. Shell server scripts implement the same documented formula, while the server-listing script discovers both persistent and ephemeral owners.

**Tech Stack:** Node.js, TypeScript/Vite, Bash, Vitest, jj.

---

### Task 1: Shared port calculation

**Files:**
- Create: `lens-editor/server/workspace-ports.mjs`
- Create: `lens-editor/server/workspace-ports.d.mts`
- Create: `lens-editor/server/workspace-ports.test.ts`

- [ ] Write tests for persistent, letter-suffixed, legacy editor-directory, and fallback names.
- [ ] Run the focused test and confirm it fails because the module does not exist.
- [ ] Implement workspace parsing and Vite, Relay, and Discord port calculation.
- [ ] Run the focused test and confirm it passes.

### Task 2: Adopt automatic ports

**Files:**
- Modify: `lens-editor/vite.config.ts`
- Modify: `lens-editor/scripts/start-local-relay.sh`
- Modify: `lens-editor/scripts/setup-local-relay.mjs`
- Modify: Relay helper and integration scripts that currently duplicate workspace parsing.
- Modify: `lens-editor/server/discord/dev-server.ts`

- [ ] Replace duplicated Node/Vite calculations with the tested helper.
- [ ] Extend the Relay shell launcher to recognize a letter suffix.
- [ ] Run focused tests and TypeScript build checks.

### Task 3: Server discovery

**Files:**
- Modify: `scripts/list-servers`

- [ ] Add a shell-level behavior check using a temporary fake `lsof`/`ps` environment.
- [ ] Extend discovery and current-workspace detection to letter-suffixed workspaces.
- [ ] Confirm persistent and ephemeral service rows report the correct owner.

### Task 4: Shared local instructions

**Files:**
- Modify: `/home/penguin/code/lens-relay/CLAUDE.local.md`
- Create: `/home/penguin/code/lens-relay/codex.local.toml`
- Modify: `/home/penguin/code/lens-platform/CLAUDE.local.md`
- Modify: `/home/penguin/code/lens-platform/codex.local.toml`

- [ ] Document suffix offsets, separate Discord ports, server lifecycle, and examples for Lens Relay.
- [ ] Add the synchronized Codex local-instruction tunnel for Lens Relay.
- [ ] Document the same suffix formula with Lens Platform's repository-specific bases.
- [ ] Compare each repository's Claude and Codex instructions for semantic parity.

### Task 5: Verification

- [ ] Run focused port tests, shell syntax checks, and relevant build checks.
- [ ] Run `jj st` in both repositories and inspect all diffs.
