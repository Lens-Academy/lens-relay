import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { readLinkOffers, readSeenLinkOffers, dismissLinkOffers } from '../../lib/link-offers';
import { FakeSourceServer } from './fake-source-server.test-helper';
import {
  DONE_CLEARS_MS,
  OFFER_HOLD_MS,
  OFFER_SEEN_MS,
  POLL_MS,
  SCAN_DEBOUNCE_MS,
  SETTLE_MS,
} from './source-links-session';
import { useSourceLinks, type UseSourceLinksOptions } from './useSourceLinks';

vi.mock('../../lib/relay-api', () => ({
  relayHeaders: (extra?: Record<string, string>) => ({ ...extra, 'X-Share-Token': 'token' }),
}));

const A = 'https://example.com/a';
const B = 'https://example.com/b';
const C = 'https://example.com/c';
const PATH = '/Lens/Notes/page.md';

let server: FakeSourceServer;

/** A page whose text this person writes on this visit: theirs, so it is offered. */
function docWith(text = ''): Y.Doc {
  const doc = new Y.Doc();
  doc.getText('contents').insert(0, text);
  return doc;
}

/** The same page opened again: a new Y.Doc, loaded from the server. */
function reloaded(from: Y.Doc): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(from), 'server');
  return doc;
}

/** A page as it opens, written before this visit or by someone else. */
function pageWith(text: string): Y.Doc {
  return reloaded(docWith(text));
}

/** Someone else's edit arriving over the connection. */
function editElsewhere(doc: Y.Doc, edit: (text: Y.Text) => void) {
  const other = reloaded(doc);
  const before = Y.encodeStateVector(doc);
  edit(other.getText('contents'));
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, before), 'server');
}

function options(doc: Y.Doc, extra: Partial<UseSourceLinksOptions> = {}): UseSourceLinksOptions {
  return { doc, docId: 'relay-doc-1', path: PATH, displayName: 'Luc', canImport: true, ...extra };
}

async function pass(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Mounts on a page, and waits out the first scan's answer. */
async function open(doc: Y.Doc, extra: Partial<UseSourceLinksOptions> = {}) {
  const hook = renderHook((props: UseSourceLinksOptions) => useSourceLinks(props), { initialProps: options(doc, extra) });
  await pass(0);
  return hook;
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

function replaceText(doc: Y.Doc, text: string) {
  const ytext = doc.getText('contents');
  ytext.delete(0, ytext.length);
  ytext.insert(0, text);
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  server = new FakeSourceServer();
  server.install();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});

describe('when it asks the server', () => {
  it('makes no request on a page with no links', async () => {
    const doc = docWith('Just writing.');
    await open(doc);
    act(() => doc.getText('contents').insert(0, 'More words. '));
    await pass(SCAN_DEBOUNCE_MS * 3);
    expect(server.requests).toBe(0);
  });

  it('makes no request for links that are not http(s) sources in the text', async () => {
    await open(docWith('A `https://example.com/in-code` and [[wikilink]]'));
    await pass(SCAN_DEBOUNCE_MS);
    expect(server.requests).toBe(0);
  });

  it('asks once a page with links opens, without waiting', async () => {
    await open(docWith(`See ${A}`));
    expect(server.checks).toEqual([[A]]);
    expect(server.headers[0]).toMatchObject({ 'X-Share-Token': 'token', 'Content-Type': 'application/json' });
  });

  it('waits for 1.5 s after the last change', async () => {
    const doc = docWith('');
    await open(doc);
    act(() => doc.getText('contents').insert(0, A));
    await pass(SCAN_DEBOUNCE_MS - 1);
    expect(server.requests).toBe(0);
    act(() => doc.getText('contents').insert(0, 'x '));
    await pass(SCAN_DEBOUNCE_MS - 1);
    expect(server.requests).toBe(0);
    await pass(1);
    expect(server.checks).toEqual([[A]]);
  });

  it('does not re-render on keystrokes', async () => {
    const doc = docWith(`See ${A}`);
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useSourceLinks(options(doc));
    });
    await pass(0);
    const settled = renders;
    for (let i = 0; i < 20; i += 1) {
      act(() => doc.getText('contents').insert(0, 'x'));
      await pass(50);
    }
    expect(renders).toBe(settled);
    await pass(SCAN_DEBOUNCE_MS);
    expect(renders).toBe(settled);
  });

  it('asks only about URLs it has not seen', async () => {
    const doc = docWith(`See ${A}`);
    await open(doc);
    act(() => doc.getText('contents').insert(0, `${B} `));
    await pass(SCAN_DEBOUNCE_MS);
    expect(server.checks).toEqual([[A], [B]]);
  });

  it('remembers that a URL is not a source', async () => {
    server.notSources.add(A);
    const doc = docWith(`See ${A}`);
    const { result } = await open(doc);
    expect(result.current.model.kind).toBe('hidden');
    act(() => doc.getText('contents').insert(0, 'x '));
    await pass(SCAN_DEBOUNCE_MS);
    expect(server.checks).toEqual([[A]]);
  });

  it('does not ask again for a URL that went and came back', async () => {
    const doc = docWith(`See ${A} and ${B}`);
    await open(doc);
    act(() => replaceText(doc, `See ${A}`));
    await pass(SCAN_DEBOUNCE_MS);
    act(() => replaceText(doc, `See ${A} and ${B}`));
    await pass(SCAN_DEBOUNCE_MS);
    expect(server.checks).toEqual([[A, B]]);
  });

  it('splits a very long list of links within the server\'s limit', async () => {
    const urls = Array.from({ length: 450 }, (_, i) => `https://example.com/${i}`);
    await open(docWith(urls.join('\n\n')));
    expect(server.checks.map((batch) => batch.length)).toEqual([200, 200, 50]);
  });
});

describe('who and which pages get nothing', () => {
  it('does nothing for someone who cannot import', async () => {
    const doc = docWith(`See ${A}`);
    const observe = vi.spyOn(doc.getText('contents'), 'observe');
    const { result } = await open(doc, { canImport: false });
    act(() => doc.getText('contents').insert(0, 'x'));
    await pass(SCAN_DEBOUNCE_MS * 2);
    expect(server.requests).toBe(0);
    expect(observe).not.toHaveBeenCalled();
    expect(result.current.session).toBeNull();
  });

  it.each([
    ['a Lens Edu page, leading slash and all', '/Lens Edu/Lenses/x.md'],
    ['a page in the trash', '/Lens/_trash/x.md'],
    ['an HTML page', '/Lens/x.html'],
    ['a page not yet found in the metadata', undefined],
  ])('does nothing on %s', async (_name, path) => {
    const doc = docWith(`See ${A}`);
    const observe = vi.spyOn(doc.getText('contents'), 'observe');
    const { result } = await open(doc, { path });
    await pass(SCAN_DEBOUNCE_MS * 2);
    expect(server.requests).toBe(0);
    expect(observe).not.toHaveBeenCalled();
    expect(result.current.model.kind).toBe('hidden');
  });

  it.each([
    ['source_url', 'source_url: https://example.com/x'],
    ['synced_from', 'synced_from:\n  source: google-doc'],
  ])('does nothing on a page with %s in its frontmatter', async (_name, field) => {
    await open(docWith(`---\n${field}\n---\n\nSee ${A}`));
    await pass(SCAN_DEBOUNCE_MS);
    expect(server.requests).toBe(0);
  });

  it('starts once the file path arrives', async () => {
    const doc = docWith(`See ${A}`);
    const { rerender, result } = await open(doc, { path: undefined });
    expect(server.requests).toBe(0);
    rerender(options(doc));
    await pass(0);
    expect(result.current.model.kind).toBe('offer');
  });

  it('shows nothing on a 403, and stops asking', async () => {
    server.checkStatus = 403;
    const doc = docWith(`See ${A}`);
    const { result } = await open(doc);
    expect(result.current.model.kind).toBe('hidden');
    act(() => doc.getText('contents').insert(0, `${B} `));
    await pass(SCAN_DEBOUNCE_MS + POLL_MS);
    expect(server.checks).toEqual([[A]]);
    expect(result.current.session?.canImport(A)).toBe(false);
  });

  it('shows nothing on a network error, and tries again with the next change', async () => {
    server.failing = true;
    const doc = docWith(`See ${A}`);
    const { result } = await open(doc);
    expect(result.current.model.kind).toBe('hidden');

    server.failing = false;
    act(() => doc.getText('contents').insert(0, 'x '));
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.kind).toBe('offer');
  });

  it('shows nothing on a server error', async () => {
    server.checkStatus = 500;
    const { result } = await open(docWith(`See ${A}`));
    expect(result.current.model.kind).toBe('hidden');
  });
});

