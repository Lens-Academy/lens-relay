// src/components/Editor/extensions/criticmarkup.test.ts
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { createCriticMarkupEditor, createCriticMarkupEditorWithSelection, createCriticMarkupEditorWithSourceMode, hasClass, moveCursor } from '../../../test/codemirror-helpers';
import { criticMarkupExtension, criticMarkupField, toggleSuggestionMode, suggestionModeField, commentClickCallback, setCurrentAuthor } from './criticmarkup';
import { toggleSourceMode } from './livePreview';
import { isAdjacentEditPair } from '../../../lib/criticmarkup-parser';

/** The text live preview shows: everything but the hidden syntax and the buttons */
function visibleText(view: EditorView): string {
  const content = view.contentDOM.cloneNode(true) as HTMLElement;
  content.querySelectorAll('.cm-hidden-syntax, .cm-criticmarkup-buttons').forEach((el) => el.remove());
  return content.textContent ?? '';
}

describe('CriticMarkup Extension', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    if (cleanup) cleanup();
  });

  describe('StateField', () => {
    it('parses CriticMarkup ranges from document', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        21
      );
      cleanup = c;

      const ranges = view.state.field(criticMarkupField);

      expect(ranges).toHaveLength(1);
      expect(ranges[0].type).toBe('addition');
    });

    it('updates ranges when document changes', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        21
      );
      cleanup = c;

      // Initially one addition
      let ranges = view.state.field(criticMarkupField);
      expect(ranges).toHaveLength(1);

      // Add a deletion
      view.dispatch({
        changes: { from: 21, insert: ' {--removed--}' },
      });

      ranges = view.state.field(criticMarkupField);
      expect(ranges).toHaveLength(2);
      expect(ranges[1].type).toBe('deletion');
    });

    it('returns empty array when no CriticMarkup in document', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello world',
        5
      );
      cleanup = c;

      const ranges = view.state.field(criticMarkupField);
      expect(ranges).toHaveLength(0);
    });

    it('parses all markup types', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        '{++added++} {--deleted--} {~~old~>new~~} {>>comment<<} {==highlight==}',
        0
      );
      cleanup = c;

      const ranges = view.state.field(criticMarkupField);
      expect(ranges).toHaveLength(5);
      expect(ranges.map(r => r.type)).toEqual([
        'addition',
        'deletion',
        'substitution',
        'comment',
        'highlight',
      ]);
    });
  });

  describe('Decorations', () => {
    it('applies cm-addition class to additions', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        21
      );
      cleanup = c;

      expect(hasClass(view, 'cm-addition')).toBe(true);
    });

    it('applies cm-deletion class to deletions', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {--removed--} end',
        23
      );
      cleanup = c;

      expect(hasClass(view, 'cm-deletion')).toBe(true);
    });

    it('applies cm-highlight class to highlights', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {==important==} end',
        25
      );
      cleanup = c;

      expect(hasClass(view, 'cm-highlight')).toBe(true);
    });

    it('replaces comments with badge (no cm-comment class in live preview)', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {>>note<<} end',
        20
      );
      cleanup = c;

      // Comments are now replaced with badges, not styled with cm-comment
      expect(hasClass(view, 'cm-comment')).toBe(false);
      expect(hasClass(view, 'cm-comment-badge')).toBe(true);
    });

    it('applies cm-substitution class to substitutions', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {~~old~>new~~} end',
        24
      );
      cleanup = c;

      expect(hasClass(view, 'cm-substitution')).toBe(true);
    });
  });

  describe('Live Preview', () => {
    it('hides markup syntax when cursor is outside', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        21 // cursor at "end"
      );
      cleanup = c;

      // The {++ and ++} should be hidden
      expect(hasClass(view, 'cm-hidden-syntax')).toBe(true);
    });

    it('always hides markup syntax regardless of cursor position', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        10 // cursor inside "world"
      );
      cleanup = c;

      // Delimiters are always hidden, even when cursor is inside
      expect(hasClass(view, 'cm-hidden-syntax')).toBe(true);
    });

    it('keeps syntax hidden when cursor moves in and out', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        21 // start outside
      );
      cleanup = c;

      // Outside - syntax hidden
      expect(hasClass(view, 'cm-hidden-syntax')).toBe(true);

      // Move cursor inside
      moveCursor(view, 10);

      // Still hidden - delimiters always hidden in live preview
      expect(hasClass(view, 'cm-hidden-syntax')).toBe(true);

      // Move cursor back outside
      moveCursor(view, 21);

      // Still hidden
      expect(hasClass(view, 'cm-hidden-syntax')).toBe(true);
    });

    it('hides metadata and @@ when cursor is outside (metadata-aware)', () => {
      // With metadata: {++{"author":"alice"}@@content++}
      const { view, cleanup: c } = createCriticMarkupEditor(
        '{++{"author":"alice"}@@hello++} end',
        35 // cursor at "end"
      );
      cleanup = c;

      // The entire {++{"author":"alice"}@@ prefix and ++} suffix should be hidden
      // Only "hello" should be visible with cm-addition styling
      const hiddenElements = view.contentDOM.querySelectorAll('.cm-hidden-syntax');
      expect(hiddenElements.length).toBeGreaterThan(0);

      // The visible content should just be "hello"
      const additionElements = view.contentDOM.querySelectorAll('.cm-addition');
      expect(additionElements.length).toBe(1);
      expect(additionElements[0].textContent).toBe('hello');
    });
  });

  describe('Suggestion Mode', () => {
    describe('mode toggle', () => {
      it('starts in editing mode by default', () => {
        const { view, cleanup: c } = createCriticMarkupEditor('hello', 5);
        cleanup = c;

        const isSuggestionMode = view.state.field(suggestionModeField);
        expect(isSuggestionMode).toBe(false);
      });

      it('can toggle to suggestion mode', () => {
        const { view, cleanup: c } = createCriticMarkupEditor('hello', 5);
        cleanup = c;

        view.dispatch({ effects: toggleSuggestionMode.of(true) });

        const isSuggestionMode = view.state.field(suggestionModeField);
        expect(isSuggestionMode).toBe(true);
      });

      it('can toggle back to editing mode', () => {
        const { view, cleanup: c } = createCriticMarkupEditor('hello', 5);
        cleanup = c;

        view.dispatch({ effects: toggleSuggestionMode.of(true) });
        view.dispatch({ effects: toggleSuggestionMode.of(false) });

        const isSuggestionMode = view.state.field(suggestionModeField);
        expect(isSuggestionMode).toBe(false);
      });
    });

    describe('wrapping insertions', () => {
      it('wraps inserted text in addition markup when suggestion mode is ON', () => {
        const { view, cleanup: c } = createCriticMarkupEditor('hello', 5);
        cleanup = c;

        // Enable suggestion mode
        view.dispatch({ effects: toggleSuggestionMode.of(true) });

        // Insert text (annotate as user input so suggestion filter activates)
        view.dispatch({
          changes: { from: 5, insert: ' world' },
          annotations: Transaction.userEvent.of('input'),
        });

        const doc = view.state.doc.toString();
        expect(doc).toMatch(/\{\+\+.*@@ world\+\+\}/);
      });

      it('does NOT wrap insertions when suggestion mode is OFF', () => {
        const { view, cleanup: c } = createCriticMarkupEditor('hello', 5);
        cleanup = c;

        // Suggestion mode is OFF by default
        view.dispatch({
          changes: { from: 5, insert: ' world' },
        });

        const doc = view.state.doc.toString();
        expect(doc).toBe('hello world');
      });

      it('includes metadata in wrapped insertion', () => {
        const { view, cleanup: c } = createCriticMarkupEditor('hello', 5);
        cleanup = c;

        view.dispatch({ effects: toggleSuggestionMode.of(true) });
        view.dispatch({
          changes: { from: 5, insert: 'X' },
          annotations: Transaction.userEvent.of('input'),
        });

        const doc = view.state.doc.toString();
        // Should have JSON metadata with author and timestamp
        expect(doc).toMatch(/\{\+\+\{.*"author".*\}@@X\+\+\}/);
        expect(doc).toMatch(/\{\+\+\{.*"timestamp".*\}@@X\+\+\}/);
      });

      it('continuous typing extends existing addition (not per-character)', () => {
        const { view, cleanup: c } = createCriticMarkupEditor('hello', 5);
        cleanup = c;

        view.dispatch({ effects: toggleSuggestionMode.of(true) });

        // Type 'h'
        view.dispatch({ changes: { from: 5, insert: 'h' }, annotations: Transaction.userEvent.of('input') });

        // Get cursor position - should be inside the addition
        const cursorPos = view.state.selection.main.head;

        // Type 'i' at cursor position
        view.dispatch({ changes: { from: cursorPos, insert: 'i' }, annotations: Transaction.userEvent.of('input') });

        const doc = view.state.doc.toString();

        // Should have ONE addition with "hi", not two separate ones
        const additionMatches = doc.match(/\{\+\+/g);
        expect(additionMatches?.length).toBe(1);
        expect(doc).toMatch(/@@hi\+\+\}/);
      });
    });

    describe('wrapping deletions', () => {
      it('wraps deleted text in deletion markup', () => {
        const { view, cleanup: c } = createCriticMarkupEditor('hello world', 5);
        cleanup = c;

        view.dispatch({ effects: toggleSuggestionMode.of(true) });

        // Delete " world"
        view.dispatch({
          changes: { from: 5, to: 11, insert: '' },
          annotations: Transaction.userEvent.of('delete'),
        });

        const doc = view.state.doc.toString();
        expect(doc).toMatch(/\{--.*@@ world--\}/);
      });

      it('does NOT wrap deletions when suggestion mode is OFF', () => {
        const { view, cleanup: c } = createCriticMarkupEditor('hello world', 5);
        cleanup = c;

        // Suggestion mode is OFF by default
        view.dispatch({
          changes: { from: 5, to: 11, insert: '' },
        });

        const doc = view.state.doc.toString();
        expect(doc).toBe('hello');
      });

      it('includes metadata in wrapped deletion', () => {
        const { view, cleanup: c } = createCriticMarkupEditor('hello world', 5);
        cleanup = c;

        view.dispatch({ effects: toggleSuggestionMode.of(true) });
        view.dispatch({
          changes: { from: 5, to: 11, insert: '' },
          annotations: Transaction.userEvent.of('delete'),
        });

        const doc = view.state.doc.toString();
        // Should have JSON metadata with author and timestamp
        expect(doc).toMatch(/\{--\{.*"author".*\}@@ world--\}/);
        expect(doc).toMatch(/\{--\{.*"timestamp".*\}@@ world--\}/);
      });
    });

    describe('wrapping replacements', () => {
      it('continues typing inside a substitution after replacing a selection', () => {
        const { view, cleanup: c } = createCriticMarkupEditorWithSelection('hello world', 6, 11);
        cleanup = c;

        view.dispatch({ effects: toggleSuggestionMode.of(true) });

        view.dispatch({
          changes: { from: 6, to: 11, insert: 't' },
          annotations: Transaction.userEvent.of('input.type'),
        });
        view.dispatch({
          changes: { from: view.state.selection.main.head, insert: 'h' },
          annotations: Transaction.userEvent.of('input.type'),
        });

        expect(view.state.doc.toString()).toMatch(/\{~~.*@@world~>th~~\}/);
      });

      it('keeps composition replacements inside the substitution new content', () => {
        const { view, cleanup: c } = createCriticMarkupEditorWithSelection('hello world', 6, 11);
        cleanup = c;

        view.dispatch({ effects: toggleSuggestionMode.of(true) });
        view.dispatch({
          changes: { from: 6, to: 11, insert: 'e' },
          annotations: Transaction.userEvent.of('input.type'),
        });

        const substitution = view.state.field(criticMarkupField)[0];
        const newContentFrom = substitution.contentTo - substitution.newContent!.length;
        view.dispatch({
          changes: { from: newContentFrom, to: substitution.contentTo, insert: 'é' },
          annotations: Transaction.userEvent.of('input.type.compose'),
        });

        expect(view.state.doc.toString()).toMatch(/\{~~.*@@world~>é~~\}/);
        expect(view.state.field(criticMarkupField)).toHaveLength(1);
      });

      it('keeps backspace edits inside the substitution new content', () => {
        const { view, cleanup: c } = createCriticMarkupEditorWithSelection('hello world', 6, 11);
        cleanup = c;

        view.dispatch({ effects: toggleSuggestionMode.of(true) });
        view.dispatch({
          changes: { from: 6, to: 11, insert: 'th' },
          annotations: Transaction.userEvent.of('input.type'),
        });

        const substitution = view.state.field(criticMarkupField)[0];
        view.dispatch({
          changes: { from: substitution.contentTo - 1, to: substitution.contentTo, insert: '' },
          annotations: Transaction.userEvent.of('delete.backward'),
        });

        expect(view.state.doc.toString()).toMatch(/\{~~.*@@world~>t~~\}/);
        expect(view.state.field(criticMarkupField)).toHaveLength(1);
      });

      it('turns a substitution into a deletion when its replacement is emptied', () => {
        const { view, cleanup: c } = createCriticMarkupEditorWithSelection('hello world', 6, 11);
        cleanup = c;

        view.dispatch({ effects: toggleSuggestionMode.of(true) });
        view.dispatch({
          changes: { from: 6, to: 11, insert: 't' },
          annotations: Transaction.userEvent.of('input.type'),
        });

        const substitution = view.state.field(criticMarkupField)[0];
        view.dispatch({
          changes: { from: substitution.contentTo - 1, to: substitution.contentTo, insert: '' },
          annotations: Transaction.userEvent.of('delete.backward'),
        });

        expect(view.state.doc.toString()).toMatch(/\{--.*@@world--\}/);
        expect(view.state.field(criticMarkupField)[0].type).toBe('deletion');
      });

      it('wraps selection replacement in substitution markup', () => {
        const { view, cleanup: c } = createCriticMarkupEditor('hello world', 6);
        cleanup = c;

        view.dispatch({ effects: toggleSuggestionMode.of(true) });

        // Replace "world" with "there"
        view.dispatch({
          changes: { from: 6, to: 11, insert: 'there' },
          annotations: Transaction.userEvent.of('input'),
        });

        const doc = view.state.doc.toString();
        expect(doc).toMatch(/\{~~.*@@world~>there~~\}/);
      });

      it('does NOT wrap replacements when suggestion mode is OFF', () => {
        const { view, cleanup: c } = createCriticMarkupEditor('hello world', 6);
        cleanup = c;

        // Suggestion mode is OFF by default
        view.dispatch({
          changes: { from: 6, to: 11, insert: 'there' },
        });

        const doc = view.state.doc.toString();
        expect(doc).toBe('hello there');
      });

      it('includes metadata in wrapped substitution', () => {
        const { view, cleanup: c } = createCriticMarkupEditor('hello world', 6);
        cleanup = c;

        view.dispatch({ effects: toggleSuggestionMode.of(true) });
        view.dispatch({
          changes: { from: 6, to: 11, insert: 'there' },
          annotations: Transaction.userEvent.of('input'),
        });

        const doc = view.state.doc.toString();
        // Should have JSON metadata with author and timestamp
        expect(doc).toMatch(/\{~~\{.*"author".*\}@@world~>there~~\}/);
        expect(doc).toMatch(/\{~~\{.*"timestamp".*\}@@world~>there~~\}/);
      });
    });

    describe('empty wrapper cleanup', () => {
      it('removes addition wrapper when all content is deleted', () => {
        const meta = '{"author":"anonymous","timestamp":1000}';
        const { view, cleanup: c } = createCriticMarkupEditor(
          `before {++${meta}@@hello++} after`,
          `before {++${meta}@@`.length + 1,
        );
        cleanup = c;

        view.dispatch({ effects: toggleSuggestionMode.of(true) });

        const contentFrom = `before {++${meta}@@`.length;
        const contentTo = contentFrom + 'hello'.length;
        view.dispatch({
          changes: { from: contentFrom, to: contentTo, insert: '' },
          annotations: Transaction.userEvent.of('delete'),
        });

        const doc = view.state.doc.toString();
        expect(doc).toBe('before  after');
        const ranges = view.state.field(criticMarkupField);
        expect(ranges).toHaveLength(0);
      });

      it('removes wrapper on final backspace of single-char content', () => {
        const meta = '{"author":"anonymous","timestamp":1000}';
        const content = `before {++${meta}@@x++} after`;
        const contentStart = `before {++${meta}@@`.length;
        const { view, cleanup: c } = createCriticMarkupEditor(
          content,
          contentStart + 1,
        );
        cleanup = c;

        view.dispatch({ effects: toggleSuggestionMode.of(true) });

        view.dispatch({
          changes: { from: contentStart, to: contentStart + 1, insert: '' },
          annotations: Transaction.userEvent.of('delete.backward'),
        });

        const doc = view.state.doc.toString();
        expect(doc).toBe('before  after');
        expect(view.state.field(criticMarkupField)).toHaveLength(0);
      });

      it('does NOT remove wrapper when partial content remains', () => {
        const meta = '{"author":"anonymous","timestamp":1000}';
        const content = `{++${meta}@@hello++}`;
        const contentStart = `{++${meta}@@`.length;
        const { view, cleanup: c } = createCriticMarkupEditor(
          content,
          contentStart + 3,
        );
        cleanup = c;

        view.dispatch({ effects: toggleSuggestionMode.of(true) });

        view.dispatch({
          changes: { from: contentStart, to: contentStart + 3, insert: '' },
          annotations: Transaction.userEvent.of('delete'),
        });

        const doc = view.state.doc.toString();
        expect(doc).toMatch(/\{\+\+.*@@lo\+\+\}/);
        expect(view.state.field(criticMarkupField)).toHaveLength(1);
      });

      it('does NOT remove wrapper when content is replaced (not deleted)', () => {
        const meta = '{"author":"anonymous","timestamp":1000}';
        const content = `{++${meta}@@hello++}`;
        const contentStart = `{++${meta}@@`.length;
        const { view, cleanup: c } = createCriticMarkupEditor(
          content,
          contentStart + 3,
        );
        cleanup = c;

        view.dispatch({ effects: toggleSuggestionMode.of(true) });

        view.dispatch({
          changes: { from: contentStart, to: contentStart + 5, insert: 'world' },
          annotations: Transaction.userEvent.of('input'),
        });

        const doc = view.state.doc.toString();
        expect(doc).toMatch(/\{\+\+.*@@world\+\+\}/);
        expect(view.state.field(criticMarkupField)).toHaveLength(1);
      });

      it('places cursor at wrapper start position after removal', () => {
        const meta = '{"author":"anonymous","timestamp":1000}';
        const content = `abc {++${meta}@@XY++} def`;
        const contentStart = `abc {++${meta}@@`.length;
        const { view, cleanup: c } = createCriticMarkupEditor(
          content,
          contentStart + 1,
        );
        cleanup = c;

        view.dispatch({ effects: toggleSuggestionMode.of(true) });

        view.dispatch({
          changes: { from: contentStart, to: contentStart + 2, insert: '' },
          annotations: Transaction.userEvent.of('delete'),
        });

        expect(view.state.selection.main.head).toBe(4);
      });

      it('backspace at left edge of content creates deletion suggestion instead of corrupting markup', () => {
        const meta = '{"author":"anonymous","timestamp":1000}';
        const content = `abc{++${meta}@@hello++} def`;
        const contentStart = `abc{++${meta}@@`.length;
        const { view, cleanup: c } = createCriticMarkupEditor(
          content,
          contentStart, // cursor at contentFrom (left edge of content)
        );
        cleanup = c;

        view.dispatch({ effects: toggleSuggestionMode.of(true) });

        // Backspace at the left edge of content — should NOT eat into the markup
        // Instead it should create a deletion suggestion for the char before the wrapper
        view.dispatch({
          changes: { from: contentStart - 1, to: contentStart, insert: '' },
          annotations: Transaction.userEvent.of('delete.backward'),
        });

        const doc = view.state.doc.toString();
        // The addition wrapper should still be intact
        expect(doc).toMatch(/\{\+\+.*@@hello\+\+\}/);
        // A deletion wrapper should appear for the char before the addition ('c')
        expect(doc).toMatch(/\{--.*@@c--\}/);
        // Cursor should be to the LEFT of the deletion wrapper (not between deletion and addition)
        expect(view.state.selection.main.head).toBe(2);
      });
    });

    // Mark edits in suggestion mode inside suggestions of Elias's (and Luc's)
    const elias = '{"author":"Elias","timestamp":1760000000000}';
    const mark = '{"author":"Mark","timestamp":1770000000000}';
    const luc = '{"author":"Luc","timestamp":1750000000000}';

    /** Mark is the author, and his metadata is `mark` */
    function editingAsMark() {
      beforeEach(() => {
        setCurrentAuthor('Mark');
        vi.spyOn(Date, 'now').mockReturnValue(1770000000000);
      });

      afterEach(() => {
        setCurrentAuthor('anonymous');
        vi.restoreAllMocks();
      });
    }

    function suggesting(doc: string, anchor: number, head = anchor) {
      const made = createCriticMarkupEditorWithSelection(doc, anchor, head);
      cleanup = made.cleanup;
      made.view.dispatch({ effects: toggleSuggestionMode.of(true) });
      return made.view;
    }

    /** What typing `text` dispatches: the selection replaced, the cursor after it */
    function type(view: EditorView, text: string, userEvent = 'input.type') {
      const { from, to } = view.state.selection.main;
      view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent });
    }

    /** Backspace, or with `forward` Delete, at the cursor (deleteCharBackward / deleteCharForward) */
    function backspace(view: EditorView, forward = false) {
      const head = view.state.selection.main.head;
      const [from, to] = forward ? [head, head + 1] : [head - 1, head];
      view.dispatch({
        changes: { from, to },
        selection: { anchor: from },
        userEvent: forward ? 'delete.forward' : 'delete.backward',
      });
    }

    const parts = (view: EditorView) =>
      view.state.field(criticMarkupField).map((r) => [r.type, r.metadata?.author, r.content]);

    /** Clicks the ✓ (or ✗) of the change starting at `from`, which the cursor must be in */
    function press(view: EditorView, from: number, button: 'accept' | 'reject') {
      const buttons = view.contentDOM.querySelector(`.cm-criticmarkup-buttons[data-range-from="${from}"]`);
      (buttons!.querySelector(`.cm-criticmarkup-${button}`) as HTMLButtonElement).click();
    }

    describe("inside someone else's addition", () => {
      editingAsMark();
      const theirs = `{++${elias}@@An added line++}`;
      const textFrom = `{++${elias}@@`.length;

      it('splits their addition around what you type: their part, yours, their part', () => {
        const view = suggesting(theirs, textFrom + 1);
        type(view, 'Z');

        expect(view.state.doc.toString()).toBe(
          `{++${elias}@@A++}{++${mark}@@Z++}{++${elias}@@n added line++}`,
        );
        expect(parts(view)).toEqual([
          ['addition', 'Elias', 'A'],
          ['addition', 'Mark', 'Z'],
          ['addition', 'Elias', 'n added line'],
        ]);
        expect(visibleText(view)).toBe('AZn added line');
      });

      it('keeps typing in your part, without more markup', () => {
        const view = suggesting(theirs, textFrom + 1);
        type(view, 'Z');
        type(view, 'Y');
        type(view, 'X');

        expect(view.state.doc.toString()).toBe(
          `{++${elias}@@A++}{++${mark}@@ZYX++}{++${elias}@@n added line++}`,
        );
        expect(visibleText(view)).toBe('AZYXn added line');
      });

      it('puts what you type at the start of their text just before their addition', () => {
        const view = suggesting(theirs, textFrom);
        type(view, 'Z');

        expect(view.state.doc.toString()).toBe(`{++${mark}@@Z++}${theirs}`);
        expect(visibleText(view)).toBe('ZAn added line');
      });

      it('puts what you type at the end of their text just after their addition', () => {
        const view = suggesting(`${theirs} more`, textFrom + 'An added line'.length);
        type(view, 'Z');

        expect(view.state.doc.toString()).toBe(`${theirs}{++${mark}@@Z++} more`);
        expect(visibleText(view)).toBe('An added lineZ more');
      });

      it('puts what you type just after an addition of yours in it', () => {
        // Where the cursor is one step right of the end of your text
        const yours = `Text {++${mark}@@Y++}`;
        const view = suggesting(`${yours} more`, yours.length);
        type(view, 'Z');

        expect(view.state.doc.toString()).toBe(`Text {++${mark}@@YZ++} more`);
        expect(view.state.selection.main.head).toBe(`Text {++${mark}@@YZ`.length);
      });

      it('adds to an addition of yours already beside theirs', () => {
        const yours = `{++${mark}@@Y++}`;
        let view = suggesting(`${theirs}${yours}`, textFrom + 'An added line'.length);
        type(view, 'Z');
        expect(view.state.doc.toString()).toBe(`${theirs}{++${mark}@@ZY++}`);

        view = suggesting(`${yours}${theirs}`, yours.length + textFrom);
        type(view, 'Z');
        expect(view.state.doc.toString()).toBe(`{++${mark}@@YZ++}${theirs}`);
      });

      it('keeps a deletion+addition pair together when you type at the start of its new text', () => {
        const pair = `{--${elias}@@old words--}{++${elias}@@new words++}`;
        const view = suggesting(pair, pair.indexOf('new words'));
        type(view, 'Z');

        expect(view.state.doc.toString()).toBe(`{++${mark}@@Z++}${pair}`);
        const [, deletion, addition] = view.state.field(criticMarkupField);
        expect(isAdjacentEditPair(deletion, addition)).toBe(true);
      });

      it('splits the new text of a deletion+addition pair, which keeps its first part', () => {
        const pair = `{--${elias}@@old words--}{++${elias}@@new words++}`;
        const view = suggesting(pair, pair.indexOf('new words') + 3);
        type(view, 'Z');

        expect(view.state.doc.toString()).toBe(
          `{--${elias}@@old words--}{++${elias}@@new++}{++${mark}@@Z++}{++${elias}@@ words++}`,
        );
        const [deletion, first] = view.state.field(criticMarkupField);
        expect(isAdjacentEditPair(deletion, first)).toBe(true);
      });

      it('splits their addition around a paste', () => {
        const view = suggesting(theirs, textFrom + 1);
        type(view, 'One\n\nTwo', 'input.paste');

        expect(view.state.doc.toString()).toBe(
          `{++${elias}@@A++}{++${mark}@@One\n\nTwo++}{++${elias}@@n added line++}`,
        );
      });

      it('splits an addition without metadata, whose parts stay without', () => {
        const view = suggesting('{++An added line++}', 4);
        type(view, 'Z');

        expect(view.state.doc.toString()).toBe(`{++A++}{++${mark}@@Z++}{++n added line++}`);
      });

      it('joins their parts again when you delete all you typed', () => {
        const view = suggesting(theirs, textFrom + 1);
        type(view, 'Z');
        type(view, 'Y');
        backspace(view);
        backspace(view);

        expect(view.state.doc.toString()).toBe(theirs);
        expect(view.state.selection.main.head).toBe(textFrom + 1);
      });

      it('never wraps their markup in a deletion from the edge of your part', () => {
        const view = suggesting(theirs, textFrom + 1);
        type(view, 'Z');
        const split = view.state.doc.toString();
        const zFrom = split.indexOf('@@Z') + 2;
        view.dispatch({ selection: { anchor: zFrom } });
        backspace(view);
        view.dispatch({ selection: { anchor: zFrom + 1 } });
        view.dispatch({ changes: { from: zFrom + 1, to: zFrom + 2 }, userEvent: 'delete.forward' });

        expect(view.state.doc.toString()).toBe(split);
      });

      it('nests a deletion in their addition when you delete some of its text', () => {
        const view = suggesting(theirs, textFrom + 2);
        backspace(view);

        expect(view.state.doc.toString()).toBe(`{++${elias}@@A{--${mark}@@n--} added line++}`);
        expect(parts(view)).toEqual([
          ['addition', 'Elias', `A{--${mark}@@n--} added line`],
          ['deletion', 'Mark', 'n'],
        ]);
      });

      it('nests a substitution in their addition when you replace some of its text', () => {
        const view = suggesting(theirs, textFrom + 3, textFrom + 8);
        type(view, 'new');

        expect(view.state.doc.toString()).toBe(`{++${elias}@@An {~~${mark}@@added~>new~~} line++}`);
        expect(parts(view).map(([type, author]) => [type, author])).toEqual([
          ['addition', 'Elias'],
          ['substitution', 'Mark'],
        ]);
      });

      it('puts text dropped into an addition of yours in its text', () => {
        const yours = `Drag me. {++${mark}@@Mine++}`;
        const into = yours.indexOf('Mine') + 2;
        const view = suggesting(yours, 5, 7);
        view.dispatch({
          changes: [{ from: 5, to: 7 }, { from: into, insert: 'me' }],
          userEvent: 'move.drop',
        });

        expect(view.state.doc.toString()).toBe(`Drag {--${mark}@@me--}. {++${mark}@@Mimene++}`);
      });

      it('splits their addition where a deletion of yours in it starts when you type in that', () => {
        const nested = `{++${elias}@@An {--${mark}@@added--} line++}`;
        const view = suggesting(nested, nested.indexOf('added') + 2);
        type(view, 'Z');

        expect(view.state.doc.toString()).toBe(
          `{++${elias}@@An ++}{++${mark}@@Z++}{++${elias}@@{--${mark}@@added--} line++}`,
        );
      });
    });

    describe("inside someone else's deletion", () => {
      editingAsMark();
      const theirs = `{--${elias}@@Deleted--}`;
      const textFrom = `{--${elias}@@`.length;

      it('moves the cursor over their deleted text on Backspace and Delete, changing nothing', () => {
        const view = suggesting(theirs, textFrom + 3);
        backspace(view);

        expect(view.state.doc.toString()).toBe(theirs);
        expect(view.state.selection.main.head).toBe(textFrom + 2);

        backspace(view, true);
        backspace(view, true);

        expect(view.state.doc.toString()).toBe(theirs);
        expect(view.state.selection.main.head).toBe(textFrom + 4);
      });

      it('moves to the start of a selection of their deleted text that you delete', () => {
        const view = suggesting(theirs, textFrom + 1, textFrom + 5);
        view.dispatch({ changes: { from: textFrom + 1, to: textFrom + 5 }, userEvent: 'delete.selection' });

        expect(view.state.doc.toString()).toBe(theirs);
        expect(view.state.selection.main.head).toBe(textFrom + 1);
      });

      it('suggests deleting just the text beyond their deletion when a deletion reaches past it', () => {
        // A selection from their text into the next: the pieces left to delete
        // when their closing delimiter is kept
        const doc = `${theirs} and more`;
        const view = suggesting(doc, textFrom + 3, theirs.length + 4);
        view.dispatch({
          changes: [{ from: textFrom + 3, to: textFrom + 7 }, { from: theirs.length, to: theirs.length + 4 }],
          userEvent: 'delete.selection',
        });

        expect(view.state.doc.toString()).toBe(`${theirs}{--${mark}@@ and--} more`);
      });

      it('puts what you type in their deleted text just before their deletion', () => {
        const view = suggesting(theirs, textFrom + 3);
        type(view, 'Z');
        type(view, 'Y');

        expect(view.state.doc.toString()).toBe(`{++${mark}@@ZY++}${theirs}`);
        expect(parts(view)).toEqual([
          ['addition', 'Mark', 'ZY'],
          ['deletion', 'Elias', 'Deleted'],
        ]);
        expect(view.state.selection.main.head).toBe(`{++${mark}@@ZY`.length);
        expect(visibleText(view)).toBe('ZYDeleted');
      });

      it('does the same at the start of their deleted text', () => {
        const view = suggesting(`Text ${theirs}`, 'Text '.length + textFrom);
        type(view, 'Z');

        expect(view.state.doc.toString()).toBe(`Text {++${mark}@@Z++}${theirs}`);
      });

      it('adds it to an addition of yours just before their deletion', () => {
        const yours = `{++${mark}@@Y++}`;
        const view = suggesting(`${yours}${theirs}`, yours.length + textFrom + 3);
        type(view, 'Z');

        expect(view.state.doc.toString()).toBe(`{++${mark}@@YZ++}${theirs}`);
      });

      it('puts what you type over some of their deleted text before it, and leaves their text whole', () => {
        const view = suggesting(theirs, textFrom + 1, textFrom + 5);
        type(view, 'Q');

        expect(view.state.doc.toString()).toBe(`{++${mark}@@Q++}${theirs}`);
      });

      it('keeps what you typed when their deletion is accepted', () => {
        const view = suggesting(theirs, textFrom + 3);
        type(view, 'Z');
        const theirsFrom = `{++${mark}@@Z++}`.length;
        view.dispatch({ selection: { anchor: theirsFrom + textFrom + 3 } });
        press(view, theirsFrom, 'accept');

        expect(view.state.doc.toString()).toBe(`{++${mark}@@Z++}`);
      });

      it('keeps their deletion+addition pair together when you type at the end of its deleted text', () => {
        // Where ArrowRight first stops at the pair's boundary; at the next
        // stop, the start of the new text, yours goes before the pair too
        const pair = `{--${elias}@@old words--}{++${elias}@@new words++}`;
        const view = suggesting(pair, pair.indexOf('--}'));
        type(view, 'Z');

        expect(view.state.doc.toString()).toBe(`{++${mark}@@Z++}${pair}`);
        const [, deletion, addition] = view.state.field(criticMarkupField);
        expect(isAdjacentEditPair(deletion, addition)).toBe(true);
      });

      it("splits someone else's addition that their deletion is in, where the deletion starts", () => {
        const nested = `{++${luc}@@An {--${elias}@@extra--} line++}`;
        const view = suggesting(nested, nested.indexOf('extra') + 2);
        type(view, 'Z');

        expect(view.state.doc.toString()).toBe(
          `{++${luc}@@An ++}{++${mark}@@Z++}{++${luc}@@{--${elias}@@extra--} line++}`,
        );
      });

      it('puts what you type in an addition inside their deletion before their deletion', () => {
        // As suggestion mode used to nest one there
        const nested = `{--${elias}@@Del{++${luc}@@xy++}eted--}`;
        const view = suggesting(nested, nested.indexOf('xy') + 1);
        type(view, 'Z');

        expect(view.state.doc.toString()).toBe(`{++${mark}@@Z++}${nested}`);
      });

      it('puts what you type over some of your own deleted text before your deletion', () => {
        const yours = `{--${mark}@@Deleted--}`;
        const view = suggesting(yours, yours.indexOf('Deleted') + 1, yours.indexOf('Deleted') + 3);
        type(view, 'Q');

        expect(view.state.doc.toString()).toBe(`{++${mark}@@Q++}${yours}`);
      });

      it("treats a deletion without metadata as someone else's", () => {
        const view = suggesting('{--Deleted--}', 6);
        backspace(view);
        type(view, 'Z');

        expect(view.state.doc.toString()).toBe(`{++${mark}@@Z++}{--Deleted--}`);
      });
    });

    describe("at the end of someone else's deletion", () => {
      editingAsMark();
      const theirs = `{--${elias}@@Deleted--}`;
      // The end of their deleted text has two cursor stops, shown in the same
      // place: in their deletion, and just after it
      const stops: Array<[string, number]> = [
        ['at the end of their deleted text', theirs.length - 3],
        ['just after their deletion', theirs.length],
      ];
      const yoursAfter = (text: string) => `${theirs}{++${mark}@@${text}++}`;

      it.each(stops)('puts what you type %s just after it, where the cursor shows it', (_, at) => {
        const view = suggesting(`${theirs} more`, at);
        type(view, 'Z');
        type(view, 'Y');

        expect(view.state.doc.toString()).toBe(`${yoursAfter('ZY')} more`);
        expect(parts(view)).toEqual([
          ['deletion', 'Elias', 'Deleted'],
          ['addition', 'Mark', 'ZY'],
        ]);
        expect(view.state.selection.main.head).toBe(yoursAfter('ZY').length - 3);
        expect(visibleText(view)).toBe('DeletedZY more');
      });

      it('makes it a change of its own, not a pair with their deletion', () => {
        let view = suggesting(`${yoursAfter('Z')} more`, yoursAfter('Z').length - 3);
        const [deletion, addition] = view.state.field(criticMarkupField);
        expect(isAdjacentEditPair(deletion, addition)).toBe(false);

        // Its ✓ ✗ act on just it, and their deletion's on just that
        expect(view.contentDOM.querySelectorAll('.cm-criticmarkup-buttons[data-merged]')).toHaveLength(0);
        press(view, theirs.length, 'accept');
        expect(view.state.doc.toString()).toBe(`${theirs}Z more`);
        cleanup!();

        view = suggesting(`${yoursAfter('Z')} more`, yoursAfter('Z').length - 3);
        press(view, theirs.length, 'reject');
        expect(view.state.doc.toString()).toBe(`${theirs} more`);
        cleanup!();

        view = suggesting(`${yoursAfter('Z')} more`, theirs.length - 5);
        press(view, 0, 'accept');
        expect(view.state.doc.toString()).toBe(`{++${mark}@@Z++} more`);
      });

      it.each(stops)('adds what you type %s to an addition of yours there', (_, at) => {
        const view = suggesting(`${yoursAfter('Y')} more`, at);
        type(view, 'Z');

        expect(view.state.doc.toString()).toBe(`${yoursAfter('ZY')} more`);
        expect(view.state.selection.main.head).toBe(yoursAfter('Z').length - 3);
      });

      it("puts it between their deletion and someone else's addition just after it", () => {
        // Two authors' changes, not a pair
        const doc = `{--${elias}@@old--}{++${luc}@@new++}`;
        for (const at of [doc.indexOf('--}'), doc.indexOf('new')]) {
          const view = suggesting(doc, at);
          type(view, 'Z');

          expect(view.state.doc.toString()).toBe(`{--${elias}@@old--}{++${mark}@@Z++}{++${luc}@@new++}`);
          cleanup!();
        }
      });

      it('keeps their deletion+addition pair together when you type between its halves too', () => {
        // Where the cursor can stand without #162: in the hidden markup between them
        const pair = `{--${elias}@@old words--}{++${elias}@@new words++}`;
        const view = suggesting(pair, pair.indexOf('{++'));
        type(view, 'Z');

        expect(view.state.doc.toString()).toBe(`{++${mark}@@Z++}${pair}`);
      });
    });

    describe('in a deletion of yours', () => {
      editingAsMark();
      const yours = `{--${mark}@@Deleted--}`;

      it('puts what you type at the end of your deleted text just after it, as your replacement of it', () => {
        const view = suggesting(`${yours} more`, yours.length - 3);
        type(view, 'Z');

        expect(view.state.doc.toString()).toBe(`${yours}{++${mark}@@Z++} more`);
        const [deletion, addition] = view.state.field(criticMarkupField);
        expect(isAdjacentEditPair(deletion, addition)).toBe(true);
        expect(view.contentDOM.querySelectorAll('.cm-criticmarkup-buttons[data-merged]')).toHaveLength(1);
      });

      it('puts what you type at the start of your deleted text just before it', () => {
        const view = suggesting(`Text ${yours}`, `Text {--${mark}@@`.length);
        type(view, 'Z');

        expect(view.state.doc.toString()).toBe(`Text {++${mark}@@Z++}${yours}`);
      });

      it('replaces a word you Delete and then type over', () => {
        const view = suggesting('Some words here', 'Some '.length);
        for (let i = 0; i < 'words'.length; i++) backspace(view, true);
        type(view, 'text');

        expect(view.state.doc.toString()).toBe(`Some {--${mark}@@words--}{++${mark}@@text++} here`);
        expect(visibleText(view)).toBe('Some wordstext here');
      });
    });

    describe("inside someone else's substitution", () => {
      editingAsMark();
      const theirs = `{~~${elias}@@old text~>new text~~}`;
      const oldFrom = `{~~${elias}@@`.length;
      const newFrom = theirs.indexOf('new text');
      /** Theirs after Mark replaced "ew" in its new text with "Q" */
      const replaced = `{~~${elias}@@old text~>n{--${mark}@@ew--}{++${mark}@@Q++} text~~}`;

      it('writes what you type over some of their new text as a deletion+addition pair of yours in it', () => {
        const view = suggesting(theirs, newFrom + 1, newFrom + 3);
        type(view, 'Q');
        type(view, 'R');

        expect(view.state.doc.toString()).toBe(replaced.replace('@@Q', '@@QR'));
        expect(parts(view)).toEqual([
          ['substitution', 'Elias', `old text~>n{--${mark}@@ew--}{++${mark}@@QR++} text`],
          ['deletion', 'Mark', 'ew'],
          ['addition', 'Mark', 'QR'],
        ]);
        expect(visibleText(view)).toBe('old text~>newQR text');
      });

      it('does the same over some of their old text', () => {
        const view = suggesting(theirs, oldFrom + 1, oldFrom + 3);
        type(view, 'Q');

        expect(view.state.doc.toString()).toBe(`{~~${elias}@@o{--${mark}@@ld--}{++${mark}@@Q++} text~>new text~~}`);
        expect(parts(view)).toEqual([
          ['substitution', 'Elias', `o{--${mark}@@ld--}{++${mark}@@Q++} text~>new text`],
          ['deletion', 'Mark', 'ld'],
          ['addition', 'Mark', 'Q'],
        ]);
      });

      it('splits an addition their substitution is in before the substitution, for your addition', () => {
        // As replacing some of Luc's addition nests Elias's substitution in it:
        // your addition would end Luc's at its `++}`
        const nested = `{++${luc}@@An {~~${elias}@@old~>new~~} line++}`;
        const view = suggesting(nested, nested.indexOf('new') + 1, nested.indexOf('new') + 3);
        type(view, 'Q');

        expect(view.state.doc.toString()).toBe(
          `{++${luc}@@An ++}{++${mark}@@Q++}{++${luc}@@{~~${elias}@@old~>n{--${mark}@@ew--}~~} line++}`,
        );
        expect(view.state.selection.main.head).toBe(`{++${luc}@@An ++}{++${mark}@@Q`.length);
      });

      it('splits an addition in their substitution around yours when you replace some of its text', () => {
        const nested = `{~~${elias}@@old~>n{++${luc}@@ew++} text~~}`;
        const view = suggesting(nested, nested.indexOf('ew'), nested.indexOf('ew') + 1);
        type(view, 'Q');

        expect(view.state.doc.toString()).toBe(
          `{~~${elias}@@old~>n{++${luc}@@{--${mark}@@e--}++}{++${mark}@@Q++}{++${luc}@@w++} text~~}`,
        );
        expect(parts(view).map(([type, author]) => [type, author])).toEqual([
          ['substitution', 'Elias'],
          ['addition', 'Luc'],
          ['deletion', 'Mark'],
          ['addition', 'Mark'],
          ['addition', 'Luc'],
        ]);
      });

      it('moves the cursor over its `~>` on Backspace and Delete, changing nothing', () => {
        const view = suggesting(theirs, newFrom);
        backspace(view);
        backspace(view);

        expect(view.state.doc.toString()).toBe(theirs);
        expect(view.state.selection.main.head).toBe(newFrom - 2);

        backspace(view, true);

        expect(view.state.doc.toString()).toBe(theirs);
        expect(view.state.selection.main.head).toBe(newFrom - 1);
      });

      it("writes a replacement in your own substitution's old text as a pair too", () => {
        const yours = `{~~${mark}@@old~>new~~}`;
        const view = suggesting(yours, yours.indexOf('old') + 1, yours.indexOf('old') + 3);
        type(view, 'Q');

        expect(view.state.doc.toString()).toBe(`{~~${mark}@@o{--${mark}@@ld--}{++${mark}@@Q++}~>new~~}`);
      });

      it("gives your pair one ✓ ✗ of its own, acting on just it", () => {
        let view = suggesting(replaced, replaced.indexOf('@@Q') + 3);
        const pairFrom = replaced.indexOf('{--');
        expect(view.contentDOM.querySelectorAll('.cm-criticmarkup-buttons')).toHaveLength(2);
        press(view, pairFrom, 'accept');
        expect(view.state.doc.toString()).toBe(`{~~${elias}@@old text~>nQ text~~}`);
        cleanup!();

        view = suggesting(replaced, replaced.indexOf('@@Q') + 3);
        press(view, pairFrom, 'reject');
        expect(view.state.doc.toString()).toBe(theirs);
      });

      it('keeps your pair pending when theirs is accepted, and drops it when theirs is rejected', () => {
        let view = suggesting(replaced, replaced.indexOf('@@Q') + 3);
        press(view, 0, 'accept');
        expect(view.state.doc.toString()).toBe(`n{--${mark}@@ew--}{++${mark}@@Q++} text`);
        cleanup!();

        view = suggesting(replaced, replaced.indexOf('@@Q') + 3);
        press(view, 0, 'reject');
        expect(view.state.doc.toString()).toBe('old text');
      });
    });

    describe('in a deletion of yours beside other markup', () => {
      editingAsMark();

      it('still takes the character before it on Backspace, and after it on Delete', () => {
        let view = suggesting(`Text {--${mark}@@more--}`, `Text {--${mark}@@more`.length);
        backspace(view);
        expect(view.state.doc.toString()).toBe(`Text{--${mark}@@ more--}`);
        expect(view.state.selection.main.head).toBe(`Text{--${mark}@@`.length);
        cleanup!();

        view = suggesting(`{--${mark}@@more--} text`, `{--${mark}@@`.length);
        backspace(view, true);
        expect(view.state.doc.toString()).toBe(`{--${mark}@@more --}text`);
        expect(view.state.selection.main.head).toBe(`{--${mark}@@more `.length);
      });

      it("leaves the markup of someone else's deletion just before it on Backspace", () => {
        const doc = `{--${elias}@@Deleted--}{--${mark}@@ more--}`;
        const view = suggesting(doc, doc.length - 3);
        backspace(view);

        expect(view.state.doc.toString()).toBe(doc);
        expect(view.state.selection.main.head).toBe(doc.indexOf(' more'));
      });

      it("leaves the markup of someone else's deletion just after it on Delete", () => {
        const doc = `{--${mark}@@Old --}{--${elias}@@Deleted--}`;
        const view = suggesting(doc, doc.indexOf('Old'));
        backspace(view, true);

        expect(view.state.doc.toString()).toBe(doc);
        expect(view.state.selection.main.head).toBe(doc.indexOf('Old ') + 4);
      });

      it("leaves the `~>` of a substitution it starts the new text of", () => {
        const doc = `{~~${elias}@@old~>{--${mark}@@new--} text~~}`;
        const view = suggesting(doc, doc.indexOf('new--}') + 3);
        backspace(view);

        expect(view.state.doc.toString()).toBe(doc);
      });

      it('never nests a deletion in it at the start of the document', () => {
        const doc = `{--${mark}@@more--} text`;
        const view = suggesting(doc, `{--${mark}@@mo`.length);
        backspace(view);

        expect(view.state.doc.toString()).toBe(doc);
        expect(view.state.selection.main.head).toBe(`{--${mark}@@`.length);
      });
    });
  });

  describe('Accept/Reject Buttons', () => {
    it('shows accept/reject buttons when cursor is inside markup', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        10 // cursor inside
      );
      cleanup = c;

      const acceptBtn = view.contentDOM.querySelector('.cm-criticmarkup-accept');
      const rejectBtn = view.contentDOM.querySelector('.cm-criticmarkup-reject');

      expect(acceptBtn).not.toBeNull();
      expect(rejectBtn).not.toBeNull();
    });

    it('hides buttons when cursor is outside markup', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        3 // cursor outside
      );
      cleanup = c;

      const acceptBtn = view.contentDOM.querySelector('.cm-criticmarkup-accept');
      const rejectBtn = view.contentDOM.querySelector('.cm-criticmarkup-reject');

      expect(acceptBtn).toBeNull();
      expect(rejectBtn).toBeNull();
    });

    it('buttons appear for all markup types', () => {
      // Test with deletion
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {--removed--} end',
        10
      );
      cleanup = c;

      expect(view.contentDOM.querySelector('.cm-criticmarkup-accept')).not.toBeNull();
      expect(view.contentDOM.querySelector('.cm-criticmarkup-reject')).not.toBeNull();
    });
  });

  describe('Button Click Behavior', () => {
    it('clicking accept button applies the change', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        10
      );
      cleanup = c;

      const acceptBtn = view.contentDOM.querySelector('.cm-criticmarkup-accept') as HTMLButtonElement;
      expect(acceptBtn).not.toBeNull();

      acceptBtn.click();

      expect(view.state.doc.toString()).toBe('hello world end');
    });

    it('clicking reject button reverts the change', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        10
      );
      cleanup = c;

      const rejectBtn = view.contentDOM.querySelector('.cm-criticmarkup-reject') as HTMLButtonElement;
      expect(rejectBtn).not.toBeNull();

      rejectBtn.click();

      expect(view.state.doc.toString()).toBe('hello  end');
    });

    describe('with a deletion nested in an addition', () => {
      // Mark's deletion of "n" in Elias's addition; the cursor is in the deletion
      const doc = '{++{"author":"Elias"}@@A{--{"author":"Mark"}@@n--} added line++}';
      const deletionFrom = doc.indexOf('{--');
      const buttons = (view: EditorView, from: number) =>
        view.contentDOM.querySelector(`.cm-criticmarkup-buttons[data-range-from="${from}"]`)!;

      it('shows buttons for both, each acting on its own change', () => {
        let { view, cleanup: c } = createCriticMarkupEditor(doc, doc.indexOf('@@n') + 3);
        cleanup = c;
        expect(view.contentDOM.querySelectorAll('.cm-criticmarkup-buttons')).toHaveLength(2);

        (buttons(view, deletionFrom).querySelector('.cm-criticmarkup-accept') as HTMLButtonElement).click();
        expect(view.state.doc.toString()).toBe('{++{"author":"Elias"}@@A added line++}');
        c();

        ({ view, cleanup: c } = createCriticMarkupEditor(doc, doc.indexOf('@@n') + 3));
        cleanup = c;
        (buttons(view, deletionFrom).querySelector('.cm-criticmarkup-reject') as HTMLButtonElement).click();
        expect(view.state.doc.toString()).toBe('{++{"author":"Elias"}@@An added line++}');
        c();

        ({ view, cleanup: c } = createCriticMarkupEditor(doc, doc.indexOf('@@n') + 3));
        cleanup = c;
        (buttons(view, 0).querySelector('.cm-criticmarkup-accept') as HTMLButtonElement).click();
        expect(view.state.doc.toString()).toBe('A{--{"author":"Mark"}@@n--} added line');
      });
    });

    it('keeps the cursor where it is when a button is pressed', () => {
      // CodeMirror would move it to where the press maps, which hidden syntax
      // throws off: out of the change, taking the buttons away before the click
      const { view, cleanup: c } = createCriticMarkupEditor('hello {++world++} end', 10);
      cleanup = c;
      const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });

      view.contentDOM.querySelector('.cm-criticmarkup-reject')!.dispatchEvent(press);

      expect(press.defaultPrevented).toBe(true);
      expect(view.state.selection.main.head).toBe(10);
    });

    it('acts on its own change when the cursor touches two', () => {
      // The cursor at 7 is at the end of the first and the start of the second
      const { view, cleanup: c } = createCriticMarkupEditor('{++a++}{++b++}', 7);
      cleanup = c;
      const second = view.contentDOM.querySelector('.cm-criticmarkup-buttons[data-range-from="7"]')!;

      (second.querySelector('.cm-criticmarkup-accept') as HTMLButtonElement).click();

      expect(view.state.doc.toString()).toBe('{++a++}b');
    });
  });

  describe('Adjacent Deletion+Addition Pairs', () => {
    it('shows a single merged button for adjacent deletion+addition', () => {
      // {--old--}{++new++} — cursor in the deletion
      const doc = 'hello {--old--}{++new++} end';
      const { view, cleanup: c } = createCriticMarkupEditor(
        doc,
        10 // cursor inside deletion
      );
      cleanup = c;

      const buttons = view.contentDOM.querySelectorAll('.cm-criticmarkup-buttons');
      expect(buttons.length).toBe(1);
    });

    it('shows merged button when cursor is in the addition part', () => {
      const doc = 'hello {--old--}{++new++} end';
      const { view, cleanup: c } = createCriticMarkupEditor(
        doc,
        19 // cursor inside addition
      );
      cleanup = c;

      const buttons = view.contentDOM.querySelectorAll('.cm-criticmarkup-buttons');
      expect(buttons.length).toBe(1);
    });

    it('accept on merged pair removes deletion and keeps addition', () => {
      const doc = 'hello {--old--}{++new++} end';
      const { view, cleanup: c } = createCriticMarkupEditor(
        doc,
        10 // cursor inside deletion
      );
      cleanup = c;

      const acceptBtn = view.contentDOM.querySelector('.cm-criticmarkup-accept') as HTMLButtonElement;
      expect(acceptBtn).not.toBeNull();
      acceptBtn.click();

      expect(view.state.doc.toString()).toBe('hello new end');
    });

    it('reject on merged pair keeps deletion content and removes addition', () => {
      const doc = 'hello {--old--}{++new++} end';
      const { view, cleanup: c } = createCriticMarkupEditor(
        doc,
        10 // cursor inside deletion
      );
      cleanup = c;

      const rejectBtn = view.contentDOM.querySelector('.cm-criticmarkup-reject') as HTMLButtonElement;
      expect(rejectBtn).not.toBeNull();
      rejectBtn.click();

      expect(view.state.doc.toString()).toBe('hello old end');
    });

    it('gives a deletion and an addition by two authors that touch a ✓ ✗ each', () => {
      // Elias's deletion, and Mark's addition just after it
      const doc = 'hello {--{"author":"Elias"}@@old--}{++{"author":"Mark"}@@new++} end';
      const { view, cleanup: c } = createCriticMarkupEditor(doc, doc.indexOf('old') + 1);
      cleanup = c;

      const buttons = view.contentDOM.querySelectorAll<HTMLElement>('.cm-criticmarkup-buttons');
      expect(buttons.length).toBe(1);
      expect(buttons[0].dataset.merged).toBeUndefined();
      (buttons[0].querySelector('.cm-criticmarkup-accept') as HTMLButtonElement).click();

      expect(view.state.doc.toString()).toBe('hello {++{"author":"Mark"}@@new++} end');
    });

    it('non-adjacent deletion and addition still get separate buttons', () => {
      // Space between them — not adjacent
      const doc = 'hello {--old--} {++new++} end';
      const { view, cleanup: c } = createCriticMarkupEditor(
        doc,
        10 // cursor inside deletion
      );
      cleanup = c;

      const buttons = view.contentDOM.querySelectorAll('.cm-criticmarkup-buttons');
      // Only one button visible (cursor is only in the deletion)
      expect(buttons.length).toBe(1);

      // Move cursor to addition
      view.dispatch({ selection: { anchor: 21 } });
      const buttons2 = view.contentDOM.querySelectorAll('.cm-criticmarkup-buttons');
      expect(buttons2.length).toBe(1);
    });
  });

  describe('Source Mode Integration', () => {
    it('suppresses Markdown strikethrough inside substitutions but preserves standalone strikethrough', () => {
      const { view, cleanup: c } = createCriticMarkupEditorWithSourceMode(
        '{~~old~>new~~} and ~~strike~~',
        17
      );
      cleanup = c;

      toggleSourceMode(view, true);

      const substitution = view.contentDOM.querySelector('.cm-substitution');
      expect(substitution).toHaveClass('cm-criticmarkup-no-strikethrough');

      const standaloneFrom = view.state.doc.toString().lastIndexOf('~~strike~~');
      const standaloneStrike = syntaxTree(view.state).resolveInner(standaloneFrom + 3, 1);
      expect(standaloneStrike.name).toBe('Strikethrough');
    });

    it('hides CriticMarkup decorations when source mode is ON', () => {
      const { view, cleanup: c } = createCriticMarkupEditorWithSourceMode(
        'hello {++world++} end',
        21 // cursor outside markup
      );
      cleanup = c;

      // Initially in live preview mode - decorations should be applied
      expect(hasClass(view, 'cm-addition')).toBe(true);
      expect(hasClass(view, 'cm-hidden-syntax')).toBe(true);

      // Enable source mode
      toggleSourceMode(view, true);

      // In source mode - color classes still applied (entire range), but syntax not hidden
      expect(hasClass(view, 'cm-addition')).toBe(true);
      expect(hasClass(view, 'cm-hidden-syntax')).toBe(false);
    });

    it('restores hidden syntax when source mode is OFF', () => {
      const { view, cleanup: c } = createCriticMarkupEditorWithSourceMode(
        'hello {++world++} end',
        21
      );
      cleanup = c;

      // Enable source mode — no hidden syntax
      toggleSourceMode(view, true);
      expect(hasClass(view, 'cm-hidden-syntax')).toBe(false);

      // Disable source mode — hidden syntax restored
      toggleSourceMode(view, false);

      expect(hasClass(view, 'cm-addition')).toBe(true);
      expect(hasClass(view, 'cm-hidden-syntax')).toBe(true);
    });

    it('shows color-coded deletion markup in source mode', () => {
      const { view, cleanup: c } = createCriticMarkupEditorWithSourceMode(
        'hello {--removed--} end',
        23
      );
      cleanup = c;

      // Enable source mode
      toggleSourceMode(view, true);

      // Color class applied to entire range, but delimiters visible (not hidden)
      expect(hasClass(view, 'cm-deletion')).toBe(true);
      expect(hasClass(view, 'cm-hidden-syntax')).toBe(false);
    });
  });

  describe('Comment Badge Decorations', () => {
    it('renders badge for single comment', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {>>a comment<<} end',
        0 // cursor outside
      );
      cleanup = c;

      const badge = view.contentDOM.querySelector('.cm-comment-badge');
      expect(badge).not.toBeNull();
    });

    it('badge contains plain number', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {>>a comment<<} end',
        0
      );
      cleanup = c;

      const badge = view.contentDOM.querySelector('.cm-comment-badge');
      expect(badge?.textContent).toBe('1');
    });

    it('hides comment content with badge replacement', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {>>a comment<<} end',
        0
      );
      cleanup = c;

      // Comment content should NOT be visible (replaced by badge)
      const commentElements = view.contentDOM.querySelectorAll('.cm-comment');
      expect(commentElements.length).toBe(0);
    });

    it('assigns sequential badge numbers to multiple threads', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {>>first<<} middle {>>second<<} end',
        0
      );
      cleanup = c;

      const badges = view.contentDOM.querySelectorAll('.cm-comment-badge');
      expect(badges.length).toBe(2);
      expect(badges[0].textContent).toBe('1');
      expect(badges[1].textContent).toBe('2');
    });

    it('uses supplied badge numbers when editing a document slice', () => {
      const state = EditorState.create({
        doc: 'field {>>second field comment<<} end',
        extensions: [
          markdown(),
          criticMarkupExtension({
            commentBadgeMap: new Map([
              [6, { badgeNumber: 2, isFirstInThread: true, absoluteFrom: 106 }],
            ]),
          }),
        ],
      });
      const view = new EditorView({ state, parent: document.body });
      cleanup = () => view.destroy();

      const badge = view.contentDOM.querySelector('.cm-comment-badge');
      expect(badge?.textContent).toBe('2');
    });

    it('uses single badge for adjacent comments (thread)', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {>>first<<}{>>reply<<} end',
        0
      );
      cleanup = c;

      const badges = view.contentDOM.querySelectorAll('.cm-comment-badge');
      expect(badges.length).toBe(1);
      expect(badges[0].textContent).toBe('1');
    });

    it('stores thread from position in data attribute', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {>>a comment<<} end',
        0
      );
      cleanup = c;

      const badge = view.contentDOM.querySelector('.cm-comment-badge');
      expect(badge?.getAttribute('data-comment-from')).toBe('6');
    });

    it('invokes commentClickCallback Facet on badge click with the absolute offset', () => {
      let receivedFrom: number | undefined;
      const state = EditorState.create({
        doc: 'hello {>>a comment<<} end',
        selection: { anchor: 0 },
        extensions: [
          markdown(),
          criticMarkupExtension(),
          commentClickCallback.of((absFrom) => { receivedFrom = absFrom; }),
        ],
      });
      const view = new EditorView({ state, parent: document.body });
      cleanup = () => view.destroy();

      const badge = view.contentDOM.querySelector('.cm-comment-badge') as HTMLElement;
      expect(badge).not.toBeNull();
      badge.click();
      expect(receivedFrom).toBe(6); // thread.from
    });
  });
});
