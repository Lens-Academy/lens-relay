# List & Checklist Live Preview Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add bullet point and checklist rendering to the live preview, replacing markers with visual widgets and providing interactive checkbox toggle.

**Architecture:** Extend the existing `livePreview.ts` ViewPlugin with two new widget types (`BulletWidget`, `CheckboxWidget`) and new `buildDecorations()` branches for `ListMark` and `TaskMarker` syntax nodes. Uses `selectionIntersects()` for cursor-proximity reveal. Add `TaskList` from `@lezer/markdown` for checklist parsing.

**Tech Stack:** CodeMirror 6, @lezer/markdown (TaskList GFM extension), Vitest, TypeScript

---

## Task 1: Enable TaskList Parsing

Add the `TaskList` extension from `@lezer/markdown` so the syntax tree includes `Task` and `TaskMarker` nodes for checklist items.

**Files:**
- Modify: `lens-editor/src/components/Editor/Editor.tsx:18,233-237`
- Modify: `lens-editor/src/test/codemirror-helpers.ts:3,24`

**Step 1: Add TaskList import and extension in Editor.tsx**

In `Editor.tsx`, add the import:

```typescript
import { TaskList } from '@lezer/markdown';
```

Then change the markdown config (line 233-237) from:

```typescript
        markdown({
          base: markdownLanguage,
          extensions: [WikilinkExtension],
          addKeymap: false,
        }),
```

to:

```typescript
        markdown({
          base: markdownLanguage,
          extensions: [WikilinkExtension, TaskList],
          addKeymap: false,
        }),
```

**Step 2: Add TaskList to test helper**

In `codemirror-helpers.ts`, add the import:

```typescript
import { TaskList } from '@lezer/markdown';
```

Then change `createTestEditor` (line 24) from:

```typescript
      markdown({ extensions: [WikilinkExtension] }),
```

to:

```typescript
      markdown({ extensions: [WikilinkExtension, TaskList] }),
```

**Step 3: Verify existing tests still pass**

Run: `cd lens-editor && npx vitest run src/components/Editor/extensions/livePreview.test.ts`

