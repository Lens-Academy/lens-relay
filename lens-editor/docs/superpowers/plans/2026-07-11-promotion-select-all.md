# Promotion Select All Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one control that selects or clears every changed promotion file.

**Architecture:** Keep bulk-selection state in `PromotionPage`, alongside existing row selection. Derive the checkbox state from the complete backend file list so text filtering does not alter its meaning.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library

---

### Task 1: Select All Changed Files

**Files:**
- Modify: `lens-editor/src/components/Promotion/PromotionPage.tsx`
- Modify: `lens-editor/src/components/Promotion/PromotionPage.test.tsx`
- Modify: `lens-editor/server/promotion/path-validation.ts`
- Modify: `lens-editor/server/promotion/path-validation.test.ts`

- [x] **Step 1: Write a failing test**

Add a UI test that loads the two-file fixture, clicks `Select all files`, verifies
both row checkboxes and `2 selected`, clicks it again, then verifies both rows
are unchecked and `0 selected`. Add server tests proving 101 valid paths are
accepted and 1,001 paths are rejected with `At most 1000`.

- [x] **Step 2: Verify RED**

Run `cd lens-editor && npx vitest run src/components/Promotion/PromotionPage.test.tsx`.
Expected: FAIL because no `Select all files` checkbox exists and the server
still rejects 101 paths.

- [x] **Step 3: Implement minimal bulk selection**

Derive `allFilesSelected` from `changes.files` and `selected`, add a handler that
sets `selected` to every changed path or an empty set, and clears `prResult`.
Render the labeled checkbox beside the selected count only when files exist.
Raise `MAX_PROMOTION_PATHS` from 100 to 1,000.

- [x] **Step 4: Verify GREEN and regressions**

Run:

```bash
cd lens-editor
npx vitest run src/components/Promotion/PromotionPage.test.tsx
npm run build
```

Expected: all page tests pass and the production build succeeds.

- [ ] **Step 5: Push and deploy**

Describe the change, rebase onto updated `main` if needed, move the `main`
bookmark, push it, pull on production, rebuild only `lens-editor`, and recreate
only that service.

- [ ] **Step 6: Verify production**

Open `/promote` with an admin token and confirm `Select all files` selects every
row and updates the count without creating a PR.
