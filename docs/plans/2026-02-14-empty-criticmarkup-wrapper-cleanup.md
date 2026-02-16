# Empty CriticMarkup Wrapper Cleanup

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When all content is removed from a CriticMarkup addition wrapper while in suggestion mode, automatically remove the entire wrapper (delimiters + metadata) instead of leaving an invisible empty shell in the document.

**Architecture:** The fix intercepts the `insideOwnAddition` branch of the `suggestionModeFilter` transaction filter. Before blindly passing the transaction through, it checks whether the edit would empty the wrapper's content. If so, it replaces the entire wrapper with nothing. This keeps the fix in a single transaction with no secondary dispatches.

**Tech Stack:** CodeMirror 6 (EditorState transaction filter), Vitest, TypeScript

---

### Task 1: RED — Test that deleting all content from an addition wrapper removes the wrapper

**Files:**
- Modify: `lens-editor/src/components/Editor/extensions/criticmarkup.test.ts`

**Step 1: Write the failing test**

Add a new `describe` block inside the existing `Suggestion Mode` describe, after the `wrapping replacements` block (after line ~393):

```typescript
describe('empty wrapper cleanup', () => {
  it('removes addition wrapper when all content is deleted', () => {
    // Start with a document containing an addition wrapper with metadata
    const meta = '{"author":"anonymous","timestamp":1000}';
    const { view, cleanup: c } = createCriticMarkupEditor(
      `before {++${meta}@@hello++} after`,
      // cursor inside the addition content
      `before {++${meta}@@`.length + 1,
    );
    cleanup = c;

    view.dispatch({ effects: toggleSuggestionMode.of(true) });

    // Select and delete all content ("hello") inside the wrapper
    const contentFrom = `before {++${meta}@@`.length;
    const contentTo = contentFrom + 'hello'.length;
    view.dispatch({
      changes: { from: contentFrom, to: contentTo, insert: '' },
      annotations: Transaction.userEvent.of('delete'),
    });

    const doc = view.state.doc.toString();
    // The entire wrapper should be gone, leaving just "before  after"
    expect(doc).toBe('before  after');
    // No CriticMarkup ranges should remain
    const ranges = view.state.field(criticMarkupField);
    expect(ranges).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd lens-editor && npx vitest run src/components/Editor/extensions/criticmarkup.test.ts -t "removes addition wrapper when all content is deleted"`

Expected: FAIL — the wrapper remains as `{++{"author":"anonymous","timestamp":1000}@@++}` instead of being removed.

---

### Task 2: GREEN — Implement empty wrapper detection in the `insideOwnAddition` branch

**Files:**
- Modify: `lens-editor/src/components/Editor/extensions/criticmarkup.ts:420-432`

**Step 3: Write minimal implementation**

Replace the `insideOwnAddition` block (lines 420-432) with logic that checks whether the edit would empty the content:

```typescript
// Check if cursor is inside an existing addition by the same author
const ownAddition = ranges.find(
  (r) =>
    r.type === 'addition' &&
    r.metadata?.author === currentAuthor &&
    cursorPos > r.from &&
    cursorPos < r.to
);

// If inside own addition, let the edit through — unless it empties the content
if (ownAddition) {
  // Check if the transaction would empty all content from the wrapper
  let wouldEmpty = false;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const added = inserted.toString();
    // Pure deletion that spans the entire content region
    if (!added && fromA <= ownAddition.contentFrom && toA >= ownAddition.contentTo) {
      wouldEmpty = true;
    }
    // Deletion of remaining content (partial content already removed previously)
    if (!added && fromA >= ownAddition.contentFrom && toA <= ownAddition.contentTo) {
      const contentBefore = tr.startState.doc.sliceString(ownAddition.contentFrom, fromA);
      const contentAfter = tr.startState.doc.sliceString(toA, ownAddition.contentTo);
      if (!contentBefore && !contentAfter) {
        wouldEmpty = true;
      }
    }
  });

  if (wouldEmpty) {
    // Remove the entire wrapper
    return {
      changes: [{ from: ownAddition.from, to: ownAddition.to, insert: '' }],
      selection: EditorSelection.cursor(ownAddition.from),
      effects: tr.effects,
    };
  }

  return tr;
}
```

Key changes:
- `ranges.some(...)` → `ranges.find(...)` to get a reference to the specific range
- Added `wouldEmpty` check before returning `tr`
- When empty, replaces the entire wrapper (from `range.from` to `range.to`) with nothing
- Places cursor at the position where the wrapper started

**Step 4: Run test to verify it passes**

Run: `cd lens-editor && npx vitest run src/components/Editor/extensions/criticmarkup.test.ts -t "removes addition wrapper when all content is deleted"`

Expected: PASS

**Step 5: Run all CriticMarkup tests to check for regressions**

Run: `cd lens-editor && npx vitest run src/components/Editor/extensions/criticmarkup.test.ts`

Expected: All tests PASS (the `continuous typing extends existing addition` test must still work since we only changed `some` → `find` and added a check before `return tr`).

**Step 6: Commit**

```
fix: remove empty CriticMarkup addition wrappers when content is fully deleted
```

---

### Task 3: RED — Test single-character backspace that empties the wrapper

**Files:**
- Modify: `lens-editor/src/components/Editor/extensions/criticmarkup.test.ts`

**Step 7: Write the failing test**

Add to the `empty wrapper cleanup` describe block:

```typescript
it('removes wrapper on final backspace of single-char content', () => {
  const meta = '{"author":"anonymous","timestamp":1000}';
  const content = `before {++${meta}@@x++} after`;
  const contentStart = `before {++${meta}@@`.length;
  const { view, cleanup: c } = createCriticMarkupEditor(
    content,
    contentStart + 1, // cursor after 'x'
  );
  cleanup = c;

  view.dispatch({ effects: toggleSuggestionMode.of(true) });

  // Backspace: delete the single char 'x'
  view.dispatch({
    changes: { from: contentStart, to: contentStart + 1, insert: '' },
    annotations: Transaction.userEvent.of('delete.backward'),
  });

  const doc = view.state.doc.toString();
  expect(doc).toBe('before  after');
  expect(view.state.field(criticMarkupField)).toHaveLength(0);
});
```

**Step 8: Run test to verify it passes (should already pass from Task 2)**

Run: `cd lens-editor && npx vitest run src/components/Editor/extensions/criticmarkup.test.ts -t "removes wrapper on final backspace"`

Expected: PASS (the implementation from Task 2 already handles this case since single-char deletion spans all content).

If it passes, no additional implementation needed. If not, adjust the `wouldEmpty` logic.

---

### Task 4: RED — Test that partial deletion does NOT remove the wrapper

**Files:**
- Modify: `lens-editor/src/components/Editor/extensions/criticmarkup.test.ts`

**Step 9: Write the failing test (expected to pass — guard test)**

Add to the `empty wrapper cleanup` describe block:

```typescript
it('does NOT remove wrapper when partial content remains', () => {
  const meta = '{"author":"anonymous","timestamp":1000}';
  const content = `{++${meta}@@hello++}`;
  const contentStart = `{++${meta}@@`.length;
  const { view, cleanup: c } = createCriticMarkupEditor(
    content,
    contentStart + 3, // cursor after 'hel'
  );
  cleanup = c;

  view.dispatch({ effects: toggleSuggestionMode.of(true) });

  // Delete 'hel', leaving 'lo'
  view.dispatch({
    changes: { from: contentStart, to: contentStart + 3, insert: '' },
    annotations: Transaction.userEvent.of('delete'),
  });

  const doc = view.state.doc.toString();
  // Wrapper should remain with 'lo' inside
  expect(doc).toMatch(/\{\+\+.*@@lo\+\+\}/);
  expect(view.state.field(criticMarkupField)).toHaveLength(1);
});
```

**Step 10: Run test to verify it passes**

Run: `cd lens-editor && npx vitest run src/components/Editor/extensions/criticmarkup.test.ts -t "does NOT remove wrapper when partial content remains"`

Expected: PASS (existing `return tr` path handles this correctly).

---

### Task 5: Guard — Replacement inside own addition does NOT remove wrapper

**Files:**
- Modify: `lens-editor/src/components/Editor/extensions/criticmarkup.test.ts`

**Step 11: Write the guard test**

Add to the `empty wrapper cleanup` describe block:

```typescript
it('does NOT remove wrapper when content is replaced (not deleted)', () => {
  const meta = '{"author":"anonymous","timestamp":1000}';
  const content = `{++${meta}@@hello++}`;
  const contentStart = `{++${meta}@@`.length;
  const { view, cleanup: c } = createCriticMarkupEditor(
    content,
    contentStart + 3,
  );
  cleanup = c;

  view.dispatch({ effects: toggleSuggestionMode.of(true) });

  // Replace all content with new text (select "hello", type "world")
  view.dispatch({
    changes: { from: contentStart, to: contentStart + 5, insert: 'world' },
    annotations: Transaction.userEvent.of('input'),
  });

  const doc = view.state.doc.toString();
  // Wrapper should remain with 'world' inside
  expect(doc).toMatch(/\{\+\+.*@@world\+\+\}/);
  expect(view.state.field(criticMarkupField)).toHaveLength(1);
});
```

**Step 12: Run test**

Run: `cd lens-editor && npx vitest run src/components/Editor/extensions/criticmarkup.test.ts -t "does NOT remove wrapper when content is replaced"`

Expected: PASS — replacements have `inserted.toString()` non-empty, so `!added` is false and `wouldEmpty` stays false.

---

### Task 6: RED — Test cursor position after wrapper removal

**Files:**
- Modify: `lens-editor/src/components/Editor/extensions/criticmarkup.test.ts`

**Step 13: Write the test**

Add to the `empty wrapper cleanup` describe block:

```typescript
it('places cursor at wrapper start position after removal', () => {
  const meta = '{"author":"anonymous","timestamp":1000}';
  const content = `abc {++${meta}@@XY++} def`;
  const contentStart = `abc {++${meta}@@`.length;
  const { view, cleanup: c } = createCriticMarkupEditor(
    content,
    contentStart + 1, // cursor between X and Y
  );
  cleanup = c;

  view.dispatch({ effects: toggleSuggestionMode.of(true) });

  // Delete all content
  view.dispatch({
    changes: { from: contentStart, to: contentStart + 2, insert: '' },
    annotations: Transaction.userEvent.of('delete'),
  });

  // Cursor should be at position 4 (where the wrapper started: "abc |")
  expect(view.state.selection.main.head).toBe(4);
});
```

**Step 14: Run test**

Run: `cd lens-editor && npx vitest run src/components/Editor/extensions/criticmarkup.test.ts -t "places cursor at wrapper start position"`

Expected: PASS

**Step 15: Run full test suite**

Run: `cd lens-editor && npx vitest run`

Expected: All tests pass. No regressions.

**Step 16: Commit**

```
test: add edge case tests for empty wrapper cleanup
```

---

## Summary

| Task | Type | Description |
|------|------|-------------|
| 1 | RED | Core test: delete all content removes wrapper |
| 2 | GREEN | Implementation: detect empty wrapper and remove it |
| 3 | RED→check | Edge: single-char backspace empties wrapper |
| 4 | Guard | Partial deletion preserves wrapper |
| 5 | Guard | Replacement inside wrapper preserves it |
| 6 | Edge | Cursor position after removal |

The fix is ~25 lines of code in a single location (`criticmarkup.ts:420-432`). It changes `ranges.some()` to `ranges.find()` and adds a `wouldEmpty` check before the existing `return tr`.
