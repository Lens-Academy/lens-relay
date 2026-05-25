// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act, screen, waitFor, renderHook, fireEvent } from '@testing-library/react';
import * as Y from 'yjs';
import { HtmlPreview, useHiddenProbeRunner } from './HtmlPreview';
import { parseComments } from './comment-store';
import type { BridgeToParent, Envelope } from './bridge/protocol';
import type { ProbeRunner } from './position-finder';

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

  it('renders a sandboxed iframe with ONLY the allow-scripts token (no allow-same-origin)', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<h1>Hello</h1>');

    const { container } = render(<HtmlPreview ytext={ytext} />);
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    const sandbox = iframe!.getAttribute('sandbox') ?? '';
    expect(sandbox).toBe('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
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
  it('opens the comment thread popover when bridge reports dot-clicked', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>Hi</p><!--lens-comment {"id":"c1","author":"me@x","ts":"t","body":"question"}-->');

    render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: '__test_nonce__',
        message: { type: 'dot-clicked', payload: { id: 'c1' } },
      });
    });

    expect(screen.getByText('question')).toBeInTheDocument();
  });

  it('opens existing comment threads read-only without allowing edits or replies', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>Hi</p><!--lens-comment {"id":"c1","author":"me@x","ts":"t","body":"question"}-->');

    render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} readOnly />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: '__test_nonce__',
        message: { type: 'dot-clicked', payload: { id: 'c1' } },
      });
    });

    expect(screen.getByText('question')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /reply/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(parseComments(ytext.toString())[0].comment.body).toBe('question');
    expect(parseComments(ytext.toString())[0].replies).toEqual([]);
  });

  it('ignores bridge messages from sources other than the iframe contentWindow', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->');

    render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);

    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { nonce: '__test_nonce__', message: { type: 'dot-clicked', payload: { id: 'c1' } } },
      }));
    });

    expect(screen.queryByText('x')).toBeNull();
  });

  it('ignores bridge messages from a concrete wrong iframe contentWindow', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->');

    render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
    const wrongIframe = document.createElement('iframe');
    document.body.appendChild(wrongIframe);

    try {
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', {
          data: { nonce: '__test_nonce__', message: { type: 'dot-clicked', payload: { id: 'c1' } } },
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

    render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: 'wrong',
        message: { type: 'dot-clicked', payload: { id: 'c1' } },
      });
    });

    expect(screen.queryByText('x')).toBeNull();
  });

  it('calls onOrphanedChange with reported string orphan ids', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->');
    const orphans: string[][] = [];

    render(
      <HtmlPreview
        ytext={ytext}
        currentUser="me@x"
        origin={Symbol()}
        debounceMs={0}
        onOrphanedChange={ids => orphans.push(ids)}
      />
    );
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: '__test_nonce__',
        message: {
          type: 'comments-rendered',
          payload: { found: [], orphaned: ['c1', 42 as unknown as string] },
        },
      });
    });

    expect(orphans.at(-1)).toEqual(['c1']);
  });

  it('applies comments-rendered reports from a replacement iframe when it becomes active', async () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>first</p><!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->');
    const orphans: string[][] = [];

    const { container } = render(
      <HtmlPreview
        ytext={ytext}
        currentUser="me@x"
        origin={Symbol()}
        debounceMs={0}
        onOrphanedChange={ids => orphans.push(ids)}
      />
    );
    const activeFrame = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(activeFrame, {
        nonce: '__test_nonce__',
        message: {
          type: 'comments-rendered',
          payload: { found: [], orphaned: ['c1'] },
        },
      });
      dispatchFromBridge(activeFrame, {
        nonce: '__test_nonce__',
        message: { type: 'scroll-state', payload: { x: 0, y: 0, scrollWidth: 500, clientWidth: 500, scrollHeight: 1000, clientHeight: 500 } },
      });
      ytext.delete(0, ytext.length);
      ytext.insert(0, '<p>second [[@comment:c1]]<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}--></p>');
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
      dispatchFromBridge(replacementFrame, {
        nonce: '__test_nonce__',
        message: {
          type: 'comments-rendered',
          payload: { found: ['c1'], orphaned: [] },
        },
      });
    });
    expect(orphans.at(-1)).toEqual(['c1']);

    await act(async () => {
      dispatchFromBridge(replacementFrame, {
        nonce: '__test_nonce__',
        message: { type: 'scroll-state', payload: { x: 0, y: 0, scrollWidth: 500, clientWidth: 500, scrollHeight: 1000, clientHeight: 500 } },
      });
    });

    expect(container.querySelector('iframe[data-preview-frame-state="active"]')).toBe(replacementFrame);
    expect(orphans.at(-1)).toEqual([]);
  });

  it('responds to bridge ready by posting init back to the iframe contentWindow', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->');

    render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
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
      expect(init?.message.payload).toEqual({ comments: [{ id: 'c1', body: 'x', replies: 0 }] });
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps the current iframe visible until the replacement iframe restores scroll', async () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>first</p>');

    const { container } = render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
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

    const { container } = render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
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

    const { container } = render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
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

    const { container } = render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
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

    const { container } = render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
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
        message: { type: 'init', payload: { comments: [] } },
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

    const { container } = render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
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

    const { container } = render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
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

    const { container } = render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
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

    render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
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

    render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
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

    render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;
    let threw = false;

    await act(async () => {
      try {
        dispatchFromBridge(iframe, {
          nonce: '__test_nonce__',
          message: { type: 'dot-clicked', payload: { id: 42 as unknown as string } },
        });
      } catch {
        threw = true;
      }
    });

    expect(threw).toBe(false);
    expect(screen.queryByText('x')).toBeNull();
  });
});

