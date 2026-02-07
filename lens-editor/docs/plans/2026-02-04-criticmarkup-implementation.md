# CriticMarkup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement CriticMarkup support for inline suggestions and comments, cross-compatible with Obsidian's Commentator plugin.

**Architecture:** Regex-based parser extracts CriticMarkup ranges from document text. CodeMirror StateField holds parsed ranges, rebuilt on every document change. ViewPlugin applies decorations (styling, syntax hiding) based on cursor position. Transaction filter intercepts edits in suggestion mode to wrap them in markup.

**Tech Stack:** TypeScript, CodeMirror 6 (StateField, ViewPlugin, transactionFilter), Vitest + Happy DOM, existing `createTestEditor` pattern.

---

## Task 1: Parser - Basic Types

**Files:**
- Create: `src/lib/criticmarkup-parser.ts`
- Create: `src/lib/criticmarkup-parser.test.ts`

### Step 1: Write failing test for addition parsing

```typescript
// src/lib/criticmarkup-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parse } from './criticmarkup-parser';

describe('CriticMarkup Parser', () => {
  describe('basic patterns', () => {
    it('parses addition', () => {
      const result = parse('hello {++world++} end');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'addition',
        from: 6,
        to: 17,
        contentFrom: 9,   // after {++
        contentTo: 14,    // before ++}
        content: 'world',
      });
    });
  });
});
```

### Step 2: Run test to verify it fails

Run: `npm test -- src/lib/criticmarkup-parser.test.ts`

Expected: FAIL with "Cannot find module './criticmarkup-parser'"

### Step 3: Write minimal implementation

```typescript
// src/lib/criticmarkup-parser.ts
export interface CriticMarkupRange {
  type: 'addition' | 'deletion' | 'substitution' | 'comment' | 'highlight';
  from: number;
  to: number;
  contentFrom: number;  // Where actual content starts (after opening delimiter + metadata)
  contentTo: number;    // Where actual content ends (before closing delimiter)
  content: string;
  oldContent?: string;
  newContent?: string;
  metadata?: {
    author?: string;
    timestamp?: number;
  };
}

export function parse(doc: string): CriticMarkupRange[] {
  const ranges: CriticMarkupRange[] = [];
  const additionPattern = /\{\+\+(.+?)\+\+\}/gs;

  let match;
  while ((match = additionPattern.exec(doc)) !== null) {
    const openDelimLen = 3; // {++
    const closeDelimLen = 3; // ++}
    ranges.push({
      type: 'addition',
      from: match.index,
      to: match.index + match[0].length,
      contentFrom: match.index + openDelimLen,
      contentTo: match.index + match[0].length - closeDelimLen,
      content: match[1],
    });
  }

  return ranges;
}
```

### Step 4: Run test to verify it passes

Run: `npm test -- src/lib/criticmarkup-parser.test.ts`

Expected: PASS

### Step 5: Commit

```bash
jj describe -m "feat(criticmarkup): add parser with addition support"
```

---

## Task 2: Parser - Remaining Basic Types

**Files:**
- Modify: `src/lib/criticmarkup-parser.test.ts`
- Modify: `src/lib/criticmarkup-parser.ts`

### Step 1: Write failing tests for deletion, substitution, comment, highlight

```typescript
// Add to src/lib/criticmarkup-parser.test.ts, inside describe('basic patterns')

    it('parses deletion', () => {
      const result = parse('hello {--removed--} end');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'deletion',
        from: 6,
        to: 19,
        content: 'removed',
      });
    });

    it('parses substitution', () => {
      const result = parse('hello {~~old~>new~~} end');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'substitution',
        from: 6,
        to: 20,
        content: 'old~>new',
        oldContent: 'old',
        newContent: 'new',
      });
    });

    it('parses comment', () => {
      const result = parse('hello {>>note<<} end');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'comment',
        from: 6,
        to: 16,
        content: 'note',
      });
    });

    it('parses highlight', () => {
      const result = parse('hello {==important==} end');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'highlight',
        from: 6,
        to: 21,
        content: 'important',
      });
    });
```

### Step 2: Run tests to verify they fail

Run: `npm test -- src/lib/criticmarkup-parser.test.ts`

Expected: 4 failing tests (deletion, substitution, comment, highlight)

### Step 3: Implement remaining patterns

```typescript
// Replace parse function in src/lib/criticmarkup-parser.ts

const DELIM_LENGTHS = {
  addition: { open: 3, close: 3 },      // {++ ++}
  deletion: { open: 3, close: 3 },      // {-- --}
  substitution: { open: 3, close: 3 },  // {~~ ~~}
  comment: { open: 3, close: 3 },       // {>> <<}
  highlight: { open: 3, close: 3 },     // {== ==}
};

export function parse(doc: string): CriticMarkupRange[] {
  const ranges: CriticMarkupRange[] = [];

  const patterns: Array<{
    type: CriticMarkupRange['type'];
    regex: RegExp;
    hasSubstitution?: boolean;
  }> = [
    { type: 'addition', regex: /\{\+\+(.+?)\+\+\}/gs },
    { type: 'deletion', regex: /\{--(.+?)--\}/gs },
    { type: 'substitution', regex: /\{~~(.+?)~>(.+?)~~\}/gs, hasSubstitution: true },
    { type: 'comment', regex: /\{>>(.+?)<<\}/gs },
    { type: 'highlight', regex: /\{==(.+?)==\}/gs },
  ];

  for (const { type, regex, hasSubstitution } of patterns) {
    const delims = DELIM_LENGTHS[type];
    let match;
    while ((match = regex.exec(doc)) !== null) {
      const from = match.index;
      const to = match.index + match[0].length;
      const range: CriticMarkupRange = {
        type,
        from,
        to,
        contentFrom: from + delims.open,
        contentTo: to - delims.close,
        content: hasSubstitution ? `${match[1]}~>${match[2]}` : match[1],
      };

      if (hasSubstitution) {
        range.oldContent = match[1];
        range.newContent = match[2];
      }

      ranges.push(range);
    }
  }

  // Sort by position
  ranges.sort((a, b) => a.from - b.from);

  return ranges;
}
```

### Step 4: Run tests to verify they pass

