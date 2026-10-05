import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as Y from 'yjs';
import {
  MAX_PARALLEL_READS,
  SNAPSHOT_TTL_MS,
  __embedDocsTesting,
  cachedSnapshot,
  closeLive,
  isLive,
  onSnapshot,
  openLive,
  readSnapshot,
} from './embed-docs';
import type { DocConnection } from '../hooks/useDocConnection';

vi.mock('../hooks/useDocConnection', () => ({
  connectDoc: vi.fn(),
  teardownProvider: vi.fn(),
}));

function fakeConnection(text: string): DocConnection {
  const doc = new Y.Doc();
  doc.getText('contents').insert(0, text);
  return { doc, provider: {} as DocConnection['provider'] };
}

beforeEach(() => __embedDocsTesting.reset());

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
