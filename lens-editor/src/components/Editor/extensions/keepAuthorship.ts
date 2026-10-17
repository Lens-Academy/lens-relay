/**
 * Keep authorship when text is moved or copied (provenance).
 *
 * Moving a line (Alt-↑/↓), duplicating it (Shift-Alt-↑/↓), dragging a
 * selection, transposing characters, and pasting text last copied or cut in
 * an editor all delete and re-insert existing text. Without this, the
 * re-inserted text would read as written by whoever moved it.
 *
 * - A transaction extender looks up, before the edit, who wrote the text the
 *   insertion re-uses: for moves and duplicates the deleted or duplicated
 *   text of the same transaction, for pastes and drops the remembered copy
 *   (carried-authorship.ts; recorded on copy, cut and dragstart), and
 *   attaches the result as `carriedAuthors`.
 * - yCollab writes the transaction to the Y.Text as usual (so undo and
 *   everything else see an ordinary local edit), but while it does, its
 *   inserts are split: each carried piece is written under a clientID that
 *   resolves to the piece's original author and date.
 *
 * Remote changes need nothing: they arrive with their authors' clientIDs.
 * Must come before yCollab, so its plugin sets the plan before yCollab writes.
 */
import { Annotation, EditorState, Text, Transaction } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import type { ViewUpdate } from '@codemirror/view';
import type * as Y from 'yjs';
import {
  authorSpans,
  matchSource,
  placeSpans,
  recallCopied,
  rememberCopied,
  sliceSpans,
  type AuthoredText,
  type AuthorSpan,
  type CarriedAuthor,
  type CarriedRange,
} from '../../../lib/carried-authorship';
import { carrierClientId, isOwnClient, isPendingClassification } from '../../../lib/provenance';

export const carriedAuthors = Annotation.define<CarriedRange[]>();

/** What a copy or cut of the current selection puts on the clipboard, with
 *  its authors: the selected ranges joined by line breaks, or, with nothing
 *  selected, the cursor lines (CodeMirror's own copiedRange). */
export function copiedAuthoredText(state: EditorState, ydoc: Y.Doc, ytext: Y.Text): AuthoredText | null {
  if (ytext.length !== state.doc.length) return null;
  let ranges = state.selection.ranges.filter((r) => !r.empty).map((r) => ({ from: r.from, to: r.to }));
  if (!ranges.length) {
    let upto = -1;
    ranges = [];
    for (const { from } of state.selection.ranges) {
      const line = state.doc.lineAt(from);
      if (line.number > upto) ranges.push({ from: line.from, to: line.to });
      upto = line.number;
    }
  }
  const parts: string[] = [];
  const spans: AuthorSpan[] = [];
  ranges.forEach((range, i) => {
    if (i > 0) spans.push({ length: 1, author: null });
    parts.push(state.sliceDoc(range.from, range.to));
    spans.push(...authorSpans(ydoc, ytext, range.from, range.to));
  });
  return { text: parts.join('\n'), spans };
}

/** Authors of a pasted or dropped chunk, if it is the remembered copy: as
 *  is, as a whole-line paste (with a line break added), or wrapped in a
 *  suggestion-mode addition. Offsets are relative to the chunk. */
