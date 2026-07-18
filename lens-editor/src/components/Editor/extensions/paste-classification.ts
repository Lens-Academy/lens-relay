/**
 * Paste classification (provenance): large pastes are inserted under a fresh,
 * temporary clientID so their authorship can be decided *after* the fact —
 * the clientID→actor mapping is late-bound, the text itself never moves.
 *
 * Flow: on paste we mint a fresh clientID, point the Y.Doc at it, and let
 * CodeMirror + yCollab handle the paste normally (synchronously, within this
 * event). A microtask then restores the session's clientID and notifies the
 * host component, which shows the non-blocking "who wrote this?" popover.
 * The answer just writes a users-map entry for the paste ID; dismissal leaves
 * it unmapped (renders as unknown, classifiable later).
 *
 * Small pastes (< MIN_CLASSIFY_CHARS) skip all of this and inherit the
 * session's human identity — nobody wants a prompt for pasting a word.
 */
import { Facet } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type * as Y from 'yjs';
import {
  freshClientId,
  markPendingClassification,
} from '../../../lib/provenance';

export const MIN_CLASSIFY_CHARS = 20;

export interface PendingPaste {
  /** Temporary clientID the pasted text was minted under. */
  pasteId: number;
  /** Document position of the paste start (pre-insertion selection head). */
  from: number;
  /** Length of the pasted plain text. */
  length: number;
}

export type PasteClassifyHandler = (paste: PendingPaste, view: EditorView) => void;

export const pasteClassifyCallback = Facet.define<PasteClassifyHandler>();

export function pasteClassification(ydoc: Y.Doc): Extension {
  return EditorView.domEventHandlers({
    paste: (event, view) => {
      if (view.state.readOnly) return false;
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (text.length < MIN_CLASSIFY_CHARS) return false;

      const sessionId = ydoc.clientID;
      const pasteId = freshClientId(ydoc);
      markPendingClassification(pasteId);
      ydoc.clientID = pasteId;
      const from = view.state.selection.main.from;

      // CodeMirror processes the paste synchronously in this same event, and
      // yCollab writes to the Y.Text synchronously within that dispatch — so
      // by microtask time the pasted items carry pasteId.
      queueMicrotask(() => {
        ydoc.clientID = sessionId;
        for (const handler of view.state.facet(pasteClassifyCallback)) {
          handler({ pasteId, from, length: text.length }, view);
        }
      });

      return false; // let CodeMirror's own paste handling run
    },
  });
}
