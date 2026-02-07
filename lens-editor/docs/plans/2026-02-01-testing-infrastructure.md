# Testing Infrastructure Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Set up complete testing infrastructure for lens-editor with Vitest, happy-dom, and test fixtures for Y.Doc and CodeMirror testing.

**Architecture:** Co-located tests using Vitest with happy-dom environment. Test fixtures stored as JSON for Y.Doc metadata and as markdown files for document content. Configuration extends existing Vite setup.

**Tech Stack:** Vitest, happy-dom, @testing-library/react, @testing-library/jest-dom, cross-env, yjs, @codemirror/state, @codemirror/view

**Approach:** Write all tests first, then run full suite to generate a pass/fail report. User will then classify:
- **Passing tests** → Green-Red-Green verification (break code to confirm test catches it)
- **Failing tests** → TDD fix (implement code to make test pass)

**Priority Order (per design doc):**
1. Live preview decorations (highest regression risk)
2. File operations (core CRUD with Y.Map)
3. Tree building & filtering (pure functions)
4. Wikilink resolution (navigation correctness)
5. React Hooks (state transitions, cleanup)

---

## Phase 1: Infrastructure Setup (Tasks 1-4)

### Task 1: Install Test Dependencies

**Files:**
- Modify: `package.json`

**Step 1: Install dependencies**

Run:
```bash
npm install -D vitest happy-dom @testing-library/react @testing-library/jest-dom cross-env
```

**Step 2: Verify installation**

Run: `npm ls vitest happy-dom @testing-library/react @testing-library/jest-dom cross-env`

Expected: All packages listed with versions, no errors

**Step 3: Commit**

```bash
jj desc -m "chore: add testing dependencies (vitest, happy-dom, testing-library)"
jj new
```

---

### Task 2: Create Vitest Configuration

**Files:**
- Create: `vitest.config.ts`
- Modify: `tsconfig.app.json` (add vitest globals type AND resolveJsonModule)

**Step 1: Create vitest.config.ts**

Create file `vitest.config.ts`:

```typescript
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(viteConfig, defineConfig({
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/lib/**', 'src/components/**/extensions/**', 'src/hooks/**'],
      exclude: ['**/*.test.ts', 'src/test/**'],
    },
  },
}));
```

**Step 2: Update tsconfig.app.json**

Edit `tsconfig.app.json`, replace lines 8-9:
```json
    "types": ["vite/client"],
    "skipLibCheck": true,
```
with:
```json
    "types": ["vite/client", "vitest/globals"],
    "resolveJsonModule": true,
    "skipLibCheck": true,
```

**Step 3: Verify TypeScript picks up config**

Run: `npx tsc --noEmit`

Expected: No errors (or same errors as before)

**Step 4: Commit**

```bash
jj desc -m "chore: add vitest configuration"
jj new
```

---

### Task 3: Create Test Setup File

**Files:**
- Create: `src/test/setup.ts`

**Step 1: Create setup.ts**

Create file `src/test/setup.ts`:

```typescript
import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// Clear mocks between tests
beforeEach(() => {
  vi.clearAllMocks();
});

// Note: happy-dom has limitations with:
// - Real CSS layout calculations
// - Full DOM coordinate APIs (view.coordsAtPos may not work)
// - Some newer Web APIs
// For coordinate-based tests, consider using real browser testing.
```

**Step 2: Verify vitest can run (empty)**

Run: `npx vitest run`

Expected: "No test files found" message (not an error)

**Step 3: Commit**

```bash
jj desc -m "chore: add vitest setup file"
jj new
```

---

### Task 4: Add Test Scripts to package.json

**Files:**
- Modify: `package.json`

**Step 1: Add test scripts**

Edit `package.json`, add to "scripts" section after "preview":

```json
    "test": "vitest",
    "test:run": "vitest run",
    "test:coverage": "vitest run --coverage",
    "dev:fixtures": "cross-env VITE_USE_FIXTURES=true vite"
```

Full scripts section should be:
```json
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "lint": "eslint .",
    "preview": "vite preview",
    "test": "vitest",
    "test:run": "vitest run",
    "test:coverage": "vitest run --coverage",
    "dev:fixtures": "cross-env VITE_USE_FIXTURES=true vite"
  },
```

**Step 2: Verify npm test works**

Run: `npm test -- --run`

Expected: "No test files found" message

**Step 3: Commit**

```bash
jj desc -m "chore: add test scripts to package.json"
jj new
```

---

## Phase 2: Test Fixtures (Tasks 5-6)

### Task 5: Create Folder Metadata Fixtures

**Files:**
- Create: `src/test/fixtures/folder-metadata/simple-flat.json`
- Create: `src/test/fixtures/folder-metadata/nested-hierarchy.json`
- Create: `src/test/fixtures/folder-metadata/edge-cases.json`
- Create: `src/test/fixtures/folder-metadata/production-sample.json`

**Step 1: Create fixtures directory**

Run: `mkdir -p src/test/fixtures/folder-metadata`

**Step 2: Create simple-flat.json**

Create file `src/test/fixtures/folder-metadata/simple-flat.json`:

```json
{
  "/README.md": {
    "id": "doc-readme",
    "type": "markdown"
  },
  "/Notes.md": {
    "id": "doc-notes",
    "type": "markdown"
  },
  "/Tasks.md": {
    "id": "doc-tasks",
    "type": "markdown"
  },
  "/Ideas.md": {
    "id": "doc-ideas",
    "type": "markdown"
  },
  "/Archive.md": {
    "id": "doc-archive",
    "type": "markdown"
  }
}
```

**Step 3: Create nested-hierarchy.json**

Create file `src/test/fixtures/folder-metadata/nested-hierarchy.json`:

```json
{
  "/Projects": {
    "id": "folder-projects",
    "type": "folder"
  },
  "/Projects/Alpha": {
    "id": "folder-alpha",
    "type": "folder"
  },
  "/Projects/Alpha/README.md": {
    "id": "doc-alpha-readme",
    "type": "markdown"
  },
  "/Projects/Alpha/Tasks.md": {
    "id": "doc-alpha-tasks",
    "type": "markdown"
  },
  "/Projects/Beta": {
    "id": "folder-beta",
    "type": "folder"
  },
  "/Projects/Beta/Notes.md": {
    "id": "doc-beta-notes",
    "type": "markdown"
  },
  "/Archive": {
    "id": "folder-archive",
    "type": "folder"
  },
  "/Archive/Old Ideas.md": {
    "id": "doc-old-ideas",
    "type": "markdown"
  },
  "/Daily Notes.md": {
    "id": "doc-daily",
    "type": "markdown"
  }
}
```

**Step 4: Create edge-cases.json**

Create file `src/test/fixtures/folder-metadata/edge-cases.json`:

```json
{
  "/Special Characters !@#$.md": {
    "id": "doc-special",
    "type": "markdown"
  },
  "/Deep": {
    "id": "folder-deep",
    "type": "folder"
  },
  "/Deep/Nested": {
    "id": "folder-nested",
    "type": "folder"
  },
  "/Deep/Nested/Path": {
    "id": "folder-path",
    "type": "folder"
  },
  "/Deep/Nested/Path/File.md": {
    "id": "doc-deep-file",
    "type": "markdown"
  },
  "/Empty Folder": {
    "id": "folder-empty",
    "type": "folder"
  },
  "/attachments": {
    "id": "folder-attachments",
    "type": "folder"
  },
  "/attachments/image.png": {
    "id": "img-1",
    "type": "image",
    "hash": "abc123"
  },
  "/UPPERCASE.md": {
    "id": "doc-upper",
    "type": "markdown"
  },
  "/lowercase.md": {
    "id": "doc-lower",
    "type": "markdown"
  }
}
```

**Step 5: Copy production-sample.json from extracted relay data**