Expected: All existing tests PASS (TaskList extension is additive, doesn't break existing parsing).

**Step 4: Commit**

```
feat(editor): add TaskList parser extension for checklist support
```

---

## Task 2: Bullet List Rendering — Tests

Write failing tests for bullet marker replacement with dot widget.

**Files:**
- Modify: `lens-editor/src/components/Editor/extensions/livePreview.test.ts`

**Step 1: Add bullet list test suite**

Append this test suite to `livePreview.test.ts`:

```typescript
describe('livePreview - bullet lists', () => {
  let cleanup: () => void;

  afterEach(() => {
    if (cleanup) cleanup();
  });

  it('replaces bullet marker with dot widget when cursor outside', () => {
    const content = '- item one\n\nParagraph';
    const { view, cleanup: c } = createTestEditor(content, 20);
    cleanup = c;

    expect(hasClass(view, 'cm-bullet')).toBe(true);
  });

  it('shows raw - marker when cursor touches marker', () => {
    // Cursor at position 0 = on the `-` character
    const content = '- item one\n\nParagraph';
    const { view, cleanup: c } = createTestEditor(content, 0);
    cleanup = c;

    expect(hasClass(view, 'cm-bullet')).toBe(false);
  });

  it('updates when cursor moves in and out of marker', () => {
    const content = '- item one\n\nParagraph';
    const { view, cleanup: c } = createTestEditor(content, 20);
    cleanup = c;

    // Initially outside: bullet widget shown
    expect(hasClass(view, 'cm-bullet')).toBe(true);

    // Move cursor onto marker
    moveCursor(view, 0);
    expect(hasClass(view, 'cm-bullet')).toBe(false);

    // Move cursor back outside
    moveCursor(view, 20);
    expect(hasClass(view, 'cm-bullet')).toBe(true);
  });

  it('does not replace ordered list markers', () => {
    const content = '1. first item\n\nParagraph';
    const { view, cleanup: c } = createTestEditor(content, 22);
    cleanup = c;

    expect(hasClass(view, 'cm-bullet')).toBe(false);
  });

  it('handles nested bullet lists', () => {
    const content = '- outer\n  - inner\n\nParagraph';
    const { view, cleanup: c } = createTestEditor(content, 27);
    cleanup = c;

    // Both bullets should be rendered
    expect(countClass(view, 'cm-bullet')).toBe(2);
  });

  it('does not replace bullet marker on task list items', () => {
    // Task list items are handled by the checklist code, not bullet code
    const content = '- [ ] task item\n\nParagraph';
    const { view, cleanup: c } = createTestEditor(content, 25);
    cleanup = c;

    expect(hasClass(view, 'cm-bullet')).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd lens-editor && npx vitest run src/components/Editor/extensions/livePreview.test.ts`

Expected: All 6 new bullet tests FAIL (no `cm-bullet` class exists yet). Existing tests PASS.

**Step 3: Commit**

```
test(editor): add failing tests for bullet list rendering
```

---

## Task 3: Bullet List Rendering — Implementation

Add `BulletWidget` and the `ListMark` decoration branch to make bullet tests pass.

**Files:**
- Modify: `lens-editor/src/components/Editor/extensions/livePreview.ts`
- Modify: `lens-editor/src/index.css`

**Step 1: Add BulletWidget class**

In `livePreview.ts`, add after the `LinkWidget` class (after line 145):

```typescript
/**
 * BulletWidget - Renders bullet list markers as a dot character
 */
class BulletWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-bullet';
    span.textContent = '•';
    return span;
  }

  eq(): boolean {
    return true;
  }
}
```

**Step 2: Add ListMark handling in buildDecorations**

In `buildDecorations()`, inside the `enter(node)` callback, add before the closing `},` of the enter function (before line 339):

```typescript
            // ListMark in bullet lists: replace with dot widget when cursor not touching
            if (node.name === 'ListMark') {
              // Only handle bullet lists, not ordered lists
              const parent = node.node.parent; // ListItem
              const grandparent = parent?.parent; // BulletList or OrderedList
              if (grandparent && grandparent.name === 'BulletList') {
                // Skip if this is a task list item (has Task child — handled by checklist code)
                const listItem = parent;
                let isTask = false;
                if (listItem) {
                  for (let child = listItem.firstChild; child; child = child.nextSibling) {
                    if (child.name === 'Task') { isTask = true; break; }
                  }
                }
                if (!isTask && !selectionIntersects(selection, node.from, node.to)) {
                  decorations.push({
                    from: node.from,
                    to: node.to,
                    deco: Decoration.replace({
                      widget: new BulletWidget(),
                    }),
                  });
                }
              }
            }
```

**Step 3: Add CSS for bullet widget**

In `index.css`, add after the `.cm-inline-code` block (after line 157):

```css
/* Bullet list dot */
.cm-bullet {
  color: #6b7280;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd lens-editor && npx vitest run src/components/Editor/extensions/livePreview.test.ts`

Expected: All bullet tests PASS. All existing tests PASS.

**Step 5: Commit**

```
feat(editor): render bullet list markers as dot widgets in live preview
```

---

## Task 4: Checklist Rendering — Tests

Write failing tests for checkbox widget rendering, strikethrough, and toggle.

**Files:**
- Modify: `lens-editor/src/components/Editor/extensions/livePreview.test.ts`

**Step 1: Add checklist test suite**

Append to `livePreview.test.ts`:

```typescript
describe('livePreview - checklists', () => {
  let cleanup: () => void;

  afterEach(() => {
    if (cleanup) cleanup();
  });

  it('replaces unchecked task with checkbox widget when cursor outside', () => {
    const content = '- [ ] buy milk\n\nParagraph';
    const { view, cleanup: c } = createTestEditor(content, 24);
    cleanup = c;

    expect(hasClass(view, 'cm-checkbox')).toBe(true);
  });

  it('replaces checked task with checked checkbox when cursor outside', () => {
    const content = '- [x] buy milk\n\nParagraph';
    const { view, cleanup: c } = createTestEditor(content, 24);
    cleanup = c;

    const checkbox = view.contentDOM.querySelector('.cm-checkbox') as HTMLInputElement | null;
    expect(checkbox).not.toBeNull();
    expect(checkbox!.checked).toBe(true);
  });

  it('shows raw [ ] when cursor touches checkbox marker', () => {
    const content = '- [ ] buy milk\n\nParagraph';
    // Cursor at position 2 = on the `[` character
    const { view, cleanup: c } = createTestEditor(content, 2);
    cleanup = c;

    expect(hasClass(view, 'cm-checkbox')).toBe(false);
  });

  it('applies strikethrough to completed task text', () => {
    const content = '- [x] done task\n\nParagraph';
    const { view, cleanup: c } = createTestEditor(content, 25);
    cleanup = c;

    expect(hasClass(view, 'cm-task-completed')).toBe(true);
  });

  it('no strikethrough on unchecked task text', () => {
    const content = '- [ ] pending task\n\nParagraph';
    const { view, cleanup: c } = createTestEditor(content, 27);
    cleanup = c;

    expect(hasClass(view, 'cm-task-completed')).toBe(false);
  });

  it('checkbox click toggles [ ] to [x]', () => {
    const content = '- [ ] buy milk\n\nParagraph';
    const { view, cleanup: c } = createTestEditor(content, 24);
    cleanup = c;

    const checkbox = view.contentDOM.querySelector('.cm-checkbox') as HTMLInputElement;
    expect(checkbox).not.toBeNull();

    // Click the checkbox
    checkbox.click();

    // Document should now contain [x]
    expect(view.state.doc.toString()).toContain('- [x] buy milk');
  });

  it('checkbox click toggles [x] to [ ]', () => {
    const content = '- [x] buy milk\n\nParagraph';
    const { view, cleanup: c } = createTestEditor(content, 24);
    cleanup = c;

    const checkbox = view.contentDOM.querySelector('.cm-checkbox') as HTMLInputElement;
    expect(checkbox).not.toBeNull();

    // Click the checkbox
    checkbox.click();

    // Document should now contain [ ]
    expect(view.state.doc.toString()).toContain('- [ ] buy milk');
  });

  it('toggle preserves surrounding text', () => {
    const content = '- [ ] buy milk\n- [x] eggs\n\nEnd';
    const { view, cleanup: c } = createTestEditor(content, 30);
    cleanup = c;

    // Toggle the first checkbox
    const checkboxes = view.contentDOM.querySelectorAll('.cm-checkbox') as NodeListOf<HTMLInputElement>;
    expect(checkboxes.length).toBe(2);

    checkboxes[0].click();

    const doc = view.state.doc.toString();
    expect(doc).toContain('- [x] buy milk');
    expect(doc).toContain('- [x] eggs');
    expect(doc).toContain('End');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd lens-editor && npx vitest run src/components/Editor/extensions/livePreview.test.ts`

Expected: All 8 new checklist tests FAIL. All existing + bullet tests PASS.

**Step 3: Commit**

```
test(editor): add failing tests for checklist rendering and toggle
```

---

## Task 5: Checklist Rendering — Implementation

Add `CheckboxWidget` and the `TaskMarker` decoration branch, plus strikethrough for completed tasks.

**Files:**
- Modify: `lens-editor/src/components/Editor/extensions/livePreview.ts`
- Modify: `lens-editor/src/index.css`

**Step 1: Add CheckboxWidget class**

In `livePreview.ts`, add after the `BulletWidget` class:

```typescript
/**
 * CheckboxWidget - Renders checklist markers as interactive checkboxes.
 * Clicking toggles [ ] ↔ [x] in the document.
 */
class CheckboxWidget extends WidgetType {
  private checked: boolean;
  private view: EditorView;
  private markerFrom: number;
  private markerTo: number;

  constructor(checked: boolean, view: EditorView, markerFrom: number, markerTo: number) {
    super();
    this.checked = checked;
    this.view = view;
    this.markerFrom = markerFrom;
    this.markerTo = markerTo;
  }

  toDOM(): HTMLElement {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'cm-checkbox';
    input.checked = this.checked;
    input.onclick = (e) => {
      e.preventDefault();
      const newText = this.checked ? '[ ]' : '[x]';
      this.view.dispatch({
        changes: { from: this.markerFrom, to: this.markerTo, insert: newText },
      });
    };
    return input;
  }

  eq(other: CheckboxWidget): boolean {
    return this.checked === other.checked
      && this.markerFrom === other.markerFrom
      && this.markerTo === other.markerTo;
  }
}
```

**Step 2: Add TaskMarker handling in buildDecorations**

In `buildDecorations()`, inside the `enter(node)` callback, add after the `ListMark` bullet handler:

```typescript
            // TaskMarker: replace list marker + task marker with checkbox widget
            if (node.name === 'TaskMarker') {
              // Find the ListMark sibling (the `- ` part)
              const task = node.node.parent; // Task node
              const listItem = task?.parent; // ListItem node
              let listMark: { from: number; to: number } | null = null;
              if (listItem) {
                for (let child = listItem.firstChild; child; child = child.nextSibling) {
                  if (child.name === 'ListMark') {
                    listMark = { from: child.from, to: child.to };
                    break;
                  }
                }
              }

              const replaceFrom = listMark ? listMark.from : node.from;
              // Include trailing space after ] in the replacement range
              const replaceTo = Math.min(node.to + 1, view.state.doc.lineAt(node.from).to);

              if (!selectionIntersects(selection, replaceFrom, replaceTo)) {
                const markerText = view.state.doc.sliceString(node.from, node.to);
                const isChecked = markerText !== '[ ]';

                decorations.push({
                  from: replaceFrom,
                  to: replaceTo,
                  deco: Decoration.replace({
                    widget: new CheckboxWidget(isChecked, view, node.from, node.to),
                  }),
                });

                // Strikethrough for completed tasks
                if (isChecked) {
                  const lineEnd = view.state.doc.lineAt(node.from).to;
                  if (replaceTo < lineEnd) {
                    decorations.push({
                      from: replaceTo,
                      to: lineEnd,
                      deco: Decoration.mark({ class: 'cm-task-completed' }),
                    });
                  }
                }
              }
            }
```

**Step 3: Add CSS for checkbox and strikethrough**

In `index.css`, add after the `.cm-bullet` rule:

```css
/* Checklist checkbox */
.cm-checkbox {
  cursor: pointer;
  vertical-align: middle;
  margin: 0 4px 0 0;
  width: 15px;
  height: 15px;
}

/* Completed task strikethrough */
.cm-task-completed {
  text-decoration: line-through;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd lens-editor && npx vitest run src/components/Editor/extensions/livePreview.test.ts`

Expected: All checklist tests PASS. All existing + bullet tests PASS.

**Step 5: Commit**

```
feat(editor): render checklists as interactive checkboxes in live preview
```

---

## Task 6: Update Module Doc Comment and Final Verification

Update the file header comment to document the new features, and run all tests.

**Files:**
- Modify: `lens-editor/src/components/Editor/extensions/livePreview.ts:1-14`

**Step 1: Update the doc comment**

Replace the file header comment (lines 1-14) with:

```typescript
/**
 * Live Preview Extension for CodeMirror 6
 *
 * Implements Obsidian-style inline rendering where markdown syntax hides
 * when cursor moves away and reveals when editing.
 *
 * Key features:
 * - Headings (H1-H6) display with progressively smaller font sizes
 * - # markers hidden when cursor not on heading line
 * - Bold/italic text shows formatted when cursor moves away
 * - Asterisks/underscores hidden when cursor not on that text
 * - Links render as clickable text with external link icon
 * - Inline code shows with distinct background styling
 * - Bullet list markers replaced with dot (•) widget
 * - Checklists rendered as interactive checkboxes with toggle
 * - Completed tasks shown with strikethrough
 */
```

**Step 2: Run full test suite**

Run: `cd lens-editor && npx vitest run`

Expected: ALL tests pass across the entire project.

**Step 3: Manual smoke test (if relay server is running)**

Start the dev server and verify visually:
- Bullet lists show `•` dots
- Checklists show checkboxes
- Clicking checkboxes toggles them
- Completed items have strikethrough
- Cursor on markers reveals raw markdown

**Step 4: Commit**

```
docs(editor): update livePreview header to document list/checklist features
```

---

## Summary of All Changes

| File | Lines Added (approx) | Nature |
|------|---------------------|--------|
| `Editor.tsx` | 2 | Import + extension config |
| `codemirror-helpers.ts` | 2 | Import + test config |
| `livePreview.ts` | ~80 | Two widget classes + two decoration branches |
| `index.css` | ~15 | Three new CSS rules |
| `livePreview.test.ts` | ~140 | Two test suites (14 tests) |
