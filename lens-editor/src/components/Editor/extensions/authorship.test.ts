import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { DecorationSet, ViewPlugin } from '@codemirror/view';
import * as Y from 'yjs';
import { pickLineCategory, actorDisplayName, authorshipExtension, setAuthorshipMode } from './authorship';

describe('pickLineCategory', () => {
  it('returns null for empty lines', () => {
    expect(pickLineCategory({ human: 0, ai: 0, unknown: 0 })).toBeNull();
  });

  it('majority wins for near-pure lines', () => {
    expect(pickLineCategory({ human: 90, ai: 10, unknown: 0 })).toBe('human');
    expect(pickLineCategory({ human: 10, ai: 90, unknown: 0 })).toBe('ai');
    expect(pickLineCategory({ human: 0, ai: 0, unknown: 50 })).toBe('unknown');
  });

  it('marks genuinely mixed human/AI lines', () => {
    expect(pickLineCategory({ human: 50, ai: 50, unknown: 0 })).toBe('mixed');
    expect(pickLineCategory({ human: 30, ai: 60, unknown: 10 })).toBe('mixed');
  });

  it('small touch-ups stay majority-colored, not mixed', () => {
    // 10% human edit inside an AI paragraph
    expect(pickLineCategory({ human: 10, ai: 90, unknown: 0 })).toBe('ai');
  });

  it('human/unknown mixtures never stripe (mixed is human+AI only)', () => {
    expect(pickLineCategory({ human: 50, ai: 0, unknown: 50 })).toBe('human');
  });
});

describe('expandedLabel', () => {
  it('shows the single author name', async () => {
    const { expandedLabel } = await import('./authorship');
    expect(expandedLabel(['human:Luc'])).toBe('Luc');
    expect(expandedLabel([undefined])).toBe('Unknown');
  });

  it('shows dominant author +N for multi-author lines', async () => {
    const { expandedLabel } = await import('./authorship');
    expect(expandedLabel(['human:Luc', 'ai:fable-5:Luc'])).toBe('Luc +1');
    expect(expandedLabel(['ai:fable-5:Luc', 'human:Luc', undefined])).toBe('fable-5 (Luc) +2');
    expect(expandedLabel([])).toBe('');
  });
});

describe('actorDisplayName', () => {
  it('formats the three actor shapes', () => {
    expect(actorDisplayName('human:Luc')).toBe('Luc');
    expect(actorDisplayName('ai:fable-5:Luc')).toBe('fable-5 (Luc)');
    expect(actorDisplayName('ai:unknown:Luc')).toBe('AI (Luc)');
    expect(actorDisplayName('ai:fable-5')).toBe('fable-5');
    expect(actorDisplayName(undefined)).toBe('Unknown');
  });
});

describe('AuthorshipPlugin decorations on Y/CM length mismatch', () => {
  // The plugin is the second entry of the extension array (not exported on
  // its own); grab it so we can read the live instance's decorations.
  type PluginInstance = { decorations: DecorationSet };

  function maxDecorationEnd(decorations: DecorationSet): number {
    let max = 0;
    const iter = decorations.iter();
    while (iter.value) {
      max = Math.max(max, iter.to);
      iter.next();
    }
    return max;
  }

  it('never leaves decorations past the doc end when the Y.Text is ahead', () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('contents');
    ytext.insert(0, 'hello world');

    const extensions = authorshipExtension(ytext);
    const plugin = (extensions as unknown[])[1] as ViewPlugin<PluginInstance>;

    const view = new EditorView({
      state: EditorState.create({ doc: 'hello world', extensions }),
      parent: document.body,
    });
    try {
      view.dispatch({ effects: setAuthorshipMode.of('inline') });
      // Precondition: in-sync doc produces decorations covering the text.
      expect(maxDecorationEnd(view.plugin(plugin)!.decorations)).toBe(11);

      // CM-only deletion (no yCollab here): the Y.Text (11 chars) is now
      // ahead of the CM doc (5 chars) — the mid-sync edge where recompute
      // skips. The previous decorations must be mapped through the change,
      // not kept at stale positions past the end of the document.
      view.dispatch({ changes: { from: 5, to: 11 } });
      expect(maxDecorationEnd(view.plugin(plugin)!.decorations)).toBeLessThanOrEqual(
        view.state.doc.length
      );
    } finally {
      view.destroy();
    }
  });
});
