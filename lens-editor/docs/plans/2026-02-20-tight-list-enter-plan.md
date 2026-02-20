# Tight List Enter Handler Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the double-linebreak bug when pressing Enter in bullet lists by wrapping the upstream markdown Enter handler to always produce tight list continuations.

**Architecture:** Post-process wrapper around `@codemirror/lang-markdown`'s `insertNewlineContinueMarkup`. The wrapper captures the upstream command's transaction, collapses any blank-line insertions (`\n[whitespace]\n` → `\n`), and dispatches the modified transaction. Uses `insertNewlineContinueMarkupCommand({ nonTightLists: false })` to also prevent tight-to-non-tight conversion on empty items.

**Tech Stack:** TypeScript, CodeMirror 6, `@codemirror/lang-markdown`, Vitest

**Design doc:** `docs/plans/2026-02-20-tight-list-enter-design.md`

---

### Task 1: Test infrastructure — add helpers to codemirror-helpers.ts

**Files:**
- Modify: `src/test/codemirror-helpers.ts`

**Step 1: Add `createMarkdownEditor` and `pressEnter` helpers**

Add at end of `src/test/codemirror-helpers.ts`:

```typescript
import { Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { tightMarkdownKeymap } from '../components/Editor/extensions/tightListEnter';

/**
 * Create an EditorView with the tight-list markdown keymap for testing.
 * Mirrors the Editor.tsx extension stack relevant to Enter/Backspace.
 */
export function createMarkdownEditor(
  content: string,
  cursorPos: number
): { view: EditorView; cleanup: () => void } {
  const state = EditorState.create({
    doc: content,
    selection: { anchor: cursorPos },
    extensions: [
      markdown({
        extensions: [WikilinkExtension],
        addKeymap: false,
      }),
      Prec.high(keymap.of(tightMarkdownKeymap)),
      keymap.of(defaultKeymap),
    ],
  });

  const view = new EditorView({
    state,
    parent: document.body,
  });

  return {
    view,
    cleanup: () => view.destroy(),
  };
}

/**
 * Simulate pressing Enter through the tight-list markdown keymap.
 * Uses the same binding-lookup pattern as criticmarkup-commands.test.ts.
 */
export function pressEnter(view: EditorView): boolean {
  const binding = tightMarkdownKeymap.find((k) => k.key === 'Enter');
  return binding?.run?.(view) ?? false;
}
```

Also add the new imports at the top of the file (merge with existing):

```typescript
import { Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { tightMarkdownKeymap } from '../components/Editor/extensions/tightListEnter';
```

**Note:** This will NOT compile yet — `tightListEnter.ts` doesn't exist. That's expected; the failing test in Task 2 will confirm this.

**Step 2: Commit helpers (no test run yet — imports will fail until Task 2 creates the module)**

No commit yet — we'll commit together with the first passing test.

---

### Task 2: Write failing test — non-tight bullet list produces tight continuation

This is the core bug case. A list with blank lines between items should produce tight continuation on Enter.

**Files:**
- Create: `src/components/Editor/extensions/tightListEnter.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { createMarkdownEditor, pressEnter } from '../../../test/codemirror-helpers';

describe('Tight List Enter Handler', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    if (cleanup) cleanup();
  });

  describe('non-tight bullet list', () => {
    it('produces tight continuation on Enter', () => {
      // Non-tight list: blank line between items
      const doc = '- first\n\n- second';
      const { view, cleanup: c } = createMarkdownEditor(doc, doc.length);
      cleanup = c;

      pressEnter(view);

      // New bullet should follow immediately — no blank line before it
      expect(view.state.doc.toString()).toBe('- first\n\n- second\n- ');
    });

    it('places cursor after new bullet marker', () => {
      const doc = '- first\n\n- second';
      const { view, cleanup: c } = createMarkdownEditor(doc, doc.length);
      cleanup = c;

      pressEnter(view);

      const expected = '- first\n\n- second\n- ';
      expect(view.state.selection.main.head).toBe(expected.length);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /home/penguin/code/lens-relay/ws2/lens-editor && npx vitest run src/components/Editor/extensions/tightListEnter.test.ts`

Expected: FAIL — module `tightListEnter` does not exist.

---

### Task 3: Implement `tightListContinueMarkup` — make the test pass

**Files:**
- Create: `src/components/Editor/extensions/tightListEnter.ts`

**Step 1: Write the implementation**

