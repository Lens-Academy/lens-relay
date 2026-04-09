import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ySectionSync, ySectionSyncAnnotation, ySectionSyncFacet, ySectionUndoManagerKeymap } from './y-section-sync';

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

    it('insert at end of trimmed section stays before trailing newlines', () => {
      // Simulate trimmed section: "AAABBB\n\nCCC" with editTo=6 (after trimming \n\n)
      // CM contains "AAABBB", user types at end
      const { ytext, view } = tracked(setup('AAABBB\n\nCCC', 0, 6));

      expect(view.state.doc.toString()).toBe('AAABBB');

      // Insert at end of CM
      view.dispatch({ changes: { from: 6, insert: 'X' } });

      // X should appear at Y.Text pos 6 (before the \n\n)
      expect(ytext.toString()).toBe('AAABBBX\n\nCCC');
    });

    it('replace in CM maps to correct Y.Text range', () => {
      const { ytext, view } = tracked(setup('AAABBBCCC', 3, 6));
      // Replace "BB" (CM pos 0..2) with "XYZ"
      view.dispatch({ changes: { from: 0, to: 2, insert: 'XYZ' } });
      expect(ytext.toString()).toBe('AAAXYZBCCC');
    });

    it('multi-change CM transaction applies both changes at correct Y.Text positions', () => {
      // "AAABBBCCC" section [3,6) = "BBB"
      // Replace B at CM pos 0 with X, and B at CM pos 2 with Y (two disjoint changes)
      const { ytext, view } = tracked(setup('AAABBBCCC', 3, 6));

      view.dispatch({
        changes: [
          { from: 0, to: 1, insert: 'X' },
          { from: 2, to: 3, insert: 'Y' },
        ],
      });

      // Both substitutions should land at correct absolute positions
      expect(ytext.toString()).toBe('AAAXBYCCC');
      expect(view.state.doc.toString()).toBe('XBY');
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

    it('external insert at exact sectionFrom boundary goes into section', () => {
      const { ytext, view } = tracked(setup('AAABBBCCC', 3, 6));

      ytext.insert(3, 'ZZ'); // Insert at exact boundary

      // Inclusive boundary: insert at sectionFrom goes into CM
      expect(view.state.doc.toString()).toBe('ZZBBB');

      const conf = view.state.facet(ySectionSyncFacet);
      expect(conf.sectionFrom).toBe(3);
      expect(conf.sectionTo).toBe(8);
    });

    it('external insert at exact sectionTo boundary goes into section', () => {
      const { ytext, view } = tracked(setup('AAABBBCCC', 3, 6));

      ytext.insert(6, 'ZZ'); // Insert at exact sectionTo

      // Inclusive boundary: insert at sectionTo appends to CM
      expect(view.state.doc.toString()).toBe('BBBZZ');

      const conf = view.state.facet(ySectionSyncFacet);
      expect(conf.sectionFrom).toBe(3);
      expect(conf.sectionTo).toBe(8);
    });

    it('external delete entirely within section', () => {
      const { ytext, view } = tracked(setup('AAABBBCCC', 3, 6));
      ytext.delete(4, 1); // Delete middle B → "AAABBCCC"
      expect(view.state.doc.toString()).toBe('BB');
      const conf = view.state.facet(ySectionSyncFacet);
      expect(conf.sectionTo).toBe(5);
    });

    it('external delete spanning section end clips correctly', () => {
      // "AAABBBCCC" section [3,6), delete [4,8) = "BBCC" (4 chars)
      const { ytext, view } = tracked(setup('AAABBBCCC', 3, 6));
      ytext.delete(4, 4); // Delete "BBCC"
      // Result: "AAA" + "B" + "C" = "AAABC"
      expect(ytext.toString()).toBe('AAABC');
      // Only "B" (index 3 in original) remains in section, rest was deleted
      expect(view.state.doc.toString()).toBe('B');
    });

    it('external delete entirely before section shifts offsets', () => {
      const { ytext, view } = tracked(setup('AAABBBCCC', 3, 6));
      ytext.delete(0, 2); // Delete "AA" → "ABBBCCC"
      expect(view.state.doc.toString()).toBe('BBB');
      const conf = view.state.facet(ySectionSyncFacet);
      expect(conf.sectionFrom).toBe(1);
      expect(conf.sectionTo).toBe(4);
    });

    it('external delete starting at exact sectionTo does not affect section', () => {
      // "AAABBBCCC" section [3,6), delete starting at pos 6 (sectionTo)
      const { ytext, view } = tracked(setup('AAABBBCCC', 3, 6));
      ytext.delete(6, 2); // Delete "CC" → "AAABBBC"
      expect(view.state.doc.toString()).toBe('BBB');
      const conf = view.state.facet(ySectionSyncFacet);
      expect(conf.sectionFrom).toBe(3);
      expect(conf.sectionTo).toBe(6);
    });
  });

  describe('consistency', () => {
    it('multiple sequential CM edits maintain consistency', () => {
      const { ytext, view } = tracked(setup('AAABBBCCC', 3, 6));
      const conf = view.state.facet(ySectionSyncFacet);

      // Edit 1: insert
      view.dispatch({ changes: { from: 0, insert: 'X' } });
      expect(ytext.toString().slice(conf.sectionFrom, conf.sectionTo))
        .toBe(view.state.doc.toString());

      // Edit 2: delete
      view.dispatch({ changes: { from: 1, to: 3 } });
      expect(ytext.toString().slice(conf.sectionFrom, conf.sectionTo))
        .toBe(view.state.doc.toString());

      // Edit 3: replace
      view.dispatch({ changes: { from: 0, to: 1, insert: 'YZ' } });
      expect(ytext.toString().slice(conf.sectionFrom, conf.sectionTo))
        .toBe(view.state.doc.toString());
    });

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

  describe('undo/redo', () => {
    it('undo reverts CM content after local edit', () => {
      const { ytext, view } = tracked(setup('AAABBBCCC', 3, 6));
      const conf = view.state.facet(ySectionSyncFacet);

      // Type something
      view.dispatch({ changes: { from: 1, insert: 'X' } });
      expect(view.state.doc.toString()).toBe('BXBB');
      expect(ytext.toString()).toBe('AAABXBBCCC');

      // Undo via UndoManager
      conf.undoManager.undo();

      // CM should revert
      expect(view.state.doc.toString()).toBe('BBB');
      expect(ytext.toString()).toBe('AAABBBCCC');
    });

    it('redo after undo restores content', () => {
      const { ytext, view } = tracked(setup('AAABBBCCC', 3, 6));
      const conf = view.state.facet(ySectionSyncFacet);

      view.dispatch({ changes: { from: 1, insert: 'X' } });
      expect(view.state.doc.toString()).toBe('BXBB');

      conf.undoManager.undo();
      expect(view.state.doc.toString()).toBe('BBB');

      conf.undoManager.redo();
      expect(view.state.doc.toString()).toBe('BXBB');
      expect(ytext.toString()).toBe('AAABXBBCCC');
    });

    it('undo of delete at section start updates CM view', () => {
      const { ytext, view } = tracked(setup('AAABBBCCC', 3, 6));
      const conf = view.state.facet(ySectionSyncFacet);

      // Delete at CM position 0 (= Y.Text sectionFrom boundary)
      view.dispatch({ changes: { from: 0, to: 2 } });
      expect(view.state.doc.toString()).toBe('B');
      expect(ytext.toString()).toBe('AAABCCC');

      // Undo should restore deleted text in both Y.Text AND CM
      conf.undoManager.undo();
      expect(ytext.toString()).toBe('AAABBBCCC');
      expect(view.state.doc.toString()).toBe('BBB');
    });

    it('undo of delete at section end updates CM view', () => {
      const { ytext, view } = tracked(setup('AAABBBCCC', 3, 6));
      const conf = view.state.facet(ySectionSyncFacet);

      // Delete at end of section
      view.dispatch({ changes: { from: 1, to: 3 } });
      expect(view.state.doc.toString()).toBe('B');
      expect(ytext.toString()).toBe('AAABCCC');

      // Undo
      conf.undoManager.undo();
      expect(ytext.toString()).toBe('AAABBBCCC');
      expect(view.state.doc.toString()).toBe('BBB');
    });

    it('undo with empty stack is a no-op', () => {
      const { view } = tracked(setup('AAABBBCCC', 3, 6));
      const conf = view.state.facet(ySectionSyncFacet);

      const result = conf.undoManager.undo();
      expect(result).toBeNull();
      expect(view.state.doc.toString()).toBe('BBB');
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

  it('cursor position stays correct after local edits', () => {
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

    v.focus();

    // Type "XX" at CM position 1
    v.dispatch({ changes: { from: 1, insert: 'XX' } });
    expect(v.state.doc.toString()).toBe('BXXBB');
    expect(yt.toString()).toBe('AAABXXBBCCC');

    // Place cursor at CM position 3 (after "XX")
    v.dispatch({ selection: { anchor: 3 } });
    v.dispatch({});

    const localState = aw.getLocalState();
    const anchor = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(localState!.cursor.anchor),
      doc,
    );
    // CM pos 3 + sectionFrom 3 = Y.Text pos 6
    expect(anchor!.index).toBe(6);
  });

  it('cursor position stays correct after external insert before section', () => {
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

    v.focus();

    // External insert before section
    yt.insert(0, 'ZZ');
    // sectionFrom should now be 5, sectionTo 8
    expect(yt.toString()).toBe('ZZAAABBBCCC');

    // Place cursor at CM position 1
    v.dispatch({ selection: { anchor: 1 } });
    v.dispatch({});

    const localState = aw.getLocalState();
    const anchor = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(localState!.cursor.anchor),
      doc,
    );
    // CM pos 1 + sectionFrom 5 = Y.Text pos 6
    expect(anchor!.index).toBe(6);
  });

  it('cursor position stays correct after external insert at sectionFrom', () => {
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

    v.focus();

    // External insert at exact sectionFrom (now goes into section with inclusive boundaries)
    yt.insert(3, 'ZZ');
    // With inclusive boundaries: insert goes into CM, sectionFrom stays 3, sectionTo becomes 8
    expect(v.state.doc.toString()).toBe('ZZBBB');
    expect(yt.toString()).toBe('AAAZZBBBCCC');

    // Place cursor at CM position 4 (on second B)
    v.dispatch({ selection: { anchor: 4 } });
    v.dispatch({});

    const localState = aw.getLocalState();
    const anchor = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(localState!.cursor.anchor),
      doc,
    );
    // CM pos 4 + sectionFrom 3 = Y.Text pos 7
    expect(anchor!.index).toBe(7);
  });
});
