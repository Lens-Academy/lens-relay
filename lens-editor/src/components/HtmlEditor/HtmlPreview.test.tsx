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

describe('HtmlPreview click-to-place', () => {
  it('right-click placement opens composer without mutating source', async () => {
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

    expect(screen.getByPlaceholderText(/add a comment/i)).toBeInTheDocument();
    expect(ytext.toString()).not.toContain('lens-comment');
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

    expect(screen.getByPlaceholderText(/add a comment/i)).toBeInTheDocument();

    await act(async () => {
      ytext.insert(0, '<p>remote edit</p>');
    });

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