Run: `npm test -- src/lib/criticmarkup-parser.test.ts`

Expected: All 5 tests PASS

### Step 5: Commit

```bash
jj describe -m "feat(criticmarkup): parser supports all 5 markup types"
```

---

## Task 3: Parser - Metadata Extraction

**Files:**
- Modify: `src/lib/criticmarkup-parser.test.ts`
- Modify: `src/lib/criticmarkup-parser.ts`

### Step 1: Write failing tests for metadata

```typescript
// Add new describe block in src/lib/criticmarkup-parser.test.ts

  describe('metadata', () => {
    it('extracts author and timestamp from addition', () => {
      const result = parse('{++{"author":"alice","timestamp":1706900000}@@added text++}');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'addition',
        content: 'added text',
        metadata: {
          author: 'alice',
          timestamp: 1706900000,
        },
      });
      // contentFrom should be after metadata+@@, not just after {++
      // {++{"author":"alice","timestamp":1706900000}@@ = 46 chars
      expect(result[0].contentFrom).toBe(46);
    });

    it('extracts metadata from comment', () => {
      const result = parse('{>>{"author":"bob"}@@This is my comment<<}');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'comment',
        content: 'This is my comment',
        metadata: {
          author: 'bob',
        },
      });
    });

    it('handles missing metadata gracefully', () => {
      const result = parse('{++plain text++}');

      expect(result).toHaveLength(1);
      expect(result[0].metadata).toBeUndefined();
      expect(result[0].content).toBe('plain text');
    });

    it('handles malformed JSON metadata', () => {
      const result = parse('{++{invalid json}@@content++}');

      expect(result).toHaveLength(1);
      // Should treat entire thing as content when JSON is invalid
      expect(result[0].content).toBe('{invalid json}@@content');
      expect(result[0].metadata).toBeUndefined();
    });
  });
```

### Step 2: Run tests to verify they fail

Run: `npm test -- src/lib/criticmarkup-parser.test.ts`

Expected: 4 failing tests in "metadata" block

### Step 3: Implement metadata extraction

```typescript
// Add helper function and update parse function in src/lib/criticmarkup-parser.ts

interface ParsedContent {
  content: string;
  metadata?: CriticMarkupRange['metadata'];
  metadataLength: number; // Length of metadata + @@ prefix (0 if no metadata)
}

function extractMetadata(rawContent: string): ParsedContent {
  // Check for metadata format: {"author":"..."}@@content
  const metaMatch = rawContent.match(/^(\{[^}]+\})@@(.+)$/s);

  if (!metaMatch) {
    return { content: rawContent, metadataLength: 0 };
  }

  try {
    const metadata = JSON.parse(metaMatch[1]);
    // metadataLength = JSON part + "@@" (2 chars)
    const metadataLength = metaMatch[1].length + 2;
    return {
      content: metaMatch[2],
      metadata: {
        author: metadata.author,
        timestamp: metadata.timestamp,
      },
      metadataLength,
    };
  } catch {
    // Invalid JSON - treat entire content as-is
    return { content: rawContent, metadataLength: 0 };
  }
}

const DELIM_LENGTHS = {
  addition: { open: 3, close: 3 },
  deletion: { open: 3, close: 3 },
  substitution: { open: 3, close: 3 },
  comment: { open: 3, close: 3 },
  highlight: { open: 3, close: 3 },
};

export function parse(doc: string): CriticMarkupRange[] {
  const ranges: CriticMarkupRange[] = [];

  const patterns: Array<{
    type: CriticMarkupRange['type'];
    regex: RegExp;
    hasSubstitution?: boolean;
  }> = [
    { type: 'addition', regex: /\{\+\+(.+?)\+\+\}/gs },
    { type: 'deletion', regex: /\{--(.+?)--\}/gs },
    { type: 'substitution', regex: /\{~~(.+?)~>(.+?)~~\}/gs, hasSubstitution: true },
    { type: 'comment', regex: /\{>>(.+?)<<\}/gs },
    { type: 'highlight', regex: /\{==(.+?)==\}/gs },
  ];

  for (const { type, regex, hasSubstitution } of patterns) {
    const delims = DELIM_LENGTHS[type];
    let match;
    while ((match = regex.exec(doc)) !== null) {
      const from = match.index;
      const to = match.index + match[0].length;

      let content: string;
      let metadata: CriticMarkupRange['metadata'] | undefined;
      let metadataLength = 0;
      let oldContent: string | undefined;
      let newContent: string | undefined;

      if (hasSubstitution) {
        // For substitution, extract metadata from old part only
        const oldParsed = extractMetadata(match[1]);
        content = `${oldParsed.content}~>${match[2]}`;
        metadata = oldParsed.metadata;
        metadataLength = oldParsed.metadataLength;
        oldContent = oldParsed.content;
        newContent = match[2];
      } else {
        const parsed = extractMetadata(match[1]);
        content = parsed.content;
        metadata = parsed.metadata;
        metadataLength = parsed.metadataLength;
      }

      // contentFrom accounts for opening delimiter + any metadata
      const contentFrom = from + delims.open + metadataLength;
      const contentTo = to - delims.close;

      const range: CriticMarkupRange = {
        type,
        from,
        to,
        contentFrom,
        contentTo,
        content,
      };

      if (metadata) {
        range.metadata = metadata;
      }
      if (oldContent !== undefined) {
        range.oldContent = oldContent;
      }
      if (newContent !== undefined) {
        range.newContent = newContent;
      }

      ranges.push(range);
    }
  }

  ranges.sort((a, b) => a.from - b.from);

  return ranges;
}
```

### Step 4: Run tests to verify they pass

Run: `npm test -- src/lib/criticmarkup-parser.test.ts`

Expected: All tests PASS

### Step 5: Commit

```bash
jj describe -m "feat(criticmarkup): parser extracts Commentator metadata"
```

---

## Task 4: Parser - Multiline Support

**Files:**
- Modify: `src/lib/criticmarkup-parser.test.ts`

### Step 1: Write tests for multiline

