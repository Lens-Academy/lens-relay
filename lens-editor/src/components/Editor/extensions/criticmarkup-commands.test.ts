// src/components/Editor/extensions/criticmarkup-commands.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { createCriticMarkupEditor, createCriticMarkupEditorWithSelection, moveCursor } from '../../../test/codemirror-helpers';
import { acceptChangeAtCursor, rejectChangeAtCursor, criticMarkupKeymap } from './criticmarkup-commands';

describe('CriticMarkup Commands', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    if (cleanup) cleanup();
  });

  describe('acceptChangeAtCursor', () => {
    it('accepts addition when cursor is inside', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        10 // cursor inside "world"
      );
      cleanup = c;

      const result = acceptChangeAtCursor(view);

      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe('hello world end');
    });

    it('returns false when cursor is not inside any markup', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        3 // cursor in "hello"
      );
      cleanup = c;

      const result = acceptChangeAtCursor(view);

      expect(result).toBe(false);
      expect(view.state.doc.toString()).toBe('hello {++world++} end');
    });

    it('accepts deletion (removes content)', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {--removed--} end',
        10
      );
      cleanup = c;

      const result = acceptChangeAtCursor(view);

      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe('hello  end');
    });

    it('accepts substitution (keeps new content)', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {~~old~>new~~} end',
        10
      );
      cleanup = c;

      const result = acceptChangeAtCursor(view);

      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe('hello new end');
    });
  });

  describe('rejectChangeAtCursor', () => {
    it('rejects addition (removes markup entirely)', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        10
      );
      cleanup = c;

      const result = rejectChangeAtCursor(view);

      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe('hello  end');
    });

    it('returns false when cursor is not inside any markup', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        3
      );
      cleanup = c;

      const result = rejectChangeAtCursor(view);

      expect(result).toBe(false);
    });

    it('rejects deletion (keeps deleted content)', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {--removed--} end',
        10
      );
      cleanup = c;

      const result = rejectChangeAtCursor(view);

      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe('hello removed end');
    });

    it('rejects substitution (keeps old content)', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {~~old~>new~~} end',
        10
      );
      cleanup = c;

      const result = rejectChangeAtCursor(view);

      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe('hello old end');
    });
  });

  describe('Bulk accept/reject', () => {
    it('accepts all additions in selection', () => {
      const content = 'hello {++foo++} mid {++bar++} end';
      const { view, cleanup: c } = createCriticMarkupEditorWithSelection(content, 0, content.length);
      cleanup = c;

      const result = acceptChangeAtCursor(view);

      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe('hello foo mid bar end');
    });

    it('rejects all additions in selection', () => {
      const content = 'hello {++foo++} mid {++bar++} end';
      const { view, cleanup: c } = createCriticMarkupEditorWithSelection(content, 0, content.length);
      cleanup = c;

      const result = rejectChangeAtCursor(view);

      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe('hello  mid  end');
    });

    it('accepts mixed types (addition + deletion)', () => {
      const content = 'hello {++added++} mid {--removed--} end';
      const { view, cleanup: c } = createCriticMarkupEditorWithSelection(content, 0, content.length);
      cleanup = c;

      const result = acceptChangeAtCursor(view);

      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe('hello added mid  end');
    });

    it('rejects mixed types (addition + deletion)', () => {
      const content = 'hello {++added++} mid {--removed--} end';
      const { view, cleanup: c } = createCriticMarkupEditorWithSelection(content, 0, content.length);
      cleanup = c;

      const result = rejectChangeAtCursor(view);

      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe('hello  mid removed end');
    });

    it('accepts substitution in bulk', () => {
      const content = 'hello {~~old~>new~~} mid {++added++} end';
      const { view, cleanup: c } = createCriticMarkupEditorWithSelection(content, 0, content.length);
      cleanup = c;

      const result = acceptChangeAtCursor(view);

      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe('hello new mid added end');
    });

    it('only affects ranges overlapping the selection', () => {
      const content = 'hello {++foo++} mid {++bar++} end';
      // Selection covers "hello {++foo++} mid" but not the second markup
      const { view, cleanup: c } = createCriticMarkupEditorWithSelection(content, 0, 19);
      cleanup = c;

      const result = acceptChangeAtCursor(view);

      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe('hello foo mid {++bar++} end');
    });

    it('returns false when selection covers no markup ranges', () => {
      const content = 'hello mid {++bar++} end';
      // Select only "hello mid" (no markup)
      const { view, cleanup: c } = createCriticMarkupEditorWithSelection(content, 0, 9);
      cleanup = c;

      const result = acceptChangeAtCursor(view);

      expect(result).toBe(false);
    });

    it('includes partially overlapping ranges', () => {
      const content = 'hello {++foo++} end';
      // Select from position 8 (inside "foo") to end
      const { view, cleanup: c } = createCriticMarkupEditorWithSelection(content, 8, content.length);
      cleanup = c;

      const result = acceptChangeAtCursor(view);

      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe('hello foo end');
    });

    it('single range in non-collapsed selection works like cursor accept', () => {
      const content = 'hello {++world++} end';
      const { view, cleanup: c } = createCriticMarkupEditorWithSelection(content, 6, 17);
      cleanup = c;

      const result = acceptChangeAtCursor(view);

      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe('hello world end');
    });

    // Ctrl+A and the bulk ✓ used to delete every comment in the file, replies included
    const ANNOTATED = 'a {++x++} b {==seen==}{>>a note<<}{>>a reply<<} c {--y--} d';
    const NOTES = '{==seen==}{>>a note<<}{>>a reply<<}';

    it('accepting a selection leaves its comments, their replies and highlights', () => {
      const { view, cleanup: c } = createCriticMarkupEditorWithSelection(ANNOTATED, 0, ANNOTATED.length);
      cleanup = c;

      expect(acceptChangeAtCursor(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(`a x b ${NOTES} c  d`);
    });

    it('rejecting a selection leaves them too', () => {
      const { view, cleanup: c } = createCriticMarkupEditorWithSelection(ANNOTATED, 0, ANNOTATED.length);
      cleanup = c;

      expect(rejectChangeAtCursor(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(`a  b ${NOTES} c y d`);
    });

    it('a selection over part of a deletion+addition pair accepts the whole pair', () => {
      const content = 'a {--old--}{++new++} b {++x++} c';
      // From inside "old" to the end: the pair's addition is in it, its deletion only partly
      const { view, cleanup: c } = createCriticMarkupEditorWithSelection(content, 5, content.length);
      cleanup = c;

      expect(acceptChangeAtCursor(view)).toBe(true);
      expect(view.state.doc.toString()).toBe('a new b x c');
    });

    it('a selection over only part of the deletion half rejects the whole pair', () => {
      const content = 'a {--old--}{++new++} b';
      const { view, cleanup: c } = createCriticMarkupEditorWithSelection(content, 5, 7);
      cleanup = c;

      expect(rejectChangeAtCursor(view)).toBe(true);
      expect(view.state.doc.toString()).toBe('a old b');
    });

    it('a selection with only comments and highlights in it changes nothing', () => {
      const content = `a ${NOTES} b`;
      const { view, cleanup: c } = createCriticMarkupEditorWithSelection(content, 0, content.length);
      cleanup = c;

      expect(acceptChangeAtCursor(view)).toBe(false);
      expect(rejectChangeAtCursor(view)).toBe(false);
      expect(view.state.doc.toString()).toBe(content);
    });
  });

  describe('Comments and highlights', () => {
    it('accept and reject never delete a comment at the cursor', () => {
      const content = 'a {>>a note<<} b';
      const { view, cleanup: c } = createCriticMarkupEditor(content, 5);
      cleanup = c;

      expect(acceptChangeAtCursor(view)).toBe(false);
      expect(rejectChangeAtCursor(view)).toBe(false);
      expect(view.state.doc.toString()).toBe(content);
    });

    it('right after a comment, the suggestion there is accepted and the comment stays', () => {
      const content = 'a {>>a note<<}{++x++} b';
      const { view, cleanup: c } = createCriticMarkupEditor(content, content.indexOf('{++'));
      cleanup = c;

      expect(acceptChangeAtCursor(view)).toBe(true);
      expect(view.state.doc.toString()).toBe('a {>>a note<<}x b');
    });

    it('a highlight inside the selection is still accepted by its own ✓ (nothing else selected)', () => {
      const content = 'a {==seen==} b';
      // Part of the highlighted text, as when its ✓ ✗ show for a selection
      const { view, cleanup: c } = createCriticMarkupEditorWithSelection(content, 6, 9);
      cleanup = c;

      expect(acceptChangeAtCursor(view)).toBe(true);
      expect(view.state.doc.toString()).toBe('a seen b');
    });
  });

  describe('Keyboard Shortcuts', () => {
    it('exports a keymap extension', () => {
      expect(criticMarkupKeymap).toBeDefined();
      expect(Array.isArray(criticMarkupKeymap)).toBe(true);
    });

    it('keymap has Mod-Enter for accept', () => {
      const acceptBinding = criticMarkupKeymap.find(
        (k) => k.key === 'Ctrl-Enter' || k.key === 'Mod-Enter'
      );
      expect(acceptBinding).toBeDefined();
    });

    it('keymap has Mod-Backspace for reject', () => {
      const rejectBinding = criticMarkupKeymap.find(
        (k) => k.key === 'Ctrl-Backspace' || k.key === 'Mod-Backspace'
      );
      expect(rejectBinding).toBeDefined();
    });
  });

  describe('Keyboard Integration', () => {
    it('Mod-Enter accepts change when cursor inside markup', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        10
      );
      cleanup = c;

      // Simulate Mod-Enter by finding and running the command
      const binding = criticMarkupKeymap.find((k) => k.key === 'Mod-Enter');
      const result = binding?.run?.(view);

      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe('hello world end');
    });

    it('Mod-Backspace rejects change when cursor inside markup', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        10
      );
      cleanup = c;

      // Simulate Mod-Backspace by finding and running the command
      const binding = criticMarkupKeymap.find((k) => k.key === 'Mod-Backspace');
      const result = binding?.run?.(view);

      expect(result).toBe(true);
      expect(view.state.doc.toString()).toBe('hello  end');
    });

    it('Mod-Enter over a selection accepts its suggestions and leaves its comments', () => {
      const content = 'a {++x++} b {>>a note<<} c {++y++} d';
      const { view, cleanup: c } = createCriticMarkupEditorWithSelection(content, 0, content.length);
      cleanup = c;

      const binding = criticMarkupKeymap.find((k) => k.key === 'Mod-Enter');

      expect(binding?.run?.(view)).toBe(true);
      expect(view.state.doc.toString()).toBe('a x b {>>a note<<} c y d');
    });
  });
});
