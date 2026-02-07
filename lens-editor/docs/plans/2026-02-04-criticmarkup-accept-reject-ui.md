# CriticMarkup Accept/Reject UI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable users to accept or reject CriticMarkup changes via inline buttons, keyboard shortcuts, and context menu.

**Architecture:** Inline widget buttons (checkmark/X) appear after each CriticMarkup range when cursor is inside. Buttons dispatch document changes using existing `acceptChange`/`rejectChange` pure functions. CodeMirror commands expose accept/reject for keyboard shortcuts and command palette.

**Tech Stack:** CodeMirror 6 (WidgetType, keymap, commands), Vitest + Happy DOM for testing, React Testing Library for toggle component tests.

**Prerequisites:**
- `src/lib/criticmarkup-actions.ts` - Pure functions (DONE)
- `src/lib/criticmarkup-parser.ts` - Parser (DONE)
- `src/components/Editor/extensions/criticmarkup.ts` - StateField + ViewPlugin (DONE)

---

## Task 1: Create Accept/Reject Commands

Commands are pure functions that operate on EditorState and return a transaction. They form the foundation for keyboard shortcuts, context menu, and button clicks.

**Files:**
- Create: `src/components/Editor/extensions/criticmarkup-commands.ts`
- Create: `src/components/Editor/extensions/criticmarkup-commands.test.ts`

### Step 1.1: Write failing test for acceptChangeAtCursor command

```typescript
// src/components/Editor/extensions/criticmarkup-commands.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { createCriticMarkupEditor, moveCursor } from '../../../test/codemirror-helpers';
import { acceptChangeAtCursor, rejectChangeAtCursor } from './criticmarkup-commands';

describe('CriticMarkup Commands', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    if (cleanup) cleanup();
  });

  describe('acceptChangeAtCursor', () => {
    it('accepts addition when cursor is inside', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        10 // cursor inside "world"
      );
      cleanup = c;

      const result = acceptChangeAtCursor(view);

      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe('hello world end');
    });

    it('returns false when cursor is not inside any markup', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        3 // cursor in "hello"
      );
      cleanup = c;

      const result = acceptChangeAtCursor(view);

      expect(result).toBe(false);
      expect(view.state.doc.toString()).toBe('hello {++world++} end');
    });

    it('accepts deletion (removes content)', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {--removed--} end',
        10
      );
      cleanup = c;

      const result = acceptChangeAtCursor(view);

      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe('hello  end');
    });

    it('accepts substitution (keeps new content)', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {~~old~>new~~} end',
        10
      );
      cleanup = c;

      const result = acceptChangeAtCursor(view);

      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe('hello new end');
    });
  });
});
```

### Step 1.2: Run test to verify it fails

Run: `npm test -- src/components/Editor/extensions/criticmarkup-commands.test.ts`

Expected: FAIL with "Cannot find module './criticmarkup-commands'"

### Step 1.3: Write minimal implementation

**IMPORTANT:** We use targeted changes (only the markup range) instead of full document replacement.
Full document replacement would break Y.js collaboration by destroying the Y.Text structure.

```typescript
// src/components/Editor/extensions/criticmarkup-commands.ts
import type { EditorView } from '@codemirror/view';
import { criticMarkupField } from './criticmarkup';
import type { CriticMarkupRange } from '../../../lib/criticmarkup-parser';

/**
 * Find the CriticMarkup range containing the given position.
 * Returns null if position is not inside any markup.
 */
export function findRangeAtPosition(view: EditorView, pos: number): CriticMarkupRange | null {
  const ranges = view.state.field(criticMarkupField);
  return ranges.find(r => pos >= r.from && pos <= r.to) ?? null;
}

/**
 * Find the CriticMarkup range containing the cursor position.
 */
function findRangeAtCursor(view: EditorView): CriticMarkupRange | null {
  return findRangeAtPosition(view, view.state.selection.main.head);
}

/**
 * Get the replacement text when accepting a CriticMarkup range.
 * Returns the content that should replace the entire markup.
 */
function getAcceptReplacement(range: CriticMarkupRange): string {
  switch (range.type) {
    case 'addition':
      return range.content;
    case 'deletion':
      return ''; // Content is deleted
    case 'substitution':
      return range.newContent ?? '';
    case 'highlight':
      return range.content;
    case 'comment':
      return ''; // Comments are removed
    default:
      return '';
  }
}

/**
 * Get the replacement text when rejecting a CriticMarkup range.
 * Returns the content that should replace the entire markup.
 */
function getRejectReplacement(range: CriticMarkupRange): string {
  switch (range.type) {
    case 'addition':
      return ''; // Addition is rejected, nothing added
    case 'deletion':
      return range.content; // Keep the "deleted" content
    case 'substitution':
      return range.oldContent ?? '';
    case 'highlight':
      return range.content;
    case 'comment':
      return ''; // Comments are removed either way
    default:
      return '';
  }
}

/**
 * Accept the CriticMarkup change at cursor position.
 * Uses targeted change (only the markup range) to preserve Y.js structure.
 * Returns true if a change was accepted, false if cursor not in markup.
 */
export function acceptChangeAtCursor(view: EditorView): boolean {
  const range = findRangeAtCursor(view);
  if (!range) return false;

  const replacement = getAcceptReplacement(range);

  view.dispatch({
    changes: { from: range.from, to: range.to, insert: replacement },
  });

  return true;
}

/**
 * Reject the CriticMarkup change at cursor position.
 * Uses targeted change (only the markup range) to preserve Y.js structure.
 * Returns true if a change was rejected, false if cursor not in markup.
 */
export function rejectChangeAtCursor(view: EditorView): boolean {
  const range = findRangeAtCursor(view);
  if (!range) return false;

  const replacement = getRejectReplacement(range);

  view.dispatch({
    changes: { from: range.from, to: range.to, insert: replacement },
  });

  return true;
}
```

