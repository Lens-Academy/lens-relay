# Unified Comments — Code Review Findings

**Scope:** `jj diff -r 'main..@'` (41 commits, 4341 +/2878 - across 64 files) — the unified comments rewrite that replaces `CommentMargin/`, `CommentsPanel/`, and `EduCommentsSidebar` with a new `Comments/` package (`CommentsLayer` + `CommentCard`), `anchor-resolver`, and `weighted-pav-layout`.

**Method:** 3-angle finder pass (line-by-line, removed-behavior, cross-file), ~18 raw candidates, deduped to 10 after verification against the actual code.

Findings ranked most-severe first.

---

## 1. Plain-heading branch omits `commentBadgeMap`

- **File:** `lens-editor/src/components/EduEditor/ContentPanel.tsx:911`
- **Severity:** Correctness (HIGH — comments inside headings are completely broken).

The `section.type === 'heading'` branch (lines 911–919) renders `HeadingRenderer` with `enableCriticMarkup={criticMarkupEnabled && isPlainHeading}` but never passes a `commentBadgeMap`. `renderHeadingWithCriticMarkup` calls into `CriticMarkupSpan` with `absoluteFrom` undefined.

**Result:**
- Inline badge renders with `data-comment-from={undefined}` (React drops the attribute).
- `handleClick` (criticmarkup-render.tsx:67) guards on `absoluteFrom != null` → click no-ops.
- `resolveAnchorYFromDOM` looks for `[data-comment-from="${offset}"]` → no match → fallback fails.

**Reality check (per user, 2026-05-24):** The visible symptom in EduEditor isn't an unclickable badge — it's that the heading section may not render at all when it contains a comment. Worth investigating before fixing.

---

## 2. `useSectionEditor` effect omits range/offset deps

- **File:** `lens-editor/src/hooks/useSectionEditor.ts:106`
- **Severity:** Correctness (HIGH under concurrent edits).

The `useEffect` that builds the CodeMirror view has deps `[opts.active, opts.editKey, opts.enableCriticMarkup, opts.initialSuggestionMode]`. It omits `ytext`, `sectionFrom`, `sectionTo`, and `yTextOffsetBase`. Both `commentOffsetTranslator` (createSectionEditorView.ts:119) and `ySectionSync` capture these at view construction.

**Failure mode:** A remote insert above the open section shifts `editRange.from` → `yTextOffsetBase` changes → the effect doesn't re-run. The facet keeps the old offset base. Clicking a badge dispatches a stale `absFrom` to `CommentsLayer.focusThread`, which focuses the wrong thread or no thread.

---

## 3. Stale `yTextTo` in `onSectionViewChange`

- **File:** `lens-editor/src/components/EduEditor/ContentPanel.tsx:440`
- **Severity:** Correctness (MEDIUM — partial DOM-fallback mitigation).

`yTextTo: editRange.from + view.state.doc.length` is captured inside `requestAnimationFrame` when the effect fires. The effect only re-runs on `editKey` or `editRange.from` change — typing inside the section grows `view.state.doc.length` without re-firing it.

`resolveAnchorYFromSectionViews` (anchor-resolver.ts:37) tests `offset < yTextTo`. A comment added past the captured length is rejected, falling through to `resolveAnchorYFromDOM`. The DOM fallback works for prose markers but not for section-editor widget badges that haven't propagated to the outer DOM yet.

---

## 4. `setFocusedThreadKey(pos)` after insert is wrong under concurrent edits

- **File:** `lens-editor/src/components/Comments/CommentsLayer.tsx:154`
- **Severity:** Correctness (MEDIUM — concurrent-edit edge case).

`handleAddSubmit` calls `insertCommentInYText(yText, content, pos)` then `setFocusedThreadKey(pos)`. This assumes the inserted thread's `from` equals the pre-insert cursor position.

**Failure mode:** A concurrent remote insert before `pos` shifts the new thread's `from`. The focus key targets a thread that doesn't exist; the new comment renders unfocused, and the user thinks the add silently failed.

---

## 5. Threads with no rendered anchor are silently dropped

- **File:** `lens-editor/src/components/Comments/CommentsLayer.tsx:226`
- **Severity:** UX regression vs. deleted sidebar (MEDIUM, arguably by design).

`for (const thread of allThreads) { const anchorY = resolveAnchorY(thread.from); if (anchorY == null) continue; … }` — a thread whose anchor isn't currently rendered is dropped from the layout entirely.

The deleted `EduCommentsSidebar` listed every thread regardless of rendering state. With the new layer, a comment on collapsed/lazy/unrendered prose is invisible: no card in the margin, no list view, no way to discover it.

