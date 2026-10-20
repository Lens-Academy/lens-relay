// src/components/Editor/extensions/criticmarkup-keymap.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import { EditorState } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { setCurrentAuthor, toggleSuggestionMode } from './criticmarkup';
import { suggestionsForKey } from './criticmarkup-commands';
import { createSectionEditorView } from '../../SectionEditor/createSectionEditorView';
import { editorKeymaps } from '../../../test/codemirror-helpers';

const OWN = '{"author":"Mark","timestamp":1000}';
const OTHER = '{"author":"Elias","timestamp":1000}';

/**
 * An editor with the keymaps of Editor.tsx, in its order: CodeMirror's
 * defaultKeymap (Mod-Enter insertBlankLine, Mod-Backspace deleteGroupBackward)
 * well ahead of criticMarkupExtension
 */
function mainEditor(
  doc: string,
  selection: { anchor: number; head?: number },
  opts: { readOnly?: boolean; canAcceptReject?: boolean; suggesting?: boolean } = {},
): EditorView {
  const { readOnly = false, canAcceptReject = true, suggesting = false } = opts;
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection,
      extensions: [
        ...(readOnly ? [EditorView.editable.of(false), EditorState.readOnly.of(true)] : []),
        markdown({ base: markdownLanguage, addKeymap: false }),
        editorKeymaps({ readOnly, canAcceptReject }),
      ],
    }),
  });
  if (suggesting) view.dispatch({ effects: toggleSuggestionMode.of(true) });
  return view;
}

/** A real key press through the editor's keymaps: Ctrl outside a Mac */
function press(view: EditorView, key: 'Enter' | 'Backspace'): void {
  runScopeHandlers(view, new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true }), 'editor');
}

const text = (view: EditorView) => view.state.doc.toString();