### Step 1.4: Run test to verify it passes

Run: `npm test -- src/components/Editor/extensions/criticmarkup-commands.test.ts`

Expected: PASS (4 tests)

### Step 1.5: Add reject command tests

Add to the test file:

```typescript
  describe('rejectChangeAtCursor', () => {
    it('rejects addition (removes markup entirely)', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        10
      );
      cleanup = c;

      const result = rejectChangeAtCursor(view);

      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe('hello  end');
    });

    it('returns false when cursor is not inside any markup', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        3
      );
      cleanup = c;

      const result = rejectChangeAtCursor(view);

      expect(result).toBe(false);
    });

    it('rejects deletion (keeps deleted content)', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {--removed--} end',
        10
      );
      cleanup = c;

      const result = rejectChangeAtCursor(view);

      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe('hello removed end');
    });

    it('rejects substitution (keeps old content)', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {~~old~>new~~} end',
        10
      );
      cleanup = c;

      const result = rejectChangeAtCursor(view);

      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe('hello old end');
    });
  });
```

### Step 1.6: Run all command tests

Run: `npm test -- src/components/Editor/extensions/criticmarkup-commands.test.ts`

Expected: PASS (8 tests)

### Step 1.7: Commit

```bash
git add src/components/Editor/extensions/criticmarkup-commands.ts src/components/Editor/extensions/criticmarkup-commands.test.ts
git commit -m "feat(criticmarkup): add accept/reject commands for cursor position

- acceptChangeAtCursor: applies change at cursor using acceptChange
- rejectChangeAtCursor: reverts change at cursor using rejectChange
- Both return false when cursor not inside markup

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Create Keyboard Shortcuts

Wire the commands to keyboard shortcuts via CodeMirror's keymap extension.

**Files:**
- Modify: `src/components/Editor/extensions/criticmarkup-commands.ts`
- Modify: `src/components/Editor/extensions/criticmarkup-commands.test.ts`
- Modify: `src/components/Editor/extensions/criticmarkup.ts`

### Step 2.1: Write failing test for keymap integration

Add to test file:

```typescript
import { criticMarkupKeymap } from './criticmarkup-commands';

describe('Keyboard Shortcuts', () => {
  it('exports a keymap extension', () => {
    expect(criticMarkupKeymap).toBeDefined();
    expect(Array.isArray(criticMarkupKeymap)).toBe(true);
  });

  it('keymap has Ctrl-Enter for accept', () => {
    const acceptBinding = criticMarkupKeymap.find(
      (k) => k.key === 'Ctrl-Enter' || k.key === 'Mod-Enter'
    );
    expect(acceptBinding).toBeDefined();
  });

  it('keymap has Ctrl-Backspace for reject', () => {
    const rejectBinding = criticMarkupKeymap.find(
      (k) => k.key === 'Ctrl-Backspace' || k.key === 'Mod-Backspace'
    );
    expect(rejectBinding).toBeDefined();
  });
});
```

### Step 2.2: Run test to verify it fails

Run: `npm test -- src/components/Editor/extensions/criticmarkup-commands.test.ts`

Expected: FAIL with "criticMarkupKeymap is not exported"

### Step 2.3: Implement keymap

Add to `criticmarkup-commands.ts`:

```typescript
import type { KeyBinding } from '@codemirror/view';

/**
 * Keymap for CriticMarkup accept/reject.
 * - Mod-Enter: Accept change at cursor
 * - Mod-Backspace: Reject change at cursor
 */
export const criticMarkupKeymap: KeyBinding[] = [
  {
    key: 'Mod-Enter',
    run: acceptChangeAtCursor,
  },
  {
    key: 'Mod-Backspace',
    run: rejectChangeAtCursor,
  },
];
```

### Step 2.4: Run test to verify it passes

Run: `npm test -- src/components/Editor/extensions/criticmarkup-commands.test.ts`

Expected: PASS

### Step 2.5: Wire keymap into criticMarkupExtension

Modify `src/components/Editor/extensions/criticmarkup.ts`:

```typescript
// Add import at top
import { keymap } from '@codemirror/view';
import { criticMarkupKeymap } from './criticmarkup-commands';

// Update criticMarkupExtension function
export function criticMarkupExtension() {
  return [
    criticMarkupField,
    suggestionModeField,
    suggestionModeFilter,
    criticMarkupCompartment.of(criticMarkupPlugin),
    keymap.of(criticMarkupKeymap),
  ];
}
```

### Step 2.6: Write integration test for keyboard shortcut

Add to test file:

```typescript
describe('Keyboard Integration', () => {
  it('Mod-Enter accepts change when cursor inside markup', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello {++world++} end',
      10
    );
    cleanup = c;

    // Simulate Mod-Enter by finding and running the command
    const binding = criticMarkupKeymap.find((k) => k.key === 'Mod-Enter');
    const result = binding?.run?.(view);

    expect(result).toBe(true);
    expect(view.state.doc.toString()).toBe('hello world end');
  });
});
```

### Step 2.7: Run all tests

Run: `npm test -- src/components/Editor/extensions/criticmarkup-commands.test.ts`

Expected: PASS

### Step 2.8: Commit

```bash
git add src/components/Editor/extensions/criticmarkup-commands.ts src/components/Editor/extensions/criticmarkup-commands.test.ts src/components/Editor/extensions/criticmarkup.ts
git commit -m "feat(criticmarkup): add keyboard shortcuts for accept/reject

