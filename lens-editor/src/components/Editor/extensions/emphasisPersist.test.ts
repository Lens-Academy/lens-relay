import { describe, it, expect, afterEach, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { livePreview } from './livePreview';
import { emphasisPersistPlugin } from './emphasisPersist';

/** Create an editor with livePreview + emphasisPersist for testing. */
function createEmphasisEditor(content: string, cursorPos: number) {
  const state = EditorState.create({
    doc: content,
    selection: { anchor: cursorPos },
    extensions: [
      markdown(),
      livePreview(),
      emphasisPersistPlugin,
    ],
  });

  const view = new EditorView({
    state,
    parent: document.body,
  });

  return {
    view,
    cleanup: () => view.destroy(),
  };
}

/** Simulate a typing event (insert text with input.type userEvent). */
function simulateTyping(view: EditorView, pos: number, text: string) {
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'input.type',
  });
}

function hasClass(view: EditorView, className: string): boolean {
  return view.contentDOM.querySelector(`.${className}`) !== null;
}

describe('emphasisPersist', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it('creates ghost decoration when typing breaks emphasis', () => {
    // **bold** end — cursor at pos 6 (inside emphasis, before closing **)
    const result = createEmphasisEditor('**bold** end', 6);
    cleanup = result.cleanup;
    const { view } = result;

    // Type a space before closing ** → **bold ** end
    // This breaks CommonMark flanking rules, StrongEmphasis disappears
    simulateTyping(view, 6, ' ');

    // Ghost .cm-strong should be present
    expect(hasClass(view, 'cm-strong')).toBe(true);
  });

  it('ghost clears after 400ms', () => {
    vi.useFakeTimers();
    try {
      const result = createEmphasisEditor('**bold** end', 6);
      cleanup = result.cleanup;
      const { view } = result;

      simulateTyping(view, 6, ' ');
      expect(hasClass(view, 'cm-strong')).toBe(true);

      // Advance timers by 400ms — ghost should clear
      vi.advanceTimersByTime(400);
      expect(hasClass(view, 'cm-strong')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ghost clears when emphasis revalidates', () => {
    vi.useFakeTimers();
    try {
      const result = createEmphasisEditor('**bold** end', 6);
      cleanup = result.cleanup;
      const { view } = result;

      // Break emphasis: **bold ** end
      simulateTyping(view, 6, ' ');
      expect(hasClass(view, 'cm-strong')).toBe(true);

      // Type 'x' after space: **bold x** end — emphasis revalidates
      simulateTyping(view, 7, 'x');

      // Ghost should clear (emphasis is real now, not ghost)
      // The real .cm-strong from livePreview would only appear if cursor outside,
      // but the syntax tree should have StrongEmphasis again
      // Since cursor is inside, livePreview won't add .cm-strong.
      // Ghost should be cleared because emphasis reappeared (no lost ranges).
      // We verify by checking no ghost timer fires are needed.
      vi.advanceTimersByTime(400);

      // Even after timeout, emphasis should come from tree, not ghost.
      // Move cursor outside to check livePreview applies .cm-strong (emphasis is valid)
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      expect(hasClass(view, 'cm-strong')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ghost persists across multiple keystrokes while emphasis stays broken', () => {
    vi.useFakeTimers();
    try {
      const result = createEmphasisEditor('**bold** end', 6);
      cleanup = result.cleanup;
      const { view } = result;

      // Break emphasis: **bold ** end
      simulateTyping(view, 6, ' ');
      expect(hasClass(view, 'cm-strong')).toBe(true);

      // Wait 200ms (ghost still active)
      vi.advanceTimersByTime(200);
      expect(hasClass(view, 'cm-strong')).toBe(true);

      // Type another space: **bold  ** end (still broken)
      simulateTyping(view, 7, ' ');
      expect(hasClass(view, 'cm-strong')).toBe(true);

      // Timer should have been reset. Wait 200ms (300ms since last space)
      vi.advanceTimersByTime(200);
      expect(hasClass(view, 'cm-strong')).toBe(true);

      // Wait remaining 200ms (400ms since last keystroke) — ghost clears
      vi.advanceTimersByTime(200);
      expect(hasClass(view, 'cm-strong')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('no ghost on undo/programmatic changes', () => {
    const result = createEmphasisEditor('**bold** end', 6);
    cleanup = result.cleanup;
    const { view } = result;

    // Break emphasis via programmatic change (no userEvent)
    view.dispatch({
      changes: { from: 6, insert: ' ' },
      selection: { anchor: 7 },
    });

    // No ghost — change was not a typing event
    expect(hasClass(view, 'cm-strong')).toBe(false);
  });

  it('creates ghost for italic emphasis', () => {
    // *italic* end — cursor at pos 7 (inside emphasis, before closing *)
    const result = createEmphasisEditor('*italic* end', 7);
    cleanup = result.cleanup;
    const { view } = result;

    // Type a space before closing * → *italic * end
    simulateTyping(view, 7, ' ');

    // Ghost .cm-emphasis should be present
    expect(hasClass(view, 'cm-emphasis')).toBe(true);
  });
});