```typescript
// Add new describe block in src/lib/criticmarkup-parser.test.ts

  describe('multiline', () => {
    it('parses multiline addition', () => {
      const doc = `{++
Hello world

Can I do multiline?++}`;

      const result = parse(doc);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('addition');
      expect(result[0].content).toContain('Hello world');
      expect(result[0].content).toContain('Can I do multiline?');
    });

    it('parses multiline with metadata', () => {
      const doc = `{++{"author":"alice"}@@
First line
Second line++}`;

      const result = parse(doc);

      expect(result).toHaveLength(1);
      expect(result[0].metadata?.author).toBe('alice');
      expect(result[0].content).toContain('First line');
      expect(result[0].content).toContain('Second line');
    });

    it('parses multiline comment', () => {
      const doc = `{>>
This is a
multi-line comment
<<}`;

      const result = parse(doc);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('comment');
      expect(result[0].content).toContain('multi-line');
    });
  });
```

### Step 2: Run tests to verify they pass

Run: `npm test -- src/lib/criticmarkup-parser.test.ts`

Expected: All tests PASS (the `s` flag on regex already handles multiline)

### Step 3: Commit

```bash
jj describe -m "test(criticmarkup): verify multiline parsing works"
```

---

## Task 5: Parser - Thread Detection

**Files:**
- Modify: `src/lib/criticmarkup-parser.ts`
- Modify: `src/lib/criticmarkup-parser.test.ts`

### Step 1: Write failing tests for thread grouping

```typescript
// Add to src/lib/criticmarkup-parser.test.ts

import { parse, parseThreads } from './criticmarkup-parser';

// Add new describe block

  describe('threads', () => {
    it('groups adjacent comments into a thread', () => {
      const doc = 'text{>>first<<}{>>reply<<}{>>another<<} more';
      const ranges = parse(doc);
      const threads = parseThreads(ranges);

      expect(threads).toHaveLength(1);
      expect(threads[0].comments).toHaveLength(3);
      expect(threads[0].from).toBe(4);
      expect(threads[0].to).toBe(39);
    });

    it('separates comments with characters between', () => {
      const doc = 'text{>>first<<} {>>second<<} more';
      const ranges = parse(doc);
      const threads = parseThreads(ranges);

      expect(threads).toHaveLength(2);
      expect(threads[0].comments).toHaveLength(1);
      expect(threads[1].comments).toHaveLength(1);
    });

    it('returns empty array when no comments', () => {
      const doc = 'text{++addition++} more';
      const ranges = parse(doc);
      const threads = parseThreads(ranges);

      expect(threads).toHaveLength(0);
    });
  });
```

### Step 2: Run tests to verify they fail

Run: `npm test -- src/lib/criticmarkup-parser.test.ts`

Expected: FAIL with "parseThreads is not exported"

### Step 3: Implement parseThreads

```typescript
// Add to src/lib/criticmarkup-parser.ts

export interface CommentThread {
  comments: CriticMarkupRange[];
  from: number;
  to: number;
}

export function parseThreads(ranges: CriticMarkupRange[]): CommentThread[] {
  const comments = ranges.filter((r) => r.type === 'comment');

  if (comments.length === 0) {
    return [];
  }

  const threads: CommentThread[] = [];
  let currentThread: CriticMarkupRange[] = [comments[0]];

  for (let i = 1; i < comments.length; i++) {
    const prev = comments[i - 1];
    const curr = comments[i];

    // Adjacent if previous ends exactly where current starts
    if (prev.to === curr.from) {
      currentThread.push(curr);
    } else {
      // Finalize previous thread, start new one
      threads.push({
        comments: currentThread,
        from: currentThread[0].from,
        to: currentThread[currentThread.length - 1].to,
      });
      currentThread = [curr];
    }
  }

  // Don't forget the last thread
  threads.push({
    comments: currentThread,
    from: currentThread[0].from,
    to: currentThread[currentThread.length - 1].to,
  });

  return threads;
}
```

### Step 4: Run tests to verify they pass

Run: `npm test -- src/lib/criticmarkup-parser.test.ts`

Expected: All tests PASS

### Step 5: Commit

```bash
jj describe -m "feat(criticmarkup): add thread detection for adjacent comments"
```

---

## Task 6: Parser - Edge Cases

**Files:**
- Modify: `src/lib/criticmarkup-parser.test.ts`

### Step 1: Write tests for edge cases

```typescript
// Add new describe block in src/lib/criticmarkup-parser.test.ts

  describe('edge cases', () => {
    it('handles multiple markup types in same document', () => {
      const doc = '{++added++} normal {--deleted--} {==highlighted==}';
      const result = parse(doc);

      expect(result).toHaveLength(3);
      expect(result[0].type).toBe('addition');
      expect(result[1].type).toBe('deletion');
      expect(result[2].type).toBe('highlight');
    });

    it('handles empty content', () => {
      const result = parse('{++++}');

      // Empty content should still match
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('');
    });

    it('handles unclosed markup (no match)', () => {
      const result = parse('{++unclosed');

      expect(result).toHaveLength(0);
    });

    it('handles nested braces in content', () => {
      const result = parse('{++function() { return 1; }++}');

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('function() { return 1; }');
    });

    it('preserves position accuracy with unicode', () => {
      const doc = '🎉{++emoji++}';
      const result = parse(doc);

      expect(result).toHaveLength(1);
      // 🎉 is 2 UTF-16 code units
      expect(result[0].from).toBe(2);
    });
  });
```

### Step 2: Run tests

Run: `npm test -- src/lib/criticmarkup-parser.test.ts`

Expected: Tests should pass (regex handles these cases). If any fail, fix the implementation.

### Step 3: Fix empty content if needed

If the "empty content" test fails, update the regex to use `*?` instead of `+?`:

```typescript
// In patterns array, change each regex from +? to *?
{ type: 'addition', regex: /\{\+\+(.*?)\+\+\}/gs },
{ type: 'deletion', regex: /\{--(.*?)--\}/gs },
{ type: 'substitution', regex: /\{~~(.*?)~>(.*?)~~\}/gs, hasSubstitution: true },
{ type: 'comment', regex: /\{>>(.*?)<<\}/gs },
{ type: 'highlight', regex: /\{==(.*?)==\}/gs },
```

### Step 4: Run tests to verify all pass

Run: `npm test -- src/lib/criticmarkup-parser.test.ts`