- Mod-Enter: accept change at cursor
- Mod-Backspace: reject change at cursor
- Keymap wired into criticMarkupExtension

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Create Inline Accept/Reject Buttons Widget

Add clickable checkmark and X buttons that appear inside CriticMarkup ranges.

**Files:**
- Modify: `src/components/Editor/extensions/criticmarkup.ts`
- Modify: `src/components/Editor/extensions/criticmarkup.test.ts`
- Modify: `src/index.css`

### Step 3.1: Write failing test for button widget presence

Add to `criticmarkup.test.ts`:

```typescript
describe('Accept/Reject Buttons', () => {
  it('shows accept/reject buttons when cursor is inside markup', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello {++world++} end',
      10 // cursor inside
    );
    cleanup = c;

    const acceptBtn = view.contentDOM.querySelector('.cm-criticmarkup-accept');
    const rejectBtn = view.contentDOM.querySelector('.cm-criticmarkup-reject');

    expect(acceptBtn).not.toBeNull();
    expect(rejectBtn).not.toBeNull();
  });

  it('hides buttons when cursor is outside markup', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello {++world++} end',
      3 // cursor outside
    );
    cleanup = c;

    const acceptBtn = view.contentDOM.querySelector('.cm-criticmarkup-accept');
    const rejectBtn = view.contentDOM.querySelector('.cm-criticmarkup-reject');

    expect(acceptBtn).toBeNull();
    expect(rejectBtn).toBeNull();
  });

  it('buttons appear for all markup types', () => {
    // Test with deletion
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello {--removed--} end',
      10
    );
    cleanup = c;

    expect(view.contentDOM.querySelector('.cm-criticmarkup-accept')).not.toBeNull();
    expect(view.contentDOM.querySelector('.cm-criticmarkup-reject')).not.toBeNull();
  });
});
```

### Step 3.2: Run test to verify it fails

Run: `npm test -- src/components/Editor/extensions/criticmarkup.test.ts`

Expected: FAIL with buttons being null

### Step 3.3: Create AcceptRejectWidget class

Add to `criticmarkup.ts` before the ViewPlugin:

**IMPORTANT:** The widget tracks the range position for proper equality checking.
We use event delegation via data attributes instead of storing the view reference,
which could become stale.

```typescript
import { WidgetType } from '@codemirror/view';

/**
 * Widget that renders accept (✓) and reject (✗) buttons for CriticMarkup.
 * Appears at the end of markup content when cursor is inside.
 *
 * Uses data attributes for range identification - click handlers are
 * attached via event delegation in the ViewPlugin.
 */
class AcceptRejectWidget extends WidgetType {
  constructor(
    private rangeFrom: number,
    private rangeTo: number
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const container = document.createElement('span');
    container.className = 'cm-criticmarkup-buttons';
    container.dataset.rangeFrom = String(this.rangeFrom);
    container.dataset.rangeTo = String(this.rangeTo);

    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'cm-criticmarkup-accept';
    acceptBtn.textContent = '✓';
    acceptBtn.title = 'Accept change (Ctrl+Enter)';
    acceptBtn.setAttribute('aria-label', 'Accept change');

    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'cm-criticmarkup-reject';
    rejectBtn.textContent = '✗';
    rejectBtn.title = 'Reject change (Ctrl+Backspace)';
    rejectBtn.setAttribute('aria-label', 'Reject change');

    container.appendChild(acceptBtn);
    container.appendChild(rejectBtn);

    return container;
  }

  eq(other: AcceptRejectWidget): boolean {
    // Widgets are equal if they represent the same range
    return this.rangeFrom === other.rangeFrom && this.rangeTo === other.rangeTo;
  }

  ignoreEvent(): boolean {
    return false; // Allow click events
  }
}
```

### Step 3.4: Modify ViewPlugin to add widget decorations and event delegation

Update the ViewPlugin class to add:
1. Event delegation for button clicks (instead of storing view reference in widget)
2. Widget decorations when cursor is inside markup
3. Proper sorting that places widgets after marks at the same position

