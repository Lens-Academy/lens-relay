// src/components/Editor/extensions/criticmarkup-paste.test.ts
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { yCollab } from 'y-codemirror.next';
import * as Y from 'yjs';
import { getAuthorshipRuns } from '../../../lib/authorship-runs';
import { forgetCopied } from '../../../lib/carried-authorship';
import { parse, type CriticMarkupRange } from '../../../lib/criticmarkup-parser';
import { getClientActorMap, registerClientMapping } from '../../../lib/provenance';
import { criticMarkupExtension, criticMarkupField, setCurrentAuthor, toggleSuggestionMode } from './criticmarkup';
import { keepAuthorship } from './keepAuthorship';
import { livePreview, toggleSourceMode } from './livePreview';

const ELIAS = '{"author":"Elias","timestamp":1000}';
const COPIED = `ends with {++${ELIAS}@@an addition++}`;

/** A paste of `text` through CodeMirror's own paste handling */
function paste(view: EditorView, text: string): void {
  const clipboardData = new DataTransfer();
  clipboardData.setData('text/plain', text);
  view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
}

/** A copy through CodeMirror's own copy handling; returns the text copied */
function copy(view: EditorView): string {
  // CodeMirror copies only while the page's selection is in the editor
  const { selection } = view.state;
  view.focus();
  if (!view.state.selection.eq(selection)) view.dispatch({ selection });
  const clipboardData = new DataTransfer();
  view.contentDOM.dispatchEvent(new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true }));
  view.contentDOM.blur();
  return clipboardData.getData('text/plain');
}

