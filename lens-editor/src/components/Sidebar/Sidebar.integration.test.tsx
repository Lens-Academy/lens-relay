/**
 * Integration test verifying both folders appear in the sidebar.
 * Requires local Y-Sweet: npx y-sweet serve --port 8090
 *
 * Run: npm run test:integration:sidebar
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';
import { Sidebar } from './Sidebar';
import { NavigationContext } from '../../contexts/NavigationContext';
import { useMultiFolderMetadata, type FolderConfig } from '../../hooks/useMultiFolderMetadata';

// Mock RELAY_ID to use local Y-Sweet prefix
vi.mock('../../App', () => ({
  RELAY_ID: 'a0000000-0000-4000-8000-000000000000',
}));

const YSWEET_URL = 'http://localhost:8090';

// Test folder configuration (matches setup-local-ysweet.mjs)
const TEST_FOLDERS: FolderConfig[] = [
  { id: 'test-folder', name: 'Lens' },
  { id: 'test-folder-edu', name: 'Lens Edu' },
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
    <NavigationContext.Provider value={{ metadata, folderDocs, folderNames, errors, onNavigate: onSelectDocument }}>
      <Sidebar activeDocId="a0000000-0000-4000-8000-000000000000-c0000001-0000-4000-8000-000000000001" onSelectDocument={onSelectDocument} />
    </NavigationContext.Provider>
  );
}

describe('Sidebar Multi-Folder Integration', () => {
  beforeAll(async () => {
    const serverUp = await checkServer();
    if (!serverUp) {
      throw new Error(
        'Local Y-Sweet not running! Start with: npx y-sweet serve --port 8090\n' +
        'Then run: npm run local:setup'
      );
    }
  });

  afterEach(() => {
    cleanup();
  });

  it('shows both folders in the file tree', async () => {
    const handleSelect = vi.fn();

    const { container } = render(<TestApp onSelectDocument={handleSelect} />);

    // Wait for real network sync (longer timeout)
    await waitFor(() => {
      expect(container.textContent).toContain('Lens');
      expect(container.textContent).toContain('Lens Edu');
    }, { timeout: 10000 });

    // Verify documents from both folders appear
    // "Welcome" is in Lens folder, "Course Notes" is in Lens Edu folder
    expect(container.textContent).toContain('Welcome');
    expect(container.textContent).toContain('Course Notes');
  });
});
