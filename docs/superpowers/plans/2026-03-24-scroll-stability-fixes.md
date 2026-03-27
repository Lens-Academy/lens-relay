# Scroll Stability Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate scroll jumping in the CodeMirror 6 editor caused by decoration rebuilds, async DOM mutations, timer-based dispatches, and layout measurement timing issues.

**Architecture:** Nine targeted fixes across the editor's extension system. The core problem is that multiple ViewPlugins rebuild their entire decoration sets too aggressively (on every viewport scroll and cursor move), and several widgets mutate the DOM outside CodeMirror's update cycle. Fixes involve: (1) removing `viewportChanged` as a rebuild trigger and using `DecorationSet.map()` instead, (2) adding `requestMeasure()` after async height changes, (3) batching timer-based dispatches with `requestAnimationFrame`, (4) preventing listener accumulation.

**Tech Stack:** CodeMirror 6 (`@codemirror/view` ^6.39.11, `@codemirror/state` ^6.5.4), TypeScript, Vitest

---

## File Map

| File | Changes |
|------|---------|
| `lens-editor/src/components/Editor/extensions/livePreview.ts` | Tasks 1, 2, 3, 4 |
| `lens-editor/src/components/Editor/extensions/criticmarkup.ts` | Task 5 |
| `lens-editor/src/components/Editor/extensions/headingFlash.ts` | Task 6 |
| `lens-editor/src/components/Editor/extensions/emphasisPersist.ts` | Task 7 |
| `lens-editor/src/components/CommentMargin/CommentMargin.tsx` | Task 8 |
| `lens-editor/src/components/TableOfContents/useHeadings.ts` | Task 9 |

**No new files are created.** All changes are modifications to existing extension files.

**Testing approach:** These are visual/interaction bugs in CodeMirror extensions that are difficult to unit test in isolation (they require a real browser viewport, scroll events, and async image loading). Instead of unit tests, each fix is verified by:
1. Reading the code to confirm the fix is correct per CM6 best practices
2. Manual testing in the editor with documents containing the relevant content (headings, images, CriticMarkup, etc.)
3. Running existing tests to confirm no regressions: `cd lens-editor && npm run test:run`

---

### Task 1: Remove viewportChanged from livePreview decoration rebuild

This is the highest-impact fix. Currently, every scroll event triggers a full syntax tree iteration and decoration rebuild via the `viewportChanged` condition. Since `buildDecorations` scopes to `view.visibleRanges`, newly-visible content only shows stale decorations until the next `docChanged` or `selectionSet` event — which happens on the very next keystroke or click. Removing `viewportChanged` eliminates expensive per-scroll rebuilds with negligible visual impact.

**Files:**
- Modify: `lens-editor/src/components/Editor/extensions/livePreview.ts:310-319`

- [ ] **Step 1: Remove viewportChanged from livePreview plugin update()**

Replace the update method (lines 310-319):

```typescript
update(update: ViewUpdate) {
  const metadataChanged = update.transactions.some(
    tr => tr.effects.some(e => e.is(wikilinkMetadataChanged))
  );

  if (update.docChanged || update.selectionSet || metadataChanged) {
    this.decorations = this.buildDecorations(update.view);
  }
  // viewportChanged (pure scroll) intentionally not handled —
  // decorations for newly-visible ranges are built on the next
  // docChanged or selectionSet, which fires on the next keystroke
  // or click. This avoids expensive per-scroll rebuilds.
}
```

- [ ] **Step 2: Apply the same fix to sourceHeadingPlugin**

In `sourceHeadingPlugin.update()` (line 694-696), keep `viewportChanged` here:

```typescript
update(update: ViewUpdate) {
  if (update.docChanged || update.viewportChanged) {
    this.decorations = this.buildDecorations(update.view);
  }
}
```

Leave as-is. Unlike livePreview, sourceHeadingPlugin is cheap (no selection checks, just heading class marks) and only runs in source mode. Removing `viewportChanged` here would cause headings scrolled into view to lack size styling until the next edit, since sourceHeadingPlugin has no `selectionSet` trigger.

