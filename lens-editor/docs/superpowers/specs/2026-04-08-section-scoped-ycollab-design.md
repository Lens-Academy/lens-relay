# Section-Scoped yCollab Sync

Replace the decoration-based section editor (6 CM extensions, 266 lines) with a forked yCollab ViewPlugin that syncs only a slice of Y.Text to a CM instance containing only that slice's text.

## Problem

The prototype section editor uses one CM instance showing the full Y.Doc, then hides non-active sections with replace decorations. This requires 6 defensive extensions (decorations, atomicRanges, cursorClamp, sectionSelectAll, sectionChangeGuard, sectionField) to prevent user actions from reaching hidden content. The `changeFilter` range-return breaks yCollab's DOM mutation reconciliation. Each extension patches a leak from the previous one.

## Solution

Fork yCollab's `YSyncPluginValue` (~60 lines) into `y-section-sync.ts`. The forked plugin takes `(ytext, sectionFrom, sectionTo)` and bridges a slice of Y.Text to a CM instance that contains only that slice's text. CM naturally constrains all editing — no decorations, guards, clamps, or selectAll overrides needed.

## Architecture

```
Y.Text('contents')  ←── full markdown document
  │
  ├─ ySectionSync ViewPlugin
  │     ├─ CM → Y.Text: offset positions by sectionFrom
  │     └─ Y.Text → CM: filter delta to [sectionFrom, sectionTo], offset by -sectionFrom
  │
  └─ CM EditorView (contains only section text)
```

### Module: `y-section-sync.ts`

Exports `ySectionSync(ytext: Y.Text, sectionFrom: number, sectionTo: number): Extension[]`.

Returns a CM6 extension array containing:

*   A `Facet` holding the sync config (ytext, sectionFrom, sectionTo refs)
*   An `Annotation` for origin tracking
*   A `ViewPlugin` implementing bidirectional sync

### Sync: CM → Y.Text

On CM `update`:

1.  Skip if no doc changes
2.  Skip if transaction has our sync annotation (origin tracking)
3.  Iterate CM changes, offset all positions by `sectionFrom`
4.  Apply `ytext.delete()` / `ytext.insert()` inside `ytext.doc.transact(fn, config)` where `config` is the origin marker
5.  Update `sectionTo` by the net change delta

### Sync: Y.Text → CM

On Y.Text `observe`:

1.  Skip if `event.transaction.origin === config` (our own changes)
2.  Walk the delta tracking absolute position in the full document
3.  For each delta operation:
    *   **Before section** (`pos < sectionFrom`): Adjust `sectionFrom` and `sectionTo` by the insert/delete size. Don't touch CM.
    *   **Within section** (`sectionFrom <= pos < sectionTo`): Build a CM change at `pos - sectionFrom`. Update `sectionTo`.
    *   **After section** (`pos >= sectionTo`): Ignore.
    *   **Spanning start boundary** (delete starts before section, ends inside): Adjust `sectionFrom` by the before-section portion deleted. Apply the in-section portion as a CM delete from position 0.
    *   **Spanning end boundary** (delete starts inside section, ends after): Apply delete from `pos - sectionFrom` to end of CM doc. Adjust `sectionTo`.
4.  Dispatch accumulated CM changes with sync annotation

### Section Offset Tracking

`sectionFrom` and `sectionTo` are mutable properties on the plugin instance. Updated synchronously in the Y.Text observer before CM dispatch. No race conditions: Yjs observers fire synchronously within the JS event loop, before the next user input event.

## Component: SectionEditor.tsx

### Reused from prototype (unchanged)

*   `SectionCard` component (card layout with colored borders)
*   Sync detection (`useEffect` with provider/polling)
*   Section list observer (`ytext.observe` → `parseSections` → `setSections`)
*   Route in `App.tsx`

### Changed: CM lifecycle

On section activation:

1.  Parse sections, get `section.from` and `section.to`
2.  Extract section text: `ytext.toString().slice(from, to)`
3.  Create `EditorState` with section text + extensions:
    *   `ySectionSync(ytext, from, to)` (the forked sync)
    *   `markdown()`, `syntaxHighlighting()`, `keymap`, theme
    *   `yUndoManagerKeymap` (Yjs undo)
4.  Create `EditorView`, mount in section's container div
5.  Focus and place cursor

On "Done" or section switch:

1.  Destroy the EditorView (plugin cleanup unobserves Y.Text automatically)

No hidden off-screen div. No DOM reparenting. No `setActiveSection` effect.

### Undo

Create a `Y.UndoManager(ytext, { trackedOrigins: new Set([config]) })` scoped to the sync origin. Only edits made through this CM instance are tracked. Passed to CM via `yUndoManagerKeymap`.

## What's Deleted

`sectionDecorations.ts` — all 266 lines:

*   `sectionField` (StateField)
*   `buildDecorations()` / `sectionDecorations` / `sectionAtomicRanges`
*   `sectionChangeGuard` (transactionFilter)
*   `sectionSelectAll` (keymap override)
*   `sectionCursorClamp` (updateListener)
*   `setActiveSection` (StateEffect)
*   `CollapsedWidget` (WidgetType)

`sectionDecorations.test.ts` and `sectionGuard.test.ts` — replaced by `y-section-sync.test.ts`.

## Testing Strategy

Unit test `y-section-sync.ts` with real Y.Doc + real CM EditorView in vitest. No mocks.

### Test cases

1.  **CM insert → Y.Text**: Insert text in CM, verify it appears in Y.Text at `sectionFrom + offset`
2.  **CM delete → Y.Text**: Delete text in CM, verify Y.Text reflects the deletion at correct offset
3.  **External insert before section**: Insert into Y.Text before sectionFrom, verify sectionFrom shifts and CM content is unchanged
4.  **External insert within section**: Insert into Y.Text within section range, verify it appears in CM at correct offset
5.  **External insert after section**: Insert into Y.Text after sectionTo, verify CM is unchanged
6.  **External delete spanning section boundary**: Delete range that starts before and extends into section, verify CM reflects only the in-section portion
7.  **Origin tracking**: CM edit doesn't trigger Y.Text → CM feedback loop
8.  **Offset consistency**: Multiple interleaved local and remote edits, verify sectionFrom/sectionTo remain correct