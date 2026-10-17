import { describe, it, expect, beforeEach } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  moveLineDown,
  moveLineUp,
  copyLineDown,
  copyLineUp,
} from '@codemirror/commands';
import { yCollab } from 'y-codemirror.next';
import * as Y from 'yjs';
import { getAuthorshipRuns } from '../../../lib/authorship-runs';
import { getClientActorMap, getRegisteredAt, registerClientMapping } from '../../../lib/provenance';
import { forgetCopied } from '../../../lib/carried-authorship';
import { keepAuthorship, copiedAuthoredText } from './keepAuthorship';
import { rememberCopied } from '../../../lib/carried-authorship';

const LUC_DAY = new Date('2026-09-01T10:00:00').getTime();
const AI_DAY = new Date('2026-09-02T10:00:00').getTime();

/** A doc whose lines were written by Luc, his AI and Luc again, opened by a
 *  third writer ("Ann") in an editor. */
function setup(keep: boolean, text = 'Luc line one\nAI line two\nLuc line three') {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('contents');
  const lines = text.split('\n');
  const writers = ['human:Luc', 'ai:fable-5:Luc', 'human:Luc'];
  const ids = [1001, 1002, 1001];
  lines.forEach((line, i) => {
    ydoc.clientID = ids[i % 3];
    ytext.insert(ytext.length, (i ? '\n' : '') + line);
  });
  registerClientMapping(ydoc, writers[0], LUC_DAY, 1001);
  registerClientMapping(ydoc, writers[1], AI_DAY, 1002);
  ydoc.clientID = 2000;
  registerClientMapping(ydoc, 'human:Ann', Date.now(), 2000);

  const extensions: Extension[] = [];
  if (keep) extensions.push(keepAuthorship(ydoc, ytext));
  extensions.push(yCollab(ytext, null, { undoManager: false }));
  const view = new EditorView({
    state: EditorState.create({ doc: ytext.toString(), extensions }),
    parent: document.body,
  });
  return { ydoc, ytext, view };
}

/** Each line of the doc as "author: text", the authors of its characters
 *  (line breaks aside) joined with "+" when there are several. */
function authors(ydoc: Y.Doc, ytext: Y.Text): string[] {
  const actors = getClientActorMap(ydoc);
  const text = ytext.toString();
  const byChar: string[] = [];
  for (const run of getAuthorshipRuns(ytext)) {
    for (let i = run.from; i < run.to; i++) byChar[i] = actors.get(run.client) ?? 'unknown';
  }
  let pos = 0;
  return text.split('\n').map((line) => {
    const names = [...new Set(byChar.slice(pos, pos + line.length))];
    pos += line.length + 1;
    return `${names.join('+')}: ${line}`;
  });
}

function cursorOnLine(view: EditorView, n: number) {
  view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(n).from + 2) });
}

beforeEach(() => forgetCopied());

const L1 = 'human:Luc: Luc line one';
const L2 = 'ai:fable-5:Luc: AI line two';
const L3 = 'human:Luc: Luc line three';

describe('without keepAuthorship (the bug)', () => {
  it('moving a line re-attributes the line it swaps with to the person moving', () => {
    const { ydoc, ytext, view } = setup(false);
    cursorOnLine(view, 2);
    moveLineUp(view);
    expect(ytext.toString()).toBe('AI line two\nLuc line one\nLuc line three');
    expect(authors(ydoc, ytext)).toEqual([L2, 'human:Ann: Luc line one', L3]);
  });
});

