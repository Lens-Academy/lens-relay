// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act, screen } from '@testing-library/react';
import * as Y from 'yjs';
import { HtmlPreview } from './HtmlPreview';
import type { BridgeToParent, Envelope } from './bridge/protocol';
import type { ThreadsResolvedPayload } from './bridge/protocol';

vi.mock('./bridge/protocol', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bridge/protocol')>();
  return { ...actual, makeNonce: () => '__test_nonce__' };
});

function dispatchFromBridge(iframe: HTMLIFrameElement, env: Envelope<BridgeToParent>): void {
  window.dispatchEvent(new MessageEvent('message', { data: env, source: iframe.contentWindow }));
}

describe('HtmlPreview', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders a sandboxed iframe that can run scripts but never reach the editor origin', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<h1>Hello</h1>');

    const { container } = render(<HtmlPreview ytext={ytext} />);
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    const sandbox = iframe!.getAttribute('sandbox') ?? '';
    const tokens = sandbox.split(/\s+/);
    expect(tokens).toContain('allow-scripts');
    // Same-origin would let the page read the editor's tokens; top navigation
    // would let it replace the editor; modals would fire on every re-render.
    expect(tokens).not.toContain('allow-same-origin');
    expect(tokens.some(t => t.startsWith('allow-top-navigation'))).toBe(false);
    expect(tokens).not.toContain('allow-modals');
  });

  it('wraps the page in the runtime head: CSP and import map before the bridge', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<!doctype html><html><head><title>t</title></head><body><p>x</p></body></html>');

    const { container } = render(<HtmlPreview ytext={ytext} />);
    const srcdoc = container.querySelector('iframe')!.getAttribute('srcdoc') ?? '';
    expect(srcdoc.startsWith('<!doctype html><html><head><script>window.__lensLineOffset=')).toBe(true);
    expect(srcdoc.indexOf('Content-Security-Policy')).toBeLessThan(srcdoc.indexOf('<title>'));
    expect(srcdoc.indexOf('type="importmap"')).toBeLessThan(srcdoc.indexOf('<title>'));
  });

  it('seeds the page storage from the viewer copy and merges storage-ops into it', () => {
    localStorage.setItem('lens-html-page-storage:doc-1', JSON.stringify({ at: 1, items: { tab: 'b', keep: '1' } }));
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>x</p>');

    const { container } = render(<HtmlPreview ytext={ytext} storageKey="doc-1" />);
    const iframe = container.querySelector('iframe')!;
    expect(iframe.getAttribute('srcdoc')).toContain('window.__lensStorageSeed={"tab":"b","keep":"1"}');

    act(() => {
      dispatchFromBridge(iframe, {
        nonce: '__test_nonce__',
        message: { type: 'storage-ops', payload: { ops: [{ op: 'set', key: 'tab', value: 'c' }, { op: 'remove', key: 'nope' }] } },
      });
    });
    const stored = JSON.parse(localStorage.getItem('lens-html-page-storage:doc-1') ?? '{}');
    expect(stored.items).toEqual({ tab: 'c', keep: '1' });
    expect(stored.at).toBeGreaterThan(1);

    act(() => {
      dispatchFromBridge(iframe, {
        nonce: '__test_nonce__',
        message: { type: 'storage-ops', payload: { ops: [{ op: 'clear' }] } },
      });
    });
    expect(localStorage.getItem('lens-html-page-storage:doc-1')).toBeNull();
  });

  it('refuses page storage over the per-page cap and reports it', async () => {
    const problems: unknown[][] = [];
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>x</p>');
    const { container } = render(
      <HtmlPreview ytext={ytext} storageKey="doc-big" onPageProblems={p => problems.push(p)} />,
    );
    const iframe = container.querySelector('iframe')!;
    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: '__test_nonce__',
        message: { type: 'storage-ops', payload: { ops: [{ op: 'set', key: 'blob', value: 'x'.repeat(250_000) }] } },
      });
    });
    expect(localStorage.getItem('lens-html-page-storage:doc-big')).toBeNull();
    expect(JSON.stringify(problems.at(-1))).toContain('localStorage is over 200,000 characters');
  });

  it('reloads a page that navigated itself away and reports it', async () => {
    const reports: unknown[][] = [];
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>x</p>');
    const { container } = render(<HtmlPreview ytext={ytext} onPageProblems={p => reports.push(p)} />);
    const iframe = container.querySelector('iframe')!;
    const original = iframe.getAttribute('srcdoc');
    await act(async () => {});
    // jsdom fires the frame's first load itself; that one is the page.
    expect(reports.at(-1) ?? []).toEqual([]);
    // A later load means the page replaced itself (e.g. location.href = …).
    // jsdom fires load for the simulated navigation, as a browser would.
    await act(async () => { iframe.setAttribute('srcdoc', 'changed by navigation'); });
    expect(iframe.getAttribute('srcdoc')).toBe(original);
    expect(JSON.stringify(reports.at(-1))).toContain('navigated away from itself');
    // The load caused by our own reload (jsdom fires it) is not another navigation.
    await act(async () => {});
    expect(JSON.stringify(reports.at(-1))).toContain('"count":1');
  });

  it('clears reported problems when it unmounts, so a remount starts clean', async () => {
    const reports: unknown[][] = [];
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>x</p>');
    const onPageProblems = (p: unknown[]) => reports.push(p);
    const { container, unmount } = render(<HtmlPreview ytext={ytext} onPageProblems={onPageProblems} />);
    await act(async () => {
      dispatchFromBridge(container.querySelector('iframe')!, {
        nonce: '__test_nonce__',
        message: { type: 'page-problems', payload: { problems: [{ kind: 'error', message: 'boom', count: 1 }] } },
      });
    });
    expect(reports.at(-1)).toHaveLength(1);
    unmount();
    expect(reports.at(-1)).toEqual([]);
    render(<HtmlPreview ytext={ytext} onPageProblems={onPageProblems} />);
    expect(reports.at(-1)).toEqual([]);
  });

  it('updates srcdoc after a Y.Text mutation, debounced by 300ms', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');

    const { container } = render(<HtmlPreview ytext={ytext} />);
    const activeIframe = () => container.querySelector('iframe[data-preview-frame-state="active"]') as HTMLIFrameElement;
    const loadingIframe = () => container.querySelector('iframe[data-preview-frame-state="loading"]') as HTMLIFrameElement | null;
    const activateLoadingIframe = async () => {
      const frame = loadingIframe();
      expect(frame).not.toBeNull();
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', {
          data: { nonce: '', message: { type: 'ready', payload: {} } },
          source: frame!.contentWindow,
        }));
        dispatchFromBridge(frame!, {
          nonce: '__test_nonce__',
          message: { type: 'scroll-state', payload: { x: 0, y: 0, scrollWidth: 500, clientWidth: 500, scrollHeight: 1000, clientHeight: 500 } },
        });
      });
    };

    await act(async () => {
      ytext.insert(0, '<p>first</p>');
    });

    await act(async () => { vi.advanceTimersByTime(100); });
    expect(activeIframe().getAttribute('srcdoc') ?? '').toContain('<script>');
    expect(loadingIframe()).toBeNull();

    await act(async () => { vi.advanceTimersByTime(250); });
    expect(loadingIframe()?.getAttribute('srcdoc')).toContain('<p>first</p>');
    expect(activeIframe().getAttribute('srcdoc')).not.toContain('<p>first</p>');

    await activateLoadingIframe();
    expect(activeIframe().getAttribute('srcdoc')).toContain('<p>first</p>');

    await act(async () => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, '<p>second</p>');
    });
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(activeIframe().getAttribute('srcdoc')).toContain('<p>first</p>');
    expect(loadingIframe()).toBeNull();
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(loadingIframe()?.getAttribute('srcdoc')).toContain('<p>second</p>');
  });
});

