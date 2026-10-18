/**
 * The Concepts panel sits inside the main editor, as a block widget before
 * the first line, so it scrolls with the document instead of taking a fixed
 * slice of the pane. The widget only holds a host element; React renders
 * the panel into it through a portal (EditorArea).
 */
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';

/** Show the panel's host element at the top of the document, or (null) none. */
export const setPanelHost = StateEffect.define<HTMLElement | null>();

class PanelHostWidget extends WidgetType {
  constructor(readonly host: HTMLElement) {
    super();
  }

  eq(other: PanelHostWidget): boolean {
    return other.host === this.host;
  }

  toDOM(view: EditorView): HTMLElement {
    // The panel grows and shrinks as rows expand: keep the editor's height
    // map in step.
    if (typeof ResizeObserver !== 'undefined' && !observers.has(this.host)) {
      const observer = new ResizeObserver(() => view.requestMeasure());
      observer.observe(this.host);
      observers.set(this.host, observer);
    }
    return this.host;
  }

  destroy(): void {
    observers.get(this.host)?.disconnect();
    observers.delete(this.host);
  }

  /** The panel handles its own events (its inputs and row editors). */
  ignoreEvent(): boolean {
    return true;
  }
}

const observers = new WeakMap<HTMLElement, ResizeObserver>();

export const panelHostField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(setPanelHost)) continue;
      value = effect.value
        ? Decoration.set([
          Decoration.widget({ widget: new PanelHostWidget(effect.value), block: true, side: -1 }).range(0),
        ])
        : Decoration.none;
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});
