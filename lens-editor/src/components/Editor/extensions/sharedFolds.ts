/**
 * Folding headings and indented blocks, with the folds shared by everyone on
 * the page (Obsidian's "Fold heading" and "Fold indent", but global).
 *
 * - A heading folds everything up to the next heading of its level or
 *   higher; any other line folds the more-indented lines under it (nested
 *   bullets, indented paragraphs). Trailing blank lines stay visible. Lines
 *   in frontmatter and fenced code start no fold.
 * - An arrow left of each foldable line, shown on hover and always while
 *   folded, toggles it. Ctrl-Shift-[ / ] (Cmd-Alt-[ / ] on Mac) fold and
 *   unfold the cursor's line, Ctrl-Alt-[ / ] fold and unfold everything.
 * - The folds live in the content doc's `folds_v0` Y.Map, never in the text:
 *   fold id → { anchor: relative position of the folded line's start, at }.
 *   Each client applies changes to the map as they arrive, so a fold or
 *   unfold shows at once for everyone with the page open, and a page opens
 *   with its folds. The range is worked out from the text by each client.
 * - Read-only viewers see the shared folds and can fold for themselves only.
 *
 * Folds opened without an unfold (the cursor moving into one, e.g. by
 * search) open for this client only; a local delete that clears a fold
 * (CodeMirror drops folds a deletion touches) removes it for everyone.
 */
import { Annotation, Prec, RangeSetBuilder, StateField } from '@codemirror/state';
import type { EditorState, Extension, Line } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { codeFolding, foldEffect, foldedRanges, unfoldEffect } from '@codemirror/language';
import * as Y from 'yjs';

export const FOLDS_MAP = 'folds_v0';

export interface SharedFold {
  /** Y.RelativePosition (JSON) of the first character of the folded line */
  anchor: unknown;
  /** When it was folded, unix ms */
  at: number;
}

// ── Which lines fold, and how far ─────────────────────────────────

/** Per line (index = line number - 1): heading level (1-6), 0 for other
 *  lines that may start a fold, -1 for lines that may not (frontmatter,
 *  fenced code, blank); and the indentation width (tabs as 4 columns). */
interface FoldLines {
  kind: Int8Array;
  indent: Int32Array;
}

const HEADING_RE = /^(#{1,6})(?:[ \t]|$)/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

function indentWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    if (ch === ' ') width++;
    else if (ch === '\t') width += 4 - (width % 4);
    else break;
  }
  return width;
}

export function scanFoldLines(doc: EditorState['doc']): FoldLines {
  const kind = new Int8Array(doc.lines);
  const indent = new Int32Array(doc.lines);
  let fence: string | null = null;
  let frontmatter = false;
  for (let n = 1; n <= doc.lines; n++) {
    const text = doc.line(n).text;
    const i = n - 1;
    indent[i] = indentWidth(text);
    if (n === 1 && text.trim() === '---') {
      frontmatter = true;
      kind[i] = -1;
      continue;
    }
    if (frontmatter) {
      if (text.trim() === '---') frontmatter = false;
      kind[i] = -1;
      continue;
    }
    const f = FENCE_RE.exec(text);
    if (fence) {
      // A closing fence: the same character, at least as long, nothing after
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !text.slice(f[0].length).trim()) fence = null;
      kind[i] = -1;
      continue;
    }
    if (f) {
      fence = f[1];
      // Code blocks don't fold, nor does anything inside them
      kind[i] = -1;
      continue;
    }
    if (!text.trim()) {
      kind[i] = -1;
      continue;
    }
    const h = HEADING_RE.exec(text);
    kind[i] = h ? h[1].length : 0;
  }
  return { kind, indent };
}

const foldLinesField = StateField.define<FoldLines>({
  create: (state) => scanFoldLines(state.doc),
  update: (value, tr) => (tr.docChanged ? scanFoldLines(tr.state.doc) : value),
});

/** The range folding line `n` hides (from its end to the end of the last
 *  line it covers), or null when the line folds nothing. */