- [ ] **Step 3: Run existing tests**

Run: `cd /home/penguin/code/lens-relay/ws1/lens-editor && npm run test:run`
Expected: All tests pass (no regressions)

- [ ] **Step 4: Commit**

```
fix(editor): remove viewportChanged from livePreview rebuild triggers

Remove viewportChanged as a decoration rebuild trigger. The per-scroll
syntax tree iteration was the main cause of scroll jumping during
typing. Newly-visible content gets decorated on the next docChanged
or selectionSet event (next keystroke or click).
```

---

### Task 2: Fix ImageWidget async DOM mutations

When an image loads, the `onload` handler directly mutates the DOM (removes placeholder, shows image) outside CM6's update cycle. This changes the widget's height without CM6 knowing, causing scroll jumps.

**Files:**
- Modify: `lens-editor/src/components/Editor/extensions/livePreview.ts:164-221`

- [ ] **Step 1: Store EditorView reference in ImageWidget for requestMeasure**

The widget needs access to the view to call `requestMeasure()`. Pass the view to the constructor:

```typescript
class ImageWidget extends WidgetType {
  private alt: string;
  private url: string;
  private view: EditorView;

  constructor(alt: string, url: string, view: EditorView) {
    super();
    this.alt = alt;
    this.url = url;
    this.view = view;
  }
```

- [ ] **Step 2: Add requestMeasure() call after image load/error**

Update `toDOM()` to notify CM6 when the image finishes loading:

```typescript
  toDOM(): HTMLElement {
    const container = document.createElement('span');
    container.className = 'cm-image-widget';

    // Security: only allow http/https URLs
    if (!/^https?:\/\//i.test(this.url)) {
      container.classList.add('cm-image-error');
      const fallback = document.createElement('span');
      fallback.className = 'cm-image-fallback';
      fallback.textContent = this.alt || this.url;
      container.appendChild(fallback);
      return container;
    }

    const img = document.createElement('img');
    img.alt = this.alt;
    img.className = 'cm-image-preview';
    img.src = this.url;

    // Loading: hide img until loaded, show placeholder
    img.style.display = 'none';
    const placeholder = document.createElement('span');
    placeholder.className = 'cm-image-loading';
    placeholder.textContent = this.alt || 'Loading image…';
    container.appendChild(placeholder);

    const view = this.view;

    img.onload = () => {
      placeholder.remove();
      img.style.display = '';
      // Notify CM6 that widget height changed so it can re-measure
      // and stabilize scroll position
      view.requestMeasure();
    };
    img.onerror = () => {
      placeholder.remove();
      img.remove();
      container.classList.add('cm-image-error');
      const fallback = document.createElement('span');
      fallback.className = 'cm-image-fallback';
      fallback.textContent = `Image not found: ${this.alt || this.url}`;
      container.appendChild(fallback);
      view.requestMeasure();
    };

    container.appendChild(img);
    return container;
  }
```

- [ ] **Step 3: Update eq() to not compare view**

The `eq()` method should only compare content identity, not the view reference:

```typescript
  eq(other: ImageWidget): boolean {
    return this.alt === other.alt && this.url === other.url;
  }
```

This is already correct — no change needed.

- [ ] **Step 4: Update ImageWidget constructor call in buildDecorations**

Find the `new ImageWidget(match[1], match[2])` call (around line 434) and add the view parameter:

```typescript
deco: Decoration.replace({
  widget: new ImageWidget(match[1], match[2], view),
}),
```

- [ ] **Step 5: Run existing tests**

Run: `cd /home/penguin/code/lens-relay/ws1/lens-editor && npm run test:run`
Expected: All tests pass

- [ ] **Step 6: Commit**

```
fix(editor): notify CM6 after image widget load/error

Call view.requestMeasure() after async image load/error events
so CodeMirror can re-measure heights and stabilize scroll position.
```