Expected: All tests PASS

### Step 5: Commit

```bash
jj describe -m "test(criticmarkup): add edge case tests for parser"
```

---

## Task 7: CodeMirror Extension - StateField

**Files:**
- Create: `src/components/Editor/extensions/criticmarkup.ts`
- Create: `src/components/Editor/extensions/criticmarkup.test.ts`
- Modify: `src/test/codemirror-helpers.ts`

### Step 1: Add test helper for CriticMarkup

```typescript
// Add to src/test/codemirror-helpers.ts

import { criticMarkupExtension } from '../components/Editor/extensions/criticmarkup';

/**
 * Create an EditorView with CriticMarkup extension for testing.
 */
export function createCriticMarkupEditor(
  content: string,
  cursorPos: number
): { view: EditorView; cleanup: () => void } {
  const state = EditorState.create({
    doc: content,
    selection: { anchor: cursorPos },
    extensions: [
      markdown(),
      criticMarkupExtension(),
    ],
  });

  const view = new EditorView({
    state,
    parent: document.body,
  });

  return {
    view,
    cleanup: () => {
      view.destroy();
    },
  };
}
```

### Step 2: Write failing test for StateField

```typescript
// src/components/Editor/extensions/criticmarkup.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { createCriticMarkupEditor, hasClass } from '../../../test/codemirror-helpers';

describe('CriticMarkup Extension', () => {
  let cleanup: () => void;

  afterEach(() => {
    if (cleanup) cleanup();
  });

  describe('StateField', () => {
    it('parses CriticMarkup ranges from document', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        21
      );
      cleanup = c;

      // Access StateField through view.state
      const { criticMarkupField } = require('./criticmarkup');
      const ranges = view.state.field(criticMarkupField);

      expect(ranges).toHaveLength(1);
      expect(ranges[0].type).toBe('addition');
    });
  });
});
```

### Step 3: Run test to verify it fails

Run: `npm test -- src/components/Editor/extensions/criticmarkup.test.ts`

Expected: FAIL - module not found

### Step 4: Implement StateField

```typescript
// src/components/Editor/extensions/criticmarkup.ts
import { StateField } from '@codemirror/state';
import { parse, type CriticMarkupRange } from '../../../lib/criticmarkup-parser';

export const criticMarkupField = StateField.define<CriticMarkupRange[]>({
  create(state) {
    return parse(state.doc.toString());
  },
  update(ranges, transaction) {
    if (!transaction.docChanged) return ranges;
    return parse(transaction.state.doc.toString());
  },
});

export function criticMarkupExtension() {
  return [criticMarkupField];
}
```

### Step 5: Run test to verify it passes

Run: `npm test -- src/components/Editor/extensions/criticmarkup.test.ts`

Expected: PASS

### Step 6: Commit

```bash
jj describe -m "feat(criticmarkup): add StateField to track markup ranges"
```

---

## Task 8: Basic Decorations

**Files:**
- Modify: `src/components/Editor/extensions/criticmarkup.ts`
- Modify: `src/components/Editor/extensions/criticmarkup.test.ts`
- Modify: `src/index.css`

### Step 1: Write failing tests for decorations

```typescript
// Add to criticmarkup.test.ts

  describe('Decorations', () => {
    it('applies cm-addition class to additions', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        21
      );
      cleanup = c;

      expect(hasClass(view, 'cm-addition')).toBe(true);
    });

    it('applies cm-deletion class to deletions', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {--removed--} end',
        23
      );
      cleanup = c;

      expect(hasClass(view, 'cm-deletion')).toBe(true);
    });

    it('applies cm-highlight class to highlights', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {==important==} end',
        25
      );
      cleanup = c;

      expect(hasClass(view, 'cm-highlight')).toBe(true);
    });

    it('applies cm-comment class to comments', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {>>note<<} end',
        20
      );
      cleanup = c;

      expect(hasClass(view, 'cm-comment')).toBe(true);
    });
  });
```

### Step 2: Run tests to verify they fail

Run: `npm test -- src/components/Editor/extensions/criticmarkup.test.ts`

Expected: FAIL - classes don't exist yet

### Step 3: Implement ViewPlugin with decorations

```typescript
// Replace content of src/components/Editor/extensions/criticmarkup.ts

import { StateField, RangeSetBuilder } from '@codemirror/state';
import {
  ViewPlugin,
  ViewUpdate,
  EditorView,
  Decoration,
} from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { parse, type CriticMarkupRange } from '../../../lib/criticmarkup-parser';

// CSS class mapping
const TYPE_CLASSES: Record<CriticMarkupRange['type'], string> = {
  addition: 'cm-addition',
  deletion: 'cm-deletion',
  substitution: 'cm-substitution',
  comment: 'cm-comment',
  highlight: 'cm-highlight',
};

export const criticMarkupField = StateField.define<CriticMarkupRange[]>({
  create(state) {
    return parse(state.doc.toString());
  },
  update(ranges, transaction) {
    if (!transaction.docChanged) return ranges;
    return parse(transaction.state.doc.toString());
  },
});

const criticMarkupPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const ranges = view.state.field(criticMarkupField);

      // Sort by position (should already be sorted from parser)
      const sorted = [...ranges].sort((a, b) => a.from - b.from);

      for (const range of sorted) {
        const className = TYPE_CLASSES[range.type];
        builder.add(
          range.from,
          range.to,
          Decoration.mark({ class: className })
        );
      }

      return builder.finish();
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

export function criticMarkupExtension() {
  return [criticMarkupField, criticMarkupPlugin];
}
```

### Step 4: Add CSS styles

```css
/* Add to src/index.css */

/* CriticMarkup styles */
.cm-addition {
  background-color: rgba(34, 197, 94, 0.2); /* green-500 with opacity */
  color: #15803d; /* green-700 */
}

.cm-deletion {
  background-color: rgba(239, 68, 68, 0.2); /* red-500 with opacity */
  color: #b91c1c; /* red-700 */
  text-decoration: line-through;
}

.cm-substitution {
  background-color: rgba(234, 179, 8, 0.2); /* yellow-500 with opacity */
}

.cm-comment {
  background-color: rgba(59, 130, 246, 0.2); /* blue-500 with opacity */
  color: #1d4ed8; /* blue-700 */
}

.cm-highlight {
  background-color: rgba(250, 204, 21, 0.4); /* yellow-400 with opacity */
}
```