export function foldRangeOf(state: EditorState, n: number, lines = state.field(foldLinesField, false) ?? scanFoldLines(state.doc)): { from: number; to: number } | null {
  const { kind, indent } = lines;
  const k = kind[n - 1];
  if (k === undefined || k < 0) return null;
  let last = n;
  if (k > 0) {
    for (let m = n + 1; m <= state.doc.lines; m++) {
      const km = kind[m - 1];
      if (km > 0 && km <= k) break;
      if (km !== -1 || state.doc.line(m).text.trim()) last = m;
    }
  } else {
    for (let m = n + 1; m <= state.doc.lines; m++) {
      if (!state.doc.line(m).text.trim()) continue;
      if (kind[m - 1] > 0 || indent[m - 1] <= indent[n - 1]) break;
      last = m;
    }
  }
  if (last === n) return null;
  return { from: state.doc.line(n).to, to: state.doc.line(last).to };
}

/** The fold currently hiding line `line`'s block, if any */
function foldOnLine(state: EditorState, line: Line): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  foldedRanges(state).between(line.to, line.to, (from, to) => {
    if (from === line.to) found = { from, to };
  });
  return found;
}

// ── Applying folds locally ─────────────────────────────────────────

/** Marks this extension's own fold transactions, so they aren't mirrored
 *  back into the map */
const fromSharedFolds = Annotation.define<true>();

function foldLine(view: EditorView, line: Line): boolean {
  if (foldOnLine(view.state, line)) return true;
  const range = foldRangeOf(view.state, line.number);
  if (!range) return false;
  view.dispatch({ effects: foldEffect.of(range), annotations: fromSharedFolds.of(true) });
  return true;
}

function unfoldLine(view: EditorView, line: Line): boolean {
  const range = foldOnLine(view.state, line);
  if (!range) return false;
  view.dispatch({ effects: unfoldEffect.of(range), annotations: fromSharedFolds.of(true) });
  return true;
}

// ── The shared map ─────────────────────────────────────────────────

class SharedFoldStore {
  readonly map: Y.Map<SharedFold>;

  constructor(
    readonly ydoc: Y.Doc,
    readonly ytext: Y.Text,
    readonly canWrite: boolean,
  ) {
    this.map = ydoc.getMap<SharedFold>(FOLDS_MAP);
  }

  /** Start of the line a fold is anchored to, or null when it can't be found
   *  or no longer sits at a line start. 'gone' when the character it was
   *  anchored to was deleted: Yjs would resolve it to whatever follows, and
   *  fold some other line. */
  lineStart(fold: SharedFold | undefined, state: EditorState): number | null | 'gone' {
    if (!fold || typeof fold !== 'object' || !fold.anchor) return null;
    try {
      const rel = Y.createRelativePositionFromJSON(fold.anchor);
      if (rel.item) {
        // Not synced yet
        if (Y.getState(this.ydoc.store, rel.item.client) <= rel.item.clock) return null;
        if (Y.getItem(this.ydoc.store, rel.item).deleted) return 'gone';
      }
      const abs = Y.createAbsolutePositionFromRelativePosition(rel, this.ydoc);
      if (!abs || abs.type !== this.ytext || abs.index > state.doc.length) return null;
      return state.doc.lineAt(abs.index).from === abs.index ? abs.index : null;
    } catch {
      return null;
    }
  }

  idsOn(line: Line, state: EditorState): string[] {
    const ids: string[] = [];
    this.map.forEach((fold, id) => {
      if (this.lineStart(fold, state) === line.from) ids.push(id);
    });
    return ids;
  }

  add(line: Line, state: EditorState) {
    if (!this.canWrite || this.idsOn(line, state).length) return;
    const anchor = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(this.ytext, line.from, 0));
    this.ydoc.transact(() => this.map.set(newId(), { anchor, at: Date.now() }), this);
  }

  remove(line: Line, state: EditorState) {
    if (!this.canWrite) return;
    const ids = this.idsOn(line, state);
    if (ids.length) this.ydoc.transact(() => ids.forEach((id) => this.map.delete(id)), this);
  }
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Fold or unfold a line for everyone (for this client only when read-only) */
function setFolded(view: EditorView, line: Line, fold: boolean): boolean {
  const store = stores.get(view);
  if (fold) {
    if (!foldRangeOf(view.state, line.number)) return false;
    store?.add(line, view.state);
    return foldLine(view, line);
  }
  store?.remove(line, view.state);
  return unfoldLine(view, line);
}

