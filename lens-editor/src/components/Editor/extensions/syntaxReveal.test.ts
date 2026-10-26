import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createTestEditor, moveCursor, getTextWithClass } from '../../../test/codemirror-helpers';

describe('syntax easing in where the cursor goes', () => {
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.useRealTimers();
  });

  it("after a key, a heading's # fades in, quiet, and the marks come off once it has", () => {
    const { view, cleanup: c } = createTestEditor('## Title\n\nText', 14);
    cleanup = c;

    moveCursor(view, 5);
    expect(getTextWithClass(view, 'cm-syntax-fade')).toEqual(['## ']);
    expect(getTextWithClass(view, 'cm-header-mark')).toEqual(['##']);
    expect(view.dom.classList.contains('cm-syntax-growing')).toBe(false);

    vi.advanceTimersByTime(300);
    expect(getTextWithClass(view, 'cm-syntax-fade')).toEqual([]);
    expect(getTextWithClass(view, 'cm-header-mark')).toEqual(['##']);
  });

  it('after a click, it grows in, the cursor hidden until it has', () => {
    const { view, cleanup: c } = createTestEditor('## Title\n\nText', 14);
    cleanup = c;

    view.contentDOM.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    moveCursor(view, 5);
    document.dispatchEvent(new Event('pointerup'));
    expect(getTextWithClass(view, 'cm-syntax-grow')).toEqual(['## ']);
    expect(view.dom.classList.contains('cm-syntax-growing')).toBe(true);

    vi.advanceTimersByTime(300);
    expect(getTextWithClass(view, 'cm-syntax-grow')).toEqual([]);
    expect(view.dom.classList.contains('cm-syntax-growing')).toBe(false);
  });

  it('an edit ends it, so typing never replays it', () => {
    const { view, cleanup: c } = createTestEditor('## Title\n\nText', 14);
    cleanup = c;

    moveCursor(view, 5);
    view.dispatch({ changes: { from: 8, insert: 's' }, selection: { anchor: 9 } });
    expect(getTextWithClass(view, 'cm-syntax-fade')).toEqual([]);
  });

  it("covers bold, a link's brackets and URL, and the > on each line of a quote", () => {
    const doc = '> a **b**\n> c\n\nSee [x](https://e.org) now\n\nEnd';
    const { view, cleanup: c } = createTestEditor(doc, doc.length);
    cleanup = c;

    moveCursor(view, doc.indexOf('b**'));
    expect(getTextWithClass(view, 'cm-syntax-fade')).toEqual(['> ', '**', '**', '> ']);

    vi.advanceTimersByTime(300);
    moveCursor(view, doc.indexOf('x]'));
    expect(getTextWithClass(view, 'cm-syntax-fade')).toEqual(['[', ']', '(', 'https://e.org', ')']);
  });

  it('leaves alone syntax that was showing already', () => {
    const { view, cleanup: c } = createTestEditor('## Title\n\nText', 3);
    cleanup = c;

    moveCursor(view, 6);
    expect(getTextWithClass(view, 'cm-syntax-fade')).toEqual([]);
  });
});
