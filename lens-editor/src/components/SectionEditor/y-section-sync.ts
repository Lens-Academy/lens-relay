/**
 * y-section-sync: A CM6 ViewPlugin that bridges a SLICE [sectionFrom, sectionTo)
 * of a Y.Text to a CodeMirror instance containing only that slice's text.
 *
 * Forked from y-codemirror.next's y-sync.js.
 */

import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
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
import { remoteCarets } from '../Editor/extensions/remoteCarets';

/**
 * Configuration stored in the facet so the plugin and keymap can access
 * the Y.Text, mutable offsets, and the UndoManager.
 */
export class YSectionSyncConfig {
  public sectionFrom: number;
  public sectionTo: number;
  public readonly ytext: Y.Text;
  public readonly undoManager: Y.UndoManager;
  public readonly awareness: Awareness | null;

  constructor(ytext: Y.Text, sectionFrom: number, sectionTo: number, awareness?: Awareness) {
    this.ytext = ytext;
    this.sectionFrom = sectionFrom;
    this.sectionTo = sectionTo;
    this.awareness = awareness ?? null;
    this.undoManager = new Y.UndoManager(ytext, {
      // Only track changes within our section origin
      trackedOrigins: new Set([this]),
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
      if (tr.origin === this.conf) {
        return;
      }

      const delta = event.delta;
      let pos = 0; // position in the Y.Text as transformed by prior delta ops

      for (const d of delta) {
        if (d.retain != null) {
          pos += d.retain;
        } else if (d.delete != null) {
          const delFrom = pos;
          const delTo = pos + d.delete;

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
            view.dispatch({
              changes: {
                from: cmFrom,
                to: cmTo,
                insert: '',
              },
              annotations: [ySectionSyncAnnotation.of(this.conf)],
            });
            this.conf.sectionTo -= overlapTo - overlapFrom;
          }

          this.conf.sectionFrom -= beforeSection;
          this.conf.sectionTo -= beforeSection;
        } else if (d.insert != null) {
          const insertText =
            typeof d.insert === 'string' ? d.insert : '';
          const insertLen = insertText.length;

          if (pos >= this.conf.sectionFrom && pos <= this.conf.sectionTo) {
            // Insert within section (inclusive boundaries so undo of
            // deletes at section start/end correctly updates the view)
            const cmPos = pos - this.conf.sectionFrom;
            view.dispatch({
              changes: { from: cmPos, to: cmPos, insert: insertText },
              annotations: [ySectionSyncAnnotation.of(this.conf)],
            });
            this.conf.sectionTo += insertLen;
          } else if (pos < this.conf.sectionFrom) {
            // Insert before section → shift offsets
            this.conf.sectionFrom += insertLen;
            this.conf.sectionTo += insertLen;
          }
          // Insert after sectionTo → ignore. Inserts advance the mutable
          // document cursor; deletes do not. This matches Yjs/Quill delta
          // application semantics and keeps replacement deltas like
          // delete+insert at the same position inside the section.
          pos += insertLen;
        }
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
    }, conf);
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
  opts?: { awareness?: Awareness },
): Extension {
  const conf = new YSectionSyncConfig(ytext, sectionFrom, sectionTo, opts?.awareness);
  const extensions: Extension[] = [ySectionSyncFacet.of(conf), ySectionSyncPlugin];

  if (opts?.awareness) {
    // Section offsets move as the document changes, so map at call time.
    extensions.push(
      remoteCarets({
        ytext,
        awareness: opts.awareness,
        toAbs: (pos) => pos + conf.sectionFrom,
        toCm: (index) =>
          index < conf.sectionFrom || index > conf.sectionTo ? null : index - conf.sectionFrom,
      }),
    );
  }

  return extensions;
}

// ── Undo / Redo commands ──────────────────────────────────────────────

function sectionUndo(view: EditorView): boolean {
  const conf = view.state.facet(ySectionSyncFacet);
  return conf.undoManager.undo() != null;
}

function sectionRedo(view: EditorView): boolean {
  const conf = view.state.facet(ySectionSyncFacet);
  return conf.undoManager.redo() != null;
}

export const ySectionUndoManagerKeymap = keymap.of([
  { key: 'Mod-z', run: sectionUndo, preventDefault: true },
  { key: 'Mod-y', run: sectionRedo, preventDefault: true },
  { key: 'Mod-Shift-z', run: sectionRedo, preventDefault: true },
]);
