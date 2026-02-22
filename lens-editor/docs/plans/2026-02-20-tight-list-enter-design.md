# Tight List Enter Handler

## Problem

Pressing Enter in a bullet list inserts two line breaks instead of one. The cursor lands two lines down (with a blank line gap) instead of on the immediately next line.

## Root Cause

`@codemirror/lang-markdown`'s `insertNewlineContinueMarkup` preserves "non-tight" (loose) list formatting. When a list has blank lines between items, the Enter handler inserts `\n\n- ` instead of `\n- `.

The non-tight detection happens at `node_modules/@codemirror/lang-markdown/dist/index.js:273`:

```javascript
if (nonTightList(inner.node, state.doc))
    insert = blankLine(context, state, line) + state.lineBreak + insert;
```

Production documents frequently contain non-tight lists (blank lines between items, confirmed in relay content). Once a list is non-tight, every new Enter perpetuates the pattern.

A secondary trigger also exists: pressing Enter on an empty second item in a 2-item tight list converts it to non-tight (lines 242-246), making all subsequent items non-tight.

## Desired Behavior

Match Obsidian: pressing Enter in a list always creates tight continuation (`\n- `), regardless of existing blank lines in the list. Existing document content is not modified.

## Approach: Post-process Wrapper

Wrap `insertNewlineContinueMarkup` to intercept its transaction and collapse double newlines into single newlines before dispatching.

### New file: `extensions/tightListEnter.ts`

Exports `tightListContinueMarkup: StateCommand` which:

1. Calls `insertNewlineContinueMarkup` with a capturing dispatch
2. If the captured transaction contains `\n\n` insertions, collapses them to `\n` and adjusts the cursor position
3. Dispatches the modified transaction to the real view
4. Falls through transparently if the upstream command returns `false`

### Integration in Editor.tsx

```typescript
markdown({
  base: markdownLanguage,
  extensions: [WikilinkExtension],
  addKeymap: false,  // Disable built-in Enter/Backspace
}),
Prec.high(keymap.of([
  { key: 'Enter', run: tightListContinueMarkup },
  { key: 'Backspace', run: deleteMarkupBackward },
])),
```

### Test helper in `codemirror-helpers.ts`

New `createMarkdownEditor(content, cursorPos)` that returns an EditorView with the full markdown keymap stack (including the tight list handler at `Prec.high`), so tests simulate a real Enter key press through the keymap.

### Error handling

If the wrapper encounters anything unexpected (no transaction captured, complex multi-range changes), it falls through to the original unmodified behavior.

## Test Cases

- Non-tight bullet list: Enter produces tight continuation
- Non-tight ordered list: Enter produces tight continuation with correct numbering
- Tight bullet list: Enter still works (no change in behavior)
- Empty bullet item: Enter exits the list (removes marker)
- Nested list: Enter produces tight continuation at correct indent level
- Non-list context: Enter falls through to default handler
- Cursor mid-line: Enter splits line correctly (tight)