describe('Ctrl+Enter / Ctrl+Backspace with the keymaps of Editor.tsx', () => {
  const views: EditorView[] = [];
  const editor = (...args: Parameters<typeof mainEditor>) => {
    const view = mainEditor(...args);
    views.push(view);
    return view;
  };

  beforeEach(() => setCurrentAuthor('Mark'));
  afterEach(() => {
    views.splice(0).forEach((v) => v.destroy());
    setCurrentAuthor('anonymous');
  });

  it('accept and reject the suggestion at the cursor', () => {
    // Cursor after "w" of world
    let view = editor('hello {++world++} end', { anchor: 10 });
    press(view, 'Enter');
    expect(text(view)).toBe('hello world end');

    view = editor('hello {++world++} end', { anchor: 10 });
    press(view, 'Backspace');
    expect(text(view)).toBe('hello  end');

    const deletion = `a {--${OTHER}@@gone--} b`;
    view = editor(deletion, { anchor: deletion.indexOf('gone') + 2 });
    press(view, 'Enter');
    expect(text(view)).toBe('a  b');

    view = editor('a {~~old~>new~~} b', { anchor: 6 });
    press(view, 'Backspace');
    expect(text(view)).toBe('a old b');
  });

  it('keep their usual meaning away from suggestions', () => {
    let view = editor('hello world {++x++}', { anchor: 11 });
    press(view, 'Enter');
    expect(text(view)).toBe('hello world {++x++}\n');

    view = editor('hello world {++x++}', { anchor: 11 });
    press(view, 'Backspace');
    expect(text(view)).toBe('hello  {++x++}');
  });

  it('keep their usual meaning right before and right after a suggestion, where you type next to it', () => {
    // Before its opening delimiter: the word before goes
    let view = editor('one {++two++} three', { anchor: 4 });
    press(view, 'Backspace');
    expect(text(view)).toBe('{++two++} three');

    // After its closing delimiter (and its ✓ ✗): a new line, and Ctrl+Backspace
    // is left to word deletion
    view = editor('one {++two++} three', { anchor: 13 });
    expect(suggestionsForKey(view, 'reject')).toEqual([]);
    press(view, 'Enter');
    expect(text(view)).toBe('one {++two++} three\n');
  });

  it('take both halves of a deletion+addition pair, as its one ✓ ✗ do', () => {
    const pair = `A pair: {--${OTHER}@@old words--}{++${OTHER}@@new words++} here.`;
    const inNewWords = pair.indexOf('new words') + 4;

    let view = editor(pair, { anchor: inNewWords });
    press(view, 'Enter');
    expect(text(view)).toBe('A pair: new words here.');

    view = editor(pair, { anchor: pair.indexOf('old words') + 4 });
    press(view, 'Backspace');
    expect(text(view)).toBe('A pair: old words here.');
  });

  it('leave comments and highlights alone', () => {
    // Before a comment: Ctrl+Backspace deletes the word, the comment stays
    let view = editor('hello{>>note<<} world', { anchor: 5 });
    press(view, 'Backspace');
    expect(text(view)).toBe('{>>note<<} world');

    // Right after a comment's badge: Ctrl+Enter starts a new line
    view = editor('hello {>>note<<} world', { anchor: 16 });
    press(view, 'Enter');
    expect(text(view)).toBe('hello {>>note<<} world\n');

    // In highlighted text: the word goes, the highlight stays
    view = editor('see {==very important==} text', { anchor: 11 });
    press(view, 'Backspace');
    expect(text(view)).toBe('see {== important==} text');
  });

  it('with a selection, take the suggestions in it and never a comment', () => {
    const doc = '{++a++} x {>>note<<} {--b--}';
    let view = editor(doc, { anchor: 0, head: doc.length });
    press(view, 'Enter');
    expect(text(view)).toBe('a x {>>note<<} ');

    view = editor(doc, { anchor: 0, head: doc.length });
    press(view, 'Backspace');
    expect(text(view)).toBe(' x {>>note<<} b');

    // Selected plain text next to a suggestion: deleted, the suggestion stays
    view = editor('one two {++three++}', { anchor: 4, head: 8 });
    press(view, 'Backspace');
    expect(text(view)).toBe('one {++three++}');
  });

  it('in suggestion mode, Ctrl+Backspace goes on deleting words in your own suggestion', () => {
    // Typing a suggestion: the cursor is in your own addition
    const typed = `I {++${OWN}@@typed two words++} here`;
    let view = editor(typed, { anchor: typed.indexOf('++} here') }, { suggesting: true });
    press(view, 'Backspace');
    expect(text(view)).toBe(`I {++${OWN}@@typed two ++} here`);

    // Ctrl+Backspace twice from plain text: the first press suggests deleting
    // "three" and leaves the cursor in that deletion; the second must not
    // reject it, which would bring "three" back
    view = editor('one two three', { anchor: 13 }, { suggesting: true });
    press(view, 'Backspace');
    expect(text(view)).toMatch(/^one two \{--\{"author":"Mark","timestamp":\d+\}@@three--\}$/);
    press(view, 'Backspace');
    expect(text(view)).not.toBe('one two three');
    expect(text(view)).toMatch(/\{--\{"author":"Mark","timestamp":\d+\}@@[^-]*three--\}$/);
  });

  it('in suggestion mode, still accept and reject other people\'s suggestions, and accept your own', () => {
    const theirs = `I {++${OTHER}@@their words++} here`;
    let view = editor(theirs, { anchor: theirs.indexOf('words') }, { suggesting: true });
    press(view, 'Backspace');
    expect(text(view)).toBe('I  here');

    view = editor(theirs, { anchor: theirs.indexOf('words') }, { suggesting: true });
    press(view, 'Enter');
    expect(text(view)).toBe('I their words here');

    const mine = `I {++${OWN}@@my words++} here`;
    view = editor(mine, { anchor: mine.indexOf('words') }, { suggesting: true });
    press(view, 'Enter');
    expect(text(view)).toBe('I my words here');
  });

  it('do what CodeMirror does for users who can\'t accept or reject', () => {
    // Suggest role: may edit, not accept or reject
    let view = editor('hello {++big world++} end', { anchor: 18 }, { canAcceptReject: false });
    press(view, 'Backspace');
    expect(text(view)).toBe('hello {++big ++} end');

    view = editor('hello {++big world++} end', { anchor: 18 }, { canAcceptReject: false });
    press(view, 'Enter');
    expect(text(view)).toBe('hello {++big world++} end\n');

    // View role: read-only, the keys change nothing
    view = editor('hello {++big world++} end', { anchor: 18 }, { readOnly: true, canAcceptReject: false });
    press(view, 'Enter');
    press(view, 'Backspace');
    expect(text(view)).toBe('hello {++big world++} end');
  });

  it('suggestionsForKey names what the keys act on', () => {
    const doc = `x {--${OTHER}@@old--}{++${OTHER}@@new++} y {>>note<<} z {++${OWN}@@mine++}`;
    const at = (needle: string) => doc.indexOf(needle) + 1;

    const pair = editor(doc, { anchor: at('new++') });
    expect(suggestionsForKey(pair, 'accept').map((r) => r.type)).toEqual(['deletion', 'addition']);
    expect(suggestionsForKey(editor(doc, { anchor: at('note') }), 'reject')).toEqual([]);
    expect(suggestionsForKey(editor(doc, { anchor: at('mine') }, { canAcceptReject: false }), 'accept')).toEqual([]);

    const mine = editor(doc, { anchor: at('mine') }, { suggesting: true });
    expect(suggestionsForKey(mine, 'reject')).toEqual([]);
    expect(suggestionsForKey(mine, 'accept').map((r) => r.content)).toEqual(['mine']);
  });
});

describe('Ctrl+Enter / Ctrl+Backspace in the course section editors', () => {
  // createSectionEditorView lists defaultKeymap ahead of criticMarkupExtension too
  function sectionEditor(text: string, cursor: number): EditorView {
    const ytext = new Y.Doc().getText('contents');
    ytext.insert(0, text);
    const view = createSectionEditorView({
      ytext,
      sectionFrom: 0,
      sectionTo: text.length,
      parent: document.body,
      enableCriticMarkup: true,
    });
    view.dispatch({ selection: { anchor: cursor } });
    return view;
  }

  it('accept and reject the suggestion at the cursor', () => {
    let view = sectionEditor('hello {++world++} end', 10);
    press(view, 'Enter');
    expect(view.state.doc.toString()).toBe('hello world end');
    view.destroy();

    view = sectionEditor('hello {++world++} end', 10);
    press(view, 'Backspace');
    expect(view.state.doc.toString()).toBe('hello  end');
    view.destroy();

    view = sectionEditor('hello world {++x++}', 11);
    press(view, 'Backspace');
    expect(view.state.doc.toString()).toBe('hello  {++x++}');
    view.destroy();
  });
});
