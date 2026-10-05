import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as Y from 'yjs';
import {
  FLUSH_WARNING_MS,
  MAX_PARALLEL_READS,
  SNAPSHOT_TTL_MS,
  __embedDocsTesting,
  cachedSnapshot,
  closeLive,
  isLive,
  onSnapshot,
  onUnsaved,
  openLive,
  readSnapshot,
} from './embed-docs';
import { teardownProvider, type DocConnection } from '../hooks/useDocConnection';

vi.mock('../hooks/useDocConnection', () => ({
  connectDoc: vi.fn(),
  teardownProvider: vi.fn(),
}));

/** A provider whose unacknowledged edits the test controls. */
function fakeProvider(pending = false) {
  const listeners = new Set<(pending: boolean) => void>();
  return {
    hasLocalChanges: pending,
    on: (_: string, fn: (pending: boolean) => void) => listeners.add(fn),
    off: (_: string, fn: (pending: boolean) => void) => listeners.delete(fn),
    acknowledge() {
      this.hasLocalChanges = false;
      for (const fn of [...listeners]) fn(false);
    },
  };
}

function fakeConnection(text: string, provider = fakeProvider()): DocConnection {
  const doc = new Y.Doc();
  doc.getText('contents').insert(0, text);
  return { doc, provider: provider as unknown as DocConnection['provider'] };
}

beforeEach(() => {
  __embedDocsTesting.reset();
  vi.mocked(teardownProvider).mockClear();
});

describe('readSnapshot', () => {
  it(`runs at most ${MAX_PARALLEL_READS} reads at once`, async () => {
    const pending: Array<() => void> = [];
    let peak = 0;
    __embedDocsTesting.setReader((id) => new Promise((resolve) => {
      peak = Math.max(peak, __embedDocsTesting.running);
      pending.push(() => resolve(`text of ${id}`));
    }));
    const reads = Array.from({ length: 7 }, (_, i) => readSnapshot(`doc-${i}`));
    await Promise.resolve();
    expect(pending.length).toBe(MAX_PARALLEL_READS);
    while (pending.length) {
      pending.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(await Promise.all(reads)).toEqual(Array.from({ length: 7 }, (_, i) => `text of doc-${i}`));
    expect(peak).toBeLessThanOrEqual(MAX_PARALLEL_READS);
  });

  it('shares one read between embeds of the same file and caches it while fresh', async () => {
    const reader = vi.fn(async () => 'hello');
    __embedDocsTesting.setReader(reader);
    await Promise.all([readSnapshot('a', 0), readSnapshot('a', 0)]);
    await readSnapshot('a', Date.now());
    expect(reader).toHaveBeenCalledTimes(1);
    expect(cachedSnapshot('a')).toBe('hello');
  });

  it('reads again once the snapshot is stale', async () => {
    const reader = vi.fn(async () => 'hello');
    __embedDocsTesting.setReader(reader);
    await readSnapshot('a');
    await readSnapshot('a', Date.now() + SNAPSHOT_TTL_MS + 1);
    expect(reader).toHaveBeenCalledTimes(2);
  });
});

describe('openLive', () => {
  it('keeps one embed live: opening another ends the first and saves its text', async () => {
    __embedDocsTesting.setConnector(async (id) => fakeConnection(`live ${id}`));
    const first = {};
    const second = {};
    const firstEnded = vi.fn();
    const seen: string[] = [];
    onSnapshot('a', (t) => seen.push(t));

    const a = await openLive('a', first, firstEnded);
    a!.connection.doc.getText('contents').insert(0, 'edited ');
    expect(isLive(first)).toBe(true);

    await openLive('b', second, () => {});
    expect(firstEnded).toHaveBeenCalledTimes(1);
    expect(isLive(first)).toBe(false);
    expect(isLive(second)).toBe(true);
    expect(cachedSnapshot('a')).toBe('edited live a');
    expect(seen).toEqual(['edited live a']);
  });

  it('drops a connection that finished after it was overtaken', async () => {
    let finish!: (c: DocConnection) => void;
    __embedDocsTesting.setConnector(() => new Promise((resolve) => { finish = resolve; }));
    const owner = {};
    const opening = openLive('a', owner, () => {});
    closeLive(owner);
    finish(fakeConnection('x'));
    expect(await opening).toBeNull();
    expect(isLive(owner)).toBe(false);
  });

  it('closeLive with another owner leaves the live embed alone', async () => {
    __embedDocsTesting.setConnector(async () => fakeConnection('x'));
    const owner = {};
    await openLive('a', owner, () => {});
    closeLive({});
    expect(isLive(owner)).toBe(true);
  });
});

describe('closing an embed with unsent edits', () => {
  it('keeps the connection until the server has every edit', async () => {
    const provider = fakeProvider(true);
    __embedDocsTesting.setConnector(async () => fakeConnection('x', provider));
    const owner = {};
    await openLive('a', owner, () => {});
    closeLive(owner);
    expect(teardownProvider).not.toHaveBeenCalled();
    expect(__embedDocsTesting.flushing).toEqual(['a']);
    provider.acknowledge();
    expect(teardownProvider).toHaveBeenCalledTimes(1);
    expect(__embedDocsTesting.flushing).toEqual([]);
  });

  it('says the edits are not saved yet when it takes long, and when they are', async () => {
    vi.useFakeTimers();
    try {
      const provider = fakeProvider(true);
      __embedDocsTesting.setConnector(async () => fakeConnection('x', provider));
      const seen: boolean[] = [];
      onUnsaved('a', (u) => seen.push(u));
      const owner = {};
      await openLive('a', owner, () => {});
      closeLive(owner);
      vi.advanceTimersByTime(FLUSH_WARNING_MS + 1);
      expect(seen).toEqual([true]);
      expect(teardownProvider).not.toHaveBeenCalled();
      provider.acknowledge();
      expect(seen).toEqual([true, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reopening the file reuses the connection that is still sending', async () => {
    const connector = vi.fn(async () => fakeConnection('x', fakeProvider(true)));
    __embedDocsTesting.setConnector(connector);
    const first = {};
    const a = await openLive('a', first, () => {});
    closeLive(first);
    const b = await openLive('a', {}, () => {});
    expect(connector).toHaveBeenCalledTimes(1);
    expect(b!.connection).toBe(a!.connection);
    expect(__embedDocsTesting.flushing).toEqual([]);
  });
});
