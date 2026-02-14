import { describe, it, expect, afterEach } from 'vitest';
import {
  createTestEditor,
  moveCursor,
  hasClass,
  countClass,
} from '../../../test/codemirror-helpers';
import { resolvePageName } from '../../../lib/document-resolver';
import type { FolderMetadata } from '../../../hooks/useFolderMetadata';

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

describe('livePreview - wikilinks', () => {
  let cleanup: () => void;

  // Test metadata with real document entries for resolution testing
  const testMetadata: FolderMetadata = {
    '/My Page.md': { id: 'doc-1', type: 'markdown' },
    '/Existing Page.md': { id: 'doc-2', type: 'markdown' },
  };

  // Create context with real resolution logic
  const createRealContext = () => ({
    onClick: () => {},
    isResolved: (pageName: string) => resolvePageName(pageName, testMetadata) !== null,
  });

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

    const { view, cleanup: c } = createTestEditor(content, 15, createRealContext());
    cleanup = c;

    const widgets = view.contentDOM.querySelectorAll('.cm-wikilink-widget');
    expect(widgets.length).toBe(1);
    expect(widgets[0].textContent).toBe('My Page');
  });

  it('marks unresolved links with unresolved class', () => {
    const content = '[[NonExistent]] more text';

    // NonExistent is not in testMetadata, so isResolved will return false
    const { view, cleanup: c } = createTestEditor(content, 25, createRealContext());
    cleanup = c;

    expect(hasClass(view, 'unresolved')).toBe(true);
  });

  it('does not mark resolved links with unresolved class', () => {
    const content = '[[Existing Page]] more text';

    // Existing Page is in testMetadata, so isResolved will return true
    const { view, cleanup: c } = createTestEditor(content, 27, createRealContext());
    cleanup = c;

    const widget = view.contentDOM.querySelector('.cm-wikilink-widget');
    expect(widget).not.toBeNull();
    expect(widget!.classList.contains('unresolved')).toBe(false);
  });

  it('replaces ![[Page]] embed with widget when cursor outside', () => {
    const content = '![[Page Name]] more';
    const { view, cleanup: c } = createTestEditor(content, 19);
    cleanup = c;
    expect(hasClass(view, 'cm-wikilink-widget')).toBe(true);
  });

  it('widget displays page name for embed syntax', () => {
    const content = '![[My Page]] end';
    const { view, cleanup: c } = createTestEditor(content, 16, createRealContext());
    cleanup = c;
    const widgets = view.contentDOM.querySelectorAll('.cm-wikilink-widget');
    expect(widgets.length).toBe(1);
    expect(widgets[0].textContent).toBe('My Page');
  });
});

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