### Step 5: Run tests to verify they pass

Run: `npm test -- src/components/Editor/extensions/criticmarkup.test.ts`

Expected: All tests PASS

### Step 6: Commit

```bash
jj describe -m "feat(criticmarkup): add basic decorations with styling"
```

---

## Task 9: Live Preview - Syntax Hiding

**Files:**
- Modify: `src/components/Editor/extensions/criticmarkup.ts`
- Modify: `src/components/Editor/extensions/criticmarkup.test.ts`

### Step 1: Write failing tests for syntax hiding

```typescript
// Add to criticmarkup.test.ts

import { moveCursor } from '../../../test/codemirror-helpers';

  describe('Live Preview', () => {
    it('hides markup syntax when cursor is outside', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        21 // cursor at "end"
      );
      cleanup = c;

      // The {++ and ++} should be hidden
      expect(hasClass(view, 'cm-hidden-syntax')).toBe(true);
    });

    it('shows markup syntax when cursor is inside', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        10 // cursor inside "world"
      );
      cleanup = c;

      // The {++ and ++} should be visible (no hidden-syntax on them)
      // Check that hidden-syntax count is 0
      const hiddenCount = view.contentDOM.querySelectorAll('.cm-hidden-syntax').length;
      expect(hiddenCount).toBe(0);
    });

    it('updates decorations when cursor moves in and out', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        21 // start outside
      );
      cleanup = c;

      // Initially outside - syntax hidden
      expect(hasClass(view, 'cm-hidden-syntax')).toBe(true);

      // Move cursor inside
      moveCursor(view, 10);

      // Now inside - syntax visible
      expect(hasClass(view, 'cm-hidden-syntax')).toBe(false);

      // Move cursor back outside
      moveCursor(view, 21);

      // Outside again - syntax hidden
      expect(hasClass(view, 'cm-hidden-syntax')).toBe(true);
    });

    it('hides metadata and @@ when cursor is outside (metadata-aware)', () => {
      // With metadata: {++{"author":"alice"}@@content++}
      const { view, cleanup: c } = createCriticMarkupEditor(
        '{++{"author":"alice"}@@hello++} end',
        35 // cursor at "end"
      );
      cleanup = c;

      // The entire {++{"author":"alice"}@@ prefix and ++} suffix should be hidden
      // Only "hello" should be visible with cm-addition styling
      const hiddenElements = view.contentDOM.querySelectorAll('.cm-hidden-syntax');
      expect(hiddenElements.length).toBeGreaterThan(0);

      // The visible content should just be "hello"
      const additionElements = view.contentDOM.querySelectorAll('.cm-addition');
      expect(additionElements.length).toBe(1);
      expect(additionElements[0].textContent).toBe('hello');
    });
  });
```

### Step 2: Run tests to verify they fail

Run: `npm test -- src/components/Editor/extensions/criticmarkup.test.ts`

Expected: FAIL - no hidden-syntax class applied

### Step 3: Implement syntax hiding based on cursor

```typescript
// Update criticMarkupPlugin in src/components/Editor/extensions/criticmarkup.ts

import { EditorSelection } from '@codemirror/state';

// Add helper function
function selectionIntersects(
  selection: EditorSelection,
  from: number,
  to: number
): boolean {
  return selection.ranges.some((range) => range.to >= from && range.from <= to);
}

// Update the plugin class
const criticMarkupPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
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
        } else {
          // Cursor outside - hide delimiters (including metadata), style content only
          // Use contentFrom/contentTo from parser - these account for metadata

          // Opening delimiter + metadata (everything before content)
          decorations.push({
            from: range.from,
            to: range.contentFrom,
            deco: Decoration.mark({ class: 'cm-hidden-syntax' }),
          });

          // Content (between delimiters)
          decorations.push({
            from: range.contentFrom,
            to: range.contentTo,
            deco: Decoration.mark({ class: className }),
          });

          // Closing delimiter
          decorations.push({
            from: range.contentTo,
            to: range.to,
            deco: Decoration.mark({ class: 'cm-hidden-syntax' }),
          });
        }
      }

      // Sort by position
      decorations.sort((a, b) => a.from - b.from || a.to - b.to);

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

### Step 4: Run tests to verify they pass

Run: `npm test -- src/components/Editor/extensions/criticmarkup.test.ts`

Expected: All tests PASS

### Step 5: Commit

```bash
jj describe -m "feat(criticmarkup): hide syntax delimiters when cursor outside"
```

---

## Task 10: Accept/Reject - Pure Functions

**Files:**
- Create: `src/lib/criticmarkup-actions.ts`
- Create: `src/lib/criticmarkup-actions.test.ts`

### Step 1: Write failing tests for accept/reject

```typescript
// src/lib/criticmarkup-actions.test.ts
import { describe, it, expect } from 'vitest';
import { acceptChange, rejectChange } from './criticmarkup-actions';
import type { CriticMarkupRange } from './criticmarkup-parser';

