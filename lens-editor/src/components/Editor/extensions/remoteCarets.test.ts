/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { CARET_LABEL_LINGER_MS, remoteCarets } from './remoteCarets';

/** Two clients on one document: the view belongs to `local`, `remote` moves around. */
function setup(text = 'hello world', opts?: { toAbs?: (p: number) => number; toCm?: (i: number) => number | null }) {
  const doc = new Y.Doc();
  const ytext = doc.getText('contents');
  ytext.insert(0, text);
  const local = new Awareness(doc);
  local.setLocalStateField('user', { name: 'Me', color: '#111111' });
  const remote = new Awareness(doc);
  remote.clientID = doc.clientID + 1;
  remote.setLocalStateField('user', { name: 'Ada', color: '#30bced' });

  const view = new EditorView({
    state: EditorState.create({
      doc: opts?.toCm ? text.slice(3, 8) : text,
      extensions: [remoteCarets({ ytext, awareness: local, ...opts })],
    }),
    parent: document.body,
  });
  views.push(view);

  // The relay would deliver the remote awareness state; inject it directly.
  const moveRemote = (index: number) => {
    const rel = Y.createRelativePositionFromTypeIndex(ytext, index);
    const cursor = { anchor: JSON.parse(JSON.stringify(rel)), head: JSON.parse(JSON.stringify(rel)) };
    local.states.set(remote.clientID, { user: { name: 'Ada', color: '#30bced' }, cursor });
    local.emit('change', [{ added: [], updated: [remote.clientID], removed: [] }, 'test']);
  };

  return { view, local, remote, moveRemote, ytext };
}

const views: EditorView[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  while (views.length) views.pop()!.destroy();
  vi.useRealTimers();
});

const caret = (view: EditorView) => view.contentDOM.querySelector('.cm-ySelectionCaret');

describe('remoteCarets', () => {
  it('draws a collaborator caret with their name, shown while it just moved', () => {
    const { view, moveRemote } = setup();
    moveRemote(5);

    const el = caret(view)!;
    expect(el).not.toBeNull();
    expect(el.querySelector('.cm-ySelectionInfo')!.textContent).toBe('Ada');
    expect(el.classList.contains('cm-ySelectionCaret-fresh')).toBe(true);
  });

  it('lets the name fade once the caret has rested', () => {
    const { view, moveRemote } = setup();
    moveRemote(5);
    expect(caret(view)!.classList.contains('cm-ySelectionCaret-fresh')).toBe(true);

    vi.advanceTimersByTime(CARET_LABEL_LINGER_MS + 10);
    expect(caret(view)!.classList.contains('cm-ySelectionCaret-fresh')).toBe(false);

    // Moving again brings it back.
    moveRemote(7);
    expect(caret(view)!.classList.contains('cm-ySelectionCaret-fresh')).toBe(true);
  });

  it('does not treat a heartbeat with the same cursor as a move', () => {
    const { view, moveRemote } = setup();
    moveRemote(5);
    vi.advanceTimersByTime(CARET_LABEL_LINGER_MS + 10);
    expect(caret(view)!.classList.contains('cm-ySelectionCaret-fresh')).toBe(false);

    moveRemote(5); // same position: awareness re-broadcast, not a move
    expect(caret(view)!.classList.contains('cm-ySelectionCaret-fresh')).toBe(false);
  });

  it('publishes the local cursor through toAbs and reads remote ones through toCm', () => {
    // The view shows text[3..8) of "hello world" ("lo wo").
    const { view, local, moveRemote, ytext } = setup('hello world', {
      toAbs: (p) => p + 3,
      toCm: (i) => (i < 3 || i > 8 ? null : i - 3),
    });

    view.focus();
    view.dispatch({ selection: { anchor: 2 } });
    view.dispatch({});
    const published = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(local.getLocalState()!.cursor.anchor),
      ytext.doc!,
    );
    expect(published!.index).toBe(5);

    moveRemote(10); // outside the slice: no caret
    expect(caret(view)).toBeNull();
    moveRemote(4); // inside: drawn at CM offset 1
    expect(caret(view)).not.toBeNull();
    expect(view.state.doc.sliceString(0, 1)).toBe('l');
  });
});