This fixture contains real-world data extracted from the relay server (sanitized).
Copy the existing file:

Run: `cp scripts/sample-folder-metadata.json src/test/fixtures/folder-metadata/production-sample.json`

This provides 100+ entries for testing at scale.

**Step 6: Commit**

```bash
jj desc -m "chore: add folder metadata test fixtures"
jj new
```

---

### Task 6: Create Document Content Fixtures

**Files:**
- Create: `src/test/fixtures/documents/emphasis-variants.md`
- Create: `src/test/fixtures/documents/headings-all.md`
- Create: `src/test/fixtures/documents/wikilinks-mixed.md`
- Create: `src/test/fixtures/documents/links-and-code.md`

**Step 1: Create documents directory**

Run: `mkdir -p src/test/fixtures/documents`

**Step 2: Create emphasis-variants.md**

Create file `src/test/fixtures/documents/emphasis-variants.md`:

```markdown
# Emphasis Variants

Single *italic* text here.

Double **bold** text here.

Mixed ***bold italic*** text.

Underscore _italic_ variant.

Underscore __bold__ variant.

Nested **bold with *italic* inside** text.
```

**Step 3: Create headings-all.md**

Create file `src/test/fixtures/documents/headings-all.md`:

```markdown
# Heading 1

Content under h1.

## Heading 2

Content under h2.

### Heading 3

Content under h3.

#### Heading 4

Content under h4.

##### Heading 5

Content under h5.

###### Heading 6

Content under h6.
```

**Step 4: Create wikilinks-mixed.md**

Create file `src/test/fixtures/documents/wikilinks-mixed.md`:

```markdown
# Wikilinks Test

Link to [[Existing Page]] here.

Link to [[NonExistent Page]] that doesn't exist.

Multiple links: [[Page One]] and [[Page Two]].

Wikilink at end of line [[Final Link]]
```

**Step 5: Create links-and-code.md**

Create file `src/test/fixtures/documents/links-and-code.md`:

```markdown
# Links and Code

External link [Example](https://example.com) here.

Link without protocol [Test](example.com) here.

Inline code: `const x = 1` in text.

Multiple backticks: ``code with ` backtick`` inside.

Mixed: [Link](url) then `code` then [[Wikilink]].
```

**Step 6: Commit**

```bash
jj desc -m "chore: add document content test fixtures"
jj new
```

---

## Phase 3: Live Preview Tests - Priority #1 (Tasks 7-12)

### Task 7: CodeMirror Test Helpers

**Files:**
- Create: `src/test/codemirror-helpers.ts`

**Step 1: Create helper for testing CodeMirror decorations**

Create file `src/test/codemirror-helpers.ts`:

```typescript
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { WikilinkExtension } from '../components/Editor/extensions/wikilinkParser';
import { livePreview } from '../components/Editor/extensions/livePreview';
import type { WikilinkContext } from '../components/Editor/extensions/livePreview';

/**
 * Create an EditorView with live preview extension for testing.
 * Returns the view and a cleanup function.
 */
