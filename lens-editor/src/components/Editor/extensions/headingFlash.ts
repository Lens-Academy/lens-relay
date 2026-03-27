import { ViewPlugin, EditorView, Decoration } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { StateEffect } from '@codemirror/state';

/**
 * Flash-highlight a heading line (yellow background that fades out).
 * Used by ToC click navigation to indicate which heading was jumped to.
 */
export const flashHeadingLine = StateEffect.define<number | null>();

/**
 * Persistent highlight that stays until user interacts with the editor.
 * Used by #L{number} line links from external navigation.
 */
export const persistentHighlightLine = StateEffect.define<number | null>();

/** Internal effect to transition flash → fade-out */
const flashFadeOut = StateEffect.define<void>();

const flashDeco = Decoration.line({ class: 'cm-heading-flash' });
const flashOutDeco = Decoration.line({ class: 'cm-heading-flash cm-heading-flash-out' });

export const headingFlashPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    private fadeTimer: ReturnType<typeof setTimeout> | null = null;
    private clearTimer: ReturnType<typeof setTimeout> | null = null;
    private persistent = false;
    private view: EditorView;

    constructor(view: EditorView) {
      this.view = view;
    }

    update(update: ViewUpdate) {
      for (const tr of update.transactions) {
        for (const e of tr.effects) {
          if (e.is(flashHeadingLine)) {
            this.clearTimers();
            this.persistent = false;

            if (e.value === null) {
              this.decorations = Decoration.none;
              return;
            }

            const line = update.state.doc.lineAt(e.value);
            this.decorations = Decoration.set([flashDeco.range(line.from)]);

            // After 1.5s, dispatch fade-out through CM6's update cycle
            this.fadeTimer = setTimeout(() => {
              this.view.dispatch({ effects: flashFadeOut.of(undefined) });
            }, 1500);

            // After 2s total, remove entirely
            this.clearTimer = setTimeout(() => {
              this.view.dispatch({ effects: flashHeadingLine.of(null) });
            }, 2000);

            return;
          }

          if (e.is(flashFadeOut) && this.decorations !== Decoration.none) {
            // Transition existing flash decoration to fade-out class.
            // The fadeTimer has already fired (that's how we got here).
            // The clearTimer (2s total) is still pending and will
            // dispatch flashHeadingLine.of(null) for final removal.
            const iter = this.decorations.iter();
            if (iter.value) {
              this.decorations = Decoration.set([flashOutDeco.range(iter.from)]);
            }
            return;
          }

          if (e.is(persistentHighlightLine)) {
            this.clearTimers();

            if (e.value === null) {
              this.decorations = Decoration.none;
              this.persistent = false;
              return;
            }

            const line = update.state.doc.lineAt(e.value);
            this.decorations = Decoration.set([flashDeco.range(line.from)]);
            this.persistent = true;
            return;
          }
        }
      }

      // Clear persistent highlight on any user interaction
      if (this.persistent) {
        for (const tr of update.transactions) {
          if (tr.isUserEvent('select') || tr.isUserEvent('input') || tr.isUserEvent('delete') || tr.isUserEvent('move')) {
            this.decorations = Decoration.none;
            this.persistent = false;
            return;
          }
        }
      }

      // Map decoration positions through doc changes
      if (update.docChanged) {
        this.decorations = this.decorations.map(update.changes);
      }
    }

    private clearTimers() {
      if (this.fadeTimer) { clearTimeout(this.fadeTimer); this.fadeTimer = null; }
      if (this.clearTimer) { clearTimeout(this.clearTimer); this.clearTimer = null; }
    }

    destroy() {
      this.clearTimers();
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);