describe('Accept/Reject Actions', () => {
  describe('acceptChange', () => {
    it('accept addition: removes delimiters, keeps content', () => {
      const doc = 'hello {++world++} end';
      const range: CriticMarkupRange = {
        type: 'addition',
        from: 6,
        to: 17,
        content: 'world',
      };

      const result = acceptChange(doc, range);

      expect(result).toBe('hello world end');
    });

    it('accept deletion: removes entire markup', () => {
      const doc = 'hello {--removed--} end';
      const range: CriticMarkupRange = {
        type: 'deletion',
        from: 6,
        to: 19,
        content: 'removed',
      };

      const result = acceptChange(doc, range);

      expect(result).toBe('hello  end');
    });

    it('accept substitution: keeps new content', () => {
      const doc = 'hello {~~old~>new~~} end';
      const range: CriticMarkupRange = {
        type: 'substitution',
        from: 6,
        to: 20,
        content: 'old~>new',
        oldContent: 'old',
        newContent: 'new',
      };

      const result = acceptChange(doc, range);

      expect(result).toBe('hello new end');
    });
  });

  describe('rejectChange', () => {
    it('reject addition: removes entire markup', () => {
      const doc = 'hello {++world++} end';
      const range: CriticMarkupRange = {
        type: 'addition',
        from: 6,
        to: 17,
        content: 'world',
      };

      const result = rejectChange(doc, range);

      expect(result).toBe('hello  end');
    });

    it('reject deletion: removes delimiters, keeps content', () => {
      const doc = 'hello {--removed--} end';
      const range: CriticMarkupRange = {
        type: 'deletion',
        from: 6,
        to: 19,
        content: 'removed',
      };

      const result = rejectChange(doc, range);

      expect(result).toBe('hello removed end');
    });

    it('reject substitution: keeps old content', () => {
      const doc = 'hello {~~old~>new~~} end';
      const range: CriticMarkupRange = {
        type: 'substitution',
        from: 6,
        to: 20,
        content: 'old~>new',
        oldContent: 'old',
        newContent: 'new',
      };

      const result = rejectChange(doc, range);

      expect(result).toBe('hello old end');
    });
  });
});
```

### Step 2: Run tests to verify they fail

Run: `npm test -- src/lib/criticmarkup-actions.test.ts`

Expected: FAIL - module not found

### Step 3: Implement accept/reject functions

```typescript
// src/lib/criticmarkup-actions.ts
import type { CriticMarkupRange } from './criticmarkup-parser';

/**
 * Accept a CriticMarkup change, returning the modified document.
 * - Addition: keep content, remove delimiters
 * - Deletion: remove entire markup (content is deleted)
 * - Substitution: keep new content
 */
export function acceptChange(doc: string, range: CriticMarkupRange): string {
  const before = doc.slice(0, range.from);
  const after = doc.slice(range.to);

  switch (range.type) {
    case 'addition':
      return before + range.content + after;
    case 'deletion':
      return before + after;
    case 'substitution':
      return before + (range.newContent ?? '') + after;
    case 'highlight':
      return before + range.content + after;
    case 'comment':
      // Accepting a comment just removes it
      return before + after;
    default:
      return doc;
  }
}

/**
 * Reject a CriticMarkup change, returning the modified document.
 * - Addition: remove entire markup (content is not added)
 * - Deletion: keep content, remove delimiters
 * - Substitution: keep old content
 */
export function rejectChange(doc: string, range: CriticMarkupRange): string {
  const before = doc.slice(0, range.from);
  const after = doc.slice(range.to);

  switch (range.type) {
    case 'addition':
      return before + after;
    case 'deletion':
      return before + range.content + after;
    case 'substitution':
      return before + (range.oldContent ?? '') + after;
    case 'highlight':
      return before + range.content + after;
    case 'comment':
      // Rejecting a comment keeps it? Or removes? Let's remove.
      return before + after;
    default:
      return doc;
  }
}
```

### Step 4: Run tests to verify they pass

Run: `npm test -- src/lib/criticmarkup-actions.test.ts`

Expected: All tests PASS

### Step 5: Commit

```bash
jj describe -m "feat(criticmarkup): add accept/reject pure functions"
```

---

## Task 11: Suggestion Mode - StateField and Effect

**Files:**
- Modify: `src/components/Editor/extensions/criticmarkup.ts`
- Modify: `src/components/Editor/extensions/criticmarkup.test.ts`

### Step 1: Write failing tests for suggestion mode toggle

```typescript
// Add to criticmarkup.test.ts

import { toggleSuggestionMode, suggestionModeField } from './criticmarkup';

  describe('Suggestion Mode', () => {
    describe('mode toggle', () => {
      it('starts in editing mode by default', () => {
        const { view, cleanup: c } = createCriticMarkupEditor('hello', 5);
        cleanup = c;

        const isSuggestionMode = view.state.field(suggestionModeField);
        expect(isSuggestionMode).toBe(false);
      });

      it('can toggle to suggestion mode', () => {
        const { view, cleanup: c } = createCriticMarkupEditor('hello', 5);
        cleanup = c;

        view.dispatch({ effects: toggleSuggestionMode.of(true) });

        const isSuggestionMode = view.state.field(suggestionModeField);
        expect(isSuggestionMode).toBe(true);
      });

      it('can toggle back to editing mode', () => {
        const { view, cleanup: c } = createCriticMarkupEditor('hello', 5);
        cleanup = c;

        view.dispatch({ effects: toggleSuggestionMode.of(true) });
        view.dispatch({ effects: toggleSuggestionMode.of(false) });

        const isSuggestionMode = view.state.field(suggestionModeField);
        expect(isSuggestionMode).toBe(false);
      });
    });
  });
```

### Step 2: Run tests to verify they fail

Run: `npm test -- src/components/Editor/extensions/criticmarkup.test.ts`

Expected: FAIL - exports not found

### Step 3: Implement suggestion mode StateField

```typescript
// Add to src/components/Editor/extensions/criticmarkup.ts

import { StateField, StateEffect, RangeSetBuilder, EditorSelection } from '@codemirror/state';

export const toggleSuggestionMode = StateEffect.define<boolean>();

export const suggestionModeField = StateField.define<boolean>({
  create() {
    return false;
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(toggleSuggestionMode)) {
        return effect.value;
      }
    }
    return value;
  },
});