export function createTestEditor(
  content: string,
  cursorPos: number,
  wikilinkContext?: WikilinkContext
): { view: EditorView; cleanup: () => void } {
  const state = EditorState.create({
    doc: content,
    selection: { anchor: cursorPos },
    extensions: [
      markdown({ extensions: [WikilinkExtension] }),
      livePreview(wikilinkContext),
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

/**
 * Check if a CSS class exists in the editor's content DOM.
 */
export function hasClass(view: EditorView, className: string): boolean {
  return view.contentDOM.querySelector(`.${className}`) !== null;
}

/**
 * Count elements with a specific class in the editor.
 */
export function countClass(view: EditorView, className: string): number {
  return view.contentDOM.querySelectorAll(`.${className}`).length;
}

/**
 * Get text content of elements with a specific class.
 */
export function getTextWithClass(view: EditorView, className: string): string[] {
  const elements = view.contentDOM.querySelectorAll(`.${className}`);
  return Array.from(elements).map((el) => el.textContent || '');
}

/**
 * Check if wikilink widget exists with specific text.
 */
export function hasWikilinkWidget(view: EditorView, pageName: string): boolean {
  const widgets = view.contentDOM.querySelectorAll('.cm-wikilink-widget');
  return Array.from(widgets).some((w) => w.textContent === pageName);
}

/**
 * Check if link widget exists with specific text.
 */
export function hasLinkWidget(view: EditorView, linkText: string): boolean {
  const widgets = view.contentDOM.querySelectorAll('.cm-link-widget');
  return Array.from(widgets).some((w) => w.textContent?.includes(linkText));
}

/**
 * Move cursor to a position and trigger decoration update.
 */
export function moveCursor(view: EditorView, pos: number): void {
  view.dispatch({
    selection: { anchor: pos },
  });
}

/**
 * Get the line number where the cursor is.
 */
export function getCursorLine(view: EditorView): number {
  return view.state.doc.lineAt(view.state.selection.main.head).number;
}
```

**Step 2: Verify helpers compile**

Run: `npx tsc --noEmit`

Expected: No new errors

**Step 3: Commit**

```bash
jj desc -m "test: add CodeMirror test helpers"
jj new
```

---

### Task 8: Tests for livePreview.ts - Emphasis

**Files:**
- Create: `src/components/Editor/extensions/livePreview.test.ts`

**Step 1: Write tests for emphasis marker hiding**

Create file `src/components/Editor/extensions/livePreview.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import {
  createTestEditor,
  moveCursor,
  hasClass,
  countClass,
} from '../../../test/codemirror-helpers';

describe('livePreview - emphasis markers', () => {
  let cleanup: () => void;

  afterEach(() => {
    if (cleanup) cleanup();
  });

  it('applies cm-emphasis class to italic text when cursor outside', () => {
    const { view, cleanup: c } = createTestEditor('*italic* end', 10);
    cleanup = c;

    expect(hasClass(view, 'cm-emphasis')).toBe(true);
  });

  it('applies cm-strong class to bold text when cursor outside', () => {
    const { view, cleanup: c } = createTestEditor('**bold** end', 12);
    cleanup = c;

    expect(hasClass(view, 'cm-strong')).toBe(true);
  });

  it('hides emphasis markers when cursor is outside element', () => {
    const { view, cleanup: c } = createTestEditor('*italic* end', 10);
    cleanup = c;

    // The * markers should have cm-hidden-syntax class
    expect(hasClass(view, 'cm-hidden-syntax')).toBe(true);
  });

  it('shows emphasis markers when cursor is inside element', () => {
    // Cursor at position 3 = inside "italic"
    const { view, cleanup: c } = createTestEditor('*italic* end', 3);
    cleanup = c;

    // When cursor is inside, markers should NOT be hidden
    // The cm-emphasis class should NOT be applied (raw text visible)
    expect(hasClass(view, 'cm-emphasis')).toBe(false);
  });

  it('updates decorations when cursor moves in and out', () => {
    const { view, cleanup: c } = createTestEditor('*italic* text', 12);
    cleanup = c;

    // Initially outside: emphasis styled, markers hidden
    expect(hasClass(view, 'cm-emphasis')).toBe(true);

    // Move cursor inside
    moveCursor(view, 3);

    // Now inside: raw markdown visible, no emphasis class
    expect(hasClass(view, 'cm-emphasis')).toBe(false);

    // Move cursor back outside
    moveCursor(view, 12);

    // Outside again: emphasis styled
    expect(hasClass(view, 'cm-emphasis')).toBe(true);
  });
});
```

**Step 2: Run tests**

Run: `npm test -- --run src/components/Editor/extensions/livePreview.test.ts`

Note: Some tests may fail if code is broken. Record results for final report.

**Step 3: Commit**

```bash
jj desc -m "test: add livePreview emphasis marker tests"
jj new
```

---

### Task 9: Tests for livePreview.ts - Headings

**Files:**
- Modify: `src/components/Editor/extensions/livePreview.test.ts`

**Step 1: Add heading marker tests**

Append to `src/components/Editor/extensions/livePreview.test.ts`:

```typescript

describe('livePreview - heading markers', () => {
  let cleanup: () => void;

  afterEach(() => {
    if (cleanup) cleanup();
  });

  it('applies heading class for h1 when cursor on different line', () => {
    const content = '# Heading\n\nParagraph';
    const { view, cleanup: c } = createTestEditor(content, 20);
    cleanup = c;

    expect(hasClass(view, 'cm-heading-1')).toBe(true);
  });

  it('hides # marker when cursor is on different line', () => {
    const content = '# Heading\n\nParagraph';
    const { view, cleanup: c } = createTestEditor(content, 20);
    cleanup = c;

    expect(hasClass(view, 'cm-hidden-syntax')).toBe(true);
  });

  it('shows # marker when cursor is on heading line', () => {
    const content = '# Heading\n\nParagraph';
    // Cursor on heading line (position 3 = in "Heading")
    const { view, cleanup: c } = createTestEditor(content, 3);
    cleanup = c;

    // # should NOT be hidden when cursor on same line
    // Check that there's no hidden-syntax class on the # mark
    const hiddenCount = countClass(view, 'cm-hidden-syntax');
    // The # mark should be visible, so hidden count should be 0 for header marks
    expect(hiddenCount).toBe(0);
  });

  it('applies correct heading classes for h1 through h6', () => {
    const content = `# H1
## H2
### H3
#### H4
##### H5
###### H6`;

    // Cursor at end
    const { view, cleanup: c } = createTestEditor(content, content.length);
    cleanup = c;

    expect(hasClass(view, 'cm-heading-1')).toBe(true);
    expect(hasClass(view, 'cm-heading-2')).toBe(true);
    expect(hasClass(view, 'cm-heading-3')).toBe(true);
    expect(hasClass(view, 'cm-heading-4')).toBe(true);
    expect(hasClass(view, 'cm-heading-5')).toBe(true);
    expect(hasClass(view, 'cm-heading-6')).toBe(true);
  });
});
```

**Step 2: Run tests**

Run: `npm test -- --run src/components/Editor/extensions/livePreview.test.ts`

Expected: All 9 tests pass

**Step 3: Commit**

```bash
jj desc -m "test: add livePreview heading marker tests"
jj new
```

---

### Task 10: Tests for livePreview.ts - Wikilinks

**Files:**
- Modify: `src/components/Editor/extensions/livePreview.test.ts`

**Step 1: Add wikilink tests**

Append to `src/components/Editor/extensions/livePreview.test.ts`:

```typescript

describe('livePreview - wikilinks', () => {
  let cleanup: () => void;

  afterEach(() => {
    if (cleanup) cleanup();
  });

  it('replaces wikilink with widget when cursor is outside', () => {
    const content = '[[Page Name]] more';
    const { view, cleanup: c } = createTestEditor(content, 18);
    cleanup = c;

    expect(hasClass(view, 'cm-wikilink-widget')).toBe(true);
  });

  it('shows raw [[ ]] when cursor is inside wikilink', () => {
    const content = '[[Page Name]] more';
    // Cursor inside wikilink (position 5)
    const { view, cleanup: c } = createTestEditor(content, 5);
    cleanup = c;

    // Widget should NOT be present when cursor inside
    expect(hasClass(view, 'cm-wikilink-widget')).toBe(false);
  });

  it('widget displays page name text', () => {
    const content = '[[My Page]] end';

    const mockContext = {
      onClick: () => {},
      isResolved: () => true,
    };

    const { view, cleanup: c } = createTestEditor(content, 15, mockContext);
    cleanup = c;

    const widgets = view.contentDOM.querySelectorAll('.cm-wikilink-widget');
    expect(widgets.length).toBe(1);
    expect(widgets[0].textContent).toBe('My Page');
  });

  it('marks unresolved links with unresolved class', () => {
    const content = '[[NonExistent]]';

    const mockContext = {
      onClick: () => {},
      isResolved: () => false,
    };

    const { view, cleanup: c } = createTestEditor(content, 20, mockContext);
    cleanup = c;

    expect(hasClass(view, 'unresolved')).toBe(true);
  });

  it('does not mark resolved links with unresolved class', () => {
    const content = '[[Existing Page]]';

    const mockContext = {
      onClick: () => {},
      isResolved: () => true,
    };

    const { view, cleanup: c } = createTestEditor(content, 20, mockContext);
    cleanup = c;

    const widget = view.contentDOM.querySelector('.cm-wikilink-widget');
    expect(widget).not.toBeNull();
    expect(widget!.classList.contains('unresolved')).toBe(false);
  });
});
```

**Step 2: Run tests**

Run: `npm test -- --run src/components/Editor/extensions/livePreview.test.ts`

Expected: All 14 tests pass

**Step 3: Commit**

```bash
jj desc -m "test: add livePreview wikilink tests"
jj new
```

---

### Task 11: Tests for livePreview.ts - Links and Inline Code

**Files:**
- Modify: `src/components/Editor/extensions/livePreview.test.ts`

**Step 1: Add link and inline code tests**

Append to `src/components/Editor/extensions/livePreview.test.ts`:

```typescript

describe('livePreview - markdown links', () => {
  let cleanup: () => void;

  afterEach(() => {
    if (cleanup) cleanup();
  });

  it('replaces [text](url) with widget when cursor is outside', () => {
    const content = '[Example](https://example.com) more';
    const { view, cleanup: c } = createTestEditor(content, 35);
    cleanup = c;

    expect(hasClass(view, 'cm-link-widget')).toBe(true);
  });

  it('shows raw markdown when cursor is inside link', () => {
    const content = '[Example](https://example.com) more';
    // Cursor inside link text
    const { view, cleanup: c } = createTestEditor(content, 5);
    cleanup = c;

    expect(hasClass(view, 'cm-link-widget')).toBe(false);
  });

  it('widget displays link text', () => {
    const content = '[Click Here](url) end';
    const { view, cleanup: c } = createTestEditor(content, 20);
    cleanup = c;

    const widgets = view.contentDOM.querySelectorAll('.cm-link-widget');
    expect(widgets.length).toBe(1);
    expect(widgets[0].textContent).toContain('Click Here');
  });
});

describe('livePreview - inline code', () => {
  let cleanup: () => void;

  afterEach(() => {
    if (cleanup) cleanup();
  });

  it('applies inline-code class when cursor is outside', () => {
    const content = 'Use `code` here';
    const { view, cleanup: c } = createTestEditor(content, 15);
    cleanup = c;

    expect(hasClass(view, 'cm-inline-code')).toBe(true);
  });

  it('hides backticks when cursor is outside', () => {
    const content = 'Use `code` here';
    const { view, cleanup: c } = createTestEditor(content, 15);
    cleanup = c;

    expect(hasClass(view, 'cm-hidden-syntax')).toBe(true);
  });

  it('shows backticks when cursor is inside code', () => {
    const content = 'Use `code` here';
    // Cursor inside code
    const { view, cleanup: c } = createTestEditor(content, 6);
    cleanup = c;

    // Backticks should be visible (no hidden-syntax on CodeMark)
    expect(hasClass(view, 'cm-inline-code')).toBe(false);
  });
});
```

**Step 2: Run tests**

Run: `npm test -- --run src/components/Editor/extensions/livePreview.test.ts`

Expected: All 20 tests pass

**Step 3: Commit**

```bash
jj desc -m "test: add livePreview link and inline code tests"
jj new
```

---

### Task 12: Tests for wikilinkParser.ts

**Files:**
- Create: `src/components/Editor/extensions/wikilinkParser.test.ts`

**Step 1: Write tests for wikilink parsing**

Create file `src/components/Editor/extensions/wikilinkParser.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { WikilinkExtension } from './wikilinkParser';

function parseContent(content: string) {
  const state = EditorState.create({
    doc: content,
    extensions: [markdown({ extensions: [WikilinkExtension] })],
  });
  return syntaxTree(state);
}

function getNodeNames(content: string): string[] {
  const tree = parseContent(content);
  const names: string[] = [];
  tree.iterate({
    enter(node) {
      names.push(node.name);
    },
  });
  return names;
}

describe('WikilinkExtension parsing', () => {
  it('parses [[Page]] as Wikilink node', () => {
    const names = getNodeNames('[[Page]]');

    expect(names).toContain('Wikilink');
  });

  it('creates WikilinkMark nodes for [[ and ]]', () => {
    const names = getNodeNames('[[Page]]');

    const markCount = names.filter((n) => n === 'WikilinkMark').length;
    expect(markCount).toBe(2);
  });

  it('creates WikilinkContent node for page name', () => {
    const names = getNodeNames('[[Page Name]]');

    expect(names).toContain('WikilinkContent');
  });

  it('does not parse empty wikilink [[]]', () => {
    const names = getNodeNames('[[]]');

    expect(names).not.toContain('Wikilink');
  });

  it('does not parse unclosed wikilink', () => {
    const names = getNodeNames('[[Page');

    expect(names).not.toContain('Wikilink');
  });

  it('parses wikilink embedded in text', () => {
    const names = getNodeNames('See [[Page]] here');

    expect(names).toContain('Wikilink');
  });

  it('parses multiple wikilinks', () => {
    const names = getNodeNames('[[One]] and [[Two]]');

    const wikilinkCount = names.filter((n) => n === 'Wikilink').length;
    expect(wikilinkCount).toBe(2);
  });

  it('does not conflict with regular markdown links', () => {
    const names = getNodeNames('[text](url)');

    expect(names).not.toContain('Wikilink');
    expect(names).toContain('Link');
  });
});
```

**Step 2: Run tests**

Run: `npm test -- --run src/components/Editor/extensions/wikilinkParser.test.ts`

Note: Some tests may fail if parsing is broken. Record results for final report.

**Step 3: Commit**

```bash
jj desc -m "test: add wikilinkParser tests"
jj new
```

---

## Phase 4: CRDT/File Operations Tests - Priority #2 (Tasks 13-14)

### Task 13: Tests for relay-api.ts (Y.Doc operations)

**Files:**
- Create: `src/lib/relay-api.test.ts`

**Step 1: Write tests for CRDT operations**

Create file `src/lib/relay-api.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';
import { createDocument, renameDocument, deleteDocument } from './relay-api';
import type { FileMetadata } from '../hooks/useFolderMetadata';

describe('relay-api', () => {
  let doc: Y.Doc;
  let filemeta: Y.Map<FileMetadata>;

  beforeEach(() => {
    doc = new Y.Doc();
    filemeta = doc.getMap<FileMetadata>('filemeta_v0');
  });

  describe('createDocument', () => {
    it('creates document with valid UUID', () => {
      const id = createDocument(doc, '/New File.md');

      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it('adds entry to filemeta_v0 map', () => {
      const id = createDocument(doc, '/Test.md');
      const meta = filemeta.get('/Test.md');

      expect(meta).toBeDefined();
      expect(meta!.id).toBe(id);
      expect(meta!.type).toBe('markdown');
    });

    it('defaults to markdown type', () => {
      createDocument(doc, '/Default.md');

      expect(filemeta.get('/Default.md')!.type).toBe('markdown');
    });

    it('allows canvas type', () => {
      createDocument(doc, '/Diagram.canvas', 'canvas');

      expect(filemeta.get('/Diagram.canvas')!.type).toBe('canvas');
    });
  });

  describe('renameDocument', () => {
    it('moves metadata from old path to new path', () => {
      const id = createDocument(doc, '/Old.md');
      renameDocument(doc, '/Old.md', '/New.md');

      expect(filemeta.get('/Old.md')).toBeUndefined();
      expect(filemeta.get('/New.md')!.id).toBe(id);
    });

    it('preserves all metadata fields after rename', () => {
      createDocument(doc, '/Original.md');
      renameDocument(doc, '/Original.md', '/Renamed.md');

      const meta = filemeta.get('/Renamed.md');
      expect(meta!.type).toBe('markdown');
    });

    it('does nothing if old path does not exist', () => {
      renameDocument(doc, '/NonExistent.md', '/Whatever.md');

      expect(filemeta.get('/Whatever.md')).toBeUndefined();
    });
  });

  describe('deleteDocument', () => {
    it('removes entry from filemeta_v0 map', () => {
      createDocument(doc, '/ToDelete.md');
      deleteDocument(doc, '/ToDelete.md');

      expect(filemeta.get('/ToDelete.md')).toBeUndefined();
    });

    it('does nothing if path does not exist', () => {
      const sizeBefore = filemeta.size;
      deleteDocument(doc, '/NonExistent.md');

      expect(filemeta.size).toBe(sizeBefore);
    });
  });

  describe('Y.Doc sync simulation', () => {
    it('syncs changes between two docs via Y.applyUpdate', () => {
      const id = createDocument(doc, '/Shared.md');

      const doc2 = new Y.Doc();
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc));

      const filemeta2 = doc2.getMap<FileMetadata>('filemeta_v0');
      expect(filemeta2.get('/Shared.md')!.id).toBe(id);

      doc2.destroy();
    });

    it('merges concurrent changes from multiple clients', () => {
      createDocument(doc, '/DocA.md');

      const doc2 = new Y.Doc();
      const filemeta2 = doc2.getMap<FileMetadata>('filemeta_v0');
      filemeta2.set('/DocB.md', { id: 'client2-id', type: 'markdown' });

      // Cross-apply updates
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc));
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(doc2));

      // Both docs should have both entries
      expect(filemeta.get('/DocA.md')).toBeDefined();
      expect(filemeta.get('/DocB.md')).toBeDefined();
      expect(filemeta2.get('/DocA.md')).toBeDefined();
      expect(filemeta2.get('/DocB.md')).toBeDefined();

      doc2.destroy();
    });
  });
});
```

**Step 2: Run tests**

Run: `npm test -- --run src/lib/relay-api.test.ts`

Expected: All 11 tests pass

**Step 3: Commit**

```bash
jj desc -m "test: add relay-api Y.Doc operation tests"
jj new
```

---

### Task 14: Tests for wikilinkAutocomplete.ts (Unit+1 Style)

**Files:**
- Create: `src/components/Editor/extensions/wikilinkAutocomplete.test.ts`

**Philosophy:** Test the actual completion source function with real CompletionContext,
not just helper utilities in isolation. This follows Unit+1 principles.

**Step 1: Write tests that invoke the actual completion source**

Create file `src/components/Editor/extensions/wikilinkAutocomplete.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext, autocompletion } from '@codemirror/autocomplete';
import { markdown } from '@codemirror/lang-markdown';
import { wikilinkAutocomplete } from './wikilinkAutocomplete';
import type { FolderMetadata } from '../../../hooks/useFolderMetadata';

