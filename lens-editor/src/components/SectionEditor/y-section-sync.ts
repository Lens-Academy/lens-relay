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
  RangeSet,
  type Extension,
} from '@codemirror/state';
import {
  Decoration,
  ViewPlugin,
  WidgetType,
  type EditorView,
  type ViewUpdate,
  keymap,
} from '@codemirror/view';
import { yRemoteSelectionsTheme } from 'y-codemirror.next';

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

          if (pos >= this.conf.sectionFrom && pos <= this.conf.sectionTo) {
            // Insert within section (inclusive boundaries so undo of
            // deletes at section start/end correctly updates the view)
            const cmPos = pos - this.conf.sectionFrom;
            changes.push({ from: cmPos, to: cmPos, insert: insertText });
            this.conf.sectionTo += insertLen;
          } else if (pos < this.conf.sectionFrom) {
            // Insert before section → shift offsets
            this.conf.sectionFrom += insertLen;
            this.conf.sectionTo += insertLen;
          }
          // Insert after sectionTo → ignore
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
    }, conf);
  }

  destroy() {
    this.conf.ytext.unobserve(this._observer);
    this.conf.undoManager.destroy();
  }
}

const ySectionSyncPlugin = ViewPlugin.fromClass(YSectionSyncPluginValue);

// ── Remote cursor widget ─────────────────────────────────────────────

class SectionRemoteCaretWidget extends WidgetType {
  constructor(readonly color: string, readonly name: string) {
    super();
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-ySelectionCaret';
    span.style.backgroundColor = this.color;
    span.style.borderColor = this.color;
    span.textContent = '\u2060'; // word-joiner to give it size

    const dot = document.createElement('div');
    dot.className = 'cm-ySelectionCaretDot';
    span.appendChild(dot);

    const info = document.createElement('div');
    info.className = 'cm-ySelectionInfo';
    info.textContent = this.name;
    span.appendChild(info);

    return span;
  }

  eq(other: SectionRemoteCaretWidget) {
    return other.color === this.color && other.name === this.name;
  }

  get estimatedHeight() { return -1; }
  ignoreEvent() { return true; }
}

// ── Remote selections ViewPlugin (section-aware) ─────────────────────

/** Annotation to trigger redecoration on awareness changes. */
const ySectionRemoteSelectionsAnnotation = Annotation.define<unknown>();

class YSectionRemoteSelectionsPluginValue {
  decorations = RangeSet.of<Decoration>([]);
  private conf: YSectionSyncConfig;
  private _awareness: Awareness;
  private _listener: (changes: { added: number[]; updated: number[]; removed: number[] }) => void;

  constructor(private view: EditorView) {
    this.conf = view.state.facet(ySectionSyncFacet);
    this._awareness = this.conf.awareness!;

    this._listener = ({ added, updated, removed }) => {
      const clients = added.concat(updated).concat(removed);
      if (clients.some(id => id !== this._awareness.doc.clientID)) {
        view.dispatch({ annotations: [ySectionRemoteSelectionsAnnotation.of([])] });
      }
    };
    this._awareness.on('change', this._listener);
  }

  update(update: ViewUpdate) {
    const ytext = this.conf.ytext;
    const ydoc = ytext.doc!;
    const awareness = this._awareness;
    const conf = this.conf;

    // Write local cursor
    const localState = awareness.getLocalState();
    if (localState != null) {
      const hasFocus = update.view.hasFocus;
      const sel = hasFocus ? update.state.selection.main : null;
      const currentAnchor = localState.cursor == null ? null : Y.createRelativePositionFromJSON(localState.cursor.anchor);
      const currentHead = localState.cursor == null ? null : Y.createRelativePositionFromJSON(localState.cursor.head);

      if (sel != null) {
        // Convert CM position to Y.Text absolute position by adding sectionFrom
        const anchor = Y.createRelativePositionFromTypeIndex(ytext, sel.anchor + conf.sectionFrom);
        const head = Y.createRelativePositionFromTypeIndex(ytext, sel.head + conf.sectionFrom);
        if (localState.cursor == null || !Y.compareRelativePositions(currentAnchor!, anchor) || !Y.compareRelativePositions(currentHead!, head)) {
          awareness.setLocalStateField('cursor', { anchor, head });
        }
      } else if (localState.cursor != null && hasFocus) {
        awareness.setLocalStateField('cursor', null);
      }
    }

    // Read remote cursors and build decorations
    const decorations: { from: number; to: number; value: Decoration }[] = [];

    awareness.getStates().forEach((state, clientid) => {
      if (clientid === awareness.doc.clientID) return;
      const cursor = state.cursor;
      if (cursor == null || cursor.anchor == null || cursor.head == null) return;

      const anchor = Y.createAbsolutePositionFromRelativePosition(cursor.anchor, ydoc);
      const head = Y.createAbsolutePositionFromRelativePosition(cursor.head, ydoc);
      if (anchor == null || head == null || anchor.type !== ytext || head.type !== ytext) return;

      // Filter to within section bounds
      if (anchor.index < conf.sectionFrom || anchor.index > conf.sectionTo) return;
      if (head.index < conf.sectionFrom || head.index > conf.sectionTo) return;

      const { color = '#30bced', name = 'Anonymous' } = state.user || {};

      // Convert Y.Text absolute to CM position by subtracting sectionFrom
      const cmHead = head.index - conf.sectionFrom;
      const cmDocLen = update.state.doc.length;

      // Clamp to valid CM range
      const clampedHead = Math.min(cmHead, cmDocLen);

      decorations.push({
        from: clampedHead,
        to: clampedHead,
        value: Decoration.widget({
          side: 1,
          block: false,
          widget: new SectionRemoteCaretWidget(color, name),
        }),
      });
    });

    this.decorations = Decoration.set(decorations, true);
  }

  destroy() {
    this._awareness.off('change', this._listener);
  }
}

const ySectionRemoteSelectionsPlugin = ViewPlugin.fromClass(
  YSectionRemoteSelectionsPluginValue,
  { decorations: v => v.decorations },
);

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
    extensions.push(yRemoteSelectionsTheme, ySectionRemoteSelectionsPlugin);
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
