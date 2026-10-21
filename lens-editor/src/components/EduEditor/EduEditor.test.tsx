import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { EditorView } from '@codemirror/view';
import { AuthProvider, type UserRole } from '../../contexts/AuthContext';
import { RELAY_ID } from '../../lib/constants';

const MODULE_ID = `${RELAY_ID}-module-uuid`;
const LENS_ID = `${RELAY_ID}-lens-uuid`;
const ELIAS = '{"author":"Elias","timestamp":1000}';
const LENS = `---\ntitle: Lens\n---\n#### Text\ncontent::\nHello {++${ELIAS}@@world++} end.\n`;

// Stable mock refs: EduEditor and ContentPanel connect in effects keyed on them
const docs = new Map<string, Y.Doc>();
const getOrConnect = vi.fn(async (docId: string) => {
  if (!docs.has(docId)) docs.set(docId, new Y.Doc());
  return { doc: docs.get(docId)!, provider: { destroy: vi.fn() } };
});
const disconnect = vi.fn();
const disconnectAll = vi.fn();

vi.mock('../../hooks/useDocConnection', () => ({
  useDocConnection: () => ({ getOrConnect, disconnect, disconnectAll }),
}));

vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    metadata: { 'Lenses/Lens.md': { id: 'lens-uuid' }, 'modules/Module.md': { id: 'module-uuid' } },
    folderNames: [],
  }),
}));

vi.mock('../../contexts/DisplayNameContext', () => ({
  useDisplayName: () => ({ displayName: 'Mark' }),
}));

// The module tree is not under test: one button that opens the lens
vi.mock('./ModuleTreeEditor', () => ({
  ModuleTreeEditor: ({ onSelect }: { onSelect: (scope: object) => void }) => (
    <button onClick={() => onSelect({ kind: 'full-doc', docId: LENS_ID, docName: 'Lens', docPath: 'Lenses/Lens.md' })}>
      Open the lens
    </button>
  ),
}));

const { EduEditor } = await import('./EduEditor');

/** Opens the lens's text field in its section editor, cursor inside Elias's suggestion */
async function openTextField(role: UserRole): Promise<EditorView> {
  render(
    <MemoryRouter>
      <AuthProvider role={role} folderUuid={null} isAllFolders>
        <EduEditor moduleDocId={MODULE_ID} sourcePath="modules/Module.md" />
      </AuthProvider>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByText('Open the lens'));
  fireEvent.click(await screen.findByText('world'));
  const dom = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('.cm-editor');
    expect(el).not.toBeNull();
    return el!;
  });
  const view = EditorView.findFromDOM(dom)!;
  view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('world') + 2 } });
  return view;
}

const buttons = (view: EditorView) =>
  view.contentDOM.querySelectorAll('.cm-criticmarkup-accept, .cm-criticmarkup-reject');

describe('EduEditor: accepting and rejecting suggestions by role', () => {
  beforeEach(() => {
    docs.clear();
    const lens = new Y.Doc();
    lens.getText('contents').insert(0, LENS);
    docs.set(LENS_ID, lens);
    // Where the header's Suggesting/Editing control renders
    const header = document.createElement('div');
    header.id = 'header-controls';
    document.body.appendChild(header);
  });

  afterEach(() => {
    document.getElementById('header-controls')?.remove();
    localStorage.clear();
  });

  it.each<UserRole>(['edit', 'admin'])('gives the %s role ✓ ✗ on a suggestion in a section editor', async (role) => {
    const view = await openTextField(role);

    expect(buttons(view)).toHaveLength(2);
  });

  it('gives the suggest role no ✓ ✗, but the suggestion and suggestion mode', async () => {
    const view = await openTextField('suggest');

    expect(buttons(view)).toHaveLength(0);
    expect(view.contentDOM.querySelector('.cm-addition')?.textContent).toBe('world');

    view.dispatch({ selection: { anchor: 0 } });
    // The panel and the editor re-render from the Y.Text change
    act(() => view.dispatch({ changes: { from: 0, insert: 'Oh, ' }, userEvent: 'input.type' }));
    expect(docs.get(LENS_ID)!.getText('contents').toString()).toMatch(
      /content::\n\{\+\+\{"author":"Mark"[^}]*\}@@Oh, \+\+\}Hello \{\+\+/,
    );
  });
});
