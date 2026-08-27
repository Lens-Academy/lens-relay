import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { DecorationSet, ViewPlugin } from '@codemirror/view';
import * as Y from 'yjs';
import { pickLineCategory, actorDisplayName, authorshipExtension, setAuthorshipMode, setRecentWindow, setRecentEnabled } from './authorship';
import { ACTIVITY_MAP } from '../../../lib/activity';

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

  it('recent overlay tints surviving text from an event and ghosts removed text, on any mode', () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('contents');
    ytext.insert(0, 'Human start. ');
    const humanClient = ydoc.clientID;

    // An "AI" replica inserts text and records the event like the relay does.
    const ai = new Y.Doc();
    Y.applyUpdate(ai, Y.encodeStateAsUpdate(ydoc));
    const aitext = ai.getText('contents');
    const clockFrom = Y.getState(ai.store, ai.clientID);
    aitext.insert('Human start. '.length, 'AI middle. ');
    const clockTo = Y.getState(ai.store, ai.clientID);
    const anchor = Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(aitext, 'Human start. '.length, 0)
    );
    ai.getMap(ACTIVITY_MAP).set('e1', {
      v: 1, ts: Date.now() - 60_000, actor: 'ai:fable-5:luc', author: "Luc's AI", mode: 'direct',
      kind: 'replace', old: 'gone', new: 'AI middle. ', old_truncated: false, new_truncated: false,
      ctx_before: 'Human start. ', ctx_after: '', pos: 13, client: ai.clientID,
      clock_from: clockFrom, clock_to: clockTo, anchor,
    });
    // A stale event outside the window must not render.
    ai.getMap(ACTIVITY_MAP).set('e0', {
      v: 1, ts: Date.now() - 10 * 86400_000, actor: 'ai:fable-5:luc', author: "Luc's AI", mode: 'direct',
      kind: 'insert', old: '', new: 'Human', old_truncated: false, new_truncated: false,
      ctx_before: '', ctx_after: '', pos: 0, client: humanClient, clock_from: 0, clock_to: 5, anchor: null,
    });
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(ai));
    expect(ytext.toString()).toBe('Human start. AI middle. ');

    const extensions = authorshipExtension(ytext);
    const plugin = (extensions as unknown[])[1] as ViewPlugin<PluginInstance>;
    const view = new EditorView({
      state: EditorState.create({ doc: ytext.toString(), extensions }),
      parent: document.body,
    });
    try {
      view.dispatch({ effects: [setAuthorshipMode.of('hidden'), setRecentEnabled.of(true), setRecentWindow.of(3600_000)] });
      const decos = view.plugin(plugin)!.decorations;
      const marks: Array<[number, number]> = [];
      let ghosts = 0;
      decos.between(0, view.state.doc.length, (from, to, value) => {
        const cls = (value.spec as { class?: string }).class;
        if (cls === 'cm-recent-insert') marks.push([from, to]);
        if ((value.spec as { widget?: unknown }).widget) ghosts += 1;
      });
      expect(marks).toEqual([[13, 24]]);
      expect(ghosts).toBe(1);
      expect(view.contentDOM.querySelector('.cm-recent-ghost')?.textContent).toBe('gone');
      expect(view.contentDOM.querySelector('.cm-recent-tray')).toBeNull();

      // Layered on gutter mode: authorship line strips and recent marks coexist.
      view.dispatch({ effects: setAuthorshipMode.of('gutter') });
      const layered = view.plugin(plugin)!.decorations;
      let recentMarks = 0;
      let lineDecos = 0;
      layered.between(0, view.state.doc.length, (_f, _t, value) => {
        const cls = (value.spec as { class?: string }).class ?? '';
        if (cls === 'cm-recent-insert') recentMarks += 1;
        if (cls.startsWith('cm-authline-')) lineDecos += 1;
      });
      expect(recentMarks).toBe(1);
      expect(lineDecos).toBeGreaterThanOrEqual(2); // authorship strip + recent strip
    } finally {
      view.destroy();
    }
  });
});
