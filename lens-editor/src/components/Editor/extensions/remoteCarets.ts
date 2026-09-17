/**
 * Collaborator carets with Google-Docs-style name labels.
 *
 * Replaces y-codemirror.next's `yRemoteSelections` (which is why the editors
 * call `yCollab(ytext, null, …)`): same awareness protocol, same DOM classes,
 * but the name label is hidden by default and shown only while the pointer
 * is over the caret or for a short while after that caret moved. A label that
 * never goes away covers the line above the caret, which readers complained
 * about.
 *
 * Works on a slice of the Y.Text too (section editor): `toAbs`/`toCm` map
 * CodeMirror offsets to absolute Y.Text indexes and back; `toCm` returns null
 * for carets outside the slice.
 */
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { Annotation, Facet, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';

/** How long a collaborator's name stays visible after their caret moved. */
export const CARET_LABEL_LINGER_MS = 2000;

export interface RemoteCaretsConfig {
  ytext: Y.Text;
  awareness: Awareness;
  /** CodeMirror offset → absolute Y.Text index. Identity when omitted. */
  toAbs?: (pos: number) => number;
  /** Absolute Y.Text index → CodeMirror offset, or null when outside this editor. */
  toCm?: (index: number) => number | null;
}

const remoteCaretsFacet = Facet.define<RemoteCaretsConfig, RemoteCaretsConfig>({
  combine: (inputs) => inputs[inputs.length - 1],
});

/** Marks the transactions that exist only to redraw carets (awareness change, label expiry). */
const redrawCarets = Annotation.define<null>();

class RemoteCaretWidget extends WidgetType {
  constructor(
    readonly color: string,
    readonly name: string,
    readonly fresh: boolean,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-ySelectionCaret';
    span.textContent = '⁠'; // word joiner, gives the caret a height
    span.appendChild(document.createElement('div')).className = 'cm-ySelectionCaretDot';
    span.appendChild(document.createElement('div')).className = 'cm-ySelectionInfo';
    this.updateDOM(span);
    return span;
  }

  eq(other: RemoteCaretWidget): boolean {
    return other.color === this.color && other.name === this.name && other.fresh === this.fresh;
  }

  /** Reuse the element so a label that stops being fresh fades instead of blinking. */
  updateDOM(dom: HTMLElement): boolean {
    dom.style.backgroundColor = this.color;
    dom.style.borderColor = this.color;
    dom.querySelector('.cm-ySelectionInfo')!.textContent = this.name;
    dom.classList.toggle('cm-ySelectionCaret-fresh', this.fresh);
    return true;
  }

  get estimatedHeight(): number {
    return -1;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

interface CursorJson {
  anchor: unknown;
  head: unknown;
}

class RemoteCaretsPluginValue {
  decorations: DecorationSet = Decoration.none;
  private readonly conf: RemoteCaretsConfig;
  private readonly listener: (changes: { added: number[]; updated: number[]; removed: number[] }) => void;
  /** Per remote client: the cursor last seen (to tell a move from a re-broadcast) and when it moved. */
  private seen = new Map<number, { cursor: string; movedAt: number }>();
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly view: EditorView) {
    // Read once: every editor recreates its view for a new document, so the
    // facet never changes underneath a running plugin.
    this.conf = view.state.facet(remoteCaretsFacet);
    // Collaborators already here have not moved; only a later change shows their name.
    this.conf.awareness.getStates().forEach((state, clientId) => {
      if (clientId !== this.conf.awareness.clientID && state.cursor != null) {
        this.seen.set(clientId, { cursor: JSON.stringify(state.cursor), movedAt: 0 });
      }
    });
    this.listener = ({ added, updated, removed }) => {
      const local = this.conf.awareness.clientID;
      if (added.concat(updated, removed).some((id) => id !== local)) this.redraw();
    };
    this.conf.awareness.on('change', this.listener);
    // Carets of collaborators already here, before any change event arrives.
    this.decorations = this.buildDecorations(view.state.doc.length);
  }

  private redraw(): void {
    this.view.dispatch({ annotations: [redrawCarets.of(null)] });
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.focusChanged) {
      this.publishLocalCursor(update);
    }
    const redraw = update.transactions.some((tr) => tr.annotation(redrawCarets) !== undefined);
    if (redraw || update.docChanged) {
      // Resolving Yjs positions costs per edit in the doc's history, so only
      // do it when a caret or the text moved; other transactions map through.
      this.decorations = this.buildDecorations(update.state.doc.length);
    }
  }

  private publishLocalCursor(update: ViewUpdate): void {
    const { ytext, awareness } = this.conf;
    const toAbs = this.conf.toAbs ?? ((pos: number) => pos);
    const localState = awareness.getLocalState();
    if (localState == null || !update.view.hasFocus) return;

    const sel = update.state.selection.main;
    const anchor = Y.createRelativePositionFromTypeIndex(ytext, toAbs(sel.anchor));
    const head = Y.createRelativePositionFromTypeIndex(ytext, toAbs(sel.head));
    const current: CursorJson | null = localState.cursor ?? null;
    const same =
      current != null &&
      Y.compareRelativePositions(Y.createRelativePositionFromJSON(current.anchor), anchor) &&
      Y.compareRelativePositions(Y.createRelativePositionFromJSON(current.head), head);
    if (!same) awareness.setLocalStateField('cursor', { anchor, head });
  }

  private buildDecorations(docLength: number): DecorationSet {
    const { ytext, awareness } = this.conf;
    const ydoc = ytext.doc!;
    const toCm = this.conf.toCm ?? ((index: number) => index);
    const now = Date.now();
    const present = new Set<number>();
    let nextExpiry = Infinity;
    const decorations: Array<{ from: number; to: number; value: Decoration }> = [];

    awareness.getStates().forEach((state, clientId) => {
      if (clientId === awareness.doc.clientID) return;
      const cursor: CursorJson | null | undefined = state.cursor;
      if (cursor == null || cursor.anchor == null || cursor.head == null) return;
      present.add(clientId);

      const anchor = Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON(cursor.anchor),
        ydoc,
      );
      const head = Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON(cursor.head),
        ydoc,
      );
      if (anchor == null || head == null || anchor.type !== ytext || head.type !== ytext) return;
      const cmAnchor = toCm(anchor.index);
      const cmHead = toCm(head.index);
      if (cmAnchor == null || cmHead == null) return;

      // Stamp the move only once the caret can be drawn, so a cursor that
      // arrives ahead of the text it points into still gets its full linger.
      const key = JSON.stringify(cursor);
      let entry = this.seen.get(clientId);
      if (!entry || entry.cursor !== key) {
        entry = { cursor: key, movedAt: now };
        this.seen.set(clientId, entry);
      }

      const expiry = entry.movedAt + CARET_LABEL_LINGER_MS;
      const fresh = expiry > now;
      if (fresh) nextExpiry = Math.min(nextExpiry, expiry);

      const { color = '#30bced', name = 'Anonymous' } = state.user || {};
      const pos = Math.min(cmHead, docLength);
      decorations.push({
        from: pos,
        to: pos,
        value: Decoration.widget({
          side: 1,
          block: false,
          widget: new RemoteCaretWidget(color, name, fresh),
        }),
      });
    });

    for (const clientId of this.seen.keys()) {
      if (!present.has(clientId)) this.seen.delete(clientId);
    }

    this.scheduleLingerRedraw(nextExpiry, now);
    return Decoration.set(decorations, true);
  }

  /** Redraw once the earliest fresh label is due to fade. */
  private scheduleLingerRedraw(at: number, now: number): void {
    if (this.lingerTimer !== null) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    if (at === Infinity) return;
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null;
      this.redraw();
    }, Math.max(0, at - now));
  }

  destroy(): void {
    this.conf.awareness.off('change', this.listener);
    if (this.lingerTimer !== null) clearTimeout(this.lingerTimer);
  }
}

