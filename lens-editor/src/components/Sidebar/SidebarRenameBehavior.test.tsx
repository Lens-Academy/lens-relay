/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import * as Y from 'yjs';
import { Sidebar } from './Sidebar';
import { NavigationContext } from '../../contexts/NavigationContext';
import type { FolderMetadata } from '../../hooks/useFolderMetadata';

vi.mock('../../App', () => ({
  RELAY_ID: 'cb696037-0f72-4e93-8717-4e433129d789',
}));

vi.mock('../../hooks/useResolvedDocId', () => ({
  useResolvedDocId: (compoundId: string) => compoundId || null,
}));

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('Sidebar file tree rename behavior', () => {
  it('renames timestamps JSON files without forcing a markdown extension', async () => {
    const user = userEvent.setup();
    const docId = '22222222-2222-4222-8222-222222222222';
    const oldPath = 'Lens/source.timestamps.json';
    const newPath = 'Lens/renamed.timestamps.json';
    const serverPaths = new Map<string, string>([[oldPath, docId]]);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}'));

      if (
        url === '/api/relay/move' &&
        body.path === oldPath &&
        body.new_path === '/renamed.timestamps.json'
      ) {
        const movedDocId = serverPaths.get(oldPath);
        if (movedDocId) {
          serverPaths.delete(oldPath);
          serverPaths.set(newPath, movedDocId);
        }
        return new Response(JSON.stringify({ links_rewritten: 0 }), { status: 200 });
      }

      return new Response(`Move request did not rename timestamps JSON file: ${JSON.stringify(body)}`, { status: 404 });
    });

    const metadata: FolderMetadata = {
      '/Lens/source.timestamps.json': { id: docId, type: 'file', version: 0 },
    };

    render(
      <MemoryRouter initialEntries={['/some-doc']}>
        <NavigationContext.Provider
          value={{
            metadata,
            folderDocs: new Map([['Lens', new Y.Doc()]]),
            folderNames: ['Lens'],
            errors: new Map(),
            onNavigate: vi.fn(),
            justCreatedRef: { current: false },
          }}
        >
          <Sidebar />
        </NavigationContext.Provider>
      </MemoryRouter>
    );

    const fileRow = screen
      .getByText('source.timestamps.json')
      .closest('[class*="cursor-pointer"]') as HTMLElement;

    fireEvent.contextMenu(fileRow);
    await user.click(await screen.findByText('Rename'));

    const input = await screen.findByDisplayValue('source.timestamps.json');
    await new Promise(resolve => setTimeout(resolve, 75));
    await user.clear(input);
    await user.type(input, 'renamed.timestamps.json{Enter}');

    await waitFor(() => {
      expect(serverPaths.get(newPath)).toBe(docId);
    });
    expect(serverPaths.has(oldPath)).toBe(false);
  });
});
