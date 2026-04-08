/**
 * y-section-sync: A CM6 ViewPlugin that bridges a SLICE [sectionFrom, sectionTo)
 * of a Y.Text to a CodeMirror instance containing only that slice's text.
 *
 * Forked from y-codemirror.next's y-sync.js.
 */

import * as Y from 'yjs';
import {
  Annotation,
  Facet,
  type Extension,
} from '@codemirror/state';
import {
  ViewPlugin,
  type EditorView,
  type ViewUpdate,
  keymap,
} from '@codemirror/view';

/**
 * Configuration stored in the facet so the plugin and keymap can access
 * the Y.Text, mutable offsets, and the UndoManager.
 */
export class YSectionSyncConfig {
  public sectionFrom: number;
  public sectionTo: number;
  public readonly ytext: Y.Text;
  public readonly undoManager: Y.UndoManager;

  constructor(ytext: Y.Text, sectionFrom: number, sectionTo: number) {
    this.ytext = ytext;
    this.sectionFrom = sectionFrom;
    this.sectionTo = sectionTo;
    this.undoManager = new Y.UndoManager(ytext, {
      // Only track changes within our section origin
      trackedOrigins: new Set([YSectionSyncConfig]),
    });
  }
}

/** Facet to retrieve the config from editor state. */
export const ySectionSyncFacet: Facet<YSectionSyncConfig, YSectionSyncConfig> =
  Facet.define({
    combine(inputs) {
      return inputs[inputs.length - 1];
    },
  });

/** Annotation used to tag CM transactions that come from Y.Text observer. */
export const ySectionSyncAnnotation = Annotation.define<YSectionSyncConfig>();

/**
 * The ViewPlugin that performs bidirectional sync.
 */
class YSectionSyncPluginValue {
  private conf: YSectionSyncConfig;
  private _observer: (event: Y.YTextEvent, tr: Y.Transaction) => void;
  private view: EditorView;

  constructor(view: EditorView) {
    this.view = view;
    this.conf = view.state.facet(ySectionSyncFacet);

    this._observer = (event, tr) => {
      // Skip if this transaction originated from our CM → Y.Text path
      if (tr.origin === YSectionSyncConfig) {
        return;
      }

      const delta = event.delta;
      const changes: { from: number; to: number; insert: string }[] = [];
      let pos = 0; // position in OLD Y.Text

      for (const d of delta) {
        if (d.retain != null) {
          pos += d.retain;
        } else if (d.delete != null) {
          const delFrom = pos;
          const delTo = pos + d.delete;
          pos += d.delete;

          // Compute overlap with section
          const overlapFrom = Math.max(delFrom, this.conf.sectionFrom);
          const overlapTo = Math.min(delTo, this.conf.sectionTo);

          // Chars deleted before section shift offsets
          const beforeSection = Math.max(
            0,
            Math.min(d.delete, this.conf.sectionFrom - delFrom),
          );

          if (overlapFrom < overlapTo) {
            // Part of the delete is inside the section
            const cmFrom = overlapFrom - this.conf.sectionFrom;
            const cmTo = overlapTo - this.conf.sectionFrom;
            // Adjust cmFrom/cmTo for any already-applied offset shifts
            changes.push({
              from: cmFrom,
              to: cmTo,
              insert: '',
            });
            this.conf.sectionTo -= overlapTo - overlapFrom;
          }

          this.conf.sectionFrom -= beforeSection;
          this.conf.sectionTo -= beforeSection;
        } else if (d.insert != null) {
          const insertText =
            typeof d.insert === 'string' ? d.insert : '';
          const insertLen = insertText.length;

          if (pos > this.conf.sectionFrom && pos < this.conf.sectionTo) {
            // Insert within section
            const cmPos = pos - this.conf.sectionFrom;
            changes.push({ from: cmPos, to: cmPos, insert: insertText });
            this.conf.sectionTo += insertLen;
          } else if (pos <= this.conf.sectionFrom) {
            // Insert before or at section start → shift offsets
            this.conf.sectionFrom += insertLen;
            this.conf.sectionTo += insertLen;
          }
          // Insert at sectionTo or after → ignore
          // Note: insert does NOT advance pos
        }
      }

      if (changes.length > 0) {
        view.dispatch({
          changes,
          annotations: [ySectionSyncAnnotation.of(this.conf)],
        });
      }
    };

    this.conf.ytext.observe(this._observer);
  }

  update(update: ViewUpdate) {
    if (
      !update.docChanged ||
      (update.transactions.length > 0 &&
        update.transactions[0].annotation(ySectionSyncAnnotation) ===
          this.conf)
    ) {
      return;
    }

    const ytext = this.conf.ytext;
    const conf = this.conf;

    ytext.doc!.transact(() => {
      let adj = 0;
      update.changes.iterChanges((fromA, toA, _fromB, _toB, insert) => {
        const insertText = insert.sliceString(0, insert.length, '\n');
        const yFrom = fromA + conf.sectionFrom + adj;
        if (fromA !== toA) {
          ytext.delete(yFrom, toA - fromA);
        }
        if (insertText.length > 0) {
          ytext.insert(yFrom, insertText);
        }
        adj += insertText.length - (toA - fromA);
      });
      conf.sectionTo += adj;
    }, YSectionSyncConfig);
  }

  destroy() {
    this.conf.ytext.unobserve(this._observer);
    this.conf.undoManager.destroy();
  }
}

const ySectionSyncPlugin = ViewPlugin.fromClass(YSectionSyncPluginValue);

/**
 * Create the section sync extension.
 */
export function ySectionSync(
  ytext: Y.Text,
  sectionFrom: number,
  sectionTo: number,
  _opts?: Record<string, unknown>,
): Extension {
  const conf = new YSectionSyncConfig(ytext, sectionFrom, sectionTo);
  return [ySectionSyncFacet.of(conf), ySectionSyncPlugin];
}

// ── Undo / Redo commands ──────────────────────────────────────────────

function sectionUndo(view: EditorView): boolean {
  const conf = view.state.facet(ySectionSyncFacet);
  conf.undoManager.undo();
  return true;
}

function sectionRedo(view: EditorView): boolean {
  const conf = view.state.facet(ySectionSyncFacet);
  conf.undoManager.redo();
  return true;
}

export const ySectionUndoManagerKeymap = keymap.of([
  { key: 'Mod-z', run: sectionUndo },
  { key: 'Mod-y', run: sectionRedo },
  { key: 'Mod-Shift-z', run: sectionRedo },
]);
