import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { EditorState, Text } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { embedLinesIn, noteEmbedField, openEmbedAtCursor, updateNoteEmbedContext, type NoteEmbedContext } from './noteEmbed';
import * as Y from 'yjs';
import { isLive } from '../../../lib/embed-docs';
import { __embedDocsTesting, setSnapshot } from '../../../lib/embed-docs';

const LENS = [
  '#### Question',
  '![[../Questions/Shared]]',
  'force-feedback:: first',
  '',
  '```',
  '![[In code]]',
  '```',
  '![[picture.png]]',
  'see ![[inline]] here',
  '#### Question',
  '![[../Questions/Missing]]',
].join('\n');

describe('findEmbedLines', () => {
  it('finds lines that are only a non-image embed, outside code', () => {
    const doc = Text.of(LENS.split('\n'));
    expect(embedLinesIn(doc).map((e) => e.target)).toEqual(['../Questions/Shared', '../Questions/Missing']);
    expect(embedLinesIn(doc)[0].lineTo).toBe(doc.line(2).to);
  });
});

describe('noteEmbedField cards', () => {
  let view: EditorView | null = null;
  const context = (over: Partial<NoteEmbedContext> = {}): NoteEmbedContext => ({
    resolve: (t) => (t.endsWith('Shared') ? { fullDocId: 'relay-shared', path: '/Questions/Shared.md' } : null),
    onOpen: () => {},
    readOnly: false,
    canAcceptReject: true,
    getActor: () => 'human:Test',
    ...over,
  });

  beforeEach(() => {
    __embedDocsTesting.reset();
    // Never read over the network in tests; cards wait for a snapshot.
    __embedDocsTesting.setReader(() => new Promise(() => {}));
  });
  afterEach(() => {
    view?.destroy();
    view = null;
    updateNoteEmbedContext(undefined);
  });

  function mount(doc: string) {
    view = new EditorView({
      state: EditorState.create({ doc, extensions: [markdown(), noteEmbedField] }),
      parent: document.body,
    });
    return view;
  }

  it('renders a card under each embed, and says when the file is missing', () => {
    updateNoteEmbedContext(context());
    const v = mount(LENS);
    const cards = [...v.dom.querySelectorAll('.cm-note-embed')];
    expect(cards.map((c) => c.getAttribute('data-embed-target'))).toEqual(['../Questions/Shared', '../Questions/Missing']);
    expect(cards[0].getAttribute('data-state')).toBe('waiting');
    expect(cards[1].getAttribute('data-state')).toBe('missing');
    expect(cards[1].textContent).toContain('No file named');
  });

  it('shows the file read-only, rendered like the page', async () => {
    updateNoteEmbedContext(context());
    setSnapshot('relay-shared', '#### Question: Open\nid:: 1\ncontent:: Does this setup hold?\n');
    const v = mount(LENS);
    await new Promise((r) => setTimeout(r, 20));
    const card = v.dom.querySelector('.cm-note-embed')!;
    expect(card.getAttribute('data-state')).toBe('preview');
    const preview = EditorView.findFromDOM(card.querySelector('.cm-editor') as HTMLElement)!;
    expect(preview.state.doc.toString()).toBe('#### Question: Open\nid:: 1\ncontent:: Does this setup hold?\n');
    expect(preview.state.readOnly).toBe(true);
    // The live-preview look: the heading is styled as a heading
    expect(card.querySelector('.cm-heading-4')?.textContent).toContain('Question: Open');
    expect(card.querySelector('.cm-note-embed-hint')?.textContent).toBe('Click to edit');
  });

  it('renders the last line too when the file has no final newline', async () => {
    updateNoteEmbedContext(context());
    setSnapshot('relay-shared', '#### Question: Open\ncontent:: Hi\n\n#### Text');
    const v = mount(LENS);
    await new Promise((r) => setTimeout(r, 20));
    const preview = EditorView.findFromDOM(v.dom.querySelector('.cm-note-embed .cm-editor') as HTMLElement)!;
    expect(preview.state.doc.toString().endsWith('#### Text\n')).toBe(true);
    expect(preview.state.selection.main.head).toBe(preview.state.doc.length);
  });

  it('offers no editing to read-only viewers', async () => {
    updateNoteEmbedContext(context({ readOnly: true }));
    setSnapshot('relay-shared', '#### Question\ncontent:: Hi\n');
    const v = mount(LENS);
    await new Promise((r) => setTimeout(r, 20));
    const card = v.dom.querySelector('.cm-note-embed')!;
    expect(card.querySelector('.cm-note-embed-hint')?.textContent).toBe('');
    expect(card.querySelector('.cm-note-embed-open')).toBeNull();
  });

  function liveConnector() {
    __embedDocsTesting.setConnector(async () => {
      const doc = new Y.Doc();
      doc.getText('contents').insert(0, '#### Question\ncontent:: Hi\n');
      const provider = { hasLocalChanges: false, on() {}, off() {}, disconnect() {}, destroy() {} };
      return { doc, provider: provider as never };
    });
  }
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it('Alt-Enter on the embed line opens it; Esc gives the keyboard back to the lens', async () => {
    updateNoteEmbedContext(context());
    setSnapshot('relay-shared', '#### Question\ncontent:: Hi\n');
    liveConnector();
    const v = mount(LENS);
    v.dispatch({ selection: { anchor: 3 } });
    expect(openEmbedAtCursor(v)).toBe(false); // the header line, not the embed
    const embedLine = v.state.doc.line(2);
    v.dispatch({ selection: { anchor: embedLine.from } });
    expect(openEmbedAtCursor(v)).toBe(true);
    await settle();
    const card = v.dom.querySelector('.cm-note-embed')!;
    expect(card.getAttribute('data-state')).toBe('live');
    const inner = EditorView.findFromDOM(card.querySelector('.cm-note-embed-live .cm-editor') as HTMLElement)!;
    runScopeHandlers(inner, new KeyboardEvent('keydown', { key: 'Escape' }), 'editor');
    await settle();
    expect(card.getAttribute('data-state')).toBe('preview');
    expect(v.state.selection.main.head).toBe(embedLine.to);
    expect(v.hasFocus).toBe(true);
  });

  it('retries a failed read on click and shows the file', async () => {
    updateNoteEmbedContext(context());
    let fail = true;
    __embedDocsTesting.setReader(async () => {
      if (fail) throw new Error('offline');
      return '#### Question\ncontent:: Back again\n';
    });
    // The test DOM never reports cards on screen: read at once instead.
    vi.stubGlobal('IntersectionObserver', undefined);
    const v = mount(LENS);
    vi.unstubAllGlobals();
    await settle();
    const card = v.dom.querySelector('.cm-note-embed')!;
    expect(card.getAttribute('data-state')).toBe('error');
    expect(card.querySelector('.cm-note-embed-hint')?.textContent).toBe('Could not load · click to retry');
    fail = false;
    card.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await settle();
    expect(card.getAttribute('data-state')).toBe('preview');
    expect(card.textContent).toContain('Back again');
  });

  it('ends a live embed when its card goes away', async () => {
    updateNoteEmbedContext(context());
    setSnapshot('relay-shared', '#### Question\ncontent:: Hi\n');
    liveConnector();
    const v = mount(LENS);
    v.dispatch({ selection: { anchor: v.state.doc.line(2).from } });
    openEmbedAtCursor(v);
    await settle();
    // Deleting the embed line removes the card (and its live editor).
    const line = v.state.doc.line(2);
    v.dispatch({ changes: { from: line.from, to: line.to + 1 } });
    await settle();
    expect(v.dom.querySelector('.cm-note-embed[data-state="live"]')).toBeNull();
    expect(isLive({})).toBe(false);
  });

  it('shows nothing without a context (no metadata yet)', () => {
    const v = mount(LENS);
    expect(v.dom.querySelector('.cm-note-embed')).toBeNull();
  });
});