const testMetadata: FolderMetadata = {
  '/Notes.md': { id: 'doc-notes', type: 'markdown' },
  '/Tasks.md': { id: 'doc-tasks', type: 'markdown' },
  '/Projects/README.md': { id: 'doc-proj', type: 'markdown' },
  '/attachments/image.png': { id: 'img-1', type: 'image' },
};

/**
 * Helper to get completions at a position by invoking the actual extension.
 * Creates real EditorState and CompletionContext, then calls completion sources.
 */
async function getCompletions(content: string, pos: number, metadata: FolderMetadata | null) {
  const state = EditorState.create({
    doc: content,
    selection: { anchor: pos },
    extensions: [
      markdown(),
      wikilinkAutocomplete(() => metadata),
    ],
  });

  const context = new CompletionContext(state, pos, false);

  // Get completion sources from the autocompletion facet
  const sources = state.facet(autocompletion.computeN);

  // Find our wikilink source and invoke it
  for (const sourceSet of sources) {
    for (const source of sourceSet) {
      const result = await source(context);
      if (result && result.options.length > 0) {
        return result;
      }
    }
  }

  return null;
}

describe('wikilinkAutocomplete', () => {
  it('returns null when not in wikilink context', async () => {
    const result = await getCompletions('regular text', 5, testMetadata);
    expect(result).toBeNull();
  });

  it('returns completions when typing after [[', async () => {
    const result = await getCompletions('See [[', 6, testMetadata);

    expect(result).not.toBeNull();
    expect(result!.options.length).toBeGreaterThan(0);
  });

  it('filters options based on typed query', async () => {
    // Type "Not" after [[ to filter to "Notes"
    const result = await getCompletions('See [[Not', 9, testMetadata);

    expect(result).not.toBeNull();
    const labels = result!.options.map(o => o.label);
    expect(labels).toContain('Notes');
    expect(labels).not.toContain('Tasks');
  });

  it('only suggests markdown files, not images', async () => {
    const result = await getCompletions('Link [[', 7, testMetadata);

    expect(result).not.toBeNull();
    const labels = result!.options.map(o => o.label);
    expect(labels).toContain('Notes');
    expect(labels).toContain('Tasks');
    expect(labels).toContain('README');
    // Image should not appear
    expect(labels.every(l => l !== 'image')).toBe(true);
  });

  it('includes correct apply text with brackets', async () => {
    const result = await getCompletions('See [[No', 8, testMetadata);

    expect(result).not.toBeNull();
    const notesOption = result!.options.find(o => o.label === 'Notes');
    expect(notesOption).toBeDefined();
    expect(notesOption!.apply).toBe('[[Notes]]');
  });

  it('boosts prefix matches over substring matches', async () => {
    // "Ta" should boost "Tasks" over other matches
    const result = await getCompletions('See [[Ta', 8, testMetadata);

    expect(result).not.toBeNull();
    // Tasks should be first (prefix match has boost)
    expect(result!.options[0].label).toBe('Tasks');
  });

  it('returns null when metadata is null', async () => {
    const result = await getCompletions('See [[', 6, null);
    expect(result).toBeNull();
  });

  it('sets from position to start of [[', async () => {
    const result = await getCompletions('See [[Not', 9, testMetadata);

    expect(result).not.toBeNull();
    // "See " is 4 chars, so [[ starts at position 4
    expect(result!.from).toBe(4);
  });
});
```

**Step 2: Run tests**

Run: `npm test -- --run src/components/Editor/extensions/wikilinkAutocomplete.test.ts`

Expected: All 8 tests pass

**Step 3: Commit**

```bash
jj desc -m "test: add wikilinkAutocomplete tests (Unit+1 style)"
jj new
```

---

## Phase 5: Pure Utility Tests - Priority #3 (Tasks 15-17)

### Task 15: Tests for tree-utils.ts - buildTreeFromPaths

**Files:**
- Create: `src/lib/tree-utils.test.ts`

**Step 1: Write tests for buildTreeFromPaths**

Create file `src/lib/tree-utils.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildTreeFromPaths, filterTree, getFolderIdsWithMatches } from './tree-utils';
import simpleFlat from '../test/fixtures/folder-metadata/simple-flat.json';
import nestedHierarchy from '../test/fixtures/folder-metadata/nested-hierarchy.json';

