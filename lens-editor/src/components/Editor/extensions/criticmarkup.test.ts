// src/components/Editor/extensions/criticmarkup.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { Transaction } from '@codemirror/state';
import { createCriticMarkupEditor, createCriticMarkupEditorWithSourceMode, hasClass, moveCursor } from '../../../test/codemirror-helpers';
import { criticMarkupField, toggleSuggestionMode, suggestionModeField, focusCommentThread } from './criticmarkup';
import { toggleSourceMode } from './livePreview';

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
  });

  describe('Source Mode Integration', () => {
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
      expect(badge?.getAttribute('data-thread-from')).toBe('6');
    });

    it('dispatches focusCommentThread effect on badge click', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {>>a comment<<} end',
        0
      );
      cleanup = c;

      const badge = view.contentDOM.querySelector('.cm-comment-badge') as HTMLElement;
      expect(badge).not.toBeNull();

      // Listen for the effect
      let receivedFrom: number | undefined;
      const originalDispatch = view.dispatch.bind(view);
      view.dispatch = (...args: Parameters<typeof view.dispatch>) => {
        for (const arg of args) {
          if (arg && typeof arg === 'object' && 'effects' in arg) {
            const effects = Array.isArray(arg.effects) ? arg.effects : [arg.effects];
            for (const effect of effects) {
              if (effect && effect.is && effect.is(focusCommentThread)) {
                receivedFrom = effect.value;
              }
            }
          }
        }
        return originalDispatch(...args);
      };

      badge.click();
      expect(receivedFrom).toBe(6); // thread.from
    });
  });
});
