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
 *
 * A paste of the text last copied in an editor keeps its original authors
 * (keepAuthorship.ts). It is asked about only for its unmarked parts (unknown
 * author), since copying unmarked text to mark it is a way to mark it: those
 * parts are written under the paste ID, the marked ones keep their authors.
 */
import { Facet } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type * as Y from 'yjs';
import {
  claimClientId,
  freshClientId,
  markPendingClassification,
} from '../../../lib/provenance';
import { normalizeLineBreaks, recallCopied, unmarkedLength } from '../../../lib/carried-authorship';

export const MIN_CLASSIFY_CHARS = 20;

export interface PendingPaste {
  /** Temporary clientID the pasted text was minted under. */
  pasteId: number;
  /** Document position of the paste start (pre-insertion selection head). */
  from: number;
  /** Length of the pasted plain text. */
  length: number;
  /** Only part of the paste is asked about: the rest kept known authors. */
  partial: boolean;
}

export type PasteClassifyHandler = (paste: PendingPaste, view: EditorView) => void;

export const pasteClassifyCallback = Facet.define<PasteClassifyHandler>();

export function pasteClassification(ydoc: Y.Doc): Extension {
  return EditorView.domEventHandlers({
    paste: (event, view) => {
      if (view.state.readOnly) return false;
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (text.length < MIN_CLASSIFY_CHARS) return false;
      // Only a single-cursor paste re-uses the copy as a whole (keepAuthorship
      // finds no match in a paste spread over several cursors), so only then
      // can the remembered authors stand in for the prompt.
      const carried = view.state.selection.ranges.length === 1
        ? recallCopied(normalizeLineBreaks(text))
        : null;
      if (carried && unmarkedLength(carried) < MIN_CLASSIFY_CHARS) return false;
      const partial = !!carried?.some((s) => s.author?.actor);

      const sessionId = ydoc.clientID;
      const pasteId = freshClientId(ydoc);
      markPendingClassification(pasteId);
      claimClientId(ydoc, pasteId);
      ydoc.clientID = pasteId;
      const from = view.state.selection.main.from;

      // CodeMirror processes the paste synchronously in this same event, and
      // yCollab writes to the Y.Text synchronously within that dispatch — so
      // by microtask time the pasted items carry pasteId.
      queueMicrotask(() => {
        ydoc.clientID = sessionId;
        for (const handler of view.state.facet(pasteClassifyCallback)) {
          handler({ pasteId, from, length: text.length, partial }, view);
        }
      });

      return false; // let CodeMirror's own paste handling run
    },
  });
}
