// @vitest-environment happy-dom
import type { ComponentProps } from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorView } from 'codemirror';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { HtmlEditor } from './HtmlEditor';
import { DisplayNameProvider } from '../../contexts/DisplayNameContext';
import { parseComments } from './comment-store';
import type { BridgeToParent, Envelope } from './bridge/protocol';
import type { ProbeRunner } from './position-finder';

vi.mock('./bridge/protocol', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bridge/protocol')>();
  return { ...actual, makeNonce: () => '__test_nonce__' };
});

function renderWithDoc() {
  const doc = new Y.Doc();
  const ytext = doc.getText('contents');
  ytext.insert(0, '<h1>Test</h1>');
  const awareness = new Awareness(doc);
  return render(
    <DisplayNameProvider>
      <HtmlEditor ytext={ytext} awareness={awareness} currentUser="me@x" />
    </DisplayNameProvider>
  );
}

function createHtmlDoc() {
  const doc = new Y.Doc();
  const ytext = doc.getText('contents');
  ytext.insert(0, '<h1>Test</h1>');
  const awareness = new Awareness(doc);
  return { ytext, awareness };
}

function dispatchFromBridge(iframe: HTMLIFrameElement, env: Envelope<BridgeToParent>): void {
  window.dispatchEvent(new MessageEvent('message', { data: env, source: iframe.contentWindow }));
}

async function triggerManualPlacementFallback() {
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
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull());
  await waitFor(() => {
    expect(document.querySelectorAll('.cm-lens-candidate').length).toBeGreaterThanOrEqual(2);
  });
}

async function openManualSourceComposer(
  ytext: Y.Text,
  awareness: Awareness,
  props: Partial<ComponentProps<typeof HtmlEditor>> = {},
) {
  const runner: ProbeRunner = {
    async run() { return null; },
    dispose() {},
  };
  const posAtCoords = vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue(3);
  const view = render(
    <DisplayNameProvider>
      <HtmlEditor
        ytext={ytext}
        awareness={awareness}
        currentUser="me@x"
        probeRunner={runner}
        {...props}
      />
    </DisplayNameProvider>,
  );

  fireEvent.click(screen.getByRole('button', { name: /comment mode/i }));

  const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', {
      source: iframe.contentWindow,
      data: {
        nonce: '__test_nonce__',
        message: {
          type: 'click-captured',
          payload: {
            fingerprint: {
              before: 'click ',
              after: 'here',
              tag: 'p',
              ancestorPath: [],
              clickRect: { x: 10, y: 10, w: 20, h: 20 },
            },
          },
        },
      },
    }));
    await Promise.resolve();
  });

  const highlighted = document.querySelector('.cm-lens-candidate') as HTMLElement;
  await act(async () => {
    highlighted.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 120, clientY: 80 }));
  });

  return { posAtCoords, ...view };
}

