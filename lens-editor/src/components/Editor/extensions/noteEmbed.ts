/**
 * `![[file]]` embeds of Markdown files (question files above all): a card
 * under the embed line that previews the file read-only, and turns into a
 * live editor of that file, in place, when clicked.
 *
 * The heavy lifting (snapshot reads, the read limit, the one live connection)
 * is in `lib/embed-docs.ts`; this file is the CodeMirror side.
 */
import { EditorState, Prec, StateField, type Text } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, drawSelection, keymap, type DecorationSet } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import * as Y from 'yjs';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { findEmbedLines } from '../../../../shared/embeds';
import { cachedSnapshot, closeLive, isLive, onSnapshot, onUnsaved, openLive, readSnapshot } from '../../../lib/embed-docs';
import { attachProvenanceRegistration } from '../../../lib/provenance';
import { NoteEmbedPreview } from '../NoteEmbedPreview';
import { criticMarkupExtension, suggestionModeField, toggleSuggestionMode } from './criticmarkup';
import { wikilinkMetadataChanged } from './wikilinkEffects';

export interface NoteEmbedContext {
  /** The embedded file, or null when the link resolves to nothing. */
  resolve: (target: string) => { fullDocId: string; path: string } | null;
  /** Navigate to the embedded file. */
  onOpen: (target: string) => void;
  readOnly: boolean;
  canAcceptReject: boolean;
  /** Provenance actor for edits made inside the embed. */
  getActor: () => string;
}

let context: NoteEmbedContext | null = null;

export function updateNoteEmbedContext(next: NoteEmbedContext | undefined): void {
  context = next ?? null;
}

/** The embed lines of `doc` (shared/embeds.ts), with where each line ends:
 *  the card sits right under it. */
export function embedLinesIn(doc: Text): Array<{ lineTo: number; target: string }> {
  const lines: string[] = [];
  for (let n = 1; n <= doc.lines; n++) lines.push(doc.line(n).text);
  return findEmbedLines(lines).map(({ index, target }) => ({ lineTo: doc.line(index + 1).to, target }));
}

function buildDecorations(state: EditorState): DecorationSet {
  if (!context) return Decoration.none;
  const ranges = [];
  for (const { lineTo, target } of embedLinesIn(state.doc)) {
    const resolved = context.resolve(target);
    // HTML widgets embedded in articles are rendered by the course, not here.
    if (resolved && /\.html$/i.test(resolved.path)) continue;
    ranges.push(
      Decoration.widget({
        widget: new NoteEmbedWidget(target, resolved?.fullDocId ?? null, resolved?.path ?? null),
        block: true,
        side: 1,
      }).range(lineTo),
    );
  }
  return Decoration.set(ranges);
}

export const noteEmbedField = StateField.define<DecorationSet>({
  create: buildDecorations,
  update(value, tr) {
    if (tr.docChanged || tr.effects.some((e) => e.is(wikilinkMetadataChanged))) {
      return buildDecorations(tr.state);
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Cards on screen, to find the one under the cursor. */
const mountedCards = new Set<EmbedCard>();

/** Alt-Enter on an embed line opens its embed for editing. */
export function openEmbedAtCursor(view: EditorView): boolean {
  const lineTo = view.state.doc.lineAt(view.state.selection.main.head).to;
  for (const card of mountedCards) {
    if (card.host === view && card.lineTo() === lineTo) return card.open();
  }
  return false;
}

/** The embed cards plus their keyboard shortcut (in the live-preview set). */
export const noteEmbeds = [
  noteEmbedField,
  Prec.high(keymap.of([{ key: 'Alt-Enter', run: openEmbedAtCursor }])),
];

/** Markdown styling of the embedded editor: CodeMirror's default style
 *  underlines headings, which reads as a link here. */
const embedHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, fontWeight: 'bold' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, color: '#6366f1' },
  { tag: tags.monospace, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  { tag: tags.processingInstruction, color: '#9ca3af' },
]);

const cards = new WeakMap<HTMLElement, EmbedCard>();

class NoteEmbedWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly fullDocId: string | null,
    readonly path: string | null,
  ) {
    super();
  }

  eq(other: NoteEmbedWidget): boolean {
    return other.target === this.target && other.fullDocId === this.fullDocId && other.path === this.path;
  }

  get estimatedHeight(): number {
    return 160;
  }

  toDOM(view: EditorView): HTMLElement {
    const card = new EmbedCard(view, this.target, this.fullDocId, this.path);
    cards.set(card.dom, card);
    return card.dom;
  }

  destroy(dom: HTMLElement): void {
    cards.get(dom)?.destroy();
    cards.delete(dom);
  }

  /** The card handles its own events; the host editor must not move its
   *  cursor or take keystrokes meant for the embedded editor. */
  ignoreEvent(): boolean {
    return true;
  }
}

