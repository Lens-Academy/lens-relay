/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { NavigationContext } from '../contexts/NavigationContext';

const { RELAY_ID, mockYText, mockYDoc } = vi.hoisted(() => {
  const mockYText = {
    content: '',
    length: 0,
    toString() {
      return this.content;
    },
    observe() {},
    unobserve() {},
  };

  return {
    RELAY_ID: 'cb696037-0f72-4e93-8717-4e433129d789',
    mockYText,
    mockYDoc: {
      getText: () => mockYText,
    },
  };
});

vi.mock('../App', () => ({
  RELAY_ID,
}));

vi.mock('@y-sweet/react', () => ({
  useYDoc: () => mockYDoc,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockYText.content = '';
  mockYText.length = 0;
  localStorage.clear();
});

describe('DocumentTitle', () => {
  it('renames the current note from its displayed title', async () => {
    const user = userEvent.setup();
    const { DocumentTitle } = await import('./DocumentTitle');
    const docUuid = '11111111-1111-4111-8111-111111111111';
    const serverMetadata = new Map([
      ['Lens/Projects/Old Title.md', docUuid],
    ]);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        path?: string;
        new_path?: string;
      };

      if (
        url === '/api/relay/move' &&
        body.path === 'Lens/Projects/Old Title.md' &&
        body.new_path === '/Projects/New Title.md'
      ) {
        const id = serverMetadata.get(body.path);
        if (id) {
          serverMetadata.delete(body.path);
          serverMetadata.set('Lens/Projects/New Title.md', id);
        }
        return new Response(JSON.stringify({ links_rewritten: 0 }), { status: 200 });
      }

      return new Response('Move request did not rename the note', { status: 404 });
    });

    render(
      <NavigationContext.Provider
        value={{
          metadata: {
            '/Lens/Projects/Old Title.md': {
              id: docUuid,
              type: 'markdown',
              version: 0,
            },
          },
          folderDocs: new Map([['Lens', new Y.Doc()]]),
          folderNames: ['Lens'],
          errors: new Map(),
          onNavigate: vi.fn(),
          justCreatedRef: { current: false },
        }}
      >
        <DocumentTitle currentDocId={`${RELAY_ID}-${docUuid}`} />
        <button type="button">Outside title</button>
      </NavigationContext.Provider>
    );

    const titleInput = screen.getByDisplayValue('Old Title');
    await user.click(titleInput);
    await user.clear(titleInput);
    await user.type(titleInput, 'New Title');
    await waitFor(() => expect(titleInput).toHaveValue('New Title'));
    await user.click(screen.getByRole('button', { name: 'Outside title' }));

    await waitFor(() => {
      expect(serverMetadata.get('Lens/Projects/New Title.md')).toBe(docUuid);
    });
    expect(serverMetadata.has('Lens/Projects/Old Title.md')).toBe(false);
  });
});
