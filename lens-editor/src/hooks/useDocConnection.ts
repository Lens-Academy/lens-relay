import { useRef, useCallback } from 'react';
import * as Y from 'yjs';
import { EVENT_CONNECTION_STATUS, EVENT_LOCAL_CHANGES, STATUS_ERROR, YSweetProvider } from '@y-sweet/client';
import { getClientToken } from '../lib/auth';

export interface DocConnection {
  doc: Y.Doc;
  provider: YSweetProvider;
}

export function waitForProviderSynced(provider: YSweetProvider, timeoutMs = 10000): Promise<void> {
  if (!provider.hasLocalChanges) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for document changes to sync'));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      provider.off(EVENT_LOCAL_CHANGES, handleLocalChanges);
      provider.off(EVENT_CONNECTION_STATUS, handleConnectionStatus);
    };

    const handleLocalChanges = (hasLocalChanges: boolean) => {
      if (!hasLocalChanges) {
        cleanup();
        resolve();
      }
    };

    const handleConnectionStatus = (status: string) => {
      if (status === STATUS_ERROR) {
        cleanup();
        reject(new Error('Connection lost before document changes synced'));
      }
    };

    provider.on(EVENT_LOCAL_CHANGES, handleLocalChanges);
    provider.on(EVENT_CONNECTION_STATUS, handleConnectionStatus);
  });
}

/**
 * Manages temporary Y.Doc connections for applying suggestion actions
 * from the review page (outside the normal editor context).
 */
export function useDocConnection() {
  const connections = useRef<Map<string, DocConnection>>(new Map());

  const getOrConnect = useCallback(async (docId: string): Promise<DocConnection> => {
    const existing = connections.current.get(docId);
    if (existing) return existing;

    const doc = new Y.Doc();
    const authEndpoint = () => getClientToken(docId);
    const provider = new YSweetProvider(authEndpoint, docId, doc, { connect: true });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000);
      provider.on('synced', () => { clearTimeout(timeout); resolve(); });
      provider.on('connection-error', (err: Error) => { clearTimeout(timeout); reject(err); });
    });

    const connection: DocConnection = { doc, provider };
    connections.current.set(docId, connection);
    return connection;
  }, []);

  const disconnect = useCallback((docId: string) => {
    const conn = connections.current.get(docId);
    if (conn) {
      conn.provider.destroy();
      conn.doc.destroy();
      connections.current.delete(docId);
    }
  }, []);

  const disconnectAll = useCallback(() => {
    for (const [id] of connections.current) {
      disconnect(id);
    }
  }, [disconnect]);

  return { getOrConnect, disconnect, disconnectAll };
}
