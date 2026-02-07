// src/components/Editor/extensions/criticmarkup-context-menu.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createCriticMarkupEditor } from '../../../test/codemirror-helpers';
import { getContextMenuItems } from './criticmarkup-context-menu';

describe('CriticMarkup Context Menu', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    if (cleanup) cleanup();
  });

  it('returns accept/reject items when cursor inside markup', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello {++world++} end',
      10
    );
    cleanup = c;

    const items = getContextMenuItems(view);

    expect(items).toHaveLength(2);
    expect(items[0].label).toBe('Accept Change');
    expect(items[1].label).toBe('Reject Change');
  });

  it('returns empty array when cursor outside markup', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello {++world++} end',
      3
    );
    cleanup = c;

    const items = getContextMenuItems(view);

    expect(items).toHaveLength(0);
  });

  it('accept item executes acceptChangeAtCursor', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello {++world++} end',
      10
    );
    cleanup = c;

    const items = getContextMenuItems(view);
    items[0].action();

    expect(view.state.doc.toString()).toBe('hello world end');
  });

  it('reject item executes rejectChangeAtCursor', () => {
    const { view, cleanup: c } = createCriticMarkupEditor(
      'hello {++world++} end',
      10
    );
    cleanup = c;

    const items = getContextMenuItems(view);
    items[1].action();

    expect(view.state.doc.toString()).toBe('hello  end');
  });

  describe('atPosition parameter', () => {
    it('returns items when atPosition is inside markup even if cursor is outside', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        3 // cursor outside
      );
      cleanup = c;

      // atPosition=10 is inside the markup
      const items = getContextMenuItems(view, 10);

      expect(items).toHaveLength(2);
    });

    it('returns empty array when atPosition is outside markup', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        10 // cursor inside
      );
      cleanup = c;

      // atPosition=3 is outside the markup
      const items = getContextMenuItems(view, 3);

      expect(items).toHaveLength(0);
    });

    it('action moves cursor to position before accepting', () => {
      const { view, cleanup: c } = createCriticMarkupEditor(
        'hello {++world++} end',
        3 // cursor outside
      );
      cleanup = c;

      const items = getContextMenuItems(view, 10);
      items[0].action();

      expect(view.state.doc.toString()).toBe('hello world end');
    });
  });
});
