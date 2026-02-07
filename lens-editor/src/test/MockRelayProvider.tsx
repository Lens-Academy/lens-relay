import React, { useState, createContext, useContext } from 'react';
import * as Y from 'yjs';
import type { FolderMetadata } from '../hooks/useFolderMetadata';

// Context for Y.Doc access in tests
export const YDocContext = createContext<Y.Doc | null>(null);

// Hook to access the Y.Doc in tests
export function useYDoc(): Y.Doc | null {
  return useContext(YDocContext);
}

interface MockRelayProviderProps {
  fixture: Record<string, FolderMetadata[string]>;
  backlinks?: Record<string, string[]>;
  children: React.ReactNode;
}

/**
 * Mock provider that creates an in-memory Y.Doc from fixture data.
 * Use in tests to avoid real relay server connections.
 */
export function MockRelayProvider({ fixture, backlinks, children }: MockRelayProviderProps) {
  const [doc] = useState(() => createDocFromFixture(fixture, backlinks));

  return (
    <YDocContext.Provider value={doc}>
      {children}
    </YDocContext.Provider>
  );
}

/**
 * Create a standalone Y.Doc from fixture for unit tests.
 * @param fixture - Map of paths to file metadata (filemeta_v0)
 * @param backlinks - Optional map of target UUIDs to source UUID arrays (backlinks_v0)
 */
export function createDocFromFixture(
  fixture: Record<string, FolderMetadata[string]>,
  backlinks?: Record<string, string[]>
): Y.Doc {
  const doc = new Y.Doc();

  // Populate filemeta_v0
  const filemeta = doc.getMap('filemeta_v0');
  for (const [path, meta] of Object.entries(fixture)) {
    filemeta.set(path, meta);
  }

  // Populate backlinks_v0 if provided
  if (backlinks) {
    const backlinksMap = doc.getMap<string[]>('backlinks_v0');
    for (const [targetId, sourceIds] of Object.entries(backlinks)) {
      backlinksMap.set(targetId, sourceIds);
    }
  }

  return doc;
}
