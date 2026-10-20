import { describe, it, expect, vi } from 'vitest';
import { EditorSelection, EditorState, type SelectionRange, type TransactionSpec } from '@codemirror/state';
import { BlockType, type EditorView } from '@codemirror/view';
import { skippedLineTarget, stepLine } from './verticalMotion';

// happy-dom lays out no text, so these drive the commands with a stand-in for
// the view: its line blocks, what CodeMirror's vertical move returns and what
// a point hits are given. The real keys run in e2e/live-preview-arrow-keys.spec.ts.

interface Block {
  from: number;
  to: number;
  top: number;
  height: number;
  type?: BlockType | Block[];
}

const CONTENT_LEFT = 100;
const DOCUMENT_TOP = 10;

function fakeView(options: {
  doc: string;
  blocks: Block[];
  selection: EditorSelection;
  moved?: SelectionRange | (() => never);
  hit?: { pos: number; assoc: -1 | 1 } | (() => never);
}) {
  const state = EditorState.create({
    doc: options.doc,
    selection: options.selection,
    extensions: EditorState.allowMultipleSelections.of(true),
  });
  const blocks = options.blocks.map((b) => ({ type: BlockType.Text, ...b, bottom: b.top + b.height }));
  const view = {
    state,
    documentTop: DOCUMENT_TOP,
    contentDOM: { getBoundingClientRect: () => ({ left: CONTENT_LEFT }) },
    lineBlockAt: (pos: number) => blocks.find((b) => b.from <= pos && pos <= b.to)!,
    moveVertically: vi.fn(() => (typeof options.moved === 'function' ? options.moved() : options.moved!)),
    posAndSideAtCoords: vi.fn((coords: { x: number; y: number }) => {
      void coords;
      return typeof options.hit === 'function' ? options.hit() : options.hit!;
    }),
    dispatch: vi.fn((spec: TransactionSpec) => spec),
  };
  return view as typeof view & EditorView;
}

// Lines 1-3: "Intro" 0-5, "## Decisions" 6-18 (with top padding), "We move the review." 19-38
const doc = 'Intro\n## Decisions\nWe move the review.';
const blocks: Block[] = [
  { from: 0, to: 5, top: 0, height: 24 },
  { from: 6, to: 18, top: 24, height: 49 },
  { from: 19, to: 38, top: 73, height: 24 },
];
const onLine3 = EditorSelection.single(29); // "We move th|e review."
const throws = () => { throw new TypeError("Cannot read properties of undefined (reading 'top')"); };

