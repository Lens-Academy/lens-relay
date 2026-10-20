/**
 * What copying, cutting and dragging take from the document.
 *
 * CodeMirror copies and cuts the selected ranges, joined by line breaks, or
 * with nothing selected the cursor lines, and drags the main selection.
 * Extensions can leave parts of those ranges off the clipboard with
 * `piecesToCopy`. A clipboard filter then makes the copied or dragged text from
 * the pieces left (a selection with none left copies nothing), and
 * keepAuthorship remembers the authors of the same pieces, so that a paste of
 * that text keeps them.
 */
import { Facet } from '@codemirror/state';
import type { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

export interface DocRange {
  from: number;
  to: number;
}

/**
 * The ranges a copy or cut of the selection takes, as CodeMirror's take them:
 * the selected ranges, or with nothing selected each cursor's line with its
 * line break (`linewise`: the line goes on the clipboard without it).
 */
export function copiedRanges(state: EditorState): { ranges: DocRange[]; linewise: boolean } {
  const ranges = state.selection.ranges.filter((r) => !r.empty).map((r) => ({ from: r.from, to: r.to }));
  if (ranges.length) return { ranges, linewise: false };
  let upto = -1;
  for (const { from } of state.selection.ranges) {
    const line = state.doc.lineAt(from);
    if (line.number > upto) ranges.push({ from: line.from, to: Math.min(state.doc.length, line.to + 1) });
    upto = line.number;
  }
  return { ranges, linewise: true };
}

/**
 * The parts of what a copy, cut or drag takes that go on the clipboard: given
 * the ranges taken (sorted), a function returns the pieces of them to copy,
 * sorted and apart. Several apply one after the other.
 */
export const piecesToCopy = Facet.define<(state: EditorState, ranges: readonly DocRange[]) => DocRange[]>({
  enables: (self) => [
    EditorView.clipboardOutputFilter.of((text, state) => (state.facet(self).length ? filtered(text, state) : text)),
    EditorView.domEventHandlers({ copy: copyNothing, cut: copyNothing }),
  ],
});

/**
 * For each of `ranges` (as copiedRanges gives them, or a dragged selection),
 * the pieces of it that go on the clipboard, up to the end of its text: a
 * `linewise` range's line break stays off.
 */
export function copiedPieces(state: EditorState, ranges: readonly DocRange[], linewise: boolean): DocRange[][] {
  let pieces: readonly DocRange[] = ranges;
  for (const narrow of state.facet(piecesToCopy)) pieces = narrow(state, pieces);
  return ranges.map((range) => {
    const end = linewise ? state.doc.lineAt(range.from).to : range.to;
    return pieces
      .map((p) => ({ from: Math.max(p.from, range.from), to: Math.min(p.to, end) }))
      .filter((p) => p.from < p.to);
  });
}

/** The clipboard text of copiedPieces: each range's pieces run together, the ranges joined by line breaks */
export function piecesText(state: EditorState, pieces: readonly (readonly DocRange[])[]): string {
  return pieces.map((range) => range.map((p) => state.sliceDoc(p.from, p.to)).join('')).join(state.lineBreak);
}

/**
 * `text` as a copy, cut or drag puts it on the clipboard. CodeMirror hands
 * over the text of the ranges it takes; this works out which those are (the
 * selected ranges or cursor lines for a copy or cut, the main selection for a
 * drag) and makes the text from their pieces instead. Other text stays as it is.
 */
function filtered(text: string, state: EditorState): string {
  const { main } = state.selection;
  const taken = [copiedRanges(state), { ranges: [{ from: main.from, to: main.to }], linewise: false }];
  for (const { ranges, linewise } of taken) {
    const whole = ranges.map((r) => (linewise ? state.doc.lineAt(r.from).text : state.sliceDoc(r.from, r.to)));
    if (whole.join(state.lineBreak) === text) return piecesText(state, copiedPieces(state, ranges, linewise));
  }
  return text;
}

/**
 * A copy or cut of a selection that piecesToCopy leaves nothing of puts
 * nothing on the clipboard. CodeMirror leaves a copy without text to the
 * browser, which would copy the selected text from the page: hidden syntax,
 * button labels and all.
 */
function copyNothing(event: ClipboardEvent, view: EditorView): boolean {
  const { state } = view;
  if (!state.facet(piecesToCopy).length || !event.clipboardData) return false;
  // As CodeMirror's own copy: not when the page's selection is elsewhere
  const selected = view.contentDOM.ownerDocument.getSelection()?.anchorNode;
  if (!selected || !view.contentDOM.contains(selected)) return false;
  const { ranges, linewise } = copiedRanges(state);
  if (linewise || copiedPieces(state, ranges, false).some((pieces) => pieces.length)) return false;
  event.clipboardData.clearData();
  event.clipboardData.setData('text/plain', '');
  return true;
}
