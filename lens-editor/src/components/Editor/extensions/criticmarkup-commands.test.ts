// src/components/Editor/extensions/criticmarkup-commands.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { createCriticMarkupEditor, moveCursor } from '../../../test/codemirror-helpers';
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
  });
});