```typescript
/**
 * Tight List Enter Handler
 *
 * Wraps @codemirror/lang-markdown's insertNewlineContinueMarkup to always
 * produce tight list continuations (single \n between items), matching
 * Obsidian's behavior. The upstream command preserves non-tight (loose)
 * list formatting by inserting blank lines; this wrapper collapses them.
 */
import type { StateCommand, Transaction } from '@codemirror/state';
import { EditorSelection } from '@codemirror/state';
import {
  insertNewlineContinueMarkupCommand,
  deleteMarkupBackward,
} from '@codemirror/lang-markdown';

/**
 * Upstream command configured with nonTightLists: false.
 * This prevents the secondary trigger: pressing Enter on an empty 2nd
 * item in a tight list converting it to non-tight. Instead, it exits
 * the list (removes the marker), matching Obsidian behavior.
 */
const upstreamEnter = insertNewlineContinueMarkupCommand({
  nonTightLists: false,
});

/**
 * Matches the blank line inserted by nonTightList detection.
 * Pattern: \n followed by optional blockquote/indent chars (> space tab),
 * then another \n.
 *
 * Examples matched:
 *   "\n\n"       — simple list
 *   "\n  \n"     — nested list (indentation)
 *   "\n> \n"     — list inside blockquote
 */
const NON_TIGHT_BLANK = /\n[> \t]*\n/;

/**
 * Enter handler that always produces tight list continuations.
 *
 * Delegates to the upstream markdown Enter command, then collapses any
 * blank-line insertion (from non-tight list detection) into a single
 * newline before dispatching.
 */
export const tightListContinueMarkup: StateCommand = ({ state, dispatch }) => {
  let captured: Transaction | null = null;
  const handled = upstreamEnter({
    state,
    dispatch: (tr: Transaction) => {
      captured = tr;
    },
  });

  if (!handled || !captured) return false;

  const tr = captured;

  // Extract changes, collapsing non-tight blank lines
  const newChanges: { from: number; to: number; insert: string }[] = [];
  let totalRemoved = 0;

  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    let text = inserted.toString();
    const match = text.match(NON_TIGHT_BLANK);
    if (match) {
      totalRemoved += match[0].length - 1; // keep one \n
      text = text.replace(NON_TIGHT_BLANK, '\n');
    }
    newChanges.push({ from: fromA, to: toA, insert: text });
  });

  if (totalRemoved === 0) {
    // No non-tight pattern — dispatch original transaction unchanged
    dispatch(tr);
    return true;
  }

  // Rebuild transaction with collapsed newlines and adjusted cursor
  const newSelection = EditorSelection.create(
    tr.selection.ranges.map((r) =>
      EditorSelection.cursor(r.head - totalRemoved)
    )
  );

  dispatch(
    state.update({
      changes: newChanges,
      selection: newSelection,
      scrollIntoView: true,
      userEvent: 'input',
    })
  );

  return true;
};

/**
 * Markdown keymap with tight list Enter behavior.
 * Replaces the built-in markdownKeymap from @codemirror/lang-markdown.
 * Install at Prec.high to match the precedence of the original.
 */
export const tightMarkdownKeymap = [
  { key: 'Enter' as const, run: tightListContinueMarkup },
  { key: 'Backspace' as const, run: deleteMarkupBackward },
];
```

**Step 2: Run test to verify it passes**

Run: `cd /home/penguin/code/lens-relay/ws2/lens-editor && npx vitest run src/components/Editor/extensions/tightListEnter.test.ts`

Expected: PASS — both tests green.

**Step 3: Commit**

```
feat(editor): add tight list Enter handler

Wraps upstream markdown Enter to always produce tight list
continuations, fixing the double-linebreak bug in bullet lists.
```

---

### Task 4: Write edge case tests — ordered list, tight list, empty item

These should all pass with the existing implementation. If any fail, adjust implementation before continuing.

**Files:**
- Modify: `src/components/Editor/extensions/tightListEnter.test.ts`

**Step 1: Add edge case tests**

Append to the existing describe block:

```typescript
  describe('non-tight ordered list', () => {
    it('produces tight continuation with correct numbering', () => {
      const doc = '1. first\n\n2. second';
      const { view, cleanup: c } = createMarkdownEditor(doc, doc.length);
      cleanup = c;

      pressEnter(view);

      expect(view.state.doc.toString()).toBe('1. first\n\n2. second\n3. ');
    });
  });

  describe('tight bullet list', () => {
    it('still produces tight continuation (no behavior change)', () => {
      const doc = '- first\n- second';
      const { view, cleanup: c } = createMarkdownEditor(doc, doc.length);
      cleanup = c;

      pressEnter(view);

      expect(view.state.doc.toString()).toBe('- first\n- second\n- ');
    });
  });

  describe('empty bullet item', () => {
    it('exits list when pressing Enter on empty third item', () => {
      const doc = '- first\n- second\n- ';
      const { view, cleanup: c } = createMarkdownEditor(doc, doc.length);
      cleanup = c;

      pressEnter(view);

      // Empty item removed, cursor on blank line after list
      expect(view.state.doc.toString()).toBe('- first\n- second\n');
    });

    it('exits list when pressing Enter on empty second item (nonTightLists: false)', () => {
      // With nonTightLists: false, this exits the list instead of
      // converting tight to non-tight (the secondary trigger fix)
      const doc = '- first\n- ';
      const { view, cleanup: c } = createMarkdownEditor(doc, doc.length);
      cleanup = c;

      pressEnter(view);

      expect(view.state.doc.toString()).toBe('- first\n');
    });
  });

  describe('non-list context', () => {
    it('returns false so default handler can take over', () => {
      const doc = 'plain text';
      const { view, cleanup: c } = createMarkdownEditor(doc, doc.length);
      cleanup = c;

      const handled = pressEnter(view);

      expect(handled).toBe(false);
    });
  });
```