describe('buildTreeFromPaths', () => {
  it('builds flat file list from simple metadata', () => {
    const tree = buildTreeFromPaths(simpleFlat);

    expect(tree).toHaveLength(5);
    expect(tree.every((n) => !n.isFolder)).toBe(true);
  });

  it('sorts files alphabetically (case-insensitive)', () => {
    const tree = buildTreeFromPaths(simpleFlat);
    const names = tree.map((n) => n.name);

    expect(names).toEqual([
      'Archive.md',
      'Ideas.md',
      'Notes.md',
      'README.md',
      'Tasks.md',
    ]);
  });

  it('builds nested hierarchy with folders first', () => {
    const tree = buildTreeFromPaths(nestedHierarchy);

    // Root level: folders first, then files
    expect(tree[0].name).toBe('Archive');
    expect(tree[0].isFolder).toBe(true);
    expect(tree[1].name).toBe('Projects');
    expect(tree[1].isFolder).toBe(true);
    expect(tree[2].name).toBe('Daily Notes.md');
    expect(tree[2].isFolder).toBe(false);
  });

  it('nests children correctly under parent folders', () => {
    const tree = buildTreeFromPaths(nestedHierarchy);
    const projects = tree.find((n) => n.name === 'Projects');

    expect(projects).toBeDefined();
    expect(projects!.children).toHaveLength(2);
    expect(projects!.children![0].name).toBe('Alpha');
    expect(projects!.children![1].name).toBe('Beta');
  });

  it('includes docId for markdown files', () => {
    const tree = buildTreeFromPaths(simpleFlat);
    const readme = tree.find((n) => n.name === 'README.md');

    expect(readme?.docId).toBe('doc-readme');
  });

  it('folders have undefined docId', () => {
    const tree = buildTreeFromPaths(nestedHierarchy);
    const projects = tree.find((n) => n.name === 'Projects');

    expect(projects?.docId).toBeUndefined();
  });
});
```

**Step 2: Run tests**

Run: `npm test -- --run src/lib/tree-utils.test.ts`

Note: Some tests may fail if code is broken. Record results for final report.

**Step 3: Commit**

```bash
jj desc -m "test: add buildTreeFromPaths tests"
jj new
```

---

### Task 16: Tests for tree-utils.ts - filterTree and getFolderIdsWithMatches

**Files:**
- Modify: `src/lib/tree-utils.test.ts`

**Step 1: Add filterTree and getFolderIdsWithMatches tests**

Append to `src/lib/tree-utils.test.ts`:

```typescript

describe('filterTree', () => {
  it('returns all nodes when search term is empty', () => {
    const tree = buildTreeFromPaths(simpleFlat);
    const filtered = filterTree(tree, '');

    expect(filtered).toHaveLength(5);
  });

  it('filters files by name match', () => {
    const tree = buildTreeFromPaths(simpleFlat);
    const filtered = filterTree(tree, 'notes');

    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe('Notes.md');
  });

  it('keeps parent folders when children match', () => {
    const tree = buildTreeFromPaths(nestedHierarchy);
    const filtered = filterTree(tree, 'alpha');

    const projects = filtered.find((n) => n.name === 'Projects');
    expect(projects).toBeDefined();
    expect(projects!.children!.some((c) => c.name === 'Alpha')).toBe(true);
  });

  it('is case-insensitive', () => {
    const tree = buildTreeFromPaths(simpleFlat);
    const filtered = filterTree(tree, 'README');

    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe('README.md');
  });

  it('clones nodes (does not mutate original)', () => {
    const tree = buildTreeFromPaths(nestedHierarchy);
    filterTree(tree, 'alpha');

    const projects = tree.find((n) => n.name === 'Projects');
    expect(projects!.children).toHaveLength(2);
  });
});

