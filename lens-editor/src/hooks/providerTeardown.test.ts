/**
 * @vitest-environment happy-dom
 *
 * Tests teardownProvider against the REAL YSweetProvider (no provider mock):
 * a fake WebSocket class is injected via the provider's WebSocketPolyfill
 * option, so the provider's actual reconnect machinery runs and the tests
 * fail if a future @y-sweet/client changes its teardown semantics.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import { YSweetProvider } from '@y-sweet/client';
import { teardownProvider } from './useDocConnection';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  url: string;
  binaryType = 'arraybuffer';
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  send() {}

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    // Browsers fire the close event asynchronously; mimic that, because the
    // zombie-reconnect bug lives exactly in this handler firing after close()
    setTimeout(() => this.onclose?.({ code: 1000 }), 0);
  }
}

function makeProvider(): { provider: YSweetProvider; doc: Y.Doc } {
  const doc = new Y.Doc();
  const provider = new YSweetProvider(
    // initialClientToken skips the auth fetch entirely
    async () => ({ url: 'ws://localhost:9', docId: 'test-doc', token: 't' }),
    'test-doc',
    doc,
    {
      connect: true,
      showDebuggerLink: false,
      WebSocketPolyfill: FakeWebSocket as unknown as typeof WebSocket,
      initialClientToken: { url: 'ws://localhost:9', docId: 'test-doc', token: 't' },
    },
  );
  return { provider, doc };
}

async function settle(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('YSweetProvider teardown', () => {
  // Documents the upstream bug this module works around (@y-sweet/client
  // 0.9.1): destroy() closes the socket with onclose still attached, and the
  // close handler restarts the reconnect loop. If this test ever FAILS after
  // a dependency bump, upstream fixed it and teardownProvider can be retired.
  it('control: plain destroy() leaves a reconnecting zombie (upstream bug)', async () => {
    const { provider, doc } = makeProvider();
    await settle(50);
    expect(FakeWebSocket.instances.length).toBe(1);

    provider.destroy();
    // Backoff after the close-triggered error is ~500ms; give it a few cycles
    await settle(5000);

    expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
    doc.destroy();
  });

  // Prevents: every bulk-accepted file leaving an immortal reconnecting
  // provider in the tab (review UI fast for ~50 files, then crawling; relay
  // flooded with stale awareness clients; edits stuck behind zombie churn)
  it('teardownProvider stops all reconnect attempts for good', async () => {
    const { provider, doc } = makeProvider();
    await settle(50);
    expect(FakeWebSocket.instances.length).toBe(1);

    teardownProvider(provider);
    await settle(30_000);

    expect(FakeWebSocket.instances.length).toBe(1);
    expect(FakeWebSocket.instances[0].readyState).toBe(FakeWebSocket.CLOSED);
    expect(provider.status).toBe('offline');
    doc.destroy();
  });

  // Prevents: revival paths that bypass the socket handlers — the provider's
  // heartbeat/connection-timeout timers call connect() directly a few seconds
  // after a CONNECTED provider is torn down (handler-nulling alone misses this)
  it('teardown survives stray timers and direct connect() calls', async () => {
    const { provider, doc } = makeProvider();
    await settle(50);
    expect(FakeWebSocket.instances.length).toBe(1);

    // Simulate the connected-case leftovers: a pending heartbeat cycle that
    // would fire connect() after teardown
    const p = provider as unknown as {
      heartbeatHandle?: ReturnType<typeof setTimeout> | null;
      connect: () => Promise<void>;
    };
    const realConnect = p.connect.bind(provider);
    p.heartbeatHandle = setTimeout(() => { void realConnect(); }, 3000);

    teardownProvider(provider);
    // Even a direct connect() call (any missed revival path) must be inert
    await p.connect();
    await settle(30_000);

    expect(FakeWebSocket.instances.length).toBe(1);
    expect(provider.status).toBe('offline');
    doc.destroy();
  });
});
