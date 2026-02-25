# List & Checklist Live Preview Rendering

## Summary

Add bullet point and checklist rendering to the lens-editor's live preview, matching Obsidian's behavior. Bullet markers (`-`, `*`, `+`) are replaced with dot widgets; checklist markers (`- [ ]`, `- [x]`) are replaced with interactive checkbox widgets. Raw markdown is revealed only when the cursor directly touches the marker characters.

## Decisions

- **Bullet style**: Simple dot (`•`) at all nesting levels (no level-differentiated shapes)
- **Ordered lists**: Excluded from this work; stay as raw markdown
- **Checklist toggle**: Clicking the checkbox toggles `[ ]` ↔ `[x]` in the document (Yjs-compatible)
- **Completed task styling**: Strikethrough on text content (no dimming/opacity change)
- **Approach**: All changes in `livePreview.ts` following the existing ViewPlugin pattern
- **Cursor behavior**: `selectionIntersects()` on the marker character range (not line-level)

## Architecture

### Parsing

Add `TaskList` from `@lezer/markdown` to the markdown language extensions in `Editor.tsx` alongside `WikilinkExtension`. This provides two new syntax tree nodes:

- `Task` — block node wrapping the list item content when it starts with `[ ]`/`[x]`
- `TaskMarker` — the `[ ]` or `[x]`/`[X]` characters

Existing nodes used:
- `ListMark` — the `- `, `* `, `+ ` marker (already parsed by default)
- `BulletList` / `ListItem` — list structure (already parsed)

### Bullet Rendering

In `buildDecorations()`, when encountering a `ListMark` node whose parent is inside a `BulletList` (not an `OrderedList`):

1. Check `selectionIntersects(selection, listMark.from, listMark.to)`
2. If cursor NOT touching: `Decoration.replace({ widget: new BulletWidget() })` covering `listMark.from` to `listMark.to`
3. If cursor touching: no decoration (raw `- ` visible)

`BulletWidget` renders `<span class="cm-bullet">•</span>`.

Also need to check this is not a task list item (has no `Task` child) — if it is, the checklist handler takes over.

### Checklist Rendering

When encountering a `TaskMarker` node:

1. Find the preceding `ListMark` sibling to get the full marker range (`- [x] `)
2. Check `selectionIntersects(selection, listMark.from, taskMarker.to + 1)` (includes trailing space)
3. If cursor NOT touching: `Decoration.replace({ widget: new CheckboxWidget(checked, view, taskMarkerFrom, taskMarkerTo) })` covering the full range
4. If cursor touching: no decoration (raw `- [ ] ` visible)

`CheckboxWidget`:
- Renders `<input type="checkbox">` (or styled `<span>`) with appropriate checked state
- `onclick` dispatches a CodeMirror transaction replacing `[ ]` with `[x]` or `[x]`/`[X]` with `[ ]`
- Transaction flows through y-codemirror.next → Yjs automatically

### Completed Task Strikethrough

When `TaskMarker` content is `x` or `X`, apply `Decoration.mark({ class: 'cm-task-completed' })` to the text content from `taskMarker.to + 1` to end of line. Only applied when cursor is NOT touching the task marker range (same `selectionIntersects` check).

### CSS

```css
.cm-bullet {
  color: #6b7280;
}

.cm-checkbox {
  /* Interactive checkbox styling */
  cursor: pointer;
  vertical-align: middle;
}

.cm-task-completed {
  text-decoration: line-through;
}
```

## Files Changed

| File | Change |
|------|--------|
| `livePreview.ts` | Add `BulletWidget`, `CheckboxWidget`, bullet/checklist decoration logic in `buildDecorations()` |
| `index.css` | Add `.cm-bullet`, `.cm-checkbox`, `.cm-task-completed` styles |
| `Editor.tsx` | Add `TaskList` to markdown extensions |
| `codemirror-helpers.ts` | Add `TaskList` to test editor markdown config |
| `livePreview.test.ts` | Add bullet and checklist test suites |

## Testing (TDD)

Tests written first, then implementation to make them pass.

### Bullet tests (`describe('livePreview - bullet lists')`)

1. Replaces bullet marker with dot widget when cursor outside
2. Shows raw `-` marker when cursor touches marker
3. Updates when cursor moves in and out of marker
4. Does not replace ordered list markers
5. Handles nested bullet lists

### Checklist tests (`describe('livePreview - checklists')`)

1. Replaces unchecked task with checkbox widget when cursor outside
2. Replaces checked task with checked checkbox when cursor outside
3. Shows raw `[ ]` when cursor touches checkbox marker
4. Applies strikethrough to completed task text
5. No strikethrough on unchecked task text
6. Checkbox click toggles `[ ]` to `[x]`
7. Checkbox click toggles `[x]` to `[ ]`
8. Toggle preserves surrounding text
