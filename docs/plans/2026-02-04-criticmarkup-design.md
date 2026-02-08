# CriticMarkup Commenting Design

## Overview

Add CriticMarkup support to Lens Editor for suggestions and comments. Cross-compatible with Obsidian's Commentator plugin.

## Syntax

### Standard CriticMarkup (all 5 types)

```
{++addition++}
{--deletion--}
{~~old~>new~~}
{>>comment<<}
{==highlight==}
```

### With Metadata (Commentator format)

```
{++{"author":"alice","timestamp":1706900000}@@added text++}
{--{"author":"bob"}@@deleted text--}
{>>{"author":"alice","timestamp":1706900000}@@This is my comment<<}
```

Metadata is JSON, separated from content by `@@`.

### Multiline Support

```
{++
Hello world

Can I do multiline?++}
```

### Threads

Adjacent comments (no characters between) form a thread:

```
text{>>first<<}{>>reply<<}{>>another reply<<} more
    └─────────────── thread ───────────────┘
```

Any character (even a space) between comments separates them.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         LENS EDITOR                                 │
│                                                                     │
│  ┌─────────────────────────────────┐  ┌──────────────────────────┐ │
│  │         CodeMirror 6            │  │     Comments Panel       │ │
│  │                                 │  │        (React)           │ │
│  │  Y.Text contains CriticMarkup   │  │                          │ │
│  │  inline in markdown             │  │  Read-only view of       │ │
│  │           │                     │  │  comments from StateField│ │
│  │           ▼                     │  │                          │ │
│  │  ┌─────────────────────────┐   │  │  Edit = textarea that    │ │
│  │  │ Parser (regex-based)    │   │  │  writes to Y.Text on     │ │
│  │  │ Extracts ranges + meta  │   │  │  Enter/Save              │ │
│  │  └─────────────────────────┘   │  │                          │ │
│  │           │                     │  │  Click comment = scroll  │ │
│  │           ▼                     │  │  to position in editor   │ │
│  │  ┌─────────────────────────┐   │  │                          │ │
│  │  │ StateField              │◄──┼──┤                          │ │
│  │  │ CriticMarkupRange[]     │   │  │                          │ │
│  │  └─────────────────────────┘   │  │                          │ │
│  │           │                     │  │                          │ │
│  │           ▼                     │  │                          │ │
│  │  ┌─────────────────────────┐   │  │                          │ │
│  │  │ Decorations             │   │  │                          │ │
│  │  │ - Styling (colors)      │   │  │                          │ │
│  │  │ - Gutter markers        │   │  │                          │ │
│  │  │ - Accept/reject buttons │   │  │                          │ │
│  │  └─────────────────────────┘   │  │                          │ │
│  └─────────────────────────────────┘  └──────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Build vs reuse | Build our own | Commentator is Obsidian-coupled, uses custom CM fork, no Y.js awareness |
| Parser approach | Regex with `s` flag | Simple, testable, handles multiline. Lezer grammar later if needed |
| Comments panel | React (not CM widget) | Simpler, full control over UI |
| Edit-on-commit | Yes (Option C) | Type in panel textarea, writes to Y.Text on Enter/Save. Not real-time during typing, but proven pattern (Commentator does this) |
| Position updates | Full re-parse on change | Simpler than incremental mapping. Fine for docs under ~50KB |
| Thread detection | Adjacency-based | Comments with no characters between = thread. No threadId needed |
| Metadata format | Commentator-compatible | `{++{"author":"..."}@@content++}` for cross-compatibility |
| Suggestion mode | Transaction filter | Intercept CM transactions, wrap in markup. Don't extend existing markup in v1 (simpler) |

## Data Structures

### CriticMarkupRange

```typescript
interface CriticMarkupRange {
  type: 'addition' | 'deletion' | 'substitution' | 'comment' | 'highlight';
  from: number;
  to: number;
  content: string;
  // For substitution only:
  oldContent?: string;
  newContent?: string;
  // Metadata (optional):
  metadata?: {
    author?: string;
    timestamp?: number;
  };
}
```

### Thread (derived)

```typescript
interface CommentThread {
  comments: CriticMarkupRange[]; // type === 'comment', adjacent
  from: number; // first comment's from
  to: number;   // last comment's to
}
```

## Components

### 1. Parser (`src/lib/criticmarkup-parser.ts`)

Pure function, no DOM dependency:

```typescript
function parse(doc: string): CriticMarkupRange[];
function parseThreads(ranges: CriticMarkupRange[]): CommentThread[];
```

Regex patterns with `s` flag for multiline:

```typescript
const patterns = {
  addition:     /\{\+\+(.+?)\+\+\}/gs,
  deletion:     /\{--(.+?)--\}/gs,
  substitution: /\{~~(.+?)~>(.+?)~~\}/gs,
  comment:      /\{>>(.+?)<<\}/gs,
  highlight:    /\{==(.+?)==\}/gs,
};
```

### 2. StateField (`src/components/Editor/extensions/criticmarkup.ts`)

