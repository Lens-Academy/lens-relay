/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import * as Y from 'yjs';
import { Sidebar } from './Sidebar';
import { AuthProvider } from '../../contexts/AuthContext';
import { NavigationContext } from '../../contexts/NavigationContext';
import type { FolderMetadata } from '../../hooks/useFolderMetadata';

const capturedFileTreeProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('../../App', () => ({
  RELAY_ID: 'cb696037-0f72-4e93-8717-4e433129d789',
}));

vi.mock('../../hooks/useResolvedDocId', () => ({
  useResolvedDocId: (compoundId: string) => compoundId || null,
}));

vi.mock('./FileTree', () => ({
  FileTree: (props: Record<string, unknown>) => {
    capturedFileTreeProps.push(props);
    return <div role="tree" />;
  },
}));

beforeEach(() => {
  capturedFileTreeProps.length = 0;
});

describe('Sidebar read-only drag behavior', () => {
  it('does not pass a drag move handler to FileTree for view-only users', () => {
    const metadata: FolderMetadata = {
      '/Lens/source.html': { id: '44444444-4444-4444-8444-444444444444', type: 'file', version: 0 },
    };

    render(
      <MemoryRouter initialEntries={['/some-doc']}>
        <AuthProvider role="view" folderUuid={null} isAllFolders>
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
        </AuthProvider>
      </MemoryRouter>
    );

    expect(capturedFileTreeProps.length).toBeGreaterThan(0);
    expect(capturedFileTreeProps.at(-1)?.onMove).toBeUndefined();
  });
});
