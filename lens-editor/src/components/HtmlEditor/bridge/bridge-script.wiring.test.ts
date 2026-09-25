import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Window as HappyWindow } from 'happy-dom';
import { installBridge } from './bridge-script';
import type { Envelope, BridgeToParent, ParentToBridge } from './protocol';

describe('installBridge', () => {
  let sent: Array<Envelope<BridgeToParent>>;
  let postSpy: ReturnType<typeof vi.spyOn> | null = null;
  let cleanups: Array<() => void> = [];

  beforeEach(() => {
    document.body.innerHTML = '';
    sent = [];
    cleanups = [];
  });
  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    postSpy?.mockRestore();
    postSpy = null;
    vi.useRealTimers();
  });

  function arm(html = '<p id="t">Hello there, world.</p>'): void {
    document.body.innerHTML = html;
    postSpy = vi.spyOn(window.parent, 'postMessage').mockImplementation(
      ((env: Envelope<BridgeToParent>) => { sent.push(env); }) as typeof window.parent.postMessage,
    );
    cleanups.push(installBridge(window as Window & typeof globalThis));
  }

  function dispatchToBridge(message: ParentToBridge, nonce = 'NONCE'): void {
    window.dispatchEvent(new MessageEvent('message', {
      data: { nonce, message },
      source: window.parent,
    }));
  }

  const anchor = {
    v: 1, kind: 'text', quote: 'there', prefix: 'Hello ', suffix: ', world.',
    position: { start: 6, end: 11, total: 19 },
  } as const;

  it('posts "ready" immediately on install', () => {
    arm();
    expect(sent[0].message.type).toBe('ready');
  });

  it('posts throttled scroll-state messages with the current scroll position', () => {
    vi.useFakeTimers();
    arm();
    sent = [];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      return window.setTimeout(() => cb(0), 0);
    });

    try {
      window.scrollTo(3, 140);
      window.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('scroll'));
      vi.runAllTimers();

      const scrollStates = sent.filter(e => e.message.type === 'scroll-state');
      expect(scrollStates).toHaveLength(1);
      expect(scrollStates[0].message).toEqual({
        type: 'scroll-state',
        payload: expect.objectContaining({ x: 3, y: 140, layoutVersion: expect.any(Number) }),
      });
    } finally {
      raf.mockRestore();
    }
  });

  it('does not throw when installed before body exists, and places threads once it does', async () => {
    const earlyWin = new HappyWindow();
    earlyWin.document.body.remove();
    const earlySent: Array<Envelope<BridgeToParent>> = [];
    const earlyPostSpy = vi.spyOn(earlyWin.parent, 'postMessage').mockImplementation(
      ((env: Envelope<BridgeToParent>) => { earlySent.push(env); }) as typeof earlyWin.parent.postMessage,
    );

    const cleanup = installBridge(earlyWin as unknown as Window & typeof globalThis);
    cleanups.push(cleanup);
    expect(earlySent[0].message.type).toBe('ready');

    const send = (message: ParentToBridge) => earlyWin.dispatchEvent(
      new earlyWin.MessageEvent('message', { data: { nonce: 'NONCE', message }, source: earlyWin.parent }),
    );
    expect(() => {
      send({ type: 'init', payload: {} });
      send({ type: 'set-threads', payload: { threads: [{ id: 't1', anchor, order: 1, resolved: false }] } });
    }).not.toThrow();

    const body = earlyWin.document.createElement('body');
    body.innerHTML = '<p>Hello there, world.</p>';
    earlyWin.document.documentElement.appendChild(body);
    earlyWin.document.dispatchEvent(new earlyWin.Event('DOMContentLoaded'));
    await new Promise(resolve => setTimeout(resolve, 80));

    const resolved = earlySent.filter(e => e.message.type === 'threads-resolved').at(-1);
    expect(resolved).toBeDefined();
    const placements = (resolved!.message as Extract<BridgeToParent, { type: 'threads-resolved' }>).payload.placements;
    expect(placements[0]).toMatchObject({ id: 't1', textOffset: 6 });
    earlyPostSpy.mockRestore();
  });

  it('captures details open state by structural path', () => {
    arm('<details><summary>A</summary></details><details open><summary>B</summary></details>');
    dispatchToBridge({ type: 'init', payload: {} });
    dispatchToBridge({ type: 'capture-ui-state', payload: {} });

    const state = sent.find(e => e.message.type === 'ui-state');
    expect(state?.message).toMatchObject({
      type: 'ui-state',
      payload: { details: [{ path: [1], open: true }] },
    });
  });

  it('restores details open state by structural path', () => {
    arm('<details><summary>A</summary></details><details><summary>B</summary></details>');
    dispatchToBridge({ type: 'init', payload: {} });
    dispatchToBridge({ type: 'restore-ui-state', payload: { details: [{ path: [1], open: true }] } });

    const details = Array.from(document.querySelectorAll('details')) as HTMLDetailsElement[];
    expect(details[0].open).toBe(false);
    expect(details[1].open).toBe(true);
  });

  it('ignores messages whose source is not the parent window', async () => {
    arm();
    window.dispatchEvent(new MessageEvent('message', {
      data: { nonce: 'NONCE', message: { type: 'init', payload: {} } },
      source: null,
    }));
    dispatchToBridge({ type: 'set-threads', payload: { threads: [{ id: 't1', anchor, order: 1, resolved: false }] } });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(sent.filter(e => e.message.type === 'threads-resolved')).toHaveLength(0);
  });

  it('reinstalling does not leave duplicate active bridge listeners', async () => {
    arm();
    cleanups.push(installBridge(window as Window & typeof globalThis));
    sent = [];
    dispatchToBridge({ type: 'init', payload: {} });
    dispatchToBridge({ type: 'set-threads', payload: { threads: [{ id: 't1', anchor, order: 1, resolved: false }] } });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(sent.filter(e => e.message.type === 'threads-resolved')).toHaveLength(1);
    expect(document.documentElement.querySelectorAll('[data-lens-comment-layer]')).toHaveLength(1);
  });

  it('ignores malformed messages without throwing', async () => {
    arm();
    const bad = [
      { type: 'init' },
      { type: 'init', payload: null },
    ];
    expect(() => {
      for (const message of bad) {
        window.dispatchEvent(new MessageEvent('message', { data: { nonce: 'NONCE', message }, source: window.parent }));
      }
      dispatchToBridge({ type: 'init', payload: {} });
      for (const message of [
        { type: 'set-threads', payload: null },
        { type: 'set-threads', payload: { threads: [{ id: 1 }, { id: 'x', order: 1, anchor: { kind: 'nope' } }] } },
        { type: 'set-draft', payload: 'x' },
        { type: 'set-focused-thread', payload: { id: 5 } },
        { type: 'describe-legacy', payload: { ids: 'x' } },
        { type: 'describe-current', payload: {} },
      ]) {
        window.dispatchEvent(new MessageEvent('message', { data: { nonce: 'NONCE', message }, source: window.parent }));
      }
    }).not.toThrow();
    await new Promise(resolve => setTimeout(resolve, 50));
    const resolved = sent.filter(e => e.message.type === 'threads-resolved').at(-1);
    expect((resolved?.message as Extract<BridgeToParent, { type: 'threads-resolved' }> | undefined)?.payload.placements ?? []).toEqual([]);
  });

  it('cleanup removes the overlay host and highlight style', async () => {
    arm();
    dispatchToBridge({ type: 'init', payload: {} });
    dispatchToBridge({ type: 'set-comment-mode', payload: { on: true } });
    dispatchToBridge({ type: 'set-threads', payload: { threads: [{ id: 't1', anchor, order: 1, resolved: false }] } });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(document.documentElement.classList.contains('lens-commenting')).toBe(true);
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    expect(document.documentElement.querySelector('[data-lens-comment-layer]')).toBeNull();
    expect(document.getElementById('lens-comment-highlight-style')).toBeNull();
    expect(document.documentElement.classList.contains('lens-commenting')).toBe(false);
  });
});