const remoteCaretsPlugin = ViewPlugin.fromClass(RemoteCaretsPluginValue, {
  decorations: (v) => v.decorations,
});

/**
 * A colored 2px caret with a dot on top and the collaborator's name above
 * it; the name is hidden until the caret is hovered or has just moved.
 */
const remoteCaretsTheme = EditorView.baseTheme({
  '.cm-ySelectionCaret': {
    position: 'relative',
    display: 'inline',
    borderLeft: '2px solid',
    marginLeft: '-1px',
    marginRight: '-1px',
    boxSizing: 'border-box',
  },
  '.cm-ySelectionCaretDot': {
    position: 'absolute',
    top: '-.2em',
    left: '-.2em',
    width: '.4em',
    height: '.4em',
    borderRadius: '50%',
    backgroundColor: 'inherit',
    boxSizing: 'border-box',
    transition: 'transform .3s ease-in-out',
  },
  '.cm-ySelectionCaret:hover > .cm-ySelectionCaretDot': {
    transformOrigin: 'bottom center',
    transform: 'scale(0)',
  },
  '.cm-ySelectionInfo': {
    position: 'absolute',
    top: '-1.6em',
    left: '-1px',
    zIndex: '101',
    padding: '2px 6px',
    borderRadius: '3px',
    backgroundColor: 'inherit',
    color: 'white',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: '11px',
    fontWeight: '500',
    fontStyle: 'normal',
    lineHeight: 'normal',
    whiteSpace: 'nowrap',
    userSelect: 'none',
    pointerEvents: 'none',
    opacity: '0',
    transition: 'opacity .2s ease-out',
  },
  '.cm-ySelectionCaret:hover > .cm-ySelectionInfo, .cm-ySelectionCaret-fresh > .cm-ySelectionInfo': {
    opacity: '1',
  },
});

export function remoteCarets(config: RemoteCaretsConfig): Extension {
  return [remoteCaretsFacet.of(config), remoteCaretsTheme, remoteCaretsPlugin];
}
