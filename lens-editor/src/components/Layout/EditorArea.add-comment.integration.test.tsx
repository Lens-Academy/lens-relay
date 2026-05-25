/**
 * Integration tests for the file-editor "add comment" flow.
 *
 * Real EditorArea + real CodeMirror Editor + real CommentsLayer wired against
 * a real Y.Doc. Only `@y-sweet/react` is stubbed (it would otherwise open a
 * websocket) and the Harper linter (worker can't run under happy-dom).
 *
 * Coverage:
 *   - Test A — Right-click → "Add Comment" goes through Editor's onRequestAddComment
 *     prop, which EditorArea must wire into CommentsLayer; submitting writes
 *     `{>>…<<}` into the Y.Text at the click position.
 *   - Test B — The sidebar "+ Add" button reads the cursor at click-time rather
 *     than at render-time, so a cursor move after the last EditorArea render is
 *     respected.
 *
 * Note: `view.posAtCoords` returns null in happy-dom (no real layout). Test A
 * patches it on the live view to return a known offset so the contextmenu
 * handler can proceed.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react';
import { useMemo, useRef, type ReactNode } from 'react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { EditorView } from '@codemirror/view';
import { AuthProvider } from '../../contexts/AuthContext';
import { DisplayNameProvider } from '../../contexts/DisplayNameContext';
import { NavigationContext } from '../../contexts/NavigationContext';

// Shared Y.Doc + Awareness across the @y-sweet/react mock and the test body so
// the test can both drive the editor and inspect the resulting Y.Text directly.
const ydoc = new Y.Doc();
const awareness = new Awareness(ydoc);

vi.mock('@y-sweet/react', () => {
  const provider = {
    awareness,
    synced: true,
    on: (event: string, cb: () => void) => {
      if (event === 'synced') queueMicrotask(cb);
    },
    off: () => {},
  };
  return {
    useYDoc: () => ydoc,
    useYjsProvider: () => provider,
  };
});

// Discord-dependent panel — not exercised by this flow.
vi.mock('../DiscussionPanel', () => ({
  ConnectedDiscussionPanel: () => null,
}));
vi.mock('../DiscussionPanel/useHasDiscussion', () => ({
  useHasDiscussion: () => false,
}));

// Harper linter spins up a worker that happy-dom can't host. The linter is
// orthogonal to the comment-insertion path under test.
vi.mock('../Editor/extensions/harper', () => ({
  harperLinter: [],
  updateHarperFolder: () => {},
}));

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

// Lazy import so the @y-sweet/react mock above is in place before EditorArea's
// module graph loads.
async function renderRealEditorArea() {
  const { EditorArea } = await import('./EditorArea');
  return render(
    <AuthProvider role="edit" folderUuid={null} isAllFolders>
      <DisplayNameProvider>
        <NavigationStub>
          <EditorArea currentDocId="test-doc" />
        </NavigationStub>
      </DisplayNameProvider>
    </AuthProvider>,
  );
}

async function getMountedEditorView(): Promise<EditorView> {
  const editorEl = await waitFor(() => {
    const el = document.querySelector('.cm-editor') as HTMLElement | null;
    if (!el) throw new Error('CodeMirror editor not mounted yet');
    return el;
  });
  const view = EditorView.findFromDOM(editorEl);
  if (!view) throw new Error('EditorView.findFromDOM returned null');
  return view;
}

async function waitForDocText(view: EditorView, expected: string) {
  await waitFor(() => {
    if (view.state.doc.toString() !== expected) {
      throw new Error(
        `editor doc not synced — got ${JSON.stringify(view.state.doc.toString())}, want ${JSON.stringify(expected)}`,
      );
    }
  });
}

/**
 * Fire a right-click on the editor that resolves to `posAtClick`. happy-dom
 * has no layout, so `posAtCoords` returns null by default; patch it for the
 * duration of the contextmenu dispatch.
 */
function rightClickAndOpenAddComment(view: EditorView, posAtClick: number) {
  const original = view.posAtCoords.bind(view);
  view.posAtCoords = () => posAtClick;
  try {
    const wrapper = view.dom.parentElement as HTMLElement;
    act(() => {
      fireEvent.contextMenu(wrapper, { clientX: 10, clientY: 10 });
    });
  } finally {
    view.posAtCoords = original;
  }
  const item = screen.getByText('Add Comment');
  fireEvent.click(item);
}

async function fillAndSubmitForm(content: string) {
  const textarea = await waitFor(() => {
    const el = document.querySelector('.add-comment-form textarea') as HTMLTextAreaElement | null;
    if (!el) throw new Error('AddCommentForm textarea not visible');
    return el;
  });
  fireEvent.change(textarea, { target: { value: content } });
  const addButton = screen.getByRole('button', { name: 'Add' });
  fireEvent.click(addButton);
}

describe('EditorArea — add comment integration', () => {
  afterEach(() => {
    cleanup();
    const ytext = ydoc.getText('contents');
    ytext.delete(0, ytext.length);
  });

  it('right-click → Add Comment opens the form and submitting writes the comment at the click position', async () => {
    // Load doc after the editor mounts — yCollab only mirrors future deltas.
    const ytext = ydoc.getText('contents');
    await renderRealEditorArea();
    const view = await getMountedEditorView();
    act(() => {
      ytext.insert(0, 'hello world');
    });
    await waitForDocText(view, 'hello world');

    // Right-click "between hello and world" (offset 6) → menu opens → click Add Comment.
    rightClickAndOpenAddComment(view, 6);

    await fillAndSubmitForm('my note');

    // Comment must land at the click offset, between "hello " and "world".
    await waitFor(() => {
      expect(ytext.toString()).toMatch(
        /^hello \{>>\{"author":"[^"]+","timestamp":\d+\}@@my note<<\}world$/,
      );
    });
  });

  it('the sidebar "+ Add" button inserts at the current cursor, not a stale render-time cursor', async () => {
    // Uses the sidebar's own "+ Add" button (which has its own showAddForm
    // state, so it opens the form independent of the keyboard-shortcut wire
    // tested above). This isolates the stale-prop bug from the dead-trigger bug.
    const ytext = ydoc.getText('contents');
    await renderRealEditorArea();
    const view = await getMountedEditorView();
    act(() => {
      ytext.insert(0, 'hello world');
    });
    await waitForDocText(view, 'hello world');

    // Move the cursor to offset 6 (between "hello " and "world"). Selection
    // changes do NOT trigger an EditorArea re-render, so the stale-prop bug
    // leaves insertCursorPos=0 even though the cursor is now at 6.
    act(() => {
      view.dispatch({ selection: { anchor: 6 } });
    });

    // Click the sidebar's "+ Add" button → form opens.
    const addBtn = screen.getByRole('button', { name: '+ Add' });
    fireEvent.click(addBtn);
    await fillAndSubmitForm('mid note');

    // The comment must land at offset 6 — between "hello " and "world".
    await waitFor(() => {
      const text = ytext.toString();
      expect(text).toMatch(/^hello \{>>\{"author":"[^"]+","timestamp":\d+\}@@mid note<<\}world$/);
    });
  });
});