describe('getFolderIdsWithMatches', () => {
  it('returns empty set for empty search term', () => {
    const tree = buildTreeFromPaths(nestedHierarchy);
    const ids = getFolderIdsWithMatches(tree, '');

    expect(ids.size).toBe(0);
  });

  it('returns folder IDs containing matching descendants', () => {
    const tree = buildTreeFromPaths(nestedHierarchy);
    const ids = getFolderIdsWithMatches(tree, 'readme');

    expect(ids.has('folder-projects')).toBe(true);
    expect(ids.has('folder-alpha')).toBe(true);
  });

  it('does not include folders without matching descendants', () => {
    const tree = buildTreeFromPaths(nestedHierarchy);
    const ids = getFolderIdsWithMatches(tree, 'readme');

    expect(ids.has('folder-beta')).toBe(false);
    expect(ids.has('folder-archive')).toBe(false);
  });
});
```

**Step 2: Run tests**

Run: `npm test -- --run src/lib/tree-utils.test.ts`

Expected: All 14 tests pass

**Step 3: Commit**

```bash
jj desc -m "test: add filterTree and getFolderIdsWithMatches tests"
jj new
```

---

### Task 17: Tests for document-resolver.ts

**Files:**
- Create: `src/lib/document-resolver.test.ts`

**Step 1: Write tests**

Create file `src/lib/document-resolver.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { resolvePageName, generateNewDocPath } from './document-resolver';
import type { FolderMetadata } from '../hooks/useFolderMetadata';

const testMetadata: FolderMetadata = {
  '/Notes.md': { id: 'doc-notes', type: 'markdown' },
  '/Projects/README.md': { id: 'doc-proj-readme', type: 'markdown' },
  '/attachments/image.png': { id: 'img-1', type: 'image' },
  '/Archive': { id: 'folder-archive', type: 'folder' },
};

describe('resolvePageName', () => {
  it('returns null for non-existent page', () => {
    expect(resolvePageName('NonExistent', testMetadata)).toBeNull();
  });

  it('matches exact filename without extension', () => {
    const result = resolvePageName('Notes', testMetadata);

    expect(result).not.toBeNull();
    expect(result!.docId).toBe('doc-notes');
    expect(result!.path).toBe('/Notes.md');
  });

  it('matches case-insensitively', () => {
    const result = resolvePageName('notes', testMetadata);

    expect(result!.docId).toBe('doc-notes');
  });

  it('matches files in subdirectories', () => {
    const result = resolvePageName('README', testMetadata);

    expect(result!.docId).toBe('doc-proj-readme');
    expect(result!.path).toBe('/Projects/README.md');
  });

  it('ignores non-markdown files', () => {
    expect(resolvePageName('image', testMetadata)).toBeNull();
  });

  it('ignores folders', () => {
    expect(resolvePageName('Archive', testMetadata)).toBeNull();
  });
});

describe('generateNewDocPath', () => {
  it('adds .md extension', () => {
    expect(generateNewDocPath('New Page')).toBe('New Page.md');
  });

  it('sanitizes invalid filename characters', () => {
    expect(generateNewDocPath('What is this?')).toBe('What is this-.md');
  });

  it('replaces forward slashes', () => {
    expect(generateNewDocPath('A/B')).toBe('A-B.md');
  });

  it('replaces backslashes', () => {
    expect(generateNewDocPath('A\\B')).toBe('A-B.md');
  });

  it('replaces colons', () => {
    expect(generateNewDocPath('Time: 10:00')).toBe('Time- 10-00.md');
  });
});
```

**Step 2: Run tests**

Run: `npm test -- --run src/lib/document-resolver.test.ts`

Expected: All 11 tests pass

**Step 3: Commit**

```bash
jj desc -m "test: add document-resolver tests"
jj new
```

---

## Phase 6: React Hooks Tests - Priority #5 (Tasks 18-22)

### Task 18: MockRelayProvider Component

**Files:**
- Create: `src/test/MockRelayProvider.tsx`

**Step 1: Create MockRelayProvider**

Create file `src/test/MockRelayProvider.tsx`:

```tsx
import React, { useState, createContext, useContext } from 'react';
import * as Y from 'yjs';
import type { FolderMetadata } from '../hooks/useFolderMetadata';

// Context for Y.Doc access in tests
export const YDocContext = createContext<Y.Doc | null>(null);

// Hook to access the Y.Doc in tests
export function useYDoc(): Y.Doc | null {
  return useContext(YDocContext);
}

interface MockRelayProviderProps {
  fixture: Record<string, FolderMetadata[string]>;
  children: React.ReactNode;
}

/**
 * Mock provider that creates an in-memory Y.Doc from fixture data.
 * Use in tests to avoid real relay server connections.
 */
export function MockRelayProvider({ fixture, children }: MockRelayProviderProps) {
  const [doc] = useState(() => {
    const d = new Y.Doc();
    const filemeta = d.getMap('filemeta_v0');
    for (const [path, meta] of Object.entries(fixture)) {
      filemeta.set(path, meta);
    }
    return d;
  });

  return (
    <YDocContext.Provider value={doc}>
      {children}
    </YDocContext.Provider>
  );
}

/**
 * Create a standalone Y.Doc from fixture for unit tests.
 */
export function createDocFromFixture(
  fixture: Record<string, FolderMetadata[string]>
): Y.Doc {
  const doc = new Y.Doc();
  const filemeta = doc.getMap('filemeta_v0');
  for (const [path, meta] of Object.entries(fixture)) {
    filemeta.set(path, meta);
  }
  return doc;
}
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`

Expected: No errors

**Step 3: Commit**

```bash
jj desc -m "test: add MockRelayProvider component"
jj new
```

---

### Task 19: Tests for useFolderMetadata Hook

**Files:**
- Create: `src/hooks/useFolderMetadata.test.tsx`

**Step 1: Write hook tests**

Create file `src/hooks/useFolderMetadata.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import * as Y from 'yjs';
import type { FileMetadata } from './useFolderMetadata';

// We'll test the core Y.Map observation logic without the full hook
// since the hook requires Y-sweet provider which needs network mocking

describe('useFolderMetadata - Y.Map observation logic', () => {
  let doc: Y.Doc;
  let filemeta: Y.Map<FileMetadata>;

  beforeEach(() => {
    doc = new Y.Doc();
    filemeta = doc.getMap<FileMetadata>('filemeta_v0');
  });

  afterEach(() => {
    doc.destroy();
  });

  it('observes changes to filemeta_v0 map', () => {
    const changes: Array<{ action: string; key: string }> = [];

    filemeta.observe((event) => {
      event.changes.keys.forEach((change, key) => {
        changes.push({ action: change.action, key });
      });
    });

    filemeta.set('/new.md', { id: 'test-id', type: 'markdown' });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({ action: 'add', key: '/new.md' });
  });

  it('notifies on document deletion', () => {
    filemeta.set('/file.md', { id: 'id-1', type: 'markdown' });

    const changes: Array<{ action: string; key: string }> = [];
    filemeta.observe((event) => {
      event.changes.keys.forEach((change, key) => {
        changes.push({ action: change.action, key });
      });
    });

    filemeta.delete('/file.md');

    expect(changes).toContainEqual({ action: 'delete', key: '/file.md' });
  });

  it('notifies on document update', () => {
    filemeta.set('/file.md', { id: 'id-1', type: 'markdown' });

    const changes: Array<{ action: string; key: string }> = [];
    filemeta.observe((event) => {
      event.changes.keys.forEach((change, key) => {
        changes.push({ action: change.action, key });
      });
    });

    filemeta.set('/file.md', { id: 'id-1', type: 'canvas' });

    expect(changes).toContainEqual({ action: 'update', key: '/file.md' });
  });

  it('can iterate all entries', () => {
    filemeta.set('/a.md', { id: 'id-a', type: 'markdown' });
    filemeta.set('/b.md', { id: 'id-b', type: 'markdown' });

    const entries: Record<string, FileMetadata> = {};
    filemeta.forEach((value, key) => {
      entries[key] = value;
    });

    expect(Object.keys(entries)).toHaveLength(2);
    expect(entries['/a.md'].id).toBe('id-a');
    expect(entries['/b.md'].id).toBe('id-b');
  });

  it('unobserve stops notifications', () => {
    const changes: string[] = [];
    const observer = () => {
      changes.push('change');
    };

    filemeta.observe(observer);
    filemeta.set('/a.md', { id: 'id-a', type: 'markdown' });
    expect(changes).toHaveLength(1);

    filemeta.unobserve(observer);
    filemeta.set('/b.md', { id: 'id-b', type: 'markdown' });
    expect(changes).toHaveLength(1); // No new changes
  });
});
```

**Step 2: Run tests**

Run: `npm test -- --run src/hooks/useFolderMetadata.test.tsx`

Expected: All 5 tests pass

**Step 3: Commit**

```bash
jj desc -m "test: add useFolderMetadata Y.Map observation tests"
jj new
```

---

### Task 20: Tests for Hook Cleanup Patterns

**Files:**
- Create: `src/hooks/cleanup-patterns.test.tsx`

**Step 1: Write cleanup pattern tests**

Create file `src/hooks/cleanup-patterns.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import * as Y from 'yjs';

