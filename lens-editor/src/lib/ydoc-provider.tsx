/**
 * Local replacement for `@y-sweet/react`'s `YDocProvider` and the hooks the
 * editor uses from it.
 *
 * Why not use the library's provider: its unmount cleanup calls
 * `provider.destroy()`, which in `@y-sweet/client` 0.9.1 closes the socket,
 * fires the provider's own `onclose` handler, and that handler calls
 * `connect()` again. Every document you navigate away from therefore leaves
 * one live, reconnecting websocket behind for the lifetime of the tab. After
 * enough navigations (across all editor tabs of one browser profile) Chrome's
 * per-profile websocket cap is reached and every new document shows
 * "Loading document..." forever. See `teardownProvider` for the full teardown.
 *
 * The hook implementations mirror `@y-sweet/react` 0.9.1 so call sites are
 * unchanged apart from the import path.
 */
/* eslint-disable react-refresh/only-export-components -- provider + its hooks
   share one context, same shape as @y-sweet/react */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import * as Y from 'yjs';
import {
  createYjsProvider,
  EVENT_CONNECTION_STATUS,
  type AuthEndpoint,
  type YSweetProvider,
  type YSweetStatus,
} from '@y-sweet/client';
import type { ClientToken } from '@y-sweet/sdk';
import { teardownProvider } from '../hooks/useDocConnection';

interface YjsContextValue {
  doc: Y.Doc;
  provider: YSweetProvider;
}

const YjsContext = createContext<YjsContextValue | null>(null);

function useYjsContext(): YjsContextValue {
  const ctx = useContext(YjsContext);
  if (!ctx) {
    throw new Error('Yjs hooks must be used within a YDocProvider');
  }
  return ctx;
}

export function useYDoc(): Y.Doc {
  return useYjsContext().doc;
}

export function useYjsProvider(): YSweetProvider {
  return useYjsContext().provider;
}

export function useConnectionStatus(): YSweetStatus {
  const { provider } = useYjsContext();
  const [status, setStatus] = useState<YSweetStatus>(provider.status);
  useEffect(() => {
    const handleStatus = (next: YSweetStatus) => setStatus(next);
    provider.on(EVENT_CONNECTION_STATUS, handleStatus);
    return () => {
      provider.off(EVENT_CONNECTION_STATUS, handleStatus);
    };
  }, [provider]);
  return status;
}

export function useAwareness() {
  return useYjsContext().provider.awareness;
}

export interface UsePresenceOptions {
  includeSelf?: boolean;
}

export function usePresence<T = Record<string, unknown>>(
  options?: UsePresenceOptions,
): Map<number, T> {
  const awareness = useAwareness();
  const [presence, setPresence] = useState<Map<number, T>>(() => new Map());
  const includeSelf = options?.includeSelf ?? false;
  useEffect(() => {
    if (!awareness) return;
    const callback = () => {
      const map = new Map<number, T>();
      awareness.getStates().forEach((state, clientID) => {
        if (!includeSelf && clientID === awareness.clientID) return;
        if (Object.keys(state).length > 0) {
          map.set(clientID, state as T);
        }
      });
      setPresence(map);
    };
    awareness.on('change', callback);
    return () => {
      awareness.off('change', callback);
    };
  }, [awareness, includeSelf]);
  return presence;
}

export interface YDocProviderProps {
  docId: string;
  authEndpoint: AuthEndpoint;
  initialClientToken?: ClientToken;
  offlineSupport?: boolean;
  showDebuggerLink?: boolean;
  warnOnClose?: boolean;
  children: ReactNode;
}

export function YDocProvider(props: YDocProviderProps) {
  const { children, docId, authEndpoint, initialClientToken } = props;
  const [ctx, setCtx] = useState<YjsContextValue | null>(null);

  useEffect(() => {
    const doc = new Y.Doc();
    const provider = createYjsProvider(doc, docId, authEndpoint, {
      initialClientToken,
      offlineSupport: props.offlineSupport,
      showDebuggerLink: props.showDebuggerLink,
      warnOnClose: props.warnOnClose,
    });
    setCtx({ doc, provider });
    return () => {
      teardownProvider(provider);
      doc.destroy();
    };
    // Mirrors @y-sweet/react: only a docId change creates a new connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  if (ctx === null) return null;
  return <YjsContext.Provider value={ctx}>{children}</YjsContext.Provider>;
}
