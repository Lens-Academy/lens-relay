// src/components/Editor/extensions/criticmarkup-delete.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view';
import { defaultKeymap, deleteLine } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { parse } from '../../../lib/criticmarkup-parser';
import { criticMarkupExtension, toggleSuggestionMode } from './criticmarkup';
import { acceptChangeAtCursor } from './criticmarkup-commands';
import { keepHiddenSyntax } from './criticmarkup-delete';
import { toggleSourceMode } from './livePreview';
import { createCriticMarkupEditorWithSourceMode } from '../../../test/codemirror-helpers';

// The default author of suggestion mode, so these count as the user's own
const OWN = '{"author":"anonymous","timestamp":1000}';
const OTHER = '{"author":"Elias","timestamp":1000}';
// Suggestion mode writes {"author":"anonymous","timestamp":<now>}@@
const MINE = '\\{"author":"anonymous","timestamp":\\d+\\}@@';
const escape = (s: string) => s.replace(/[{}()[\]+*?.^$|\\]/g, '\\$&');

describe('keepHiddenSyntax', () => {
  // `ab{++cd++}ef`: hidden 2-5 and 7-10, its text 5-7
  const ranges = parse('ab{++cd++}ef');

  it('keeps the opening delimiter of a suggestion that a deletion runs into', () => {
    expect(keepHiddenSyntax([{ from: 1, to: 6 }], ranges, true)).toEqual([{ from: 1, to: 2 }, { from: 5, to: 6 }]);
  });

  it('keeps the closing delimiter of a suggestion that a deletion runs out of', () => {
    expect(keepHiddenSyntax([{ from: 6, to: 11 }], ranges, true)).toEqual([{ from: 6, to: 7 }, { from: 10, to: 11 }]);
  });

  it('deletes a suggestion that a deletion covers whole', () => {
    expect(keepHiddenSyntax([{ from: 1, to: 11 }], ranges, true)).toEqual([{ from: 1, to: 11 }]);
  });

  it('removes a suggestion whose text all goes, unless told not to', () => {
    expect(keepHiddenSyntax([{ from: 1, to: 7 }], ranges, true)).toEqual([{ from: 1, to: 10 }]);
    expect(keepHiddenSyntax([{ from: 5, to: 7 }], ranges, true)).toEqual([{ from: 2, to: 10 }]);
    expect(keepHiddenSyntax([{ from: 1, to: 7 }], ranges, false)).toEqual([{ from: 1, to: 2 }, { from: 5, to: 7 }]);
  });

  it('keeps the metadata with the delimiter', () => {
    const doc = `a {++${OTHER}@@new++} b`;
    const contentFrom = doc.indexOf('new');
    expect(keepHiddenSyntax([{ from: 1, to: contentFrom + 1 }], parse(doc), true))
      .toEqual([{ from: 1, to: 2 }, { from: contentFrom, to: contentFrom + 1 }]);
  });

  it('keeps a comment that a deletion covers only part of whole, and deletes one it covers', () => {
    // An older comment written over two lines: deleting the first line
    const doc = 'one {>>note\nmore<<} two';
    expect(keepHiddenSyntax([{ from: 0, to: 12 }], parse(doc), true)).toEqual([{ from: 0, to: 4 }]);
    expect(keepHiddenSyntax([{ from: 0, to: 19 }], parse(doc), true)).toEqual([{ from: 0, to: 19 }]);
  });

  it('in a deletion+addition pair, deletes the deletion it covers and keeps the addition\'s opening', () => {
    // `{--old--}{++new++}`: the addition's text is 12-15
    expect(keepHiddenSyntax([{ from: 0, to: 13 }], parse('{--old--}{++new++}'), true))
      .toEqual([{ from: 0, to: 9 }, { from: 12, to: 13 }]);
  });

  it('leaves a deletion that touches no hidden syntax as it is', () => {
    expect(keepHiddenSyntax([{ from: 0, to: 2 }, { from: 5, to: 6 }], ranges, true))
      .toEqual([{ from: 0, to: 2 }, { from: 5, to: 6 }]);
  });
});