// Update criticMarkupExtension to include suggestionModeField
export function criticMarkupExtension() {
  return [criticMarkupField, suggestionModeField, criticMarkupPlugin];
}
```

### Step 4: Run tests to verify they pass

Run: `npm test -- src/components/Editor/extensions/criticmarkup.test.ts`

Expected: All tests PASS

### Step 5: Commit

```bash
jj describe -m "feat(criticmarkup): add suggestion mode StateField and toggle"
```

---

## Task 12: Suggestion Mode - Transaction Filter (Insertions)

**Files:**
- Modify: `src/components/Editor/extensions/criticmarkup.ts`
- Modify: `src/components/Editor/extensions/criticmarkup.test.ts`

### Step 1: Write failing tests for insertion wrapping

```typescript
// Add to criticmarkup.test.ts, inside describe('Suggestion Mode')

    describe('wrapping insertions', () => {
      it('wraps inserted text in addition markup when suggestion mode is ON', () => {
        const { view, cleanup: c } = createCriticMarkupEditor('hello', 5);
        cleanup = c;

        // Enable suggestion mode
        view.dispatch({ effects: toggleSuggestionMode.of(true) });

        // Insert text
        view.dispatch({
          changes: { from: 5, insert: ' world' },
        });

        const doc = view.state.doc.toString();
        expect(doc).toMatch(/\{\+\+.*@@ world\+\+\}/);
      });

      it('does NOT wrap insertions when suggestion mode is OFF', () => {
        const { view, cleanup: c } = createCriticMarkupEditor('hello', 5);
        cleanup = c;

        // Suggestion mode is OFF by default
        view.dispatch({
          changes: { from: 5, insert: ' world' },
        });

        const doc = view.state.doc.toString();
        expect(doc).toBe('hello world');
      });

      it('includes metadata in wrapped insertion', () => {
        const { view, cleanup: c } = createCriticMarkupEditor('hello', 5);
        cleanup = c;

        view.dispatch({ effects: toggleSuggestionMode.of(true) });
        view.dispatch({
          changes: { from: 5, insert: 'X' },
        });

        const doc = view.state.doc.toString();
        // Should have JSON metadata
        expect(doc).toMatch(/\{\+\+\{.*"author".*\}@@X\+\+\}/);
      });
    });
```

### Step 2: Run tests to verify they fail

Run: `npm test -- src/components/Editor/extensions/criticmarkup.test.ts`

Expected: FAIL - insertions not wrapped

### Step 3: Implement transaction filter for insertions

```typescript
// Add to src/components/Editor/extensions/criticmarkup.ts

import { EditorState, Transaction } from '@codemirror/state';
import type { ChangeSpec } from '@codemirror/state';

// Author context - can be set externally
let currentAuthor = 'anonymous';

export function setCurrentAuthor(author: string) {
  currentAuthor = author;
}

const suggestionModeFilter = EditorState.transactionFilter.of((tr: Transaction) => {
  // Only process document changes
  if (!tr.docChanged) return tr;

  // Only wrap when suggestion mode is ON
  if (!tr.startState.field(suggestionModeField)) return tr;

  const timestamp = Date.now();
  const meta = JSON.stringify({ author: currentAuthor, timestamp });

  const newChanges: ChangeSpec[] = [];

  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
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
        to: fromA,
        insert: `{++${meta}@@${added}++}`,
      });
    }
  });

  if (newChanges.length === 0) return tr;

  return {
    changes: newChanges,
    selection: tr.selection,
    effects: tr.effects,
  };
});

// Update extension to include filter
export function criticMarkupExtension() {
  return [
    criticMarkupField,
    suggestionModeField,
    suggestionModeFilter,
    criticMarkupPlugin,
  ];
}
```

### Step 4: Run tests to verify they pass

Run: `npm test -- src/components/Editor/extensions/criticmarkup.test.ts`

Expected: All tests PASS

### Step 5: Commit

```bash
jj describe -m "feat(criticmarkup): transaction filter wraps insertions in suggestion mode"
```

---

## Task 13: Suggestion Mode - Deletions and Substitutions

**Files:**
- Modify: `src/components/Editor/extensions/criticmarkup.test.ts`

### Step 1: Write tests for deletions and substitutions

```typescript
// Add to criticmarkup.test.ts, inside describe('Suggestion Mode')

    describe('wrapping deletions', () => {
      it('wraps deleted text in deletion markup', () => {
        const { view, cleanup: c } = createCriticMarkupEditor('hello world', 5);
        cleanup = c;

        view.dispatch({ effects: toggleSuggestionMode.of(true) });

        // Delete " world"
        view.dispatch({
          changes: { from: 5, to: 11, insert: '' },
        });

        const doc = view.state.doc.toString();
        expect(doc).toMatch(/\{--.*@@ world--\}/);
      });
    });

    describe('wrapping replacements', () => {
      it('wraps selection replacement in substitution markup', () => {
        const { view, cleanup: c } = createCriticMarkupEditor('hello world', 6);
        cleanup = c;

        view.dispatch({ effects: toggleSuggestionMode.of(true) });

        // Replace "world" with "there"
        view.dispatch({
          changes: { from: 6, to: 11, insert: 'there' },
        });

        const doc = view.state.doc.toString();
        expect(doc).toMatch(/\{~~.*@@world~>there~~\}/);
      });
    });
```

### Step 2: Run tests to verify they pass

Run: `npm test -- src/components/Editor/extensions/criticmarkup.test.ts`

Expected: All tests PASS (implementation already handles these cases)

### Step 3: Commit

```bash
jj describe -m "test(criticmarkup): verify deletion and substitution wrapping"
```

---

## Task 14: Suggestion Mode - Continuous Typing

**Files:**
- Modify: `src/components/Editor/extensions/criticmarkup.ts`
- Modify: `src/components/Editor/extensions/criticmarkup.test.ts`

### Step 1: Write failing test for continuous typing

```typescript
// Add to criticmarkup.test.ts, inside describe('wrapping insertions')

      it('continuous typing extends existing addition (not per-character)', () => {
        const { view, cleanup: c } = createCriticMarkupEditor('hello', 5);
        cleanup = c;

        view.dispatch({ effects: toggleSuggestionMode.of(true) });

        // Type 'h'
        view.dispatch({ changes: { from: 5, insert: 'h' } });

        // Get cursor position - should be inside the addition
        let cursorPos = view.state.selection.main.head;

        // Type 'i' at cursor position
        view.dispatch({ changes: { from: cursorPos, insert: 'i' } });

        const doc = view.state.doc.toString();

        // Should have ONE addition with "hi", not two separate ones
        const additionMatches = doc.match(/\{\+\+/g);
        expect(additionMatches?.length).toBe(1);
        expect(doc).toMatch(/@@hi\+\+\}/);
      });
```

### Step 2: Run test to verify it fails

Run: `npm test -- src/components/Editor/extensions/criticmarkup.test.ts`

Expected: FAIL - creates two separate additions

### Step 3: Update transaction filter to check if inside own addition

```typescript
// Update suggestionModeFilter in src/components/Editor/extensions/criticmarkup.ts

