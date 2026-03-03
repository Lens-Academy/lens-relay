import { describe, it, expect, afterEach } from 'vitest';
import { EditorState, EditorSelection, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { defaultKeymap } from '@codemirror/commands';
import { markdownFormattingKeymap } from './markdownFormatting';

/** Create an editor with the formatting keymap registered. */
function createFormattingEditor(
  content: string,
  cursorPos: number,
  options?: { selection?: EditorSelection }
): { view: EditorView; cleanup: () => void } {
  const state = EditorState.create({
    doc: content,
    selection: options?.selection ?? { anchor: cursorPos },
    extensions: [
      EditorState.allowMultipleSelections.of(true),
      markdown({ addKeymap: false }),
      Prec.high(keymap.of(markdownFormattingKeymap)),
      keymap.of(defaultKeymap),
    ],
  });

  const view = new EditorView({ state, parent: document.body });
  return { view, cleanup: () => view.destroy() };
}

function pressCtrlB(view: EditorView): boolean {
  const binding = markdownFormattingKeymap.find((k) => k.key === 'Mod-b');
  return binding?.run?.(view) ?? false;
}

function pressCtrlI(view: EditorView): boolean {
  const binding = markdownFormattingKeymap.find((k) => k.key === 'Mod-i');
  return binding?.run?.(view) ?? false;
}

describe('Markdown Formatting (Ctrl+B / Ctrl+I)', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    if (cleanup) cleanup();
  });

  describe('Bold (Ctrl+B) — selection', () => {
    it('wraps selected text with **', () => {
      const { view, cleanup: c } = createFormattingEditor('hello', 0, {
        selection: EditorSelection.single(0, 5),
      });
      cleanup = c;

      const result = pressCtrlB(view);

      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe('**hello**');
      // Selection should cover the wrapped text
      expect(view.state.selection.main.from).toBe(2);
      expect(view.state.selection.main.to).toBe(7);
    });

    it('unwraps **bold** when bold text is selected', () => {
      // "**hello**" with "hello" selected (positions 2..7)
      const { view, cleanup: c } = createFormattingEditor('**hello**', 0, {
        selection: EditorSelection.single(2, 7),
      });
      cleanup = c;

      pressCtrlB(view);

      expect(view.state.doc.toString()).toBe('hello');
      expect(view.state.selection.main.from).toBe(0);
      expect(view.state.selection.main.to).toBe(5);
    });
  });

  describe('Bold (Ctrl+B) — cursor on word', () => {
    it('expands to word and wraps when cursor is on a word', () => {
      // "hello world" with cursor inside "hello" → "**hello** world"
      const { view, cleanup: c } = createFormattingEditor('hello world', 3);
      cleanup = c;

      pressCtrlB(view);

      expect(view.state.doc.toString()).toBe('**hello** world');
    });

    it('unwraps word when cursor is inside bold word', () => {
      // "**hello** world" with cursor inside "hello" → "hello world"
      const { view, cleanup: c } = createFormattingEditor('**hello** world', 4);
      cleanup = c;

      pressCtrlB(view);

      expect(view.state.doc.toString()).toBe('hello world');
    });
  });

  describe('Bold (Ctrl+B) — empty markers', () => {
    it('inserts empty markers when cursor is not on a word', () => {
      // "hello " with cursor after space → "hello ****" with cursor between
      const { view, cleanup: c } = createFormattingEditor('hello ', 6);
      cleanup = c;

      pressCtrlB(view);

      expect(view.state.doc.toString()).toBe('hello ****');
      expect(view.state.selection.main.head).toBe(8); // between the **|**
    });

    it('removes empty markers on second press', () => {
      // "hello ****" with cursor between markers → "hello "
      const { view, cleanup: c } = createFormattingEditor('hello ****', 8);
      cleanup = c;

      pressCtrlB(view);

      expect(view.state.doc.toString()).toBe('hello ');
    });
  });

  describe('Italic (Ctrl+I)', () => {
    it('wraps selected text with *', () => {
      const { view, cleanup: c } = createFormattingEditor('hello', 0, {
        selection: EditorSelection.single(0, 5),
      });
      cleanup = c;

      pressCtrlI(view);

      expect(view.state.doc.toString()).toBe('*hello*');
      expect(view.state.selection.main.from).toBe(1);
      expect(view.state.selection.main.to).toBe(6);
    });

    it('unwraps *italic* when italic text is selected', () => {
      const { view, cleanup: c } = createFormattingEditor('*hello*', 0, {
        selection: EditorSelection.single(1, 6),
      });
      cleanup = c;

      pressCtrlI(view);

      expect(view.state.doc.toString()).toBe('hello');
    });

    it('expands to word and wraps with *', () => {
      const { view, cleanup: c } = createFormattingEditor('hello world', 3);
      cleanup = c;

      pressCtrlI(view);

      expect(view.state.doc.toString()).toBe('*hello* world');
    });

    it('unwraps *italic* word with cursor inside', () => {
      const { view, cleanup: c } = createFormattingEditor('*hello* world', 3);
      cleanup = c;

      pressCtrlI(view);

      expect(view.state.doc.toString()).toBe('hello world');
    });
  });

  describe('* vs ** guard', () => {
    it('Ctrl+I inside **bold** does NOT unwrap bold markers', () => {
      // "**hello**" with cursor inside "hello", press Ctrl+I
      // should wrap word with * → "***hello***", NOT unwrap **
      const { view, cleanup: c } = createFormattingEditor('**hello**', 4);
      cleanup = c;

      pressCtrlI(view);

      expect(view.state.doc.toString()).toBe('***hello***');
    });

    it('Ctrl+B inside *italic* does NOT unwrap italic markers', () => {
      // "*hello*" with cursor inside "hello", press Ctrl+B
      // should wrap word with ** → "***hello***", NOT unwrap *
      const { view, cleanup: c } = createFormattingEditor('*hello*', 3);
      cleanup = c;

      pressCtrlB(view);

      expect(view.state.doc.toString()).toBe('***hello***');
    });
  });

  describe('Multi-cursor', () => {
    it('toggles independently for multiple cursors', () => {
      // "foo bar" with cursors on "foo" and "bar"
      const { view, cleanup: c } = createFormattingEditor('foo bar', 0, {
        selection: EditorSelection.create([
          EditorSelection.cursor(1), // inside "foo"
          EditorSelection.cursor(5), // inside "bar"
        ]),
      });
      cleanup = c;

      pressCtrlB(view);

      expect(view.state.doc.toString()).toBe('**foo** **bar**');
    });
  });

  describe('Edge cases', () => {
    it('works at document start', () => {
      const { view, cleanup: c } = createFormattingEditor('hello', 2);
      cleanup = c;

      pressCtrlB(view);

      expect(view.state.doc.toString()).toBe('**hello**');
    });

    it('works at document end', () => {
      const { view, cleanup: c } = createFormattingEditor('hello', 5);
      cleanup = c;

      pressCtrlB(view);

      expect(view.state.doc.toString()).toBe('**hello**');
    });

    it('works on empty document', () => {
      const { view, cleanup: c } = createFormattingEditor('', 0);
      cleanup = c;

      pressCtrlB(view);

      expect(view.state.doc.toString()).toBe('****');
      expect(view.state.selection.main.head).toBe(2);
    });
  });
});
