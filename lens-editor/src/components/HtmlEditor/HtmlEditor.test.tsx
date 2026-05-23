// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { HtmlEditor } from './HtmlEditor';
import { DisplayNameProvider } from '../../contexts/DisplayNameContext';
import { parseComments } from './comment-store';
import type { BridgeToParent, Envelope } from './bridge/protocol';

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
      const iframe = () => container.querySelector('iframe')!;

      await act(async () => { ytext.insert(0, '<p>shared</p>'); });
      await act(async () => { vi.advanceTimersByTime(400); });

      expect(iframe().getAttribute('srcdoc')).toContain('<p>shared</p>');
    } finally {
      vi.useRealTimers();
    }
  });

  it('comment-mode toggle button toggles aria-pressed state', async () => {
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

  it('uses DisplayNameProvider for new comment authors when currentUser prop is omitted', async () => {
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

    expect(parseComments(ytext.toString())[0].comment.author).toBe('Luc');
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
});