describe('suggestion mode: pasting text with suggestions in it', () => {
  let view: EditorView | undefined;
  const destroy = () => {
    view?.destroy();
    view = undefined;
  };
  beforeEach(() => setCurrentAuthor('Mark'));
  afterEach(destroy);

  function editor(text: string, anchor: number, head = anchor, suggesting = true): EditorView {
    destroy();
    view = new EditorView({
      state: EditorState.create({
        doc: text,
        selection: { anchor, head },
        extensions: [markdown({ base: markdownLanguage, addKeymap: false }), livePreview(), criticMarkupExtension()],
      }),
      parent: document.body,
    });
    if (suggesting) view.dispatch({ effects: toggleSuggestionMode.of(true) });
    return view;
  }

  /** The suggestions in `v`'s document that start at or after `from` */
  function rangesFrom(v: EditorView, from: number): CriticMarkupRange[] {
    return v.state.field(criticMarkupField).filter((r) => r.from >= from);
  }

  /** No suggestion starts inside another of its kind (which ends it early) */
  function expectNoNesting(v: EditorView): void {
    const ranges = v.state.field(criticMarkupField);
    const nested = ranges.filter((r) => ranges.some((o) => o !== r && o.type === r.type && o.from < r.from && r.from < o.to));
    expect(nested).toEqual([]);
  }

  it('someone\'s addition in the pasted text goes in as plain text, in one addition of yours', () => {
    const doc = 'Paste here: ';
    const v = editor(doc, doc.length);
    paste(v, COPIED);

    const [mine, ...others] = rangesFrom(v, doc.length);
    expect(others).toEqual([]);
    expect(mine).toMatchObject({ type: 'addition', from: doc.length, to: v.state.doc.length, content: 'ends with an addition' });
    expect(mine.metadata?.author).toBe('Mark');
    expect(v.state.doc.toString()).not.toContain('Elias');
    // The cursor stays in it, for typing on
    expect(v.state.selection.main.head).toBe(mine.contentTo);
    expectNoNesting(v);
  });

  it('pasted suggestions read as accepted: a deletion\'s text and comments go, a substitution keeps its new text', () => {
    const v = editor('', 0);
    paste(v, [
      `A {--${ELIAS}@@very --}quick {~~${ELIAS}@@red~>brown~~} fox `,
      `{==jumps==}{>>${ELIAS}@@Which way?<<} over {--${ELIAS}@@the--}{++${ELIAS}@@a++} dog.`,
    ].join(''));

    const ranges = v.state.field(criticMarkupField);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ type: 'addition', content: 'A quick brown fox jumps over a dog.' });
    expect(ranges[0].metadata?.author).toBe('Mark');
  });

  it('a change nested in a pasted addition is accepted with it', () => {
    // Mark's deletion of part of Elias's addition, as suggestion mode writes it
    const v = editor('', 0);
    paste(v, `{++${ELIAS}@@an {--{"author":"Mark","timestamp":2000}@@extra --}addition++}`);
    expect(v.state.field(criticMarkupField).map((r) => [r.type, r.content])).toEqual([['addition', 'an addition']]);
  });

  it('text without suggestions is wrapped as before', () => {
    const v = editor('Paste here: ', 12);
    paste(v, 'plain words');
    expect(rangesFrom(v, 12).map((r) => [r.type, r.content, r.metadata?.author])).toEqual([['addition', 'plain words', 'Mark']]);
  });

  it('pasted into an addition of your own, the text goes into it, not as a nested one', () => {
    const own = '{++{"author":"Mark","timestamp":2000}@@my words++}';
    const doc = `Start ${own} end`;
    const v = editor(doc, doc.indexOf('my words') + 'my '.length);
    paste(v, COPIED);

    expect(v.state.field(criticMarkupField).map((r) => [r.type, r.content])).toEqual([['addition', 'my ends with an additionwords']]);
    expectNoNesting(v);
  });

  it('pasted over a selection, the text goes in as the new text of your substitution', () => {
    const doc = 'Replace this here';
    const v = editor(doc, doc.indexOf('this'), doc.indexOf('this') + 4);
    paste(v, COPIED);

    const ranges = v.state.field(criticMarkupField);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ type: 'substitution', oldContent: 'this', newContent: 'ends with an addition' });
  });

  it('a whole line copied with nothing selected still goes in as a line of its own', () => {
    const line = `This line ends with {++${ELIAS}@@an addition++}`;
    const v = editor(`${line}\nSecond line`, 3);
    expect(copy(v)).toBe(line);
    v.dispatch({ selection: EditorSelection.cursor(v.state.doc.line(2).from + 3) });
    paste(v, line);

    // Above line 2, with its line break in the addition
    expect(v.state.doc.line(1).text).toBe(line);
    expect(v.state.doc.line(3).text).toBe('++}Second line');
    const added = rangesFrom(v, v.state.doc.line(2).from);
    expect(added.map((r) => [r.type, r.content])).toEqual([['addition', 'This line ends with an addition\n']]);
  });

  it('dropped text is taken in the same way', () => {
    const doc = 'Drop here: ';
    const v = editor(doc, 0);
    // What CodeMirror dispatches for text dropped from elsewhere
    v.dispatch({
      changes: { from: doc.length, insert: COPIED },
      selection: { anchor: doc.length, head: doc.length + COPIED.length },
      userEvent: 'input.drop',
    });
    expect(rangesFrom(v, doc.length).map((r) => [r.type, r.content])).toEqual([['addition', 'ends with an addition']]);
  });

  it('a paste of only someone\'s deletion adds nothing: accepted, there is no text', () => {
    const doc = 'Paste here: ';
    const v = editor(doc, doc.length);
    paste(v, `{--${ELIAS}@@gone--}`);
    expect(v.state.doc.toString()).toBe(doc);
  });

  it('in source mode too', () => {
    const doc = 'Paste here: ';
    const v = editor(doc, doc.length);
    toggleSourceMode(v, true);
    paste(v, COPIED);
    expect(rangesFrom(v, doc.length).map((r) => [r.type, r.content])).toEqual([['addition', 'ends with an addition']]);
  });

  it('outside suggestion mode a pasted suggestion stays as it is', () => {
    const doc = 'Paste here: ';
    const v = editor(doc, doc.length, doc.length, false);
    paste(v, COPIED);
    expect(v.state.doc.toString()).toBe(doc + COPIED);
    expect(parse(v.state.doc.toString()).map((r) => r.metadata?.author)).toEqual(['Elias']);
  });
});