/** The foldable line at or above `pos` whose block contains it */
function foldableLineAt(state: EditorState, pos: number): Line | null {
  const line = state.doc.lineAt(pos);
  for (let n = line.number; n >= 1; n--) {
    const range = foldRangeOf(state, n);
    if (range && (n === line.number || range.to >= line.to)) return state.doc.line(n);
  }
  return null;
}

// ── Syncing the map and the editor ─────────────────────────────────

const stores = new WeakMap<EditorView, SharedFoldStore>();

type Pending = { id: string; fold: boolean; value: SharedFold | undefined };

class SharedFoldsView {
  store: SharedFoldStore;
  private pending: Pending[] = [];
  private scheduled = false;
  private destroyed = false;
  private readonly observer: (event: Y.YMapEvent<SharedFold>) => void;

  constructor(
    readonly view: EditorView,
    ydoc: Y.Doc,
    ytext: Y.Text,
    canWrite: boolean,
  ) {
    this.store = new SharedFoldStore(ydoc, ytext, canWrite);
    stores.set(view, this.store);
    this.store.map.forEach((value, id) => this.pending.push({ id, fold: true, value }));
    this.observer = (event) => {
      // Our own writes are applied directly
      if (event.transaction.origin === this.store) return;
      event.changes.keys.forEach((change, id) => {
        if (change.action === 'delete') this.pending.push({ id, fold: false, value: change.oldValue });
        else this.pending.push({ id, fold: true, value: this.store.map.get(id) });
      });
      this.schedule();
    };
    this.store.map.observe(this.observer);
    this.schedule();
  }

  /** Apply after the current Y transaction, once the editor shows the same
   *  text as the Y.Text (yCollab may not have dispatched it yet) */
  private schedule() {
    if (this.scheduled || !this.pending.length) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.destroyed) this.flush();
    });
  }

  private flush() {
    const { state } = this.view;
    if (!this.pending.length || this.store.ytext.length !== state.doc.length) return;
    const pending = this.pending;
    this.pending = [];
    const gone: string[] = [];
    for (const { id, fold, value } of pending) {
      const from = this.store.lineStart(value, this.view.state);
      if (from === 'gone' && fold) gone.push(id);
      if (from === null || from === 'gone') continue;
      const line = this.view.state.doc.lineAt(from);
      if (fold) foldLine(this.view, line);
      // Someone else may still have it folded under another id
      else if (!this.store.idsOn(line, this.view.state).length) unfoldLine(this.view, line);
    }
    // Folds whose line was deleted
    if (gone.length && this.store.canWrite) {
      this.store.ydoc.transact(() => gone.forEach((id) => this.store.map.delete(id)), this.store);
    }
  }

  update(update: ViewUpdate) {
    if (update.docChanged) this.schedule();
    if (!this.store.canWrite) return;
    for (const tr of update.transactions) {
      if (tr.annotation(fromSharedFolds)) continue;
      // Folds CodeMirror opened itself: its placeholder click, other fold
      // commands, a local delete touching the fold
      for (const e of tr.effects) {
        if (e.is(unfoldEffect)) this.store.remove(tr.state.doc.lineAt(e.value.from), tr.state);
        else if (e.is(foldEffect)) {
          const line = tr.state.doc.lineAt(e.value.from);
          if (foldRangeOf(tr.state, line.number)) this.store.add(line, tr.state);
        }
      }
      if (tr.docChanged && tr.isUserEvent('delete')) {
        const after = foldedRanges(tr.state);
        foldedRanges(tr.startState).between(0, tr.startState.doc.length, (from, to) => {
          const mFrom = tr.changes.mapPos(from, 1);
          const mTo = tr.changes.mapPos(to, -1);
          let kept = false;
          after.between(mFrom, mFrom, (a, b) => {
            if (a === mFrom && b === mTo) kept = true;
          });
          if (kept) return;
          // The line the fold hung from, if it still exists
          const startLine = tr.startState.doc.lineAt(from);
          const lineStart = tr.changes.mapPos(startLine.from, 1);
          const line = tr.state.doc.lineAt(lineStart);
          if (line.from === lineStart) this.store.remove(line, tr.state);
        });
      }
    }
  }

  destroy() {
    this.destroyed = true;
    stores.delete(this.view);
    this.store.map.unobserve(this.observer);
  }
}

// ── The arrows ─────────────────────────────────────────────────────

