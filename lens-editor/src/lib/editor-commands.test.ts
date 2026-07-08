import { describe, it, expect, afterEach } from 'vitest';
import { EditorView } from '@codemirror/view';
import { EditorState, EditorSelection } from '@codemirror/state';
import {
  toggleInlineMark,
  toggleLinePrefix,
  cycleHeading,
  insertWikilink,
} from './editor-commands';

let view: EditorView | null = null;

function makeView(doc: string, anchor: number, head?: number): EditorView {
  view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(anchor, head ?? anchor),
    }),
  });
  return view;
}

afterEach(() => {
  view?.destroy();
  view = null;
});

describe('toggleInlineMark', () => {
  it('wraps a selection in the marker', () => {
    const v = makeView('hello world', 0, 5);
    toggleInlineMark(v, '**');
    expect(v.state.doc.toString()).toBe('**hello** world');
    expect(v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to)).toBe('hello');
  });

  it('unwraps when the selection is already marked (marks outside)', () => {
    const v = makeView('**hello** world', 2, 7);
    toggleInlineMark(v, '**');
    expect(v.state.doc.toString()).toBe('hello world');
  });

  it('unwraps when the marks are inside the selection', () => {
    const v = makeView('**hello** world', 0, 9);
    toggleInlineMark(v, '**');
    expect(v.state.doc.toString()).toBe('hello world');
  });

  it('inserts a marker pair at an empty cursor', () => {
    const v = makeView('ab', 1);
    toggleInlineMark(v, '*');
    expect(v.state.doc.toString()).toBe('a**b');
    expect(v.state.selection.main.head).toBe(2);
  });

  it('does not eat surrounding bold when toggling italic inside **bold**', () => {
    const v = makeView('**hello** world', 2, 7);
    toggleInlineMark(v, '*');
    expect(v.state.doc.toString()).toBe('***hello*** world');
  });
});

describe('toggleLinePrefix', () => {
  it('adds bullets to selected lines', () => {
    const v = makeView('one\ntwo', 0, 7);
    toggleLinePrefix(v, 'bullet');
    expect(v.state.doc.toString()).toBe('- one\n- two');
  });

  it('removes bullets when all lines have them', () => {
    const v = makeView('- one\n- two', 0, 11);
    toggleLinePrefix(v, 'bullet');
    expect(v.state.doc.toString()).toBe('one\ntwo');
  });

  it('converts bullet to task', () => {
    const v = makeView('- one', 2);
    toggleLinePrefix(v, 'task');
    expect(v.state.doc.toString()).toBe('- [ ] one');
  });

  it('adds a quote prefix preserving indentation', () => {
    const v = makeView('  hi', 3);
    toggleLinePrefix(v, 'quote');
    expect(v.state.doc.toString()).toBe('  > hi');
  });

  it('skips blank lines in multi-line selections', () => {
    const v = makeView('one\n\ntwo', 0, 8);
    toggleLinePrefix(v, 'bullet');
    expect(v.state.doc.toString()).toBe('- one\n\n- two');
  });
});

describe('cycleHeading', () => {
  it('cycles none → h1 → h2 → h3 → none', () => {
    const v = makeView('title', 2);
    cycleHeading(v);
    expect(v.state.doc.toString()).toBe('# title');
    cycleHeading(v);
    expect(v.state.doc.toString()).toBe('## title');
    cycleHeading(v);
    expect(v.state.doc.toString()).toBe('### title');
    cycleHeading(v);
    expect(v.state.doc.toString()).toBe('title');
  });

  it('does not flatten deeper headings — H4 cycles to H5', () => {
    const v = makeView('#### title', 6);
    cycleHeading(v);
    expect(v.state.doc.toString()).toBe('##### title');
    cycleHeading(v);
    expect(v.state.doc.toString()).toBe('###### title');
    cycleHeading(v);
    expect(v.state.doc.toString()).toBe('title');
  });
});

describe('insertWikilink', () => {
  it('wraps the selection and places the cursor inside the closing brackets', () => {
    const v = makeView('see page here', 4, 8);
    insertWikilink(v);
    expect(v.state.doc.toString()).toBe('see [[page]] here');
    expect(v.state.selection.main.head).toBe(10);
  });

  it('inserts empty brackets at a cursor', () => {
    const v = makeView('', 0);
    insertWikilink(v);
    expect(v.state.doc.toString()).toBe('[[]]');
    expect(v.state.selection.main.head).toBe(2);
  });
});