```typescript
const criticMarkupField = StateField.define<CriticMarkupRange[]>({
  create(state) {
    return parse(state.doc.toString());
  },
  update(ranges, transaction) {
    if (!transaction.docChanged) return ranges;
    return parse(transaction.state.doc.toString());
  },
});
```

### 3. Decorations

- **Mark decorations**: Style additions (green), deletions (red strikethrough), highlights (yellow)
- **Widget decorations**: Gutter markers, accept/reject buttons
- **Live preview**: Hide CriticMarkup syntax when cursor outside (like existing wikilink/emphasis behavior)

### 4. Comments Panel (`src/components/CommentsPanel/`)

React component that:
- Subscribes to StateField via CM view
- Lists comments grouped by thread
- Shows author, timestamp, content
- Click → scrolls editor to comment position
- "Add Comment" → textarea → Enter writes to Y.Text
- "Edit" → textarea with current content → Save updates Y.Text
- "Reply" → textarea → writes adjacent comment

### 5. Accept/Reject

**UI entry points** (following Google Docs + Commentator patterns):
- Gutter buttons (checkmark / X)
- Right-click context menu
- Command palette
- Keyboard shortcuts (TBD)

**Logic:**
- Accept addition: Remove `{++` and `++}`, keep content
- Accept deletion: Remove entire `{--...--}`
- Accept substitution: Replace `{~~old~>new~~}` with `new`
- Reject = inverse

### 6. Suggestion Mode

Toggle between two editing modes:

- **Editing mode** (default): Normal typing, changes go directly to Y.Text
- **Suggestion mode**: Every edit auto-wraps in CriticMarkup with author metadata

#### Mode State

```typescript
const suggestionModeField = StateField.define<boolean>({
  create() { return false; },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(toggleSuggestionMode)) return effect.value;
    }
    return value;
  },
});

const toggleSuggestionMode = StateEffect.define<boolean>();
```

#### Transaction Filter

Transaction filters are a standard CodeMirror 6 extension point (`EditorState.transactionFilter`). They intercept transactions between creation and application:

```
User types → DOM event → Transaction created → Filter intercepts → Modified transaction → Applied to state
```

This is the designed mechanism for transforming user input before it's applied (also used for auto-closing brackets, input masks, etc.). Importantly, programmatic `view.dispatch()` calls go through the same filter - this is why we can test suggestion mode with Happy DOM by dispatching transactions directly, without simulating keyboard events.

When suggestion mode is ON, our filter intercepts transactions and wraps changes:

```typescript
const suggestionModeFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  if (!tr.startState.field(suggestionModeField)) return tr;

  // Get current user info for metadata
  const author = getCurrentUser();
  const timestamp = Date.now();
  const meta = JSON.stringify({ author, timestamp });

  // Transform each change
  const newChanges: ChangeSpec[] = [];

  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    const deleted = tr.startState.doc.sliceString(fromA, toA);
    const added = inserted.toString();

    if (deleted && added) {
      // Replacement → substitution
      newChanges.push({
        from: fromA,
        to: toA,
        insert: `{~~${meta}@@${deleted}~>${added}~~}`,
      });
    } else if (deleted) {
      // Pure deletion
      newChanges.push({
        from: fromA,
        to: toA,
        insert: `{--${meta}@@${deleted}--}`,
      });
    } else if (added) {
      // Pure insertion
      newChanges.push({
        from: fromA,
        insert: `{++${meta}@@${added}++}`,
      });
    }
  });

  return { changes: newChanges };
});
```

#### Cursor Positioning (Critical for Continuous Typing)

After wrapping, cursor must be positioned *inside* the content:
- **Addition**: Before `++}` so next keystroke extends the addition
- **Deletion**: After the closing `--}` (content is "deleted")
- **Substitution**: At end of new content, before `~~}`

This prevents each character becoming a separate markup block.

**Flow for typing "hello":**
```
Type 'h' at pos 0:
  → Not inside addition → wrap → {++{"author":"me"}@@h++}
  → Cursor: {++{"author":"me"}@@h|++}  (before ++})

Type 'e':
  → Detect: cursor inside addition by same author → NO wrap
  → Just insert 'e' normally → {++{"author":"me"}@@he|++}

Type 'l', 'l', 'o':
  → Same logic → {++{"author":"me"}@@hello|++}
```

#### Transaction Filter Logic (Updated)

```typescript
const suggestionModeFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  if (!tr.startState.field(suggestionModeField)) return tr;

  const author = getCurrentUser();
  const cursorPos = tr.startState.selection.main.head;

  // Check if cursor is inside existing addition by same author
  const ranges = tr.startState.field(criticMarkupField);
  const insideOwnAddition = ranges.some(r =>
    r.type === 'addition' &&
    r.metadata?.author === author &&
    cursorPos > r.from && cursorPos < r.to
  );

  if (insideOwnAddition) {
    // Let the edit through - it's already inside our addition
    return tr;
  }

  // Otherwise, wrap the change in new markup
  // ... (wrapping logic as before)
});
```

#### Edge Cases