---

## 6. Inline focus highlight lost on widget DOM rebuild

- **File:** `lens-editor/src/components/Comments/CommentsLayer.tsx:141`
- **Severity:** UX (MEDIUM).

The effect that toggles `data-comment-focused` on matching badges depends on `[focusedThreadKey, editorRootRef, textRevision]` — no layout/scroll dep.

CodeMirror rebuilds widget DOM when the badge widget exits and re-enters the viewport. The new DOM element starts without `data-comment-focused`. Since neither `focusedThreadKey` nor `textRevision` changed, the toggle effect doesn't re-run; the inline highlight on the badge is gone even though the card is still outlined.

---

## 7. `sliceCommentBadgeMap` returns a fresh `Map` every render

- **File:** `lens-editor/src/components/EduEditor/ContentPanel.tsx:252`
- **Severity:** Performance (MEDIUM).

`sliceCommentBadgeMap(globalBadgeMap, editRange.from, …)` is called inline during render and returns a new `Map` identity each time. It's passed into `useSectionEditor` as `commentBadgeMap`. The badge-map dispatch effect (`useSectionEditor.ts:113`) keys on this reference, so `setCommentBadgeMap` dispatches on every parent re-render, which forces `buildDecorations` to rebuild every criticmarkup decoration in the section editor.

Every state change in `EduEditor` (cursor moves, presence, `layoutTick` from `CommentsLayer`, etc.) triggers this rebuild.

---

## 8. `ResizeObserver` churn on every render

- **File:** `lens-editor/src/components/Comments/CommentsLayer.tsx:162`
- **Severity:** Performance (MEDIUM).

`attachObserver` is a function declared inside the component body, so its identity changes every render. React invokes the previous ref callback with `null` and the new callback with the element on every re-render; both branches disconnect-and-reconnect the `ResizeObserver`.

On bursts of yText edits or scroll-driven `layoutTick` updates, every card's observer is torn down and rebuilt — O(threads) per render. Missed resize callbacks during the gap can leave `cardHeightsRef` stale.

---

## 9. Click-outside-to-clear focus is dead code

- **File:** `lens-editor/src/components/Comments/CommentsLayer.tsx:341`
- **Severity:** UX (LOW–MEDIUM).

The layer's outer `<div>` has `pointerEvents: 'none'`. Background clicks fall through to the editor underneath, so the `onClick={(e) => { if (e.target === e.currentTarget) setFocusedThreadKey(null) }}` handler never fires.

The only way to clear focus is to re-click the same badge or navigate away.

---

## 10. `pendingOpenAddForm` flag leaks across doc switches

- **File:** `lens-editor/src/components/EduEditor/EduEditor.tsx:157`
- **Severity:** UX (LOW–MEDIUM, timing-dependent).

The effect at line 152–157 fires `openAddForm()` when `pendingOpenAddForm && commentsLayerRef.current`. It clears the flag only when `commentsLayerRef.current` is non-null at run time. If the user presses `Mod-Shift-m` before `activeYText` resolves (so `CommentsLayer` hasn't mounted yet), the flag persists. On the next doc/module switch that mounts a `CommentsLayer`, the effect fires the add-form against the wrong content.

---

## Cross-cutting themes

- **Stable identity assumptions break under reactive renders** — `sliceCommentBadgeMap` (#7) and `attachObserver` (#8) both assume identity stability that React doesn't provide.
- **Y.Text offsets treated as stable under concurrent edits** — `setFocusedThreadKey(pos)` (#4) and the captured `yTextOffsetBase`/`yTextTo` (#2, #3) all assume offsets won't shift between read and use.
- **The deleted sidebar offered "always discoverable" as a contract** — the new layer trades that for spatial anchoring, which is correct when anchors render and invisible when they don't (#5).

## What's NOT in here

Skipped from the raw 18 candidates after verification:
- `ContentPanel.tsx:414` (`onYTextChange?.(null)` cleanup race) — REFUTED; `pendingOpenAddForm` lives in `EduEditor` state and survives remount, the effect re-fires on `activeYText`.
- `criticmarkup.ts:414` (supplied-map `threadFrom`) — first-comment-in-thread invariant holds in steady state; only a stale supplied map diverges, which is the same concern as #2.
- `CommentsLayer.tsx:109` (`useCommentsFromText` reparses every render) — real, but #7 captures the dominant per-render cost; folded in.
- `CommentsLayer.tsx:418` (`layerTop = 0` on first paint) — single-frame flash, low impact.
- `CommentCard.tsx` aria-label regression — low severity, easy to fix in passing.
