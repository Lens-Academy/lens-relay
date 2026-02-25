import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import * as Y from 'yjs';
import { BacklinksPanel } from './BacklinksPanel';
import { NavigationContext } from '../../contexts/NavigationContext';
import type { FolderMetadata } from '../../hooks/useFolderMetadata';

// Helper to create test context matching multi-folder NavigationContextValue
function createTestContext(metadata: FolderMetadata, backlinks: Record<string, string[]>) {
  const doc = new Y.Doc();
  const backlinksMap = doc.getMap<string[]>('backlinks_v0');
  for (const [targetId, sourceIds] of Object.entries(backlinks)) {
    backlinksMap.set(targetId, sourceIds);
  }
  const folderDocs = new Map([['Test Folder', doc]]);
  return {
    metadata,
    folderDocs,
    folderNames: ['Test Folder'],
    errors: new Map(),
    onNavigate: vi.fn(),
    justCreatedRef: { current: false },
  };
}

describe('BacklinksPanel', () => {
  it('shows "No backlinks" when empty', () => {
    const ctx = createTestContext(
      { '/Note.md': { id: 'uuid-1', type: 'markdown', version: 0 } },
      {}
    );

    render(
      <NavigationContext.Provider value={ctx}>
        <BacklinksPanel currentDocId="uuid-1" />
      </NavigationContext.Provider>
    );

    expect(screen.getByText(/no backlinks/i)).toBeInTheDocument();
  });

  it('displays backlink document names', () => {
    const metadata: FolderMetadata = {
      '/Target.md': { id: 'target-uuid', type: 'markdown', version: 0 },
      '/Source1.md': { id: 'source-1', type: 'markdown', version: 0 },
      '/Folder/Source2.md': { id: 'source-2', type: 'markdown', version: 0 },
    };
    const backlinks = {
      'target-uuid': ['source-1', 'source-2'],
    };
    const ctx = createTestContext(metadata, backlinks);

    render(
      <NavigationContext.Provider value={ctx}>
        <BacklinksPanel currentDocId="target-uuid" />
      </NavigationContext.Provider>
    );

    expect(screen.getByText('Source1')).toBeInTheDocument();
    expect(screen.getByText('Source2')).toBeInTheDocument();
    expect(screen.getByText('Folder/')).toBeInTheDocument();
  });

  it('calls onNavigate with compound doc ID when clicking a backlink', () => {
    const metadata: FolderMetadata = {
      '/Target.md': { id: 'target-uuid', type: 'markdown', version: 0 },
      '/Source.md': { id: 'source-uuid', type: 'markdown', version: 0 },
    };
    const backlinks = { 'target-uuid': ['source-uuid'] };
    const ctx = createTestContext(metadata, backlinks);

    // App passes compound doc IDs: relay_id-doc_uuid
    const compoundDocId = 'a0000000-0000-4000-8000-000000000000-target-uuid';

    render(
      <NavigationContext.Provider value={ctx}>
        <BacklinksPanel currentDocId={compoundDocId} />
      </NavigationContext.Provider>
    );

    fireEvent.click(screen.getByText('Source'));

    // onNavigate should receive a compound doc ID, not a bare UUID
    expect(ctx.onNavigate).toHaveBeenCalledWith('a0000000-0000-4000-8000-000000000000-source-uuid');
  });

  it('handles missing source documents gracefully', () => {
    const metadata: FolderMetadata = {
      '/Target.md': { id: 'target-uuid', type: 'markdown', version: 0 },
      // source-uuid is NOT in metadata (deleted document)
    };
    const backlinks = { 'target-uuid': ['source-uuid'] };
    const ctx = createTestContext(metadata, backlinks);

    render(
      <NavigationContext.Provider value={ctx}>
        <BacklinksPanel currentDocId="target-uuid" />
      </NavigationContext.Provider>
    );

    // Should not crash, missing sources are filtered out
    expect(screen.queryByText(/no backlinks/i)).toBeInTheDocument();
  });

  it('resolves backlinks when currentDocId is a compound relay-uuid ID', () => {
    const metadata: FolderMetadata = {
      '/Target.md': { id: 'target-uuid', type: 'markdown', version: 0 },
      '/Source.md': { id: 'source-uuid', type: 'markdown', version: 0 },
    };
    // backlinks_v0 stores bare UUIDs as keys
    const backlinks = { 'target-uuid': ['source-uuid'] };
    const ctx = createTestContext(metadata, backlinks);

    // App passes compound doc IDs: relay_id-doc_uuid
    const compoundDocId = 'a0000000-0000-4000-8000-000000000000-target-uuid';

    render(
      <NavigationContext.Provider value={ctx}>
        <BacklinksPanel currentDocId={compoundDocId} />
      </NavigationContext.Provider>
    );

    // Should find backlinks despite compound ID format
    expect(screen.getByText('Source')).toBeInTheDocument();
  });

  it('updates reactively when backlinks_v0 Y.Map changes after mount', async () => {
    const metadata: FolderMetadata = {
      '/Target.md': { id: 'target-uuid', type: 'markdown', version: 0 },
      '/Source.md': { id: 'source-uuid', type: 'markdown', version: 0 },
    };
    // Start with no backlinks
    const doc = new Y.Doc();
    const folderDocs = new Map([['Test Folder', doc]]);
    const ctx = {
      metadata,
      folderDocs,
      folderNames: ['Test Folder'],
      errors: new Map(),
      onNavigate: vi.fn(),
      justCreatedRef: { current: false },
    };

    render(
      <NavigationContext.Provider value={ctx}>
        <BacklinksPanel currentDocId="target-uuid" />
      </NavigationContext.Provider>
    );

    // Initially no backlinks
    expect(screen.getByText(/no backlinks/i)).toBeInTheDocument();

    // Simulate server writing backlinks (like the link indexer does)
    act(() => {
      const backlinksMap = doc.getMap<string[]>('backlinks_v0');
      backlinksMap.set('target-uuid', ['source-uuid']);
    });

    // Panel should reactively show the new backlink
    await waitFor(() => {
      expect(screen.getByText('Source')).toBeInTheDocument();
    });
  });

  it('updates reactively when backlinks arrive via Y.Doc sync (server → client)', async () => {
    const metadata: FolderMetadata = {
      '/Target.md': { id: 'target-uuid', type: 'markdown', version: 0 },
      '/Source.md': { id: 'source-uuid', type: 'markdown', version: 0 },
    };

    // "Client" doc — this is what BacklinksPanel observes
    const clientDoc = new Y.Doc();
    const folderDocs = new Map([['Test Folder', clientDoc]]);
    const ctx = {
      metadata,
      folderDocs,
      folderNames: ['Test Folder'],
      errors: new Map(),
      onNavigate: vi.fn(),
      justCreatedRef: { current: false },
    };

    // "Server" doc — separate Y.Doc simulating the relay server
    const serverDoc = new Y.Doc();

    // Sync initial state (empty) from server to client
    const serverState = Y.encodeStateAsUpdate(serverDoc);
    Y.applyUpdate(clientDoc, serverState);

    render(
      <NavigationContext.Provider value={ctx}>
        <BacklinksPanel currentDocId="target-uuid" />
      </NavigationContext.Provider>
    );

    // Initially no backlinks
    expect(screen.getByText(/no backlinks/i)).toBeInTheDocument();

    // Server-side: link indexer writes backlinks_v0 (like Rust code does)
    const serverBacklinks = serverDoc.getMap('backlinks_v0');
    serverBacklinks.set('target-uuid', ['source-uuid']);

    // Sync the server update to the client (simulates WebSocket sync)
    act(() => {
      const update = Y.encodeStateAsUpdate(serverDoc);
      Y.applyUpdate(clientDoc, update);
    });

    // Panel should reactively show the new backlink
    await waitFor(() => {
      expect(screen.getByText('Source')).toBeInTheDocument();
    });
  });

  it('removes backlinks reactively when server updates backlinks_v0', async () => {
    const metadata: FolderMetadata = {
      '/Target.md': { id: 'target-uuid', type: 'markdown', version: 0 },
      '/Source1.md': { id: 'source-1', type: 'markdown', version: 0 },
      '/Source2.md': { id: 'source-2', type: 'markdown', version: 0 },
    };

    // Start with two backlinks
    const doc = new Y.Doc();
    doc.getMap<string[]>('backlinks_v0').set('target-uuid', ['source-1', 'source-2']);
    const folderDocs = new Map([['Test Folder', doc]]);
    const ctx = {
      metadata,
      folderDocs,
      folderNames: ['Test Folder'],
      errors: new Map(),
      onNavigate: vi.fn(),
      justCreatedRef: { current: false },
    };

    render(
      <NavigationContext.Provider value={ctx}>
        <BacklinksPanel currentDocId="target-uuid" />
      </NavigationContext.Provider>
    );

    expect(screen.getByText('Source1')).toBeInTheDocument();
    expect(screen.getByText('Source2')).toBeInTheDocument();

    // Server removes one source from the backlinks
    act(() => {
      doc.getMap<string[]>('backlinks_v0').set('target-uuid', ['source-1']);
    });

    await waitFor(() => {
      expect(screen.getByText('Source1')).toBeInTheDocument();
      expect(screen.queryByText('Source2')).not.toBeInTheDocument();
    });
  });

  it('opens backlink in new tab on ctrl+click', () => {
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    const metadata: FolderMetadata = {
      '/Target.md': { id: 'target-uuid', type: 'markdown' as const, version: 0 },
      '/Source.md': { id: 'source-uuid', type: 'markdown' as const, version: 0 },
    };
    const backlinks = { 'target-uuid': ['source-uuid'] };
    const ctx = createTestContext(metadata, backlinks);
    const compoundDocId = 'a0000000-0000-4000-8000-000000000000-target-uuid';

    render(
      <NavigationContext.Provider value={ctx}>
        <BacklinksPanel currentDocId={compoundDocId} />
      </NavigationContext.Provider>
    );

    fireEvent.click(screen.getByText('Source'), { ctrlKey: true });
    expect(windowOpen).toHaveBeenCalledWith(expect.stringContaining('/source-u'), '_blank');
    expect(ctx.onNavigate).not.toHaveBeenCalled();
    windowOpen.mockRestore();
  });

  it('opens backlink in new tab on middle-click', () => {
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    const metadata: FolderMetadata = {
      '/Target.md': { id: 'target-uuid', type: 'markdown' as const, version: 0 },
      '/Source.md': { id: 'source-uuid', type: 'markdown' as const, version: 0 },
    };
    const backlinks = { 'target-uuid': ['source-uuid'] };
    const ctx = createTestContext(metadata, backlinks);
    const compoundDocId = 'a0000000-0000-4000-8000-000000000000-target-uuid';

    render(
      <NavigationContext.Provider value={ctx}>
        <BacklinksPanel currentDocId={compoundDocId} />
      </NavigationContext.Provider>
    );

    fireEvent(screen.getByText('Source'), new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    expect(windowOpen).toHaveBeenCalledWith(expect.stringContaining('/source-u'), '_blank');
    expect(ctx.onNavigate).not.toHaveBeenCalled();
    windowOpen.mockRestore();
  });

  it('shows loading state when folderDocs is empty', () => {
    const ctx = {
      metadata: {},
      folderDocs: new Map(),
      folderNames: [],
      errors: new Map(),
      onNavigate: vi.fn(),
      justCreatedRef: { current: false },
    };

    render(
      <NavigationContext.Provider value={ctx}>
        <BacklinksPanel currentDocId="any-id" />
      </NavigationContext.Provider>
    );

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });
});
