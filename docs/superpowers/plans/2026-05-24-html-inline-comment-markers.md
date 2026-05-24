# HTML Inline Comment Markers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add exact inline clickable markers for HTML preview comments by storing visible text anchors next to comment metadata.

**Architecture:** Comment persistence will insert `[[@comment:<id>]]` before each new parent comment metadata marker. The iframe bridge will replace those visible text anchors with inline buttons and keep the existing overlay-dot fallback for legacy comments that do not have anchors.

**Tech Stack:** TypeScript, React, Yjs, Vitest, Happy DOM.

---

### Task 1: Comment Store Anchors

**Files:**
- Modify: `lens-editor/src/components/HtmlEditor/comment-store.ts`
- Test: `lens-editor/src/components/HtmlEditor/comment-store.test.ts`

- [x] Add failing tests for `serializeCommentAnchor`, anchored `addComment`, anchored parse bounds, anchored edit, and anchored delete.
- [x] Run `npm run test:run -- src/components/HtmlEditor/comment-store.test.ts` and confirm the new tests fail because anchor support does not exist yet.
- [x] Implement anchor serialization, parse anchored parent comments with `sourceStart` including the anchor, preserve the anchor when editing, and remove the anchor when deleting.
- [x] Run `npm run test:run -- src/components/HtmlEditor/comment-store.test.ts` and confirm it passes.

### Task 2: Preview Bridge Inline Buttons

**Files:**
- Modify: `lens-editor/src/components/HtmlEditor/bridge/bridge-script.ts`
- Test: `lens-editor/src/components/HtmlEditor/bridge/bridge-script.wiring.test.ts`

- [x] Add failing bridge tests showing `[[@comment:c1]]` is replaced with a clickable `.lens-comment-inline-marker` button and posts `dot-clicked`.
- [x] Keep a test proving legacy HTML-comment-only comments still render a fallback `.lens-comment-dot`.
- [x] Run `npm run test:run -- src/components/HtmlEditor/bridge/bridge-script.wiring.test.ts` and confirm the inline marker test fails.
- [x] Implement text-node anchor replacement in the bridge before fallback dot rendering.
- [x] Run `npm run test:run -- src/components/HtmlEditor/bridge/bridge-script.wiring.test.ts` and confirm it passes.

### Task 3: Integration Verification

**Files:**
- Modify only if test failures reveal needed integration updates.

- [x] Run `npm run test:run -- src/components/HtmlEditor`.
- [x] Run targeted lint for changed files with `npx eslint src/components/HtmlEditor/comment-store.ts src/components/HtmlEditor/comment-store.test.ts src/components/HtmlEditor/comment-store.ytext.test.ts src/components/HtmlEditor/bridge/bridge-script.ts src/components/HtmlEditor/bridge/bridge-script.wiring.test.ts`.
- [x] Run `npm run build`.
- [x] Run `jj st` and review the final diff before reporting completion.
