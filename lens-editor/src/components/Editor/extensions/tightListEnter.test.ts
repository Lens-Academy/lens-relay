import { describe, it, expect, afterEach } from 'vitest';
import { createMarkdownEditor, pressEnter } from '../../../test/codemirror-helpers';

describe('Tight List Enter Handler', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    if (cleanup) cleanup();
  });

  describe('non-tight bullet list', () => {
    it('produces tight continuation on Enter', () => {
      // Non-tight list: blank line between items
      const doc = '- first\n\n- second';
      const { view, cleanup: c } = createMarkdownEditor(doc, doc.length);
      cleanup = c;

      pressEnter(view);

      // New bullet should follow immediately — no blank line before it
      expect(view.state.doc.toString()).toBe('- first\n\n- second\n- ');
    });

    it('places cursor after new bullet marker', () => {
      const doc = '- first\n\n- second';
      const { view, cleanup: c } = createMarkdownEditor(doc, doc.length);
      cleanup = c;

      pressEnter(view);

      const expected = '- first\n\n- second\n- ';
      expect(view.state.selection.main.head).toBe(expected.length);
    });
  });

  describe('non-tight ordered list', () => {
    it('produces tight continuation with correct numbering', () => {
      const doc = '1. first\n\n2. second';
      const { view, cleanup: c } = createMarkdownEditor(doc, doc.length);
      cleanup = c;

      pressEnter(view);

      expect(view.state.doc.toString()).toBe('1. first\n\n2. second\n3. ');
    });
  });

  describe('tight bullet list', () => {
    it('still produces tight continuation (no behavior change)', () => {
      const doc = '- first\n- second';
      const { view, cleanup: c } = createMarkdownEditor(doc, doc.length);
      cleanup = c;

      pressEnter(view);

      expect(view.state.doc.toString()).toBe('- first\n- second\n- ');
    });
  });

  describe('empty bullet item', () => {
    it('exits list when pressing Enter on empty third item', () => {
      const doc = '- first\n- second\n- ';
      const { view, cleanup: c } = createMarkdownEditor(doc, doc.length);
      cleanup = c;

      pressEnter(view);

      expect(view.state.doc.toString()).toBe('- first\n- second\n');
    });

    it('exits list when pressing Enter on empty second item (nonTightLists: false)', () => {
      const doc = '- first\n- ';
      const { view, cleanup: c } = createMarkdownEditor(doc, doc.length);
      cleanup = c;

      pressEnter(view);

      expect(view.state.doc.toString()).toBe('- first\n');
    });
  });

  describe('non-list context', () => {
    it('returns false so default handler can take over', () => {
      const doc = 'plain text';
      const { view, cleanup: c } = createMarkdownEditor(doc, doc.length);
      cleanup = c;

      const handled = pressEnter(view);

      expect(handled).toBe(false);
    });
  });

  describe('nested list', () => {
    it('produces tight continuation at correct indent level', () => {
      const doc = '- outer\n  - inner1\n\n  - inner2';
      const { view, cleanup: c } = createMarkdownEditor(doc, doc.length);
      cleanup = c;

      pressEnter(view);

      expect(view.state.doc.toString()).toBe(
        '- outer\n  - inner1\n\n  - inner2\n  - '
      );
    });
  });
});
