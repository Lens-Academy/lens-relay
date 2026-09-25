import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installBridge } from './bridge-script';
import type { BridgeToParent, ParentToBridge, ThreadsResolvedPayload } from './protocol';
import { buildTextIndex } from '../anchoring/text-index';
import { describeSpan } from '../anchoring/describe';
import type { TextAnchor } from '../anchoring/types';

function setupBody(html: string): void {
  document.body.innerHTML = html;
}

describe('installBridge scroll handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('restores scroll when parent sends restore-scroll', () => {
    vi.useFakeTimers();
    setupBody('<p>scroll me</p>');
    const cleanup = installBridge(window);
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      return window.setTimeout(() => cb(0), 0);
    });

    window.dispatchEvent(new MessageEvent('message', {
      source: window.parent,
      data: { nonce: 'N', message: { type: 'init', payload: {} } },
    }));
    window.dispatchEvent(new MessageEvent('message', {
      source: window.parent,
      data: { nonce: 'N', message: { type: 'restore-scroll', payload: { x: 3, y: 140 } } },
    }));
    vi.runAllTimers();

    expect(scrollTo).toHaveBeenCalledWith(3, 140);
    cleanup();
  });

  it('defers restore-scroll until the iframe layout range is stable', () => {
    vi.useFakeTimers();
    setupBody('<p>scroll me</p>');
    const cleanup = installBridge(window);
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      return window.setTimeout(() => cb(0), 0);
    });
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      configurable: true,
      value: 2000,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 500,
    });

    window.dispatchEvent(new MessageEvent('message', {
      source: window.parent,
      data: { nonce: 'N', message: { type: 'init', payload: {} } },
    }));
    window.dispatchEvent(new MessageEvent('message', {
      source: window.parent,
      data: { nonce: 'N', message: { type: 'restore-scroll', payload: { x: 3, y: 140 } } },
    }));

    expect(scrollTo).not.toHaveBeenCalledWith(3, 140);
    vi.runAllTimers();

    expect(scrollTo).toHaveBeenCalledWith(3, 140);
    cleanup();
  });

  it('restores scroll ratio using the iframe document scroll range', () => {
    vi.useFakeTimers();
    setupBody('<p>scroll me</p>');
    const cleanup = installBridge(window);
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      return window.setTimeout(() => cb(0), 0);
    });
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      configurable: true,
      value: 2000,
    });
    Object.defineProperty(document.body, 'clientHeight', {
      configurable: true,
      value: 2000,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 500,
    });

    window.dispatchEvent(new MessageEvent('message', {
      source: window.parent,
      data: { nonce: 'N', message: { type: 'init', payload: {} } },
    }));
    window.dispatchEvent(new MessageEvent('message', {
      source: window.parent,
      data: { nonce: 'N', message: { type: 'restore-scroll-ratio', payload: { xRatio: 0, yRatio: 0.4 } } },
    }));
    vi.runAllTimers();

    expect(scrollTo).toHaveBeenCalledWith(0, 600);
    cleanup();
  });
});


type Sent = { nonce: string; message: BridgeToParent };

function anchorFor(quote: string): TextAnchor {
  const index = buildTextIndex(document.body);
  const at = index.text.indexOf(quote);
  return describeSpan(index, at, at + quote.length)!;
}

