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
import { yRemoteSelectionsTheme } from 'y-codemirror.next';

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

/** Tags the no-op transactions that only redraw carets. */
const remoteCaretsAnnotation = Annotation.define<null>();

export class RemoteCaretWidget extends WidgetType {
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
    span.style.backgroundColor = this.color;
    span.style.borderColor = this.color;
    span.dataset.color = this.color;
    span.textContent = '⁠'; // word joiner, gives the caret a height

    const dot = document.createElement('div');
    dot.className = 'cm-ySelectionCaretDot';
    span.appendChild(dot);

    const info = document.createElement('div');
    info.className = 'cm-ySelectionInfo';
    info.textContent = this.name;
    span.appendChild(info);

    span.classList.toggle('cm-ySelectionCaret-fresh', this.fresh);
    return span;
  }

  eq(other: RemoteCaretWidget): boolean {
    return other.color === this.color && other.name === this.name && other.fresh === this.fresh;
  }

  /** Same caret, only the linger state changed: flip the class so the label fades. */
  updateDOM(dom: HTMLElement): boolean {
    if (dom.dataset.color !== this.color) return false;
    const info = dom.querySelector('.cm-ySelectionInfo');
    if (!info || info.textContent !== this.name) return false;
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
  /** Last cursor seen per remote client, to tell a move from a heartbeat. */
  private lastCursor = new Map<number, string>();
  private movedAt = new Map<number, number>();
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(private readonly view: EditorView) {
    this.conf = view.state.facet(remoteCaretsFacet);
    this.listener = ({ added, updated, removed }) => {
      const local = this.conf.awareness.clientID;
      if (added.concat(updated, removed).some((id) => id !== local)) {
        this.redraw();
      }
    };
    this.conf.awareness.on('change', this.listener);
  }

  private redraw(): void {
    if (this.destroyed) return;
    this.view.dispatch({ annotations: [remoteCaretsAnnotation.of(null)] });
  }

  update(update: ViewUpdate): void {
    this.publishLocalCursor(update);
    this.decorations = this.buildDecorations(update);
  }

  private publishLocalCursor(update: ViewUpdate): void {
    const { ytext, awareness } = this.conf;
    const toAbs = this.conf.toAbs ?? ((pos: number) => pos);
    const localState = awareness.getLocalState();
    if (localState == null) return;

    const hasFocus = update.view.hasFocus;
    const sel = hasFocus ? update.state.selection.main : null;
    const current: CursorJson | null = localState.cursor ?? null;

    if (sel != null) {
      const anchor = Y.createRelativePositionFromTypeIndex(ytext, toAbs(sel.anchor));
      const head = Y.createRelativePositionFromTypeIndex(ytext, toAbs(sel.head));
      const same =
        current != null &&
        Y.compareRelativePositions(Y.createRelativePositionFromJSON(current.anchor), anchor) &&
        Y.compareRelativePositions(Y.createRelativePositionFromJSON(current.head), head);
      if (!same) awareness.setLocalStateField('cursor', { anchor, head });
    } else if (current != null && hasFocus) {
      awareness.setLocalStateField('cursor', null);
    }
  }

  private buildDecorations(update: ViewUpdate): DecorationSet {
    const { ytext, awareness } = this.conf;
    const ydoc = ytext.doc!;
    const toCm = this.conf.toCm ?? ((index: number) => index);
    const now = Date.now();
    const seen = new Set<number>();
    let nextExpiry = Infinity;
    const decorations: Array<{ from: number; to: number; value: Decoration }> = [];

    awareness.getStates().forEach((state, clientId) => {
      if (clientId === awareness.doc.clientID) return;
      const cursor: CursorJson | null | undefined = state.cursor;
      if (cursor == null || cursor.anchor == null || cursor.head == null) return;
      seen.add(clientId);

      const key = JSON.stringify(cursor);
      if (this.lastCursor.get(clientId) !== key) {
        this.lastCursor.set(clientId, key);
        this.movedAt.set(clientId, now);
      }

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

      const expiry = (this.movedAt.get(clientId) ?? 0) + CARET_LABEL_LINGER_MS;
      const fresh = expiry > now;
      if (fresh) nextExpiry = Math.min(nextExpiry, expiry);

      const { color = '#30bced', name = 'Anonymous' } = state.user || {};
      const pos = Math.min(cmHead, update.state.doc.length);
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

    for (const clientId of this.lastCursor.keys()) {
      if (!seen.has(clientId)) {
        this.lastCursor.delete(clientId);
        this.movedAt.delete(clientId);
      }
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
    this.destroyed = true;
    this.conf.awareness.off('change', this.listener);
    if (this.lingerTimer !== null) clearTimeout(this.lingerTimer);
  }
}

const remoteCaretsPlugin = ViewPlugin.fromClass(RemoteCaretsPluginValue, {
  decorations: (v) => v.decorations,
});

/**
 * Look of the carets: colored 2px line with the collaborator's name above
 * it, the name hidden until the caret is hovered or has just moved. No
 * selection highlighting, caret only.
 */
export const remoteCaretsTheme = EditorView.theme({
  '.cm-ySelectionInfo': {
    opacity: '0',
    transition: 'opacity .2s ease-out',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: '11px',
    fontWeight: '500',
    borderRadius: '3px',
    padding: '2px 6px',
    top: '-1.6em',
    pointerEvents: 'none',
  },
  '.cm-ySelectionCaret:hover > .cm-ySelectionInfo, .cm-ySelectionCaret-fresh > .cm-ySelectionInfo': {
    opacity: '1',
    transitionDelay: '0s',
  },
  '.cm-ySelectionCaret': {
    borderLeftWidth: '2px',
    borderRightWidth: '0',
  },
  '.cm-ySelection': {
    background: 'none !important',
  },
  '.cm-yLineSelection': {
    background: 'none !important',
  },
});

export function remoteCarets(config: RemoteCaretsConfig): Extension {
  return [remoteCaretsFacet.of(config), yRemoteSelectionsTheme, remoteCaretsTheme, remoteCaretsPlugin];
}