describe('HtmlPreview bridge integration', () => {
  it('calls onThreadClicked with the thread id when the bridge reports a click', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>Hi</p><!--lens-comment {"id":"c1","author":"me@x","ts":"t","body":"question"}-->');

    const onThreadClicked = vi.fn();
    render(
      <HtmlPreview
        ytext={ytext}
        debounceMs={0}
        onThreadClicked={onThreadClicked}
      />
    );
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: '__test_nonce__',
        message: { type: 'thread-clicked', payload: { id: 'c1' } },
      });
    });

    expect(onThreadClicked).toHaveBeenCalledWith('c1');
  });

  it('ignores bridge messages from sources other than the iframe contentWindow', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->');

    render(<HtmlPreview ytext={ytext} debounceMs={0} />);

    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { nonce: '__test_nonce__', message: { type: 'thread-clicked', payload: { id: 'c1' } } },
      }));
    });

    expect(screen.queryByText('x')).toBeNull();
  });

  it('ignores bridge messages from a concrete wrong iframe contentWindow', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->');

    render(<HtmlPreview ytext={ytext} debounceMs={0} />);
    const wrongIframe = document.createElement('iframe');
    document.body.appendChild(wrongIframe);

    try {
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', {
          data: { nonce: '__test_nonce__', message: { type: 'thread-clicked', payload: { id: 'c1' } } },
          source: wrongIframe.contentWindow,
        }));
      });

      expect(screen.queryByText('x')).toBeNull();
    } finally {
      wrongIframe.remove();
    }
  });

  it('ignores bridge messages with a wrong nonce', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->');

    render(<HtmlPreview ytext={ytext} debounceMs={0} />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: 'wrong',
        message: { type: 'thread-clicked', payload: { id: 'c1' } },
      });
    });

    expect(screen.queryByText('x')).toBeNull();
  });

  it('forwards validated threads-resolved payloads', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>Hi</p>');
    const reports: ThreadsResolvedPayload[] = [];

    render(<HtmlPreview ytext={ytext} debounceMs={0} onThreadsResolved={r => reports.push(r)} />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: '__test_nonce__',
        message: {
          type: 'threads-resolved',
          payload: {
            placements: [
              { id: 't1', state: 'anchored', rect: { x: 1, y: 2, w: 3, h: 4 }, textOffset: 5 },
              { id: 't2', state: 'bogus', rect: null, textOffset: null } as never,
              { id: 't3', state: 'orphaned', rect: 'nope' as never, textOffset: null },
            ],
            draft: null,
            baselineScrollY: 0,
            layoutVersion: 3,
            settled: true,
          },
        },
      });
    });

    expect(reports.at(-1)?.placements).toEqual([
      { id: 't1', state: 'anchored', rect: { x: 1, y: 2, w: 3, h: 4 }, textOffset: 5 },
      { id: 't3', state: 'orphaned', rect: null, textOffset: null },
    ]);
    expect(reports.at(-1)?.settled).toBe(true);
  });

  it('accepts a captured anchor only in comment mode or from a selection', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>Hi there</p>');
    const captures: unknown[] = [];
    const anchor = { v: 1, kind: 'text', quote: 'Hi', prefix: '', suffix: ' there', position: { start: 0, end: 2, total: 8 } };
    const rect = { x: 0, y: 0, w: 10, h: 10 };

    const { rerender } = render(<HtmlPreview ytext={ytext} debounceMs={0} onAnchorCaptured={c => captures.push(c)} />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;
    const send = () => dispatchFromBridge(iframe, {
      nonce: '__test_nonce__',
      message: { type: 'anchor-captured', payload: { anchor, rect, via: 'click' } } as never,
    });

    await act(async () => { send(); });
    expect(captures).toHaveLength(0);

    rerender(<HtmlPreview ytext={ytext} debounceMs={0} commentMode onAnchorCaptured={c => captures.push(c)} />);
    await act(async () => { send(); });
    expect(captures).toHaveLength(1);
    expect((captures[0] as { anchor: { quote: string } }).anchor.quote).toBe('Hi');
  });

  it('ignores replies the parent never asked for (the page can forge them)', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>Hi there</p>');
    const captures: unknown[] = [];
    const described: string[] = [];
    const legacy: unknown[] = [];
    const anchor = { v: 1, kind: 'text', quote: 'Hi', prefix: '', suffix: ' there', position: { start: 0, end: 2, total: 8 } };
    const ref = { current: null as import('./HtmlPreview').HtmlPreviewHandle | null };
    render(
      <HtmlPreview
        ref={handle => { ref.current = handle; }}
        ytext={ytext}
        debounceMs={0}
        onAnchorCaptured={c => captures.push(c)}
        onCurrentDescribed={id => described.push(id)}
        onLegacyDescribed={a => legacy.push(a)}
      />,
    );
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;
    const send = (message: unknown) => dispatchFromBridge(iframe, { nonce: '__test_nonce__', message: message as BridgeToParent });

    await act(async () => {
      send({ type: 'anchor-captured', payload: { anchor, rect: { x: 0, y: 0, w: 1, h: 1 }, via: 'selection' } });
      send({ type: 'current-described', payload: { id: 't1', anchor } });
      send({ type: 'legacy-described', payload: { anchors: { x: anchor } } });
    });
    expect(captures).toHaveLength(0);
    expect(described).toHaveLength(0);
    expect(legacy).toHaveLength(0);

    await act(async () => {
      ref.current!.captureSelection();
      ref.current!.describeCurrent('t1');
      send({ type: 'anchor-captured', payload: { anchor, rect: { x: 0, y: 0, w: 1, h: 1 }, via: 'selection' } });
      send({ type: 'current-described', payload: { id: 't1', anchor } });
      // Each request is answered once.
      send({ type: 'anchor-captured', payload: { anchor, rect: { x: 0, y: 0, w: 1, h: 1 }, via: 'selection' } });
      send({ type: 'current-described', payload: { id: 't1', anchor } });
    });
    expect(captures).toHaveLength(1);
    expect(described).toEqual(['t1']);
  });

  it('applies threads-resolved reports from a replacement iframe when it becomes active', async () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>first</p>');
    const reports: ThreadsResolvedPayload[] = [];
    const resolved = (state: 'anchored' | 'orphaned') => ({
      type: 'threads-resolved' as const,
      payload: {
        placements: [{ id: 't1', state, rect: null, textOffset: null }],
        draft: null,
        baselineScrollY: 0,
        layoutVersion: 1,
        settled: true,
      },
    });

    const { container } = render(<HtmlPreview ytext={ytext} debounceMs={0} onThreadsResolved={r => reports.push(r)} />);
    const activeFrame = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(activeFrame, { nonce: '__test_nonce__', message: resolved('orphaned') });
      dispatchFromBridge(activeFrame, {
        nonce: '__test_nonce__',
        message: { type: 'scroll-state', payload: { x: 0, y: 0, scrollWidth: 500, clientWidth: 500, scrollHeight: 1000, clientHeight: 500, layoutVersion: 0 } },
      });
      ytext.delete(0, ytext.length);
      ytext.insert(0, '<p>second</p>');
    });
    await act(async () => { vi.advanceTimersByTime(0); });
    await act(async () => {});

    const replacementFrame = container.querySelector('iframe[data-preview-frame-state="loading"]') as HTMLIFrameElement;
    expect(replacementFrame).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { nonce: '', message: { type: 'ready', payload: {} } },
        source: replacementFrame.contentWindow,
      }));
    });
    await act(async () => {
      dispatchFromBridge(replacementFrame, { nonce: '__test_nonce__', message: resolved('anchored') });
    });
    // Buffered until the replacement becomes the visible frame.
    expect(reports.at(-1)?.placements[0].state).toBe('orphaned');

    await act(async () => {
      dispatchFromBridge(replacementFrame, {
        nonce: '__test_nonce__',
        message: { type: 'scroll-state', payload: { x: 0, y: 0, scrollWidth: 500, clientWidth: 500, scrollHeight: 1000, clientHeight: 500, layoutVersion: 0 } },
      });
    });

    expect(container.querySelector('iframe[data-preview-frame-state="active"]')).toBe(replacementFrame);
    expect(reports.at(-1)?.placements[0].state).toBe('anchored');
  });

  it('responds to bridge ready by posting init back to the iframe contentWindow', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->');

    render(<HtmlPreview ytext={ytext} debounceMs={0} />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;
    const posted: unknown[] = [];
    const spy = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(
      ((msg: unknown) => { posted.push(msg); }) as typeof window.postMessage
    );

    try {
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', {
          data: { nonce: '', message: { type: 'ready', payload: {} } },
          source: iframe.contentWindow,
        }));
      });

      const init = posted.find((p): p is Envelope<{ type: 'init'; payload: unknown }> =>
        typeof p === 'object' && p !== null && (p as { message?: { type?: string } }).message?.type === 'init'
      );
      expect(init).toBeDefined();
      expect(init?.nonce).toBe('__test_nonce__');
      expect(init?.message.payload).toEqual({});
      const types = posted.map(p => (p as { message?: { type?: string } }).message?.type);
      expect(types).toEqual(expect.arrayContaining(['set-threads', 'set-draft', 'set-focused-thread', 'set-comment-mode']));
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps the current iframe visible until the replacement iframe restores scroll', async () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>first</p>');

    const { container } = render(<HtmlPreview ytext={ytext} debounceMs={0} />);
    const activeFrame = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(activeFrame, {
        nonce: '__test_nonce__',
        message: { type: 'scroll-state', payload: { x: 0, y: 320, scrollWidth: 500, clientWidth: 500, scrollHeight: 1600, clientHeight: 800 } },
      });
      ytext.delete(0, ytext.length);
      ytext.insert(0, '<p>second</p>');
    });
    await act(async () => {
      vi.advanceTimersByTime(0);
    });
    await act(async () => {});

    const framesWhileLoading = Array.from(container.querySelectorAll('iframe')) as HTMLIFrameElement[];
    expect(framesWhileLoading).toHaveLength(2);
    expect(framesWhileLoading[0]).toBe(activeFrame);
    expect(framesWhileLoading[0]).toHaveAttribute('data-preview-frame-state', 'active');
    expect(framesWhileLoading[1]).toHaveAttribute('data-preview-frame-state', 'loading');
    expect(framesWhileLoading[0].srcdoc).toContain('<p>first</p>');
    expect(framesWhileLoading[1].srcdoc).toContain('<p>second</p>');

    const replacementFrame = framesWhileLoading[1];
    const posted: unknown[] = [];
    const spy = vi.spyOn(replacementFrame.contentWindow!, 'postMessage').mockImplementation(
      ((msg: unknown) => { posted.push(msg); }) as typeof window.postMessage
    );

    try {
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', {
          data: { nonce: '', message: { type: 'ready', payload: {} } },
          source: replacementFrame.contentWindow,
        }));
      });

      expect(posted).toContainEqual({
        nonce: '__test_nonce__',
        message: { type: 'restore-scroll', payload: { x: 0, y: 320 } },
      });
      expect(activeFrame).toHaveAttribute('data-preview-frame-state', 'active');
      expect(replacementFrame).toHaveAttribute('data-preview-frame-state', 'loading');

      await act(async () => {
        dispatchFromBridge(replacementFrame, {
          nonce: '__test_nonce__',
          message: { type: 'scroll-state', payload: { x: 0, y: 320, scrollWidth: 500, clientWidth: 500, scrollHeight: 1600, clientHeight: 800 } },
        });
      });

      const finalFrames = Array.from(container.querySelectorAll('iframe')) as HTMLIFrameElement[];
      expect(finalFrames).toHaveLength(1);
      expect(finalFrames[0]).toBe(replacementFrame);
      expect(finalFrames[0]).toHaveAttribute('data-preview-frame-state', 'active');
      expect(finalFrames[0].srcdoc).toContain('<p>second</p>');
    } finally {
      spy.mockRestore();
    }
  });

  it('does not activate a stale replacement iframe after source reverts while loading', async () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>first</p>');

    const { container } = render(<HtmlPreview ytext={ytext} debounceMs={0} />);
    const activeFrame = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(activeFrame, {
        nonce: '__test_nonce__',
        message: { type: 'scroll-state', payload: { x: 0, y: 320, scrollWidth: 500, clientWidth: 500, scrollHeight: 1600, clientHeight: 800 } },
      });
      ytext.delete(0, ytext.length);
      ytext.insert(0, '<p>second</p>');
    });
    await act(async () => { vi.advanceTimersByTime(0); });
    await act(async () => {});

    const staleReplacementFrame = container.querySelector('iframe[data-preview-frame-state="loading"]') as HTMLIFrameElement;
    expect(staleReplacementFrame).not.toBeNull();
    expect(staleReplacementFrame.srcdoc).toContain('<p>second</p>');

    await act(async () => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, '<p>first</p>');
    });
    await act(async () => { vi.advanceTimersByTime(0); });
    await act(async () => {});

    let framesAfterRevert = Array.from(container.querySelectorAll('iframe')) as HTMLIFrameElement[];
    expect(framesAfterRevert).toHaveLength(1);
    expect(framesAfterRevert[0]).toBe(activeFrame);
    expect(framesAfterRevert[0]).toHaveAttribute('data-preview-frame-state', 'active');
    expect(framesAfterRevert[0].srcdoc).toContain('<p>first</p>');

    await act(async () => {
      dispatchFromBridge(staleReplacementFrame, {
        nonce: '__test_nonce__',
        message: { type: 'scroll-state', payload: { x: 0, y: 320, scrollWidth: 500, clientWidth: 500, scrollHeight: 1600, clientHeight: 800 } },
      });
    });

    framesAfterRevert = Array.from(container.querySelectorAll('iframe')) as HTMLIFrameElement[];
    expect(framesAfterRevert).toHaveLength(1);
    expect(framesAfterRevert[0]).toBe(activeFrame);
    expect(framesAfterRevert[0].srcdoc).toContain('<p>first</p>');
  });

  it('posts exact scroll coordinates to replacement iframes for source edits', async () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>first</p>');

    const { container } = render(<HtmlPreview ytext={ytext} debounceMs={0} />);
    const activeFrame = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(activeFrame, {
        nonce: '__test_nonce__',
        message: { type: 'scroll-state', payload: { x: 150, y: 320, scrollWidth: 900, clientWidth: 300, scrollHeight: 1600, clientHeight: 800 } },
      });
      ytext.delete(0, ytext.length);
      ytext.insert(0, '<p>second</p>');
    });
    await act(async () => { vi.advanceTimersByTime(0); });
    await act(async () => {});

    const replacementFrame = container.querySelector('iframe[data-preview-frame-state="loading"]') as HTMLIFrameElement;
    const posted: unknown[] = [];
    const spy = vi.spyOn(replacementFrame.contentWindow!, 'postMessage').mockImplementation(
      ((msg: unknown) => { posted.push(msg); }) as typeof window.postMessage
    );

    try {
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', {
          data: { nonce: '', message: { type: 'ready', payload: {} } },
          source: replacementFrame.contentWindow,
        }));
      });

      expect(posted).toContainEqual({
        nonce: '__test_nonce__',
        message: { type: 'restore-scroll', payload: { x: 150, y: 320 } },
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('restores details UI state to replacement iframe after source changes', async () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<details><summary>A</summary></details><details><summary>B</summary></details>');

    const { container } = render(<HtmlPreview ytext={ytext} debounceMs={0} />);
    const activeFrame = screen.getByTitle('HTML preview') as HTMLIFrameElement;
    const activePosted: unknown[] = [];
    const activeSpy = vi.spyOn(activeFrame.contentWindow!, 'postMessage').mockImplementation(
      ((msg: unknown) => { activePosted.push(msg); }) as typeof window.postMessage
    );

    try {
      await act(async () => {
        dispatchFromBridge(activeFrame, {
          nonce: '__test_nonce__',
          message: { type: 'scroll-state', payload: { x: 0, y: 0, scrollWidth: 500, clientWidth: 500, scrollHeight: 1000, clientHeight: 500 } },
        });
        ytext.insert(ytext.length, 'x');
      });
      await act(async () => { vi.advanceTimersByTime(0); });
      await act(async () => {});

      expect(activePosted).toContainEqual({
        nonce: '__test_nonce__',
        message: { type: 'capture-ui-state', payload: {} },
      });

      await act(async () => {
        dispatchFromBridge(activeFrame, {
          nonce: '__test_nonce__',
          message: { type: 'ui-state', payload: { details: [{ path: [1], open: true }] } },
        } as unknown as Envelope<BridgeToParent>);
      });

      const replacementFrame = container.querySelector('iframe[data-preview-frame-state="loading"]') as HTMLIFrameElement;
      expect(replacementFrame).not.toBeNull();
      const replacementPosted: unknown[] = [];
      const replacementSpy = vi.spyOn(replacementFrame.contentWindow!, 'postMessage').mockImplementation(
        ((msg: unknown) => { replacementPosted.push(msg); }) as typeof window.postMessage
      );

      try {
        await act(async () => {
          window.dispatchEvent(new MessageEvent('message', {
            data: { nonce: '', message: { type: 'ready', payload: {} } },
            source: replacementFrame.contentWindow,
          }));
        });

        expect(replacementPosted).toContainEqual({
          nonce: '__test_nonce__',
          message: { type: 'restore-ui-state', payload: { details: [{ path: [1], open: true }] } },
        });
      } finally {
        replacementSpy.mockRestore();
      }
    } finally {
      activeSpy.mockRestore();
    }
  });

  it('waits for details UI state before restoring replacement iframe scroll', async () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<details><summary>A</summary></details><details><summary>B</summary><p>expanded content</p></details>');

    const { container } = render(<HtmlPreview ytext={ytext} debounceMs={0} />);
    const activeFrame = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(activeFrame, {
        nonce: '__test_nonce__',
        message: { type: 'scroll-state', payload: { x: 0, y: 320, scrollWidth: 500, clientWidth: 500, scrollHeight: 1600, clientHeight: 800 } },
      });
      ytext.insert(ytext.length, 'x');
    });
    await act(async () => { vi.advanceTimersByTime(0); });
    await act(async () => {});

    const replacementFrame = container.querySelector('iframe[data-preview-frame-state="loading"]') as HTMLIFrameElement;
    expect(replacementFrame).not.toBeNull();
    const replacementPosted: unknown[] = [];
    const replacementSpy = vi.spyOn(replacementFrame.contentWindow!, 'postMessage').mockImplementation(
      ((msg: unknown) => { replacementPosted.push(msg); }) as typeof window.postMessage
    );

    try {
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', {
          data: { nonce: '', message: { type: 'ready', payload: {} } },
          source: replacementFrame.contentWindow,
        }));
      });

      expect(replacementPosted).toContainEqual({
        nonce: '__test_nonce__',
        message: { type: 'init', payload: {} },
      });
      expect(replacementPosted).not.toContainEqual({
        nonce: '__test_nonce__',
        message: { type: 'restore-scroll', payload: { x: 0, y: 320 } },
      });

      await act(async () => {
        dispatchFromBridge(activeFrame, {
          nonce: '__test_nonce__',
          message: { type: 'ui-state', payload: { details: [{ path: [1], open: true }] } },
        } as unknown as Envelope<BridgeToParent>);
      });

      const restoreUiIndex = replacementPosted.findIndex(message => JSON.stringify(message).includes('"restore-ui-state"'));
      const restoreScrollIndex = replacementPosted.findIndex(message => JSON.stringify(message).includes('"restore-scroll"'));
      expect(restoreUiIndex).toBeGreaterThanOrEqual(0);
      expect(restoreScrollIndex).toBeGreaterThan(restoreUiIndex);
      expect(replacementPosted).toContainEqual({
        nonce: '__test_nonce__',
        message: { type: 'restore-ui-state', payload: { details: [{ path: [1], open: true }] } },
      });
      expect(replacementPosted).toContainEqual({
        nonce: '__test_nonce__',
        message: { type: 'restore-scroll', payload: { x: 0, y: 320 } },
      });
    } finally {
      replacementSpy.mockRestore();
    }
  });

  it('activates the replacement iframe immediately when the hidden restore reaches the intended scroll', async () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>first</p>');

    const { container } = render(<HtmlPreview ytext={ytext} debounceMs={0} />);
    const activeFrame = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(activeFrame, {
        nonce: '__test_nonce__',
        message: { type: 'scroll-state', payload: { x: 0, y: 320, scrollWidth: 500, clientWidth: 500, scrollHeight: 1600, clientHeight: 800 } },
      });
      ytext.delete(0, ytext.length);
      ytext.insert(0, '<p>second</p>');
    });
    await act(async () => { vi.advanceTimersByTime(0); });
    await act(async () => {});

    const replacementFrame = container.querySelector('iframe[data-preview-frame-state="loading"]') as HTMLIFrameElement;
    const posted: unknown[] = [];
    const spy = vi.spyOn(replacementFrame.contentWindow!, 'postMessage').mockImplementation(
      ((msg: unknown) => { posted.push(msg); }) as typeof window.postMessage
    );

    try {
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', {
          data: { nonce: '', message: { type: 'ready', payload: {} } },
          source: replacementFrame.contentWindow,
        }));
      });
      posted.length = 0;

      await act(async () => {
        dispatchFromBridge(replacementFrame, {
          nonce: '__test_nonce__',
          message: { type: 'scroll-state', payload: { x: 0, y: 320, scrollWidth: 500, clientWidth: 500, scrollHeight: 1600, clientHeight: 800 } },
        });
      });
      await act(async () => { vi.runAllTimers(); });
      await act(async () => {});

      expect(container.querySelector('iframe[data-preview-frame-state="active"]')).toBe(replacementFrame);
      expect(posted).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not treat a hidden replacement iframe clamped scroll as the restore target', async () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>first</p>');

    const { container } = render(<HtmlPreview ytext={ytext} debounceMs={0} />);
    const activeFrame = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(activeFrame, {
        nonce: '__test_nonce__',
        message: { type: 'scroll-state', payload: { x: 0, y: 1697, scrollWidth: 500, clientWidth: 500, scrollHeight: 2600, clientHeight: 903 } },
      });
      ytext.delete(0, ytext.length);
      ytext.insert(0, '<p>second</p>');
    });
    await act(async () => { vi.advanceTimersByTime(0); });
    await act(async () => {});

    const replacementFrame = container.querySelector('iframe[data-preview-frame-state="loading"]') as HTMLIFrameElement;
    const posted: unknown[] = [];
    const spy = vi.spyOn(replacementFrame.contentWindow!, 'postMessage').mockImplementation(
      ((msg: unknown) => { posted.push(msg); }) as typeof window.postMessage
    );

    try {
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', {
          data: { nonce: '', message: { type: 'ready', payload: {} } },
          source: replacementFrame.contentWindow,
        }));
      });
      posted.length = 0;

      await act(async () => {
        dispatchFromBridge(replacementFrame, {
          nonce: '__test_nonce__',
          message: { type: 'scroll-state', payload: { x: 0, y: 479, scrollWidth: 500, clientWidth: 500, scrollHeight: 1382, clientHeight: 903 } },
        });
      });
      await act(async () => { vi.runAllTimers(); });
      await act(async () => {});

      expect(container.querySelector('iframe[data-preview-frame-state="active"]')).toBe(activeFrame);
      expect(replacementFrame).toHaveAttribute('data-preview-frame-state', 'settling');
      expect(posted).toContainEqual({
        nonce: '__test_nonce__',
        message: { type: 'restore-scroll', payload: { x: 0, y: 1697 } },
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps the old iframe visible while the promoted replacement settles at the intended scroll', async () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>first</p>');

    const { container } = render(<HtmlPreview ytext={ytext} debounceMs={0} />);
    const activeFrame = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(activeFrame, {
        nonce: '__test_nonce__',
        message: { type: 'scroll-state', payload: { x: 0, y: 1697, scrollWidth: 500, clientWidth: 500, scrollHeight: 2600, clientHeight: 903 } },
      });
      ytext.delete(0, ytext.length);
      ytext.insert(0, '<p>second</p>');
    });
    await act(async () => { vi.advanceTimersByTime(0); });
    await act(async () => {});

    const replacementFrame = container.querySelector('iframe[data-preview-frame-state="loading"]') as HTMLIFrameElement;
    const posted: unknown[] = [];
    const spy = vi.spyOn(replacementFrame.contentWindow!, 'postMessage').mockImplementation(
      ((msg: unknown) => { posted.push(msg); }) as typeof window.postMessage
    );

    try {
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', {
          data: { nonce: '', message: { type: 'ready', payload: {} } },
          source: replacementFrame.contentWindow,
        }));
      });
      posted.length = 0;

      await act(async () => {
        dispatchFromBridge(replacementFrame, {
          nonce: '__test_nonce__',
          message: { type: 'scroll-state', payload: { x: 0, y: 479, scrollWidth: 500, clientWidth: 500, scrollHeight: 1382, clientHeight: 903 } },
        });
      });
      await act(async () => { vi.runAllTimers(); });
      await act(async () => {});

      const framesWhileSettling = Array.from(container.querySelectorAll('iframe')) as HTMLIFrameElement[];
      expect(framesWhileSettling).toHaveLength(2);
      expect(activeFrame).toHaveAttribute('data-preview-frame-state', 'active');
      expect(replacementFrame).toHaveAttribute('data-preview-frame-state', 'settling');
      expect(replacementFrame).toHaveClass('opacity-0');
      expect(posted).toContainEqual({
        nonce: '__test_nonce__',
        message: { type: 'restore-scroll', payload: { x: 0, y: 1697 } },
      });

      await act(async () => {
        dispatchFromBridge(replacementFrame, {
          nonce: '__test_nonce__',
          message: { type: 'scroll-state', payload: { x: 0, y: 1697, scrollWidth: 500, clientWidth: 500, scrollHeight: 2600, clientHeight: 903 } },
        });
      });

      const finalFrames = Array.from(container.querySelectorAll('iframe')) as HTMLIFrameElement[];
      expect(finalFrames).toHaveLength(1);
      expect(finalFrames[0]).toBe(replacementFrame);
      expect(finalFrames[0]).toHaveAttribute('data-preview-frame-state', 'active');
    } finally {
      spy.mockRestore();
    }
  });

  it('ignores ready messages with a non-empty nonce', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->');

    render(<HtmlPreview ytext={ytext} debounceMs={0} />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;
    const spy = vi.spyOn(iframe.contentWindow!, 'postMessage');

    try {
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', {
          data: { nonce: '__test_nonce__', message: { type: 'ready', payload: {} } },
          source: iframe.contentWindow,
        }));
      });

      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('ignores ready messages from sources other than the iframe contentWindow', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->');

    render(<HtmlPreview ytext={ytext} debounceMs={0} />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;
    const spy = vi.spyOn(iframe.contentWindow!, 'postMessage');

    try {
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', {
          data: { nonce: '', message: { type: 'ready', payload: {} } },
        }));
      });

      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('ignores well-nonced messages whose payload is shape-invalid without throwing', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->');

    render(<HtmlPreview ytext={ytext} debounceMs={0} />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;
    let threw = false;

    await act(async () => {
      try {
        dispatchFromBridge(iframe, {
          nonce: '__test_nonce__',
          message: { type: 'thread-clicked', payload: { id: 42 as unknown as string } },
        });
      } catch {
        threw = true;
      }
    });

    expect(threw).toBe(false);
    expect(screen.queryByText('x')).toBeNull();
  });
});