**Step 2: Run tests to verify they all pass**

Run: `cd /home/penguin/code/lens-relay/ws2/lens-editor && npx vitest run src/components/Editor/extensions/tightListEnter.test.ts`

Expected: ALL PASS. If any fail, debug and fix before continuing.

**Step 3: Commit**

```
test(editor): add edge case tests for tight list Enter handler
```

---

### Task 5: Write nested list test

Tests the regex handles indented blank lines correctly.

**Files:**
- Modify: `src/components/Editor/extensions/tightListEnter.test.ts`

**Step 1: Add nested list test**

```typescript
  describe('nested list', () => {
    it('produces tight continuation at correct indent level', () => {
      const doc = '- outer\n  - inner1\n\n  - inner2';
      const { view, cleanup: c } = createMarkdownEditor(doc, doc.length);
      cleanup = c;

      pressEnter(view);

      expect(view.state.doc.toString()).toBe(
        '- outer\n  - inner1\n\n  - inner2\n  - '
      );
    });
  });
```

**Step 2: Run tests to verify all pass**

Run: `cd /home/penguin/code/lens-relay/ws2/lens-editor && npx vitest run src/components/Editor/extensions/tightListEnter.test.ts`

Expected: PASS. If the nested case fails, the `NON_TIGHT_BLANK` regex may need adjustment — check the actual insertion text in the failing output.

**Step 3: Commit**

```
test(editor): add nested list test for tight Enter handler
```

---

### Task 6: Integrate into Editor.tsx

**Files:**
- Modify: `src/components/Editor/Editor.tsx`

**Step 1: Add imports**

At the top of Editor.tsx, add:

```typescript
import { Prec } from '@codemirror/state';
import { deleteMarkupBackward } from '@codemirror/lang-markdown';
import { tightMarkdownKeymap } from './extensions/tightListEnter';
```

Note: `Prec` may already be imported via other paths — check and merge. `deleteMarkupBackward` is imported as a reference but is already included in `tightMarkdownKeymap`, so the direct import is not needed. Only import `tightMarkdownKeymap`.

Simplified imports to add:

```typescript
import { Prec } from '@codemirror/state';
import { tightMarkdownKeymap } from './extensions/tightListEnter';
```

**Step 2: Disable built-in markdown keymap**

Change line 229-232 from:

```typescript
      markdown({
        base: markdownLanguage,
        extensions: [WikilinkExtension],
      }),
```

To:

```typescript
      markdown({
        base: markdownLanguage,
        extensions: [WikilinkExtension],
        addKeymap: false,
      }),
```

**Step 3: Add tight markdown keymap**

After the `markdown()` extension (around line 233, after `livePreview`), add:

```typescript
      Prec.high(keymap.of(tightMarkdownKeymap)),
```

Place it near the other keymaps but note it must be at `Prec.high` to match the priority the built-in markdown keymap had.

**Step 4: Run all editor-related tests to verify no regressions**

Run: `cd /home/penguin/code/lens-relay/ws2/lens-editor && npx vitest run src/components/Editor/`

Expected: ALL PASS.

**Step 5: Commit**

```
feat(editor): integrate tight list Enter handler into editor

Disables the built-in markdown keymap and installs our custom
tight-list keymap at Prec.high, fixing the double-linebreak bug
when pressing Enter in bullet/ordered lists.
```

---

### Task 7: Run full test suite

**Step 1: Run all tests**

Run: `cd /home/penguin/code/lens-relay/ws2/lens-editor && npx vitest run`

Expected: ALL PASS. No regressions.

**Step 2: If failures, investigate and fix before final commit**

---

## Summary of files changed

| File | Action | Purpose |
|------|--------|---------|
| `src/components/Editor/extensions/tightListEnter.ts` | Create | Wrapper handler + keymap |
| `src/components/Editor/extensions/tightListEnter.test.ts` | Create | Tests for all list scenarios |
| `src/test/codemirror-helpers.ts` | Modify | Add `createMarkdownEditor` + `pressEnter` helpers |
| `src/components/Editor/Editor.tsx` | Modify | Wire up new keymap, disable built-in |