describe('the library index loading', () => {
  it('offers nothing and asks again until it is ready', async () => {
    server.ready = false;
    const { result } = await open(docWith(`See ${A}`));
    expect(result.current.model.kind).toBe('hidden');
    await pass(POLL_MS);
    expect(server.checks).toHaveLength(2);
    expect(result.current.model.kind).toBe('hidden');

    server.ready = true;
    await pass(POLL_MS);
    expect(result.current.model.kind).toBe('offer');

    const asked = server.checks.length;
    await pass(POLL_MS * 3);
    expect(server.checks).toHaveLength(asked);
  });

  it('still shows what the job list knows', async () => {
    server.ready = false;
    server.set(A, { state: 'importing', job_id: 'j1', eta_minutes: 3 });
    const { result } = await open(docWith(`See ${A} and ${B}`));
    expect(result.current.model.kind).toBe('working');
    expect(result.current.model.rows.map((row) => row.url)).toEqual([A]);
  });

  it('does not poll for a page holding only links that are not sources', async () => {
    server.ready = false;
    server.notSources.add(A);
    await open(docWith(`See ${A}`));
    await pass(POLL_MS * 3);
    expect(server.checks).toHaveLength(1);
  });
});

describe('polling', () => {
  it('reopens a page with an import running, even one someone else started', async () => {
    server.set(A, { state: 'importing', job_id: 'j1', eta_minutes: 6 });
    const { result } = await open(docWith(`See ${A}`));
    expect(result.current.model.kind).toBe('working');
    expect(result.current.model.text).toContain('Importing 1 source, about 6 min.');
    expect(result.current.model.canStop).toBe(true);
  });

  it('polls while a job runs, and only about that job', async () => {
    server.set(A, { state: 'queued', job_id: 'j1' });
    await open(docWith(`See ${A} and ${B}`));
    await pass(POLL_MS);
    expect(server.checks).toEqual([[A, B], [A]]);
    await pass(POLL_MS);
    expect(server.checks).toHaveLength(3);
  });

  it('stops polling when nothing is active', async () => {
    server.set(A, { state: 'queued', job_id: 'j1' });
    const doc = docWith(`See ${A}`);
    await open(doc);
    await pass(POLL_MS);
    server.set(A, { state: 'library', path: 'Lens/articles/a.md' });
    act(() => replaceText(doc, 'See [[a]]'));
    await pass(POLL_MS);
    const asked = server.checks.length;
    await pass(POLL_MS * 5);
    expect(server.checks).toHaveLength(asked);
  });

  it('pauses while the page is hidden and catches up on return', async () => {
    server.set(A, { state: 'queued', job_id: 'j1' });
    await open(docWith(`See ${A}`));
    await pass(POLL_MS);
    expect(server.checks).toHaveLength(2);

    act(() => setVisibility('hidden'));
    await pass(POLL_MS * 5);
    expect(server.checks).toHaveLength(2);

    await act(async () => {
      setVisibility('visible');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(server.checks).toHaveLength(3);
    await pass(POLL_MS);
    expect(server.checks).toHaveLength(4);
  });

  it('does not start polling while hidden', async () => {
    setVisibility('hidden');
    server.set(A, { state: 'queued', job_id: 'j1' });
    await open(docWith(`See ${A}`));
    await pass(POLL_MS * 3);
    expect(server.checks).toHaveLength(1);
  });

  it('stops polling on unmount', async () => {
    server.set(A, { state: 'queued', job_id: 'j1' });
    const { unmount } = await open(docWith(`See ${A}`));
    unmount();
    await pass(POLL_MS * 3);
    expect(server.checks).toHaveLength(1);
  });

  it('keeps Working through a network blip, and backs off', async () => {
    server.set(A, { state: 'importing', job_id: 'j1' });
    const { result } = await open(docWith(`See ${A}`));
    server.failing = true;
    await pass(POLL_MS);
    expect(result.current.model.kind).toBe('working');
    expect(server.checks).toHaveLength(2);
    await pass(POLL_MS);
    expect(server.checks).toHaveLength(2); // the next try is at twice the interval
    await pass(POLL_MS);
    expect(server.checks).toHaveLength(3);
    server.failing = false;
    await pass(POLL_MS * 4);
    expect(result.current.model.kind).toBe('working');
  });

  it('shows nothing and stops if a poll is refused', async () => {
    server.set(A, { state: 'importing', job_id: 'j1' });
    const { result } = await open(docWith(`See ${A}`));
    server.checkStatus = 403;
    await pass(POLL_MS);
    expect(result.current.model.kind).toBe('hidden');
    await pass(POLL_MS * 3);
    expect(server.checks).toHaveLength(2);
  });

  it('leaves out someone else\'s import of a link turned down here', async () => {
    server.set(A, { state: 'importing', job_id: 'j1' });
    const doc = docWith(`See ${A}`);
    dismissLinkOffers(doc, [A], 'Sam');
    const { result } = await open(doc);
    expect(result.current.model.kind).toBe('hidden');
  });
});

describe('no state carries between documents', () => {
  it('starts afresh, asks afresh, and ignores the old page\'s late answers', async () => {
    const first = docWith(`See ${A}`);
    const { result, rerender } = await open(first);
    expect(result.current.model.kind).toBe('offer');

    // The old page's answer arrives after the switch
    act(() => first.getText('contents').insert(0, `${B} `));
    server.hold = true;
    await pass(SCAN_DEBOUNCE_MS);

    const second = docWith(`See ${C}`);
    rerender(options(second, { docId: 'relay-doc-2', path: '/Lens/Notes/other.md' }));
    expect(result.current.model.kind).toBe('hidden');

    await pass(0);
    server.release();
    await pass(0);
    expect(result.current.model.rows.map((row) => row.url)).toEqual([C]);
  });

  it('forgets a job and its polling', async () => {
    server.set(A, { state: 'importing', job_id: 'j1' });
    const { result, rerender } = await open(docWith(`See ${A}`));
    expect(result.current.model.kind).toBe('working');

    rerender(options(docWith('Nothing here.'), { docId: 'relay-doc-2' }));
    await pass(POLL_MS * 3);
    expect(result.current.model.kind).toBe('hidden');
    expect(server.checks).toHaveLength(1);
  });

  it('forgets even if the Y.Doc object is the same one', async () => {
    const doc = docWith(`See ${A}`);
    const { result, rerender } = await open(doc);
    const first = result.current.session;
    rerender(options(doc, { docId: 'relay-doc-2' }));
    await pass(0);
    expect(result.current.session).not.toBe(first);
  });

  it('sends the page\'s new path after a rename, without starting over', async () => {
    const doc = docWith(`See ${A}`);
    const { result, rerender } = await open(doc);
    const { session } = result.current;
    rerender(options(doc, { path: '/Lens/Notes/renamed.md' }));
    await pass(0);
    expect(result.current.session).toBe(session);
    act(() => result.current.session?.accept([A]));
    await pass(0);
    expect(server.imports[0].linkBack.path).toBe('Lens/Notes/renamed.md');
  });
});

describe('accepting', () => {
  it('sends the link-back, with no protectHuman and no leading slash', async () => {
    const { result } = await open(docWith(`See ${A}`));
    act(() => result.current.session?.accept([A]));
    await pass(0);
    expect(server.imports).toEqual([
      {
        urls: [A],
        importMode: 'article',
        linkBack: { path: 'Lens/Notes/page.md', actor: 'human:Luc', author: 'Luc' },
      },
    ]);
    expect(server.imports[0].linkBack).not.toHaveProperty('protectHuman');
  });

  it('follows human:unknown when there is no display name', async () => {
    const { result } = await open(docWith(`See ${A}`), { displayName: null });
    act(() => result.current.session?.accept([A]));
    await pass(0);
    expect(server.imports[0].linkBack).toMatchObject({ actor: 'human:unknown', author: 'unknown' });
  });

  it('sends chunks of 20', async () => {
    const urls = Array.from({ length: 45 }, (_, i) => `https://example.com/${i}`);
    const { result } = await open(docWith(urls.join('\n\n')));
    act(() => result.current.session?.accept(urls));
    await pass(0);
    expect(server.imports.map((call) => call.urls.length)).toEqual([20, 20, 5]);
    expect(server.imports.flatMap((call) => call.urls)).toEqual(urls);
  });

  it('shows Working at once, before the server answers', async () => {
    const { result } = await open(docWith(`See ${A}`));
    act(() => result.current.session?.accept([A]));
    expect(result.current.model.kind).toBe('working');
    expect(result.current.model.canStop).toBe(false);
    await pass(0);
    expect(result.current.model.canStop).toBe(true);
    expect(result.current.model.text).toContain('about 8 min');
  });

  it('does not import a link deleted since it was listed', async () => {
    const doc = docWith(`See ${A} and ${B}`);
    const { result } = await open(doc);
    act(() => {
      replaceText(doc, `See ${A}`);
      result.current.session?.accept([A, B]);
    });
    await pass(0);
    expect(server.imports[0].urls).toEqual([A]);
  });

  it('does not send a link twice', async () => {
    const { result } = await open(docWith(`See ${A}`));
    act(() => {
      result.current.session?.accept([A]);
      result.current.session?.accept([A]);
    });
    await pass(0);
    expect(server.imports).toHaveLength(1);
  });

  it.each(['linked', 'suggested'] as const)('counts a %s row as done', async (status) => {
    server.importRows.set(A, { status, path: 'Lens/articles/a.md', title: 'A' });
    server.set(A, { state: 'library', path: 'Lens/articles/a.md', title: 'A' });
    const doc = docWith(`See ${A}`);
    const { result } = await open(doc);
    act(() => result.current.session?.accept([A]));
    await pass(0);
    expect(result.current.model.kind).toBe('done');
    expect(result.current.model.text).toBe(`1 source ${status}.`);
  });

  it.each(['invalid', 'link_failed'] as const)('shows a %s row as a failure, with its reason', async (status) => {
    server.importRows.set(A, { status, id: undefined, error: 'Not a valid http(s) URL' });
    const { result } = await open(docWith(`See ${A}`));
    act(() => result.current.session?.accept([A]));
    await pass(0);
    expect(result.current.model.kind).toBe('failed');
    expect(result.current.model.rows[0].error).toBe('Not a valid http(s) URL');
  });

  it('counts a link_failed row as done when the link has left the page', async () => {
    const doc = docWith(`See ${A}`);
    server.importRows.set(A, { status: 'link_failed', error: 'The link is no longer on the page' });
    const { result } = await open(doc);
    act(() => {
      result.current.session?.accept([A]);
      replaceText(doc, 'See [[a]]');
    });
    await pass(0);
    expect(result.current.model.kind).toBe('done');
  });

  it('shows the server\'s reason when it refuses the whole request', async () => {
    server.importStatus = 404;
    server.importError = 'No page at Lens/Notes/page.md';
    const { result } = await open(docWith(`See ${A}`));
    act(() => result.current.session?.accept([A]));
    await pass(0);
    expect(result.current.model.kind).toBe('failed');
    expect(result.current.model.rows[0].error).toBe('No page at Lens/Notes/page.md');
  });

  it('shows a failure, not silence, when accepting can\'t reach the server', async () => {
    const { result } = await open(docWith(`See ${A}`));
    server.failing = true;
    act(() => result.current.session?.accept([A]));
    await pass(0);
    expect(result.current.model.kind).toBe('failed');
  });

  it('keeps sending later chunks after one fails, and after leaving the page', async () => {
    const urls = Array.from({ length: 25 }, (_, i) => `https://example.com/${i}`);
    const { result, unmount } = await open(docWith(urls.join('\n\n')));
    act(() => result.current.session?.accept(urls));
    unmount();
    await pass(0);
    expect(server.imports).toHaveLength(2);
  });

  it('is not undone by a check that was asked before the job existed', async () => {
    const doc = docWith('');
    const { result } = await open(doc);
    act(() => doc.getText('contents').insert(0, A));
    server.hold = true;
    await pass(SCAN_DEBOUNCE_MS); // the check goes out, and will say "new"
    server.hold = false;

    act(() => result.current.session?.importSource(A));
    await pass(0);
    expect(result.current.model.kind).toBe('working');

    await act(async () => {
      server.release();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.model.kind).toBe('working');
  });
});

describe('finishing', () => {
  async function importing(text = `See ${A}`) {
    const doc = docWith(text);
    const hook = await open(doc);
    act(() => hook.result.current.session?.accept([A]));
    await pass(0);
    expect(hook.result.current.model.kind).toBe('working');
    return { doc, ...hook };
  }

  it('is done when the job ends and the link has been swapped', async () => {
    const { doc, result } = await importing();
    server.set(A, { state: 'library', path: 'Lens/articles/a.md' });
    await pass(POLL_MS);
    expect(result.current.model.text).toBe('Linking 1 source.');
    act(() => replaceText(doc, 'See [[a]]'));
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.text).toBe('1 source imported and linked.');
  });

  it('sees the swap at a poll even while someone keeps typing', async () => {
    const { doc, result } = await importing();
    server.set(A, { state: 'library', path: 'Lens/articles/a.md' });
    await pass(POLL_MS);
    act(() => replaceText(doc, 'See [[a]]'));
    for (let elapsed = 0; elapsed < POLL_MS; elapsed += 500) {
      act(() => doc.getText('contents').insert(0, 'x'));
      await pass(500);
    }
    expect(result.current.model.kind).toBe('done');
  });

  it('counts a link leaving the text at once when the job has ended', async () => {
    const { doc, result } = await importing();
    server.set(A, { state: 'library', path: 'Lens/articles/a.md' });
    act(() => replaceText(doc, 'See [[a]]'));
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.kind).toBe('done');
  });

  it('keeps Working, and Stop, while a deleted link\'s job still runs, then counts it', async () => {
    const { doc, result } = await importing();
    act(() => replaceText(doc, 'No link now.'));
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.kind).toBe('working');
    expect(result.current.model.canStop).toBe(true);

    server.set(A, { state: 'library', path: 'Lens/articles/a.md' });
    await pass(POLL_MS);
    expect(result.current.model.text).toBe('1 source imported and linked.');
  });

  it('drops a deleted link whose job fails: there is nothing left to fix', async () => {
    const { doc, result } = await importing();
    act(() => replaceText(doc, 'No link now.'));
    await pass(SCAN_DEBOUNCE_MS);
    server.set(A, { state: 'failed', job_id: `job:${A}`, error: 'No' });
    await pass(POLL_MS);
    expect(result.current.model.kind).toBe('hidden');
  });

  it('clears Done after 8 seconds', async () => {
    const { doc, result } = await importing();
    server.set(A, { state: 'library', path: 'Lens/articles/a.md' });
    act(() => replaceText(doc, 'See [[a]]'));
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.kind).toBe('done');
    await pass(DONE_CLEARS_MS - 1);
    expect(result.current.model.kind).toBe('done');
    await pass(1);
    expect(result.current.model.kind).toBe('hidden');
  });

  it('turns to an offer when the link stays, rather than claim it was linked', async () => {
    const { result } = await importing();
    server.set(A, { state: 'library', path: 'Lens/articles/a.md', title: 'A' });
    await pass(POLL_MS);
    expect(result.current.model.kind).toBe('working');
    await pass(SETTLE_MS + POLL_MS);
    expect(result.current.model.kind).toBe('offer');
    expect(result.current.model.text).toBe('A is already in the library.');
    const asked = server.checks.length;
    await pass(POLL_MS * 3);
    expect(server.checks).toHaveLength(asked);
  });

  it('turns a failed job to the Failed state', async () => {
    const { result } = await importing();
    server.set(A, { state: 'failed', job_id: `job:${A}`, error: 'The page could not be read' });
    await pass(POLL_MS);
    expect(result.current.model.kind).toBe('failed');
    expect(result.current.model.rows[0].error).toBe('The page could not be read');
  });

  it('goes back to the offer if the job was stopped elsewhere', async () => {
    const { result } = await importing();
    server.links.delete(A);
    await pass(POLL_MS);
    expect(result.current.model.kind).toBe('offer');
  });

  it('lets go of a job the server says is not a source, rather than sit in Working', async () => {
    const { result } = await importing();
    server.notSources.add(A);
    await pass(POLL_MS);
    expect(result.current.model.kind).toBe('hidden');
  });
});