| Scenario | Behavior |
|----------|----------|
| Typing inside own addition | No wrap - extends naturally |
| Typing inside another author's addition | Create nested addition |
| Typing immediately after `++}` | Create new adjacent addition (v1 simplification) |
| Deleting inside own addition | No wrap - deletion is within addition |
| Deleting across addition boundary | Complex - defer to v2 |
| Undo in suggestion mode | Undoes the wrapped change |
| Paste in suggestion mode | Entire paste wrapped as single addition |

**v1 Simplification:** If cursor is immediately after `++}` (not inside), we create a new adjacent addition rather than extending. This may result in `{++hello++}{++world++}` when typing with a pause, which is verbose but correct.

#### UI Toggle

```
┌─────────────────────────────────────────┐
│  [Editing ▼]  ←── dropdown or toggle    │
│   ○ Editing                             │
│   ● Suggesting                          │
└─────────────────────────────────────────┘
```

Or a simple toggle button in the toolbar that shows current mode.

## Testing Strategy

### Parser Tests (no DOM)

```typescript
describe('CriticMarkup Parser', () => {
  describe('basic patterns', () => {
    it('parses addition');
    it('parses deletion');
    it('parses substitution');
    it('parses comment');
    it('parses highlight');
  });

  describe('multiline', () => {
    it('parses multiline addition');
    it('parses multiline with metadata');
  });

  describe('metadata', () => {
    it('extracts author and timestamp');
    it('handles missing metadata');
    it('handles malformed JSON');
  });

  describe('threads', () => {
    it('groups adjacent comments');
    it('separates comments with characters between');
  });

  describe('edge cases', () => {
    it('handles nested markup');
    it('handles unclosed markup');
    it('handles empty content');
  });
});
```

### Decoration Tests (Happy DOM)

Using existing `createTestEditor` pattern:

```typescript
describe('CriticMarkup Decorations', () => {
  it('applies cm-addition class to additions');
  it('applies cm-deletion class to deletions');
  it('hides markup syntax when cursor outside');
  it('shows markup syntax when cursor inside');
  it('updates positions when text inserted before markup');
});
```

### Accept/Reject Tests (unit, no DOM)

```typescript
describe('Accept/Reject', () => {
  it('accept addition removes delimiters, keeps content');
  it('accept deletion removes entire markup');
  it('accept substitution keeps new content');
  it('reject addition removes entire markup');
  it('reject deletion removes delimiters, keeps content');
  it('reject substitution keeps old content');
});
```

### Suggestion Mode Tests (Happy DOM)

These tests use `view.dispatch({ changes: ... })` to simulate typing. This goes through the same transaction filter as real keyboard input, so we're testing the actual code path without needing Playwright or real browser events.

```typescript
describe('Suggestion Mode', () => {
  describe('mode toggle', () => {
    it('starts in editing mode by default');
    it('can toggle to suggestion mode');
    it('can toggle back to editing mode');
  });

  describe('wrapping insertions', () => {
    it('wraps first character in addition markup');
    it('includes author and timestamp in metadata');
    it('positions cursor inside content (before ++})');
    it('does NOT wrap subsequent chars when typing inside own addition');
    it('continuous typing produces single addition, not per-character');
  });

  describe('wrapping deletions', () => {
    it('wraps deleted text in deletion markup');
    it('positions cursor after deletion markup');
  });

  describe('wrapping replacements', () => {
    it('wraps selection replacement in substitution markup');
    it('captures both old and new text');
  });

  describe('edge cases', () => {
    it('wraps pasted text as single addition');
    it('handles multi-cursor edits');
    it('undo removes entire wrapped change');
  });
});
```

## Implementation Phases

### Phase 1: Parser & Basic Rendering
- Parser with all 5 types + metadata + multiline
- StateField for CriticMarkup ranges
- Basic decorations (styling, no live preview hiding yet)
- TDD: Parser tests first

### Phase 2: Live Preview
- Hide syntax when cursor outside (like wikilinks)
- Show syntax when cursor inside
- TDD: Decoration tests with Happy DOM

### Phase 3: Suggestion Mode
- StateField for mode toggle
- Transaction filter to wrap edits
- UI toggle (toolbar button or dropdown)
- Cursor positioning after wrap
- TDD: Suggestion mode tests with Happy DOM

### Phase 4: Accept/Reject
- Pure functions for accept/reject logic
- Commands + keyboard shortcuts
- Gutter buttons
- Context menu
- TDD: Accept/reject logic tests (no DOM)

### Phase 5: Comments Panel
- React component reading from StateField
- List comments with thread grouping
- Click to navigate
- Add/edit/reply (edit-on-commit to Y.Text)

### Phase 6: Polish & Integration
- Gutter markers for all markup types
- Permission level integration (future - when auth exists)
- Performance optimization if needed

## Open Questions

1. **Keyboard shortcuts for accept/reject** - What keys? Ctrl+Enter? Custom?
2. **Comments panel placement** - Right sidebar (like ToC)? Collapsible?
3. **Styling** - Match Commentator's colors or our own palette?
4. **Resolved status** - Add `resolved: boolean` to metadata for comments?

---
*Design created: 2026-02-04*