---

### Task 3: Add estimatedHeight to ImageWidget

CM6 uses height estimates for off-screen widgets. Without `estimatedHeight`, it falls back to default line height, which is wildly wrong for images. This causes scroll jumps when images enter/leave the viewport.

**Files:**
- Modify: `lens-editor/src/components/Editor/extensions/livePreview.ts:164-221`

- [ ] **Step 1: Override estimatedHeight on ImageWidget**

Add the `estimatedHeight` getter to ImageWidget. The loading placeholder is roughly 2em tall, and loaded images can be up to 500px. Use a middle-ground estimate:

```typescript
class ImageWidget extends WidgetType {
  private alt: string;
  private url: string;
  private view: EditorView;

  constructor(alt: string, url: string, view: EditorView) {
    super();
    this.alt = alt;
    this.url = url;
    this.view = view;
  }

  get estimatedHeight(): number {
    // Estimate between loading placeholder (~30px) and max image (500px).
    // 150px is a reasonable middle ground that minimizes jump magnitude
    // regardless of whether the image is small or large.
    return 150;
  }
```

- [ ] **Step 2: Run existing tests**

Run: `cd /home/penguin/code/lens-relay/ws1/lens-editor && npm run test:run`
Expected: All tests pass

- [ ] **Step 3: Commit**

```
fix(editor): add estimatedHeight to ImageWidget

Provides CM6 with a reasonable height estimate (150px) for image
widgets so the height map doesn't default to line height, reducing
scroll jumps when images enter/leave the viewport.
```

---

### Task 4: Remove view reference from CheckboxWidget

CheckboxWidget stores an `EditorView` reference but its `eq()` doesn't compare it, creating a subtle inconsistency. More importantly, the stored view could become stale. Use a dispatch callback pattern instead.

**Files:**
- Modify: `lens-editor/src/components/Editor/extensions/livePreview.ts:243-277`

- [ ] **Step 1: Replace stored view with a dispatch callback**

Refactor CheckboxWidget to accept a callback instead of a view reference:

```typescript
class CheckboxWidget extends WidgetType {
  private checked: boolean;
  private onToggle: () => void;

  constructor(checked: boolean, onToggle: () => void) {
    super();
    this.checked = checked;
    this.onToggle = onToggle;
  }

  toDOM(): HTMLElement {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'cm-checkbox';
    input.checked = this.checked;
    input.onclick = (e) => {
      e.preventDefault();
      this.onToggle();
    };
    return input;
  }

  eq(other: CheckboxWidget): boolean {
    return this.checked === other.checked;
  }
}
```

- [ ] **Step 2: Update the CheckboxWidget constructor call in buildDecorations**

Find the `new CheckboxWidget(isChecked, view, node.from, node.to)` call (around line 607) and update:

```typescript
const capturedFrom = node.from;
const capturedTo = node.to;
const isChecked = markerText !== '[ ]';

decorations.push({
  from: replaceFrom,
  to: replaceTo,
  deco: Decoration.replace({
    widget: new CheckboxWidget(isChecked, () => {
      const newText = isChecked ? '[ ]' : '[x]';
      view.dispatch({
        changes: { from: capturedFrom, to: capturedTo, insert: newText },
      });
    }),
  }),
});
```

Note: The `eq()` now only compares `checked`, which is correct for CM6 — position is tracked by the decoration range, not the widget. Two checkboxes at different positions get different decoration ranges, so `eq()` is only called when comparing a widget to its replacement at the same position.

Note: The closure captures `capturedFrom`/`capturedTo` at decoration-build time. These positions can become stale if the document is edited between decoration creation and click. This is the same behavior as the original code (which stored `markerFrom`/`markerTo` at construction) — not a regression. The benefit of this refactor is removing the stored `EditorView` reference, which was a separate staleness concern.

- [ ] **Step 3: Run existing tests**

