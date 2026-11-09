/**
 * A page takes the cursor once it has synced, so typing works without a
 * click: below the frontmatter, and never from a field the user types in.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';
import { useMemo, useRef, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { EditorView } from '@codemirror/view';
import { AuthProvider } from '../../contexts/AuthContext';
import { DisplayNameProvider } from '../../contexts/DisplayNameContext';
import { NavigationContext } from '../../contexts/NavigationContext';

const ydoc = new Y.Doc();
const awareness = new Awareness(ydoc);

vi.mock('../../lib/ydoc-provider', () => {
  const provider = {
    awareness,
    synced: true,
    on: (event: string, cb: () => void) => {
      if (event === 'synced') queueMicrotask(cb);
    },
    off: () => {},
  };
  return { useYDoc: () => ydoc, useYjsProvider: () => provider };
});

vi.mock('../DiscussionPanel', () => ({ ConnectedDiscussionPanel: () => null }));
vi.mock('../DiscussionPanel/useHasDiscussion', () => ({ useHasDiscussion: () => false }));
vi.mock('../Editor/extensions/harper', async () => {
  const { StateField } = await import('@codemirror/state');
  return {
    harperLinter: [],
    updateHarperFolder: () => {},
    // The spellcheck setting EditorArea holds for the page menu
    loadSpellcheckEnabled: () => true,
    saveSpellcheckEnabled: () => {},
    spellcheckEnabledField: StateField.define({ create: () => true, update: (on: boolean) => on }),
    toggleSpellcheck: () => {},
  };
});

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

function NavigationStub({ children }: { children: ReactNode }) {
  const justCreatedRef = useRef(false);
  const value = useMemo(
    () => ({
      metadata: {},
      folderDocs: new Map<string, Y.Doc>(),
      folderNames: [] as string[],
      errors: new Map<string, Error>(),
      onNavigate: () => {},
      justCreatedRef,
    }),
    [],
  );
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

async function renderEditorArea(): Promise<EditorView> {
  const { EditorArea } = await import('./EditorArea');
  render(
    <MemoryRouter>
      <AuthProvider role="edit" folderUuid={null} isAllFolders>
        <DisplayNameProvider>
          <NavigationStub>
            <EditorArea currentDocId="test-doc" />
          </NavigationStub>
        </DisplayNameProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  const editorEl = await waitFor(() => {
    const el = document.querySelector('.cm-editor') as HTMLElement | null;
    if (!el) throw new Error('CodeMirror editor not mounted yet');
    return el;
  });
  return EditorView.findFromDOM(editorEl)!;
}

// Content arrives after the editor mounts, as from the relay after sync
function setContents(text: string) {
  ydoc.getText('contents').insert(0, text);
}

describe('EditorArea — autofocus on open', () => {
  afterEach(() => {
    cleanup();
    const ytext = ydoc.getText('contents');
    ytext.delete(0, ytext.length);
    document.querySelectorAll('[data-test-input]').forEach((el) => el.remove());
  });

  it('focuses the editor with the cursor on the first line below the frontmatter', async () => {
    const view = await renderEditorArea();
    setContents('---\ntitle: A\n---\n# Heading\nBody');
    await waitFor(() => expect(view.contentDOM.contains(document.activeElement)).toBe(true));
    expect(view.state.doc.lineAt(view.state.selection.main.head).text).toBe('# Heading');
  });

  it('focuses at the start when there is no frontmatter', async () => {
    const view = await renderEditorArea();
    setContents('# Heading\nBody');
    await waitFor(() => expect(view.contentDOM.contains(document.activeElement)).toBe(true));
    expect(view.state.selection.main.head).toBe(0);
  });

  it('does not take focus from a field the user is typing in', async () => {
    const input = document.createElement('input');
    input.setAttribute('data-test-input', '');
    document.body.appendChild(input);
    input.focus();
    const view = await renderEditorArea();
    setContents('# Heading\nBody');
    await new Promise((r) => setTimeout(r, 300));
    expect(view.contentDOM.contains(document.activeElement)).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it('leaves a page that is only frontmatter unfocused, so typing cannot break it', async () => {
    const view = await renderEditorArea();
    setContents('---\ntitle: A\n---');
    await new Promise((r) => setTimeout(r, 300));
    expect(view.contentDOM.contains(document.activeElement)).toBe(false);
  });
});