describe('Stop', () => {
  it('cancels the running jobs, and does not offer them again to this person', async () => {
    const doc = docWith(`See ${A} and ${B}`);
    const { result, unmount } = await open(doc);
    act(() => result.current.session?.accept([A, B]));
    await pass(0);
    await act(async () => {
      await result.current.session?.stopImports();
    });
    expect(server.cancels).toEqual([[`job:${A}`, `job:${B}`]]);
    expect(result.current.model.kind).toBe('hidden');
    expect([...readSeenLinkOffers('relay-doc-1')]).toEqual([A, B]);
    expect(readLinkOffers(doc).size).toBe(0);
    unmount();
    const again = await open(doc);
    expect(again.result.current.model.kind).toBe('hidden');
  });

  it('still offers another source on the page after a Stop', async () => {
    const { result } = await open(docWith(`See ${A} and ${B}`));
    act(() => result.current.session?.accept([A]));
    await pass(0);
    await act(async () => {
      await result.current.session?.stopImports();
    });
    expect(result.current.model.rows.map((row) => row.url)).toEqual([B]);
  });

  it('stops polling', async () => {
    const { result } = await open(docWith(`See ${A}`));
    act(() => result.current.session?.accept([A]));
    await pass(0);
    await act(async () => {
      await result.current.session?.stopImports();
    });
    const asked = server.checks.length;
    await pass(POLL_MS * 3);
    expect(server.checks).toHaveLength(asked);
  });

  it('stays Working for a job too far along to stop', async () => {
    const { result } = await open(docWith(`See ${A}`));
    act(() => result.current.session?.accept([A]));
    await pass(0);
    server.uncancellable.add(`job:${A}`);
    await act(async () => {
      await result.current.session?.stopImports();
    });
    expect(result.current.model.kind).toBe('working');
  });

  it('is not undone by a poll that was out when it landed', async () => {
    server.set(A, { state: 'importing', job_id: 'j1' });
    const { result } = await open(docWith(`See ${A}`));
    server.hold = true;
    await pass(POLL_MS); // the poll goes out, and will say "importing"
    server.hold = false;

    await act(async () => {
      await result.current.session?.stopImports();
    });
    expect(result.current.model.kind).toBe('hidden');

    await act(async () => {
      server.release();
      await vi.advanceTimersByTimeAsync(0);
    });
    // The stale "importing" brings back neither Working nor the offer
    expect(result.current.model.kind).toBe('hidden');
  });
});

