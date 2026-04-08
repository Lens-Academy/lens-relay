import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ySectionSync, ySectionSyncAnnotation, ySectionSyncFacet } from './y-section-sync';

// Helper: create a Y.Doc with a Y.Text pre-filled with `text`,
// and an EditorView syncing [sectionFrom, sectionTo).
function setup(fullText: string, sectionFrom: number, sectionTo: number, opts?: { awareness?: Awareness }) {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('contents');
  ytext.insert(0, fullText);

  const sectionContent = fullText.slice(sectionFrom, sectionTo);

  const state = EditorState.create({
    doc: sectionContent,
    extensions: [
      ySectionSync(ytext, sectionFrom, sectionTo, opts),
    ],
  });
  const view = new EditorView({ state, parent: document.body });

  return { ydoc, ytext, view };
}

// Collect views for cleanup
const views: EditorView[] = [];
function tracked<T extends { view: EditorView }>(result: T): T {
  views.push(result.view);
  return result;
}
afterEach(() => {
  views.forEach((v) => v.destroy());
  views.length = 0;
});

describe('y-section-sync', () => {
  describe('CM → Y.Text', () => {
    it('insert in CM appears at correct offset in Y.Text', () => {
      // "AAABBBCCC" with section [3,6) = "BBB"
      const { ytext, view } = tracked(setup('AAABBBCCC', 3, 6));

      // Insert "XX" at position 1 in CM (between first and second B)
      view.dispatch({
        changes: { from: 1, to: 1, insert: 'XX' },
      });

      // Y.Text should now be "AAABXXBBCCC"
      expect(ytext.toString()).toBe('AAABXXBBCCC');
    });

    it('delete in CM deletes at correct offset in Y.Text', () => {
      const { ytext, view } = tracked(setup('AAABBBCCC', 3, 6));

      // Delete 2 chars starting at position 0 in CM (first two B's)
      view.dispatch({
        changes: { from: 0, to: 2, insert: '' },
      });

      expect(ytext.toString()).toBe('AAABCCC');
    });

    it('does not create feedback loop (origin tracking)', () => {
      const { ytext, view } = tracked(setup('AAABBBCCC', 3, 6));

      // Simulate an external Y.Text change within the section
      // This should dispatch to CM with our annotation
      ytext.insert(4, 'X'); // Insert X after first B → "AAABXBBCCC"

      // CM should now have "BXBB" (the section grew by 1)
      expect(view.state.doc.toString()).toBe('BXBB');

      // The Y.Text should remain "AAABXBBCCC" — no feedback loop
      expect(ytext.toString()).toBe('AAABXBBCCC');
    });
  });

  describe('Y.Text → CM', () => {
    it('external insert within section appears in CM', () => {
      const { ytext, view } = tracked(setup('AAABBBCCC', 3, 6));

      ytext.insert(5, 'XX'); // After second B → "AAABBXXBCCC"

      expect(view.state.doc.toString()).toBe('BBXXB');
    });

    it('external insert before section shifts offsets, CM unchanged', () => {
      const { ytext, view } = tracked(setup('AAABBBCCC', 3, 6));

      ytext.insert(1, 'ZZ'); // Insert in "AAA" area → "AZZAABBBCCC"

      // CM content should be unchanged
      expect(view.state.doc.toString()).toBe('BBB');

      // But the section offsets should have shifted
      const conf = view.state.facet(ySectionSyncFacet);
      expect(conf.sectionFrom).toBe(5);
      expect(conf.sectionTo).toBe(8);
    });

    it('external insert after section does not affect CM', () => {
      const { ytext, view } = tracked(setup('AAABBBCCC', 3, 6));

      ytext.insert(7, 'ZZ'); // Insert in "CCC" area → "AAABBBCZZCCC"... wait
      // pos 7 is after 'C' at index 6, so: "AAABBBCZZCC"

      expect(view.state.doc.toString()).toBe('BBB');

      const conf = view.state.facet(ySectionSyncFacet);
      expect(conf.sectionFrom).toBe(3);
      expect(conf.sectionTo).toBe(6);
    });

    it('external delete spanning section start clips correctly', () => {
      // "AAABBBCCC" section [3,6) = "BBB"
      // Delete chars 1..4 → removes "AAB" → "ABBCCC"...
      // Wait, let me think: delete from pos 1, length 3 → removes chars at indices 1,2,3 → "A" + "BBCCC" = "ABBCCC"
      // The delete spans [1, 4) in old doc. Section was [3, 6).
      // Overlap with section: [3, 4) — 1 char inside section deleted.
      // Before section: [1, 3) — 2 chars before section deleted, so sectionFrom shifts by -2.
      // New sectionFrom = 3 - 2 = 1, and 1 char deleted from section start, so sectionTo = 6 - 2 - 1 = 3.
      // Section content becomes "BB" (the B at index 3 was deleted).
      const { ytext, view } = tracked(setup('AAABBBCCC', 3, 6));

      ytext.delete(1, 3); // Delete "AAB"

      expect(ytext.toString()).toBe('ABBCCC');
      expect(view.state.doc.toString()).toBe('BB');

      const conf = view.state.facet(ySectionSyncFacet);
      expect(conf.sectionFrom).toBe(1);
      expect(conf.sectionTo).toBe(3);
    });

    it('external insert at exact sectionFrom boundary shifts offsets', () => {
      const { ytext, view } = tracked(setup('AAABBBCCC', 3, 6));

      ytext.insert(3, 'ZZ'); // Insert at exact boundary

      // Treat as outside → shifts offsets
      expect(view.state.doc.toString()).toBe('BBB');

      const conf = view.state.facet(ySectionSyncFacet);
      expect(conf.sectionFrom).toBe(5);
      expect(conf.sectionTo).toBe(8);
    });

    it('external insert at exact sectionTo boundary does not affect CM', () => {
      const { ytext, view } = tracked(setup('AAABBBCCC', 3, 6));

      ytext.insert(6, 'ZZ'); // Insert at exact sectionTo

      expect(view.state.doc.toString()).toBe('BBB');

      const conf = view.state.facet(ySectionSyncFacet);
      expect(conf.sectionFrom).toBe(3);
      expect(conf.sectionTo).toBe(6);
    });
  });

  describe('consistency', () => {
    it('offset consistency after interleaved local/remote edits', () => {
      const { ytext, view } = tracked(setup('AAABBBCCC', 3, 6));
      const conf = view.state.facet(ySectionSyncFacet);

      // Local edit: insert "X" at CM pos 1
      view.dispatch({ changes: { from: 1, insert: 'X' } });
      expect(ytext.toString()).toBe('AAABXBBCCC');
      expect(ytext.toString().slice(conf.sectionFrom, conf.sectionTo))
        .toBe(view.state.doc.toString());

      // Remote edit: insert "YY" before section
      ytext.insert(0, 'YY');
      expect(ytext.toString().slice(conf.sectionFrom, conf.sectionTo))
        .toBe(view.state.doc.toString());

      // Remote edit: insert "Z" inside section
      ytext.insert(conf.sectionFrom + 2, 'Z');
      expect(ytext.toString().slice(conf.sectionFrom, conf.sectionTo))
        .toBe(view.state.doc.toString());

      // Local edit: delete first char of section
      view.dispatch({ changes: { from: 0, to: 1 } });
      expect(ytext.toString().slice(conf.sectionFrom, conf.sectionTo))
        .toBe(view.state.doc.toString());

      // Remote edit: delete after section
      ytext.delete(conf.sectionTo + 1, 1);
      expect(ytext.toString().slice(conf.sectionFrom, conf.sectionTo))
        .toBe(view.state.doc.toString());
    });
  });
});

