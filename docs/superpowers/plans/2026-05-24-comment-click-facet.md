# Comment Click — Facet + Callback Refactor

**Goal**: Replace the `comment-badge-focus` `document`-level CustomEvent bus
with a typed callback path: a CodeMirror Facet for edit-mode markers and a
direct prop callback for read-mode markers. Both call the same handler
provided by the editor mount (file editor or course editor).

**Why now**:
- The bus is the proximate cause of the StrictMode toggle bug (ref-mirror
  workaround currently lives in `CommentsLayer.tsx:92-97`) — a direct
  callback can close over fresh state and doesn't need the ref-mirror.
- Two parallel dispatch sites (`criticmarkup.ts:357` and
  `criticmarkup-render.tsx:74`) silently doubled events and cancelled
  toggles in read mode. A single typed callback collapses both paths.
- Cross-component coordination via global event names is invisible to the
  type system. Refactor makes the dependency explicit.

---

## Current architecture

```
┌────────────────────────────────────┐                ┌──────────────────────┐
│ criticmarkup.ts                    │                │ CommentsLayer.tsx    │
│   click on .cm-comment-badge       │                │   useEffect([]):     │
│   → document.dispatchEvent(        │ ─── 'comment   │     document.addEvent│
│       'comment-badge-focus',       │     -badge-    │       Listener(...)  │
│       {threadFrom})                │     focus' ──→ │   handler reads      │
└────────────────────────────────────┘                │     focusedKeyRef.   │
                                                       │     current and     │
┌────────────────────────────────────┐                │     toggles state    │
│ criticmarkup-render.tsx            │                └──────────┬───────────┘
│   click on .cm-comment-anchor      │                           │
│   → document.dispatchEvent(...)    │ ──── same event ──────────┘
└────────────────────────────────────┘
                                                       ┌──────────────────────┐
                                                       │ EditorArea.tsx       │
                                                       │   useEffect([]):     │
                                                       │     listen for same  │
                                                       │     event, expand    │
                                                       │     comment-margin   │
                                                       └──────────────────────┘
```

## Target architecture

```
┌────────────────────────────────────┐
│ criticmarkup.ts                    │
│   click on .cm-comment-badge       │
│   → state.facet(commentClickCb)    │      ┌────────────────────────────────┐
│       .forEach(cb => cb(from))     │ ──→  │ handleMarkerClick(from)        │
└────────────────────────────────────┘      │   - opens comment margin       │
                                            │   - calls CommentsLayer.focus  │
┌────────────────────────────────────┐      │     (toggles via fresh state)  │
│ criticmarkup-render.tsx            │      └────────────────────────────────┘
│   click on .cm-comment-anchor      │ ──→        defined in EditorArea /
│   → props.onMarkerClick(from)      │            EduEditor mount
└────────────────────────────────────┘
```

No more `document.dispatchEvent`. No more `document.addEventListener`. No
more ref-mirror.

---

## Tech notes

- Existing Facet pattern in `criticmarkup.ts:31-46` (`canAcceptRejectFacet`,
  `commentOffsetTranslator`) is the template. The new facet has the same
  shape: `Facet.define<(from: number) => void>` with `combine: (vals) =>
  vals`.
- `CommentsLayer` exposes a `focusThread(from: number | null)` API via an
  imperative ref handle (or accepts a controlled `focusedKey` prop with
  `onFocusChange`). Decision in Task 1 below.
- The "open the comment margin" side effect in `EditorArea.tsx:139-143`
  becomes a wrapper around the same callback.

---

## Tasks

### Task 1 — Decide focus-state ownership model

Two options for plumbing the focus state between the marker callback and
`CommentsLayer`:

**Option A — Imperative ref**: `CommentsLayer` exposes `useImperativeHandle`
with `focusThread(from: number)`. Parent stores a ref and calls it from the
marker callback. `CommentsLayer` still owns the state internally.

**Option B — Controlled**: Lift focus state into the parent
(`EditorArea` / `EduEditor`). `CommentsLayer` becomes controlled —
`focusedKey` prop in, `onFocusChange` prop out.