describe('Retry', () => {
  async function failedJob() {
    server.set(A, { state: 'failed', job_id: 'j1', error: 'Timed out' });
    const hook = await open(docWith(`See ${A}`));
    expect(hook.result.current.model.kind).toBe('failed');
    return hook;
  }

  it('retries the job and shows Working', async () => {
    const { result } = await failedJob();
    server.set(A, { state: 'queued', job_id: 'j1-again' });
    act(() => result.current.session?.retry());
    expect(result.current.model.kind).toBe('working');
    await pass(0);
    expect(server.retries).toEqual(['j1']);
    expect(server.imports).toHaveLength(0);
    expect(result.current.model.kind).toBe('working');
    expect(result.current.model.canStop).toBe(true);
  });

  it('follows the running job when someone else got there first', async () => {
    server.retryStatus = 409;
    const { result } = await failedJob();
    server.set(A, { state: 'queued', job_id: 'running-job' });
    act(() => result.current.session?.retry());
    await pass(0);
    expect(result.current.model.kind).toBe('working');
    expect(result.current.model.rows[0].jobIds).toEqual(['running-job']);
  });

  it('stays Failed when the retry is refused', async () => {
    server.retryStatus = 400;
    const { result } = await failedJob();
    act(() => result.current.session?.retry());
    await pass(0);
    expect(result.current.model.kind).toBe('failed');
  });

  it('sends a failure with no job through the import again', async () => {
    server.importRows.set(A, { status: 'link_failed', id: undefined, error: 'Relay timeout' });
    const { result } = await open(docWith(`See ${A}`));
    act(() => result.current.session?.accept([A]));
    await pass(0);
    expect(result.current.model.kind).toBe('failed');

    server.importRows.delete(A);
    act(() => result.current.session?.retry());
    await pass(0);
    expect(server.imports).toHaveLength(2);
    expect(server.retries).toEqual([]);
    expect(result.current.model.kind).toBe('working');
  });

  it('picks a retried job up when someone else retries it', async () => {
    const { result } = await failedJob();
    server.set(A, { state: 'queued', job_id: 'j2' });
    act(() => result.current.session?.importSource(A));
    await pass(0);
    expect(result.current.model.kind).toBe('working');
  });
});

describe('dismissing', () => {
  it('writes the listed URLs, for everyone, and hides the bar', async () => {
    const doc = docWith(`See ${A} and ${B}`);
    const { result } = await open(doc);
    act(() => result.current.session?.dismiss(result.current.model.dismissUrls ?? []));
    expect(result.current.model.kind).toBe('hidden');
    expect(readLinkOffers(doc).get(A)?.by).toBe('Luc');
    expect(readLinkOffers(doc).has(B)).toBe(true);
    expect(server.imports).toHaveLength(0);
  });

  it('shows a dismissal someone else makes, straight away', async () => {
    const doc = docWith(`See ${A}`);
    const { result } = await open(doc);
    act(() => dismissLinkOffers(doc, [A], 'Sam'));
    expect(result.current.model.kind).toBe('hidden');
  });

  it('stays dismissed when the page is reopened', async () => {
    const doc = docWith(`See ${A}`);
    const first = await open(doc);
    act(() => first.result.current.session?.dismiss([A]));
    first.unmount();

    const { result } = await open(doc);
    expect(result.current.model.kind).toBe('hidden');
  });

  it('asks about a new link on a page where others were dismissed', async () => {
    const doc = docWith(`See ${A}`);
    dismissLinkOffers(doc, [A], 'Sam');
    const { result } = await open(doc);
    act(() => doc.getText('contents').insert(0, `${B} `));
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.rows.map((row) => row.url)).toEqual([B]);
  });

  it('clears what finished along with the failures', async () => {
    server.importRows.set(A, { status: 'linked' });
    server.importRows.set(B, { status: 'invalid', id: undefined, error: 'No' });
    const doc = docWith(`See ${A} and ${B}`);
    const { result } = await open(doc);
    act(() => result.current.session?.accept([A, B]));
    await pass(0);
    act(() => replaceText(doc, `See [[a]] and ${B}`)); // A's link was swapped
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.kind).toBe('failed');
    act(() => result.current.session?.dismiss(result.current.model.dismissUrls ?? []));
    expect(result.current.model.kind).toBe('hidden');
  });
});

describe('the right-click', () => {
  it('imports one link, clears its dismissal and shows Working', async () => {
    const doc = docWith(`See ${A}`);
    dismissLinkOffers(doc, [A], 'Sam');
    const { result } = await open(doc);
    expect(result.current.model.kind).toBe('hidden');

    act(() => result.current.session?.importSource(A));
    expect(readLinkOffers(doc).has(A)).toBe(false);
    expect(result.current.model.kind).toBe('working');
    await pass(0);
    expect(server.imports[0].urls).toEqual([A]);
    expect(server.imports[0].linkBack.actor).toBe('human:Luc');
  });

  it('works on a link pasted a moment ago, before the scan', async () => {
    const doc = docWith('');
    const { result } = await open(doc);
    act(() => doc.getText('contents').insert(0, A));
    act(() => result.current.session?.importSource(A));
    await pass(0);
    expect(result.current.model.kind).toBe('working');
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.kind).toBe('working');
  });

  it('is not offered for a link known not to be a source', async () => {
    server.notSources.add(A);
    const { result } = await open(docWith(`See ${A} and ${B}`));
    expect(result.current.session?.canImport(A)).toBe(false);
    expect(result.current.session?.canImport(B)).toBe(true);
  });

  it('is not offered once the page has become ineligible', async () => {
    const doc = docWith(`See ${A}`);
    const { result } = await open(doc);
    expect(result.current.session?.canImport(A)).toBe(true);
    act(() => replaceText(doc, `---\nsource_url: x\n---\nSee ${A}`));
    expect(result.current.session?.canImport(A)).toBe(false);
  });
});

describe('a URL spelled two ways', () => {
  const PLAIN = 'https://example.com/post';
  const TAGGED = 'https://www.example.com/post/?utm_source=x';

  it('is one row once the server shows they are one source', async () => {
    server.set(PLAIN, { key: 'post', state: 'library', path: 'Lens/articles/post.md', title: 'Post' });
    server.set(TAGGED, { key: 'post', state: 'library', path: 'Lens/articles/post.md', title: 'Post' });
    const { result } = await open(docWith(`${PLAIN} and ${TAGGED}`));
    expect(result.current.model.text).toBe('Post is already in the library.');
    expect(result.current.model.primary?.urls).toEqual([PLAIN, TAGGED]);
    expect(result.current.model.dismissUrls).toEqual([PLAIN, TAGGED]);
  });

  it('is one row while it is new', async () => {
    server.set(PLAIN, { key: 'post' });
    server.set(TAGGED, { key: 'post' });
    const { result } = await open(docWith(`${PLAIN} and ${TAGGED}`));
    expect(result.current.model.rows).toHaveLength(1);
    expect(result.current.model.primary?.urls).toEqual([PLAIN, TAGGED]);
  });

  it('counts one job once, and imports both spellings', async () => {
    server.set(PLAIN, { key: 'post' });
    server.set(TAGGED, { key: 'post' });
    const { result } = await open(docWith(`${PLAIN} and ${TAGGED}`));
    server.importRows.set(PLAIN, { status: 'queued', id: 'j1' });
    server.importRows.set(TAGGED, { status: 'already_queued', id: 'j1' });
    act(() => result.current.session?.accept([PLAIN, TAGGED]));
    await pass(0);
    server.set(PLAIN, { key: 'post', state: 'queued', job_id: 'j1' });
    server.set(TAGGED, { key: 'post', state: 'queued', job_id: 'j1' });
    await pass(POLL_MS);
    expect(server.imports[0].urls).toEqual([PLAIN, TAGGED]);
    expect(result.current.model.text).toContain('Importing 1 source');
    await act(async () => {
      await result.current.session?.stopImports();
    });
    expect(server.cancels).toEqual([['j1']]);
  });

  it('survives an already_queued row with no job id', async () => {
    const { result } = await open(docWith(`${PLAIN} and ${TAGGED}`));
    server.importRows.set(TAGGED, { status: 'already_queued', id: undefined });
    act(() => result.current.session?.accept([PLAIN, TAGGED]));
    await pass(0);
    expect(result.current.model.kind).toBe('working');
  });
});

