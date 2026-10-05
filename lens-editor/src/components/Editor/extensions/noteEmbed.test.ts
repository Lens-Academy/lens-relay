import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { EditorState, Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { cursorFor, findEmbedLines, noteEmbedField, updateNoteEmbedContext, type NoteEmbedContext } from './noteEmbed';
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
    expect(findEmbedLines(doc).map((e) => e.target)).toEqual(['../Questions/Shared', '../Questions/Missing']);
    expect(findEmbedLines(doc)[0].lineTo).toBe(doc.line(2).to);
  });
});

describe('cursorFor', () => {
  const file = '#### Question\nid:: x\ncontent:: Does it hold?\nassessment-instructions:: Score it';
  it('lands at the end of the line holding the clicked text', () => {
    expect(cursorFor(file, 'Does it hold?')).toBe(file.indexOf('\nassessment'));
    expect(cursorFor(file, 'Score it')).toBe(file.length);
  });
  it('falls back to the start', () => {
    expect(cursorFor(file, null)).toBe(0);
    expect(cursorFor(file, 'rendered differently')).toBe(0);
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

  it('previews the file from its snapshot, question-shaped', async () => {
    updateNoteEmbedContext(context());
    setSnapshot('relay-shared', '#### Question: Open\nid:: 1\ncontent:: Does this setup hold?\n');
    const v = mount(LENS);
    await new Promise((r) => setTimeout(r, 20));
    const card = v.dom.querySelector('.cm-note-embed')!;
    expect(card.getAttribute('data-state')).toBe('preview');
    expect(card.querySelector('.cm-note-embed-kind')?.textContent).toBe('Question · Open');
    expect(card.textContent).toContain('Does this setup hold?');
    expect(card.querySelector('.cm-note-embed-hint')?.textContent).toBe('Click to edit');
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

  it('shows nothing without a context (no metadata yet)', () => {
    const v = mount(LENS);
    expect(v.dom.querySelector('.cm-note-embed')).toBeNull();
  });
});