describe('y-section-sync: awareness/cursors', () => {
  it('broadcasts local cursor position with sectionFrom offset', () => {
    const doc = new Y.Doc();
    const yt = doc.getText('contents');
    yt.insert(0, 'AAABBBCCC');
    const aw = new Awareness(doc);

    const state = EditorState.create({
      doc: 'BBB',
      extensions: [ySectionSync(yt, 3, 6, { awareness: aw })],
    });
    const v = new EditorView({ state, parent: document.body });
    views.push(v);

    // Place cursor at CM position 2 and focus
    v.focus();
    v.dispatch({ selection: { anchor: 2 } });
    v.dispatch({});

    const localState = aw.getLocalState();
    expect(localState).not.toBeNull();
    expect(localState!.cursor).toBeDefined();

    // Resolve anchor relative position to absolute
    const anchor = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(localState!.cursor.anchor),
      doc,
    );
    expect(anchor).not.toBeNull();
    // CM pos 2 + sectionFrom 3 = Y.Text pos 5
    expect(anchor!.index).toBe(5);
  });

  it('clears cursor when awareness cursor is set to null', () => {
    const doc = new Y.Doc();
    const yt = doc.getText('contents');
    yt.insert(0, 'AAABBBCCC');
    const aw = new Awareness(doc);

    const state = EditorState.create({
      doc: 'BBB',
      extensions: [ySectionSync(yt, 3, 6, { awareness: aw })],
    });
    const v = new EditorView({ state, parent: document.body });
    views.push(v);

    // Focus and place cursor
    v.focus();
    v.dispatch({ selection: { anchor: 1 } });
    v.dispatch({});

    expect(aw.getLocalState()!.cursor).toBeDefined();

    // Manually clear cursor (simulating blur behavior)
    aw.setLocalStateField('cursor', null);

    const localState = aw.getLocalState();
    expect(localState!.cursor).toBeNull();
  });
});