```typescript
import { acceptChangeAtCursor, rejectChangeAtCursor } from './criticmarkup-commands';

export const criticMarkupPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);

      // Event delegation for accept/reject button clicks
      view.contentDOM.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.classList.contains('cm-criticmarkup-accept')) {
          e.preventDefault();
          e.stopPropagation();
          acceptChangeAtCursor(view);
        } else if (target.classList.contains('cm-criticmarkup-reject')) {
          e.preventDefault();
          e.stopPropagation();
          rejectChangeAtCursor(view);
        }
      });
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const ranges = view.state.field(criticMarkupField);
      const selection = view.state.selection;

      const decorations: Array<{ from: number; to: number; deco: Decoration }> = [];

      for (const range of ranges) {
        const className = TYPE_CLASSES[range.type];
        const cursorInside = selectionIntersects(selection, range.from, range.to);

        if (cursorInside) {
          // Cursor inside - show everything, apply class to whole range
          decorations.push({
            from: range.from,
            to: range.to,
            deco: Decoration.mark({ class: className }),
          });

          // Add accept/reject buttons at end of content (before closing delimiter)
          decorations.push({
            from: range.contentTo,
            to: range.contentTo,
            deco: Decoration.widget({
              widget: new AcceptRejectWidget(range.from, range.to),
              side: 1, // After the content
            }),
          });
        } else {
          // Cursor outside - hide delimiters, style content only
          decorations.push({
            from: range.from,
            to: range.contentFrom,
            deco: Decoration.mark({ class: 'cm-hidden-syntax' }),
          });

          decorations.push({
            from: range.contentFrom,
            to: range.contentTo,
            deco: Decoration.mark({ class: className }),
          });

          decorations.push({
            from: range.contentTo,
            to: range.to,
            deco: Decoration.mark({ class: 'cm-hidden-syntax' }),
          });
        }
      }

      // Sort by position (required for RangeSetBuilder)
      // Widgets (from === to) should come after marks at the same position
      decorations.sort((a, b) => {
        if (a.from !== b.from) return a.from - b.from;
        if (a.to !== b.to) return a.to - b.to;
        const aIsWidget = a.from === a.to;
        const bIsWidget = b.from === b.to;
        if (aIsWidget !== bIsWidget) return aIsWidget ? 1 : -1;
        return 0;
      });

      for (const d of decorations) {
        builder.add(d.from, d.to, d.deco);
      }

      return builder.finish();
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);
```

### Step 3.5: Run test to verify it passes

Run: `npm test -- src/components/Editor/extensions/criticmarkup.test.ts`

Expected: PASS

### Step 3.6: Add CSS styles for buttons

Add to `src/index.css` after the existing CriticMarkup styles:

```css
/* CriticMarkup Accept/Reject Buttons */
.cm-criticmarkup-buttons {
  display: inline-flex;
  gap: 2px;
  margin-left: 4px;
  vertical-align: middle;
}

.cm-criticmarkup-accept,
.cm-criticmarkup-reject {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 3px;
  font-size: 12px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.cm-criticmarkup-accept {
  background-color: rgba(34, 197, 94, 0.3);
  color: #15803d;
}

.cm-criticmarkup-accept:hover {
  background-color: rgba(34, 197, 94, 0.5);
}

.cm-criticmarkup-reject {
  background-color: rgba(239, 68, 68, 0.3);
  color: #b91c1c;
}

.cm-criticmarkup-reject:hover {
  background-color: rgba(239, 68, 68, 0.5);
}

/* Focus states for accessibility */
.cm-criticmarkup-accept:focus,
.cm-criticmarkup-reject:focus {
  outline: 2px solid #2563eb;
  outline-offset: 1px;
}

.cm-criticmarkup-accept:focus-visible,
.cm-criticmarkup-reject:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 1px;
}
```

### Step 3.7: Write click behavior test

Add to `criticmarkup.test.ts`:

```typescript
describe('Button Click Behavior', () => {
  it('clicking accept button applies the change', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello {++world++} end',
      10
    );
    cleanup = c;

    const acceptBtn = view.contentDOM.querySelector('.cm-criticmarkup-accept') as HTMLButtonElement;
    expect(acceptBtn).not.toBeNull();

    acceptBtn.click();

    expect(view.state.doc.toString()).toBe('hello world end');
  });

  it('clicking reject button reverts the change', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello {++world++} end',
      10
    );
    cleanup = c;

    const rejectBtn = view.contentDOM.querySelector('.cm-criticmarkup-reject') as HTMLButtonElement;
    expect(rejectBtn).not.toBeNull();

    rejectBtn.click();

    expect(view.state.doc.toString()).toBe('hello  end');
  });
});
```

### Step 3.8: Run all tests

Run: `npm test -- src/components/Editor/extensions/criticmarkup.test.ts`

Expected: PASS

### Step 3.9: Commit

```bash
git add src/components/Editor/extensions/criticmarkup.ts src/components/Editor/extensions/criticmarkup.test.ts src/index.css
git commit -m "feat(criticmarkup): add inline accept/reject buttons

- AcceptRejectWidget renders ✓/✗ buttons when cursor inside markup
- Buttons appear at end of content (before closing delimiter)
- Click handlers call acceptChangeAtCursor/rejectChangeAtCursor
- Styled with green/red colors matching markup styling

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Add Context Menu Integration

Add "Accept Change" and "Reject Change" to the right-click context menu.

**Files:**
- Create: `src/components/Editor/extensions/criticmarkup-context-menu.ts`
- Create: `src/components/Editor/extensions/criticmarkup-context-menu.test.ts`
- Modify: `src/components/Editor/extensions/criticmarkup.ts`

### Step 4.1: Write failing test for context menu items

```typescript
// src/components/Editor/extensions/criticmarkup-context-menu.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createCriticMarkupEditor } from '../../../test/codemirror-helpers';
import { getContextMenuItems } from './criticmarkup-context-menu';