function recallChunk(chunk: string): { offset: number; spans: AuthorSpan[] } | null {
  const exact = recallCopied(chunk);
  if (exact) return { offset: 0, spans: exact };
  if (chunk.endsWith('\n')) {
    const linewise = recallCopied(chunk.slice(0, -1));
    if (linewise) return { offset: 0, spans: linewise };
  }
  const suggestion = /^\{\+\+(?:[^]*?@@)?/.exec(chunk);
  if (suggestion && chunk.endsWith('++}')) {
    const inner = chunk.slice(suggestion[0].length, -3);
    const found = recallChunk(inner);
    if (found) return { offset: suggestion[0].length + found.offset, spans: found.spans };
  }
  return null;
}

function inserts(tr: Transaction): { fromB: number; text: string }[] {
  const out: { fromB: number; text: string }[] = [];
  tr.changes.iterChanges((_fromA, _toA, fromB, _toB, inserted) => {
    if (inserted.length) out.push({ fromB, text: inserted.sliceString(0, inserted.length, '\n') });
  });
  return out;
}

/** Carried ranges for a local transaction, in its new-doc positions. */
export function planCarriedAuthors(tr: Transaction, ydoc: Y.Doc, ytext: Y.Text): CarriedRange[] {
  if (!tr.docChanged) return [];
  const pasted = tr.isUserEvent('input.paste') || tr.isUserEvent('input.drop');
  const moved = tr.isUserEvent('move') || tr.isUserEvent('input.copyline');
  if (!pasted && !moved) return [];
  // The Y.Text must still be the transaction's start state
  if (ytext.length !== tr.startState.doc.length) return [];

  const plan: CarriedRange[] = [];
  if (pasted) {
    // While the paste prompt is coming (the doc writes under a pending paste
    // ID), its unmarked parts are left to the prompt: they are written under
    // the paste ID, which the answer maps to an author.
    const askingUnmarked = isPendingClassification(ydoc.clientID);
    for (const { fromB, text } of inserts(tr)) {
      const found = recallChunk(text);
      if (!found) continue;
      const ranges = placeSpans(found.spans, fromB + found.offset);
      plan.push(...(askingUnmarked ? ranges.filter((r) => r.author.actor !== null) : ranges));
    }
    return plan;
  }

  // Moves and duplicates: the text deleted by this transaction, and for a
  // duplicate the lines it copies.
  const sources: { from: number; to: number }[] = [];
  tr.changes.iterChanges((fromA, toA) => {
    if (toA > fromA) sources.push({ from: fromA, to: toA });
  });
  if (tr.isUserEvent('input.copyline')) {
    for (const range of tr.startState.selection.ranges) {
      sources.push({ from: tr.startState.doc.lineAt(range.from).from, to: tr.startState.doc.lineAt(range.to).to });
    }
  }
  const sourceTexts = sources.map((s) => tr.startState.sliceDoc(s.from, s.to));
  const sourceSpans: (AuthorSpan[] | null)[] = sources.map(() => null);

  for (const { fromB, text } of inserts(tr)) {
    for (let i = 0; i < sources.length; i++) {
      const match = matchSource(text, sourceTexts[i]);
      if (!match) continue;
      const spans = (sourceSpans[i] ??= authorSpans(ydoc, ytext, sources[i].from, sources[i].to));
      plan.push(...placeSpans(sliceSpans(spans, match.sourceFrom, match.length), fromB + match.insertedFrom));
      break;
    }
  }
  return plan;
}

function clientFor(ydoc: Y.Doc, author: CarriedAuthor): number {
  if (author.client !== undefined && isOwnClient(ydoc, author.client)) return author.client;
  return carrierClientId(ydoc, author.actor, author.at);
}

interface ActivePlan {
  /** The update's new doc: yCollab inserts at new-doc positions. */
  doc: Text;
  pieces: { from: number; to: number; client: number }[];
}

/**
 * Split yCollab's inserts of a planned update into per-author pieces. yCollab
 * writes each inserted chunk with one ytext.insert(index, text) call, at the
 * chunk's new-doc position; while a plan is active, this writes the carried
 * pieces of the chunk under their clientIDs and the rest as usual.
 */
/** The plan of the update being written, per Y.Text: shared by every editor
 *  on it, since the split insert is installed only once (an editor can be
 *  created again for the same Y.Text, e.g. by a React remount). */
const activePlans = new WeakMap<Y.Text, ActivePlan>();

function installSplittingInsert(ydoc: Y.Doc, ytext: Y.Text): void {
  const marker = ytext as Y.Text & { __carriedInsert?: true };
  if (marker.__carriedInsert) return;
  marker.__carriedInsert = true;
  const insert = ytext.insert.bind(ytext);
  ytext.insert = (index: number, text: string, attributes?: Record<string, unknown>) => {
    const plan = activePlans.get(ytext);
    // Only yCollab's write of the planned update matches the planned doc
    if (!plan || attributes || plan.doc.sliceString(index, index + text.length) !== text) {
      return insert(index, text, attributes);
    }
    const base = ydoc.clientID;
    try {
      let off = 0;
      while (off < text.length) {
        const pos = index + off;
        const piece = plan.pieces.find((p) => p.from <= pos && pos < p.to);
        const next = plan.pieces.find((p) => p.from > pos)?.from ?? Infinity;
        const end = Math.min(text.length, (piece ? piece.to : next) - index);
        ydoc.clientID = piece ? piece.client : base;
        insert(pos, text.slice(off, end));
        off = end;
      }
    } finally {
      ydoc.clientID = base;
    }
  };
}

/** Must be placed before yCollab, so its plugin runs first. */
export function keepAuthorship(ydoc: Y.Doc, ytext: Y.Text): Extension {
  installSplittingInsert(ydoc, ytext);

  const remember = (view: EditorView) => {
    const copied = copiedAuthoredText(view.state, ydoc, ytext);
    if (copied && copied.text) rememberCopied(copied);
    return false; // CodeMirror still does the copy, cut or drag
  };

  return [
    EditorView.domEventHandlers({
      copy: (_event, view) => remember(view),
      cut: (_event, view) => remember(view),
      dragstart: (_event, view) => {
        const { from, to } = view.state.selection.main;
        if (from < to && ytext.length === view.state.doc.length) {
          rememberCopied({ text: view.state.sliceDoc(from, to), spans: authorSpans(ydoc, ytext, from, to) });
        }
        return false;
      },
    }),
    EditorState.transactionExtender.of((tr) => {
      const plan = planCarriedAuthors(tr, ydoc, ytext);
      return plan.length ? { annotations: carriedAuthors.of(plan) } : null;
    }),
    ViewPlugin.define(() => ({
      update(update: ViewUpdate) {
        activePlans.delete(ytext);
        if (!update.docChanged || !update.transactions.some((tr) => tr.annotation(carriedAuthors))) return;
        // Plans are in their own transaction's positions: map them to the end
        let ranges: CarriedRange[] = [];
        for (const tr of update.transactions) {
          ranges = ranges
            .map((r) => ({ ...r, from: tr.changes.mapPos(r.from, 1), to: tr.changes.mapPos(r.to, -1) }))
            .filter((r) => r.to > r.from);
          ranges.push(...(tr.annotation(carriedAuthors) ?? []));
        }
        const plan: ActivePlan = {
          doc: update.state.doc,
          pieces: ranges
            .map((r) => ({ from: r.from, to: r.to, client: clientFor(ydoc, r.author) }))
            .sort((a, b) => a.from - b.from),
        };
        activePlans.set(ytext, plan);
        // yCollab writes within this same update; never let the plan outlive it
        queueMicrotask(() => {
          if (activePlans.get(ytext) === plan) activePlans.delete(ytext);
        });
      },
    })),
  ];
}
