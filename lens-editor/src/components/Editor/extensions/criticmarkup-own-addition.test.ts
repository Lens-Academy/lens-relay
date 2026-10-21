// src/components/Editor/extensions/criticmarkup-own-addition.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { indentUnit } from '@codemirror/language';
import { defaultKeymap, indentLess, indentMore } from '@codemirror/commands';
import { criticMarkupExtension, criticMarkupField, setCurrentAuthor, toggleSuggestionMode } from './criticmarkup';
import { tightMarkdownKeymap } from './tightListEnter';

// Mark suggests, and the addition with the cursor in it is his
const mark = '{"author":"Mark","timestamp":1000}';
const now = '{"author":"Mark","timestamp":2000}';
const yours = `{++${mark}@@my words++}`;
const textFrom = `{++${mark}@@`.length;
const textTo = textFrom + 'my words'.length;

const views: EditorView[] = [];

/**
 * An editor in suggestion mode for a user who can only suggest, with Editor.tsx's
 * keymaps for the keys pressed here, in its order: CodeMirror's defaultKeymap
 * (Mod-Enter is insertBlankLine, which adds a line below the cursor's line) and
 * Tab / Shift-Tab (indentMore, indentLess at the line's start) ahead of
 * criticMarkupExtension
 */
function suggesting(doc: string, anchor: number, head = anchor): EditorView {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: { anchor, head },
      extensions: [
        indentUnit.of('\t'),
        keymap.of(defaultKeymap),
        markdown({ base: markdownLanguage, addKeymap: false }),
        Prec.high(keymap.of(tightMarkdownKeymap)),
        keymap.of([
          { key: 'Tab', run: indentMore },
          { key: 'Shift-Tab', run: indentLess },
        ]),
        criticMarkupExtension({ canAcceptReject: false }),
      ],
    }),
  });
  view.dispatch({ effects: toggleSuggestionMode.of(true) });
  views.push(view);
  return view;
}

/** A real key press through the editor's keymaps (Ctrl outside a Mac) */
function press(view: EditorView, key: string, mods: { ctrl?: boolean; shift?: boolean } = {}): void {
  const event = new KeyboardEvent('keydown', {
    key,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    bubbles: true,
    cancelable: true,
  });
  runScopeHandlers(view, event, 'editor');
}

/** What typing `text` dispatches: inserted at the cursor, the cursor after it */
function type(view: EditorView, text: string): void {
  const head = view.state.selection.main.head;
  view.dispatch({ changes: { from: head, insert: text }, selection: { anchor: head + text.length }, userEvent: 'input.type' });
}

const text = (view: EditorView) => view.state.doc.toString();
const kinds = (view: EditorView) => view.state.field(criticMarkupField).map((r) => [r.type, r.content]);

/** The document as it reads with its suggested additions and deletions accepted */
function accepted(view: EditorView): string {
  let out = '';
  let pos = 0;
  for (const r of view.state.field(criticMarkupField)) {
    out += text(view).slice(pos, r.from) + (r.type === 'addition' ? r.content : '');
    pos = r.to;
  }
  return out + text(view).slice(pos);
}

describe('Suggestion mode with the cursor in your own addition', () => {
  beforeEach(() => {
    setCurrentAuthor('Mark');
    vi.spyOn(Date, 'now').mockReturnValue(2000);
  });

  afterEach(() => {
    views.splice(0).forEach((v) => v.destroy());
    setCurrentAuthor('anonymous');
    vi.restoreAllMocks();
  });

  describe('keys that edit away from the cursor suggest their edit where it is', () => {
    it("Ctrl+Enter suggests its new line at the line's end, and typing goes on in it", () => {
      const view = suggesting(`I ${yours} here\nnext line`, 2 + textTo);
      press(view, 'Enter', { ctrl: true });

      expect(text(view)).toBe(`I ${yours} here{++${now}@@\n++}\nnext line`);
      type(view, 'more');
      expect(text(view)).toBe(`I ${yours} here{++${now}@@\nmore++}\nnext line`);
      expect(kinds(view)).toEqual([
        ['addition', 'my words'],
        ['addition', '\nmore'],
      ]);
    });

    it('Ctrl+Enter on a line your addition ends suggests the new line right after it', () => {
      const view = suggesting(`I ${yours}\nnext line`, 2 + textTo);
      press(view, 'Enter', { ctrl: true });
      type(view, 'more');

      // A new addition right after yours, or yours made longer: either way,
      // nothing is suggested for deletion
      const ranges = view.state.field(criticMarkupField);
      expect(ranges.every((r) => r.type === 'addition' && r.metadata?.author === 'Mark')).toBe(true);
      expect(accepted(view)).toBe('I my words\nmore\nnext line');
    });

    it("Tab suggests its indent at the line's start", () => {
      const view = suggesting(`I ${yours} here`, 2 + textFrom + 2);
      press(view, 'Tab');

      expect(text(view)).toBe(`{++${now}@@\t++}I ${yours} here`);
    });

    it("Shift-Tab suggests deleting the indent at the line's start", () => {
      const view = suggesting(`\tI ${yours} here`, 3 + textFrom + 2);
      press(view, 'Tab', { shift: true });

      expect(text(view)).toBe(`{--${now}@@\t--}I ${yours} here`);
    });
  });

  describe('edits in your addition', () => {
    it('typing goes into its text', () => {
      const view = suggesting(`I ${yours} here`, 2 + textTo);
      type(view, ' too');

      expect(text(view)).toBe(`I {++${mark}@@my words too++} here`);
    });

    it('Enter goes into its text', () => {
      const view = suggesting(`I ${yours} here`, 2 + textTo);
      press(view, 'Enter');

      expect(text(view)).toBe(`I {++${mark}@@my words\n++} here`);
      expect(view.state.selection.main.head).toBe(2 + textTo + 1);
    });

    it('Backspace at its start suggests deleting the character before it', () => {
      const view = suggesting(`I ${yours} here`, 2 + textFrom);
      press(view, 'Backspace');

      expect(text(view)).toBe(`I{--${now}@@ --}${yours} here`);
    });

    it('Delete at its end suggests deleting the character after it', () => {
      const view = suggesting(`I ${yours} here`, 2 + textTo);
      press(view, 'Delete');

      expect(text(view)).toBe(`I ${yours}{--${now}@@ --}here`);
    });

    it('deleting all its text removes it', () => {
      const view = suggesting(`I ${yours} here`, 2 + textFrom, 2 + textTo);
      press(view, 'Backspace');

      expect(text(view)).toBe('I  here');
    });
  });
});