class FoldToggleWidget extends WidgetType {
  constructor(
    readonly folded: boolean,
    readonly indented: boolean,
  ) {
    super();
  }

  eq(other: FoldToggleWidget) {
    return other.folded === this.folded && other.indented === this.indented;
  }

  toDOM() {
    const wrap = document.createElement('span');
    wrap.className = 'cm-fold-toggle-anchor' + (this.indented ? ' cm-fold-toggle-indented' : '');
    const button = document.createElement('span');
    button.className = 'cm-fold-toggle' + (this.folded ? ' cm-fold-toggle-folded' : '');
    button.setAttribute('role', 'button');
    button.setAttribute('aria-label', this.folded ? 'Unfold' : 'Fold');
    button.setAttribute('aria-expanded', String(!this.folded));
    button.title = this.folded ? 'Unfold (for everyone)' : 'Fold (for everyone)';
    button.innerHTML =
      '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    wrap.appendChild(button);
    return wrap;
  }

  ignoreEvent() {
    return false;
  }
}

function buildArrows(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { state } = view;
  const lines = state.field(foldLinesField);
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = state.doc.lineAt(pos);
      if (lines.kind[line.number - 1] >= 0 && foldRangeOf(state, line.number, lines)) {
        // After the indentation, so a nested item's arrow is by its bullet
        const at = line.from + /^[ \t]*/.exec(line.text)![0].length;
        const folded = !!foldOnLine(state, line);
        builder.add(at, at, Decoration.widget({ widget: new FoldToggleWidget(folded, at > line.from), side: 1 }));
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const arrowsPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildArrows(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        foldedRanges(update.startState) !== foldedRanges(update.state)
      ) {
        this.decorations = buildArrows(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      mousedown(event, view) {
        const target = (event.target as HTMLElement).closest?.('.cm-fold-toggle');
        if (!target || event.button !== 0) return false;
        event.preventDefault();
        const pos = view.posAtDOM(target);
        const line = view.state.doc.lineAt(pos);
        setFolded(view, line, !foldOnLine(view.state, line));
        return true;
      },
    },
  },
);

// ── Keys ───────────────────────────────────────────────────────────

function foldCursorLines(fold: boolean) {
  return (view: EditorView) => {
    let done = false;
    for (const range of view.state.selection.ranges) {
      if (fold) {
        const line = foldableLineAt(view.state, range.head);
        if (line && !foldOnLine(view.state, line)) done = setFolded(view, line, true) || done;
      } else {
        const line = view.state.doc.lineAt(range.head);
        done = setFolded(view, line, false) || done;
      }
    }
    return done;
  };
}

function foldEverything(fold: boolean) {
  return (view: EditorView) => {
    if (!fold) {
      const lines: Line[] = [];
      foldedRanges(view.state).between(0, view.state.doc.length, (from) => {
        lines.push(view.state.doc.lineAt(from));
      });
      lines.forEach((line) => setFolded(view, line, false));
      return lines.length > 0;
    }
    // Outermost blocks only: folding one hides the blocks inside it
    const { doc } = view.state;
    let n = 1;
    let done = false;
    while (n <= doc.lines) {
      const range = foldRangeOf(view.state, n);
      if (range) {
        done = setFolded(view, doc.line(n), true) || done;
        n = doc.lineAt(range.to).number + 1;
      } else n++;
    }
    return done;
  };
}

const sharedFoldKeymap = keymap.of([
  { key: 'Ctrl-Shift-[', mac: 'Cmd-Alt-[', run: foldCursorLines(true) },
  { key: 'Ctrl-Shift-]', mac: 'Cmd-Alt-]', run: foldCursorLines(false) },
  { key: 'Ctrl-Alt-[', run: foldEverything(true) },
  { key: 'Ctrl-Alt-]', run: foldEverything(false) },
]);

// ── The extension ─────────────────────────────────────────────────

/**
 * @param canWrite false for read-only viewers: they see shared folds and
 *   fold for themselves only
 */
export function sharedFolds(ydoc: Y.Doc, ytext: Y.Text, { canWrite = true } = {}): Extension {
  return [
    foldLinesField,
    codeFolding({ placeholderText: '…' }),
    Prec.high(sharedFoldKeymap),
    ViewPlugin.define((view) => new SharedFoldsView(view, ydoc, ytext, canWrite)),
    arrowsPlugin,
  ];
}
