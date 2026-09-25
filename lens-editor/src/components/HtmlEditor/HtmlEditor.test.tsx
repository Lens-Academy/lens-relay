// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { HtmlEditor } from './HtmlEditor';
import { DisplayNameProvider } from '../../contexts/DisplayNameContext';
import type { BridgeToParent, Envelope, ThreadPlacement } from './bridge/protocol';
import { createThread, readThreads, recordSeen, setThreadStatus } from './comments/thread-store';
import type { TextAnchor } from './anchoring/types';

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

function createHtmlDoc(source = '<h1>Test</h1>') {
  const doc = new Y.Doc();
  const ytext = doc.getText('contents');
  ytext.insert(0, source);
  const awareness = new Awareness(doc);
  return { doc, ytext, awareness };
}

const anchor: TextAnchor = {
  v: 1,
  kind: 'text',
  quote: 'brown fox',
  prefix: 'The quick ',
  suffix: ' jumps',
  position: { start: 10, end: 19, total: 30 },
};

function iframe(): HTMLIFrameElement {
  return screen.getByTitle('HTML preview') as HTMLIFrameElement;
}

async function fromBridge(message: BridgeToParent): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', {
      data: { nonce: '__test_nonce__', message } satisfies Envelope<BridgeToParent>,
      source: iframe().contentWindow,
    }));
  });
}

async function resolved(placements: ThreadPlacement[], settled = true): Promise<void> {
  await fromBridge({
    type: 'threads-resolved',
    payload: { placements, draft: null, baselineScrollY: 0, layoutVersion: 1, settled },
  });
}

async function placed(...ids: string[]): Promise<void> {
  await resolved(ids.map((id, i) => ({ id, state: 'anchored' as const, rect: { x: 0, y: 20 * i, w: 10, h: 10 }, textOffset: i })));
}

function spyPosted(): { types: () => string[]; messages: () => Array<{ type: string; payload: unknown }> } {
  const posted: Array<{ type: string; payload: unknown }> = [];
  vi.spyOn(iframe().contentWindow!, 'postMessage').mockImplementation(((msg: Envelope<{ type: string; payload: unknown }>) => {
    posted.push(msg.message);
  }) as typeof window.postMessage);
  return { types: () => posted.map(p => p.type), messages: () => posted };
}

function renderEditor(ytext: Y.Text, awareness: Awareness, props: { readOnly?: boolean } = {}) {
  return render(
    <DisplayNameProvider>
      <HtmlEditor ytext={ytext} awareness={awareness} currentUser="me@x" {...props} />
    </DisplayNameProvider>,
  );
}