const suggestionModeFilter = EditorState.transactionFilter.of((tr: Transaction) => {
  if (!tr.docChanged) return tr;
  if (!tr.startState.field(suggestionModeField)) return tr;

  const cursorPos = tr.startState.selection.main.head;
  const ranges = tr.startState.field(criticMarkupField);

  // Check if cursor is inside an existing addition by the same author
  const insideOwnAddition = ranges.some((r) =>
    r.type === 'addition' &&
    r.metadata?.author === currentAuthor &&
    cursorPos > r.from && cursorPos < r.to
  );

  // If inside own addition, let the edit through without wrapping
  if (insideOwnAddition) {
    return tr;
  }

  // Otherwise, wrap the change
  const timestamp = Date.now();
  const meta = JSON.stringify({ author: currentAuthor, timestamp });

  const newChanges: ChangeSpec[] = [];

  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const deleted = tr.startState.doc.sliceString(fromA, toA);
    const added = inserted.toString();

    if (deleted && added) {
      newChanges.push({
        from: fromA,
        to: toA,
        insert: `{~~${meta}@@${deleted}~>${added}~~}`,
      });
    } else if (deleted) {
      newChanges.push({
        from: fromA,
        to: toA,
        insert: `{--${meta}@@${deleted}--}`,
      });
    } else if (added) {
      newChanges.push({
        from: fromA,
        to: fromA,
        insert: `{++${meta}@@${added}++}`,
      });
    }
  });

  if (newChanges.length === 0) return tr;

  // Calculate new cursor position: inside the wrapped content
  // For additions, cursor should be before ++}
  let newCursorPos: number | undefined;
  if (newChanges.length === 1) {
    const change = newChanges[0] as { from: number; to?: number; insert: string };
    if (change.insert.startsWith('{++')) {
      // Position cursor before ++} (end of insert minus 3)
      newCursorPos = change.from + change.insert.length - 3;
    }
  }

  return {
    changes: newChanges,
    selection: newCursorPos !== undefined
      ? EditorSelection.cursor(newCursorPos)
      : tr.selection,
    effects: tr.effects,
  };
});
```

### Step 4: Run tests to verify they pass

Run: `npm test -- src/components/Editor/extensions/criticmarkup.test.ts`

Expected: All tests PASS

### Step 5: Commit

```bash
jj describe -m "feat(criticmarkup): continuous typing extends existing addition"
```

---

## Task 15: Integration - Wire Extension to Editor

**Files:**
- Find and modify: Main editor component that creates EditorView
- This will depend on your actual codebase structure

### Step 1: Find editor setup

Run: `grep -r "EditorView" src/components/Editor --include="*.tsx" --include="*.ts" | head -5`

Look for where EditorView is created and extensions are passed.

### Step 2: Add CriticMarkup extension to editor

```typescript
// In the editor setup file, add:
import { criticMarkupExtension } from './extensions/criticmarkup';

// In the extensions array:
const extensions = [
  // ... existing extensions
  criticMarkupExtension(),
];
```

### Step 3: Verify manually

Run the dev server and test:
1. Type `{++test++}` - should show green highlighting
2. Type `{--removed--}` - should show red strikethrough
3. Move cursor in/out - delimiters should hide/show

### Step 4: Commit

```bash
jj describe -m "feat(criticmarkup): wire extension to main editor"
```

---

## Task 16: Suggestion Mode UI Toggle

**Files:**
- Create: `src/components/Editor/SuggestionModeToggle.tsx`
- Modify: Editor toolbar/header component (find actual file)

### Step 1: Find toolbar location

Run: `grep -r "toolbar\|header\|EditorHeader" src/components --include="*.tsx" | head -10`

Look for where editor controls (like view mode toggles) are rendered.

### Step 2: Create toggle component

```typescript
// src/components/Editor/SuggestionModeToggle.tsx
import { EditorView } from '@codemirror/view';
import { toggleSuggestionMode, suggestionModeField } from './extensions/criticmarkup';

interface SuggestionModeToggleProps {
  view: EditorView | null;
}

export function SuggestionModeToggle({ view }: SuggestionModeToggleProps) {
  if (!view) return null;

  const isSuggestionMode = view.state.field(suggestionModeField);

  const handleToggle = () => {
    view.dispatch({
      effects: toggleSuggestionMode.of(!isSuggestionMode),
    });
  };

  return (
    <button
      onClick={handleToggle}
      className={`px-3 py-1 text-sm rounded ${
        isSuggestionMode
          ? 'bg-blue-500 text-white'
          : 'bg-gray-200 text-gray-700'
      }`}
      title={isSuggestionMode ? 'Switch to Editing mode' : 'Switch to Suggesting mode'}
    >
      {isSuggestionMode ? 'Suggesting' : 'Editing'}
    </button>
  );
}
```

### Step 3: Add to editor toolbar

```typescript
// In the toolbar/header component, add:
import { SuggestionModeToggle } from './SuggestionModeToggle';

// Where the view ref is available:
<SuggestionModeToggle view={editorView} />
```

### Step 4: Test manually

1. Toggle should switch between "Editing" and "Suggesting"
2. In Suggesting mode, typing should wrap text in `{++...++}`
3. In Editing mode, typing should be normal

### Step 5: Commit

```bash
jj describe -m "feat(criticmarkup): add suggestion mode toggle button"
```

---

## Summary

This plan covers:

1. **Tasks 1-6**: Parser implementation with TDD (pure functions, no DOM)
2. **Tasks 7-9**: CodeMirror StateField and decorations with Happy DOM tests
3. **Task 10**: Accept/Reject pure functions
4. **Tasks 11-14**: Suggestion mode with transaction filter
5. **Task 15**: Integration with main editor
6. **Task 16**: Suggestion mode UI toggle button

**Test commands:**
- Parser only: `npm test -- src/lib/criticmarkup-parser.test.ts`
- Actions only: `npm test -- src/lib/criticmarkup-actions.test.ts`
- Extension: `npm test -- src/components/Editor/extensions/criticmarkup.test.ts`
- All: `npm test`

**Future phases** (not in this plan):
- Comments Panel (React component)
- Gutter markers
- Accept/Reject commands and UI
- Context menu integration
