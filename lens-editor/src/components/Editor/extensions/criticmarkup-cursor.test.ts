// src/components/Editor/extensions/criticmarkup-cursor.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view';
import { cursorCharLeft, cursorCharRight, defaultKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { parse } from '../../../lib/criticmarkup-parser';
import { criticMarkupExtension, toggleSuggestionMode } from './criticmarkup';
import { hiddenSyntaxSpans, moveOutOfHiddenSyntax } from './criticmarkup-cursor';
import { toggleSourceMode } from './livePreview';
import { createCriticMarkupEditorWithSourceMode } from '../../../test/codemirror-helpers';

// The default author of suggestion mode, so these count as the user's own
const OWN = '{"author":"anonymous","timestamp":1000}';
const OTHER = '{"author":"Elias","timestamp":1000}';

describe('hiddenSyntaxSpans', () => {
  it('covers a suggestion\'s delimiters, with its metadata', () => {
    expect(hiddenSyntaxSpans(parse('a {++new++} b'))).toEqual([
      { from: 2, to: 5 },
      { from: 8, to: 11 },
    ]);
    const doc = `{--${OTHER}@@old--}`;
    expect(hiddenSyntaxSpans(parse(doc))).toEqual([
      { from: 0, to: `{--${OTHER}@@`.length },
      { from: doc.length - 3, to: doc.length },
    ]);
  });

  it('covers a whole comment, which shows as a badge', () => {
    expect(hiddenSyntaxSpans(parse('word{>>note<<} more'))).toEqual([{ from: 4, to: 14 }]);
  });

  it('joins spans that touch: a deletion+addition pair, a highlight\'s comment, a thread', () => {
    expect(hiddenSyntaxSpans(parse('{--old--}{++new++}'))).toEqual([
      { from: 0, to: 3 },
      { from: 6, to: 12 },
      { from: 15, to: 18 },
    ]);
    expect(hiddenSyntaxSpans(parse('{==text==}{>>note<<}'))).toEqual([
      { from: 0, to: 3 },
      { from: 7, to: 20 },
    ]);
    expect(hiddenSyntaxSpans(parse('x{>>one<<}{>>two<<}'))).toEqual([{ from: 1, to: 19 }]);
  });

  it('is empty without CriticMarkup', () => {
    expect(hiddenSyntaxSpans(parse('plain {+ text +}'))).toEqual([]);
  });
});

describe('moveOutOfHiddenSyntax', () => {
  // `{++An added line++}`: hidden 0-3 and 16-19
  const spans = hiddenSyntaxSpans(parse('{++An added line++}'));
  const cursor = (pos: number, goal?: number) =>
    EditorSelection.create([EditorSelection.cursor(pos, 0, undefined, goal)]);

  it('steps a cursor across hidden syntax in the direction it moved', () => {
    expect(moveOutOfHiddenSyntax(cursor(1), cursor(0), spans)?.main.head).toBe(3);
    expect(moveOutOfHiddenSyntax(cursor(2), cursor(3), spans)?.main.head).toBe(0);
    // Home from the line's end, End from its start
    expect(moveOutOfHiddenSyntax(cursor(1), cursor(19), spans)?.main.head).toBe(0);
    expect(moveOutOfHiddenSyntax(cursor(18), cursor(0), spans)?.main.head).toBe(19);
  });

  it('takes the nearer edge for a cursor that was inside already', () => {
    expect(moveOutOfHiddenSyntax(cursor(17), cursor(17), spans)?.main.head).toBe(16);
    expect(moveOutOfHiddenSyntax(cursor(18), cursor(17), spans)?.main.head).toBe(19);
  });

  it('keeps the column a vertical move aims for', () => {
    expect(moveOutOfHiddenSyntax(cursor(1, 40), cursor(25), spans)?.main.goalColumn).toBe(40);
  });

  it('moves the head of a selection and keeps its anchor', () => {
    const selection = EditorSelection.create([EditorSelection.range(10, 1)]);
    const moved = moveOutOfHiddenSyntax(selection, EditorSelection.create([EditorSelection.cursor(10)]), spans);
    expect(moved?.main.anchor).toBe(10);
    expect(moved?.main.head).toBe(0);
  });

  it('returns null when no selection end is in hidden syntax', () => {
    expect(moveOutOfHiddenSyntax(cursor(3), cursor(0), spans)).toBeNull();
    expect(moveOutOfHiddenSyntax(cursor(19), cursor(16), spans)).toBeNull();
  });
});

describe('the cursor in the editor (live preview)', () => {
  let view: EditorView | undefined;
  afterEach(() => view?.destroy());

  /** An editor with Editor.tsx's keymap setup, cursor at `pos` */
  function editor(doc: string, pos: number): EditorView {
    view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: pos },
        extensions: [
          markdown({ base: markdownLanguage, addKeymap: false }),
          keymap.of(defaultKeymap),
          criticMarkupExtension(),
        ],
      }),
      parent: document.body,
    });
    return view;
  }

  function press(v: EditorView, key: string) {
    runScopeHandlers(v, new KeyboardEvent('keydown', { key }), 'editor');
  }

  const head = (v: EditorView) => v.state.selection.main.head;

  it('arrow keys cross a delimiter and its metadata in one press', () => {
    const doc = `a {++${OTHER}@@new++} b`;
    const contentFrom = doc.indexOf('new');
    const v = editor(doc, 2);
    cursorCharRight(v);
    expect(head(v)).toBe(contentFrom);
    cursorCharRight(v);
    expect(head(v)).toBe(contentFrom + 1);
    cursorCharLeft(v);
    cursorCharLeft(v);
    expect(head(v)).toBe(2);
  });

  it('arrow keys cross a comment badge in one press', () => {
    const v = editor('word{>>note<<} more', 4);
    cursorCharRight(v);
    expect(head(v)).toBe(14);
    cursorCharLeft(v);
    expect(head(v)).toBe(4);
  });

  it('a cursor move into hidden syntax ends at its edge', () => {
    // As Home on a wrapped line, which finds the line's start by screen position
    const v = editor('{++An added line++}', 19);
    v.dispatch({ selection: { anchor: 1 }, userEvent: 'select' });
    expect(head(v)).toBe(0);
  });

  it('leaves a selection that a command sets alone', () => {
    const v = editor('{++An added line++}', 19);
    v.dispatch({ selection: { anchor: 1 } });
    expect(head(v)).toBe(1);
  });

  it('Backspace after a suggestion deletes its last character, not its delimiter', () => {
    const v = editor('{++An added line++}', 19);
    press(v, 'Backspace');
    expect(v.state.doc.toString()).toBe('{++An added lin++}');
  });

  it('Backspace at the start of a suggestion\'s text deletes the character before the suggestion', () => {
    const v = editor('ab{++new++}', 5);
    press(v, 'Backspace');
    expect(v.state.doc.toString()).toBe('a{++new++}');
  });

  it('Delete before a suggestion deletes its first character; Delete at its end the one after it', () => {
    const v = editor('{++new++}ab', 0);
    press(v, 'Delete');
    expect(v.state.doc.toString()).toBe('{++ew++}ab');
    v.dispatch({ selection: { anchor: 5 } }); // end of "ew"
    press(v, 'Delete');
    expect(v.state.doc.toString()).toBe('{++ew++}b');
  });

  it('Backspace and Delete pass a comment badge and keep the comment', () => {
    const v = editor('Some {==text==}{>>note<<} here', 25);
    press(v, 'Backspace');
    expect(v.state.doc.toString()).toBe('Some {==tex==}{>>note<<} here');
    v.dispatch({ selection: { anchor: 11 } }); // end of "tex"
    press(v, 'Delete');
    expect(v.state.doc.toString()).toBe('Some {==tex==}{>>note<<}here');
  });

  it('in suggestion mode, Backspace after your own addition takes a character off it', () => {
    const doc = `{++${OWN}@@An added line++}`;
    const v = editor(doc, doc.length);
    v.dispatch({ effects: toggleSuggestionMode.of(true) });
    press(v, 'Backspace');
    expect(v.state.doc.toString()).toBe(`{++${OWN}@@An added lin++}`);
  });

  it('in suggestion mode, Backspace after someone else\'s addition suggests deleting its last character', () => {
    const doc = `{++${OTHER}@@An added line++}`;
    const v = editor(doc, doc.length);
    v.dispatch({ effects: toggleSuggestionMode.of(true) });
    press(v, 'Backspace');
    const after = v.state.doc.toString();
    expect(after).toMatch(new RegExp(`^\\{\\+\\+\\{"author":"Elias".*@@An added lin\\{--.*@@e--\\}\\+\\+\\}$`));
    expect(parse(after).map((r) => r.type)).toEqual(['addition', 'deletion']);
  });
});

describe('the cursor in source mode', () => {
  it('stops inside the syntax, which source mode shows', () => {
    const { view, cleanup } = createCriticMarkupEditorWithSourceMode('a {++new++} b', 2);
    toggleSourceMode(view, true);
    cursorCharRight(view);
    expect(view.state.selection.main.head).toBe(3);
    cleanup();
  });
});