describe('skippedLineTarget', () => {
  it('puts the cursor on the line CodeMirror jumped over, under the same column', () => {
    const view = fakeView({
      doc, blocks, selection: onLine3,
      moved: EditorSelection.cursor(3, 1, undefined, 80), // landed on line 1
      hit: { pos: 15, assoc: 1 },
    });
    const target = skippedLineTarget(view, view.state.selection.main, false)!;
    expect([target.head, target.goalColumn, target.assoc]).toEqual([15, 80, 1]);
    // At the column, inside the line's last row
    expect(view.posAndSideAtCoords).toHaveBeenCalledWith({ x: CONTENT_LEFT + 80, y: DOCUMENT_TOP + 24 + 49 - 1 }, false);
  });

  it('aims at the first row of the line below when going down', () => {
    const view = fakeView({
      doc, blocks, selection: EditorSelection.single(2),
      moved: EditorSelection.cursor(30, 1, undefined, 20), // landed on line 3
      hit: { pos: 8, assoc: -1 },
    });
    expect(skippedLineTarget(view, view.state.selection.main, true)?.head).toBe(8);
    expect(view.posAndSideAtCoords).toHaveBeenCalledWith({ x: CONTENT_LEFT + 20, y: DOCUMENT_TOP + 24 + 1 }, false);
  });

  it('leaves a move that lands on the next line to CodeMirror', () => {
    const view = fakeView({ doc, blocks, selection: onLine3, moved: EditorSelection.cursor(12, 1, undefined, 80) });
    expect(skippedLineTarget(view, view.state.selection.main, false)).toBeNull();
    expect(view.posAndSideAtCoords).not.toHaveBeenCalled();
  });

  it('counts landing at the start of the document as a jump over the first line', () => {
    // CodeMirror falls through to position 0 when it takes "## Title" for padding
    const view = fakeView({
      doc: '## Title\nBody text',
      blocks: [{ from: 0, to: 8, top: 0, height: 49 }, { from: 9, to: 18, top: 49, height: 24 }],
      selection: EditorSelection.single(14),
      moved: EditorSelection.cursor(0, 1, undefined, 40),
      hit: { pos: 5, assoc: 1 },
    });
    expect(skippedLineTarget(view, view.state.selection.main, false)?.head).toBe(5);
  });

  describe('lines between', () => {
    // "One" 0-3, "## Two" 4-10, line 3 11-16, "Four" 17-21
    const fourLines = 'One\n## Two\n| t |\nFour';
    const around = (third: Partial<Block>): Block[] => [
      { from: 0, to: 3, top: 0, height: 24 },
      { from: 4, to: 10, top: 24, height: 49 },
      { from: 11, to: 16, top: 73, height: 40, ...third },
      { from: 17, to: 21, top: 113, height: 24 },
    ];

    it.each([
      ['a block widget (a table)', { type: BlockType.WidgetRange }],
      ['a line collapsed to nothing', { height: 0 }],
    ])('passes over %s to the line of text beyond it', (_, third) => {
      const view = fakeView({
        doc: fourLines, blocks: around(third), selection: EditorSelection.single(19),
        moved: EditorSelection.cursor(1, 1, undefined, 50), // landed on "One", past "## Two"
        hit: { pos: 7, assoc: 1 },
      });
      expect(skippedLineTarget(view, view.state.selection.main, false)?.head).toBe(7);
    });

    it('leaves a line that holds a block widget to CodeMirror', () => {
      const view = fakeView({
        doc: fourLines,
        blocks: around({ type: [{ from: 11, to: 11, top: 73, height: 16 }] }),
        selection: EditorSelection.single(19),
        moved: EditorSelection.cursor(1, 1, undefined, 50),
        hit: { pos: 7, assoc: 1 },
      });
      expect(skippedLineTarget(view, view.state.selection.main, false)).toBeNull();
    });
  });

  it('gives up, leaving the key to CodeMirror, when its measuring throws or misses the line', () => {
    const cases = [
      { moved: throws },
      { moved: EditorSelection.cursor(3, 1, undefined, 80), hit: throws },
      { moved: EditorSelection.cursor(3, 1, undefined, 80), hit: { pos: 2, assoc: 1 as const } }, // not on line 2
      { moved: EditorSelection.cursor(3) }, // no goal column
    ];
    for (const c of cases) {
      const view = fakeView({ doc, blocks, selection: onLine3, ...c });
      expect(skippedLineTarget(view, view.state.selection.main, false)).toBeNull();
    }
  });

  it('has nothing to do at the first line going up', () => {
    const view = fakeView({ doc, blocks, selection: EditorSelection.single(2), moved: EditorSelection.cursor(0) });
    expect(skippedLineTarget(view, view.state.selection.main, false)).toBeNull();
    expect(view.moveVertically).not.toHaveBeenCalled();
  });
});

describe('stepLine', () => {
  const jumpOverLine2 = { doc, blocks, moved: EditorSelection.cursor(3, 1, undefined, 80), hit: { pos: 15, assoc: 1 as const } };

  it('moves the cursor onto the skipped line as one selection, keeping its goal column', () => {
    const view = fakeView({ ...jumpOverLine2, selection: onLine3 });
    expect(stepLine(view, false, false)).toBe(true);
    const spec = view.dispatch.mock.calls[0][0];
    // A bare range would be read as { anchor, head } and lose the goal column
    expect(spec.selection).toBeInstanceOf(EditorSelection);
    const main = (spec.selection as EditorSelection).main;
    expect([main.head, main.goalColumn]).toEqual([15, 80]);
    expect(spec.scrollIntoView).toBe(true);
    expect(spec.userEvent).toBe('select');
  });

  it('extends the selection with Shift, keeping its anchor', () => {
    const view = fakeView({ ...jumpOverLine2, selection: EditorSelection.single(35, 29) });
    expect(stepLine(view, false, true)).toBe(true);
    const main = (view.dispatch.mock.calls[0][0].selection as EditorSelection).main;
    expect([main.anchor, main.head, main.goalColumn]).toEqual([35, 15, 80]);
  });

  it('leaves several cursors, a selection without Shift, and normal moves to CodeMirror', () => {
    const several = fakeView({ ...jumpOverLine2, selection: EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(29)], 1) });
    const selected = fakeView({ ...jumpOverLine2, selection: EditorSelection.single(35, 29) });
    const normal = fakeView({ doc, blocks, selection: onLine3, moved: EditorSelection.cursor(12, 1, undefined, 80) });
    expect(stepLine(several, false, false)).toBe(false);
    expect(stepLine(selected, false, false)).toBe(false);
    expect(stepLine(normal, false, false)).toBe(false);
    for (const view of [several, selected, normal]) expect(view.dispatch).not.toHaveBeenCalled();
  });
});