describe('HtmlPreview click-to-place', () => {
  it('right-click placement shows an action menu without mutating source', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>Hello world</p>');

    render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: '__test_nonce__',
        message: {
          type: 'placement-requested',
          payload: {
            trigger: 'contextmenu',
            fingerprint: {
              before: '',
              after: 'Hello world',
              tag: 'p',
              ancestorPath: [{ tag: 'p', index: 0 }],
              clickRect: { x: 20, y: 30, w: 120, h: 20 },
            },
            point: { x: 20, y: 30 },
            scroll: { x: 0, y: 100 },
          },
        },
      });
      await Promise.resolve();
    });

    expect(screen.getByRole('button', { name: 'Create comment' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add marker' })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/add a comment/i)).not.toBeInTheDocument();
    expect(ytext.toString()).not.toContain('lens-comment');
  });

  it('create comment from the placement menu opens composer without mutating source', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>Hello world</p>');

    render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: '__test_nonce__',
        message: {
          type: 'placement-requested',
          payload: {
            trigger: 'contextmenu',
            fingerprint: {
              before: '',
              after: 'Hello world',
              tag: 'p',
              ancestorPath: [{ tag: 'p', index: 0 }],
              clickRect: { x: 20, y: 30, w: 120, h: 20 },
            },
            point: { x: 20, y: 30 },
            scroll: { x: 0, y: 100 },
          },
        },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create comment' }));
      await Promise.resolve();
    });

    expect(screen.getByPlaceholderText(/add a comment/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create comment' })).not.toBeInTheDocument();
    expect(ytext.toString()).not.toContain('lens-comment');
  });

  it('selection placement shows the same action menu before opening composer', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>Hello world</p>');

    render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: '__test_nonce__',
        message: {
          type: 'placement-requested',
          payload: {
            trigger: 'selection',
            fingerprint: {
              before: 'Hello ',
              after: 'world',
              tag: 'p',
              ancestorPath: [{ tag: 'p', index: 0 }],
              clickRect: { x: 20, y: 30, w: 120, h: 20 },
            },
            point: { x: 42, y: 44 },
            scroll: { x: 0, y: 100 },
          },
        },
      });
    });

    expect(screen.getByRole('button', { name: 'Create comment' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add marker' })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/add a comment/i)).not.toBeInTheDocument();
  });

  it('add marker from the placement menu inserts a visible diagnostic token without creating a comment', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>Hello world</p>');

    render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: '__test_nonce__',
        message: {
          type: 'placement-requested',
          payload: {
            trigger: 'contextmenu',
            fingerprint: {
              before: '',
              after: 'Hello world',
              tag: 'p',
              ancestorPath: [{ tag: 'p', index: 0 }],
              clickRect: { x: 20, y: 30, w: 120, h: 20 },
            },
            point: { x: 20, y: 30 },
            scroll: { x: 0, y: 100 },
          },
        },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add marker' }));
      await Promise.resolve();
    });

    expect(ytext.toString()).toBe('<p>[[@1]]Hello world</p>');
    expect(parseComments(ytext.toString())).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Add marker' })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/add a comment/i)).not.toBeInTheDocument();
  });

  it('add marker uses shortened context when rendered list text differs from source markdown', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    const source = '<div>Specific details like:\n     - file names\n     - full code snippets</div>';
    ytext.insert(0, source);

    render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: '__test_nonce__',
        message: {
          type: 'placement-requested',
          payload: {
            trigger: 'contextmenu',
            fingerprint: {
              before: 'Specific details like:file ',
              after: 'namesfull code snippets',
              tag: 'li',
              ancestorPath: [{ tag: 'li', index: 0 }],
              clickRect: { x: 20, y: 30, w: 120, h: 20 },
            },
            point: { x: 20, y: 30 },
            scroll: { x: 0, y: 100 },
          },
        },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add marker' }));
      await Promise.resolve();
    });

    expect(ytext.toString()).toBe(source.replace('file names', 'file [[@1]]names'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a visible placement error when add marker cannot find a source match', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>foo</p>');

    render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: '__test_nonce__',
        message: {
          type: 'placement-requested',
          payload: {
            trigger: 'contextmenu',
            fingerprint: {
              before: 'missing ',
              after: 'text',
              tag: 'p',
              ancestorPath: [{ tag: 'p', index: 0 }],
              clickRect: { x: 20, y: 30, w: 120, h: 20 },
            },
            point: { x: 20, y: 30 },
            scroll: { x: 0, y: 100 },
          },
        },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add marker' }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole('alert')).toHaveTextContent(/couldn't find/i);
    expect(ytext.toString()).toBe('<p>foo</p>');
  });

  it('read-only placement requests do not open composer or mutate source', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>Hello world</p>');

    render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} readOnly />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: '__test_nonce__',
        message: {
          type: 'placement-requested',
          payload: {
            trigger: 'contextmenu',
            fingerprint: {
              before: '',
              after: 'Hello world',
              tag: 'p',
              ancestorPath: [{ tag: 'p', index: 0 }],
              clickRect: { x: 20, y: 30, w: 120, h: 20 },
            },
            point: { x: 20, y: 30 },
            scroll: { x: 0, y: 100 },
          },
        },
      });
      await Promise.resolve();
    });

    expect(screen.queryByRole('button', { name: 'Create comment' })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/add a comment/i)).not.toBeInTheDocument();
    expect(ytext.toString()).not.toContain('lens-comment');
  });

  it('submitting contextual composer writes root comment body once', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>Hello world</p>');
    const onPlace = vi.fn();

    render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} onPlaceComplete={onPlace} />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: '__test_nonce__',
        message: {
          type: 'placement-requested',
          payload: {
            trigger: 'contextmenu',
            fingerprint: {
              before: '',
              after: 'Hello world',
              tag: 'p',
              ancestorPath: [{ tag: 'p', index: 0 }],
              clickRect: { x: 20, y: 30, w: 120, h: 20 },
            },
            point: { x: 20, y: 30 },
            scroll: { x: 0, y: 100 },
          },
        },
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create comment' }));

    expect(onPlace).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText(/add a comment/i), {
      target: { value: 'real comment' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

    const clusters = parseComments(ytext.toString());
    expect(clusters).toHaveLength(1);
    expect(clusters[0].comment.body).toBe('real comment');
    expect(clusters[0].replies).toEqual([]);
    expect(onPlace).toHaveBeenCalledTimes(1);
    expect(onPlace).toHaveBeenCalledWith(clusters[0].comment.id);
  });

  it('cancelling contextual composer writes no marker', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>Hello world</p>');

    render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: '__test_nonce__',
        message: {
          type: 'placement-requested',
          payload: {
            trigger: 'contextmenu',
            fingerprint: {
              before: '',
              after: 'Hello world',
              tag: 'p',
              ancestorPath: [{ tag: 'p', index: 0 }],
              clickRect: { x: 20, y: 30, w: 120, h: 20 },
            },
            point: { x: 20, y: 30 },
            scroll: { x: 0, y: 100 },
          },
        },
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create comment' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(ytext.toString()).not.toContain('lens-comment');
  });

  it('clears pending contextual composer when source changes before submit', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>Hello world</p>');

    render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: '__test_nonce__',
        message: {
          type: 'placement-requested',
          payload: {
            trigger: 'contextmenu',
            fingerprint: {
              before: '',
              after: 'Hello world',
              tag: 'p',
              ancestorPath: [{ tag: 'p', index: 0 }],
              clickRect: { x: 20, y: 30, w: 120, h: 20 },
            },
            point: { x: 20, y: 30 },
            scroll: { x: 0, y: 100 },
          },
        },
      });
    });

    expect(screen.getByRole('button', { name: 'Create comment' })).toBeInTheDocument();

    await act(async () => {
      ytext.insert(0, '<p>remote edit</p>');
    });

    expect(screen.queryByRole('button', { name: 'Create comment' })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/add a comment/i)).not.toBeInTheDocument();
    expect(ytext.toString()).not.toContain('lens-comment');
  });

  it('does not submit contextual composer at a stale source position', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>Hello world</p>');

    render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: '__test_nonce__',
        message: {
          type: 'placement-requested',
          payload: {
            trigger: 'contextmenu',
            fingerprint: {
              before: '',
              after: 'Hello world',
              tag: 'p',
              ancestorPath: [{ tag: 'p', index: 0 }],
              clickRect: { x: 20, y: 30, w: 120, h: 20 },
            },
            point: { x: 20, y: 30 },
            scroll: { x: 0, y: 100 },
          },
        },
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create comment' }));

    fireEvent.change(screen.getByPlaceholderText(/add a comment/i), {
      target: { value: 'stale comment' },
    });
    const submit = screen.getByRole('button', { name: 'Comment' });

    act(() => {
      ytext.insert(0, '<p>remote edit</p>');
      fireEvent.click(submit);
    });

    expect(parseComments(ytext.toString())).toEqual([]);
  });

  it('posts saved scroll after submit when iframe reports ready again', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>Hello world</p>');

    render(<HtmlPreview ytext={ytext} currentUser="me@x" origin={Symbol()} debounceMs={0} />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;
    const posted: unknown[] = [];
    const spy = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(
      ((msg: unknown) => { posted.push(msg); }) as typeof window.postMessage
    );

    try {
      await act(async () => {
        dispatchFromBridge(iframe, {
          nonce: '__test_nonce__',
          message: {
            type: 'placement-requested',
            payload: {
              trigger: 'contextmenu',
              fingerprint: {
                before: '',
                after: 'Hello world',
                tag: 'p',
                ancestorPath: [{ tag: 'p', index: 0 }],
                clickRect: { x: 20, y: 30, w: 120, h: 20 },
              },
              point: { x: 20, y: 30 },
              scroll: { x: 0, y: 100 },
            },
          },
        });
      });

      fireEvent.click(screen.getByRole('button', { name: 'Create comment' }));

      fireEvent.change(screen.getByPlaceholderText(/add a comment/i), {
        target: { value: 'real comment' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', {
          data: { nonce: '', message: { type: 'ready', payload: {} } },
          source: iframe.contentWindow,
        }));
      });

      expect(posted).toContainEqual({
        nonce: '__test_nonce__',
        message: { type: 'restore-scroll', payload: { x: 0, y: 100 } },
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('sends click-to-place mode changes to the bridge with exact empty payloads', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>Hi</p>');

    const { rerender } = render(<HtmlPreview ytext={ytext} isCommentMode={false} />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;
    const posted: unknown[] = [];
    const spy = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(
      ((msg: unknown) => { posted.push(msg); }) as typeof window.postMessage
    );

    try {
      rerender(<HtmlPreview ytext={ytext} isCommentMode={true} />);
      rerender(<HtmlPreview ytext={ytext} isCommentMode={false} />);

      expect(posted).toContainEqual({
        nonce: '__test_nonce__',
        message: { type: 'enable-click-to-place', payload: {} },
      });
      expect(posted).toContainEqual({
        nonce: '__test_nonce__',
        message: { type: 'disable-click-to-place', payload: {} },
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('toolbar click-to-place opens composer before writing marker', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>click here</p>');

    render(
      <HtmlPreview
        ytext={ytext}
        currentUser="me@x"
        origin={Symbol()}
        debounceMs={0}
        isCommentMode
      />
    );
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: '__test_nonce__',
        message: {
          type: 'click-captured',
          payload: {
            fingerprint: {
              before: 'click ',
              after: 'here',
              tag: 'p',
              ancestorPath: [],
              clickRect: { x: 20, y: 30, w: 100, h: 20 },
            },
          },
        },
      });
    });

    expect(screen.getByPlaceholderText(/add a comment/i)).toBeInTheDocument();
    expect(ytext.toString()).not.toContain('lens-comment');
  });

  it('ignores click-captured when comment mode is disabled or fingerprint shape is invalid', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>unique words here</p>');

    render(<HtmlPreview ytext={ytext} currentUser="me@x" debounceMs={0} isCommentMode={false} />);
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: '__test_nonce__',
        message: {
          type: 'click-captured',
          payload: {
            fingerprint: {
              before: 'unique ',
              after: 'words',
              tag: 'p',
              ancestorPath: [],
              clickRect: { x: 0, y: 0, w: 10, h: 10 },
            },
          },
        },
      });
      dispatchFromBridge(iframe, {
        nonce: '__test_nonce__',
        message: {
          type: 'click-captured',
          payload: { fingerprint: { before: 1 as unknown as string } },
        },
      });
    });

    expect(parseComments(ytext.toString())).toEqual([]);
  });

  it('falls back to manual placement when every probe candidate misses the click rect', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>click here</p><p>click here</p>');
    const onManual = vi.fn();
    const missRunner: ProbeRunner = {
      async run() { return { x: -1000, y: -1000, w: 1, h: 1 }; },
      dispose() {},
    };

    render(
      <HtmlPreview
        ytext={ytext}
        currentUser="me@x"
        origin={Symbol()}
        debounceMs={0}
        isCommentMode={true}
        onManualPlacement={onManual}
        probeRunner={missRunner}
      />
    );
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: '__test_nonce__',
        message: {
          type: 'click-captured',
          payload: {
            fingerprint: {
              before: 'click ',
              after: 'here',
              tag: 'p',
              ancestorPath: [],
              clickRect: { x: 9999, y: 9999, w: 1, h: 1 },
            },
          },
        },
      });
      await Promise.resolve();
    });

    expect(onManual).toHaveBeenCalledWith([
      { position: 9, score: 10 },
      { position: 26, score: 10 },
    ]);
    expect(parseComments(ytext.toString())).toEqual([]);
  });

  it('opens composer when the injected probe runner reports a rect overlap', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>click here</p><p>click here</p>');
    const onPlace = vi.fn();
    const hitRunner: ProbeRunner = {
      async run() { return { x: 95, y: 45, w: 20, h: 20 }; },
      dispose() {},
    };

    render(
      <HtmlPreview
        ytext={ytext}
        currentUser="me@x"
        origin={Symbol()}
        debounceMs={0}
        isCommentMode={true}
        onPlaceComplete={onPlace}
        probeRunner={hitRunner}
      />
    );
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: '__test_nonce__',
        message: {
          type: 'click-captured',
          payload: {
            fingerprint: {
              before: 'click ',
              after: 'here',
              tag: 'p',
              ancestorPath: [],
              clickRect: { x: 100, y: 50, w: 10, h: 10 },
            },
          },
        },
      });
      await Promise.resolve();
    });

    expect(screen.getByPlaceholderText(/add a comment/i)).toBeInTheDocument();
    expect(parseComments(ytext.toString())).toEqual([]);
    expect(onPlace).not.toHaveBeenCalled();
  });

  it('does not place or notify when comment mode is disabled before async probe resolves', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>click here</p><p>click here</p>');
    const onPlace = vi.fn();
    const onManual = vi.fn();
    let resolveProbe: ((rect: { x: number; y: number; w: number; h: number } | null) => void) | undefined;
    const runner: ProbeRunner = {
      run: vi.fn(() => new Promise(resolve => { resolveProbe = resolve; })),
      dispose() {},
    };

    const { rerender } = render(
      <HtmlPreview
        ytext={ytext}
        currentUser="me@x"
        origin={Symbol()}
        debounceMs={0}
        isCommentMode={true}
        onPlaceComplete={onPlace}
        onManualPlacement={onManual}
        probeRunner={runner}
      />
    );
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: '__test_nonce__',
        message: {
          type: 'click-captured',
          payload: {
            fingerprint: {
              before: 'click ',
              after: 'here',
              tag: 'p',
              ancestorPath: [],
              clickRect: { x: 100, y: 50, w: 10, h: 10 },
            },
          },
        },
      });
      await Promise.resolve();
    });

    rerender(
      <HtmlPreview
        ytext={ytext}
        currentUser="me@x"
        origin={Symbol()}
        debounceMs={0}
        isCommentMode={false}
        onPlaceComplete={onPlace}
        onManualPlacement={onManual}
        probeRunner={runner}
      />
    );

    await act(async () => {
      resolveProbe?.({ x: 95, y: 45, w: 20, h: 20 });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(parseComments(ytext.toString())).toEqual([]);
    expect(onPlace).not.toHaveBeenCalled();
    expect(onManual).not.toHaveBeenCalled();
  });

  it('does not place or notify when Y.Text changes before async probe resolves', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>click here</p><p>click here</p>');
    const onPlace = vi.fn();
    const onManual = vi.fn();
    let resolveProbe: ((rect: { x: number; y: number; w: number; h: number } | null) => void) | undefined;
    const runner: ProbeRunner = {
      run: vi.fn(() => new Promise(resolve => { resolveProbe = resolve; })),
      dispose() {},
    };

    render(
      <HtmlPreview
        ytext={ytext}
        currentUser="me@x"
        origin={Symbol()}
        debounceMs={0}
        isCommentMode={true}
        onPlaceComplete={onPlace}
        onManualPlacement={onManual}
        probeRunner={runner}
      />
    );
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: '__test_nonce__',
        message: {
          type: 'click-captured',
          payload: {
            fingerprint: {
              before: 'click ',
              after: 'here',
              tag: 'p',
              ancestorPath: [],
              clickRect: { x: 100, y: 50, w: 10, h: 10 },
            },
          },
        },
      });
      await Promise.resolve();
    });

    await act(async () => {
      ytext.insert(0, '<p>remote edit</p>');
    });

    await act(async () => {
      resolveProbe?.({ x: 95, y: 45, w: 20, h: 20 });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(ytext.toString()).not.toContain('lens-comment');
    expect(parseComments(ytext.toString())).toEqual([]);
    expect(onPlace).not.toHaveBeenCalled();
    expect(onManual).not.toHaveBeenCalled();
  });

  it('does not mutate or notify when an injected probe runner rejects', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>click here</p><p>click here</p>');
    const onPlace = vi.fn();
    const onManual = vi.fn();
    const runner: ProbeRunner = {
      run: vi.fn(async () => { throw new Error('probe failed'); }),
      dispose() {},
    };

    render(
      <HtmlPreview
        ytext={ytext}
        currentUser="me@x"
        origin={Symbol()}
        debounceMs={0}
        isCommentMode={true}
        onPlaceComplete={onPlace}
        onManualPlacement={onManual}
        probeRunner={runner}
      />
    );
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: '__test_nonce__',
        message: {
          type: 'click-captured',
          payload: {
            fingerprint: {
              before: 'click ',
              after: 'here',
              tag: 'p',
              ancestorPath: [],
              clickRect: { x: 100, y: 50, w: 10, h: 10 },
            },
          },
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(parseComments(ytext.toString())).toEqual([]);
    expect(onPlace).not.toHaveBeenCalled();
    expect(onManual).not.toHaveBeenCalled();
  });
});