describe('the bar stays put while the text moves', () => {
  it('keeps the old offer up until the new URL has an answer', async () => {
    const doc = docWith(`See ${A}`);
    const { result } = await open(doc);
    expect(result.current.model.rows.map((row) => row.url)).toEqual([A]);

    // The URL being typed: a pause at /a, then it grows to /ab
    server.hold = true;
    act(() => replaceText(doc, `See ${A}b`));
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.kind).toBe('offer');
    expect(result.current.model.rows.map((row) => row.url)).toEqual([A]);

    await act(async () => {
      server.release();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.model.rows.map((row) => row.url)).toEqual([`${A}b`]);
  });

  it('does not flicker when a link is cut and pasted back', async () => {
    const doc = docWith(`See ${A}`);
    const { result } = await open(doc);
    const kinds: string[] = [];
    const watch = () => kinds.push(result.current.model.kind);

    act(() => replaceText(doc, 'See '));
    await pass(SCAN_DEBOUNCE_MS);
    watch();
    await pass(OFFER_HOLD_MS - SCAN_DEBOUNCE_MS);
    watch();
    act(() => replaceText(doc, `See ${A}`));
    await pass(SCAN_DEBOUNCE_MS);
    watch();
    expect(kinds).toEqual(['offer', 'offer', 'offer']);
    expect(server.checks).toEqual([[A]]);
  });

  it('holds while someone is still typing, and leaves at the next pause', async () => {
    const doc = docWith(`See ${A}`);
    const { result } = await open(doc);
    act(() => replaceText(doc, 'Gone. '));
    await pass(SCAN_DEBOUNCE_MS);
    for (let elapsed = 0; elapsed < OFFER_HOLD_MS * 2; elapsed += 500) {
      act(() => doc.getText('contents').insert(0, 'x'));
      await pass(500);
    }
    expect(result.current.model.kind).toBe('offer');
    await pass(SCAN_DEBOUNCE_MS + OFFER_HOLD_MS);
    expect(result.current.model.kind).toBe('hidden');
  });

  it('leaves once the last link has really gone', async () => {
    const doc = docWith(`See ${A}`);
    const { result } = await open(doc);
    act(() => replaceText(doc, 'See '));
    await pass(SCAN_DEBOUNCE_MS + OFFER_HOLD_MS);
    expect(result.current.model.kind).toBe('hidden');
  });

  it('drops a deleted row at once when others remain', async () => {
    const doc = docWith(`See ${A} and ${B} and ${C}`);
    const { result } = await open(doc);
    act(() => replaceText(doc, `See ${A} and ${C}`));
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.rows.map((row) => row.url)).toEqual([A, C]);
    expect(result.current.model.text).toBe("2 sources on this page aren't in the library yet.");
  });

  it('brings an undone deletion back without asking the server', async () => {
    const doc = docWith(`See ${A} and ${B}`);
    const undo = new Y.UndoManager(doc.getText('contents'));
    const { result } = await open(doc);

    act(() => {
      const ytext = doc.getText('contents');
      ytext.delete(`See ${A}`.length, ` and ${B}`.length);
    });
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.text).toBe("example.com/a isn't in the library yet.");

    act(() => {
      undo.undo();
    });
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.text).toBe("2 sources on this page aren't in the library yet.");
    expect(server.checks).toEqual([[A, B]]);
  });

  it('does not offer a link again once it was linked, when it is written again', async () => {
    server.importRows.set(A, { status: 'linked', path: 'Lens/articles/a.md' });
    const doc = docWith(`See ${A}`);
    const { result } = await open(doc);
    act(() => result.current.session?.accept([A]));
    await pass(0);
    act(() => replaceText(doc, 'See [[a]]'));
    await pass(SCAN_DEBOUNCE_MS + DONE_CLEARS_MS);
    expect(result.current.model.kind).toBe('hidden');

    act(() => replaceText(doc, `See ${A}`));
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.kind).toBe('hidden');
    expect(result.current.session?.canImport(A)).toBe(true);
  });
});

describe('the page and the job list', () => {
  const RELAY_PATH = 'Lens/Notes/page.md';

  it('tells the server which page is asking', async () => {
    await open(docWith(`See ${A}`));
    expect(server.checkPaths).toEqual([RELAY_PATH]);
  });

  it('keeps telling it while polling', async () => {
    server.set(A, { state: 'queued', job_id: 'j1' });
    await open(docWith(`See ${A}`));
    await pass(POLL_MS);
    expect(server.checkPaths).toEqual([RELAY_PATH, RELAY_PATH]);
  });

  it('offers a source whose job is someone else\'s, as the server reports it, and accepting joins', async () => {
    const { result } = await open(docWith(`See ${A}`));
    expect(result.current.model.kind).toBe('offer');
    server.importRows.set(A, { status: 'already_queued', id: 'theirs' });
    act(() => result.current.session?.accept([A]));
    await pass(0);
    expect(result.current.model.kind).toBe('working');
    expect(result.current.model.rows[0].jobIds).toEqual(['theirs']);
  });

  it('tells the server which page is stopping', async () => {
    const { result } = await open(docWith(`See ${A}`));
    act(() => result.current.session?.accept([A]));
    await pass(0);
    await act(async () => {
      await result.current.session?.stopImports();
    });
    expect(server.cancelPaths).toEqual([RELAY_PATH]);
  });

  it('counts a detached job as stopped for this page', async () => {
    const { result } = await open(docWith(`See ${A}`));
    server.importRows.set(A, { status: 'already_queued', id: 'theirs' });
    server.shared.add('theirs');
    act(() => result.current.session?.accept([A]));
    await pass(0);
    await act(async () => {
      await result.current.session?.stopImports();
    });
    expect(server.cancelPaths).toEqual(['Lens/Notes/page.md']);
    expect(result.current.model.kind).toBe('hidden');
    await pass(POLL_MS * 2);
    expect(result.current.model.kind).toBe('hidden');
  });
});

describe('what became of the link', () => {
  async function importing() {
    const doc = docWith(`See ${A}`);
    const hook = await open(doc);
    act(() => hook.result.current.session?.accept([A]));
    await pass(0);
    return { doc, ...hook };
  }
  const ended = (link_state: 'waiting' | 'linked' | 'suggested' | 'not_found' | 'failed') =>
    server.set(A, { state: 'library', path: 'Lens/articles/a.md', title: 'A', link_state });

  it('claims nothing when the link was deleted during the import', async () => {
    const { doc, result } = await importing();
    act(() => replaceText(doc, 'No link now.'));
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.kind).toBe('working');
    ended('not_found');
    await pass(POLL_MS);
    expect(result.current.model.kind).toBe('hidden');
  });

  it('counts a link that really changed', async () => {
    const { result } = await importing();
    ended('linked');
    await pass(POLL_MS);
    expect(result.current.model.text).toBe('1 source imported and linked.');
  });

  it('says suggested when the swap is a pending suggestion', async () => {
    const { result } = await importing();
    ended('suggested');
    await pass(POLL_MS);
    expect(result.current.model.text).toBe('1 source imported and suggested.');
  });

  it('goes back to the offer when the swap failed', async () => {
    const { result } = await importing();
    ended('failed');
    await pass(POLL_MS);
    expect(result.current.model.kind).toBe('offer');
  });

  it('waits to hear, polling, rather than guess from the text', async () => {
    const { doc, result } = await importing();
    ended('waiting');
    act(() => replaceText(doc, 'See [[a]]'));
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.text).toBe('Linking 1 source.');
    const asked = server.checks.length;
    ended('linked');
    await pass(POLL_MS);
    expect(server.checks.length).toBeGreaterThan(asked);
    expect(result.current.model.text).toBe('1 source imported and linked.');
  });

  it('lets go if it never hears', async () => {
    const { doc, result } = await importing();
    ended('waiting');
    act(() => replaceText(doc, 'No link now.'));
    await pass(SCAN_DEBOUNCE_MS + SETTLE_MS + POLL_MS);
    expect(result.current.model.kind).toBe('hidden');
    const asked = server.checks.length;
    await pass(POLL_MS * 3);
    expect(server.checks).toHaveLength(asked);
  });
});

