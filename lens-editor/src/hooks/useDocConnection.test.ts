import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { EVENT_LOCAL_CHANGES } from '@y-sweet/client';
import type { YSweetProvider } from '@y-sweet/client';

// Mock YSweetProvider to avoid real network connections.
// mockState.autoSync controls whether providers emit 'synced' on their own;
// tests drive events manually via mockState.instances[n].emit(...).
const mockState: {
  autoSync: boolean;
  instances: Array<{
    emit: (event: string, data?: unknown) => void;
    destroy: ReturnType<typeof vi.fn>;
  }>;
} = { autoSync: true, instances: [] };

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
      this.on = function (event: string, cb: Function) {
        (listeners[event] ??= []).push(cb);
        if (event === 'synced' && mockState.autoSync) setTimeout(() => cb(), 0);
      };
      this.off = function (event: string, cb: Function) {
        listeners[event] = (listeners[event] ?? []).filter(f => f !== cb);
      };
      this.emit = function (event: string, data?: unknown) {
        for (const cb of listeners[event] ?? []) cb(data);
      };
      mockState.instances.push(this);
    }),
  };
});

vi.mock('../lib/auth', () => ({
  getClientToken: vi.fn().mockResolvedValue({ token: 'test' }),
}));

const { useDocConnection, waitForProviderSynced } = await import('./useDocConnection');

beforeEach(() => {
  mockState.autoSync = true;
  mockState.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

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

  // Prevents: a transient websocket drop mid-bulk (relay restart, Cloudflare
  // tunnel blip) rejecting the sync wait and discarding the file's edits even
  // though the provider auto-reconnects and re-syncs local changes on its own
  it('waitForProviderSynced keeps waiting through a transient error status', async () => {
    type Listener = (data: unknown) => void;
    const listeners: Record<string, Listener[]> = {};
    const provider = {
      hasLocalChanges: true,
      on: (event: string, cb: Listener) => { (listeners[event] ??= []).push(cb); },
      off: (event: string, cb: Listener) => {
        listeners[event] = (listeners[event] ?? []).filter(f => f !== cb);
      },
    };

    const wait = waitForProviderSynced(provider as unknown as YSweetProvider, 1000);
    // Transient connection error: provider reconnects and re-syncs by itself
    for (const cb of listeners['connection-status'] ?? []) cb('error');
    provider.hasLocalChanges = false;
    for (const cb of listeners['local-changes'] ?? []) cb(false);
    await expect(wait).resolves.toBeUndefined();
  });

  it('waitForProviderSynced rejects when changes never sync within the timeout', async () => {
    vi.useFakeTimers();
    const provider = {
      hasLocalChanges: true,
      on: vi.fn(),
      off: vi.fn(),
    };
    const wait = waitForProviderSynced(provider as unknown as YSweetProvider, 5000);
    const assertion = expect(wait).rejects.toThrow(/Timed out/);
    await vi.advanceTimersByTimeAsync(5001);
    await assertion;
  });

  // Prevents: the first transient connection error failing a connect that the
  // provider itself retries and completes moments later
  it('getOrConnect survives a transient connection-error before synced', async () => {
    mockState.autoSync = false;
    const { result } = renderHook(() => useDocConnection());
    let connection: any;
    await act(async () => {
      const pending = result.current.getOrConnect('doc-blip');
      const p = mockState.instances[0];
      p.emit('connection-error', new Error('ws blip'));
      p.emit('synced');
      connection = await pending;
    });
    expect(connection.provider).toBe(mockState.instances[0]);
    expect(mockState.instances[0].destroy).not.toHaveBeenCalled();
  });

  // Prevents: zombie providers reconnecting forever (leaked websockets and
  // awareness noise) after a bulk connect gives up
  it('getOrConnect destroys the provider when the connection times out', async () => {
    vi.useFakeTimers();
    mockState.autoSync = false;
    const { result } = renderHook(() => useDocConnection());
    const pending = result.current.getOrConnect('doc-timeout');
    const assertion = expect(pending).rejects.toThrow(/Connection timeout/);
    await vi.advanceTimersByTimeAsync(15001);
    await assertion;
    expect(mockState.instances[0].destroy).toHaveBeenCalled();
  });

  it('getOrConnect includes the last connection error in the timeout message', async () => {
    vi.useFakeTimers();
    mockState.autoSync = false;
    const { result } = renderHook(() => useDocConnection());
    const pending = result.current.getOrConnect('doc-autherr');
    mockState.instances[0].emit('connection-error', new Error('auth failed'));
    const assertion = expect(pending).rejects.toThrow(/auth failed/);
    await vi.advanceTimersByTimeAsync(15001);
    await assertion;
  });
});
