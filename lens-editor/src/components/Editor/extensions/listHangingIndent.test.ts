import { describe, it, expect, afterEach } from 'vitest';
import { createTestEditor, countClass } from '../../../test/codemirror-helpers';
import { listPrefixLength } from './listHangingIndent';
import type { EditorView } from '@codemirror/view';

function prefixOfLine(view: EditorView, lineNumber: number): number | null {
  return listPrefixLength(view.state, view.state.doc.line(lineNumber));
}

describe('listHangingIndent - listPrefixLength', () => {
  let cleanup: () => void;
  afterEach(() => cleanup?.());

  it('covers indent, marker and following space for bullets at every level', () => {
    const { view, cleanup: c } = createTestEditor('- a\n\t- b\n\t\t- c\nplain', 0);
    cleanup = c;
    expect(prefixOfLine(view, 1)).toBe(2);
    expect(prefixOfLine(view, 2)).toBe(3);
    expect(prefixOfLine(view, 3)).toBe(4);
    expect(prefixOfLine(view, 4)).toBeNull();
  });

  it('handles *, +, ordered markers and task checkboxes', () => {
    const { view, cleanup: c } = createTestEditor('* a\n+ b\n1. c\n10) d\n- [ ] e\n- [x] f', 0);
    cleanup = c;
    expect(prefixOfLine(view, 1)).toBe(2);
    expect(prefixOfLine(view, 2)).toBe(2);
    expect(prefixOfLine(view, 3)).toBe(3);
    expect(prefixOfLine(view, 4)).toBe(4);
    expect(prefixOfLine(view, 5)).toBe(6);
    expect(prefixOfLine(view, 6)).toBe(6);
  });

  it('handles list items inside blockquotes', () => {
    const { view, cleanup: c } = createTestEditor('> - a\n> \t- b\n>> - c', 0);
    cleanup = c;
    expect(prefixOfLine(view, 1)).toBe(4);
    expect(prefixOfLine(view, 2)).toBe(5);
    expect(prefixOfLine(view, 3)).toBe(5);
  });

  it('ignores lines that merely start with a dash', () => {
    const { view, cleanup: c } = createTestEditor('---\n-no space\n--- rule\ntext - dash', 0);
    cleanup = c;
    for (let ln = 1; ln <= 4; ln++) expect(prefixOfLine(view, ln)).toBeNull();
  });

  it('ignores list-looking lines inside fenced code blocks', () => {
    const { view, cleanup: c } = createTestEditor('```\n- not a bullet\n```\n- bullet', 0);
    cleanup = c;
    expect(prefixOfLine(view, 2)).toBeNull();
    expect(prefixOfLine(view, 4)).toBe(2);
  });

  it('ignores YAML list lines inside frontmatter', () => {
    const { view, cleanup: c } = createTestEditor('---\ntags:\n- one\n---\n- bullet', 0);
    cleanup = c;
    expect(prefixOfLine(view, 3)).toBeNull();
    expect(prefixOfLine(view, 5)).toBe(2);
  });
});

describe('listHangingIndent - decorations', () => {
  let cleanup: () => void;
  afterEach(() => cleanup?.());

  it('wraps the leading tabs of indented list lines in cm-list-indent', () => {
    const { view, cleanup: c } = createTestEditor('- a\n\t- b\n\t\t- c\n\tnot a list', 0);
    cleanup = c;
    const spans = Array.from(view.contentDOM.querySelectorAll('.cm-list-indent'));
    expect(spans.map((s) => s.textContent)).toEqual(['\t', '\t\t']);
  });

  it('includes blockquote markers in the indent span', () => {
    const { view, cleanup: c } = createTestEditor('> \t- b', 0);
    cleanup = c;
    const spans = Array.from(view.contentDOM.querySelectorAll('.cm-list-indent'));
    expect(spans.map((s) => s.textContent)).toEqual(['> \t']);
  });

  it('adds no indent span for top-level or non-list lines', () => {
    const { view, cleanup: c } = createTestEditor('- a\nplain\n\tcode-ish', 0);
    cleanup = c;
    expect(countClass(view, 'cm-list-indent')).toBe(0);
  });

  it('keeps the indent span when the cursor sits on the marker', () => {
    // The bullet widget disappears near the cursor; the tab span must not.
    const { view, cleanup: c } = createTestEditor('\t- b', 1);
    cleanup = c;
    expect(countClass(view, 'cm-list-indent')).toBe(1);
  });
});