Run: `cd /home/penguin/code/lens-relay/ws1/lens-editor && npm run test:run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```
fix(editor): remove stale view reference from CheckboxWidget

Replace stored EditorView with a dispatch callback. The view
reference could become stale and wasn't compared in eq(), creating
potential for incorrect widget reuse.
```

---

### Task 5: Stop rebuilding criticMarkup decorations on viewportChanged

Same issue as Task 1 but for the CriticMarkup plugin. The CriticMarkup plugin rebuilds all decorations on viewport change AND selection change. Since CriticMarkup ranges don't depend on viewport position (they're based on parsed ranges from the full document), viewport changes should just map existing decorations.

**Files:**
- Modify: `lens-editor/src/components/Editor/extensions/criticmarkup.ts:333-346`

- [ ] **Step 1: Remove viewportChanged from criticMarkup plugin rebuild triggers**

The CriticMarkup plugin iterates the `criticMarkupField` (which contains ALL ranges, not just visible ones) — it doesn't use `view.visibleRanges`. So viewport changes don't affect its output at all. Remove `viewportChanged`:

```typescript
update(update: ViewUpdate) {
  if (update.docChanged || update.selectionSet) {
    this.decorations = this.buildDecorations(update.view);
    return;
  }
  for (const tr of update.transactions) {
    for (const e of tr.effects) {
      if (e.is(focusCommentThread)) {
        this.decorations = this.buildDecorations(update.view);
        return;
      }
    }
  }
}
```

This is a safe change because `buildDecorations` reads from `view.state.field(criticMarkupField)` which contains all ranges regardless of viewport position. The only viewport-dependent decorations would be if it used `view.visibleRanges` to scope iteration — but it doesn't.

- [ ] **Step 2: Run existing tests**

Run: `cd /home/penguin/code/lens-relay/ws1/lens-editor && npm run test:run`
Expected: All tests pass

- [ ] **Step 3: Commit**

```
fix(editor): remove viewportChanged from criticMarkup rebuild triggers

CriticMarkup decorations are built from the full parsed range set
(criticMarkupField), not scoped to visible ranges. Viewport changes
cannot affect the decoration output, so rebuilding on scroll was
pure waste causing unnecessary layout recalculations.
```

---

### Task 6: Fix headingFlash requestMeasure() in timer

The heading flash plugin calls `view.requestMeasure()` inside a `setTimeout` callback. This forces a layout recalculation outside CM6's normal update cycle. Replace with a proper dispatch.

**Files:**
- Modify: `lens-editor/src/components/Editor/extensions/headingFlash.ts:46-57`

- [ ] **Step 1: Replace requestMeasure() with a state effect dispatch**

The current code mutates `this.decorations` inside a `setTimeout` and calls `requestMeasure()` to force CM6 to notice. This causes layout recalculation outside the normal update cycle. Instead, dispatch a proper effect so the change flows through CM6's `update()` method.

Add a new internal effect at the top of the file (after the existing `persistentHighlightLine` definition):

```typescript
/** Internal effect to transition flash → fade-out */
const flashFadeOut = StateEffect.define<void>();
```

Replace the timer block (lines 47-57) with:

```typescript
// After 1.5s, dispatch fade-out through CM6's update cycle
this.fadeTimer = setTimeout(() => {
  this.view.dispatch({ effects: flashFadeOut.of(undefined) });
}, 1500);

// After 2s total, remove entirely
this.clearTimer = setTimeout(() => {
  this.view.dispatch({ effects: flashHeadingLine.of(null) });
}, 2000);
```

Add handling for `flashFadeOut` in the `update()` method's effects loop (after the `flashHeadingLine` check, before `persistentHighlightLine`):

```typescript
if (e.is(flashFadeOut) && this.decorations !== Decoration.none) {
  // Transition existing flash decoration to fade-out class.
  // The fadeTimer has already fired (that's how we got here).
  // The clearTimer (2s total) is still pending and will
  // dispatch flashHeadingLine.of(null) for final removal.
  const iter = this.decorations.iter();
  if (iter.value) {
    this.decorations = Decoration.set([flashOutDeco.range(iter.from)]);
  }
  return;
}
```

- [ ] **Step 2: Run existing tests**

Run: `cd /home/penguin/code/lens-relay/ws1/lens-editor && npm run test:run`
Expected: All tests pass

- [ ] **Step 3: Commit**

```
fix(editor): replace requestMeasure() with dispatch in headingFlash

