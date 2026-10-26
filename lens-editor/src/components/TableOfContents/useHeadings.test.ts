import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { extractHeadings, headingInView, normalizeHeadingLevels, plainHeadingText, rankHeadingLevels, useHeadingInView } from './useHeadings';
import type { Heading } from './useHeadings';

/** Helper: build minimal Heading[] from raw levels */
function headingsFromLevels(levels: number[]): Heading[] {
  return levels.map((level, i) => ({
    level,
    text: `Heading ${i}`,
    from: i * 100,
    to: i * 100 + 50,
  }));
}

const fixtures = [
  {
    name: 'already normalized (H1, H2, H3)',
    input: [1, 2, 3, 2, 1],
    expected: [1, 2, 3, 2, 1],
  },
  {
    name: 'starts at H3 — promotes to level 1',
    input: [3, 4, 4, 3, 2, 4, 3, 4],
    expected: [1, 2, 2, 1, 1, 2, 2, 3],
  },
  {
    name: 'single heading',
    input: [4],
    expected: [1],
  },
  {
    name: 'all same level',
    input: [2, 2, 2],
    expected: [1, 1, 1],
  },
  {
    name: 'gap in levels (H2 then H5) — child is still level 2',
    input: [2, 5, 5, 2],
    expected: [1, 2, 2, 1],
  },
  {
    name: 'descending levels (H4, H3, H2, H1)',
    input: [4, 3, 2, 1],
    expected: [1, 1, 1, 1],
  },
  {
    name: 'deep nesting from high start',
    input: [3, 4, 5, 6, 3],
    expected: [1, 2, 3, 4, 1],
  },
  {
    name: 'empty array',
    input: [],
    expected: [],
  },
];

describe('normalizeHeadingLevels', () => {
  for (const { name, input, expected } of fixtures) {
    it(name, () => {
      const headings = headingsFromLevels(input);
      const result = normalizeHeadingLevels(headings);
      expect(result.map((h) => h.displayLevel)).toEqual(expected);
    });
  }
});

describe('rankHeadingLevels', () => {
  it('gives each heading type one level, the highest on the page 1', () => {
    // An H3 after an H1 and an H3 after an H2 are both level 3
    const result = rankHeadingLevels(headingsFromLevels([2, 4, 3, 4, 2, 4]));
    expect(result.map((h) => h.displayLevel)).toEqual([1, 3, 2, 3, 1, 3]);
  });
});

describe('extractHeadings', () => {
  it("lists the page's headings as they read, not those inside lists", () => {
    const state = EditorState.create({
      doc: '# **One**\n- ##### **Actions done:**\n\t- x\n\n## See [[Docs/Q4 Plan|the plan]] and `code`',
      extensions: [markdown()],
    });
    // The whole document, however long parsing takes on a busy machine
    ensureSyntaxTree(state, state.doc.length, 10_000);
    expect(extractHeadings(state).map((h) => h.text)).toEqual(['One', 'See the plan and code']);
  });
});

describe('plainHeadingText', () => {
  it('drops emphasis, links, highlights and suggestions', () => {
    expect(plainHeadingText('**Actions done:**')).toBe('Actions done:');
    expect(plainHeadingText('Read [the source](https://x.org) and [[Lens/Plans/Q4 Plan]]')).toBe('Read the source and Q4 Plan');
    expect(plainHeadingText('A *really* {==new==}{>>a comment<<} {++plan++}{--old--}')).toBe('A really new plan');
    expect(plainHeadingText('snake_case_name stays')).toBe('snake_case_name stays');
  });
});

describe('headingInView', () => {
  it('is the last heading at or above the line, else the first', () => {
    expect(headingInView([100, 400, 900], 450)).toBe(1);
    expect(headingInView([100, 400, 900], 400)).toBe(1);
    expect(headingInView([100, 400, 900], 50)).toBe(0);
    expect(headingInView([100, 400, 900], 2000)).toBe(2);
    expect(headingInView([], 100)).toBe(-1);
  });
});

describe('useHeadingInView', () => {
  const doc = '# One\n\ntext\n\n# Two\n\nmore';
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
  });

  it('dispatches nothing, also when the headings change', () => {
    // An extra transaction after an edit makes CodeMirror lose its scroll
    // anchor, so a remote edit above the viewport moved the page.
    view = new EditorView({ state: EditorState.create({ doc }), parent: document.body });
    const editor = view;
    const dispatch = vi.spyOn(editor, 'dispatch');
    const { rerender, unmount } = renderHook(({ headings }) => useHeadingInView(editor, headings), {
      initialProps: { headings: headingsFromLevels([1, 1]) },
    });
    rerender({ headings: headingsFromLevels([1, 1]) });
    rerender({ headings: headingsFromLevels([1, 2, 1]) });
    unmount();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