**Recommendation**: A. Smaller diff, doesn't expand `CommentsLayer`'s
prop surface, doesn't force every parent to manage focus state, doesn't
trigger a parent re-render on every focus change (which would re-run the
parent's layout effect deps).

If reviewer disagrees, switch to B before starting Task 2.

**No code changes in this task** — it's a decision gate. Document the
choice in the plan (in this file) before continuing.

### Task 2 — Add `commentClickCallback` Facet to the criticmarkup extension

**File**: `lens-editor/src/components/Editor/extensions/criticmarkup.ts`

After the existing `commentOffsetTranslator` definition (~line 46), add:

```ts
/**
 * Callback invoked when a user clicks a comment badge in the editor.
 * Receives the absolute Y.Text offset (already translated through
 * commentOffsetTranslator). Multiple callbacks are all invoked.
 */
export const commentClickCallback = Facet.define<(absFrom: number) => void>();
```

Update the click delegator (currently `criticmarkup.ts:352-358`):

```ts
} else if (target.classList.contains('cm-comment-badge')) {
  e.preventDefault();
  e.stopPropagation();
  const absFrom = parseInt(target.dataset.commentFrom ?? '', 10);
  if (!isNaN(absFrom)) {
    const cbs = view.state.facet(commentClickCallback);
    cbs.forEach((cb) => cb(absFrom));
  }
}
```

Keep the `document.dispatchEvent('comment-badge-focus', ...)` call alongside
for now — we'll remove it in Task 6 after all consumers are migrated.

### Task 3 — Add `onMarkerClick` prop to `CriticMarkupSpan`

**File**: `lens-editor/src/lib/criticmarkup-render.tsx`

Add an optional `onMarkerClick?: (absFrom: number) => void` to `RenderOpts`,
thread it through `renderMarkdownWithCriticMarkup` and into
`CriticMarkupSpan`. Update `CriticMarkupSpan.handleClick`:

```tsx
const handleClick = (e: React.MouseEvent) => {
  if (range.type === 'comment' && absoluteFrom != null) {
    e.stopPropagation();
    opts.onMarkerClick?.(absoluteFrom);
    if (onClickRange) { /* existing call */ }
    return;
  }
  if (onClickRange) onClickRange(range);
};
```

Keep the `document.dispatchEvent` here too for now (remove in Task 6).

### Task 4 — Expose imperative focus handle on `CommentsLayer`

**File**: `lens-editor/src/components/Comments/CommentsLayer.tsx`

Change the function signature from `function CommentsLayer(props)` to
`forwardRef`, expose:

```ts
export interface CommentsLayerHandle {
  focusThread(absFrom: number): void;  // toggles: if already focused, clears
}
```

Implement with `useImperativeHandle` reading the existing
`focusedThreadKey` state directly (no need for ref-mirror — the handle is
called synchronously from event handlers that close over fresh state of
the parent component, and the *toggle decision* now happens inside
`focusThread` which sees the latest state):

```ts
useImperativeHandle(ref, () => ({
  focusThread(absFrom: number) {
    setFocusedThreadKey((prev) => prev === absFrom ? null : absFrom);
  },
}), []);
```

Wait — that's the same functional updater that StrictMode breaks. Instead:

```ts
useImperativeHandle(ref, () => ({
  focusThread(absFrom: number) {
    setFocusedThreadKey(focusedKeyRef.current === absFrom ? null : absFrom);
  },
}), []);
```

We still need the ref mirror for this case (the handle identity must be
stable across renders, so it can't close over per-render state). Two
choices:

- (a) Keep the ref-mirror (it's now narrowly scoped, with one purpose).
- (b) Rebuild the handle each render (`useImperativeHandle(ref, () => ({...}), [focusedThreadKey])`) so the closure is always fresh.

(b) is cleaner — `useImperativeHandle` dep array works exactly like
`useMemo`, and the parent's `markerHandlerRef.current.focusThread` always
gets the latest closure. The ref-mirror can be removed entirely.

**Decision for this task**: use (b). The whole point of the refactor is
removing the ref-mirror, and (b) achieves that.

```ts
useImperativeHandle(ref, () => ({
  focusThread(absFrom: number) {
    setFocusedThreadKey(focusedThreadKey === absFrom ? null : absFrom);
  },
}), [focusedThreadKey]);
```

Also delete the `focusedKeyRef` and its mirror effect, and delete the
document-level `useEffect` listener at `CommentsLayer.tsx:117-125`. The
`handleFocus` callback for card-click can stay; it already uses the
correct closed-over state pattern.

### Task 5 — Wire the callback in both editor mounts

**File**: `lens-editor/src/components/Layout/EditorArea.tsx` (file editor)

Add a ref + handler:

```tsx
const commentsLayerRef = useRef<CommentsLayerHandle | null>(null);
const handleMarkerClick = useCallback((absFrom: number) => {
  manager.expand('comment-margin');
  commentsLayerRef.current?.focusThread(absFrom);
}, [manager.expand]);
```

Pass `handleMarkerClick` into the criticmarkup extension config via
`commentClickCallback.of(handleMarkerClick)` (find the extension setup
site and add it; likely in the same place `canAcceptRejectFacet` /
`commentOffsetTranslator` are configured — search for `criticMarkupExtension`).

Wire `commentsLayerRef` to `<CommentsLayer ref={commentsLayerRef} ... />`.

Delete the `document.addEventListener('comment-badge-focus', ...)` block
at `EditorArea.tsx:139-143`.

**File**: `lens-editor/src/components/EduEditor/EduEditor.tsx` (course editor)

Same pattern:

```tsx
const commentsLayerRef = useRef<CommentsLayerHandle | null>(null);
const handleMarkerClick = useCallback((absFrom: number) => {
  ensureCommentsVisible();
  commentsLayerRef.current?.focusThread(absFrom);
}, [ensureCommentsVisible]);
```

Three wiring sites:

1. Pass `handleMarkerClick` through `ContentPanel`'s `onMarkerClick` prop
   (new), which `ContentPanel` forwards to read-mode renderers
   (`TextRenderer`, `HeadingRenderer`, etc.) as their `onMarkerClick`
   prop, which they pass into `renderMarkdownWithCriticMarkup({
   onMarkerClick })`.
2. Pass `handleMarkerClick` into the section editor's criticmarkup
   extension via `commentClickCallback.of(...)` in
   `createSectionEditorView.ts:114-120`.
3. Set `ref={commentsLayerRef}` on the `<CommentsLayer>` mount.

Drop the dispatch in `handleClickCriticRange` — it's already simplified to
just `ensureCommentsVisible()` (see prior cleanup), and that role moves
into `handleMarkerClick`.

### Task 6 — Remove the document-event paths

Once Tasks 2-5 are wired and tested:

- `criticmarkup.ts:357` — delete the `document.dispatchEvent` line.
- `criticmarkup-render.tsx:74-78` — delete the `document.dispatchEvent` block.
- `CommentsLayer.tsx:117-125` — already deleted in Task 4.
- `EditorArea.tsx:139-143` — already deleted in Task 5.

Search-grep for any other references to `comment-badge-focus` and delete.

### Task 7 — Update tests

**`criticmarkup.test.ts:833-852`** — replace the
"dispatches comment-badge-focus CustomEvent on badge click" test with a
test that wires a mock callback via `commentClickCallback.of(mockFn)` and
asserts the mock is called with the absolute offset on click.

**`criticmarkup-render.test.tsx`** — add a test that `onMarkerClick` is
called with the absolute offset when a comment anchor is clicked, and
that the new (Task 4) toggle works under StrictMode by mounting twice
(this is the P0.1 test from the test review — worth adding here as a
regression lock).

**`CommentsLayer.test.tsx`** — switch from `document.dispatchEvent` (if
any test uses it; none in current suite) to using the imperative handle.
Add a test that `forwardRef`'s `focusThread` toggles state.

### Task 8 — Manual verification

Reload both editor pages. Verify:

1. File editor: click an inline badge → sidebar card focuses. Click same badge → unfocuses. Click sidebar card → inline badge gets the focused look.
2. Course editor (read mode): click a `.cm-comment-anchor` → sidebar focuses. Click again → unfocuses.
3. Course editor (edit mode): same, on a section that's been click-to-edit'd.
4. Switch between focused markers across sections. The previous section's marker should clear when a new one focuses.

---

## Test strategy

Run after each task: `npx vitest run src/components/Comments src/components/Editor/extensions/criticmarkup src/lib/criticmarkup-render src/lib/anchor-resolver` — should stay green.

Run full suite at the end: `npx vitest run`.

Type-check after each task: `npx tsc --noEmit`.

---

## Review fixes (from plan reviewer)

1. **Facet callback identity in section editors**: `useSectionEditor` captures the callback at view-construction time. EduEditor's `handleMarkerClick` closure depends on `ensureCommentsVisible` (and transitively on `commentsVisible`), so it changes when comments visibility toggles — but the editor view still holds the stale closure. **Fix**: register the Facet with a stable wrapper that reads through a ref: `commentClickCallback.of((from) => optsRef.current.onMarkerClick?.(from))`, mirroring the existing `optsRef` pattern in `useSectionEditor`. EditorArea is fine because its `handleMarkerClick` only depends on `manager.expand` (stable).

2. **Tasks 4 and 5 are one atomic unit**: between Task 4 (deletes the `CommentsLayer` document listener) and Task 5 (wires the new callback), badge clicks would do nothing. Do them in a single commit.

3. **`QuestionRenderer` has TWO `renderMarkdownWithCriticMarkup` call sites** (content + assessmentInstructions). Thread `onMarkerClick` to both.

4. **Facet form differs from existing**: `Facet.define<F>()` with no `combine` returns `readonly F[]` (array of all registrations). This is different from `canAcceptRejectFacet`/`commentOffsetTranslator` which explicitly `combine` to a single value. Mention in the doc comment of the new facet.

## Risks

- **Stable handle identity vs fresh closure**: The chosen
  `useImperativeHandle(..., [focusedThreadKey])` pattern means the handle
  reference changes per render. Anything that depends on `===` identity
  of the handle would break. Nothing currently does — handle is held in
  a ref, not in a dep array. Confirm in Task 5 that no consumer adds it
  to a dep array.

- **Multiple subscribers via Facet**: `Facet.define<F>()` with no
  `combine` returns an array of all registered values. We do
  `cbs.forEach`, so multiple subscribers are supported. Currently we
  have only one per editor mount but future tools/integrations could
  add more. No risk.

- **EduEditor's `handleClickCriticRange`** still exists for non-comment
  ranges (acceptance UI etc.). Don't delete it; just stop dispatching
  the event from it.

- **`ContentPanel` plumbing**: `onMarkerClick` needs to thread through
  ContentPanel into every renderer (`TextRenderer`, `HeadingRenderer`,
  `QuestionRenderer`, `TutorInstructions`) that uses
  `renderMarkdownWithCriticMarkup`. This is grep-and-add work. Easy to
  forget one. Search: `grep -rn 'renderMarkdownWithCriticMarkup' src/`.

- **Test order**: Adding the Facet (Task 2) and CriticMarkupSpan prop
  (Task 3) without consumers is safe — both keep dispatching the
  document event too. Removing dispatch (Task 6) only after all
  consumers are wired (Task 5) preserves green tests throughout.

---

## Files changed (estimated)

- `criticmarkup.ts` — add Facet, update click delegator, remove dispatch
- `criticmarkup-render.tsx` — add `onMarkerClick` prop, remove dispatch
- `CommentsLayer.tsx` — `forwardRef`, expose `focusThread`, remove ref-mirror + document listener
- `EditorArea.tsx` — wire callback, remove document listener
- `EduEditor.tsx` — wire callback through ContentPanel
- `ContentPanel.tsx` — thread `onMarkerClick` to renderers
- `ContentPanel/renderers/*.tsx` (4-5 files) — accept + forward `onMarkerClick`
- `TutorInstructions.tsx` — same
- `createSectionEditorView.ts` — accept optional `commentClickCallback` parameter
- `useSectionEditor.ts` (callers of createSectionEditorView) — thread the callback
- Tests as above

Net change: estimated -50 to -100 lines (removing dispatch sites and ref-mirror).