describe('HtmlEditor', () => {
  beforeEach(() => {
    // HtmlEditor portals view-mode controls into #header-controls (the global
    // header slot owned by App.tsx). Tests render the component in isolation,
    // so we provide a stand-in element to receive the portaled controls.
    if (!document.getElementById('header-controls')) {
      const target = document.createElement('div');
      target.id = 'header-controls';
      document.body.appendChild(target);
    }
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
    document.getElementById('header-controls')?.remove();
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

  it('toggles Comment mode from the header button, the C key and Escape', async () => {
    const { ytext, awareness } = createHtmlDoc();
    renderEditor(ytext, awareness);
    const posted = spyPosted();
    const button = screen.getByRole('button', { name: /^Comment$/ });

    await userEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('status')).toHaveTextContent(/Click text or an element/);
    expect(posted.messages()).toContainEqual({ type: 'set-comment-mode', payload: { on: true } });

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(button).toHaveAttribute('aria-pressed', 'false');

    fireEvent.keyDown(window, { key: 'c' });
    expect(button).toHaveAttribute('aria-pressed', 'true');

    // The page can end it too (Escape pressed inside the frame).
    await fromBridge({ type: 'comment-mode-exit', payload: {} });
    expect(button).toHaveAttribute('aria-pressed', 'false');
  });

  it('hides commenting entirely when readOnly', () => {
    const { ytext, awareness } = createHtmlDoc();
    renderEditor(ytext, awareness, { readOnly: true });
    expect(screen.queryByRole('button', { name: /^Comment$/ })).toBeNull();
    fireEvent.keyDown(window, { key: 'c' });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('opens a composer for a captured anchor that survives remote edits, and writes the thread out of band', async () => {
    const { doc, ytext, awareness } = createHtmlDoc('<p>The quick brown fox jumps over.</p>');
    renderEditor(ytext, awareness);
    await userEvent.click(screen.getByRole('button', { name: /^Comment$/ }));
    await fromBridge({ type: 'anchor-captured', payload: { anchor, rect: { x: 0, y: 40, w: 80, h: 16 }, via: 'selection' } });

    expect(screen.getByText('brown fox')).toBeInTheDocument();
    const box = screen.getByPlaceholderText('Add a comment...');
    await userEvent.type(box, 'Is this right?');

    // A collaborator edits the page while we type: the draft stays.
    await act(async () => { ytext.insert(0, '<h2>New heading</h2>'); });
    expect(screen.getByPlaceholderText('Add a comment...')).toHaveValue('Is this right?');

    await userEvent.click(screen.getByRole('button', { name: 'Post' }));
    const threads = readThreads(doc);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ anchor, status: 'open', createdBy: 'me@x' });
    expect(threads[0].messages[0]).toMatchObject({ author: 'me@x', body: 'Is this right?' });
    // The source is untouched: comments no longer live in the HTML.
    expect(ytext.toString()).toBe('<h2>New heading</h2><p>The quick brown fox jumps over.</p>');
  });

  it('keeps the text of a cancelled comment for the same spot', async () => {
    const { ytext, awareness } = createHtmlDoc();
    renderEditor(ytext, awareness);
    const capture = () => fromBridge({ type: 'anchor-captured', payload: { anchor, rect: { x: 0, y: 40, w: 80, h: 16 }, via: 'click' } });
    await userEvent.click(screen.getByRole('button', { name: /^Comment$/ }));
    await capture();
    await userEvent.type(screen.getByPlaceholderText('Add a comment...'), 'Half a thought');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByPlaceholderText('Add a comment...')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /^Comment$/ }));
    await capture();
    expect(screen.getByPlaceholderText('Add a comment...')).toHaveValue('Half a thought');
  });

  it('toggles Comment mode when C is pressed inside the page', async () => {
    const { ytext, awareness } = createHtmlDoc();
    renderEditor(ytext, awareness);
    await fromBridge({ type: 'shortcut', payload: { key: 'c' } });
    expect(screen.getByRole('button', { name: 'Commenting…' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('numbers comments in creation order, whatever their place on the page', async () => {
    const { doc, ytext, awareness } = createHtmlDoc();
    createThread(doc, 'test', { id: 'first', anchor, author: 'ann', body: 'First comment', ts: 1 });
    createThread(doc, 'test', { id: 'second', anchor, author: 'ann', body: 'Second comment', ts: 2 });
    const { container } = renderEditor(ytext, awareness);
    await resolved([
      { id: 'first', state: 'anchored', rect: { x: 0, y: 300, w: 10, h: 10 }, textOffset: 50 },
      { id: 'second', state: 'anchored', rect: { x: 0, y: 10, w: 10, h: 10 }, textOffset: 1 },
    ]);
    const numberOf = (text: string) => container.querySelector(`[data-comment-thread] .comments-card:has(p)`)
      && Array.from(container.querySelectorAll('[data-comment-thread]')).find(el => el.textContent?.includes(text))?.textContent?.trim()[0];
    expect(numberOf('First comment')).toBe('1');
    expect(numberOf('Second comment')).toBe('2');
  });

  it('ignores captured anchors when not commenting', async () => {
    const { doc, ytext, awareness } = createHtmlDoc();
    renderEditor(ytext, awareness);
    await fromBridge({ type: 'anchor-captured', payload: { anchor, rect: { x: 0, y: 0, w: 1, h: 1 }, via: 'click' } });
    expect(screen.queryByPlaceholderText('Add a comment...')).toBeNull();
    expect(readThreads(doc)).toHaveLength(0);
  });

  it('shows anchor states on cards and in the header once the page has settled', async () => {
    const { doc, ytext, awareness } = createHtmlDoc();
    createThread(doc, 'test', { id: 'gone', anchor, author: 'ann', body: 'Lost one' });
    createThread(doc, 'test', { id: 'moved', anchor: { ...anchor, quote: 'lazy dog' }, author: 'ann', body: 'Moved one' });
    renderEditor(ytext, awareness);

    await resolved([
      { id: 'gone', state: 'orphaned', rect: null, textOffset: null },
      { id: 'moved', state: 'guessed', rect: { x: 0, y: 10, w: 10, h: 10 }, textOffset: 3, currentQuote: 'lazy cat' },
    ], false);
    expect(screen.queryByText('Not found on the page')).toBeNull(); // still rendering

    await resolved([
      { id: 'gone', state: 'orphaned', rect: null, textOffset: null },
      { id: 'moved', state: 'guessed', rect: { x: 0, y: 10, w: 10, h: 10 }, textOffset: 3, currentQuote: 'lazy cat' },
    ]);
    // Comments whose text is gone wait in their own panel, not in the margin.
    expect(screen.queryByText('Not found on the page')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /1 not found on the page/ }));
    expect(screen.getByText('Not found on the page')).toBeInTheDocument();
    expect(screen.getByText('Moved? Check the spot')).toBeInTheDocument();
    expect(screen.getByText(/Now on: “lazy cat”/)).toBeInTheDocument();
    expect(screen.getByText('1 not found')).toBeInTheDocument();
    expect(screen.getByText('1 to check')).toBeInTheDocument();
    // Editors record what they saw, so agents reading the page know too.
    const seen = Object.fromEntries(readThreads(doc).map(t => [t.id, t.seen?.state]));
    expect(seen).toEqual({ gone: 'orphaned', moved: 'guessed' });
  });

  it('records what it saw once per observation and never argues with another editor', async () => {
    const { doc, ytext, awareness } = createHtmlDoc();
    createThread(doc, 'test', { id: 't1', anchor, author: 'ann', body: 'Hi' });
    renderEditor(ytext, awareness);
    await resolved([{ id: 't1', state: 'orphaned', rect: null, textOffset: null }]);
    expect(readThreads(doc)[0].seen?.state).toBe('orphaned');

    // Another editor, whose page renders differently, records 'anchored'.
    await act(async () => { recordSeen(doc, 'remote', 't1', 'anchored'); });
    await resolved([{ id: 't1', state: 'orphaned', rect: { x: 0, y: 0, w: 1, h: 1 }, textOffset: null }]);
    expect(readThreads(doc)[0].seen?.state).toBe('anchored');
  });

  it('refreshes a drifted anchor only to resembling text, and not repeatedly', async () => {
    const { doc, ytext, awareness } = createHtmlDoc();
    createThread(doc, 'test', { id: 't1', anchor, author: 'ann', body: 'Hi' });
    renderEditor(ytext, awareness);
    const forged = { ...anchor, quote: 'something entirely unrelated to the fox' };
    await resolved([{ id: 't1', state: 'anchored', rect: null, textOffset: 1, refreshed: forged }]);
    expect(readThreads(doc)[0].anchor).toMatchObject({ quote: 'brown fox' });

    await resolved([{ id: 't1', state: 'anchored', rect: null, textOffset: 1, refreshed: { ...anchor, quote: 'brown foxes' } }]);
    expect(readThreads(doc)[0].anchor).toMatchObject({ quote: 'brown foxes' });
    await resolved([{ id: 't1', state: 'anchored', rect: null, textOffset: 2, refreshed: { ...anchor, quote: 'brown foxy' } }]);
    expect(readThreads(doc)[0].anchor).toMatchObject({ quote: 'brown foxes' });
  });

  it('confirms a guessed anchor by describing its current target afresh', async () => {
    const { doc, ytext, awareness } = createHtmlDoc();
    createThread(doc, 'test', { id: 't1', anchor, author: 'ann', body: 'Check me' });
    renderEditor(ytext, awareness);
    const posted = spyPosted();
    await resolved([{ id: 't1', state: 'guessed', rect: { x: 0, y: 10, w: 10, h: 10 }, textOffset: 3, currentQuote: 'brown cat' }]);

    await userEvent.click(screen.getByRole('button', { name: 'Looks right' }));
    expect(posted.messages()).toContainEqual({ type: 'describe-current', payload: { id: 't1' } });

    const fresh = { ...anchor, quote: 'brown cat' };
    await fromBridge({ type: 'current-described', payload: { id: 't1', anchor: fresh } });
    const thread = readThreads(doc)[0];
    expect(thread.anchor).toMatchObject({ quote: 'brown cat' });
    expect(thread.originalQuote).toBe('brown fox');
  });

  it('re-attaches an orphaned thread to the next spot picked in the page', async () => {
    const { doc, ytext, awareness } = createHtmlDoc();
    createThread(doc, 'test', { id: 't1', anchor, author: 'ann', body: 'Where did it go?' });
    renderEditor(ytext, awareness);
    await resolved([{ id: 't1', state: 'orphaned', rect: null, textOffset: null }]);

    // The header chip opens the panel of comments not found on the page.
    await userEvent.click(screen.getByRole('button', { name: '1 not found' }));
    await userEvent.click(screen.getByRole('button', { name: 'Re-attach' }));
    expect(screen.getByRole('status')).toHaveTextContent(/Pick the new spot for comment 1/);
    const target = { ...anchor, quote: 'new spot' };
    await fromBridge({ type: 'anchor-captured', payload: { anchor: target, rect: { x: 0, y: 0, w: 1, h: 1 }, via: 'click' } });

    const threads = readThreads(doc);
    expect(threads).toHaveLength(1);
    expect(threads[0].anchor).toMatchObject({ quote: 'new spot' });
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByPlaceholderText('Add a comment...')).toBeNull();
  });

  it('resolves a thread, hides it, and shows it again on request', async () => {
    const { doc, ytext, awareness } = createHtmlDoc();
    createThread(doc, 'test', { id: 't1', anchor, author: 'ann', body: 'Please fix' });
    renderEditor(ytext, awareness);
    await placed('t1');
    expect(screen.getByText('Please fix')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    expect(readThreads(doc)[0]).toMatchObject({ status: 'resolved', resolvedBy: 'me@x' });
    expect(screen.queryByText('Please fix')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Show resolved (1)' }));
    await placed('t1');
    expect(screen.getByText('Please fix')).toBeInTheDocument();
    expect(screen.getByText('Resolved')).toBeInTheDocument();
    expect(screen.getByText(/Resolved by me@x/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    expect(readThreads(doc)[0].status).toBe('open');
  });

  it('lets only the author edit or delete a message, by browser id rather than name', async () => {
    const { doc, ytext, awareness } = createHtmlDoc();
    createThread(doc, 'test', { id: 'mine', anchor, author: 'me@x', authorId: 'someone-else', body: 'Same name, other browser' });
    renderEditor(ytext, awareness);
    await placed('mine');
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    await userEvent.type(screen.getByRole('button', { name: 'Reply' }), '{enter}');
    await userEvent.type(screen.getByPlaceholderText('Write a reply...'), 'My reply');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(readThreads(doc)[0].messages.map(m => m.body)).toEqual(['Same name, other browser', 'My reply']);
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(1);
  });

  it('focuses the card when its highlight or badge is clicked in the page', async () => {
    const { doc, ytext, awareness } = createHtmlDoc();
    createThread(doc, 'test', { id: 't1', anchor, author: 'ann', body: 'Focus me' });
    const { container } = renderEditor(ytext, awareness);
    await resolved([{ id: 't1', state: 'anchored', rect: { x: 0, y: 10, w: 10, h: 10 }, textOffset: 3 }]);
    await fromBridge({ type: 'thread-clicked', payload: { id: 't1' } });
    await waitFor(() => expect(container.querySelector('.comments-card--focused')).not.toBeNull());
  });

  it('migrates legacy inline comments into threads and strips the markers', async () => {
    const legacy = '<p>Intro.</p>[[@comment:old1]]<!--lens-comment {"id":"old1","author":"bob","ts":"2026-01-02T03:04:05.000Z","body":"Old note"}-->'
      + '<!--lens-reply {"id":"r1","parent":"old1","author":"amy","ts":"2026-01-03T00:00:00.000Z","body":"Old reply"}--><p>Body text here.</p>';
    const { doc, ytext, awareness } = createHtmlDoc(legacy);
    renderEditor(ytext, awareness);
    // The preview never shows the raw text anchor.
    expect(iframe().getAttribute('srcdoc')).not.toContain('[[@comment:');
    const posted = spyPosted();

    await resolved([]);
    expect(posted.messages()).toContainEqual({ type: 'describe-legacy', payload: { ids: ['old1'] } });

    const migrated = { ...anchor, quote: 'Body text here.' };
    await fromBridge({ type: 'legacy-described', payload: { anchors: { old1: migrated } } });

    expect(ytext.toString()).toBe('<p>Intro.</p><p>Body text here.</p>');
    const threads = readThreads(doc);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ id: 'old1', anchor: migrated, createdBy: 'bob' });
    expect(threads[0].messages.map(m => [m.author, m.body])).toEqual([['bob', 'Old note'], ['amy', 'Old reply']]);
  });

  it('does not migrate for read-only viewers', async () => {
    const legacy = '<p>x</p>[[@comment:old1]]<!--lens-comment {"id":"old1","author":"bob","ts":"t","body":"Old"}-->';
    const { doc, ytext, awareness } = createHtmlDoc(legacy);
    renderEditor(ytext, awareness, { readOnly: true });
    const posted = spyPosted();
    await resolved([]);
    expect(posted.types()).not.toContain('describe-legacy');
    expect(ytext.toString()).toBe(legacy);
    expect(readThreads(doc)).toHaveLength(0);
    setThreadStatus(doc, 'test', 'none', 'resolved', 'x'); // no-op on a missing thread
  });
});
