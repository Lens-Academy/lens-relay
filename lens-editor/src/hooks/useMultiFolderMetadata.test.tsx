// src/hooks/useMultiFolderMetadata.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import * as Y from 'yjs';
import type { FileMetadata } from './useFolderMetadata';

// Use vi.hoisted to define mock class before vi.mock hoisting
const { MockYSweetProvider, mockProviderInstances, resetMockProviders } = vi.hoisted(() => {
  const instances: Array<{
    listeners: Map<string, Set<(...args: unknown[]) => void>>;
    synced: boolean;
    doc: Y.Doc;
    folderId: string;
    emitSynced: () => void;
    destroy: () => void;
    on: (event: string, handler: (...args: unknown[]) => void) => void;
    off: (event: string, handler: (...args: unknown[]) => void) => void;
  }> = [];

  class MockYSweetProviderClass {
    private listeners: Map<string, Set<(...args: unknown[]) => void>> = new Map();
    public synced = false;
    public doc: Y.Doc;
    public folderId: string;

    constructor(
      _authEndpoint: unknown,
      docId: string,
      doc: Y.Doc,
      _options?: unknown
    ) {
      this.doc = doc;
      // Extract folder ID from docId (format: "local-{folderId}" or "{relayId}-{folderId}")
      this.folderId = docId.split('-').slice(1).join('-');
      instances.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => void) {
      if (!this.listeners.has(event)) {
        this.listeners.set(event, new Set());
      }
      this.listeners.get(event)!.add(handler);
    }

    off(event: string, handler: (...args: unknown[]) => void) {
      this.listeners.get(event)?.delete(handler);
    }

    emitSynced() {
      this.synced = true;
      this.listeners.get('synced')?.forEach((h) => h());
    }

    destroy() {
      this.listeners.clear();
    }
  }

  return {
    MockYSweetProvider: MockYSweetProviderClass,
    mockProviderInstances: instances,
    resetMockProviders: () => {
      instances.length = 0;
    },
  };
});

// Mock the auth module
vi.mock('../lib/auth', () => ({
  getClientToken: vi.fn().mockResolvedValue({
    url: 'ws://mock-relay/doc/test-doc',
    baseUrl: 'http://mock-relay',
    docId: 'test-doc',
    token: 'mock-token',
    authorization: 'full',
  }),
}));

// Mock @y-sweet/client
vi.mock('@y-sweet/client', () => ({
  YSweetProvider: MockYSweetProvider,
}));

// Import the hook AFTER mocks are set up
import { useMultiFolderMetadata } from './useMultiFolderMetadata';

describe('useMultiFolderMetadata', () => {
  beforeEach(() => {
    resetMockProviders();
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockProviderInstances.forEach((p) => {
      if (p.doc && !p.doc.isDestroyed) {
        p.doc.destroy();
      }
    });
  });

  it('connects to multiple folder docs', async () => {
    const { result } = renderHook(() => useMultiFolderMetadata([
      { id: 'folder-1', name: 'Lens' },
      { id: 'folder-2', name: 'Lens Edu' }
    ]));

    await waitFor(() => {
      expect(mockProviderInstances.length).toBe(2);
    });
  });

  it('merges metadata from both folders with prefixes', async () => {
    const { result } = renderHook(() => useMultiFolderMetadata([
      { id: 'folder-1', name: 'Lens' },
      { id: 'folder-2', name: 'Lens Edu' }
    ]));

    await waitFor(() => expect(mockProviderInstances.length).toBe(2));

    // Populate both mock providers with data
    act(() => {
      mockProviderInstances[0].doc.getMap<FileMetadata>('filemeta_v0').set('/doc.md', { id: 'uuid1', type: 'markdown', version: 0 });
      mockProviderInstances[1].doc.getMap<FileMetadata>('filemeta_v0').set('/syllabus.md', { id: 'uuid2', type: 'markdown', version: 0 });
      mockProviderInstances.forEach(p => p.emitSynced());
    });

    await waitFor(() => {
      expect(result.current.metadata['/Lens/doc.md']).toBeDefined();
      expect(result.current.metadata['/Lens Edu/syllabus.md']).toBeDefined();
    });
  });

  it('returns folderDocs map keyed by folder NAME for CRUD routing', async () => {
    const { result } = renderHook(() => useMultiFolderMetadata([
      { id: 'folder-1', name: 'Lens' },
      { id: 'folder-2', name: 'Lens Edu' }
    ]));

    await waitFor(() => {
      // KEY: Map is keyed by folder NAME, not folder ID
      expect(result.current.folderDocs.get('Lens')).toBeInstanceOf(Y.Doc);
      expect(result.current.folderDocs.get('Lens Edu')).toBeInstanceOf(Y.Doc);
    });
  });

  it('cleans up all providers on unmount', async () => {
    const { unmount } = renderHook(() => useMultiFolderMetadata([
      { id: 'folder-1', name: 'Lens' },
      { id: 'folder-2', name: 'Lens Edu' }
    ]));

    await waitFor(() => expect(mockProviderInstances.length).toBe(2));

    const destroySpies = mockProviderInstances.map(p => vi.spyOn(p, 'destroy'));

    unmount();

    destroySpies.forEach(spy => {
      expect(spy).toHaveBeenCalled();
    });
  });

  it('handles partial sync failure - shows working folder, reports error', async () => {
    const { result } = renderHook(() => useMultiFolderMetadata([
      { id: 'folder-1', name: 'Lens' },
      { id: 'folder-2', name: 'Lens Edu' }
    ]));

    await waitFor(() => expect(mockProviderInstances.length).toBe(2));

    // First folder syncs successfully with data
    act(() => {
      mockProviderInstances[0].doc.getMap('filemeta_v0').set('/doc.md', { id: 'uuid1', type: 'markdown', version: 0 });
      mockProviderInstances[0].emitSynced();
    });

    // Second folder fails to connect
    act(() => {
      const errorEvent = mockProviderInstances[1].listeners.get('connection-error');
      errorEvent?.forEach(handler => handler(new Error('Connection refused')));
    });

    await waitFor(() => {
      // Loading should complete (both folders finished, one way or another)
      expect(result.current.loading).toBe(false);
    });

    // Should have metadata from successful folder
    expect(result.current.metadata['/Lens/doc.md']).toBeDefined();

    // Should have error for failed folder
    expect(result.current.errors.get('Lens Edu')).toBeInstanceOf(Error);
    expect(result.current.errors.get('Lens Edu')?.message).toBe('Connection refused');

    // Should NOT have error for successful folder
    expect(result.current.errors.get('Lens')).toBeUndefined();
  });
});