describe('a bare URL the caret is on', () => {
  const held = (doc: Y.Doc) => doc.getText('contents').toString().indexOf(A) + A.length;

  async function typed(text: string, caret: (doc: Y.Doc) => number) {
    const doc = docWith('');
    const hook = await open(doc);
    act(() => {
      doc.getText('contents').insert(0, text);
      hook.result.current.session?.setCaret(caret(doc));
    });
    await pass(SCAN_DEBOUNCE_MS);
    return { doc, ...hook };
  }

  it('asks nothing and offers nothing while the caret is at its end', async () => {
    const { result } = await typed(`See ${A}`, held);
    expect(result.current.model.kind).toBe('hidden');
    expect(server.requests).toBe(0);
  });

  it('holds it with the caret inside', async () => {
    await typed(`See ${A} more`, (doc) => held(doc) - 3);
    expect(server.requests).toBe(0);
  });

  it('does not hold it with the caret at its start', async () => {
    const { result } = await typed(`See ${A} more`, (doc) => held(doc) - A.length);
    expect(result.current.model.kind).toBe('offer');
  });

  it('offers it once the caret has left, with no text change', async () => {
    const { result } = await typed(`See ${A}`, held);
    act(() => result.current.session?.setCaret(0));
    await pass(0);
    expect(server.checks).toEqual([[A]]);
    expect(result.current.model.kind).toBe('offer');
  });

  it('offers it once typing has moved past it', async () => {
    const { doc, result } = await typed(`See ${A}`, held);
    act(() => {
      doc.getText('contents').insert(doc.getText('contents').length, ' and');
      result.current.session?.setCaret(doc.getText('contents').length);
    });
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.kind).toBe('offer');
  });

  it('does not scan for a caret moving around inside it, or anywhere else', async () => {
    const { doc, result } = await typed(`See ${A} and ${B}`, held);
    const before = server.checks.length;
    const end = held(doc);
    const scan = vi.spyOn(doc.getText('contents'), 'toString');
    act(() => result.current.session?.setCaret(end - 1));
    act(() => result.current.session?.setCaret(end - 2));
    expect(scan).not.toHaveBeenCalled();
    act(() => result.current.session?.setCaret(0));
    await pass(0);
    scan.mockClear();
    act(() => result.current.session?.setCaret(1));
    act(() => result.current.session?.setCaret(2));
    expect(scan).not.toHaveBeenCalled();
    expect(server.checks.length).toBe(before + 1);
  });

  it('holds a link with a label while its URL is typed, inside the ) closeBrackets added', async () => {
    const inside = await typed(`See [a](${A})`, (doc) => doc.getText('contents').length - 1);
    expect(inside.result.current.model.kind).toBe('hidden');
    const after = await typed(`See [a](${A})`, (doc) => doc.getText('contents').length);
    expect(after.result.current.model.kind).toBe('hidden');
    expect(server.requests).toBe(0);
    act(() => after.result.current.session?.setCaret(0));
    await pass(0);
    expect(after.result.current.model.kind).toBe('offer');
  });

  it('holds an autolink the same way, and not one the caret is in front of', async () => {
    const at = await typed(`See <${B}>`, (doc) => doc.getText('contents').length);
    expect(at.result.current.model.kind).toBe('hidden');
    const before = await typed(`See <${B}>`, (doc) => doc.getText('contents').toString().indexOf('<'));
    expect(before.result.current.model.kind).toBe('offer');
  });

  it('does not hold a URL that is finished elsewhere on the page', async () => {
    const { result } = await typed(`${A} and again ${A}`, (doc) => doc.getText('contents').length);
    expect(result.current.model.kind).toBe('offer');
  });

  it('does not take a held URL for one that left the page', async () => {
    const doc = docWith(`See ${A}`);
    const { result } = await open(doc);
    act(() => result.current.session?.accept([A]));
    await pass(0);
    act(() => {
      doc.getText('contents').insert(0, 'x');
      result.current.session?.setCaret(held(doc));
    });
    server.set(A, { state: 'library', path: 'Lens/articles/a.md' });
    await pass(SCAN_DEBOUNCE_MS + POLL_MS);
    expect(result.current.model.text).toBe('Linking 1 source.');
  });
});

describe('only links this person adds', () => {
  it('offers nothing for links already on the page when it opens', async () => {
    const { result } = await open(pageWith(`See ${A} and ${B}`));
    await pass(SCAN_DEBOUNCE_MS + OFFER_SEEN_MS);
    expect(result.current.model.kind).toBe('hidden');
  });

  it('offers a link the person adds, and not the ones already there', async () => {
    const doc = pageWith(`See ${A}`);
    const { result } = await open(doc);
    act(() => doc.getText('contents').insert(0, `${B} `));
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.rows.map((row) => row.url)).toEqual([B]);
  });

  it('offers nothing for a link someone else adds while the page is open', async () => {
    const doc = pageWith('See');
    const { result } = await open(doc);
    act(() => editElsewhere(doc, (text) => text.insert(3, ` ${A}`)));
    await pass(SCAN_DEBOUNCE_MS + OFFER_SEEN_MS);
    expect(result.current.model.kind).toBe('hidden');
  });

  it("keeps the person's link theirs when someone else types nearby before the scan", async () => {
    const doc = pageWith('See');
    const { result } = await open(doc);
    act(() => doc.getText('contents').insert(3, ` ${A}`));
    act(() => editElsewhere(doc, (text) => text.insert(0, 'Also: ')));
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.rows.map((row) => row.url)).toEqual([A]);
  });

  it('offers nothing for a link that arrives with the page after it opened', async () => {
    const source = docWith(`See ${A}`);
    const doc = new Y.Doc();
    const { result } = await open(doc);
    act(() => Y.applyUpdate(doc, Y.encodeStateAsUpdate(source), 'server'));
    await pass(SCAN_DEBOUNCE_MS + OFFER_SEEN_MS);
    expect(result.current.model.kind).toBe('hidden');
  });

  it('does not offer a link already on the page that the person moves or writes again', async () => {
    const doc = pageWith(`See ${A}\n\nMore.`);
    const { result } = await open(doc);
    act(() => replaceText(doc, `More.\n\nSee ${A}`));
    await pass(SCAN_DEBOUNCE_MS);
    act(() => doc.getText('contents').insert(0, `${A} `));
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.kind).toBe('hidden');
  });

  it("does not offer a link the person writes again that someone else's text has too", async () => {
    const doc = pageWith(`See ${A}`);
    const { result } = await open(doc);
    act(() => doc.getText('contents').insert(0, `[again](${A}) `));
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.kind).toBe('hidden');
  });

  it('does not count editing the label of an old link as adding it', async () => {
    const doc = pageWith(`See [Old](${A})`);
    const { result } = await open(doc);
    act(() => {
      const text = doc.getText('contents');
      text.delete(5, 3);
      text.insert(5, 'New title');
    });
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.kind).toBe('hidden');
  });

  it("keeps the person's links theirs when their clientID turns over", async () => {
    const doc = pageWith('See');
    const { result } = await open(doc);
    act(() => doc.getText('contents').insert(3, ` ${A}`));
    act(() => {
      doc.clientID = 123_456_789; // a new day or a new name
      doc.getText('contents').insert(0, `${B} `);
    });
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.rows.map((row) => row.url)).toEqual([B, A]);
  });

  it('still lets the right-click import a link that was already there', async () => {
    const { result } = await open(pageWith(`See ${A}`));
    expect(result.current.session?.canImport(A)).toBe(true);
    act(() => result.current.session?.importSource(A));
    await pass(0);
    expect(result.current.model.kind).toBe('working');
  });
});