describe('suggestion mode: pasted text keeps its authors', () => {
  const LUC = 1001;
  const ELIAS_CLIENT = 1002;
  const MARK = 2000;
  const DAY = new Date('2026-09-01T10:00:00').getTime();
  const views: EditorView[] = [];
  beforeEach(() => {
    setCurrentAuthor('Mark');
    forgetCopied();
  });
  afterEach(() => views.splice(0).forEach((v) => v.destroy()));

  /** Luc's line with Elias's addition in it, open in Mark's editor, which suggests */
  function setup() {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('contents');
    const parts: [number, string][] = [
      [LUC, 'This line ends with '],
      [ELIAS_CLIENT, `{++${ELIAS}@@an addition++}`],
      [LUC, '\nPaste here: '],
    ];
    for (const [client, text] of parts) {
      ydoc.clientID = client;
      ytext.insert(ytext.length, text);
    }
    registerClientMapping(ydoc, 'human:Luc', DAY, LUC);
    registerClientMapping(ydoc, 'human:Elias', DAY, ELIAS_CLIENT);
    ydoc.clientID = MARK;
    registerClientMapping(ydoc, 'human:Mark', Date.now(), MARK);
    const view = new EditorView({
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [keepAuthorship(ydoc, ytext), yCollab(ytext, null, { undoManager: false }), criticMarkupExtension()],
      }),
      parent: document.body,
    });
    views.push(view);
    view.dispatch({ effects: toggleSuggestionMode.of(true) });
    return { ydoc, ytext, view };
  }

  /** Who wrote the document from `from` on, as "author: text" per run */
  function authorsFrom(ydoc: Y.Doc, ytext: Y.Text, from: number): string[] {
    const actors = getClientActorMap(ydoc);
    const text = ytext.toString();
    return getAuthorshipRuns(ytext)
      .filter((r) => r.to > from)
      .map((r) => `${actors.get(r.client) ?? 'unknown'}: ${text.slice(Math.max(r.from, from), r.to)}`);
  }

  /** Paste `text` at the end of the document; returns the authors of what went in */
  function pasteAtEnd(setupResult: ReturnType<typeof setup>, text: string): string[] {
    const { ydoc, ytext, view } = setupResult;
    const at = view.state.doc.length;
    view.dispatch({ selection: EditorSelection.cursor(at) });
    paste(view, text);
    // Mark's opening delimiter and metadata, as written
    const opening = ytext.toString().slice(at, ytext.toString().indexOf('@@', at) + 2);
    return authorsFrom(ydoc, ytext, at).map((run) => run.replace(opening, '<opening>'));
  }

  it('text copied with someone\'s addition in it keeps its authors, the addition\'s text too', () => {
    const s = setup();
    const from = s.view.state.doc.toString().indexOf('ends');
    s.view.dispatch({ selection: EditorSelection.range(from, s.view.state.doc.line(1).to) });
    expect(copy(s.view)).toBe(COPIED);

    expect(pasteAtEnd(s, COPIED)).toEqual([
      'human:Mark: <opening>',
      'human:Luc: ends with ',
      'human:Elias: an addition',
      'human:Mark: ++}',
    ]);
  });

  it('so does plain text (suggestion mode used to lose the paste\'s user event, and with it the authors)', () => {
    const s = setup();
    s.view.dispatch({ selection: EditorSelection.range(0, 'This line'.length) });
    expect(copy(s.view)).toBe('This line');
    expect(pasteAtEnd(s, 'This line')).toEqual(['human:Mark: <opening>', 'human:Luc: This line', 'human:Mark: ++}']);
  });

  it('text dragged in from another editor keeps its authors', () => {
    const source = setup();
    const from = source.view.state.doc.toString().indexOf('ends');
    source.view.dispatch({ selection: EditorSelection.range(from, source.view.state.doc.line(1).to) });
    const dragstart = new DragEvent('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(dragstart, 'dataTransfer', { value: new DataTransfer() });
    source.view.contentDOM.dispatchEvent(dragstart);

    const { ydoc, ytext, view } = setup();
    const at = view.state.doc.length;
    // What CodeMirror dispatches for a drop from elsewhere
    view.dispatch({ changes: { from: at, insert: COPIED }, selection: { anchor: at, head: at + COPIED.length }, userEvent: 'input.drop' });
    const opening = ytext.toString().slice(at, ytext.toString().indexOf('@@', at) + 2);
    expect(authorsFrom(ydoc, ytext, at).map((run) => run.replace(opening, '<opening>'))).toEqual([
      'human:Mark: <opening>',
      'human:Luc: ends with ',
      'human:Elias: an addition',
      'human:Mark: ++}',
    ]);
  });
});
