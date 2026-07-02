import { useRef, useCallback } from 'react';
import * as Y from 'yjs';
import { EVENT_CONNECTION_STATUS, EVENT_LOCAL_CHANGES, STATUS_ERROR, YSweetProvider } from '@y-sweet/client';
import { getClientToken } from '../lib/auth';

export interface DocConnection {
  doc: Y.Doc;
  provider: YSweetProvider;
}

/**
 * Fully tear down a YSweetProvider so it STOPS reconnecting.
 *
 * The provider auto-reconnects whenever its websocket closes: the socket's
 * onclose handler (websocketClose) unconditionally sets status=error and
 * calls connect() again, and connect() re-enters its retry loop regardless
 * of a prior disconnect(). Neither provider.destroy() nor
 * provider.disconnect() alone stops this (@y-sweet/client 0.9.1): the close
 * they trigger runs that onclose handler on the way down and kicks off a
 * fresh reconnect loop. So the socket's handlers are detached FIRST (closing
 * it can then not start another reconnect), then the provider is marked
 * offline and destroyed (removing window listeners + awareness state).
 *
 * Without this, every file in a bulk accept/reject leaves an immortal
 * reconnecting provider (plus its Y.Doc) alive in the tab; after a few dozen
 * files the tab runs dozens of backoff/reconnect loops and the review UI
 * crawls ("fast for the first ~50 files, then a pause every few edits").
 */
export function teardownProvider(provider: YSweetProvider): void {
  const ws = (provider as unknown as { websocket?: WebSocket | null }).websocket;
  if (ws) {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
  }
  provider.disconnect(); // status -> offline, closes the socket (no reconnect now)
  provider.destroy(); // removes window listeners + awareness state
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

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000);
        provider.on('synced', () => { clearTimeout(timeout); resolve(); });
        provider.on('connection-error', (err: Error) => { clearTimeout(timeout); reject(err); });
      });
    } catch (err) {
      // Connect failed/timed out — tear the provider down so it doesn't keep
      // reconnecting in the background forever (see teardownProvider).
      teardownProvider(provider);
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
      teardownProvider(conn.provider);
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