describe('once per person', () => {
  const DOC_ID = 'relay-doc-1';

  it('counts an offer as seen after 5 seconds on screen', async () => {
    await open(docWith(`See ${A}`));
    await pass(OFFER_SEEN_MS - 1);
    expect(readSeenLinkOffers(DOC_ID).size).toBe(0);
    await pass(1);
    expect([...readSeenLinkOffers(DOC_ID)]).toEqual([A]);
  });

  it('does not take the offer away mid-visit', async () => {
    const { result } = await open(docWith(`See ${A}`));
    await pass(OFFER_SEEN_MS * 3);
    expect(result.current.model.kind).toBe('offer');
  });

  it('does not offer it on the next visit', async () => {
    const doc = docWith(`See ${A}`);
    const first = await open(doc);
    await pass(OFFER_SEEN_MS);
    first.unmount();

    const { result } = await open(reloaded(doc));
    expect(result.current.model.kind).toBe('hidden');
  });

  it('does not offer it on the next visit however briefly it was up', async () => {
    const doc = docWith(`See ${A}`);
    const first = await open(doc);
    await pass(1000);
    first.unmount();

    const { result } = await open(reloaded(doc));
    expect(result.current.model.kind).toBe('hidden');
  });

  it('does not offer it when the person writes it again on a later visit', async () => {
    const doc = docWith(`See ${A}`);
    const first = await open(doc);
    await pass(OFFER_SEEN_MS);
    first.unmount();

    const again = pageWith('See');
    const { result } = await open(again);
    act(() => again.getText('contents').insert(3, ` ${A}`));
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.kind).toBe('hidden');
  });

  it('times a new link from when it was offered', async () => {
    const doc = docWith(`See ${A}`);
    await open(doc);
    await pass(3000);
    act(() => doc.getText('contents').insert(0, `${B} `));
    await pass(SCAN_DEBOUNCE_MS);
    await pass(OFFER_SEEN_MS - SCAN_DEBOUNCE_MS);
    expect([...readSeenLinkOffers(DOC_ID)]).toEqual([A]);
    await pass(SCAN_DEBOUNCE_MS);
    expect([...readSeenLinkOffers(DOC_ID)]).toEqual([A, B]);
  });

  it('offers a new link at once on a page seen before', async () => {
    const doc = docWith(`See ${A}`);
    const first = await open(doc);
    await pass(OFFER_SEEN_MS);
    first.unmount();

    const again = reloaded(doc);
    const { result } = await open(again);
    act(() => again.getText('contents').insert(0, `${B} `));
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.rows.map((row) => row.url)).toEqual([B]);
  });

  it('keeps pages apart', async () => {
    const doc = docWith(`See ${A}`);
    const first = await open(doc);
    await pass(OFFER_SEEN_MS);
    first.unmount();

    const { result } = await open(docWith(`See ${A}`), { docId: 'relay-doc-2' });
    expect(result.current.model.kind).toBe('offer');
  });

  it('does not count time while the page is hidden', async () => {
    await open(docWith(`See ${A}`));
    await pass(2000);
    act(() => setVisibility('hidden'));
    await pass(OFFER_SEEN_MS * 2);
    expect(readSeenLinkOffers(DOC_ID).size).toBe(0);
    await act(async () => {
      setVisibility('visible');
      await vi.advanceTimersByTimeAsync(0);
    });
    await pass(OFFER_SEEN_MS - 1);
    expect(readSeenLinkOffers(DOC_ID).size).toBe(0);
    await pass(1);
    expect(readSeenLinkOffers(DOC_ID).size).toBe(1);
  });

  it('shows the next visit an import accepted on this one that is still running', async () => {
    const doc = docWith(`See ${A}`);
    const first = await open(doc);
    act(() => first.result.current.session?.accept([A]));
    await pass(0);
    first.unmount();

    server.set(A, { state: 'importing', job_id: `job:${A}` });
    const { result } = await open(reloaded(doc));
    expect(result.current.model.kind).toBe('working');
  });

  it('shows the next visit the failure of an import accepted on this one, once', async () => {
    const doc = docWith(`See ${A}`);
    const first = await open(doc);
    act(() => first.result.current.session?.accept([A]));
    await pass(0);
    first.unmount();

    server.set(A, { state: 'failed', job_id: `job:${A}`, error: 'Timed out' });
    const second = await open(reloaded(doc));
    expect(second.result.current.model.kind).toBe('failed');
    await pass(OFFER_SEEN_MS * 2);
    expect(second.result.current.model.kind).toBe('failed');
    second.unmount();

    const { result } = await open(reloaded(doc));
    expect(result.current.model.kind).toBe('hidden');
  });

  it('forgets an accepted import once it is linked', async () => {
    const doc = docWith(`See ${A}`);
    const first = await open(doc);
    act(() => first.result.current.session?.accept([A]));
    await pass(0);
    server.set(A, { state: 'library', path: 'Lens/articles/a.md', link_state: 'linked' });
    act(() => replaceText(doc, 'See [[a]]'));
    await pass(POLL_MS + SCAN_DEBOUNCE_MS);
    expect(first.result.current.model.kind).toBe('done');
    await pass(DONE_CLEARS_MS);
    first.unmount();
    expect(localStorage.getItem('lens-editor:accepted-link-offers:relay-doc-1')).toBeNull();
  });

  it("shows nobody else someone's running import or failure", async () => {
    const doc = docWith(`See ${A}`);
    const first = await open(doc);
    act(() => first.result.current.session?.accept([A]));
    await pass(0);
    first.unmount();
    localStorage.clear(); // someone else's browser

    server.set(A, { state: 'importing', job_id: `job:${A}` });
    const running = await open(reloaded(doc));
    expect(running.result.current.model.kind).toBe('hidden');
    running.unmount();
    server.set(A, { state: 'failed', job_id: `job:${A}` });
    const { result } = await open(reloaded(doc));
    expect(result.current.model.kind).toBe('hidden');
  });

  it('still lets the right-click import it', async () => {
    const doc = docWith(`See ${A}`);
    const first = await open(doc);
    await pass(OFFER_SEEN_MS);
    first.unmount();

    const { result } = await open(reloaded(doc));
    expect(result.current.session?.canImport(A)).toBe(true);
    act(() => result.current.session?.importSource(A));
    await pass(0);
    expect(result.current.model.kind).toBe('working');
  });

  it('sets rows aside for this person alone, even when they write it again', async () => {
    const doc = docWith(`See ${A} and ${B}`);
    const { result } = await open(doc);
    act(() => result.current.session?.setAside([B]));
    expect(result.current.model.rows.map((row) => row.url)).toEqual([A]);
    expect(readLinkOffers(doc).size).toBe(0);

    act(() => replaceText(doc, `See ${A}`));
    await pass(SCAN_DEBOUNCE_MS);
    act(() => replaceText(doc, `See ${A} and ${B}`));
    await pass(SCAN_DEBOUNCE_MS + OFFER_HOLD_MS);
    expect(result.current.model.rows.map((row) => row.url)).toEqual([A]);
    expect([...readSeenLinkOffers(DOC_ID)]).toContain(B);
  });

  it('copes with storage that is full or refused', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const { result } = await open(docWith(`See ${A}`));
    await pass(OFFER_SEEN_MS);
    expect(result.current.model.kind).toBe('offer');
    setItem.mockRestore();
  });
});

describe('swapping in the open editor', () => {
  const LIBRARY = { state: 'library', path: 'Lens/articles/a.md', title: 'A' } as const;

  /** Stands in for the editor: swaps the text as the real one does. */
  function editor(doc: Y.Doc, answer?: string[]) {
    return vi.fn((hits: Array<{ urls: string[]; path: string; title?: string }>) => {
      const swapped = answer ?? hits.flatMap((hit) => hit.urls);
      for (const url of swapped) {
        const contents = doc.getText('contents');
        const at = contents.toString().indexOf(url);
        contents.delete(at, url.length);
        contents.insert(at, '[[a|A]]');
      }
      return swapped;
    });
  }

  it('swaps what the library has, sends nothing, and says so at once', async () => {
    server.set(A, LIBRARY);
    const doc = docWith(`See ${A}`);
    const swapInPage = editor(doc);
    const { result } = await open(doc, { swapInPage });
    act(() => result.current.session?.accept([A]));
    expect(swapInPage).toHaveBeenCalledWith([{ urls: [A], path: 'Lens/articles/a.md', title: 'A' }]);
    expect(result.current.model.text).toBe('1 source linked.');
    await pass(0);
    expect(server.imports).toEqual([]);
  });

  it('hands every library hit of one accept over in one call, and the rest to the server', async () => {
    server.set(A, LIBRARY);
    server.set(B, { state: 'library', path: 'Lens/articles/b.md', title: 'B' });
    const doc = docWith(`${A} and ${B} and ${C}`);
    const swapInPage = editor(doc);
    const { result } = await open(doc, { swapInPage });
    act(() => result.current.session?.accept([A, B, C]));
    await pass(0);
    expect(swapInPage).toHaveBeenCalledTimes(1);
    expect(swapInPage.mock.calls[0][0].map((hit) => hit.path)).toEqual(['Lens/articles/a.md', 'Lens/articles/b.md']);
    expect(server.imports.map((call) => call.urls)).toEqual([[C]]);
  });

  it('passes spellings of one source as one hit', async () => {
    const SECOND = `${A}?utm_source=x`;
    server.set(A, { ...LIBRARY, key: 'a' });
    server.set(SECOND, { ...LIBRARY, key: 'a' });
    const doc = docWith(`${A} and ${SECOND}`);
    const swapInPage = vi.fn(() => [A, SECOND]);
    const { result } = await open(doc, { swapInPage });
    act(() => result.current.session?.accept([A, SECOND]));
    expect(swapInPage).toHaveBeenCalledWith([{ urls: [A, SECOND], path: 'Lens/articles/a.md', title: 'A' }]);
  });

  it('leaves to the server what it could not swap', async () => {
    server.set(A, LIBRARY);
    server.importRows.set(A, { status: 'linked', path: 'Lens/articles/a.md' });
    const doc = docWith(`See ${A}`);
    const { result } = await open(doc, { swapInPage: vi.fn(() => []) });
    act(() => result.current.session?.accept([A]));
    await pass(0);
    expect(server.imports).toHaveLength(1);
    expect(result.current.model.text).toBe('1 source linked.');
  });

  it('never touches a source the library does not have', async () => {
    const swapInPage = vi.fn(() => []);
    const { result } = await open(docWith(`See ${A}`), { swapInPage });
    act(() => result.current.session?.accept([A]));
    await pass(0);
    expect(swapInPage).not.toHaveBeenCalled();
  });

  it('leaves it all to the server in Suggesting mode, as suggestions', async () => {
    server.set(A, LIBRARY);
    server.importRows.set(A, { status: 'suggested' });
    const swapInPage = vi.fn(() => []);
    const { result } = await open(docWith(`See ${A}`), { suggesting: true, swapInPage });
    act(() => result.current.session?.accept([A]));
    await pass(0);
    expect(swapInPage).not.toHaveBeenCalled();
    expect(server.imports[0].linkBack.protectHuman).toBe(true);
    expect(result.current.model.text).toBe('1 source suggested.');
  });

  it('picks up a change of mode without starting over', async () => {
    server.set(A, LIBRARY);
    const doc = docWith(`See ${A}`);
    const { result, rerender } = await open(doc);
    const { session } = result.current;
    rerender(options(doc, { suggesting: true }));
    await pass(0);
    expect(result.current.session).toBe(session);
    act(() => result.current.session?.accept([A]));
    await pass(0);
    expect(server.imports[0].linkBack.protectHuman).toBe(true);
  });

  it('does not offer it again when an undo brings the link back', async () => {
    server.set(A, LIBRARY);
    const doc = docWith(`See ${A}`);
    const swapInPage = editor(doc);
    const { result } = await open(doc, { swapInPage });
    act(() => result.current.session?.accept([A]));
    await pass(SCAN_DEBOUNCE_MS);

    act(() => replaceText(doc, `See ${A}`));
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.kind).toBe('hidden');
    expect(server.checks).toEqual([[A]]);
    // The right-click still can
    act(() => result.current.session?.importSource(A));
    expect(swapInPage).toHaveBeenCalledTimes(2);
  });

  it('stays Done through the debounce that follows its own swap', async () => {
    server.set(A, LIBRARY);
    const doc = docWith(`See ${A}`);
    const { result } = await open(doc, { swapInPage: editor(doc) });
    act(() => result.current.session?.accept([A]));
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.kind).toBe('done');
    await pass(DONE_CLEARS_MS);
    expect(result.current.model.kind).toBe('hidden');
  });

  it('clears a stale offer at once when clicked', async () => {
    const doc = docWith(`See ${A}`);
    const { result } = await open(doc);
    act(() => replaceText(doc, 'Gone.'));
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.kind).toBe('offer');
    act(() => result.current.session?.accept([A]));
    expect(result.current.model.kind).toBe('hidden');
    expect(server.imports).toEqual([]);
  });
});

