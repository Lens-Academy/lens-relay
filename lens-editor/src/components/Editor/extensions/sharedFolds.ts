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
import { Annotation, MapMode, Prec, RangeSetBuilder, StateField } from '@codemirror/state';
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
 *  fenced code, blank); the indentation width (tabs as 4 columns); whether
 *  it is blank. Arrays, as the arrows ask for many lines' ranges per edit. */
interface FoldLines {
  kind: Int8Array;
  indent: Int32Array;
  blank: Uint8Array;
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
  const blank = new Uint8Array(doc.lines);
  let fence: string | null = null;
  let frontmatter = false;
  let n = 0;
  for (const iter = doc.iterLines(); !iter.next().done; ) {
    const text = iter.value;
    const i = n++;
    indent[i] = indentWidth(text);
    blank[i] = text.trim() ? 0 : 1;
    if (i === 0 && text.trim() === '---') {
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
    if (blank[i]) {
      kind[i] = -1;
      continue;
    }
    const h = HEADING_RE.exec(text);
    kind[i] = h ? h[1].length : 0;
  }
  return { kind, indent, blank };
}

const foldLinesField = StateField.define<FoldLines>({
  create: (state) => scanFoldLines(state.doc),
  update: (value, tr) => (tr.docChanged ? scanFoldLines(tr.state.doc) : value),
});

/** The range folding line `n` hides (from its end to the end of the last
 *  line it covers), or null when the line folds nothing. */
export function foldRangeOf(state: EditorState, n: number, lines = state.field(foldLinesField, false) ?? scanFoldLines(state.doc)): { from: number; to: number } | null {
  const { kind, indent, blank } = lines;
  const k = kind[n - 1];
  if (k === undefined || k < 0) return null;
  let last = n;
  if (k > 0) {
    for (let m = n + 1; m <= state.doc.lines; m++) {
      const km = kind[m - 1];
      if (km > 0 && km <= k) break;
      if (!blank[m - 1]) last = m;
    }
  } else {
    for (let m = n + 1; m <= state.doc.lines; m++) {
      if (blank[m - 1]) continue;
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

/** Fold or unfold lines in this editor, in one transaction. Returns
 *  whether any of them folds (or was folded). */
function applyLocally(view: EditorView, lines: Line[], fold: boolean): boolean {
  const effects = [];
  let any = false;
  for (const line of lines) {
    const current = foldOnLine(view.state, line);
    if (fold) {
      const range = !current && foldRangeOf(view.state, line.number);
      if (range) effects.push(foldEffect.of(range));
      any ||= !!(current || range);
    } else if (current) {
      effects.push(unfoldEffect.of(current));
      any = true;
    }
  }
  if (effects.length) view.dispatch({ effects, annotations: fromSharedFolds.of(true) });
  return any;
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

  /** Start of the line a fold is anchored to (the line holding the
   *  character it was anchored to, which text typed before it on the same
   *  line moves), or null when it can't be found. 'gone' when that character
   *  was
   *  anchored to was deleted: Yjs would resolve it to whatever follows, and
   *  fold some other line. 'later' when that character hasn't arrived yet
   *  (the map and the text sync independently). */
  lineStart(fold: SharedFold | undefined, state: EditorState): number | null | 'gone' | 'later' {
    if (!fold || typeof fold !== 'object' || !fold.anchor) return null;
    try {
      const rel = Y.createRelativePositionFromJSON(fold.anchor);
      if (rel.item) {
        if (Y.getState(this.ydoc.store, rel.item.client) <= rel.item.clock) return 'later';
        if (Y.getItem(this.ydoc.store, rel.item).deleted) return 'gone';
      }
      const abs = Y.createAbsolutePositionFromRelativePosition(rel, this.ydoc);
      if (!abs || abs.type !== this.ytext || abs.index > state.doc.length) return null;
      return state.doc.lineAt(abs.index).from;
    } catch {
      return null;
    }
  }

  /** Line start → ids of the folds on that line. One pass over the map:
   *  resolving an anchor walks the Y.Text. */
  byLine(state: EditorState): Map<number, string[]> {
    const lines = new Map<number, string[]>();
    this.map.forEach((fold, id) => {
      const from = this.lineStart(fold, state);
      if (typeof from === 'number') lines.set(from, [...(lines.get(from) ?? []), id]);
    });
    return lines;
  }

  /** Must be called with the state the Y.Text shows */
  add(lines: Line[], state: EditorState) {
    if (!this.canWrite || !lines.length) return;
    const folded = this.byLine(state);
    const fresh = lines.filter((line) => !folded.has(line.from));
    if (!fresh.length) return;
    this.ydoc.transact(() => {
      for (const line of fresh) {
        const anchor = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(this.ytext, line.from, 0));
        this.map.set(newId(), { anchor, at: Date.now() });
      }
    }, this);
  }

  /** Drop folds whose line was deleted */
  prune(state: EditorState) {
    if (!this.canWrite) return;
    const gone: string[] = [];
    this.map.forEach((fold, id) => {
      if (this.lineStart(fold, state) === 'gone') gone.push(id);
    });
    if (gone.length) this.ydoc.transact(() => gone.forEach((id) => this.map.delete(id)), this);
  }

  /** Must be called with the state the Y.Text shows */
  remove(lines: Line[], state: EditorState) {
    if (!this.canWrite || !lines.length) return;
    const folded = this.byLine(state);
    const ids = lines.flatMap((line) => folded.get(line.from) ?? []);
    if (ids.length) this.ydoc.transact(() => ids.forEach((id) => this.map.delete(id)), this);
  }
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Fold or unfold lines for everyone (for this client only when read-only) */
function setFolded(view: EditorView, lines: Line[], fold: boolean): boolean {
  const store = stores.get(view);
  if (fold) lines = lines.filter((line) => foldRangeOf(view.state, line.number));
  if (fold) store?.add(lines, view.state);
  else store?.remove(lines, view.state);
  return applyLocally(view, lines, fold);
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
    const toFold: Line[] = [];
    const toUnfold: Line[] = [];
    for (const item of pending) {
      const from = this.store.lineStart(item.value, state);
      // Its line hasn't arrived: try again when the text changes
      if (from === 'later') this.pending.push(item);
      if (from === 'gone' && item.fold) gone.push(item.id);
      if (typeof from !== 'number') continue;
      (item.fold ? toFold : toUnfold).push(state.doc.lineAt(from));
    }
    applyLocally(this.view, toFold, true);
    if (toUnfold.length) {
      // Someone else may still have it folded under another id
      const folded = this.store.byLine(state);
      applyLocally(this.view, toUnfold.filter((line) => !folded.has(line.from)), false);
    }
    // Folds whose line was deleted
    if (gone.length && this.store.canWrite) {
      this.store.ydoc.transact(() => gone.forEach((id) => this.store.map.delete(id)), this.store);
    }
  }

  update(update: ViewUpdate) {
    if (update.docChanged) this.schedule();
    if (!this.store.canWrite) return;
    // Folds CodeMirror opened or closed itself (its placeholder click, other
    // fold commands, an edit replacing or deleting folded text), as line
    // starts mapped
    // to the update's final state, which is what the Y.Text shows: this runs
    // after yCollab has written the update's edits
    let opened: number[] = [];
    let closed: number[] = [];
    let dropped = false;
    for (const tr of update.transactions) {
      opened = opened.map((pos) => tr.changes.mapPos(pos, 1));
      closed = closed.map((pos) => tr.changes.mapPos(pos, 1));
      if (tr.annotation(fromSharedFolds)) continue;
      for (const e of tr.effects) {
        if (e.is(unfoldEffect)) opened.push(tr.state.doc.lineAt(e.value.from).from);
        else if (e.is(foldEffect)) closed.push(tr.state.doc.lineAt(e.value.from).from);
      }
      if (tr.docChanged) {
        const after = foldedRanges(tr.state);
        foldedRanges(tr.startState).between(0, tr.startState.doc.length, (from, to) => {
          const mFrom = tr.changes.mapPos(from, 1);
          const mTo = tr.changes.mapPos(to, -1);
          let kept = false;
          after.between(mFrom, mFrom, (a, b) => {
            if (a === mFrom && b === mTo) kept = true;
          });
          if (kept) return;
          dropped = true;
          // Unless its line was deleted too (pruned below)
          const start = tr.changes.mapPos(tr.startState.doc.lineAt(from).from, 1, MapMode.TrackDel);
          if (start !== null) opened.push(start);
        });
      }
    }
    const { state } = update;
    // Only line starts that are still line starts: the line the fold hung
    // from may be gone
    const lines = (starts: number[]) =>
      starts.map((pos) => state.doc.lineAt(pos)).filter((line, i) => line.from === starts[i]);
    this.store.remove(lines(opened), state);
    if (dropped) this.store.prune(state);
    this.store.add(lines(closed).filter((line) => foldRangeOf(state, line.number)), state);
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
    readonly shared: boolean,
  ) {
    super();
  }

  eq(other: FoldToggleWidget) {
    return other.folded === this.folded && other.indented === this.indented && other.shared === this.shared;
  }

  toDOM() {
    const wrap = document.createElement('span');
    wrap.className = 'cm-fold-toggle-anchor' + (this.indented ? ' cm-fold-toggle-indented' : '');
    const button = document.createElement('span');
    button.className = 'cm-fold-toggle' + (this.folded ? ' cm-fold-toggle-folded' : '');
    button.setAttribute('role', 'button');
    button.setAttribute('aria-label', this.folded ? 'Unfold' : 'Fold');
    button.setAttribute('aria-expanded', String(!this.folded));
    button.title = `${this.folded ? 'Unfold' : 'Fold'} (${this.shared ? 'for everyone' : 'only for you: view only'})`;
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
  const shared = stores.get(view)?.canWrite ?? false;
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = state.doc.lineAt(pos);
      if (lines.kind[line.number - 1] >= 0 && foldRangeOf(state, line.number, lines)) {
        // After the indentation, so a nested item's arrow is by its bullet
        const at = line.from + /^[ \t]*/.exec(line.text)![0].length;
        const folded = !!foldOnLine(state, line);
        builder.add(at, at, Decoration.widget({ widget: new FoldToggleWidget(folded, at > line.from, shared), side: 1 }));
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
        setFolded(view, [line], !foldOnLine(view.state, line));
        return true;
      },
    },
  },
);

// ── Keys ───────────────────────────────────────────────────────────

function foldCursorLines(fold: boolean) {
  return (view: EditorView) => {
    const lines: Line[] = [];
    for (const range of view.state.selection.ranges) {
      const line = fold ? foldableLineAt(view.state, range.head) : view.state.doc.lineAt(range.head);
      if (line && !!foldOnLine(view.state, line) !== fold) lines.push(line);
    }
    return lines.length > 0 && setFolded(view, lines, fold);
  };
}

function foldEverything(fold: boolean) {
  return (view: EditorView) => {
    if (!fold) {
      const lines: Line[] = [];
      foldedRanges(view.state).between(0, view.state.doc.length, (from) => {
        lines.push(view.state.doc.lineAt(from));
      });
      return lines.length > 0 && setFolded(view, lines, false);
    }
    // Outermost blocks only: folding one hides the blocks inside it
    const { doc } = view.state;
    const lines: Line[] = [];
    let n = 1;
    while (n <= doc.lines) {
      const range = foldRangeOf(view.state, n);
      if (range) {
        lines.push(doc.line(n));
        n = doc.lineAt(range.to).number + 1;
      } else n++;
    }
    return lines.length > 0 && setFolded(view, lines, true);
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