describe('installBridge comment layer', () => {
  let sent: Sent[] = [];
  let cleanup: (() => void) | null = null;
  const rect = { left: 10, top: 20, right: 110, bottom: 40, x: 10, y: 20, width: 100, height: 20, toJSON: () => ({}) };

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    // happy-dom has no layout: give every range and element a box.
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([rect] as unknown as DOMRectList);
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(rect as DOMRect);
    vi.spyOn(window.parent, 'postMessage').mockImplementation((msg: unknown) => { sent.push(msg as Sent); });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => window.setTimeout(() => cb(0), 0));
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => window.clearTimeout(id));
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function send(message: ParentToBridge, nonce = 'N'): void {
    window.dispatchEvent(new MessageEvent('message', { data: { nonce, message }, source: window.parent }));
  }

  function lastResolved(): ThreadsResolvedPayload | undefined {
    const found = sent.filter(e => e.message.type === 'threads-resolved').at(-1);
    return found ? (found.message as Extract<BridgeToParent, { type: 'threads-resolved' }>).payload : undefined;
  }

  it('places threads after init and never inserts nodes into the body', () => {
    setupBody('<h2>Plans</h2><p>The basic plan costs ten euros a month.</p>');
    const anchor = anchorFor('ten euros');
    const before = document.body.innerHTML;
    cleanup = installBridge(window);
    send({ type: 'init', payload: {} });
    send({ type: 'set-threads', payload: { threads: [{ id: 't1', anchor, order: 1, resolved: false }] } });
    vi.advanceTimersByTime(50);

    const payload = lastResolved();
    expect(payload?.placements).toEqual([
      expect.objectContaining({ id: 't1', state: 'anchored', textOffset: anchor.position.start }),
    ]);
    expect(payload?.placements[0].rect).toEqual({ x: 10, y: 20, w: 100, h: 20 });
    expect(document.body.innerHTML).toBe(before);
    // The badge lives in a shadow-rooted host after <body>.
    const host = document.documentElement.querySelector('[data-lens-comment-layer]');
    expect(host?.parentElement).toBe(document.documentElement);
  });

  it('re-resolves when the page changes and reports orphans once settled', async () => {
    setupBody('<p id="p">Delete this sentence about llamas.</p>');
    const anchor = anchorFor('sentence about llamas');
    cleanup = installBridge(window);
    send({ type: 'init', payload: {} });
    send({ type: 'set-threads', payload: { threads: [{ id: 't1', anchor, order: 1, resolved: false }] } });
    vi.advanceTimersByTime(50);
    expect(lastResolved()?.placements[0].state).toBe('anchored');

    document.getElementById('p')!.textContent = 'Something unrelated now.';
    await vi.advanceTimersByTimeAsync(200);
    expect(lastResolved()?.placements[0].state).toBe('orphaned');
    await vi.advanceTimersByTimeAsync(6000);
    expect(lastResolved()?.settled).toBe(true);
  });

  it('turns a click in comment mode into an anchor without letting the page see it', () => {
    setupBody('<h3>Short heading</h3><p><a href="#x" id="link">A link inside text</a></p>');
    const text = document.getElementById('link')!.firstChild as Text;
    const pageClick = vi.fn();
    document.getElementById('link')!.addEventListener('click', pageClick);
    (document as Document & { caretPositionFromPoint?: unknown }).caretPositionFromPoint = () => ({ offsetNode: text, offset: 3 });
    document.elementFromPoint = () => document.getElementById('link');
    cleanup = installBridge(window);
    send({ type: 'init', payload: {} });
    send({ type: 'set-comment-mode', payload: { on: true } });

    document.getElementById('link')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }));

    expect(pageClick).not.toHaveBeenCalled();
    const captured = sent.find(e => e.message.type === 'anchor-captured');
    expect(captured).toBeDefined();
    const payload = (captured!.message as Extract<BridgeToParent, { type: 'anchor-captured' }>).payload;
    expect(payload.via).toBe('click');
    expect(payload.anchor).toMatchObject({ kind: 'text', quote: 'A link inside text' });
    delete (document as Document & { caretPositionFromPoint?: unknown }).caretPositionFromPoint;
  });

  it('leaves clicks alone outside comment mode and posts comment-mode-exit on Escape', () => {
    setupBody('<button id="b">Go</button>');
    const pageClick = vi.fn();
    document.getElementById('b')!.addEventListener('click', pageClick);
    cleanup = installBridge(window);
    send({ type: 'init', payload: {} });
    document.getElementById('b')!.click();
    expect(pageClick).toHaveBeenCalledTimes(1);

    send({ type: 'set-comment-mode', payload: { on: true } });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(sent.some(e => e.message.type === 'comment-mode-exit')).toBe(true);
  });

  it('does not pin a click on the blank space of a big layout container', () => {
    setupBody('<main id="m"><p>Some text</p></main>');
    const main = document.getElementById('m')!;
    const big = { left: 0, top: 0, right: 2000, bottom: 2000, x: 0, y: 0, width: 2000, height: 2000, toJSON: () => ({}) };
    main.getBoundingClientRect = () => big as DOMRect;
    document.elementFromPoint = () => main;
    cleanup = installBridge(window);
    send({ type: 'init', payload: {} });
    send({ type: 'set-comment-mode', payload: { on: true } });
    main.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 900, clientY: 900 }));
    expect(sent.some(e => e.message.type === 'anchor-captured')).toBe(false);
  });

  it('keeps dropdowns closed in comment mode and forwards the C shortcut', () => {
    setupBody('<select id="s"><option>A</option></select><p id="p">text</p>');
    cleanup = installBridge(window);
    send({ type: 'init', payload: {} });
    send({ type: 'set-comment-mode', payload: { on: true } });
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    document.getElementById('s')!.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);

    document.getElementById('p')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true }));
    vi.advanceTimersByTime(5);
    expect(sent.some(e => e.message.type === 'shortcut')).toBe(true);

    sent = [];
    const handled = new KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true });
    document.getElementById('p')!.addEventListener('keydown', e => e.preventDefault(), { once: true });
    document.getElementById('p')!.dispatchEvent(handled);
    vi.advanceTimersByTime(5);
    expect(sent.some(e => e.message.type === 'shortcut')).toBe(false);
  });

  it('describes legacy inline comments from where their markers render', () => {
    setupBody('<p>Intro text.</p><!--lens-comment {"id":"old1","author":"a","ts":"t","body":"x"}--><p>The commented paragraph.</p>');
    cleanup = installBridge(window);
    send({ type: 'init', payload: {} });
    send({ type: 'describe-legacy', payload: { ids: ['old1', 'missing'] } });
    const msg = sent.find(e => e.message.type === 'legacy-described');
    const anchors = (msg!.message as Extract<BridgeToParent, { type: 'legacy-described' }>).payload.anchors;
    expect(anchors.old1).toMatchObject({ kind: 'text', quote: 'The commented paragraph.' });
    expect(anchors.missing).toBeNull();
  });

  it('ignores thread messages before init and with a wrong nonce', () => {
    setupBody('<p>Hello there world</p>');
    const anchor = anchorFor('there');
    cleanup = installBridge(window);
    send({ type: 'set-threads', payload: { threads: [{ id: 't1', anchor, order: 1, resolved: false }] } });
    vi.advanceTimersByTime(50);
    expect(lastResolved()).toBeUndefined();
    send({ type: 'init', payload: {} });
    send({ type: 'set-threads', payload: { threads: [{ id: 't2', anchor, order: 1, resolved: false }] } }, 'wrong');
    vi.advanceTimersByTime(50);
    expect(lastResolved()?.placements ?? []).toEqual([]);
  });
});