describe('someone else\'s caret', () => {
  /** Another person on the page: their state arrives in this awareness, as y-sweet delivers it. */
  function onTheSamePage(text: string) {
    const doc = docWith(text);
    const awareness = new Awareness(doc);
    const OTHER = awareness.clientID + 1;
    const placeOther = (index: number | null) => {
      if (index === null) awareness.states.delete(OTHER);
      else {
        const at = Y.createRelativePositionFromTypeIndex(doc.getText('contents'), index);
        awareness.states.set(OTHER, { cursor: { anchor: at, head: at } });
      }
      awareness.emit('change', [{ added: [], updated: [OTHER], removed: [] }, 'remote']);
    };
    return { doc, awareness, placeOther };
  }

  async function withAwareness(doc: Y.Doc, awareness: Awareness) {
    const hook = await open(doc);
    act(() => hook.result.current.session?.setAwareness(awareness));
    return hook;
  }

  it('holds a URL they are typing, with no request for it', async () => {
    const text = `See ${A}`;
    const { doc, awareness, placeOther } = onTheSamePage('');
    const { result } = await withAwareness(doc, awareness);
    act(() => {
      doc.getText('contents').insert(0, text);
      placeOther(text.length);
    });
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.kind).toBe('hidden');
    expect(server.requests).toBe(0);
  });

  it('offers it once their caret has left, with no text change here', async () => {
    const text = `See ${A}`;
    const { doc, awareness, placeOther } = onTheSamePage('');
    const { result } = await withAwareness(doc, awareness);
    act(() => {
      doc.getText('contents').insert(0, text);
      placeOther(text.length);
    });
    await pass(SCAN_DEBOUNCE_MS);
    act(() => placeOther(0));
    await pass(0);
    expect(result.current.model.kind).toBe('offer');
  });

  it('lets go when they leave the page', async () => {
    const text = `See ${A}`;
    const { doc, awareness, placeOther } = onTheSamePage('');
    const { result } = await withAwareness(doc, awareness);
    act(() => {
      doc.getText('contents').insert(0, text);
      placeOther(text.length);
    });
    await pass(SCAN_DEBOUNCE_MS);
    act(() => placeOther(null));
    await pass(0);
    expect(result.current.model.kind).toBe('offer');
  });

  it('ignores this person\'s own state in awareness: the editor reports that caret', async () => {
    const text = `See ${A}`;
    const { doc, awareness } = onTheSamePage(text);
    const end = Y.createRelativePositionFromTypeIndex(doc.getText('contents'), text.length);
    awareness.setLocalStateField('cursor', { anchor: end, head: end });
    const { result } = await withAwareness(doc, awareness);
    act(() => doc.getText('contents').insert(0, 'x'));
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.kind).toBe('offer');
  });

  it('does not scan for their caret moving about elsewhere', async () => {
    const { doc, awareness, placeOther } = onTheSamePage(`See ${A} and more words`);
    await withAwareness(doc, awareness);
    const scan = vi.spyOn(doc.getText('contents'), 'toString');
    act(() => placeOther(2));
    act(() => placeOther(3));
    expect(scan).not.toHaveBeenCalled();
  });

  it('copes with a state that has nothing in it', async () => {
    const { doc, awareness } = onTheSamePage(`See ${A}`);
    awareness.states.set(awareness.clientID + 2, null as unknown as Record<string, unknown>);
    const { result } = await withAwareness(doc, awareness);
    act(() => doc.getText('contents').insert(0, 'x'));
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.kind).toBe('offer');
  });

  it('stops listening when the page closes', async () => {
    const { doc, awareness } = onTheSamePage(`See ${A}`);
    const { unmount } = await withAwareness(doc, awareness);
    const off = vi.spyOn(awareness, 'off');
    unmount();
    expect(off).toHaveBeenCalledWith('change', expect.any(Function));
  });
});

describe('Hide', () => {
  it('hides the bar for this visit, and marks what was on offer seen here', async () => {
    const doc = docWith(`See ${A} and ${B}`);
    const { result, unmount } = await open(doc);
    act(() => result.current.session?.hide());
    expect(result.current.model.kind).toBe('hidden');
    expect([...readSeenLinkOffers('relay-doc-1')]).toEqual([A, B]);
    expect(readLinkOffers(doc).size).toBe(0);
    unmount();
    const again = await open(doc);
    expect(again.result.current.model.kind).toBe('hidden');
  });

  it('comes back for a link added after it, and only that one', async () => {
    const doc = docWith(`See ${A}`);
    const { result } = await open(doc);
    act(() => result.current.session?.hide());
    act(() => doc.getText('contents').insert(0, 'More words. '));
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.kind).toBe('hidden');
    act(() => doc.getText('contents').insert(0, `${B} `));
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.rows.map((row) => row.url)).toEqual([B]);
  });

  it('keeps a hidden failure hidden when a link added later comes up', async () => {
    const doc = docWith(`See ${A}`);
    const { result } = await open(doc);
    act(() => result.current.session?.accept([A]));
    await pass(0);
    server.set(A, { state: 'failed', job_id: `job:${A}`, error: 'No' });
    await pass(POLL_MS);
    expect(result.current.model.kind).toBe('failed');
    act(() => result.current.session?.hide());
    act(() => doc.getText('contents').insert(0, `${B} `));
    await pass(SCAN_DEBOUNCE_MS);
    expect(result.current.model.kind).toBe('offer');
    expect(result.current.model.rows.map((row) => row.url)).toEqual([B]);
  });

  it('hides Working too, and comes back to report a failure', async () => {
    const { result } = await open(docWith(`See ${A}`));
    act(() => result.current.session?.accept([A]));
    await pass(0);
    act(() => result.current.session?.hide());
    expect(result.current.model.kind).toBe('hidden');
    server.set(A, { state: 'library', path: 'Lens/articles/a.md', link_state: 'linked' });
    await pass(POLL_MS);
    expect(result.current.model.kind).toBe('hidden'); // Done stays quiet

    const other = await open(docWith(`See ${B}`), { docId: 'relay-doc-2' });
    act(() => other.result.current.session?.accept([B]));
    await pass(0);
    act(() => other.result.current.session?.hide());
    server.set(B, { state: 'failed', job_id: `job:${B}`, error: 'The page could not be read' });
    await pass(POLL_MS);
    expect(other.result.current.model.kind).toBe('failed');
  });

  it('does not bring back a failure it hid', async () => {
    server.set(A, { state: 'failed', job_id: 'j1' });
    const { result } = await open(docWith(`See ${A}`));
    expect(result.current.model.kind).toBe('failed');
    act(() => result.current.session?.hide());
    expect(result.current.model.kind).toBe('hidden');
    act(() => result.current.session?.dismiss([]));
    expect(result.current.model.kind).toBe('hidden');
  });

  it('gives way to the right-click, which is asked for', async () => {
    const { result } = await open(docWith(`See ${A}`));
    act(() => result.current.session?.hide());
    act(() => result.current.session?.importSource(A));
    expect(result.current.model.kind).toBe('working');
    await pass(0);
  });
});

describe('a library copy', () => {
  it('carries its path on the row, for Open', async () => {
    server.set(A, { state: 'library', path: 'Lens Edu/articles/a.md', title: 'A' });
    const { result } = await open(docWith(`See ${A} and ${B}`));
    expect(result.current.model.rows.map((row) => row.libraryPath)).toEqual(['Lens Edu/articles/a.md', undefined]);
  });

  it('says linked, not imported, when the library had it all along', async () => {
    const doc = docWith('');
    const { result } = await open(doc);
    act(() => doc.getText('contents').insert(0, A));
    server.importRows.set(A, { status: 'suggested', path: 'Lens/articles/a.md' });
    // Right-clicked before anyone asked what it was
    act(() => result.current.session?.importSource(A));
    await pass(0);
    expect(result.current.model.text).toBe('1 source suggested.');
  });
});
