import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown';
import { EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import * as Y from 'yjs';
import type { FolderMetadata } from '../../hooks/useFolderMetadata';
import { pageUndoManager, swapLinksInEditor, type LibraryHit } from './localSwap';

const URL_A = 'https://example.com/a';
const URL_B = 'https://example.com/b';
const PAGE = '/Lens/Notes/page.md';
const TARGET = 'Lens Edu/articles/a.md';
const METADATA = {
  [`/${TARGET}`]: { id: 'a', type: 'markdown', version: 0 },
  '/Lens Edu/articles/b.md': { id: 'b', type: 'markdown', version: 0 },
} as unknown as FolderMetadata;
const REL = '../../Lens Edu/articles/a';
const HIT: LibraryHit = { urls: [URL_A], path: TARGET, title: 'The Title' };

let views: EditorView[] = [];

afterEach(() => {
  views.forEach((view) => view.destroy());
  views = [];
});

/** The real binding and undo history, as the main editor has them. */
function editorOn(text: string, extra: Parameters<typeof EditorState.create>[0] = {}) {
  const doc = new Y.Doc();
  const ytext = doc.getText('contents');
  ytext.insert(0, text);
  const undoManager = new Y.UndoManager(ytext, { captureTimeout: 500, trackedOrigins: new Set([]) });
  const view = new EditorView({
    state: EditorState.create({
      doc: text,
      extensions: [
        markdown({ base: commonmarkLanguage }),
        yCollab(ytext, null, { undoManager }),
        pageUndoManager.of(undoManager),
        ...((extra.extensions as []) ?? []),
      ],
    }),
    parent: document.body,
  });
  views.push(view);
  const swapIn = (hits: LibraryHit[] = [HIT], metadata = METADATA) =>
    swapLinksInEditor(view, ytext.length, metadata, PAGE, hits);
  const key = (name: string) => yUndoManagerKeymap.find((binding) => binding.key === name)?.run?.(view);
  return { view, ytext, undoManager, swapIn, undo: () => key('Mod-z'), redo: () => key('Mod-y') };
}

describe('swapLinksInEditor', () => {
  it('turns an inline link into a wikilink, keeping its label', () => {
    const { view, ytext, swapIn } = editorOn(`Read [my label](${URL_A}) now`);
    expect(swapIn()).toEqual([URL_A]);
    expect(view.state.doc.toString()).toBe(`Read [[${REL}|my label]] now`);
    expect(ytext.toString()).toBe(view.state.doc.toString());
  });

  it('gives a bare URL the title', () => {
    const { view, swapIn } = editorOn(`Read ${URL_A} now`);
    swapIn();
    expect(view.state.doc.toString()).toBe(`Read [[${REL}|The Title]] now`);
  });

  it('swaps every spelling and copy, in one transaction, with no user event', () => {
    const doc = `[a](${URL_A}) and [b](${URL_B}) and ${URL_A}/`;
    const seen: Transaction[] = [];
    const { view, swapIn } = editorOn(doc, {
      extensions: [EditorView.updateListener.of((update) => seen.push(...update.transactions.filter((tr) => tr.docChanged)))],
    });
    swapIn([
      { urls: [URL_A, `${URL_A}/`], path: TARGET, title: 'A' },
      { urls: [URL_B], path: 'Lens Edu/articles/b.md', title: 'B' },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0].annotation(Transaction.userEvent)).toBeUndefined();
    expect(view.state.doc.toString()).not.toContain('example.com');
  });

  it('uses the table form of a wikilink in a table', () => {
    const { view, swapIn } = editorOn(`| Name |\n|---|\n| [label](${URL_A}) |\n`);
    swapIn();
    expect(view.state.doc.toString()).toContain(`[[${REL}\\|label]]`);
  });

  describe('where it leaves the caret', () => {
    const TEXT = `Read ${URL_A} then`;
    const INLINE = `Read [lbl](${URL_A}) then`;
    const typed = (text: string, offset: number) => {
      const { view, swapIn } = editorOn(text);
      view.dispatch({ selection: { anchor: offset } });
      swapIn();
      const { head } = view.state.selection.main;
      view.dispatch({ changes: { from: head, insert: 'XX' }, selection: { anchor: head + 2 } });
      return view.state.doc.toString();
    };

    it('after a bare URL it was after or in', () => {
      expect(typed(TEXT, 5 + URL_A.length)).toBe(`Read [[${REL}|The Title]]XX then`);
      expect(typed(TEXT, 9)).toBe(`Read [[${REL}|The Title]]XX then`);
    });

    it('before one it was at the start of', () => {
      expect(typed(TEXT, 5)).toBe(`Read XX[[${REL}|The Title]] then`);
    });

    it('after the link, not in the label, when it was after the )', () => {
      expect(typed(INLINE, INLINE.indexOf(')') + 1)).toBe(`Read [[${REL}|lbl]]XX then`);
    });

    it('in the label when it was in the label', () => {
      expect(typed(INLINE, INLINE.indexOf('lbl') + 1)).toBe(`Read [[${REL}|lXXbl]] then`);
    });
  });

  describe('undo', () => {
    const undoable = (text: string) => {
      const editor = editorOn('');
      editor.ytext.doc?.transact(() => editor.ytext.insert(0, ''));
      editor.view.dispatch({ changes: { from: 0, insert: text } });
      editor.undoManager.stopCapturing();
      return editor;
    };

    it('brings the link back exactly, and redo swaps it again', () => {
      const text = `Read [my label](${URL_A}) now`;
      const { view, swapIn, undo, redo } = undoable(text);
      swapIn();
      undo();
      expect(view.state.doc.toString()).toBe(text);
      redo();
      expect(view.state.doc.toString()).toBe(`Read [[${REL}|my label]] now`);
    });

    it('restores a bare URL with the words around it', () => {
      const text = `Read ${URL_A} now`;
      const { view, swapIn, undo } = undoable(text);
      swapIn();
      undo();
      expect(view.state.doc.toString()).toBe(text);
    });

    it('is one step however many links changed', () => {
      const text = `[a](${URL_A}) and [b](${URL_B}) and [c](${URL_A})`;
      const { view, swapIn, undo } = undoable(text);
      swapIn([
        { urls: [URL_A], path: TARGET, title: 'A' },
        { urls: [URL_B], path: 'Lens Edu/articles/b.md', title: 'B' },
      ]);
      undo();
      expect(view.state.doc.toString()).toBe(text);
    });

    it('is its own step, apart from typing just before and just after', () => {
      const text = `Read [lbl](${URL_A}) now.`;
      const { view, swapIn, undo } = undoable(text);
      const type = (words: string) => view.dispatch({ changes: { from: view.state.doc.length, insert: words } });
      type(' Before.');
      swapIn();
      type(' After.');
      undo();
      expect(view.state.doc.toString()).toBe(`Read [[${REL}|lbl]] now. Before.`);
      undo();
      expect(view.state.doc.toString()).toBe(`Read [lbl](${URL_A}) now. Before.`);
      undo();
      expect(view.state.doc.toString()).toBe(text);
    });
  });

  describe('leaves to the server', () => {
    const TEXT = `Read [lbl](${URL_A}) now`;

    it('a target not in the metadata', () => {
      const { view, swapIn } = editorOn(TEXT);
      expect(swapIn([HIT], {})).toEqual([]);
      expect(view.state.doc.toString()).toBe(TEXT);
    });

    it('only that target, when others are there', () => {
      const { swapIn } = editorOn(`${TEXT} [b](${URL_B})`);
      expect(swapIn([HIT, { urls: [URL_B], path: 'Lens/nowhere.md' }])).toEqual([URL_A]);
    });

    it('a text out of step with the Y.Text', () => {
      const { view } = editorOn(TEXT);
      expect(swapLinksInEditor(view, TEXT.length + 1, METADATA, PAGE, [HIT])).toEqual([]);
      expect(view.state.doc.toString()).toBe(TEXT);
    });

    it('a read-only editor', () => {
      const { view, swapIn } = editorOn(TEXT, { extensions: [EditorState.readOnly.of(true)] });
      expect(swapIn()).toEqual([]);
      expect(view.state.doc.toString()).toBe(TEXT);
    });

    it('a link that has gone, or can\'t become a wikilink', () => {
      const { swapIn } = editorOn('Nothing here.');
      expect(swapIn()).toEqual([]);
      const unswappable = editorOn(`[a|b](${URL_A})`);
      expect(unswappable.swapIn()).toEqual([]);
    });

    it('nothing at all when there is nothing to do, not even an undo step', () => {
      const { undoManager, swapIn } = editorOn(TEXT);
      const stop = vi.spyOn(undoManager, 'stopCapturing');
      swapIn([HIT], {});
      expect(stop).not.toHaveBeenCalled();
    });
  });
});