describe('useHiddenProbeRunner orchestration (parent-side)', () => {
  it('sizes the hidden probe iframe to the visible preview viewport', async () => {
    vi.useRealTimers();
    const { result, unmount } = renderHook(() => useHiddenProbeRunner(
      '__test_nonce__',
      () => ({ width: 640, height: 360 })
    ));

    const pending = result.current.run('<body><!--lens-probe TV--></body>', 'TV');

    await waitFor(() => expect(document.querySelectorAll('iframe[style*="-9999px"]')).toHaveLength(1));
    const frame = document.querySelector('iframe[style*="-9999px"]') as HTMLIFrameElement;
    expect(frame.style.width).toBe('640px');
    expect(frame.style.height).toBe('360px');

    unmount();
    await expect(pending).resolves.toBeNull();
  });

  it('resolves concurrent .run() calls to their respective rects and disposes cleanly', async () => {
    vi.useRealTimers();
    const { result, unmount } = renderHook(() => useHiddenProbeRunner('__test_nonce__'));
    const runner = result.current;

    const pA = runner.run('<body><!--lens-probe TA--></body>', 'TA');
    const pB = runner.run('<body><!--lens-probe TB--></body>', 'TB');

    await waitFor(() => expect(document.querySelectorAll('iframe[style*="-9999px"]')).toHaveLength(2));
    const [frameA, frameB] = Array.from(document.querySelectorAll('iframe[style*="-9999px"]')) as HTMLIFrameElement[];
    expect(frameA.srcdoc).toContain('<!--lens-probe TA-->');
    expect(frameB.srcdoc).toContain('<!--lens-probe TB-->');

    window.dispatchEvent(new MessageEvent('message', {
      data: { nonce: '', message: { type: 'ready', payload: {} } },
      source: frameA.contentWindow,
    }));
    window.dispatchEvent(new MessageEvent('message', {
      data: { nonce: '', message: { type: 'ready', payload: {} } },
      source: frameB.contentWindow,
    }));
    await Promise.resolve();
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        nonce: '__test_nonce__',
        message: { type: 'probe-found', payload: { token: 'TA', rect: { x: 10, y: 10, w: 10, h: 10 } } },
      },
      source: frameA.contentWindow,
    }));
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        nonce: '__test_nonce__',
        message: { type: 'probe-found', payload: { token: 'TB', rect: { x: 20, y: 20, w: 10, h: 10 } } },
      },
      source: frameB.contentWindow,
    }));

    await expect(Promise.all([pA, pB])).resolves.toEqual([
      { x: 10, y: 10, w: 10, h: 10 },
      { x: 20, y: 20, w: 10, h: 10 },
    ]);

    unmount();
    expect(document.querySelectorAll('iframe[style*="-9999px"]')).toHaveLength(0);
  });

  it('resolves to null when bridge ready never arrives', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useHiddenProbeRunner('__test_nonce__'));
    const p = result.current.run('<body><!--lens-probe X--></body>', 'X');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    await expect(p).resolves.toBeNull();
  });

  it('resolves to null when bridge ready arrives but probe-found does not', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useHiddenProbeRunner('__test_nonce__'));
    const p = result.current.run('<body><!--lens-probe Y--></body>', 'Y');
    const frame = document.querySelector('iframe[style*="-9999px"]') as HTMLIFrameElement;

    window.dispatchEvent(new MessageEvent('message', {
      data: { nonce: '', message: { type: 'ready', payload: {} } },
      source: frame.contentWindow,
    }));
    await Promise.resolve();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });

    await expect(p).resolves.toBeNull();
  });
});
