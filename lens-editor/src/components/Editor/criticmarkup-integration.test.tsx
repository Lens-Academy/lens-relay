// src/components/Editor/criticmarkup-integration.test.tsx
/**
 * Integration tests for CriticMarkup accept/reject UI.
 * @vitest-environment happy-dom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { history, undo } from '@codemirror/commands';
import { moveCursor, hasClass } from '../../test/codemirror-helpers';
import { criticMarkupExtension } from './extensions/criticmarkup';
import { criticMarkupKeymap } from './extensions/criticmarkup-commands';

/**
 * Create an EditorView with CriticMarkup extension AND history for testing undo.
 */
function createCriticMarkupEditorWithHistory(
  content: string,
  cursorPos: number
): { view: EditorView; cleanup: () => void } {
  const state = EditorState.create({
    doc: content,
    selection: { anchor: cursorPos },
    extensions: [
      markdown(),
      history(),
      criticMarkupExtension(),
    ],
  });

  const view = new EditorView({
    state,
    parent: document.body,
  });

  return {
    view,
    cleanup: () => {
      view.destroy();
    },
  };
}

describe('CriticMarkup Accept/Reject Integration', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    if (cleanup) cleanup();
  });

  describe('Full workflow', () => {
    it('cursor inside shows buttons, clicking accept removes markup', () => {
      const { view, cleanup: c } = createCriticMarkupEditorWithHistory(
        'hello {++world++} end',
        10
      );
      cleanup = c;

      // Verify buttons appear
      const acceptBtn = view.contentDOM.querySelector('.cm-criticmarkup-accept');
      expect(acceptBtn).not.toBeNull();

      // Click accept
      (acceptBtn as HTMLButtonElement).click();

      // Verify document changed
      expect(view.state.doc.toString()).toBe('hello world end');

      // Verify no more markup styling
      expect(hasClass(view, 'cm-addition')).toBe(false);
    });

    it('keyboard shortcut accepts change', () => {
      const { view, cleanup: c } = createCriticMarkupEditorWithHistory(
        'hello {--removed--} end',
        10
      );
      cleanup = c;

      // Execute keyboard command
      const binding = criticMarkupKeymap.find((k) => k.key === 'Mod-Enter');
      binding?.run?.(view);

      // Accept deletion = remove content
      expect(view.state.doc.toString()).toBe('hello  end');
    });

    it('moving cursor in/out toggles button visibility', () => {
      const { view, cleanup: c } = createCriticMarkupEditorWithHistory(
        'hello {++world++} end',
        3 // outside
      );
      cleanup = c;

      // Initially outside - no buttons
      expect(view.contentDOM.querySelector('.cm-criticmarkup-accept')).toBeNull();

      // Move inside
      moveCursor(view, 10);
      expect(view.contentDOM.querySelector('.cm-criticmarkup-accept')).not.toBeNull();

      // Move outside again
      moveCursor(view, 20);
      expect(view.contentDOM.querySelector('.cm-criticmarkup-accept')).toBeNull();
    });

    it('works with metadata-enriched markup', () => {
      const { view, cleanup: c } = createCriticMarkupEditorWithHistory(
        'hello {++{"author":"alice"}@@world++} end',
        20
      );
      cleanup = c;

      const acceptBtn = view.contentDOM.querySelector('.cm-criticmarkup-accept');
      (acceptBtn as HTMLButtonElement).click();

      expect(view.state.doc.toString()).toBe('hello world end');
    });

    it('substitution accept keeps new content', () => {
      const { view, cleanup: c } = createCriticMarkupEditorWithHistory(
        'hello {~~old~>new~~} end',
        10
      );
      cleanup = c;

      const acceptBtn = view.contentDOM.querySelector('.cm-criticmarkup-accept');
      (acceptBtn as HTMLButtonElement).click();

      expect(view.state.doc.toString()).toBe('hello new end');
    });

    it('substitution reject keeps old content', () => {
      const { view, cleanup: c } = createCriticMarkupEditorWithHistory(
        'hello {~~old~>new~~} end',
        10
      );
      cleanup = c;

      const rejectBtn = view.contentDOM.querySelector('.cm-criticmarkup-reject');
      (rejectBtn as HTMLButtonElement).click();

      expect(view.state.doc.toString()).toBe('hello old end');
    });
  });

  describe('Edge Cases', () => {
    it('handles empty document gracefully', () => {
      const { view, cleanup: c } = createCriticMarkupEditorWithHistory('', 0);
      cleanup = c;

      // No buttons should appear
      expect(view.contentDOM.querySelector('.cm-criticmarkup-accept')).toBeNull();
    });

    it('handles cursor at exact start boundary of markup', () => {
      const { view, cleanup: c } = createCriticMarkupEditorWithHistory(
        'hello {++world++} end',
        6 // exactly at {
      );
      cleanup = c;

      // Cursor at boundary should be considered "inside"
      expect(view.contentDOM.querySelector('.cm-criticmarkup-accept')).not.toBeNull();
    });

    it('handles cursor at exact end boundary of markup', () => {
      const { view, cleanup: c } = createCriticMarkupEditorWithHistory(
        'hello {++world++} end',
        17 // exactly at }
      );
      cleanup = c;

      // Cursor at boundary should be considered "inside"
      expect(view.contentDOM.querySelector('.cm-criticmarkup-accept')).not.toBeNull();
    });

    it('handles multiple adjacent markup ranges', () => {
      const { view, cleanup: c } = createCriticMarkupEditorWithHistory(
        '{++one++}{++two++}',
        5 // inside "one"
      );
      cleanup = c;

      const acceptBtn = view.contentDOM.querySelector('.cm-criticmarkup-accept');
      (acceptBtn as HTMLButtonElement).click();

      // Should only accept "one", not "two"
      expect(view.state.doc.toString()).toBe('one{++two++}');
    });

    it('handles multiline markup', () => {
      const { view, cleanup: c } = createCriticMarkupEditorWithHistory(
        'start {++line1\nline2++} end',
        12
      );
      cleanup = c;

      const acceptBtn = view.contentDOM.querySelector('.cm-criticmarkup-accept');
      (acceptBtn as HTMLButtonElement).click();

      expect(view.state.doc.toString()).toBe('start line1\nline2 end');
    });

    it('handles comment type (accept removes it)', () => {
      const { view, cleanup: c } = createCriticMarkupEditorWithHistory(
        'hello {>>note<<} world',
        10
      );
      cleanup = c;

      const acceptBtn = view.contentDOM.querySelector('.cm-criticmarkup-accept');
      (acceptBtn as HTMLButtonElement).click();

      expect(view.state.doc.toString()).toBe('hello  world');
    });

    it('handles highlight type (accept keeps content)', () => {
      const { view, cleanup: c } = createCriticMarkupEditorWithHistory(
        'hello {==important==} world',
        12
      );
      cleanup = c;

      const acceptBtn = view.contentDOM.querySelector('.cm-criticmarkup-accept');
      (acceptBtn as HTMLButtonElement).click();

      expect(view.state.doc.toString()).toBe('hello important world');
    });
  });

  describe('Undo Support', () => {
    it('accept can be undone', () => {
      const { view, cleanup: c } = createCriticMarkupEditorWithHistory(
        'hello {++world++} end',
        10
      );
      cleanup = c;

      const acceptBtn = view.contentDOM.querySelector('.cm-criticmarkup-accept');
      (acceptBtn as HTMLButtonElement).click();

      expect(view.state.doc.toString()).toBe('hello world end');

      // Undo using CodeMirror's undo
      undo(view);

      expect(view.state.doc.toString()).toBe('hello {++world++} end');
    });

    it('reject can be undone', () => {
      const { view, cleanup: c } = createCriticMarkupEditorWithHistory(
        'hello {++world++} end',
        10
      );
      cleanup = c;

      const rejectBtn = view.contentDOM.querySelector('.cm-criticmarkup-reject');
      (rejectBtn as HTMLButtonElement).click();

      expect(view.state.doc.toString()).toBe('hello  end');

      // Undo
      undo(view);

      expect(view.state.doc.toString()).toBe('hello {++world++} end');
    });
  });
});
