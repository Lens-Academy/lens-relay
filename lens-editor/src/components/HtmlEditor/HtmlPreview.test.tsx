// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act, screen } from '@testing-library/react';
import * as Y from 'yjs';
import { HtmlPreview } from './HtmlPreview';
import type { BridgeToParent, Envelope } from './bridge/protocol';

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
    const iframe = () => container.querySelector('iframe')!;

    await act(async () => {
      ytext.insert(0, '<p>first</p>');
    });

    await act(async () => { vi.advanceTimersByTime(100); });
    expect(iframe().getAttribute('srcdoc') ?? '').toContain('<script>');
    expect(iframe().getAttribute('srcdoc') ?? '').not.toContain('<p>first</p>');

    await act(async () => { vi.advanceTimersByTime(250); });
    expect(iframe().getAttribute('srcdoc')).toContain('<p>first</p>');

    await act(async () => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, '<p>second</p>');
    });
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(iframe().getAttribute('srcdoc')).toContain('<p>first</p>');
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(iframe().getAttribute('srcdoc')).toContain('<p>second</p>');
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
