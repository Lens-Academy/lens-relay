/**
 * Delete flow: the Sidebar's Delete action calls the relay's POST /doc/trash
 * (server-side trash), shows the referencing documents when the relay
 * refuses, and re-sends with force on "Delete anyway".
 *
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import * as Y from 'yjs';
import { Sidebar } from './Sidebar';
import { NavigationContext } from '../../contexts/NavigationContext';
import { AuthProvider } from '../../contexts/AuthContext';
import type { FolderMetadata } from '../../hooks/useFolderMetadata';

vi.mock('../../App', () => ({
  RELAY_ID: 'cb696037-0f72-4e93-8717-4e433129d789',
}));

vi.mock('../../hooks/useResolvedDocId', () => ({
  useResolvedDocId: (compoundId: string) => ({ docId: compoundId || null, notFound: false }),
}));

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

// A.md sits at the top level so its row is rendered (folders start collapsed).
const metadata: FolderMetadata = {
  '/Lens/A.md': { id: '11111111-1111-4111-8111-111111111111', type: 'markdown', version: 0 },
  '/Lens/B.md': { id: '22222222-2222-4222-8222-222222222222', type: 'markdown', version: 0 },
  '/Lens/Notes': { id: '00000000-0000-4000-8000-00000000000d', type: 'folder', version: 0 },
  '/Lens/Notes/C.md': { id: '33333333-3333-4333-8333-333333333333', type: 'markdown', version: 0 },
};

function renderSidebar(role: 'edit' | 'suggest' = 'edit') {
  const folderDoc = new Y.Doc();
  render(
    <MemoryRouter initialEntries={['/some-doc']}>
      <AuthProvider role={role} folderUuid={null} isAllFolders>
        <NavigationContext.Provider
          value={{
            metadata,
            folderDocs: new Map([['Lens', folderDoc]]),
            folderNames: ['Lens'],
            errors: new Map(),
            onNavigate: vi.fn(),
            justCreatedRef: { current: false },
          }}
        >
          <Sidebar />
        </NavigationContext.Provider>
      </AuthProvider>
    </MemoryRouter>
  );
  return folderDoc;
}

type TrashCall = { path: string; force?: boolean };

/** Mock fetch so /api/relay/doc/trash answers from `respond`; records calls. */
function mockTrashEndpoint(respond: (body: TrashCall) => Response) {
  const calls: TrashCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/api/relay/doc/trash' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as TrashCall;
      calls.push(body);
      return respond(body);
    }
    return new Response(`unexpected request ${url}`, { status: 404 });
  });
  return calls;
}

async function openDeleteDialog(user: ReturnType<typeof userEvent.setup>, name: string) {
  const row = screen.getByText(name).closest('[class*="cursor-pointer"]') as HTMLElement;
  fireEvent.contextMenu(row);
  await user.click(await screen.findByText(name === 'Notes' ? 'Delete Folder' : 'Delete'));
  await screen.findByText(`Delete ${name}?`);
}

describe('Sidebar delete via relay trash', () => {
  it('sends the user-facing path to /doc/trash and does not touch the folder doc', async () => {
    const user = userEvent.setup();
    const calls = mockTrashEndpoint(() =>
      new Response(JSON.stringify({ trashed: ['Lens/_trash/A.md'], trashed_at: 1, restore_hint: '' }), { status: 200 })
    );
    const folderDoc = renderSidebar();
    const filemetaBefore = folderDoc.getMap('filemeta_v0').size;

    await openDeleteDialog(user, 'A.md');
    expect(screen.getByText(/moves to the _trash folder/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(calls).toEqual([{ path: 'Lens/A.md' }]));
    await waitFor(() => expect(screen.queryByText('Delete A.md?')).not.toBeInTheDocument());
    expect(folderDoc.getMap('filemeta_v0').size).toBe(filemetaBefore);
  });

  it('deletes a folder through the same endpoint', async () => {
    const user = userEvent.setup();
    const calls = mockTrashEndpoint(() =>
      new Response(JSON.stringify({ trashed: ['Lens/_trash/Notes', 'Lens/_trash/A.md'], trashed_at: 1, restore_hint: '' }), { status: 200 })
    );
    renderSidebar();

    await openDeleteDialog(user, 'Notes');
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(calls).toEqual([{ path: 'Lens/Notes' }]));
  });

  it('lists the referencing documents on refusal and forces on "Delete anyway"', async () => {
    const user = userEvent.setup();
    const calls = mockTrashEndpoint((body) => {
      if (!body.force) {
        return new Response(
          JSON.stringify({
            error: 'Cannot delete Lens/A.md: 1 document outside it still links to it',
            code: 'inbound_links',
            referencing: [{ path: 'Lens/B.md', count: 2 }],
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ trashed: ['Lens/_trash/A.md'], trashed_at: 1, restore_hint: '' }), { status: 200 });
    });
    renderSidebar();

    await openDeleteDialog(user, 'A.md');
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await screen.findByText('Delete A.md anyway?');
    const list = screen.getByTestId('delete-referencing');
    expect(list).toHaveTextContent('Lens/B.md');
    expect(list).toHaveTextContent('(2 links)');
    expect(calls).toEqual([{ path: 'Lens/A.md' }]);

    await user.click(screen.getByRole('button', { name: 'Delete anyway' }));

    await waitFor(() => expect(calls).toEqual([
      { path: 'Lens/A.md' },
      { path: 'Lens/A.md', force: true },
    ]));
    await waitFor(() => expect(screen.queryByText('Delete A.md anyway?')).not.toBeInTheDocument());
  });

  it('cancelling the refusal dialog sends nothing more and resets the dialog', async () => {
    const user = userEvent.setup();
    const calls = mockTrashEndpoint(() =>
      new Response(
        JSON.stringify({ error: 'refused', code: 'inbound_links', referencing: [{ path: 'Lens/B.md', count: 1 }] }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      )
    );
    renderSidebar();

    await openDeleteDialog(user, 'A.md');
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await screen.findByText('Delete A.md anyway?');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByText('Delete A.md anyway?')).not.toBeInTheDocument());
    expect(calls).toHaveLength(1);
    // Reopening starts from the plain confirmation again.
    await openDeleteDialog(user, 'A.md');
    expect(screen.queryByTestId('delete-referencing')).not.toBeInTheDocument();
  });

  it('shows the relay error and closes the dialog on other failures', async () => {
    const user = userEvent.setup();
    mockTrashEndpoint(() =>
      new Response(JSON.stringify({ error: 'Path not found: Lens/A.md', code: 'not_found' }), { status: 404 })
    );
    renderSidebar();

    await openDeleteDialog(user, 'A.md');
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Path not found: Lens/A.md');
    expect(screen.queryByText('Delete A.md?')).not.toBeInTheDocument();
  });
});