/** Where the cursor goes when an embed opens: at the end of the line holding
 *  the text that was clicked in the preview, else at the start. */
export function cursorFor(text: string, clickedText: string | null): number {
  const probe = clickedText?.trim().slice(0, 40);
  if (!probe) return 0;
  const at = text.indexOf(probe);
  if (at === -1) return 0;
  const lineEnd = text.indexOf('\n', at);
  return lineEnd === -1 ? text.length : lineEnd;
}

function displayName(path: string | null, target: string): string {
  const name = (path ?? target).split('/').pop() ?? target;
  return name.replace(/\.md$/i, '');
}

type CardState = 'waiting' | 'preview' | 'connecting' | 'live' | 'error' | 'missing';

class EmbedCard {
  readonly dom: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly body: HTMLElement;
  private readonly previewHost: HTMLElement;
  private readonly liveHost: HTMLElement;
  private readonly more: HTMLButtonElement;
  private root: Root | null = null;
  private observer: IntersectionObserver | null = null;
  private readonly unsubscribe: Array<() => void> = [];
  private liveView: EditorView | null = null;
  private detachProvenance: (() => void) | null = null;
  private destroyed = false;
  private expanded = false;
  private state: CardState = 'waiting';
  /** What failed last: reading the snapshot, or opening the file live. */
  private failed: 'read' | 'open' | null = null;
  /** Closed edits not yet acknowledged by the server (embed-docs flushes them). */
  private unsaved = false;
  /** Escape closed the editor: give the keyboard back to the lens. */
  private refocusHost = false;