The heading flash plugin was calling requestMeasure() inside a
setTimeout to force CM6 to pick up decoration changes. This causes
layout recalculation outside CM6's update cycle. Replace with a
proper state effect dispatch that flows through the update cycle.
```

---

### Task 7: Fix emphasisPersist timer dispatch timing

The emphasis persist plugin dispatches a transaction from a 400ms timer to clear ghost emphasis. If this fires during active typing, it can cause a layout pass at an inopportune time. Use `requestAnimationFrame` to batch with the browser's frame cycle.

**Files:**
- Modify: `lens-editor/src/components/Editor/extensions/emphasisPersist.ts:89-94`

- [ ] **Step 1: Wrap the dispatch in requestAnimationFrame**

Replace lines 90-94:

```typescript
// Schedule ghost clearing
if (this.ghostTimer) clearTimeout(this.ghostTimer);
this.ghostTimer = setTimeout(() => {
  requestAnimationFrame(() => {
    this.view.dispatch({ effects: clearGhostEmphasis.of(undefined) });
  });
  this.ghostTimer = null;
}, 400);
```

The `requestAnimationFrame` ensures the dispatch aligns with the browser's paint cycle rather than firing at an arbitrary point in the middle of a layout calculation.

- [ ] **Step 2: Run existing tests**

Run: `cd /home/penguin/code/lens-relay/ws1/lens-editor && npm run test:run`
Expected: All tests pass

- [ ] **Step 3: Commit**

```
fix(editor): batch emphasisPersist ghost clearing with rAF

Wrap the ghost emphasis clearing dispatch in requestAnimationFrame
so it aligns with the browser's paint cycle instead of firing at
an arbitrary point during layout calculations.
```

---

### Task 8: Fix CommentMargin scroll sync stale reads

The CommentMargin synchronizes scroll position on every scroll event and reads `view.lineBlockAt()` during React render, which may return stale layout data before CM6 has finished its measure cycle.

**Files:**
- Modify: `lens-editor/src/components/CommentMargin/CommentMargin.tsx:61-78`

- [ ] **Step 1: Debounce scroll sync with requestAnimationFrame**

Replace the scroll handler (lines 62-78) with a rAF-debounced version:

```typescript
// Scroll sync: mirror editor's scrollTop (debounced to align with paint)
useEffect(() => {
  const scrollDOM = view.scrollDOM;
  const container = containerRef.current;
  if (!container) return;

  let rafId: number | null = null;

  const handleScroll = () => {
    if (rafId !== null) return; // Already scheduled
    rafId = requestAnimationFrame(() => {
      container.scrollTop = scrollDOM.scrollTop;
      rafId = null;
    });
  };

  scrollDOM.addEventListener('scroll', handleScroll);
  // Sync initial position
  container.scrollTop = scrollDOM.scrollTop;

  return () => {
    scrollDOM.removeEventListener('scroll', handleScroll);
    if (rafId !== null) cancelAnimationFrame(rafId);
  };
}, [view]);
```

This ensures the scroll sync happens after CM6's measure cycle completes (which also uses rAF), so the container scrollTop matches the stabilized editor scroll position.

- [ ] **Step 2: Run existing tests**

Run: `cd /home/penguin/code/lens-relay/ws1/lens-editor && npm run test:run`
Expected: All tests pass

- [ ] **Step 3: Commit**

```
fix(editor): debounce CommentMargin scroll sync with rAF