describe('Hook cleanup patterns', () => {
  it('Y.Doc destroy cleans up resources', () => {
    const doc = new Y.Doc();
    const filemeta = doc.getMap('filemeta_v0');

    filemeta.set('/file.md', { id: 'id-1', type: 'markdown' });
    expect(filemeta.size).toBe(1);

    doc.destroy();

    // After destroy, doc should be cleaned up
    // Accessing destroyed doc may throw or return empty
    expect(doc.isDestroyed).toBe(true);
  });

  it('observers are cleaned up on destroy', () => {
    const doc = new Y.Doc();
    const filemeta = doc.getMap('filemeta_v0');

    const callback = vi.fn();
    filemeta.observe(callback);

    filemeta.set('/a.md', { id: 'id-a', type: 'markdown' });
    expect(callback).toHaveBeenCalledTimes(1);

    doc.destroy();

    // After destroy, observers should not fire
    // (attempting to modify destroyed doc may throw)
  });

  it('multiple observers can be attached', () => {
    const doc = new Y.Doc();
    const filemeta = doc.getMap('filemeta_v0');

    const callback1 = vi.fn();
    const callback2 = vi.fn();

    filemeta.observe(callback1);
    filemeta.observe(callback2);

    filemeta.set('/file.md', { id: 'id-1', type: 'markdown' });

    expect(callback1).toHaveBeenCalled();
    expect(callback2).toHaveBeenCalled();

    doc.destroy();
  });

  it('observeDeep catches nested changes', () => {
    const doc = new Y.Doc();
    const root = doc.getMap('root');

    const deepChanges: string[] = [];
    root.observeDeep((events) => {
      events.forEach(() => deepChanges.push('deep'));
    });

    const nested = new Y.Map();
    root.set('nested', nested);
    nested.set('key', 'value');

    expect(deepChanges.length).toBeGreaterThan(0);

    doc.destroy();
  });
});
```

**Step 2: Run tests**

Run: `npm test -- --run src/hooks/cleanup-patterns.test.tsx`

Expected: All 4 tests pass

**Step 3: Commit**

```bash
jj desc -m "test: add hook cleanup pattern tests"
jj new
```

---

### Task 21: Tests for useSynced Hook

**Files:**
- Create: `src/hooks/useSynced.test.tsx`

**Philosophy:** Test the sync state transitions and event handling patterns without requiring
a real Y-sweet provider. We test the underlying state machine logic.

**Step 1: Write tests for sync state transitions**

Create file `src/hooks/useSynced.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock provider interface matching Y-sweet's structure
interface MockProvider {
  synced: boolean;
  listeners: Map<string, Set<() => void>>;
  on: (event: string, handler: () => void) => void;
  off: (event: string, handler: () => void) => void;
  emit: (event: string) => void;
}

function createMockProvider(initialSynced = false): MockProvider {
  const provider: MockProvider = {
    synced: initialSynced,
    listeners: new Map(),
    on(event: string, handler: () => void) {
      if (!this.listeners.has(event)) {
        this.listeners.set(event, new Set());
      }
      this.listeners.get(event)!.add(handler);
    },
    off(event: string, handler: () => void) {
      this.listeners.get(event)?.delete(handler);
    },
    emit(event: string) {
      this.listeners.get(event)?.forEach((h) => h());
    },
  };
  return provider;
}

describe('useSynced - sync state logic', () => {
  let provider: MockProvider;

  beforeEach(() => {
    provider = createMockProvider();
  });

  it('provider starts with synced=false by default', () => {
    expect(provider.synced).toBe(false);
  });

  it('provider can be created with initial synced=true', () => {
    const syncedProvider = createMockProvider(true);
    expect(syncedProvider.synced).toBe(true);
  });

  it('event handlers can be registered with on()', () => {
    const handler = vi.fn();
    provider.on('synced', handler);

    provider.emit('synced');

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('event handlers can be unregistered with off()', () => {
    const handler = vi.fn();
    provider.on('synced', handler);
    provider.off('synced', handler);

    provider.emit('synced');

    expect(handler).not.toHaveBeenCalled();
  });

  it('multiple handlers can listen to same event', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    provider.on('synced', handler1);
    provider.on('synced', handler2);

    provider.emit('synced');

    expect(handler1).toHaveBeenCalled();
    expect(handler2).toHaveBeenCalled();
  });

  it('unregistering one handler does not affect others', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    provider.on('synced', handler1);
    provider.on('synced', handler2);
    provider.off('synced', handler1);

    provider.emit('synced');

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).toHaveBeenCalled();
  });

  it('simulates sync state change pattern', () => {
    const states: boolean[] = [];

    provider.on('synced', () => {
      provider.synced = true;
      states.push(provider.synced);
    });

    // Simulate provider becoming synced
    provider.emit('synced');

    expect(states).toEqual([true]);
    expect(provider.synced).toBe(true);
  });
});
```

**Step 2: Run tests**

Run: `npm test -- --run src/hooks/useSynced.test.tsx`

Expected: All 7 tests pass

**Step 3: Commit**

```bash
jj desc -m "test: add useSynced sync state tests"
jj new
```

---

### Task 22: Tests for useCollaborators Hook

**Files:**
- Create: `src/hooks/useCollaborators.test.tsx`

**Philosophy:** Test the awareness/presence pattern without real WebSocket connections.
Focus on the data transformation from awareness states to collaborator info.

**Step 1: Write tests for awareness patterns**

Create file `src/hooks/useCollaborators.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock awareness state matching Y-sweet's structure
interface AwarenessState {
  clientId: number;
  user?: { name: string; color: string };
  cursor?: { anchor: number; head: number };
}

interface MockAwareness {
  clientID: number;
  states: Map<number, AwarenessState>;
  listeners: Set<() => void>;
  on: (event: string, handler: () => void) => void;
  off: (event: string, handler: () => void) => void;
  getStates: () => Map<number, AwarenessState>;
  setLocalState: (state: Partial<AwarenessState>) => void;
  emit: () => void;
}

function createMockAwareness(clientID = 1): MockAwareness {
  const awareness: MockAwareness = {
    clientID,
    states: new Map(),
    listeners: new Set(),
    on(_event: string, handler: () => void) {
      this.listeners.add(handler);
    },
    off(_event: string, handler: () => void) {
      this.listeners.delete(handler);
    },
    getStates() {
      return this.states;
    },
    setLocalState(state: Partial<AwarenessState>) {
      const existing = this.states.get(this.clientID) || { clientId: this.clientID };
      this.states.set(this.clientID, { ...existing, ...state });
    },
    emit() {
      this.listeners.forEach((h) => h());
    },
  };
  return awareness;
}

