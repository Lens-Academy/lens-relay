// src/components/Editor/extensions/copiedText.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView, drawSelection } from '@codemirror/view';
import { copiedRanges, piecesToCopy, type DocRange } from './copiedText';
import { copyEvent, dragStartEvent } from '../../../test/codemirror-helpers';

/** Leaves every `#` off the clipboard */
const withoutHashes = piecesToCopy.of((state, ranges) => {
  const pieces: DocRange[] = [];
  for (const { from, to } of ranges) {
    let start = from;
    for (let pos = from; pos <= to; pos++) {
      if (pos < to && state.sliceDoc(pos, pos + 1) !== '#') continue;
      if (pos > start) pieces.push({ from: start, to: pos });
      start = pos + 1;
    }
  }
  return pieces;
});

let view: EditorView | undefined;
afterEach(() => view?.destroy());

function editor(doc: string, selection: EditorSelection, extensions: Extension = withoutHashes): EditorView {
  view = new EditorView({
    state: EditorState.create({
      doc,
      selection,
      // As Editor.tsx: several selected ranges need drawSelection
      extensions: [EditorState.allowMultipleSelections.of(true), drawSelection(), extensions],
    }),
    parent: document.body,
  });
  return view;
}

describe('copiedRanges', () => {
  const state = (selection: EditorSelection) =>
    EditorState.create({ doc: 'one\ntwo\nthree', selection, extensions: EditorState.allowMultipleSelections.of(true) });

  it('takes the selected ranges, not the cursors among them', () => {
    const ranges = [EditorSelection.range(0, 2), EditorSelection.cursor(5), EditorSelection.range(9, 11)];
    expect(copiedRanges(state(EditorSelection.create(ranges)))).toEqual({
      ranges: [{ from: 0, to: 2 }, { from: 9, to: 11 }],
      linewise: false,
    });
  });

  it('with nothing selected, takes each cursor line once, with its line break', () => {
    const cursors = [EditorSelection.cursor(1), EditorSelection.cursor(2), EditorSelection.cursor(10)];
    expect(copiedRanges(state(EditorSelection.create(cursors)))).toEqual({
      ranges: [{ from: 0, to: 4 }, { from: 8, to: 13 }],
      linewise: true,
    });
  });
});

describe('piecesToCopy', () => {
  it('a copy puts what it leaves of the selection on the clipboard', () => {
    expect(copyEvent(editor('a#b#c d', EditorSelection.single(0, 5))).text).toBe('abc');
  });

  it('several selected ranges go on lines of their own', () => {
    const v = editor('a#b c#d', EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(4, 7)]));
    expect(copyEvent(v).text).toBe('ab\ncd');
  });

  it('a whole-line copy (nothing selected) takes the lines without their line breaks', () => {
    const v = editor('#one\ntwo\n#three', EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(10)]));
    expect(copyEvent(v).text).toBe('one\nthree');
  });

  it('a drag carries what it leaves of the main selection', () => {
    const v = editor('a#b c#d', EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(4, 7)], 1));
    expect(dragStartEvent(v)).toBe('cd');
  });

  it('a copy of a selection it leaves nothing of puts nothing on the clipboard', () => {
    // CodeMirror leaves a copy without text to the browser, which copies the page's selection
    expect(copyEvent(editor('a##b', EditorSelection.single(1, 3)))).toEqual({ text: '', handled: true });
  });

  it('leaves text that comes from elsewhere as it is', () => {
    const v = editor('a#b', EditorSelection.single(0, 3));
    const text = v.state.facet(EditorView.clipboardOutputFilter).reduce((t, filter) => filter(t, v.state), 'x#y');
    expect(text).toBe('x#y');
  });

  it('without it, a copy takes the selection as it is', () => {
    expect(copyEvent(editor('a#b#c d', EditorSelection.single(0, 5), [])).text).toBe('a#b#c');
  });
});