Align scroll synchronization with the browser's paint cycle so
it reads the editor's scroll position after CM6 has completed
its measure cycle, preventing stale reads that cause layout jitter.
```

---

### Task 9: Fix useActiveHeading listener accumulation

`useActiveHeading` uses `StateEffect.appendConfig` to add an `EditorView.updateListener` on every render cycle when dependencies change. These listeners are never removed, causing cumulative processing overhead.

**Files:**
- Modify: `lens-editor/src/components/TableOfContents/useHeadings.ts:139-189`

- [ ] **Step 1: Replace appendConfig with a Compartment for the update listener**

Use a Compartment that's reconfigured instead of appending new config entries. This way old listeners are replaced, not accumulated.

Add a `useRef` for the compartment and reconfigure instead of append:

```typescript
import { useState, useEffect, useCallback, useRef } from 'react';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { StateEffect, Compartment } from '@codemirror/state';
import { flashHeadingLine } from '../Editor/extensions/headingFlash';
import type { EditorState } from '@codemirror/state';
```

Then rewrite `useActiveHeading`:

```typescript
export function useActiveHeading(view: EditorView | null, headings: Heading[]): number {
  const [activeIndex, setActiveIndex] = useState(-1);
  const compartmentRef = useRef<Compartment | null>(null);
  const installedRef = useRef(false);
  const installedViewRef = useRef<EditorView | null>(null);

  const updateActive = useCallback(() => {
    if (!view || headings.length === 0) {
      setActiveIndex(-1);
      return;
    }

    const cursorPos = view.state.selection.main.head;
    let active = -1;

    for (let i = 0; i < headings.length; i++) {
      if (headings[i].from <= cursorPos) {
        active = i;
      } else {
        break;
      }
    }

    if (active === -1 && headings.length > 0) {
      active = 0;
    }

    setActiveIndex(active);
  }, [view, headings]);

  useEffect(() => {
    if (!view) return;

    // Initial computation
    updateActive();

    const listener = EditorView.updateListener.of((update) => {
      if (update.selectionSet) {
        updateActive();
      }
    });

    if (!installedRef.current || installedViewRef.current !== view) {
      // First install or view changed: create compartment and append it
      const compartment = new Compartment();
      compartmentRef.current = compartment;
      installedViewRef.current = view;
      view.dispatch({ effects: StateEffect.appendConfig.of(compartment.of(listener)) });
      installedRef.current = true;
    } else if (compartmentRef.current) {
      // Subsequent updates (same view): reconfigure the compartment (replaces the listener)
      view.dispatch({ effects: compartmentRef.current.reconfigure(listener) });
    }
  }, [view, updateActive]);

  return activeIndex;
}
```

This ensures only one listener exists at a time. When `updateActive` changes (because headings changed), the compartment is reconfigured with the new callback instead of stacking another listener.

- [ ] **Step 2: Run existing tests**

Run: `cd /home/penguin/code/lens-relay/ws1/lens-editor && npm run test:run`
Expected: All tests pass

- [ ] **Step 3: Commit**

```
fix(editor): prevent listener accumulation in useActiveHeading

Replace StateEffect.appendConfig with a Compartment that gets
reconfigured on dependency changes. Previously, every re-render
appended a new EditorView.updateListener without removing the old
one, causing cumulative processing overhead.
```

---

## Verification

After all tasks are complete:

- [ ] **Run full test suite:** `cd /home/penguin/code/lens-relay/ws1/lens-editor && npm run test:run`
- [ ] **Manual testing:** Start the editor (`npm run dev:local`) and verify:
  1. Open a document with headings, images, emphasis, code blocks, CriticMarkup, and wikilinks
  2. Type continuously and verify no scroll jumping
  3. Scroll up and down rapidly, then type — verify position stability
  4. Load a document with images — verify scroll doesn't jump when images load
  5. Click headings in ToC — verify flash animation works without layout glitch
  6. Open a document with CriticMarkup — verify decorations render correctly while typing