describe('CriticMarkup Context Menu', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    if (cleanup) cleanup();
  });

  it('returns accept/reject items when cursor inside markup', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello {++world++} end',
      10
    );
    cleanup = c;

    const items = getContextMenuItems(view);

    expect(items).toHaveLength(2);
    expect(items[0].label).toBe('Accept Change');
    expect(items[1].label).toBe('Reject Change');
  });

  it('returns empty array when cursor outside markup', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello {++world++} end',
      3
    );
    cleanup = c;

    const items = getContextMenuItems(view);

    expect(items).toHaveLength(0);
  });

  it('accept item executes acceptChangeAtCursor', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello {++world++} end',
      10
    );
    cleanup = c;

    const items = getContextMenuItems(view);
    items[0].action();

    expect(view.state.doc.toString()).toBe('hello world end');
  });

  it('reject item executes rejectChangeAtCursor', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello {++world++} end',
      10
    );
    cleanup = c;

    const items = getContextMenuItems(view);
    items[1].action();

    expect(view.state.doc.toString()).toBe('hello  end');
  });

  describe('atPosition parameter', () => {
    it('returns items when atPosition is inside markup even if cursor is outside', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        3 // cursor outside
      );
      cleanup = c;

      // atPosition=10 is inside the markup
      const items = getContextMenuItems(view, 10);

      expect(items).toHaveLength(2);
    });

    it('returns empty array when atPosition is outside markup', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        10 // cursor inside
      );
      cleanup = c;

      // atPosition=3 is outside the markup
      const items = getContextMenuItems(view, 3);

      expect(items).toHaveLength(0);
    });

    it('action moves cursor to position before accepting', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        3 // cursor outside
      );
      cleanup = c;

      const items = getContextMenuItems(view, 10);
      items[0].action();

      expect(view.state.doc.toString()).toBe('hello world end');
    });
  });
});
```

### Step 4.2: Run test to verify it fails

Run: `npm test -- src/components/Editor/extensions/criticmarkup-context-menu.test.ts`

Expected: FAIL with "Cannot find module"

### Step 4.3: Implement context menu items

**IMPORTANT:** The function accepts an optional `atPosition` parameter for right-click handling.
When right-clicking, we use the click position (not cursor position) to determine if we're in markup.
This allows right-clicking on markup even when the cursor is elsewhere.

```typescript
// src/components/Editor/extensions/criticmarkup-context-menu.ts
import type { EditorView } from '@codemirror/view';
import { criticMarkupField } from './criticmarkup';
import { acceptChangeAtCursor, rejectChangeAtCursor, findRangeAtPosition } from './criticmarkup-commands';

export interface ContextMenuItem {
  label: string;
  action: () => void;
  shortcut?: string;
}

/**
 * Get context menu items for CriticMarkup.
 *
 * @param view - The EditorView instance
 * @param atPosition - Optional position to check (for right-click). If not provided, uses cursor position.
 * @returns Menu items if position is inside markup, empty array otherwise.
 */
export function getContextMenuItems(view: EditorView, atPosition?: number): ContextMenuItem[] {
  const pos = atPosition ?? view.state.selection.main.head;
  const range = findRangeAtPosition(view, pos);

  if (!range) {
    return [];
  }

  // If we're checking a click position different from cursor,
  // first move cursor to that position so accept/reject work correctly
  const needsMoveCursor = atPosition !== undefined && atPosition !== view.state.selection.main.head;

  return [
    {
      label: 'Accept Change',
      action: () => {
        if (needsMoveCursor) {
          view.dispatch({ selection: { anchor: pos } });
        }
        acceptChangeAtCursor(view);
      },
      shortcut: 'Ctrl+Enter',
    },
    {
      label: 'Reject Change',
      action: () => {
        if (needsMoveCursor) {
          view.dispatch({ selection: { anchor: pos } });
        }
        rejectChangeAtCursor(view);
      },
      shortcut: 'Ctrl+Backspace',
    },
  ];
}
```

### Step 4.4: Run test to verify it passes

Run: `npm test -- src/components/Editor/extensions/criticmarkup-context-menu.test.ts`

Expected: PASS

### Step 4.5: Commit

```bash
git add src/components/Editor/extensions/criticmarkup-context-menu.ts src/components/Editor/extensions/criticmarkup-context-menu.test.ts
git commit -m "feat(criticmarkup): add context menu items for accept/reject

- getContextMenuItems returns items when cursor in markup
- Items include labels, actions, and keyboard shortcut hints
- Returns empty array when cursor outside markup

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: Wire Context Menu to Editor

Connect the context menu items to the actual browser context menu event.

**Files:**
- Modify: `src/components/Editor/Editor.tsx`
- Create: `src/components/Editor/ContextMenu.tsx`
- Create: `src/components/Editor/ContextMenu.test.tsx`

### Step 5.1: Write failing test for ContextMenu component

