/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { DisplayNameProvider } from '../../contexts/DisplayNameContext';
import type { SourceLinkMenuTarget } from '../SourceLinksBar/sourceLinkMenu';
import { Editor } from './Editor';

const yjs = vi.hoisted(() => ({ doc: undefined as unknown, provider: undefined as unknown }));

vi.mock('../../lib/ydoc-provider', () => ({
  useYDoc: () => yjs.doc,
  useYjsProvider: () => yjs.provider,
}));
// Harper loads a wasm linter, which has nothing to do with this menu
vi.mock('./extensions/harper', () => ({ harperLinter: [], updateHarperFolder: () => {} }));

const URL_A = 'https://example.com/a';
const TEXT = `Read [the post](${URL_A}) now`;

/** The main editor on a page; happy-dom has no layout, so the click is placed by hand. */
function mountEditor(target?: SourceLinkMenuTarget) {
  const doc = new Y.Doc();
  yjs.doc = doc;
  yjs.provider = { awareness: new Awareness(doc), synced: true, on: () => {}, off: () => {} };
  let view: EditorView | null = null;
  render(
    <DisplayNameProvider>
      <Editor
        onEditorReady={(ready) => {
          view = ready;
        }}
        sourceLinkTargetRef={target ? { current: target } : undefined}
      />
    </DisplayNameProvider>,
  );
  // The text arrives once the editor is bound, as a document syncing in does
  act(() => doc.getText('contents').insert(0, TEXT));
  return view as unknown as EditorView;
}

function rightClickAt(view: EditorView, pos: number) {
  view.posAtCoords = (() => pos) as EditorView['posAtCoords'];
  fireEvent.contextMenu(view.dom, { clientX: 10, clientY: 10 });
}

describe('the right-click on a link in the main editor', () => {
  beforeEach(() => {
    // Read-aloud asks for its voices when an editor mounts
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('adds "Import and link this source" above Add Comment, and it imports', () => {
    const target = { canImport: vi.fn(() => true), importSource: vi.fn() };
    const view = mountEditor(target);
    rightClickAt(view, TEXT.indexOf('post'));

    const labels = screen.getAllByRole('button').map((button) => button.textContent);
    expect(labels.findIndex((label) => label?.startsWith('Import and link this source'))).toBeGreaterThanOrEqual(0);
    expect(labels.at(-1)).toContain('Add Comment');

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Import and link this source' }));
    });
    expect(target.importSource).toHaveBeenCalledWith(URL_A);
    expect(screen.queryByRole('button', { name: 'Import and link this source' })).not.toBeInTheDocument();
  });

  it('tells the page when the caret moves, and when the text changes', () => {
    const target = { canImport: () => true, importSource: vi.fn(), editorChanged: vi.fn() };
    const view = mountEditor(target);
    target.editorChanged.mockClear();
    act(() => view.dispatch({ selection: { anchor: 3 } }));
    expect(target.editorChanged).toHaveBeenCalledWith(view);
    target.editorChanged.mockClear();
    act(() => view.dispatch({ changes: { from: 0, insert: 'x' } }));
    expect(target.editorChanged).toHaveBeenCalledTimes(1);
  });

  it('adds nothing off a link', () => {
    const view = mountEditor({ canImport: () => true, importSource: vi.fn() });
    rightClickAt(view, 1);
    expect(screen.getByRole('button', { name: /Add Comment/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import and link this source' })).not.toBeInTheDocument();
  });

  it('adds nothing when the page cannot have it', () => {
    const view = mountEditor({ canImport: () => false, importSource: vi.fn() });
    rightClickAt(view, TEXT.indexOf('post'));
    expect(screen.queryByRole('button', { name: 'Import and link this source' })).not.toBeInTheDocument();
  });

  it('adds nothing where no target is passed: the section and /edu editors', () => {
    const view = mountEditor();
    rightClickAt(view, TEXT.indexOf('post'));
    expect(screen.queryByRole('button', { name: 'Import and link this source' })).not.toBeInTheDocument();
  });
});
