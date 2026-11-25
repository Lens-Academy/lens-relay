import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import type { DiffPart } from './history-api';

/** What the history panel draws on a version (components/HistoryPanel/HistoryDoc.tsx). */

class Removed extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(o: Removed) { return o.text === this.text; }
  toDOM() {
    const el = document.createElement('del');
    el.className = 'lens-history-removed';
    el.textContent = this.text;
    return el;
  }
}

/** Decorations for `parts` over the new text: marks on added runs, widgets for removed ones. */
export function diffDecorations(parts: DiffPart[]): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  let pos = 0;
  for (const p of parts) {
    if (p.kind === 'removed') {
      b.add(pos, pos, Decoration.widget({ widget: new Removed(p.text), side: -1 }));
    } else {
      if (p.kind === 'added' && p.text) b.add(pos, pos + p.text.length, Decoration.mark({ class: 'lens-history-added' }));
      pos += p.text.length;
    }
  }
  return b.finish();
}

/** Where each change starts in the new text: one offset per run of adjacent edits (a removal
 *  right before an addition is one change); whitespace-only edits are skipped. */
export function changeOffsets(parts: DiffPart[]): number[] {
  const out: number[] = [];
  let pos = 0;
  let prevChanged = false;
  for (const p of parts) {
    const changed = p.kind !== 'same' && p.text.trim() !== '';
    if (changed && !prevChanged) out.push(pos);
    prevChanged = changed;
    if (p.kind !== 'removed') pos += p.text.length;
  }
  return out;
}

/** Scroll `view` so text offset `pos` sits mid-screen. */
export function scrollToOffset(view: EditorView | null, pos: number) {
  view?.dispatch({ effects: EditorView.scrollIntoView(Math.min(pos, view.state.doc.length), { y: 'center' }) });
}
