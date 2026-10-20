// src/components/Editor/extensions/criticmarkup-copy.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, drawSelection } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { parse } from '../../../lib/criticmarkup-parser';
import { criticMarkupExtension } from './criticmarkup';
import { toggleSourceMode } from './livePreview';
import { copyEvent, createCriticMarkupEditorWithSourceMode, dragStartEvent } from '../../../test/codemirror-helpers';

const OTHER = '{"author":"Elias","timestamp":1000}';

// "Plain inserted text"
const doc = `Plain {++${OTHER}@@inserted++} text`;
const contentFrom = doc.indexOf('inserted');
const contentTo = contentFrom + 'inserted'.length;
const end = contentTo + '++}'.length;

describe('copying part of a suggestion (live preview)', () => {
  let view: EditorView | undefined;
  const destroy = () => {
    view?.destroy();
    view = undefined;
  };
  afterEach(destroy);

  function editor(text: string, anchor: number, head = anchor): EditorView {
    destroy();
    view = new EditorView({
      state: EditorState.create({
        doc: text,
        selection: { anchor, head },
        extensions: [
          EditorState.allowMultipleSelections.of(true),
          drawSelection(),
          markdown({ base: markdownLanguage, addKeymap: false }),
          criticMarkupExtension(),
        ],
      }),
      parent: document.body,
    });
    return view;
  }

  it('a selection that runs into a suggestion copies only the text shown in it', () => {
    // "Pl[ain ins]erted text"
    expect(copyEvent(editor(doc, 2, contentFrom + 3)).text).toBe('ain ins');
  });

  it('a selection that runs out of a suggestion copies only the text shown in it', () => {
    // "Plain inser[ted te]xt"
    expect(copyEvent(editor(doc, contentTo - 3, end + 3)).text).toBe('ted te');
  });

  it('a suggestion the selection covers whole goes as it is, markup and all', () => {
    expect(copyEvent(editor(doc, 2, end + 3)).text).toBe(`ain {++${OTHER}@@inserted++} te`);
  });

  it('a selection that leaves out only its closing delimiter copies the text shown', () => {
    // On screen the same as the one above: the closing delimiter shows nothing
    expect(copyEvent(editor(doc, 2, contentTo)).text).toBe('ain inserted');
  });

  it('a selection within a suggestion\'s text copies that text', () => {
    expect(copyEvent(editor(doc, contentFrom + 2, contentFrom + 5)).text).toBe('ser');
  });

  it('in a deletion+addition pair, copies the text shown of each', () => {
    // "A o[ld ne]w b"
    const pair = `A {--${OTHER}@@old--}{++${OTHER}@@new++} b`;
    expect(copyEvent(editor(pair, pair.indexOf('old') + 1, pair.indexOf('new') + 2)).text).toBe('ldne');
  });

  it('takes a comment the selection covers whole, and leaves out one it covers part of', () => {
    // A highlight and its comment: "Some high[lighted¹ af]ter"
    const commented = `Some {==highlighted==}{>>${OTHER}@@A note<<} after`;
    const after = commented.indexOf(' after');
    expect(copyEvent(editor(commented, commented.indexOf('lighted'), after + 3)).text)
      .toBe(`lighted{>>${OTHER}@@A note<<} af`);
    // An older comment written over two lines, the selection ending in it
    expect(copyEvent(editor('one {>>note\nmore<<} two', 0, 8)).text).toBe('one ');
  });

  it('a whole-line copy (nothing selected) of a line that a suggestion runs on from copies its text shown', () => {
    expect(copyEvent(editor('{++one\ntwo++} three', 4)).text).toBe('one');
  });

  it('copies each selected range so', () => {
    const v = editor(doc, 0);
    v.dispatch({ selection: EditorSelection.create([EditorSelection.range(0, 2), EditorSelection.range(3, contentFrom + 3)]) });
    expect(copyEvent(v).text).toBe('Pl\nin ins');
  });

  it('a drag carries only the text shown, too', () => {
    expect(dragStartEvent(editor(doc, 2, contentFrom + 3))).toBe('ain ins');
  });

  it('a selection of only a suggestion\'s hidden opening copies nothing', () => {
    // As Shift+ArrowRight right before a suggestion selects: nothing shows
    expect(copyEvent(editor(doc, contentFrom - OTHER.length - 5, contentFrom))).toEqual({ text: '', handled: true });
  });

  it('cut and paste moves the text shown, and every suggestion stays whole', () => {
    const v = editor(`${doc}\nLast {++line++}`, 2, contentFrom + 3);
    const { text } = copyEvent(v);
    // CodeMirror's cut after the copy: the selected ranges, deleted
    v.dispatch({ changes: [{ from: 2, to: contentFrom + 3 }], userEvent: 'delete.cut' });
    const line2 = v.state.doc.line(2).from;
    v.dispatch({ changes: { from: line2, insert: text }, userEvent: 'input.paste' });
    expect(v.state.doc.toString()).toBe(`Pl{++${OTHER}@@erted++} text\nain insLast {++line++}`);
    // What the raw selection would have pasted: `ain {++…@@ins`, running on to `line++}`
    expect(parse(v.state.doc.toString()).map((r) => r.content)).toEqual(['erted', 'line']);
  });
});

describe('copying in source mode', () => {
  it('takes the syntax that source mode shows as it is', () => {
    const { view, cleanup } = createCriticMarkupEditorWithSourceMode(doc, 0);
    toggleSourceMode(view, true);
    view.dispatch({ selection: { anchor: 2, head: contentFrom + 3 } });
    expect(copyEvent(view).text).toBe(`ain {++${OTHER}@@ins`);
    cleanup();
  });
});
