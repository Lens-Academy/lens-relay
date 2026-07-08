import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { EVENT_LOCAL_CHANGES } from '@y-sweet/client';
import type { YSweetProvider } from '@y-sweet/client';

// Mock YSweetProvider to avoid real network connections
vi.mock('@y-sweet/client', () => {
  const { Awareness } = require('y-protocols/awareness');
  return {
    EVENT_CONNECTION_STATUS: 'connection-status',
    EVENT_LOCAL_CHANGES: 'local-changes',
    STATUS_ERROR: 'error',
    YSweetProvider: vi.fn().mockImplementation(function (this: any, _auth: any, _id: any, doc: any) {
      const awareness = new Awareness(doc);
      const listeners: Record<string, Function[]> = {};
      this.awareness = awareness;
      this.destroy = vi.fn();
      this.disconnect = vi.fn();
      this.on = function (event: string, cb: Function) {
        (listeners[event] ??= []).push(cb);
        if (event === 'synced') setTimeout(() => cb(), 0);
      };
      this.off = function (event: string, cb: Function) {
        listeners[event] = (listeners[event] ?? []).filter(f => f !== cb);
      };
    }),
  };
});

vi.mock('../lib/auth', () => ({
  getClientToken: vi.fn().mockResolvedValue({ token: 'test' }),
}));

const { useDocConnection, waitForProviderSynced } = await import('./useDocConnection');

describe('useDocConnection', () => {
  it('getOrConnect returns { doc, provider } with awareness', async () => {
    const { result } = renderHook(() => useDocConnection());
    let connection: any;
    await act(async () => {
      connection = await result.current.getOrConnect('test-doc-id');
    });
    expect(connection).toHaveProperty('doc');
    expect(connection).toHaveProperty('provider');
    expect(connection.provider).toHaveProperty('awareness');
  });

  it('returns same connection on second call with same docId', async () => {
    const { result } = renderHook(() => useDocConnection());
    let conn1: any, conn2: any;
    await act(async () => {
      conn1 = await result.current.getOrConnect('same-id');
      conn2 = await result.current.getOrConnect('same-id');
    });
    expect(conn1.doc).toBe(conn2.doc);
    expect(conn1.provider).toBe(conn2.provider);
  });

  it('disconnect destroys provider and doc', async () => {
    const { result } = renderHook(() => useDocConnection());
    let connection: any;
    await act(async () => {
      connection = await result.current.getOrConnect('to-disconnect');
    });
    act(() => {
      result.current.disconnect('to-disconnect');
    });
    expect(connection.provider.destroy).toHaveBeenCalled();
  });

  it('waitForProviderSynced waits until local changes are acknowledged', async () => {
    type Listener = (hasLocalChanges: boolean) => void;
    const listeners: Record<string, Listener[]> = {};
    const provider = {
      hasLocalChanges: true,
      on: vi.fn((event: string, cb: Listener) => {
        (listeners[event] ??= []).push(cb);
      }),
      off: vi.fn((event: string, cb: Listener) => {
        listeners[event] = (listeners[event] ?? []).filter(f => f !== cb);
      }),
    };

    let resolved = false;
    const wait = waitForProviderSynced(provider as unknown as YSweetProvider, 1000).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(provider.on).toHaveBeenCalledWith(EVENT_LOCAL_CHANGES, expect.any(Function));

    provider.hasLocalChanges = false;
    listeners[EVENT_LOCAL_CHANGES][0](false);
    await wait;

    expect(resolved).toBe(true);
    expect(provider.off).toHaveBeenCalledWith(EVENT_LOCAL_CHANGES, expect.any(Function));
  });
});
