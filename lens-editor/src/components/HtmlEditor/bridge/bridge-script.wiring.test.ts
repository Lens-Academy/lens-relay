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

  function stubRenderedRect(el: Element): void {
    const domRect = { left: 10, top: 20, right: 110, bottom: 50, x: 10, y: 20, width: 100, height: 30, toJSON: () => ({}) };
    el.getBoundingClientRect = () => domRect;
    el.getClientRects = () => [domRect] as unknown as DOMRectList;
  }

  function arm(commentId = 'c1'): void {
    document.body.innerHTML =
      '<p>before</p>' +
      `<!--lens-comment ${JSON.stringify({ id: commentId, author: 'a', ts: 't', body: 'x' })}-->` +
      '<p id="t">after</p>';
    stubRenderedRect(document.getElementById('t')!);
    postSpy = vi.spyOn(window.parent, 'postMessage').mockImplementation(
      ((env: Envelope<BridgeToParent>) => { sent.push(env); }) as typeof window.parent.postMessage,
    );
    const cleanup = installBridge(window as Window & typeof globalThis);
    if (typeof cleanup === 'function') cleanups.push(cleanup);
  }

  function dispatchToBridge(message: ParentToBridge, nonce = 'NONCE'): void {
    window.dispatchEvent(new MessageEvent('message', {
      data: { nonce, message },
      source: window.parent,
    }));
  }

  async function flushMutationObserver(): Promise<void> {
    await Promise.resolve();
  }

  it('posts "ready" immediately on install', () => {
    arm();
    expect(sent[0].message.type).toBe('ready');
  });

  it('does not throw when installed before body exists and renders after DOMContentLoaded', () => {
    const earlyWin = new HappyWindow();
    earlyWin.document.body.remove();
    const earlySent: Array<Envelope<BridgeToParent>> = [];
    const earlyPostSpy = vi.spyOn(earlyWin.parent, 'postMessage').mockImplementation(
      ((env: Envelope<BridgeToParent>) => { earlySent.push(env); }) as typeof earlyWin.parent.postMessage,
    );

    const cleanup = installBridge(earlyWin as unknown as Window & typeof globalThis);
    cleanups.push(cleanup);
    expect(earlySent[0].message.type).toBe('ready');

    const initEnv: Envelope<ParentToBridge> = {
      nonce: 'NONCE',
      message: { type: 'init', payload: { comments: [{ id: 'c1', body: 'x', replies: 0 }] } },
    };
    expect(() => {
      earlyWin.dispatchEvent(new earlyWin.MessageEvent('message', { data: initEnv, source: earlyWin.parent }));
    }).not.toThrow();
    expect(earlySent.find(e => e.message.type === 'comments-rendered')).toBeUndefined();
    expect(() => {
      earlyWin.dispatchEvent(new earlyWin.MessageEvent('message', {
        data: { nonce: 'NONCE', message: { type: 'find-probe', payload: { token: 'TKN' } } },
        source: earlyWin.parent,
      }));
    }).not.toThrow();
    const probe = earlySent.find(e => e.message.type === 'probe-found');
    expect(probe).toBeDefined();
    expect((probe!.message as Extract<BridgeToParent, { type: 'probe-found' }>).payload.rect).toBeNull();

    const body = earlyWin.document.createElement('body');
    body.innerHTML =
      '<p>before</p>' +
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->' +
      '<p id="t">after</p>';
    earlyWin.document.documentElement.appendChild(body);
    stubRenderedRect(earlyWin.document.getElementById('t')!);
    earlyWin.document.dispatchEvent(new earlyWin.Event('DOMContentLoaded'));

    const rendered = earlySent.find(e => e.message.type === 'comments-rendered');
    expect(rendered).toBeDefined();
    expect(earlyWin.document.querySelectorAll('.lens-comment-dot')).toHaveLength(1);

    earlyPostSpy.mockRestore();
  });

  it('after receiving init, renders dots and posts comments-rendered', () => {
    arm();
    const initEnv: Envelope<ParentToBridge> = {
      nonce: 'NONCE',
      message: { type: 'init', payload: { comments: [{ id: 'c1', body: 'x', replies: 0 }] } },
    };
    window.dispatchEvent(new MessageEvent('message', { data: initEnv, source: window.parent }));
    expect(document.querySelectorAll('.lens-comment-dot')).toHaveLength(1);
    const rendered = sent.find(e => e.message.type === 'comments-rendered');
    expect(rendered).toBeDefined();
    expect((rendered!.message as Extract<BridgeToParent, { type: 'comments-rendered' }>).payload.found).toEqual(['c1']);
  });

  it('cleanup removes owned overlay UI and leaves old dots inert', () => {
    arm();
    dispatchToBridge({ type: 'init', payload: { comments: [{ id: 'c1', body: 'x', replies: 0 }] } });
    const cleanup = cleanups.pop()!;
    const dot = document.querySelector('.lens-comment-dot') as HTMLElement;
    sent = [];

    cleanup();
    dot.click();

    expect(document.querySelector('[data-lens-overlay-root="v1"]')).toBeNull();
    expect(document.querySelectorAll('.lens-comment-dot')).toHaveLength(0);
    expect(sent.filter(e => e.message.type === 'dot-clicked')).toHaveLength(0);
  });

  it('ignores messages with wrong nonce after init', () => {
    arm();
    window.dispatchEvent(new MessageEvent('message', {
      data: { nonce: 'NONCE', message: { type: 'init', payload: { comments: [] } } },
      source: window.parent,
    }));
    const sentCountAfterInit = sent.length;
    window.dispatchEvent(new MessageEvent('message', {
      data: { nonce: 'WRONG', message: { type: 'set-comments', payload: { comments: [{ id: 'c1', body: 'x', replies: 0 }] } } },
      source: window.parent,
    }));
    expect(sent.length).toBe(sentCountAfterInit);
  });

  it('ignores messages whose source is not the parent window', () => {
    arm();
    window.dispatchEvent(new MessageEvent('message', {
      data: { nonce: 'NONCE', message: { type: 'init', payload: { comments: [] } } },
      source: null,
    }));

    expect(sent.filter(e => e.message.type === 'comments-rendered')).toHaveLength(0);
  });

  it('on dot click, posts dot-clicked with the comment id', () => {
    arm();
    window.dispatchEvent(new MessageEvent('message', {
      data: { nonce: 'NONCE', message: { type: 'init', payload: { comments: [{ id: 'c1', body: 'x', replies: 0 }] } } },
      source: window.parent,
    }));
    const dot = document.querySelector('.lens-comment-dot') as HTMLElement;
    dot.click();
    const clicked = sent.find(e => e.message.type === 'dot-clicked');
    expect(clicked).toBeDefined();
    expect((clicked!.message as Extract<BridgeToParent, { type: 'dot-clicked' }>).payload.id).toBe('c1');
  });

  it('when enable-click-to-place is active, next body click posts click-captured', () => {
    arm();
    window.dispatchEvent(new MessageEvent('message', {
      data: { nonce: 'NONCE', message: { type: 'init', payload: { comments: [] } } },
      source: window.parent,
    }));
    window.dispatchEvent(new MessageEvent('message', {
      data: { nonce: 'NONCE', message: { type: 'enable-click-to-place', payload: {} } },
      source: window.parent,
    }));
    const target = document.getElementById('t')!;
    target.click();
    const captured = sent.find(e => e.message.type === 'click-captured');
    expect(captured).toBeDefined();
    expect((captured!.message as Extract<BridgeToParent, { type: 'click-captured' }>).payload.fingerprint.tag).toBe('p');
  });

  it('ignores malformed enable-click-to-place after init without arming click capture', () => {
    arm();
    dispatchToBridge({ type: 'init', payload: { comments: [] } });
    window.dispatchEvent(new MessageEvent('message', {
      data: { nonce: 'NONCE', message: { type: 'enable-click-to-place', payload: null } },
      source: window.parent,
    }));

    document.getElementById('t')!.click();

    expect(sent.filter(e => e.message.type === 'click-captured')).toHaveLength(0);
  });

  it('ignores enable-click-to-place payloads with extra keys without arming click capture', () => {
    arm();
    dispatchToBridge({ type: 'init', payload: { comments: [] } });
    window.dispatchEvent(new MessageEvent('message', {
      data: { nonce: 'NONCE', message: { type: 'enable-click-to-place', payload: { extra: true } } },
      source: window.parent,
    }));

    document.getElementById('t')!.click();

    expect(sent.filter(e => e.message.type === 'click-captured')).toHaveLength(0);
  });

  it('ignores malformed disable-click-to-place after init without disarming click capture', () => {
    arm();
    dispatchToBridge({ type: 'init', payload: { comments: [] } });
    dispatchToBridge({ type: 'enable-click-to-place', payload: {} });
    window.dispatchEvent(new MessageEvent('message', {
      data: { nonce: 'NONCE', message: { type: 'disable-click-to-place', payload: null } },
      source: window.parent,
    }));

    document.getElementById('t')!.click();

    expect(sent.filter(e => e.message.type === 'click-captured')).toHaveLength(1);
  });

  it('ignores disable-click-to-place payloads with extra keys without disarming click capture', () => {
    arm();
    dispatchToBridge({ type: 'init', payload: { comments: [] } });
    dispatchToBridge({ type: 'enable-click-to-place', payload: {} });
    window.dispatchEvent(new MessageEvent('message', {
      data: { nonce: 'NONCE', message: { type: 'disable-click-to-place', payload: { extra: true } } },
      source: window.parent,
    }));

    document.getElementById('t')!.click();

    expect(sent.filter(e => e.message.type === 'click-captured')).toHaveLength(1);
  });

  it('valid redundant disable-click-to-place does not clear an existing page cursor', () => {
    arm();
    dispatchToBridge({ type: 'init', payload: { comments: [] } });
    document.body.style.cursor = 'text';

    dispatchToBridge({ type: 'disable-click-to-place', payload: {} });

    expect(document.body.style.cursor).toBe('text');
  });

  it('restores previous inline cursor after click-to-place captures a click', () => {
    arm();
    document.body.style.cursor = 'text';
    dispatchToBridge({ type: 'init', payload: { comments: [] } });
    dispatchToBridge({ type: 'enable-click-to-place', payload: {} });

    document.getElementById('t')!.click();

    expect(document.body.style.cursor).toBe('text');
  });

  it('click-to-place captures clicks on user elements that spoof overlay attributes', () => {
    arm();
    const target = document.getElementById('t')!;
    target.setAttribute('data-lens-overlay', 'true');
    dispatchToBridge({ type: 'init', payload: { comments: [] } });
    dispatchToBridge({ type: 'enable-click-to-place', payload: {} });

    target.click();

    const captured = sent.find(e => e.message.type === 'click-captured');
    expect(captured).toBeDefined();
    expect((captured!.message as Extract<BridgeToParent, { type: 'click-captured' }>).payload.fingerprint.tag).toBe('p');
  });

  it('responds to find-probe with rect or null', () => {
    arm();
    window.dispatchEvent(new MessageEvent('message', {
      data: { nonce: 'NONCE', message: { type: 'init', payload: { comments: [] } } },
      source: window.parent,
    }));
    document.body.insertAdjacentHTML('beforeend', '<!--lens-probe TKN--><span>x</span>');
    window.dispatchEvent(new MessageEvent('message', {
      data: { nonce: 'NONCE', message: { type: 'find-probe', payload: { token: 'TKN' } } },
      source: window.parent,
    }));
    const probe = sent.find(e => e.message.type === 'probe-found');
    expect(probe).toBeDefined();
    expect((probe!.message as Extract<BridgeToParent, { type: 'probe-found' }>).payload.token).toBe('TKN');
  });

  it('reinstalling does not leave duplicate active bridge listeners', () => {
    arm();
    const cleanup = installBridge(window as Window & typeof globalThis);
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    sent = [];

    dispatchToBridge({ type: 'init', payload: { comments: [{ id: 'c1', body: 'x', replies: 0 }] } });
    expect(sent.filter(e => e.message.type === 'comments-rendered')).toHaveLength(1);

    const dot = document.querySelector('.lens-comment-dot') as HTMLElement;
    dot.click();
    expect(sent.filter(e => e.message.type === 'dot-clicked')).toHaveLength(1);

    document.body.insertAdjacentHTML('beforeend', '<!--lens-probe TKN--><span>x</span>');
    dispatchToBridge({ type: 'find-probe', payload: { token: 'TKN' } });
    expect(sent.filter(e => e.message.type === 'probe-found')).toHaveLength(1);

    dispatchToBridge({ type: 'enable-click-to-place', payload: {} });
    document.getElementById('t')!.click();
    expect(sent.filter(e => e.message.type === 'click-captured')).toHaveLength(1);
  });

  it('highlight-comment handles selector-significant comment ids without selector lookup failure', () => {
    const id = 'weird"]id';
    arm(id);
    dispatchToBridge({ type: 'init', payload: { comments: [{ id, body: 'x', replies: 0 }] } });
    const dot = document.querySelector('.lens-comment-dot') as HTMLElement;
    const animate = vi.fn();
    dot.animate = animate;

    expect(() => {
      dispatchToBridge({ type: 'highlight-comment', payload: { id } });
    }).not.toThrow();
    expect(animate).toHaveBeenCalledOnce();
  });

  it('cleanup during pending mutation debounce prevents stale comments-rendered', async () => {
    vi.useFakeTimers();
    arm();
    dispatchToBridge({ type: 'init', payload: { comments: [{ id: 'c1', body: 'x', replies: 0 }] } });
    sent = [];

    document.body.appendChild(document.createElement('section'));
    await flushMutationObserver();
    const cleanup = installBridge(window as Window & typeof globalThis);
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    sent = [];

    vi.advanceTimersByTime(100);

    expect(sent.filter(e => e.message.type === 'comments-rendered')).toHaveLength(0);
  });

  it('old dot listeners do not survive reinstall before new init', () => {
    arm();
    dispatchToBridge({ type: 'init', payload: { comments: [{ id: 'c1', body: 'x', replies: 0 }] } });
    const oldDot = document.querySelector('.lens-comment-dot') as HTMLElement;
    const cleanup = installBridge(window as Window & typeof globalThis);
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    sent = [];

    oldDot.click();

    expect(sent.filter(e => e.message.type === 'dot-clicked')).toHaveLength(0);
  });

  it('mutations to user elements that spoof overlay attributes still schedule comments-rendered rebuilds', async () => {
    vi.useFakeTimers();
    arm();
    dispatchToBridge({ type: 'init', payload: { comments: [{ id: 'c1', body: 'x', replies: 0 }] } });
    sent = [];

    const spoofed = document.createElement('div');
    spoofed.setAttribute('data-lens-overlay', 'true');
    document.body.appendChild(spoofed);
    await flushMutationObserver();
    vi.advanceTimersByTime(100);

    expect(sent.filter(e => e.message.type === 'comments-rendered')).toHaveLength(1);
  });

  it('owned overlay-only mutations do not schedule comments-rendered rebuilds', async () => {
    vi.useFakeTimers();
    arm();
    dispatchToBridge({ type: 'init', payload: { comments: [{ id: 'c1', body: 'x', replies: 0 }] } });
    sent = [];

    const ownedOverlayRoot = document.querySelector('[data-lens-overlay-root="v1"]')!;
    ownedOverlayRoot.appendChild(document.createElement('span'));
    await flushMutationObserver();
    vi.advanceTimersByTime(100);

    expect(sent.filter(e => e.message.type === 'comments-rendered')).toHaveLength(0);
  });

  it('owned overlay root removal schedules rebuild and recreates dots', async () => {
    vi.useFakeTimers();
    arm();
    dispatchToBridge({ type: 'init', payload: { comments: [{ id: 'c1', body: 'x', replies: 0 }] } });
    const firstRoot = document.querySelector('[data-lens-overlay-root="v1"]')!;
    sent = [];

    firstRoot.remove();
    await flushMutationObserver();
    vi.advanceTimersByTime(100);

    expect(sent.filter(e => e.message.type === 'comments-rendered')).toHaveLength(1);
    expect(document.querySelectorAll('[data-lens-overlay-root="v1"]')).toHaveLength(1);
    expect(document.querySelectorAll('.lens-comment-dot')).toHaveLength(1);
  });

  it('set-comments rerender does not loop from removed owned dot nodes', async () => {
    vi.useFakeTimers();
    arm();
    dispatchToBridge({ type: 'init', payload: { comments: [{ id: 'c1', body: 'x', replies: 0 }] } });
    sent = [];

    dispatchToBridge({ type: 'set-comments', payload: { comments: [{ id: 'c1', body: 'x', replies: 0 }] } });
    await flushMutationObserver();
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(100);
      await flushMutationObserver();
    }

    expect(sent.filter(e => e.message.type === 'comments-rendered')).toHaveLength(1);
  });

  it('ignores malformed init envelopes without throwing before init', () => {
    arm();

    expect(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { nonce: 'NONCE', message: { type: 'init' } },
        source: window.parent,
      }));
      window.dispatchEvent(new MessageEvent('message', {
        data: { nonce: 'NONCE', message: { type: 'init', payload: null } },
        source: window.parent,
      }));
    }).not.toThrow();
    expect(sent.filter(e => e.message.type === 'comments-rendered')).toHaveLength(0);
  });

  it('ignores malformed set-comments after init without throwing or posting comments-rendered', () => {
    arm();
    dispatchToBridge({ type: 'init', payload: { comments: [] } });
    sent = [];

    expect(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { nonce: 'NONCE', message: { type: 'set-comments', payload: null } },
        source: window.parent,
      }));
    }).not.toThrow();
    expect(sent.filter(e => e.message.type === 'comments-rendered')).toHaveLength(0);
  });

  it('ignores malformed find-probe after init without throwing or posting probe-found', () => {
    arm();
    dispatchToBridge({ type: 'init', payload: { comments: [] } });
    sent = [];

    expect(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { nonce: 'NONCE', message: { type: 'find-probe', payload: null } },
        source: window.parent,
      }));
    }).not.toThrow();
    expect(sent.filter(e => e.message.type === 'probe-found')).toHaveLength(0);
  });

  it('ignores malformed highlight-comment after init without throwing', () => {
    arm();
    dispatchToBridge({ type: 'init', payload: { comments: [{ id: 'c1', body: 'x', replies: 0 }] } });
    const dot = document.querySelector('.lens-comment-dot') as HTMLElement;
    const animate = vi.fn();
    dot.animate = animate;

    expect(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { nonce: 'NONCE', message: { type: 'highlight-comment', payload: null } },
        source: window.parent,
      }));
    }).not.toThrow();
    expect(animate).not.toHaveBeenCalled();
  });
});