describe('keepAuthorship', () => {
  it.each([
    ['Alt-↑ (moveLineUp)', moveLineUp, 2],
    ['Alt-↓ (moveLineDown)', moveLineDown, 1],
  ])('%s keeps every line with its author', (_name, command, line) => {
    const { ydoc, ytext, view } = setup(true);
    cursorOnLine(view, line);
    command(view);
    expect(ytext.toString()).toBe('AI line two\nLuc line one\nLuc line three');
    expect(authors(ydoc, ytext)).toEqual([L2, L1, L3]);
  });

  it('keeps the original date, under a new clientID', () => {
    const { ydoc, ytext, view } = setup(true);
    cursorOnLine(view, 2);
    moveLineUp(view); // moves line 1 down, so Luc's line is re-inserted
    const text = ytext.toString();
    const run = getAuthorshipRuns(ytext).find((r) => text.slice(r.from, r.to).includes('Luc line one'))!;
    expect(run.client).not.toBe(1001); // never write under another writer's clientID
    expect(getRegisteredAt(ydoc, run.client)).toBe(LUC_DAY);
  });

  it('moves a multi-line selection with mixed authors', () => {
    const { ydoc, ytext, view } = setup(true, 'Luc line one\nAI line two\nLuc line three\nAI four');
    view.dispatch({ selection: EditorSelection.range(0, view.state.doc.line(2).to) });
    moveLineDown(view);
    expect(ytext.toString()).toBe('Luc line three\nLuc line one\nAI line two\nAI four');
    expect(authors(ydoc, ytext)).toEqual([L3, L1, L2, 'human:Luc: AI four']);
  });

  it.each([
    ['Shift-Alt-↓ (copyLineDown)', copyLineDown],
    ['Shift-Alt-↑ (copyLineUp)', copyLineUp],
  ])('%s gives the copy the original author', (_name, command) => {
    const { ydoc, ytext, view } = setup(true);
    cursorOnLine(view, 2);
    command(view);
    expect(authors(ydoc, ytext)).toEqual([L1, L2, L2, L3]);
  });

  it('dragging a selection (move.drop) keeps its author', () => {
    const { ydoc, ytext, view } = setup(true);
    const line2 = view.state.doc.line(2);
    const changes = view.state.changes([
      { from: line2.from - 1, to: line2.to },
      { from: view.state.doc.length, insert: '\nAI line two' },
    ]);
    view.dispatch({ changes, userEvent: 'move.drop' });
    expect(authors(ydoc, ytext)).toEqual([L1, L3, L2]);
  });

  it('still works in an editor created again for the same doc (React remount)', () => {
    const { ydoc, ytext, view: first } = setup(true);
    first.destroy();
    const view = new EditorView({
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [keepAuthorship(ydoc, ytext), yCollab(ytext, null, { undoManager: false })],
      }),
      parent: document.body,
    });
    cursorOnLine(view, 2);
    moveLineUp(view);
    expect(authors(ydoc, ytext)).toEqual([L2, L1, L3]);
  });

  it('a collaborator receives the move with the same authors', () => {
    const { ydoc, view } = setup(true);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    ydoc.on('update', (update: Uint8Array) => Y.applyUpdate(peer, update));
    cursorOnLine(view, 2);
    moveLineUp(view);
    expect(authors(peer, peer.getText('contents'))).toEqual([L2, L1, L3]);
  });

  it('undo puts a moved line back', () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('contents');
    ytext.insert(0, 'one\ntwo\nthree');
    const undoManager = new Y.UndoManager(ytext, { trackedOrigins: new Set([]) });
    const view = new EditorView({
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [keepAuthorship(ydoc, ytext), yCollab(ytext, null, { undoManager })],
      }),
      parent: document.body,
    });
    cursorOnLine(view, 2);
    moveLineUp(view);
    expect(ytext.toString()).toBe('two\none\nthree');
    undoManager.undo();
    expect(ytext.toString()).toBe('one\ntwo\nthree');
    expect(view.state.doc.toString()).toBe('one\ntwo\nthree');
  });

  it('typing is still the typist’s', () => {
    const { ydoc, ytext, view } = setup(true);
    view.dispatch({ changes: { from: 0, insert: 'Hi ' }, userEvent: 'input.type' });
    expect(authors(ydoc, ytext)[0]).toBe('human:Ann+human:Luc: Hi Luc line one');
  });

  it('unknown text stays unknown', () => {
    const { ydoc, ytext, view } = setup(true);
    ydoc.clientID = 3000; // never registered
    ytext.insert(ytext.length, '\nNobody knows');
    ydoc.clientID = 2000;
    cursorOnLine(view, 4);
    moveLineUp(view);
    expect(authors(ydoc, ytext)).toEqual([L1, L2, 'unknown: Nobody knows', L3]);
  });

  describe('copy and paste', () => {
    function copy(view: EditorView, ydoc: Y.Doc, ytext: Y.Text, from: number, to: number) {
      view.dispatch({ selection: EditorSelection.range(from, to) });
      rememberCopied(copiedAuthoredText(view.state, ydoc, ytext)!);
    }

    it('a paste of the copied text keeps its authors, in another doc too', () => {
      const a = setup(true);
      copy(a.view, a.ydoc, a.ytext, 4, a.view.state.doc.line(2).to);

      const b = setup(true, 'Other doc');
      b.view.dispatch({ changes: { from: b.view.state.doc.length, insert: 'line one\nAI line two' }, userEvent: 'input.paste' });
      expect(authors(b.ydoc, b.ytext)).toEqual(['human:Luc: Other docline one', L2]);
    });

    it('cut then paste moves a section with its authors', () => {
      const { ydoc, ytext, view } = setup(true);
      const line2 = view.state.doc.line(2);
      copy(view, ydoc, ytext, line2.from, line2.to + 1);
      view.dispatch({ changes: { from: line2.from, to: line2.to + 1 }, userEvent: 'delete.cut' });
      view.dispatch({ changes: { from: view.state.doc.length, insert: '\nAI line two\n' }, userEvent: 'input.paste' });
      // The paste is "\n" + the copy: not the copied text, so not carried
      expect(authors(ydoc, ytext)[2]).toBe('human:Ann: AI line two');
      view.dispatch({ changes: { from: 0, insert: 'AI line two\n' }, userEvent: 'input.paste' });
      expect(authors(ydoc, ytext)[0]).toBe(L2);
    });

    it('a whole-line copy (nothing selected) pasted as a line keeps its author', () => {
      const { ydoc, ytext, view } = setup(true);
      cursorOnLine(view, 2);
      rememberCopied(copiedAuthoredText(view.state, ydoc, ytext)!);
      view.dispatch({ changes: { from: 0, insert: 'AI line two\n' }, userEvent: 'input.paste' });
      expect(authors(ydoc, ytext)).toEqual([L2, L1, L2, L3]);
    });

    it('a paste of other text is the paster’s', () => {
      const { ydoc, ytext, view } = setup(true);
      copy(view, ydoc, ytext, 0, 3);
      view.dispatch({ changes: { from: 0, insert: 'Lucky\n' }, userEvent: 'input.paste' });
      expect(authors(ydoc, ytext)[0]).toBe('human:Ann: Lucky');
    });

    it('a suggestion-mode paste keeps the authors of the suggested text', () => {
      const { ydoc, ytext, view } = setup(true);
      const line2 = view.state.doc.line(2);
      copy(view, ydoc, ytext, line2.from, line2.to);
      const markup = '{++{"author":"Ann"}@@';
      const inserted = `${markup}AI line two++}`;
      view.dispatch({ changes: { from: 0, insert: inserted }, userEvent: 'input.paste' });
      const actors = getClientActorMap(ydoc);
      const text = ytext.toString();
      const pieces = getAuthorshipRuns(ytext)
        .filter((r) => r.from < inserted.length)
        .map((r) => `${actors.get(r.client)}: ${text.slice(r.from, Math.min(r.to, inserted.length))}`);
      expect(pieces).toEqual([`human:Ann: ${markup}`, 'ai:fable-5:Luc: AI line two', 'human:Ann: ++}']);
    });
  });
});