```typescript
// src/components/Editor/ContextMenu.test.tsx
/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ContextMenu } from './ContextMenu';
import type { ContextMenuItem } from './extensions/criticmarkup-context-menu';

describe('ContextMenu Component', () => {
  afterEach(() => {
    cleanup();
  });

  const mockItems: ContextMenuItem[] = [
    { label: 'Accept Change', action: vi.fn(), shortcut: 'Ctrl+Enter' },
    { label: 'Reject Change', action: vi.fn(), shortcut: 'Ctrl+Backspace' },
  ];

  it('renders menu items', () => {
    render(
      <ContextMenu
        items={mockItems}
        position={{ x: 100, y: 100 }}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText('Accept Change')).toBeInTheDocument();
    expect(screen.getByText('Reject Change')).toBeInTheDocument();
  });

  it('shows keyboard shortcuts', () => {
    render(
      <ContextMenu
        items={mockItems}
        position={{ x: 100, y: 100 }}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText('Ctrl+Enter')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+Backspace')).toBeInTheDocument();
  });

  it('calls action and onClose when item clicked', () => {
    const onClose = vi.fn();
    render(
      <ContextMenu
        items={mockItems}
        position={{ x: 100, y: 100 }}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByText('Accept Change'));

    expect(mockItems[0].action).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('is positioned at specified coordinates', () => {
    const { container } = render(
      <ContextMenu
        items={mockItems}
        position={{ x: 150, y: 200 }}
        onClose={vi.fn()}
      />
    );

    const menu = container.firstChild as HTMLElement;
    expect(menu.style.left).toBe('150px');
    expect(menu.style.top).toBe('200px');
  });

  it('does not render when items array is empty', () => {
    const { container } = render(
      <ContextMenu
        items={[]}
        position={{ x: 100, y: 100 }}
        onClose={vi.fn()}
      />
    );

    expect(container.firstChild).toBeNull();
  });
});
```

### Step 5.2: Run test to verify it fails

Run: `npm test -- src/components/Editor/ContextMenu.test.tsx`

Expected: FAIL with "Cannot find module './ContextMenu'"

### Step 5.3: Implement ContextMenu component

```typescript
// src/components/Editor/ContextMenu.tsx
import { useEffect, useRef } from 'react';
import type { ContextMenuItem } from './extensions/criticmarkup-context-menu';

interface ContextMenuProps {
  items: ContextMenuItem[];
  position: { x: number; y: number };
  onClose: () => void;
}

export function ContextMenu({ items, position, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  if (items.length === 0) {
    return null;
  }

  return (
    <div
      ref={menuRef}
      className="fixed bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50 min-w-[180px]"
      style={{ left: `${position.x}px`, top: `${position.y}px` }}
    >
      {items.map((item, index) => (
        <button
          key={index}
          className="w-full px-3 py-2 text-left text-sm hover:bg-gray-100 flex justify-between items-center"
          onClick={() => {
            item.action();
            onClose();
          }}
        >
          <span>{item.label}</span>
          {item.shortcut && (
            <span className="text-gray-400 text-xs ml-4">{item.shortcut}</span>
          )}
        </button>
      ))}
    </div>
  );
}
```

### Step 5.4: Run test to verify it passes

Run: `npm test -- src/components/Editor/ContextMenu.test.tsx`

Expected: PASS

### Step 5.5: Commit

```bash
git add src/components/Editor/ContextMenu.tsx src/components/Editor/ContextMenu.test.tsx
git commit -m "feat(criticmarkup): add ContextMenu React component

- Renders menu items with labels and keyboard shortcuts
- Positioned at specified coordinates
- Closes on click outside or Escape key
- Returns null when items array is empty

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: Wire Context Menu to Editor Component

Integrate the context menu into the Editor component with right-click handling.

**Files:**
- Modify: `src/components/Editor/Editor.tsx`

### Step 6.1: Add context menu state and handler to Editor

**IMPORTANT:** We use `posAtCoords` to convert click coordinates to editor position.
This allows right-clicking on markup even when the cursor is elsewhere in the document.

Read the current Editor.tsx first, then add:

```typescript
// Add imports at top
import { useState, useCallback } from 'react';
import { ContextMenu } from './ContextMenu';
import { getContextMenuItems } from './extensions/criticmarkup-context-menu';
import type { ContextMenuItem } from './extensions/criticmarkup-context-menu';

// Add state inside Editor component
const [contextMenu, setContextMenu] = useState<{
  items: ContextMenuItem[];
  position: { x: number; y: number };
} | null>(null);

// Stable onClose callback to prevent effect re-runs
const handleCloseContextMenu = useCallback(() => {
  setContextMenu(null);
}, []);

// Add handler - uses click position, not cursor position
const handleContextMenu = useCallback(
  (e: React.MouseEvent) => {
    if (!editorView) return;

    // Convert click coordinates to editor document position
    const clickPos = editorView.posAtCoords({ x: e.clientX, y: e.clientY });
    if (clickPos === null) return;

    // Get items at click position (not cursor position)
    const items = getContextMenuItems(editorView, clickPos);
    if (items.length > 0) {
      e.preventDefault();
      setContextMenu({
        items,
        position: { x: e.clientX, y: e.clientY },
      });
    }
  },
  [editorView]
);

// Clear context menu when document changes
useEffect(() => {
  if (!editorView) return;

  const listener = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      setContextMenu(null);
    }
  });

  // Note: This effect just documents the need - the actual implementation
  // requires adding the listener to the editor extensions, which is complex.
  // For now, clicking outside or Escape will close the menu.
}, [editorView]);

// Wrap editor container with onContextMenu
<div onContextMenu={handleContextMenu}>
  {/* existing editor content */}
</div>

// Add ContextMenu component at end of return
{contextMenu && (
  <ContextMenu
    items={contextMenu.items}
    position={contextMenu.position}
    onClose={handleCloseContextMenu}
  />
)}
```

### Step 6.2: Test manually in browser

1. Open the editor with CriticMarkup content
2. Place cursor inside a markup range
3. Right-click
4. Verify context menu appears with Accept/Reject options
5. Click an option and verify it works

### Step 6.3: Commit

```bash
git add src/components/Editor/Editor.tsx
git commit -m "feat(criticmarkup): wire context menu to Editor component

