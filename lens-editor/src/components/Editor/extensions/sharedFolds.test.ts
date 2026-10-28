import { describe, it, expect, afterEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { foldedRanges } from '@codemirror/language';
import { yCollab } from 'y-codemirror.next';
import * as Y from 'yjs';
import { FOLDS_MAP, foldRangeOf, sharedFolds } from './sharedFolds';

const DOC = [
  '# One', // 1
  'text a', // 2
  '## One.a', // 3
  '- item', // 4
  '\t- child', // 5
  '\t\t- grandchild', // 6
  '- sibling', // 7
  '', // 8
  '# Two', // 9
  '```', // 10
  '# not a heading', // 11
  '\tcode', // 12
  '```', // 13
  'after code', // 14
].join('\n');

function range(doc: string, n: number) {
  const state = EditorState.create({ doc });
  const r = foldRangeOf(state, n);
  return r && [state.doc.lineAt(r.from).number, state.doc.lineAt(r.to).number];
}

describe('foldRangeOf', () => {
  it('folds a heading up to the next heading of its level or higher', () => {
    expect(range(DOC, 1)).toEqual([1, 7]);
    expect(range(DOC, 3)).toEqual([3, 7]);
  });

  it('leaves trailing blank lines out', () => {
    expect(range(DOC, 3)).toEqual([3, 7]);
  });

  it('folds the more-indented lines under a line', () => {
    expect(range(DOC, 4)).toEqual([4, 6]);
    expect(range(DOC, 5)).toEqual([5, 6]);
    expect(range(DOC, 6)).toBeNull();
    expect(range(DOC, 7)).toBeNull();
  });

  it('ignores headings in code, and starts no fold inside code', () => {
    expect(range(DOC, 9)).toEqual([9, 14]);
    expect(range(DOC, 11)).toBeNull();
    expect(range(DOC, 10)).toBeNull();
  });

  it('starts no fold in frontmatter', () => {
    const doc = '---\ntitle: x\ntags:\n  - a\n---\n# H\nbody';
    expect(range(doc, 3)).toBeNull();
    expect(range(doc, 6)).toEqual([6, 7]);
  });

  it('a heading with nothing under it does not fold', () => {
    expect(range('# A\n# B\nx', 1)).toBeNull();
  });
});

// Two editors on two Y.Docs that exchange updates, like two people on a page
const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
});

function editor(ydoc: Y.Doc, canWrite = true) {
  const ytext = ydoc.getText('contents');
  const view = new EditorView({
    state: EditorState.create({
      doc: ytext.toString(),
      extensions: [yCollab(ytext, null, { undoManager: false }), sharedFolds(ydoc, ytext, { canWrite })],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

function pair() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  const link = { online: true };
  a.on('update', (u: Uint8Array, origin: unknown) => link.online && origin !== 'b' && Y.applyUpdate(b, u, 'a'));
  b.on('update', (u: Uint8Array, origin: unknown) => link.online && origin !== 'a' && Y.applyUpdate(a, u, 'b'));
  a.getText('contents').insert(0, DOC);
  /** Exchange everything missed while offline */
  const reconnect = () => {
    link.online = true;
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), 'a');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), 'b');
  };
  return { a, b, link, reconnect };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function foldedLines(view: EditorView) {
  const lines: number[] = [];
  foldedRanges(view.state).between(0, view.state.doc.length, (from) => {
    lines.push(view.state.doc.lineAt(from).number);
  });
  return lines;
}

function press(view: EditorView, key: string, opts: KeyboardEventInit = {}) {
  view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }));
}

function clickArrow(view: EditorView, lineNumber: number) {
  const line = view.state.doc.line(lineNumber);
  const arrow = [...view.contentDOM.querySelectorAll('.cm-fold-toggle')].find(
    (el) => view.state.doc.lineAt(view.posAtDOM(el)).number === lineNumber,
  );
  expect(arrow, `arrow on line ${lineNumber} (${line.text})`).toBeTruthy();
  arrow!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
}

describe('sharedFolds', () => {
  it('a fold shows for the other person at once, and an unfold too', async () => {
    const { a, b } = pair();
    const va = editor(a);
    const vb = editor(b);
    clickArrow(va, 3);
    await tick();
    expect(foldedLines(va)).toEqual([3]);
    expect(foldedLines(vb)).toEqual([3]);

    clickArrow(vb, 3);
    await tick();
    expect(foldedLines(va)).toEqual([]);
    expect(foldedLines(vb)).toEqual([]);
    expect(a.getMap(FOLDS_MAP).size).toBe(0);
  });

  it('keeps the markdown unchanged', async () => {
    const { a } = pair();
    const va = editor(a);
    clickArrow(va, 1);
    await tick();
    expect(a.getText('contents').toString()).toBe(DOC);
  });

  it('a page opens with its folds', async () => {
    const { a, b } = pair();
    const va = editor(a);
    clickArrow(va, 4);
    await tick();
    const vb = editor(b);
    await tick();
    expect(foldedLines(vb)).toEqual([4]);
  });

  it('a fold follows its line through edits above it', async () => {
    const { a, b } = pair();
    const va = editor(a);
    clickArrow(va, 9);
    await tick();
    a.getText('contents').insert(0, 'new line\n');
    const vb = editor(b);
    await tick();
    expect(foldedLines(vb)).toEqual([10]);
  });

  it('a fold whose line was deleted folds nothing else, and is removed', async () => {
    const { a, b } = pair();
    const va = editor(a);
    clickArrow(va, 9);
    await tick();
    const ytext = a.getText('contents');
    ytext.delete(0, ytext.length);
    ytext.insert(0, DOC);
    const vb = editor(b);
    await tick();
    expect(foldedLines(vb)).toEqual([]);
    expect(a.getMap(FOLDS_MAP).size).toBe(0);
  });

  it('the keyboard folds the block the cursor is in, for everyone', async () => {
    const { a, b } = pair();
    const va = editor(a);
    const vb = editor(b);
    va.dispatch({ selection: { anchor: va.state.doc.line(2).from } });
    press(va, '[', { ctrlKey: true, shiftKey: true });
    await tick();
    expect(foldedLines(vb)).toEqual([1]);
  });

  it('a read-only viewer sees shared folds but folds only for themselves', async () => {
    const { a, b } = pair();
    const va = editor(a);
    const vb = editor(b, false);
    clickArrow(va, 1);
    await tick();
    expect(foldedLines(vb)).toEqual([1]);
    clickArrow(vb, 9);
    await tick();
    expect(foldedLines(vb)).toEqual([1, 9]);
    expect(foldedLines(va)).toEqual([1]);
  });

  it('two people folding the same heading: one unfold opens it', async () => {
    const { a, b, link, reconnect } = pair();
    const va = editor(a);
    const vb = editor(b);
    // Both fold before seeing each other's fold
    link.online = false;
    clickArrow(va, 9);
    clickArrow(vb, 9);
    reconnect();
    await tick();
    expect(a.getMap(FOLDS_MAP).size).toBe(2);
    expect(foldedLines(va)).toEqual([9]);
    clickArrow(vb, 9);
    await tick();
    expect(a.getMap(FOLDS_MAP).size).toBe(0);
    expect(foldedLines(va)).toEqual([]);
    expect(foldedLines(vb)).toEqual([]);
  });
});
