import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock YSweetProvider to avoid real network connections
vi.mock('@y-sweet/client', () => {
  const { Awareness } = require('y-protocols/awareness');
  return {
    YSweetProvider: vi.fn().mockImplementation(function (this: any, _auth: any, _id: any, doc: any) {
      const awareness = new Awareness(doc);
      const listeners: Record<string, Function[]> = {};
      this.awareness = awareness;
      this.destroy = vi.fn();
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

const { useDocConnection } = await import('./useDocConnection');

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
});