- Right-click inside markup shows Accept/Reject menu
- Menu positioned at click coordinates
- Closes after action or click outside

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: Export Commands for External Use

Export the commands and context menu functions for use by other components (e.g., command palette).

**Files:**
- Modify: `src/components/Editor/extensions/index.ts` (create if doesn't exist)

### Step 7.1: Create or update extensions index

```typescript
// src/components/Editor/extensions/index.ts
export {
  criticMarkupExtension,
  criticMarkupField,
  toggleSuggestionMode,
  suggestionModeField,
  criticMarkupCompartment,
} from './criticmarkup';

export {
  acceptChangeAtCursor,
  rejectChangeAtCursor,
  criticMarkupKeymap,
} from './criticmarkup-commands';

export {
  getContextMenuItems,
  type ContextMenuItem,
} from './criticmarkup-context-menu';

export { livePreview, toggleSourceMode, livePreviewCompartment } from './livePreview';
```

### Step 7.2: Commit

```bash
git add src/components/Editor/extensions/index.ts
git commit -m "feat(criticmarkup): export commands and context menu from extensions index

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: Final Integration Test

Write an integration test that verifies the full flow works together.

**Files:**
- Create: `src/components/Editor/criticmarkup-integration.test.tsx`

### Step 8.1: Write integration test

```typescript
// src/components/Editor/criticmarkup-integration.test.tsx
/**
 * Integration tests for CriticMarkup accept/reject UI.
 * @vitest-environment happy-dom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createCriticMarkupEditor, moveCursor, hasClass } from '../../test/codemirror-helpers';
import { criticMarkupKeymap } from './extensions/criticmarkup-commands';

describe('CriticMarkup Accept/Reject Integration', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    if (cleanup) cleanup();
  });

  describe('Full workflow', () => {
    it('cursor inside shows buttons, clicking accept removes markup', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        10
      );
      cleanup = c;

      // Verify buttons appear
      const acceptBtn = view.contentDOM.querySelector('.cm-criticmarkup-accept');
      expect(acceptBtn).not.toBeNull();

      // Click accept
      (acceptBtn as HTMLButtonElement).click();

      // Verify document changed
      expect(view.state.doc.toString()).toBe('hello world end');

      // Verify no more markup styling
      expect(hasClass(view, 'cm-addition')).toBe(false);
    });

    it('keyboard shortcut accepts change', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {--removed--} end',
        10
      );
      cleanup = c;

      // Execute keyboard command
      const binding = criticMarkupKeymap.find((k) => k.key === 'Mod-Enter');
      binding?.run?.(view);

      // Accept deletion = remove content
      expect(view.state.doc.toString()).toBe('hello  end');
    });

    it('moving cursor in/out toggles button visibility', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        3 // outside
      );
      cleanup = c;

      // Initially outside - no buttons
      expect(view.contentDOM.querySelector('.cm-criticmarkup-accept')).toBeNull();

      // Move inside
      moveCursor(view, 10);
      expect(view.contentDOM.querySelector('.cm-criticmarkup-accept')).not.toBeNull();

      // Move outside again
      moveCursor(view, 20);
      expect(view.contentDOM.querySelector('.cm-criticmarkup-accept')).toBeNull();
    });

    it('works with metadata-enriched markup', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++{"author":"alice"}@@world++} end',
        20
      );
      cleanup = c;

      const acceptBtn = view.contentDOM.querySelector('.cm-criticmarkup-accept');
      (acceptBtn as HTMLButtonElement).click();

      expect(view.state.doc.toString()).toBe('hello world end');
    });

    it('substitution accept keeps new content', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {~~old~>new~~} end',
        10
      );
      cleanup = c;

      const acceptBtn = view.contentDOM.querySelector('.cm-criticmarkup-accept');
      (acceptBtn as HTMLButtonElement).click();

      expect(view.state.doc.toString()).toBe('hello new end');
    });

    it('substitution reject keeps old content', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {~~old~>new~~} end',
        10
      );
      cleanup = c;

      const rejectBtn = view.contentDOM.querySelector('.cm-criticmarkup-reject');
      (rejectBtn as HTMLButtonElement).click();

      expect(view.state.doc.toString()).toBe('hello old end');
    });
  });

  describe('Edge Cases', () => {
    it('handles empty document gracefully', () => {
      const { view, cleanup: c } = createCriticMarkupEditor('', 0);
      cleanup = c;

      // No buttons should appear
      expect(view.contentDOM.querySelector('.cm-criticmarkup-accept')).toBeNull();
    });

    it('handles cursor at exact start boundary of markup', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        6 // exactly at {
      );
      cleanup = c;

      // Cursor at boundary should be considered "inside"
      expect(view.contentDOM.querySelector('.cm-criticmarkup-accept')).not.toBeNull();
    });

    it('handles cursor at exact end boundary of markup', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        17 // exactly at }
      );
      cleanup = c;

      // Cursor at boundary should be considered "inside"
      expect(view.contentDOM.querySelector('.cm-criticmarkup-accept')).not.toBeNull();
    });

    it('handles multiple adjacent markup ranges', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        '{++one++}{++two++}',
        5 // inside "one"
      );
      cleanup = c;

      const acceptBtn = view.contentDOM.querySelector('.cm-criticmarkup-accept');
      (acceptBtn as HTMLButtonElement).click();

      // Should only accept "one", not "two"
      expect(view.state.doc.toString()).toBe('one{++two++}');
    });

    it('handles multiline markup', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'start {++line1\nline2++} end',
        12
      );
      cleanup = c;

      const acceptBtn = view.contentDOM.querySelector('.cm-criticmarkup-accept');
      (acceptBtn as HTMLButtonElement).click();

      expect(view.state.doc.toString()).toBe('start line1\nline2 end');
    });

    it('handles comment type (accept removes it)', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {>>note<<} world',
        10
      );
      cleanup = c;

      const acceptBtn = view.contentDOM.querySelector('.cm-criticmarkup-accept');
      (acceptBtn as HTMLButtonElement).click();

      expect(view.state.doc.toString()).toBe('hello  world');
    });

    it('handles highlight type (accept keeps content)', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {==important==} world',
        12
      );
      cleanup = c;

      const acceptBtn = view.contentDOM.querySelector('.cm-criticmarkup-accept');
      (acceptBtn as HTMLButtonElement).click();

      expect(view.state.doc.toString()).toBe('hello important world');
    });
  });

  describe('Undo Support', () => {
    it('accept can be undone', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        10
      );
      cleanup = c;

      const acceptBtn = view.contentDOM.querySelector('.cm-criticmarkup-accept');
      (acceptBtn as HTMLButtonElement).click();

      expect(view.state.doc.toString()).toBe('hello world end');

      // Undo using CodeMirror's undo
      import { undo } from '@codemirror/commands';
      undo(view);

      expect(view.state.doc.toString()).toBe('hello {++world++} end');
    });

    it('reject can be undone', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        10
      );
      cleanup = c;

      const rejectBtn = view.contentDOM.querySelector('.cm-criticmarkup-reject');
      (rejectBtn as HTMLButtonElement).click();

      expect(view.state.doc.toString()).toBe('hello  end');

      // Undo
      import { undo } from '@codemirror/commands';
      undo(view);

      expect(view.state.doc.toString()).toBe('hello {++world++} end');
    });
  });
});
```

**Note:** The undo tests require importing `undo` from `@codemirror/commands`. Add this import at the top of the test file:

```typescript
import { undo } from '@codemirror/commands';
```

### Step 8.2: Run integration tests

Run: `npm test -- src/components/Editor/criticmarkup-integration.test.tsx`

Expected: PASS

### Step 8.3: Run all CriticMarkup tests

Run: `npm test -- criticmarkup`

Expected: All tests PASS

### Step 8.4: Commit

```bash
git add src/components/Editor/criticmarkup-integration.test.tsx
git commit -m "test(criticmarkup): add integration tests for accept/reject UI

- Tests full workflow: cursor → buttons → click → document change
- Tests keyboard shortcuts
- Tests button visibility toggling with cursor movement
- Tests metadata-enriched markup
- Tests substitution accept/reject

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Summary

**Tasks completed:**
1. ✅ Accept/Reject commands (pure functions wrapping existing logic)
2. ✅ Keyboard shortcuts (Mod-Enter, Mod-Backspace)
3. ✅ Inline widget buttons (✓/✗ appearing when cursor inside)
4. ✅ Context menu items (getContextMenuItems function)
5. ✅ ContextMenu React component
6. ✅ Editor integration (right-click handling)
7. ✅ Exports for external use
8. ✅ Integration tests

**Files created/modified:**
- `src/components/Editor/extensions/criticmarkup-commands.ts` (new)
- `src/components/Editor/extensions/criticmarkup-commands.test.ts` (new)
- `src/components/Editor/extensions/criticmarkup-context-menu.ts` (new)
- `src/components/Editor/extensions/criticmarkup-context-menu.test.ts` (new)
- `src/components/Editor/extensions/criticmarkup.ts` (modified - widget)
- `src/components/Editor/extensions/criticmarkup.test.ts` (modified - button tests)
- `src/components/Editor/extensions/index.ts` (new or modified)
- `src/components/Editor/ContextMenu.tsx` (new)
- `src/components/Editor/ContextMenu.test.tsx` (new)
- `src/components/Editor/Editor.tsx` (modified - context menu)
- `src/components/Editor/criticmarkup-integration.test.tsx` (new)
- `src/index.css` (modified - button styles)

**Test coverage:**
- Unit tests for commands (accept/reject at cursor)
- Unit tests for context menu items (with atPosition parameter)
- React component tests for ContextMenu (React Testing Library)
- Integration tests for full workflow
- Edge case tests (empty doc, boundaries, adjacent ranges, multiline)
- Undo support tests
- ~40 new test cases

**Key implementation decisions (from code review):**
1. **Targeted changes** - Use `{ from: range.from, to: range.to, insert: replacement }` instead of full document replacement to preserve Y.js structure
2. **Widget equality** - Track `rangeFrom`/`rangeTo` for proper equality checks
3. **Event delegation** - Click handlers attached to `contentDOM` instead of widget instances
4. **Click position** - Context menu uses `posAtCoords` to get click position, not cursor position
5. **Accessibility** - Focus states and aria-labels on buttons

---

*Plan created: 2026-02-04*
*Updated: 2026-02-04 (code review fixes)*