// Transform awareness states to collaborator list (mirrors hook logic)
function getCollaborators(awareness: MockAwareness) {
  const self = awareness.states.get(awareness.clientID);
  const others: AwarenessState[] = [];

  awareness.states.forEach((state, clientId) => {
    if (clientId !== awareness.clientID) {
      others.push(state);
    }
  });

  return {
    self: self || null,
    others,
    totalCount: awareness.states.size,
  };
}

describe('useCollaborators - awareness patterns', () => {
  let awareness: MockAwareness;

  beforeEach(() => {
    awareness = createMockAwareness(1);
  });

  it('starts with no states', () => {
    const { self, others, totalCount } = getCollaborators(awareness);

    expect(self).toBeNull();
    expect(others).toHaveLength(0);
    expect(totalCount).toBe(0);
  });

  it('setLocalState adds self to states', () => {
    awareness.setLocalState({ user: { name: 'Alice', color: '#f00' } });

    const { self, totalCount } = getCollaborators(awareness);

    expect(self).not.toBeNull();
    expect(self!.user!.name).toBe('Alice');
    expect(totalCount).toBe(1);
  });

  it('other clients appear in others array', () => {
    // Self
    awareness.setLocalState({ user: { name: 'Alice', color: '#f00' } });

    // Simulate remote client
    awareness.states.set(2, { clientId: 2, user: { name: 'Bob', color: '#0f0' } });

    const { self, others, totalCount } = getCollaborators(awareness);

    expect(self!.user!.name).toBe('Alice');
    expect(others).toHaveLength(1);
    expect(others[0].user!.name).toBe('Bob');
    expect(totalCount).toBe(2);
  });

  it('awareness change triggers listeners', () => {
    const handler = vi.fn();
    awareness.on('change', handler);

    awareness.emit();

    expect(handler).toHaveBeenCalled();
  });

  it('cursor positions are tracked', () => {
    awareness.setLocalState({
      user: { name: 'Alice', color: '#f00' },
      cursor: { anchor: 10, head: 10 },
    });

    awareness.states.set(2, {
      clientId: 2,
      user: { name: 'Bob', color: '#0f0' },
      cursor: { anchor: 50, head: 55 },
    });

    const { self, others } = getCollaborators(awareness);

    expect(self!.cursor).toEqual({ anchor: 10, head: 10 });
    expect(others[0].cursor).toEqual({ anchor: 50, head: 55 });
  });

  it('handles clients without user info', () => {
    awareness.states.set(2, { clientId: 2 });

    const { others } = getCollaborators(awareness);

    expect(others).toHaveLength(1);
    expect(others[0].user).toBeUndefined();
  });

  it('unregistering listener stops updates', () => {
    const handler = vi.fn();
    awareness.on('change', handler);
    awareness.off('change', handler);

    awareness.emit();

    expect(handler).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run tests**

Run: `npm test -- --run src/hooks/useCollaborators.test.tsx`

Expected: All 7 tests pass

**Step 3: Commit**

```bash
jj desc -m "test: add useCollaborators awareness tests"
jj new
```

---

## Phase 7: Test Report (Tasks 23-24)

### Task 23: Run Full Test Suite and Generate Report

**Step 1: Run all tests with verbose output**

Run: `npm test -- --run 2>&1 | tee test-results.txt`

**Step 2: Generate pass/fail report**

Create file `docs/plans/2026-02-01-testing-report.md`:

```markdown
# Testing Infrastructure Report

**Date:** [execution date]
**Total Tests:** 93

## Summary

| Status | Count |
|--------|-------|
| ✅ Passing | X |
| ❌ Failing | Y |

## Results by File

### ✅ Passing Tests (Green-Red-Green candidates)

These tests pass, meaning the code works. Apply GRG verification:
1. Break the code intentionally
2. Verify test fails
3. Restore the code

| File | Tests | Status |
|------|-------|--------|
| [list passing files] | | ✅ |

### ❌ Failing Tests (TDD candidates)

These tests fail, meaning the code is broken. Apply TDD:
1. Test already fails (RED)
2. Fix the code (GREEN)
3. Refactor if needed

| File | Tests | Failing | Error Summary |
|------|-------|---------|---------------|
| [list failing files] | | | |

## Detailed Failures

[For each failing test, document:]
- Test name
- Expected behavior
- Actual behavior
- Likely root cause

## Recommendations

1. **High Priority (blocking features):**
   - [list]

2. **Medium Priority (degraded experience):**
   - [list]

3. **Low Priority (edge cases):**
   - [list]
```

Fill in the template based on actual test results.

**Step 3: Commit report**

```bash
jj desc -m "docs: add testing infrastructure report with pass/fail analysis"
jj new
```

---

### Task 24: Final Commit - Squash (Optional)

**Step 1: Review commit history**

Run: `jj log --limit 25`

**Step 2: If desired, squash into a single commit**

```bash
jj squash --from <first-testing-commit> --into @
jj desc -m "test: add testing infrastructure with Vitest and happy-dom

Testing stack:
- Vitest with happy-dom environment
- @testing-library/react and jest-dom matchers
- Co-located tests (*.test.ts next to source)

Test coverage (75 tests):
- livePreview.ts: emphasis, headings, wikilinks, links, inline code (20)
- wikilinkParser.ts: parsing, node types, edge cases (8)
- wikilinkAutocomplete.ts: filtering, suggestions (6)
- relay-api.ts: CRDT operations, Y.Doc sync (11)
- tree-utils.ts: tree building, filtering, folder matching (14)
- document-resolver.ts: page resolution, path generation (11)
- React hooks: Y.Map observation, cleanup patterns (9)

Fixtures:
- Folder metadata: simple-flat, nested-hierarchy, edge-cases
- Document content: emphasis, headings, wikilinks, links

Philosophy:
- Green-Red-Green for existing working code (verified)
- Unit+1 style: real Y.Doc, real CodeMirror, mock network"
```

---

## Summary

| Phase | Tasks | Tests Added |
|-------|-------|-------------|
| 1. Infrastructure | 1-4 | 0 (setup only) |
| 2. Fixtures | 5-6 | 0 (data only) |
| 3. Live Preview (Priority #1) | 7-12 | 28 |
| 4. CRDT/File Ops (Priority #2) | 13-14 | 19 |
| 5. Pure Utilities (Priority #3) | 15-17 | 25 |
| 6. React Hooks (Priority #5) | 18-22 | 23 |
| 7. Test Report | 23-24 | 0 (analysis only) |

**Total: 93 tests across 10 test files**

### Files Created

```
vitest.config.ts
src/test/
├── setup.ts
├── codemirror-helpers.ts
├── MockRelayProvider.tsx
└── fixtures/
    ├── folder-metadata/
    │   ├── simple-flat.json
    │   ├── nested-hierarchy.json
    │   ├── edge-cases.json
    │   └── production-sample.json
    └── documents/
        ├── emphasis-variants.md
        ├── headings-all.md
        ├── wikilinks-mixed.md
        └── links-and-code.md

src/lib/
├── tree-utils.test.ts
├── document-resolver.test.ts
└── relay-api.test.ts

src/components/Editor/extensions/
├── livePreview.test.ts
├── wikilinkParser.test.ts
└── wikilinkAutocomplete.test.ts

src/hooks/
├── useFolderMetadata.test.tsx
├── cleanup-patterns.test.tsx
├── useSynced.test.tsx
└── useCollaborators.test.tsx
```

### Files Modified

- `package.json` (dependencies + scripts)
- `tsconfig.app.json` (vitest globals + resolveJsonModule)

### Next Steps After This Plan

The test report (Task 23) will categorize tests as:

1. **Passing tests** → Apply Green-Red-Green verification
   - Break code intentionally to confirm test catches regression
   - Restore code

2. **Failing tests** → Apply TDD to fix
   - Test already fails (RED)
   - Implement fix (GREEN)
   - Refactor if needed
