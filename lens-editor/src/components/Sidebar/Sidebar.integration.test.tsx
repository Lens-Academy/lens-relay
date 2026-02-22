/**
 * Integration test verifying both folders appear in the sidebar.
 * Requires local relay-server running (auto-detected port from workspace).
 *
 * Run: npm run test:integration:sidebar
 *
 * @vitest-environment happy-dom
 */
import path from 'path';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { NavigationContext } from '../../contexts/NavigationContext';
import { useMultiFolderMetadata, type FolderConfig } from '../../hooks/useMultiFolderMetadata';

// Auto-detect relay port from workspace directory name
const projectDir = path.basename(path.resolve(import.meta.dirname, '../../..'));
const parentDir = path.basename(path.resolve(import.meta.dirname, '../../../..'));
const workspaceMatch = projectDir.match(/-ws(\d+)$/) || parentDir.match(/^ws(\d+)$/);
const wsNum = workspaceMatch ? parseInt(workspaceMatch[1], 10) : 1;
const defaultPort = 8090 + (wsNum - 1) * 100;
const YSWEET_URL = process.env.RELAY_URL || `http://localhost:${defaultPort}`;

const TEST_RELAY_ID = 'a0000000-0000-4000-8000-000000000000';

// Mock RELAY_ID to use local relay prefix
vi.mock('../../App', () => ({
  RELAY_ID: 'a0000000-0000-4000-8000-000000000000',
}));

// Mock auth to hit relay server directly (bypasses Vite proxy)
vi.mock('../../lib/auth', () => {
  // Inline port detection (can't reference outer scope from hoisted vi.mock)
  const _path = require('path');
  const _dir = _path.basename(_path.resolve(__dirname, '../../..'));
  const _m = _dir.match(/-ws(\d+)$/);
  const _port = 8090 + ((_m ? parseInt(_m[1], 10) : 1) - 1) * 100;
  const _url = process.env.RELAY_URL || `http://localhost:${_port}`;

  return {
    getClientToken: async (docId: string) => {
      const response = await fetch(`${_url}/doc/${docId}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authorization: 'full' }),
      });
      if (!response.ok) {
        throw new Error(`Auth failed: ${response.status}`);
      }
      const data = await response.json();
      return { url: data.url, baseUrl: _url, docId: data.docId, authorization: 'full' };
    },
  };
});

// Force useMultiFolderMetadata to use local RELAY_ID by setting env before it loads
vi.mock('../../hooks/useMultiFolderMetadata', async () => {
  import.meta.env.VITE_LOCAL_RELAY = 'true';
  return await vi.importActual<typeof import('../../hooks/useMultiFolderMetadata')>('../../hooks/useMultiFolderMetadata');
});

// Mock useResolvedDocId — this test doesn't test doc resolution
vi.mock('../../hooks/useResolvedDocId', () => ({
  useResolvedDocId: (compoundId: string) => compoundId || null,
}));

// Test folder configuration (matches setup-local-relay.mjs)
const TEST_FOLDERS: FolderConfig[] = [
  { id: 'b0000001-0000-4000-8000-000000000001', name: 'Relay Folder 1' },
  { id: 'b0000002-0000-4000-8000-000000000002', name: 'Relay Folder 2' },
];

async function checkServer(): Promise<boolean> {
  try {
    const response = await fetch(`${YSWEET_URL}/`);
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

/**
 * Test wrapper that uses REAL useMultiFolderMetadata hook.
 * This ensures we're testing real behavior, not mock behavior.
 */
function TestApp({ onSelectDocument }: { onSelectDocument: (id: string) => void }) {
  const { metadata, folderDocs, errors } = useMultiFolderMetadata(TEST_FOLDERS);
  const folderNames = TEST_FOLDERS.map(f => f.name);

  return (
    <MemoryRouter initialEntries={['/c0000001']}>
      <NavigationContext.Provider value={{ metadata, folderDocs, folderNames, errors, onNavigate: onSelectDocument, justCreatedRef: { current: false } }}>
        <Sidebar />
      </NavigationContext.Provider>
    </MemoryRouter>
  );
}

describe('Sidebar Multi-Folder Integration', () => {
  beforeAll(async () => {
    const serverUp = await checkServer();
    if (!serverUp) {
      throw new Error(
        `Local relay-server not running at ${YSWEET_URL}.\n` +
        'Start with: cargo run --bin relay -- serve --port 8090\n' +
        'Then run: cd lens-editor && npm run relay:setup'
      );
    }
  });

  afterEach(() => {
    cleanup();
  });

  it('shows both folders in the file tree', { timeout: 15000 }, async () => {
    const handleSelect = vi.fn();

    const { container } = render(<TestApp onSelectDocument={handleSelect} />);

    // Wait for real network sync — both folder names appear once Y.Doc metadata syncs
    await waitFor(() => {
      expect(container.textContent).toContain('Relay Folder 1');
      expect(container.textContent).toContain('Relay Folder 2');
    }, { timeout: 10000 });
  });
});