  constructor(
    readonly host: EditorView,
    private readonly target: string,
    private readonly fullDocId: string | null,
    path: string | null,
  ) {
    this.dom = document.createElement('div');
    this.dom.className = 'cm-note-embed';
    this.dom.setAttribute('data-embed-target', target);

    const header = document.createElement('div');
    header.className = 'cm-note-embed-header';
    const title = document.createElement('span');
    title.className = 'cm-note-embed-title';
    title.textContent = displayName(path, target);
    title.title = path ?? target;
    this.hint = document.createElement('span');
    this.hint.className = 'cm-note-embed-hint';
    header.append(title, this.hint);

    this.body = document.createElement('div');
    this.body.className = 'cm-note-embed-body';
    this.previewHost = document.createElement('div');
    this.liveHost = document.createElement('div');
    this.liveHost.className = 'cm-note-embed-live';
    this.body.append(this.previewHost, this.liveHost);

    this.more = document.createElement('button');
    this.more.type = 'button';
    this.more.className = 'cm-note-embed-more';
    this.more.textContent = 'Show all';
    this.more.hidden = true;
    this.more.addEventListener('click', (e) => {
      e.stopPropagation();
      this.expanded = !this.expanded;
      this.dom.classList.toggle('cm-note-embed-expanded', this.expanded);
      this.more.textContent = this.expanded ? 'Show less' : 'Show all';
      this.host.requestMeasure();
    });

    this.dom.append(header, this.body, this.more);

    if (!fullDocId) {
      this.setState('missing');
      this.previewHost.textContent = `No file named “${target}”`;
      return;
    }
    mountedCards.add(this);

    if (!context?.readOnly) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'cm-note-embed-open';
      open.textContent = 'Open';
      open.title = 'Open the file';
      open.addEventListener('click', (e) => {
        e.stopPropagation();
        context?.onOpen(target);
      });
      header.append(open);
      // Keyboard: Tab reaches the card, Enter edits it (Alt-Enter does from
      // the embed line in the lens).
      this.dom.tabIndex = 0;
      this.dom.title = 'Click or press Enter to edit the file here (Alt-Enter from the embed line)';
      this.dom.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target === this.dom) {
          e.preventDefault();
          this.open();
        }
      });
    }

    this.dom.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      if (this.liveView || this.state === 'connecting') return;
      e.preventDefault();
      const clicked = (e.target as HTMLElement).closest('.cm-note-embed-prompt, .cm-note-embed-field dd, .cm-note-embed-markdown p');
      this.open(clicked?.textContent ?? null);
    });

    const cached = cachedSnapshot(fullDocId);
    if (cached !== undefined) this.renderPreview(cached);
    else {
      this.setState('waiting');
      this.previewHost.textContent = 'Loading…';
    }
    this.unsubscribe.push(
      onSnapshot(fullDocId, (text) => {
        if (!this.liveView) this.renderPreview(text);
      }),
      onUnsaved(fullDocId, (unsaved) => {
        this.unsaved = unsaved;
        this.setState(this.state);
      }),
    );

    // Read only once the card is (nearly) on screen.
    if (typeof IntersectionObserver === 'undefined') {
      this.load();
    } else {
      this.observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) this.load();
        },
        { rootMargin: '200px 0px' },
      );
      this.observer.observe(this.dom);
    }
  }

  /** End of the embed line this card sits under. */
  lineTo(): number {
    return this.host.state.doc.lineAt(this.host.posAtDOM(this.dom)).to;
  }

  private setState(state: CardState): void {
    this.state = state;
    this.dom.setAttribute('data-state', state);
    const readOnly = context?.readOnly ?? true;
    this.hint.textContent =
      state === 'live' ? 'Editing the file · Esc to finish'
      : state === 'connecting' ? 'Opening…'
      : state === 'error' ? `Could not ${this.failed === 'open' ? 'open' : 'load'} · click to retry`
      : this.unsaved ? 'Not saved yet · reconnecting'
      : state === 'preview' && !readOnly ? 'Click to edit'
      : '';
  }

  private load(): void {
    if (!this.fullDocId || this.liveView || this.destroyed) return;
    readSnapshot(this.fullDocId).then(
      (text) => {
        // A fresh cached read fires no snapshot event: render it here.
        if (!this.destroyed && !this.liveView) this.renderPreview(text);
      },
      () => {
        if (this.destroyed || this.liveView) return;
        if (cachedSnapshot(this.fullDocId!) === undefined) {
          this.failed = 'read';
          this.setState('error');
          this.previewHost.textContent = '';
        }
      },
    );
  }

  private renderPreview(text: string): void {
    if (this.destroyed) return;
    this.failed = null;
    this.setState('preview');
    if (!this.root) {
      this.previewHost.textContent = '';
      this.root = createRoot(this.previewHost);
    }
    this.root.render(createElement(NoteEmbedPreview, { text }));
    requestAnimationFrame(() => this.updateMore());
  }

  private updateMore(): void {
    if (this.destroyed) return;
    const overflows = this.body.scrollHeight > this.body.clientHeight + 1;
    this.more.hidden = this.liveView !== null || (!overflows && !this.expanded);
    this.host.requestMeasure();
  }

  /** Edit the file in place (or retry what failed). True when it acted. */
  open(clickedText: string | null = null): boolean {
    if (!this.fullDocId || !context || context.readOnly || this.liveView || this.state === 'connecting') return false;
    if (this.failed === 'read') {
      this.setState('waiting');
      this.load();
      return true;
    }
    void this.activate(clickedText);
    return true;
  }

  private async activate(clickedText: string | null): Promise<void> {
    const ctx = context!;
    this.setState('connecting');
    let opened;
    try {
      opened = await openLive(this.fullDocId!, this, () => this.deactivated());
    } catch {
      if (isLive(this)) closeLive(this);
      if (!this.destroyed) {
        this.failed = 'open';
        this.setState('error');
      }
      return;
    }
    if (!opened) return; // overtaken by another embed, or closed meanwhile
    if (this.destroyed) {
      closeLive(this);
      return;
    }

    const { doc } = opened.connection;
    const ytext = doc.getText('contents');
    const undoManager = new Y.UndoManager(ytext, { captureTimeout: 500, trackedOrigins: new Set([]) });
    this.detachProvenance = attachProvenanceRegistration(doc, ctx.getActor);
    this.liveView = new EditorView({
      parent: this.liveHost,
      state: EditorState.create({
        // yCollab syncs changes, not the starting text: start from the file as it is.
        doc: ytext.toString(),
        extensions: [
          indentUnit.of('\t'),
          EditorState.tabSize.of(4),
          drawSelection(),
          syntaxHighlighting(embedHighlightStyle),
          keymap.of([
            {
              key: 'Escape',
              run: () => {
                this.refocusHost = true;
                closeLive(this);
                return true;
              },
            },
            ...yUndoManagerKeymap,
            ...defaultKeymap,
          ]),
          markdown({ base: markdownLanguage, addKeymap: false }),
          yCollab(ytext, null, { undoManager }),
          criticMarkupExtension({ canAcceptReject: ctx.canAcceptReject }),
          EditorView.lineWrapping,
        ],
      }),
    });
    if (this.host.state.field(suggestionModeField, false)) {
      this.liveView.dispatch({ effects: toggleSuggestionMode.of(true) });
    }
    this.failed = null;
    this.previewHost.hidden = true;
    this.setState('live');
    this.more.hidden = true;
    document.addEventListener('mousedown', this.onOutsideMouseDown, true);
    const at = cursorFor(ytext.toString(), clickedText);
    this.liveView.dispatch({ selection: { anchor: at }, scrollIntoView: true });
    this.liveView.focus();
    this.host.requestMeasure();
  }

  private readonly onOutsideMouseDown = (e: MouseEvent) => {
    if (!this.dom.contains(e.target as Node)) closeLive(this);
  };

  /** Called by embed-docs when this card stops being the live embed. */
  private deactivated(): void {
    document.removeEventListener('mousedown', this.onOutsideMouseDown, true);
    this.detachProvenance?.();
    this.detachProvenance = null;
    this.liveView?.destroy();
    this.liveView = null;
    if (this.destroyed) return;
    this.previewHost.hidden = false;
    const text = this.fullDocId ? cachedSnapshot(this.fullDocId) : undefined;
    if (text !== undefined) this.renderPreview(text);
    else this.setState('preview');
    if (this.refocusHost) {
      this.refocusHost = false;
      this.host.dispatch({ selection: { anchor: this.lineTo() } });
      this.host.focus();
    }
    this.host.requestMeasure();
  }

  destroy(): void {
    // First: closing below calls deactivated(), which must not render into a dying card.
    this.destroyed = true;
    mountedCards.delete(this);
    closeLive(this);
    this.observer?.disconnect();
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    const root = this.root;
    this.root = null;
    // Unmount after the current CodeMirror update; React refuses to unmount
    // synchronously while another root may be rendering.
    if (root) queueMicrotask(() => root.unmount());
  }
}
