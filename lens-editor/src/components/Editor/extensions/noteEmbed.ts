/**
 * `![[file]]` embeds of Markdown files (question files above all): a card
 * under the embed line that previews the file read-only, and turns into a
 * live editor of that file, in place, when clicked.
 *
 * The heavy lifting (snapshot reads, the read limit, the one live connection)
 * is in `lib/embed-docs.ts`; this file is the CodeMirror side.
 */
import { EditorState, StateField, type Text } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, drawSelection, keymap, type DecorationSet } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import * as Y from 'yjs';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { embedLineTarget } from '../../../lib/questionFile';
import { isImageEmbedTarget } from '../../../lib/isImageEmbedTarget';
import { cachedSnapshot, closeLive, isLive, onSnapshot, openLive, readSnapshot } from '../../../lib/embed-docs';
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

export interface EmbedLine {
  /** End of the embed line: the card sits right under it. */
  lineTo: number;
  target: string;
}

const FENCE = /^[ \t]*(```|~~~)/;

/** Lines that are only a `![[...]]` embed of something other than an image,
 *  outside fenced code. */
export function findEmbedLines(doc: Text): EmbedLine[] {
  const out: EmbedLine[] = [];
  let fence: string | null = null;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const fenceMatch = FENCE.exec(line.text);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1];
      else if (fence === fenceMatch[1]) fence = null;
      continue;
    }
    if (fence !== null || !line.text.includes('![[')) continue;
    const target = embedLineTarget(line.text);
    if (target && !isImageEmbedTarget(target)) out.push({ lineTo: line.to, target });
  }
  return out;
}

function buildDecorations(state: EditorState): DecorationSet {
  if (!context) return Decoration.none;
  const ranges = [];
  for (const { lineTo, target } of findEmbedLines(state.doc)) {
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
    return other.target === this.target && other.fullDocId === this.fullDocId;
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

class EmbedCard {
  readonly dom: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly body: HTMLElement;
  private readonly previewHost: HTMLElement;
  private readonly liveHost: HTMLElement;
  private readonly more: HTMLButtonElement;
  private root: Root | null = null;
  private observer: IntersectionObserver | null = null;
  private unsubscribe: (() => void) | null = null;
  private liveView: EditorView | null = null;
  private detachProvenance: (() => void) | null = null;
  private destroyed = false;
  private expanded = false;

  constructor(
    private readonly host: EditorView,
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
      this.hint.textContent = '';
      this.previewHost.textContent = `No file named “${target}”`;
      return;
    }

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
    }

    this.dom.addEventListener('mousedown', (e) => {
      if (this.liveView || this.dom.getAttribute('data-state') === 'connecting' || (e.target as HTMLElement).closest('button')) return;
      e.preventDefault();
      const clicked = (e.target as HTMLElement).closest('.cm-note-embed-prompt, .cm-note-embed-field dd, .cm-note-embed-markdown p');
      this.activate(clicked?.textContent ?? null);
    });

    const cached = cachedSnapshot(fullDocId);
    if (cached !== undefined) this.renderPreview(cached);
    else {
      this.setState('waiting');
      this.previewHost.textContent = 'Loading…';
    }
    this.unsubscribe = onSnapshot(fullDocId, (text) => {
      if (!this.liveView) this.renderPreview(text);
    });

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

  private setState(state: 'waiting' | 'preview' | 'connecting' | 'live' | 'error' | 'missing'): void {
    this.dom.setAttribute('data-state', state);
    const readOnly = context?.readOnly ?? true;
    this.hint.textContent =
      state === 'live' ? 'Editing the file · Esc to finish'
      : state === 'connecting' ? 'Opening…'
      : state === 'error' ? 'Could not load · click to retry'
      : state === 'preview' && !readOnly ? 'Click to edit'
      : '';
  }

  private load(): void {
    if (!this.fullDocId || this.liveView || this.destroyed) return;
    readSnapshot(this.fullDocId).catch(() => {
      if (this.destroyed || this.liveView) return;
      if (cachedSnapshot(this.fullDocId!) === undefined) {
        this.setState('error');
        this.previewHost.textContent = '';
      }
    });
  }

  private renderPreview(text: string): void {
    if (this.destroyed) return;
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

  private async activate(clickedText: string | null = null): Promise<void> {
    if (!this.fullDocId || !context || context.readOnly) return;
    if (this.dom.getAttribute('data-state') === 'error') {
      this.setState('waiting');
      this.load();
      return;
    }
    const ctx = context;
    this.setState('connecting');
    let opened;
    try {
      opened = await openLive(this.fullDocId, this, () => this.deactivated());
    } catch {
      if (!this.destroyed && isLive(this)) closeLive(this);
      if (!this.destroyed) this.setState('error');
      return;
    }
    if (!opened || this.destroyed) {
      if (opened) closeLive(this);
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
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          keymap.of([
            { key: 'Escape', run: () => { closeLive(this); return true; } },
            ...yUndoManagerKeymap,
            ...defaultKeymap,
          ]),
          markdown({ base: markdownLanguage, addKeymap: false }),
          yCollab(ytext, null, { undoManager }),
          criticMarkupExtension({ canAcceptReject: ctx.canAcceptReject }),
          EditorView.lineWrapping,
          EditorView.theme({ '.tok-heading': { textDecoration: 'none' } }),
        ],
      }),
    });
    if (this.host.state.field(suggestionModeField, false)) {
      this.liveView.dispatch({ effects: toggleSuggestionMode.of(true) });
    }
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
    this.host.requestMeasure();
  }

  destroy(): void {
    closeLive(this);
    this.destroyed = true;
    this.observer?.disconnect();
    this.unsubscribe?.();
    const root = this.root;
    this.root = null;
    // Unmount after the current CodeMirror update; React refuses to unmount
    // synchronously while another root may be rendering.
    if (root) queueMicrotask(() => root.unmount());
  }
}
