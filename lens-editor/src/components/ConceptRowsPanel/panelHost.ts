/**
 * The page header (icon and title) and the Concepts panel sit inside the
 * main editor, as a block widget before the first line, so they scroll with
 * the document instead of taking a fixed slice of the pane. The widget only
 * holds a host element; React renders into it through a portal (EditorArea).
 */
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';

/** Show the panel's host element at the top of the document, or (null) none. */
export const setPanelHost = StateEffect.define<HTMLElement | null>();

/**
 * Measure the panel again: CodeMirror only re-measures its blocks when the
 * content's height changes, and on a page shorter than the pane the content
 * keeps its minimum height while the header grows (the title is drawn into the
 * host after the editor first measured it at 0px). A stale height puts every
 * height lookup (the read-aloud button, the fold arrows) off by the header.
 */
const remeasurePanelHost = StateEffect.define<null>();

class PanelHostWidget extends WidgetType {
  constructor(readonly host: HTMLElement, readonly version = 0) {
    super();
  }

  eq(other: PanelHostWidget): boolean {
    return other.host === this.host && other.version === this.version;
  }

  /** A new version keeps the same element: CodeMirror just measures it again. */
  updateDOM(dom: HTMLElement): boolean {
    return dom === this.host;
  }

  toDOM(view: EditorView): HTMLElement {
    // The panel grows and shrinks as rows expand, and the title is drawn
    // into it after the editor first measured it: keep the editor's height
    // map in step.
    if (typeof ResizeObserver !== 'undefined' && !observers.has(this.host)) {
      let lastHeight = -1;
      const observer = new ResizeObserver((entries) => {
        const height = entries[entries.length - 1]?.contentRect.height ?? 0;
        if (height === lastHeight) return;
        lastHeight = height;
        // Outside the observer callback, so never inside an editor update
        requestAnimationFrame(() => {
          if (view.dom.isConnected) view.dispatch({ effects: remeasurePanelHost.of(null) });
        });
      });
      observer.observe(this.host);
      observers.set(this.host, observer);
    }
    return this.host;
  }

  destroy(dom: HTMLElement): void {
    observers.get(dom)?.disconnect();
    observers.delete(dom);
  }

  /** The panel handles its own events (its inputs and row editors). */
  ignoreEvent(): boolean {
    return true;
  }
}

const observers = new WeakMap<HTMLElement, ResizeObserver>();

function panelDecorations(host: HTMLElement, version: number): DecorationSet {
  return Decoration.set([
    // The lowest side: before every other block at the start, such
    // as the expanded frontmatter's header (side -1), which must stay
    // with the frontmatter under the panel.
    Decoration.widget({ widget: new PanelHostWidget(host, version), block: true, side: -10000 }).range(0),
  ]);
}

export const panelHostField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setPanelHost)) {
        value = effect.value ? panelDecorations(effect.value, 0) : Decoration.none;
      } else if (effect.is(remeasurePanelHost)) {
        const widget = currentWidget(value);
        if (widget) value = panelDecorations(widget.host, widget.version + 1);
      }
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

function currentWidget(value: DecorationSet): PanelHostWidget | null {
  let found: PanelHostWidget | null = null;
  value.between(0, 0, (_from, _to, deco) => {
    const widget = deco.spec.widget;
    if (widget instanceof PanelHostWidget) found = widget;
  });
  return found;
}
