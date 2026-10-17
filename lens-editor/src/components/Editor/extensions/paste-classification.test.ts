import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import * as Y from 'yjs';
import { pasteClassification, pasteClassifyCallback, type PendingPaste } from './paste-classification';
import { forgetCopied, rememberCopied } from '../../../lib/carried-authorship';

const TEXT = 'A paragraph long enough to be asked about.';
const luc = { actor: 'human:Luc', at: 1 };
const unmarked = { actor: null, at: null };

function setup() {
  const ydoc = new Y.Doc();
  const handler = vi.fn<(paste: PendingPaste) => void>();
  const view = new EditorView({
    state: EditorState.create({
      doc: 'one\ntwo',
      extensions: [
        EditorState.allowMultipleSelections.of(true),
        pasteClassification(ydoc),
        pasteClassifyCallback.of((paste) => handler(paste)),
      ],
    }),
    parent: document.body,
  });
  return { view, handler };
}

/** Fire a real paste event at the editor and let the microtask run. */
async function paste(view: EditorView, text: string) {
  const data = new DataTransfer();
  data.setData('text/plain', text);
  const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
  view.contentDOM.dispatchEvent(event);
  await Promise.resolve();
}

beforeEach(() => forgetCopied());

describe('pasteClassification', () => {
  it('asks about text from elsewhere', async () => {
    const { view, handler } = setup();
    await paste(view, TEXT);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ length: TEXT.length, partial: false }));
  });

  it('does not ask about a paste of the copied text whose authors are known', async () => {
    const { view, handler } = setup();
    rememberCopied({ text: TEXT, spans: [{ length: TEXT.length, author: luc }] });
    await paste(view, TEXT);
    expect(handler).not.toHaveBeenCalled();
  });

  it('asks about the unmarked parts of a paste of the copied text', async () => {
    const { view, handler } = setup();
    rememberCopied({ text: TEXT, spans: [{ length: 10, author: luc }, { length: TEXT.length - 10, author: unmarked }] });
    await paste(view, TEXT);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ partial: true }));
  });

  it('asks about a paste of the copied text spread over several cursors', async () => {
    const { view, handler } = setup();
    rememberCopied({ text: TEXT, spans: [{ length: TEXT.length, author: luc }] });
    view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(4)]) });
    await paste(view, TEXT);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ partial: false }));
  });
});
