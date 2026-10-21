import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { normalizeHeadingLevels, useActiveHeading } from './useHeadings';
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

describe('useActiveHeading', () => {
  const doc = '# One\n\ntext\n\n# Two\n\nmore';
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
  });

  it('dispatches nothing when the headings change', () => {
    // An extra transaction after an edit makes CodeMirror lose its scroll
    // anchor, so a remote edit above the viewport moved the page.
    view = new EditorView({ state: EditorState.create({ doc }), parent: document.body });
    const editor = view;
    const { rerender } = renderHook(({ headings }) => useActiveHeading(editor, headings), {
      initialProps: { headings: headingsFromLevels([1, 1]) },
    });
    const dispatch = vi.spyOn(editor, 'dispatch');
    rerender({ headings: headingsFromLevels([1, 1]) });
    rerender({ headings: headingsFromLevels([1, 2, 1]) });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('follows the cursor with the latest headings', () => {
    view = new EditorView({ state: EditorState.create({ doc }), parent: document.body });
    const editor = view;
    const { result, rerender } = renderHook(({ headings }) => useActiveHeading(editor, headings), {
      initialProps: { headings: headingsFromLevels([1]) },
    });
    // headingsFromLevels puts heading i at i * 100
    rerender({ headings: headingsFromLevels([1, 1, 1]) });
    act(() => editor.dispatch({ selection: { anchor: 0 } }));
    expect(result.current).toBe(0);
    act(() => editor.dispatch({ changes: { from: doc.length, insert: ' '.repeat(300) }, selection: { anchor: 250 } }));
    expect(result.current).toBe(2);
  });

  it('stops listening when unmounted and keeps one editor listener across remounts', () => {
    view = new EditorView({ state: EditorState.create({ doc: doc + ' '.repeat(300) }), parent: document.body });
    const editor = view;
    const headings = headingsFromLevels([1, 1, 1]);
    const first = renderHook(() => useActiveHeading(editor, headings));
    first.unmount();
    const dispatch = vi.spyOn(editor, 'dispatch');
    const second = renderHook(() => useActiveHeading(editor, headings));
    expect(dispatch).not.toHaveBeenCalled();
    act(() => editor.dispatch({ selection: { anchor: 250 } }));
    expect(second.result.current).toBe(2);
    expect(first.result.current).toBe(0);
  });
});
