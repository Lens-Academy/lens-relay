import { useRef, useCallback } from 'react';
import * as Y from 'yjs';
import { EVENT_LOCAL_CHANGES, YSweetProvider } from '@y-sweet/client';
import { getClientToken } from '../lib/auth';

export interface DocConnection {
  doc: Y.Doc;
  provider: YSweetProvider;
}

// Connecting is one round trip; syncing pending edits may span a provider
// reconnect cycle (backoff + resync), so it gets the longer budget.
const CONNECT_TIMEOUT_MS = 15000;
const SYNC_TIMEOUT_MS = 30000;

/**
 * Wait until the provider has no unacknowledged local changes.
 *
 * Transient connection drops are NOT treated as failures: the provider
 * reconnects with backoff on its own and re-syncs pending local changes, so
 * the only unrecoverable outcome is the timeout. Rejecting on a transient
 * error status would discard edits that were about to sync.
 */
export function waitForProviderSynced(provider: YSweetProvider, timeoutMs = SYNC_TIMEOUT_MS): Promise<void> {
  if (!provider.hasLocalChanges) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for document changes to sync'));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      provider.off(EVENT_LOCAL_CHANGES, handleLocalChanges);
    };

    const handleLocalChanges = (hasLocalChanges: boolean) => {
      if (!hasLocalChanges) {
        cleanup();
        resolve();
      }
    };

    provider.on(EVENT_LOCAL_CHANGES, handleLocalChanges);
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

    try {
      await new Promise<void>((resolve, reject) => {
        // 'connection-error' fires on transient errors too (the provider
        // retries by itself), so it only feeds the timeout message instead of
        // rejecting outright.
        let lastError: unknown = null;
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`Connection timeout${lastError ? ` (last error: ${lastError})` : ''}`));
        }, CONNECT_TIMEOUT_MS);
        const onSynced = () => { cleanup(); resolve(); };
        const onError = (err: unknown) => { lastError = err; };
        const cleanup = () => {
          clearTimeout(timeout);
          provider.off('synced', onSynced);
          provider.off('connection-error', onError);
        };
        provider.on('synced', onSynced);
        provider.on('connection-error', onError);
      });
    } catch (err) {
      // Without this the provider keeps reconnecting in the background forever
      provider.destroy();
      doc.destroy();
      throw err;
    }

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
