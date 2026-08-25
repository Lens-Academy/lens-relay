import { describe, it, expect, vi } from 'vitest';
import { render, act } from '@testing-library/react';

// Fake @y-sweet/client whose provider behaves like 0.9.1 on destroy(): closing
// the socket fires onclose, which calls connect() and opens a replacement.
vi.mock('@y-sweet/client', async () => {
  const { Awareness } = await import('y-protocols/awareness');
  class FakeSocket {
    onopen: (() => void) | null = null;
    onmessage: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    close() {
      this.onclose?.();
    }
  }
  class FakeProvider {
    status = 'connected';
    awareness: unknown;
    websocket: FakeSocket | null = null;
    heartbeatHandle: ReturnType<typeof setTimeout> | null = null;
    connectionTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
    sockets: FakeSocket[] = [];
    connectCalls = 0;
    constructor(doc: unknown) {
      this.awareness = new Awareness(doc);
      void this.connect();
    }
    async connect() {
      this.connectCalls++;
      const ws = new FakeSocket();
      ws.onclose = () => void this.connect();
      this.websocket = ws;
      this.sockets.push(ws);
    }
    disconnect() {
      this.status = 'offline';
      this.websocket?.close();
    }
    destroy() {
      this.websocket?.close();
    }
    on() {}
    off() {}
  }
  const providers: FakeProvider[] = [];
  return {
    EVENT_CONNECTION_STATUS: 'connection-status',
    createYjsProvider: vi.fn((doc: unknown) => {
      const p = new FakeProvider(doc);
      providers.push(p);
      return p;
    }),
    __providers: providers,
  };
});

const client = (await import('@y-sweet/client')) as unknown as {
  __providers: Array<{ connectCalls: number; sockets: Array<{ onclose: unknown }> }>;
};
const { YDocProvider, useYDoc } = await import('./ydoc-provider');

function Child() {
  useYDoc();
  return <span>ready</span>;
}

describe('YDocProvider', () => {
  it('unmount tears the provider down without spawning a replacement socket', async () => {
    const { unmount, findByText } = render(
      <YDocProvider docId="doc-a" authEndpoint={async () => ({ url: 'ws://x', token: 't' }) as never}>
        <Child />
      </YDocProvider>,
    );
    await findByText('ready');
    const provider = client.__providers.at(-1)!;
    expect(provider.connectCalls).toBe(1);

    await act(async () => {
      unmount();
    });

    // The library's own cleanup (destroy() only) would leave connectCalls at 2
    // and a second live socket. Full teardown detaches onclose first.
    expect(provider.connectCalls).toBe(1);
    expect(provider.sockets).toHaveLength(1);
    expect(provider.sockets[0].onclose).toBeNull();
  });
});