// Several tests below are .skipped because the visible "Comment" toolbar
// button was removed (user-facing entry point pending redesign). The
// underlying commentMode mechanism still exists; once a new entry point
// (header action, keyboard shortcut, or sidebar affordance) lands, switch
// the helpers to drive it and re-enable these tests.
describe('HtmlEditor', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('defaults to preview mode (iframe visible, source pane hidden)', () => {
    const { container } = renderWithDoc();
    expect(container.querySelector('iframe')).not.toBeNull();
    expect(container.querySelector('.cm-editor')).toBeNull();
  });

  it('switching to source mode shows the source pane and hides preview', async () => {
    const { container } = renderWithDoc();
    await userEvent.click(screen.getByRole('button', { name: /^Source$/ }));
    expect(container.querySelector('.cm-editor')).not.toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('makes source mode non-editable when readOnly is true', async () => {
    const { ytext, awareness } = createHtmlDoc();
    const { container } = render(
      <DisplayNameProvider>
        <HtmlEditor ytext={ytext} awareness={awareness} currentUser="me@x" readOnly />
      </DisplayNameProvider>
    );

    await userEvent.click(screen.getByRole('button', { name: /source/i }));

    expect(container.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false');
  });

  it('switching to split mode shows both source and preview', async () => {
    const { container } = renderWithDoc();
    await userEvent.click(screen.getByRole('button', { name: /split/i }));
    expect(container.querySelector('.cm-editor')).not.toBeNull();
    expect(container.querySelector('iframe')).not.toBeNull();
  });

  it('toggle highlights the active mode', async () => {
    renderWithDoc();
    const sourceBtn = screen.getByRole('button', { name: /source/i });
    const previewBtn = screen.getByRole('button', { name: /preview/i });

    expect(previewBtn.getAttribute('aria-pressed')).toBe('true');
    expect(sourceBtn.getAttribute('aria-pressed')).toBe('false');

    await userEvent.click(sourceBtn);

    expect(previewBtn.getAttribute('aria-pressed')).toBe('false');
    expect(sourceBtn.getAttribute('aria-pressed')).toBe('true');
  });

  it('preview pane is bound to the SAME Y.Text instance the parent owns', async () => {
    vi.useFakeTimers();
    try {
      const doc = new Y.Doc();
      const ytext = doc.getText('contents');
      const awareness = new Awareness(doc);

      const { container } = render(
        <DisplayNameProvider>
          <HtmlEditor ytext={ytext} awareness={awareness} currentUser="me@x" />
        </DisplayNameProvider>
      );

      await act(async () => { ytext.insert(0, '<p>shared</p>'); });
      await act(async () => { vi.advanceTimersByTime(400); });

      const iframes = Array.from(container.querySelectorAll('iframe'));
      expect(iframes.some(iframe => iframe.getAttribute('srcdoc')?.includes('<p>shared</p>'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.skip('comment-mode toggle button toggles aria-pressed state', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    const awareness = new Awareness(doc);
    render(
      <DisplayNameProvider>
        <HtmlEditor ytext={ytext} awareness={awareness} currentUser="me@x" />
      </DisplayNameProvider>
    );
    const btn = screen.getByRole('button', { name: /comment mode/i });

    expect(btn).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(btn);

    expect(btn).toHaveAttribute('aria-pressed', 'true');
  });

  it('orphan badge displays the count from HtmlPreview', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(
      0,
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->' +
        '<!--lens-comment {"id":"c2","author":"a","ts":"t","body":"y"}-->',
    );
    const awareness = new Awareness(doc);
    render(
      <DisplayNameProvider>
        <HtmlEditor ytext={ytext} awareness={awareness} currentUser="me@x" />
      </DisplayNameProvider>
    );
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: '__test_nonce__',
        message: { type: 'comments-rendered', payload: { found: [], orphaned: ['c1', 'c2'] } },
      });
    });

    expect(screen.getByText(/2 orphan/i)).toBeInTheDocument();
  });

  it.skip('uses DisplayNameProvider for new comment authors when currentUser prop is omitted', async () => {
    localStorage.setItem('lens-editor-display-name', 'Luc');
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>unique words here</p>');
    const awareness = new Awareness(doc);
    render(
      <DisplayNameProvider>
        <HtmlEditor ytext={ytext} awareness={awareness} />
      </DisplayNameProvider>
    );

    await userEvent.click(screen.getByRole('button', { name: /comment mode/i }));
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
    });

    fireEvent.change(screen.getByPlaceholderText(/add a comment/i), {
      target: { value: 'display name check' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

    expect(parseComments(ytext.toString())[0].comment.author).toBe('Luc');
  });

  it.skip('toolbar click-to-place keeps comment mode active until composer submit', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>click here</p>');
    const awareness = new Awareness(doc);

    render(
      <DisplayNameProvider>
        <HtmlEditor ytext={ytext} awareness={awareness} currentUser="me@x" />
      </DisplayNameProvider>
    );
    await userEvent.click(screen.getByRole('button', { name: /comment mode/i }));

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
    expect(screen.getByRole('button', { name: /comment mode/i })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.change(screen.getByPlaceholderText(/add a comment/i), {
      target: { value: 'toolbar body' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

    const clusters = parseComments(ytext.toString());
    expect(clusters).toHaveLength(1);
    expect(clusters[0].comment.body).toBe('toolbar body');
    expect(screen.getByRole('button', { name: /comment mode/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it('clears stale orphan badge in source-only mode after the orphan marker is removed', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->');
    const awareness = new Awareness(doc);
    render(
      <DisplayNameProvider>
        <HtmlEditor ytext={ytext} awareness={awareness} currentUser="me@x" />
      </DisplayNameProvider>
    );
    const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;

    await act(async () => {
      dispatchFromBridge(iframe, {
        nonce: '__test_nonce__',
        message: { type: 'comments-rendered', payload: { found: [], orphaned: ['c1'] } },
      });
    });
    expect(screen.getByText(/1 orphan/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^Source$/ }));

    await act(async () => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, '<p>fixed</p>');
    });

    expect(screen.queryByText(/1 orphan/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Orphaned comments/i)).not.toBeInTheDocument();
  });

  it('hides the comment-mode toggle when readOnly is true', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    const awareness = new Awareness(doc);
    render(
      <DisplayNameProvider>
        <HtmlEditor ytext={ytext} awareness={awareness} currentUser="me@x" readOnly />
      </DisplayNameProvider>
    );

    expect(screen.queryByRole('button', { name: /comment mode/i })).toBeNull();
  });

  it.skip('on manual placement, switches to source mode and shows highlights on both candidates', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>click here</p><p>click here</p>');
    const awareness = new Awareness(doc);
    const missRunner: ProbeRunner = {
      async run() { return { x: -1000, y: -1000, w: 1, h: 1 }; },
      dispose() {},
    };

    render(
      <DisplayNameProvider>
        <HtmlEditor ytext={ytext} awareness={awareness} currentUser="me@x" probeRunner={missRunner} />
      </DisplayNameProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: /comment mode/i }));

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
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(screen.getByRole('button', { name: /^Source$/ })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => {
      expect(document.querySelectorAll('.cm-lens-candidate').length).toBeGreaterThanOrEqual(2);
    });
    expect(parseComments(ytext.toString())).toEqual([]);
  });

  it.skip('manual source placement opens composer and writes root body only on submit', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>click here</p><p>click here</p>');
    const awareness = new Awareness(doc);
    const runner: ProbeRunner = {
      async run() { return null; },
      dispose() {},
    };
    const posAtCoords = vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue(3);

    try {
      render(
        <DisplayNameProvider>
          <HtmlEditor ytext={ytext} awareness={awareness} currentUser="me@x" probeRunner={runner} />
        </DisplayNameProvider>,
      );
      fireEvent.click(screen.getByRole('button', { name: /comment mode/i }));

      const iframe = screen.getByTitle('HTML preview') as HTMLIFrameElement;
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', {
          source: iframe.contentWindow,
          data: {
            nonce: '__test_nonce__',
            message: {
              type: 'click-captured',
              payload: {
                fingerprint: {
                  before: 'click ',
                  after: 'here',
                  tag: 'p',
                  ancestorPath: [],
                  clickRect: { x: 10, y: 10, w: 20, h: 20 },
                },
              },
            },
          },
        }));
        await Promise.resolve();
      });

      expect(screen.getByText('Source')).toHaveAttribute('aria-pressed', 'true');
      expect(ytext.toString()).not.toContain('lens-comment');

      const highlighted = document.querySelector('.cm-lens-candidate') as HTMLElement;
      await act(async () => {
        highlighted.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 120, clientY: 80 }));
      });

      expect(screen.getByPlaceholderText(/add a comment/i)).toBeInTheDocument();
      expect(ytext.toString()).not.toContain('lens-comment');

      fireEvent.change(screen.getByPlaceholderText(/add a comment/i), {
        target: { value: 'manual body' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

      const clusters = parseComments(ytext.toString());
      expect(clusters).toHaveLength(1);
      expect(clusters[0].comment.body).toBe('manual body');
      expect(clusters[0].replies).toEqual([]);
    } finally {
      posAtCoords.mockRestore();
    }
  });

  it.skip('manual composer cannot mutate after rerendering readOnly before submit', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>click here</p><p>click here</p>');
    const awareness = new Awareness(doc);

    const { posAtCoords, rerender } = await openManualSourceComposer(ytext, awareness);
    try {
      fireEvent.change(screen.getByPlaceholderText(/add a comment/i), {
        target: { value: 'stale body' },
      });
      rerender(
        <DisplayNameProvider>
          <HtmlEditor ytext={ytext} awareness={awareness} currentUser="me@x" readOnly />
        </DisplayNameProvider>,
      );

      const submit = screen.queryByRole('button', { name: 'Comment' });
      if (submit) fireEvent.click(submit);

      expect(parseComments(ytext.toString())).toEqual([]);
    } finally {
      posAtCoords.mockRestore();
    }
  });

  it.skip('manual composer cannot mutate after comment mode is toggled off before submit', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>click here</p><p>click here</p>');
    const awareness = new Awareness(doc);

    const { posAtCoords } = await openManualSourceComposer(ytext, awareness);
    try {
      fireEvent.change(screen.getByPlaceholderText(/add a comment/i), {
        target: { value: 'stale body' },
      });
      fireEvent.click(screen.getByRole('button', { name: /comment mode/i }));

      const submit = screen.queryByRole('button', { name: 'Comment' });
      if (submit) fireEvent.click(submit);

      expect(parseComments(ytext.toString())).toEqual([]);
    } finally {
      posAtCoords.mockRestore();
    }
  });

  it.skip('manual composer cannot write a stale position after source changes before submit', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>click here</p><p>click here</p>');
    const awareness = new Awareness(doc);

    const { posAtCoords } = await openManualSourceComposer(ytext, awareness);
    try {
      fireEvent.change(screen.getByPlaceholderText(/add a comment/i), {
        target: { value: 'stale source body' },
      });

      await act(async () => {
        ytext.insert(0, '<p>new intro</p>');
      });

      const submit = screen.queryByRole('button', { name: 'Comment' });
      if (submit) fireEvent.click(submit);

      expect(parseComments(ytext.toString())).toEqual([]);
    } finally {
      posAtCoords.mockRestore();
    }
  });

  it.skip('positions manual composer using source wrapper local coordinates', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>click here</p><p>click here</p>');
    const awareness = new Awareness(doc);
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (
        this instanceof HTMLElement
        && this.classList.contains('relative')
        && this.classList.contains('min-w-0')
        && this.classList.contains('flex-1')
      ) {
        return {
          x: 40,
          y: 30,
          top: 30,
          left: 40,
          right: 640,
          bottom: 430,
          width: 600,
          height: 400,
          toJSON: () => {},
        };
      }
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON: () => {},
      };
    });

    const { posAtCoords } = await openManualSourceComposer(ytext, awareness);
    try {
      const card = document.querySelector('.comment-card-new') as HTMLElement;

      expect(card.style.left).toBe('80px');
      expect(card.style.top).toBe('50px');
    } finally {
      rectSpy.mockRestore();
      posAtCoords.mockRestore();
    }
  });

  it.skip('source-pane click while manual placement is pending opens the composer before writing a marker', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>click here</p><p>click here</p>');
    const awareness = new Awareness(doc);
    const missRunner: ProbeRunner = {
      async run() { return { x: -1000, y: -1000, w: 1, h: 1 }; },
      dispose() {},
    };
    const posAtCoords = vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue(3);

    try {
      render(
        <DisplayNameProvider>
          <HtmlEditor ytext={ytext} awareness={awareness} currentUser="me@x" probeRunner={missRunner} />
        </DisplayNameProvider>,
      );
      await userEvent.click(screen.getByRole('button', { name: /comment mode/i }));

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
        await new Promise(resolve => setTimeout(resolve, 0));
      });
      await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull());

      const editor = document.querySelector('.cm-content') as HTMLElement;
      await act(async () => {
        editor.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 100, clientY: 50 }));
      });

      expect(screen.getByPlaceholderText(/add a comment/i)).toBeInTheDocument();
      expect(parseComments(ytext.toString())).toEqual([]);

      fireEvent.change(screen.getByPlaceholderText(/add a comment/i), {
        target: { value: 'source placement' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

      await waitFor(() => expect(parseComments(ytext.toString())).toHaveLength(1));
      const [cluster] = parseComments(ytext.toString());
      expect(cluster.sourceStart).toBe(3);
      expect(cluster.comment.author).toBe('me@x');
      expect(cluster.comment.body).toBe('source placement');
      expect(screen.getByRole('button', { name: /comment mode/i })).toHaveAttribute('aria-pressed', 'false');
    } finally {
      posAtCoords.mockRestore();
    }
  });

  it.skip('clears pending manual placement when comment mode is toggled off', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>click here</p><p>click here</p>');
    const awareness = new Awareness(doc);
    const missRunner: ProbeRunner = {
      async run() { return { x: -1000, y: -1000, w: 1, h: 1 }; },
      dispose() {},
    };
    const posAtCoords = vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue(3);

    try {
      render(
        <DisplayNameProvider>
          <HtmlEditor ytext={ytext} awareness={awareness} currentUser="me@x" probeRunner={missRunner} />
        </DisplayNameProvider>,
      );
      await userEvent.click(screen.getByRole('button', { name: /comment mode/i }));
      await triggerManualPlacementFallback();

      await userEvent.click(screen.getByRole('button', { name: /comment mode/i }));

      await waitFor(() => expect(document.querySelectorAll('.cm-lens-candidate')).toHaveLength(0));
      const editor = document.querySelector('.cm-content') as HTMLElement;
      await act(async () => {
        editor.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 100, clientY: 50 }));
      });

      expect(parseComments(ytext.toString())).toEqual([]);
    } finally {
      posAtCoords.mockRestore();
    }
  });

  it.skip('does not re-arm pending manual placement after rapid comment mode off/on', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>click here</p><p>click here</p>');
    const awareness = new Awareness(doc);
    const missRunner: ProbeRunner = {
      async run() { return { x: -1000, y: -1000, w: 1, h: 1 }; },
      dispose() {},
    };
    const posAtCoords = vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue(3);

    try {
      render(
        <DisplayNameProvider>
          <HtmlEditor ytext={ytext} awareness={awareness} currentUser="me@x" probeRunner={missRunner} />
        </DisplayNameProvider>,
      );
      await userEvent.click(screen.getByRole('button', { name: /comment mode/i }));
      await triggerManualPlacementFallback();

      vi.useFakeTimers();
      const commentModeButton = screen.getByRole('button', { name: /comment mode/i });
      act(() => {
        fireEvent.click(commentModeButton);
      });
      act(() => {
        fireEvent.click(commentModeButton);
      });
      act(() => {
        vi.runOnlyPendingTimers();
      });
      vi.useRealTimers();

      await waitFor(() => expect(document.querySelectorAll('.cm-lens-candidate')).toHaveLength(0));
      const editor = document.querySelector('.cm-content') as HTMLElement;
      await act(async () => {
        editor.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 100, clientY: 50 }));
      });

      expect(parseComments(ytext.toString())).toEqual([]);
    } finally {
      vi.useRealTimers();
      posAtCoords.mockRestore();
    }
  });

  it.skip('clears pending manual placement when the source changes before source click', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<p>click here</p><p>click here</p>');
    const awareness = new Awareness(doc);
    const missRunner: ProbeRunner = {
      async run() { return { x: -1000, y: -1000, w: 1, h: 1 }; },
      dispose() {},
    };
    const posAtCoords = vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue(3);

    try {
      render(
        <DisplayNameProvider>
          <HtmlEditor ytext={ytext} awareness={awareness} currentUser="me@x" probeRunner={missRunner} />
        </DisplayNameProvider>,
      );
      await userEvent.click(screen.getByRole('button', { name: /comment mode/i }));
      await triggerManualPlacementFallback();

      await act(async () => {
        ytext.insert(0, '<p>new</p>');
      });

      await waitFor(() => expect(document.querySelectorAll('.cm-lens-candidate')).toHaveLength(0));
      const editor = document.querySelector('.cm-content') as HTMLElement;
      await act(async () => {
        editor.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 100, clientY: 50 }));
      });

      expect(parseComments(ytext.toString())).toEqual([]);
    } finally {
      posAtCoords.mockRestore();
    }
  });
});
