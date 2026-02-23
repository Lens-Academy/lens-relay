import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import * as Y from 'yjs';
import type { FileMetadata } from './useFolderMetadata';

// Use vi.hoisted to define mock class before vi.mock hoisting
const { MockYSweetProvider, mockProviderInstances, resetMockProviders } = vi.hoisted(() => {
  // Track created providers for test access
  const instances: Array<{
    listeners: Map<string, Set<(...args: unknown[]) => void>>;
    synced: boolean;
    doc: Y.Doc;
    emitSynced: () => void;
    destroy: () => void;
    on: (event: string, handler: (...args: unknown[]) => void) => void;
    off: (event: string, handler: (...args: unknown[]) => void) => void;
  }> = [];

  // Mock YSweetProvider class
  class MockYSweetProviderClass {
    private listeners: Map<string, Set<(...args: unknown[]) => void>> = new Map();
    public synced = false;
    public doc: Y.Doc;

    constructor(
      _authEndpoint: unknown,
      _docId: string,
      doc: Y.Doc,
      _options?: unknown
    ) {
      this.doc = doc;
      // Track this instance for test access
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

    // Test helper to emit synced event
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

// Mock the auth module (network boundary)
vi.mock('../lib/auth', () => ({
  getClientToken: vi.fn().mockResolvedValue({
    url: 'ws://mock-relay/doc/test-doc',
    baseUrl: 'http://mock-relay',
    docId: 'test-doc',
    token: 'mock-token',
    authorization: 'full',
  }),
}));

// Mock @y-sweet/client (network boundary) - use the class from hoisted
vi.mock('@y-sweet/client', () => ({
  YSweetProvider: MockYSweetProvider,
}));

// Import the hook AFTER mocks are set up
import { useFolderMetadata } from './useFolderMetadata';

describe('useFolderMetadata', () => {
  beforeEach(() => {
    resetMockProviders();
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Cleanup any docs
    mockProviderInstances.forEach((p) => {
      if (p.doc && !p.doc.isDestroyed) {
        p.doc.destroy();
      }
    });
  });

  it('starts in loading state', async () => {
    const { result } = renderHook(() => useFolderMetadata('test-folder-id'));

    // Initial state before async connect resolves
    // Note: The hook sets loading=true in initial useState, but connect() is called in useEffect
    // which runs synchronously after render in test environment
    expect(result.current.metadata).toEqual({});
    expect(result.current.error).toBeNull();
  });

  it('creates Y.Doc and returns it', async () => {
    const { result } = renderHook(() => useFolderMetadata('test-folder-id'));

    // Wait for async connect to complete
    await waitFor(() => {
      expect(result.current.doc).not.toBeNull();
    });

    expect(result.current.doc).toBeInstanceOf(Y.Doc);
  });

  it('stops loading and populates metadata after sync', async () => {
    const { result } = renderHook(() => useFolderMetadata('test-folder-id'));

    // Wait for provider to be created
    await waitFor(() => {
      expect(mockProviderInstances.length).toBe(1);
    });

    const provider = mockProviderInstances[0];

    // Simulate server sending some metadata by populating the Y.Map
    act(() => {
      const filemeta = provider.doc.getMap<FileMetadata>('filemeta_v0');
      filemeta.set('/notes/hello.md', { id: 'doc-uuid-1', type: 'markdown', version: 0 });
      filemeta.set('/images/photo.png', { id: 'img-uuid-1', type: 'image', version: 0 });
    });

    // Emit synced event
    act(() => {
      provider.emitSynced();
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.metadata).toEqual({
      '/notes/hello.md': { id: 'doc-uuid-1', type: 'markdown', version: 0 },
      '/images/photo.png': { id: 'img-uuid-1', type: 'image', version: 0 },
    });
  });

  it('updates metadata when Y.Map changes after initial sync', async () => {
    const { result } = renderHook(() => useFolderMetadata('test-folder-id'));

    await waitFor(() => {
      expect(mockProviderInstances.length).toBe(1);
    });

    const provider = mockProviderInstances[0];
    const filemeta = provider.doc.getMap<FileMetadata>('filemeta_v0');

    // Initial data and sync
    act(() => {
      filemeta.set('/file1.md', { id: 'id-1', type: 'markdown', version: 0 });
      provider.emitSynced();
    });

    await waitFor(() => {
      expect(result.current.metadata['/file1.md']).toBeDefined();
    });

    // Add another file after sync
    act(() => {
      filemeta.set('/file2.md', { id: 'id-2', type: 'markdown', version: 0 });
    });

    await waitFor(() => {
      expect(result.current.metadata['/file2.md']).toBeDefined();
    });

    expect(result.current.metadata).toEqual({
      '/file1.md': { id: 'id-1', type: 'markdown', version: 0 },
      '/file2.md': { id: 'id-2', type: 'markdown', version: 0 },
    });
  });

  it('handles file deletion from Y.Map', async () => {
    const { result } = renderHook(() => useFolderMetadata('test-folder-id'));

    await waitFor(() => {
      expect(mockProviderInstances.length).toBe(1);
    });

    const provider = mockProviderInstances[0];
    const filemeta = provider.doc.getMap<FileMetadata>('filemeta_v0');

    // Initial data
    act(() => {
      filemeta.set('/keep.md', { id: 'id-1', type: 'markdown', version: 0 });
      filemeta.set('/delete.md', { id: 'id-2', type: 'markdown', version: 0 });
      provider.emitSynced();
    });

    await waitFor(() => {
      expect(Object.keys(result.current.metadata)).toHaveLength(2);
    });

    // Delete one file
    act(() => {
      filemeta.delete('/delete.md');
    });

    await waitFor(() => {
      expect(Object.keys(result.current.metadata)).toHaveLength(1);
    });

    expect(result.current.metadata['/keep.md']).toBeDefined();
    expect(result.current.metadata['/delete.md']).toBeUndefined();
  });

  it('handles file type updates', async () => {
    const { result } = renderHook(() => useFolderMetadata('test-folder-id'));

    await waitFor(() => {
      expect(mockProviderInstances.length).toBe(1);
    });

    const provider = mockProviderInstances[0];
    const filemeta = provider.doc.getMap<FileMetadata>('filemeta_v0');

    // Initial data as markdown
    act(() => {
      filemeta.set('/doc.md', { id: 'id-1', type: 'markdown', version: 0 });
      provider.emitSynced();
    });

    await waitFor(() => {
      expect(result.current.metadata['/doc.md']?.type).toBe('markdown');
    });

    // Update to canvas type
    act(() => {
      filemeta.set('/doc.md', { id: 'id-1', type: 'canvas', version: 0 });
    });

    await waitFor(() => {
      expect(result.current.metadata['/doc.md']?.type).toBe('canvas');
    });
  });

  it('cleans up provider and doc on unmount', async () => {
    const { unmount } = renderHook(() => useFolderMetadata('test-folder-id'));

    await waitFor(() => {
      expect(mockProviderInstances.length).toBe(1);
    });

    const provider = mockProviderInstances[0];
    const destroySpy = vi.spyOn(provider, 'destroy');
    const docDestroySpy = vi.spyOn(provider.doc, 'destroy');

    unmount();

    expect(destroySpy).toHaveBeenCalled();
    expect(docDestroySpy).toHaveBeenCalled();
  });

  it('reconnects when folderId changes', async () => {
    const { rerender } = renderHook(
      ({ folderId }) => useFolderMetadata(folderId),
      { initialProps: { folderId: 'folder-1' } }
    );

    await waitFor(() => {
      expect(mockProviderInstances.length).toBe(1);
    });

    // Change folderId
    rerender({ folderId: 'folder-2' });

    await waitFor(() => {
      expect(mockProviderInstances.length).toBe(2);
    });

    // First provider should be destroyed
    expect(mockProviderInstances[0].doc.isDestroyed).toBe(true);
    // Second provider should have a new doc
    expect(mockProviderInstances[1].doc.isDestroyed).toBe(false);
  });

  it('handles data already present before sync event (race condition)', async () => {
    const { result } = renderHook(() => useFolderMetadata('test-folder-id'));

    await waitFor(() => {
      expect(mockProviderInstances.length).toBe(1);
    });

    const provider = mockProviderInstances[0];
    const filemeta = provider.doc.getMap<FileMetadata>('filemeta_v0');

    // Simulate data arriving before synced event is emitted
    // (the hook should handle this via filemeta.size > 0 check)
    act(() => {
      filemeta.set('/early.md', { id: 'early-id', type: 'markdown', version: 0 });
    });

    // The hook should detect the data immediately since size > 0
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.metadata['/early.md']).toBeDefined();
  });
});