describe('deleting in the editor (live preview)', () => {
  let view: EditorView | undefined;
  afterEach(() => view?.destroy());

  /**
   * An editor with Editor.tsx's keymap order, CodeMirror's default keymap
   * ahead of the CriticMarkup one, or with `embedOrder` the other way round,
   * as embedded notes have it
   */
  function editor(doc: string, anchor: number, head = anchor, embedOrder = false): EditorView {
    const keys = keymap.of(defaultKeymap);
    view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor, head },
        extensions: [
          markdown({ base: markdownLanguage, addKeymap: false }),
          embedOrder ? [criticMarkupExtension(), keys] : [keys, criticMarkupExtension()],
        ],
      }),
      parent: document.body,
    });
    return view;
  }

  function press(v: EditorView, key: string, modifiers: KeyboardEventInit = {}) {
    runScopeHandlers(v, new KeyboardEvent('keydown', { key, ...modifiers }), 'editor');
  }

  const text = (v: EditorView) => v.state.doc.toString();
  const head = (v: EditorView) => v.state.selection.main.head;
  const suggesting = (v: EditorView) => v.dispatch({ effects: toggleSuggestionMode.of(true) });
  const type = (v: EditorView, typed: string) => v.dispatch({ ...v.state.replaceSelection(typed), userEvent: 'input.type' });

  describe('word deletion', () => {
    it('Ctrl+Delete before a suggestion deletes the word shown, and the suggestion it empties', () => {
      const v = editor('text {++inserted++} more', 4);
      press(v, 'Delete', { ctrlKey: true });
      expect(text(v)).toBe('text more');
      expect(head(v)).toBe(4);
    });

    it('the same with metadata, which CodeMirror\'s word deletion took with the delimiter', () => {
      const v = editor(`text {++${OTHER}@@inserted++} more`, 4);
      press(v, 'Delete', { ctrlKey: true });
      expect(text(v)).toBe('text more');
    });

    it('Ctrl+Backspace after a suggestion and a space deletes its word, not `++} `', () => {
      const v = editor('a {++abc++} more', 12);
      press(v, 'Backspace', { ctrlKey: true });
      expect(text(v)).toBe('a more');
      expect(head(v)).toBe(2);
    });

    it('Ctrl+Backspace right after a suggestion deletes the last word shown in it', () => {
      const v = editor(`Plain {++${OTHER}@@some words++}`, `Plain {++${OTHER}@@some words++}`.length);
      press(v, 'Backspace', { ctrlKey: true });
      expect(text(v)).toBe(`Plain {++${OTHER}@@some ++}`);
    });

    it('where the editor gives Ctrl+Backspace to the reject shortcut first, it still rejects', () => {
      const doc = `Plain {++${OTHER}@@some words++}`;
      const v = editor(doc, doc.length, doc.length, true);
      press(v, 'Backspace', { ctrlKey: true });
      expect(text(v)).toBe('Plain ');
    });

    it('deletes a word that a suggestion splits as one word', () => {
      // "say inserted more", the cursor after "inserted"
      const v = editor('say in{++serted++} more', 18);
      press(v, 'Backspace', { ctrlKey: true });
      expect(text(v)).toBe('say  more');
    });

    it('Ctrl+Delete before a comment badge deletes the word after it and keeps the comment', () => {
      const v = editor('word{>>note<<} next', 4);
      press(v, 'Delete', { ctrlKey: true });
      expect(text(v)).toBe('word{>>note<<}');
    });

    it('Ctrl+Delete before a badge at a line\'s end deletes the line break after it', () => {
      const v = editor('word{>>note<<}\nnext', 4);
      press(v, 'Delete', { ctrlKey: true });
      expect(text(v)).toBe('word{>>note<<}next');
    });

    it('in suggestion mode, Ctrl+Backspace after someone else\'s addition suggests deleting its last word', () => {
      const doc = `{++${OTHER}@@some words++}`;
      const v = editor(doc, doc.length);
      suggesting(v);
      press(v, 'Backspace', { ctrlKey: true });
      expect(text(v)).toMatch(new RegExp(`^\\{\\+\\+${escape(OTHER)}@@some \\{--${MINE}words--\\}\\+\\+\\}$`));
    });

    it('with no hidden syntax in reach, leaves word deletion to CodeMirror', () => {
      const v = editor('one two {++three++}', 7);
      press(v, 'Backspace', { ctrlKey: true });
      expect(text(v)).toBe('one  {++three++}');
    });
  });

  describe('a selection over part of a suggestion', () => {
    // "Plain inserted text": the selection "ain ins"
    const doc = `Plain {++${OTHER}@@inserted++} text`;
    const contentFrom = doc.indexOf('inserted');
    const contentTo = contentFrom + 'inserted'.length;

    it('Backspace deletes the text shown in it and keeps the suggestion\'s markup', () => {
      const v = editor(doc, 2, contentFrom + 3);
      press(v, 'Backspace');
      expect(text(v)).toBe(`Pl{++${OTHER}@@erted++} text`);
      expect(head(v)).toBe(2);
    });

    it('Delete on a selection from inside the suggestion out of it keeps its closing delimiter', () => {
      const v = editor(doc, contentTo - 3, contentTo + 3 + 3);
      press(v, 'Delete');
      expect(text(v)).toBe(`Plain {++${OTHER}@@inser++}xt`);
    });

    it('typing over it puts the text where the selection started', () => {
      const v = editor(doc, 2, contentFrom + 3);
      type(v, 'X');
      expect(text(v)).toBe(`PlX{++${OTHER}@@erted++} text`);
      expect(head(v)).toBe(3);
      type(v, 'Y');
      expect(text(v)).toBe(`PlXY{++${OTHER}@@erted++} text`);
    });

    it('typing over all of a suggestion\'s text replaces the suggestion', () => {
      const v = editor(doc, 'Plain '.length, contentTo);
      type(v, 'new');
      expect(text(v)).toBe('Plain new text');
    });

    it('typing over only its hidden opening (Shift+ArrowRight at its start) types before it', () => {
      const v = editor('ab{++cd++}', 2, 5);
      type(v, 'X');
      expect(text(v)).toBe('abX{++cd++}');
      expect(head(v)).toBe(3);
    });

    it('cut deletes the text shown in it', () => {
      // As CodeMirror's cut handler: the selected ranges, no selection
      const v = editor(doc, 2, contentFrom + 3);
      v.dispatch({ changes: [{ from: 2, to: contentFrom + 3 }], userEvent: 'delete.cut', scrollIntoView: true });
      expect(text(v)).toBe(`Pl{++${OTHER}@@erted++} text`);
    });

    it('a drag that moves it leaves the suggestion\'s markup where it was', () => {
      const v = editor(doc, 2, contentFrom + 3);
      const dragged = v.state.sliceDoc(2, contentFrom + 3);
      const changes = v.state.changes([{ from: 2, to: contentFrom + 3 }, { from: doc.length, insert: dragged }]);
      v.dispatch({ changes, userEvent: 'move.drop' });
      expect(text(v).startsWith(`Pl{++${OTHER}@@erted++} text`)).toBe(true);
    });

    it('deleting a line keeps the markup of a suggestion that goes on to the next', () => {
      const v = editor('{++one\ntwo++} three', 4);
      deleteLine(v);
      expect(text(v)).toBe('{++two++} three');
    });

    it('in suggestion mode, suggests deleting the text shown and keeps the other addition\'s markup', () => {
      const v = editor(doc, 2, contentFrom + 3);
      suggesting(v);
      press(v, 'Backspace');
      const after = text(v);
      expect(after).toMatch(new RegExp(
        `^Pl\\{--${MINE}ain --\\}\\{\\+\\+${escape(OTHER)}@@\\{--${MINE}ins--\\}erted\\+\\+\\} text$`,
      ));
      expect(parse(after).map((r) => r.type)).toEqual(['deletion', 'addition', 'deletion']);
    });
  });

  it('Backspace on the last character of someone else\'s addition removes it, instead of showing its metadata', () => {
    const doc = `a {++${OTHER}@@b++} c`;
    const v = editor(doc, doc.length - 2);
    press(v, 'Backspace');
    expect(text(v)).toBe('a  c');
  });

  it('in suggestion mode, deleting all of your own addition\'s text removes it as before', () => {
    const doc = `x {++${OWN}@@abc++} y`;
    const contentFrom = doc.indexOf('abc');
    const v = editor(doc, contentFrom, contentFrom + 3);
    suggesting(v);
    press(v, 'Backspace');
    expect(text(v)).toBe('x  y');
  });

  it('leaves edits without a user event alone: accepting a suggestion deletes its delimiters', () => {
    const v = editor('a {++new++} b', 5);
    acceptChangeAtCursor(v);
    expect(text(v)).toBe('a new b');
    v.destroy();
    const w = editor('a {++new++} b', 0);
    w.dispatch({ changes: { from: 0, to: 6 } });
    expect(text(w)).toBe('ew++} b');
  });
});

describe('deleting in source mode', () => {
  it('deletes the syntax that source mode shows', () => {
    const { view, cleanup } = createCriticMarkupEditorWithSourceMode('a {++new++} b', 0);
    toggleSourceMode(view, true);
    view.dispatch({ changes: { from: 0, to: 6 }, userEvent: 'delete.selection' });
    expect(view.state.doc.toString()).toBe('ew++} b');
    cleanup();
  });
});
