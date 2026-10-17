import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetch = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', mockFetch);
// Node 25 defines a global localStorage that shadows happy-dom's and has no
// methods without --localstorage-file; a Map-backed one works on every Node.
const stored = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => void stored.set(key, value),
  clear: () => stored.clear(),
});

// The module remembers "disabled" for the session, so each test loads a fresh copy.
async function api() {
  vi.resetModules();
  return import('./content-status-api');
}

describe('gitBlobId', () => {
  // Expected values are `printf '…' | git hash-object --stdin`, as in the
  // relay's blob.rs test: the panel and the relay must agree with Git.
  it.each([
    ['', 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'],
    ['hello\n', 'ce013625030ba8dba906f756967f9e9ca394464a'],
    ['café — ünïcödé ✓\n', '1078fabbd368c02ce3ef72f69678569a583bbe90'],
    ['line one\r\nline two\r\n', 'cf9b2a85b62bc2fd67c5ed43a1d0009df848ac8a'],
  ])('matches git hash-object for %j', async (text, expected) => {
    const { gitBlobId } = await api();
    expect(await gitBlobId(text)).toBe(expected);
  });
});

describe('fetchContentStatus', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    localStorage.clear();
  });

  it('asks the editor server with the share token, path, blob and drafts flag', async () => {
    localStorage.setItem('lens-share-token', 'share-token');
    const status = { path: 'Lenses/A & B.md', content: true, published: { state: 'published' } };
    mockFetch.mockResolvedValueOnce(Response.json(status));
    const { fetchContentStatus } = await api();

    await expect(fetchContentStatus('Lenses/A & B.md', 'abc', true)).resolves.toEqual({
      kind: 'ok',
      status: { ...status, issues: [], cause_cards: { caused_here: [], broken_by: [] }, used_by: [] },
    });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/content-status?path=Lenses%2FA+%26+B.md&blob=abc&drafts=1');
    expect(init?.headers).toEqual({ 'X-Share-Token': 'share-token' });
  });

  it('remembers for the session that the server has the panel switched off', async () => {
    mockFetch.mockResolvedValueOnce(Response.json({ error: 'off', code: 'disabled' }, { status: 404 }));
    const { fetchContentStatus } = await api();

    expect(await fetchContentStatus('Lenses/A.md', 'abc', false)).toEqual({ kind: 'disabled' });
    expect(await fetchContentStatus('Lenses/B.md', 'abc', false)).toEqual({ kind: 'disabled' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('treats an HTML answer (a server without the route) as switched off', async () => {
    mockFetch.mockResolvedValueOnce(new Response('<!doctype html><html></html>', { status: 200 }));
    const { fetchContentStatus } = await api();
    expect(await fetchContentStatus('Lenses/A.md', 'abc', false)).toEqual({ kind: 'disabled' });
  });

  it('tells "no status yet" and errors apart from switched off', async () => {
    const { fetchContentStatus } = await api();
    mockFetch.mockResolvedValueOnce(Response.json({ code: 'not_found' }, { status: 404 }));
    expect(await fetchContentStatus('Lenses/A.md', 'abc', false)).toEqual({ kind: 'not_found' });

    mockFetch.mockResolvedValueOnce(Response.json({ error: 'The platform answered 500' }, { status: 502 }));
    expect(await fetchContentStatus('Lenses/A.md', 'abc', false))
      .toEqual({ kind: 'error', message: 'The platform answered 500' });

    // A gateway's HTML error page is an error, not "switched off".
    mockFetch.mockResolvedValueOnce(new Response('<html>Bad gateway</html>', { status: 502 }));
    expect(await fetchContentStatus('Lenses/A.md', 'abc', false)).toEqual({ kind: 'error', message: 'HTTP 502' });

    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await fetchContentStatus('Lenses/A.md', 'abc', false)).toEqual({ kind: 'error', message: 'Failed to fetch' });

    mockFetch.mockResolvedValueOnce(Response.json({ path: 'Lenses/A.md', content: true }));
    expect((await fetchContentStatus('Lenses/A.md', 'abc', false)).kind).toBe('ok');
  });

  it('reads a 200 answer that is not a status as an error, so the panel asks again', async () => {
    const { fetchContentStatus } = await api();
    for (const body of ['null', '[]', '"ok"', '1', '{"path": 1, "content": true}']) {
      mockFetch.mockResolvedValueOnce(new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }));
      expect(await fetchContentStatus('Lenses/A.md', 'abc', false), body)
        .toEqual({ kind: 'error', message: 'The platform answered in an unknown format' });
    }
  });

  it('keeps the parts of a status the panel can show, and fills in empty lists', async () => {
    mockFetch.mockResolvedValueOnce(Response.json({
      path: 'Lenses/A.md',
      content: true,
      processed: { commit: null, commit_time: '', processed_at: '2026-10-05T13:59:57Z' },
      published: { state: 'nonsense' },
      issues: null,
      cause_cards: { caused_here: [null, { id: 'c', what_broke: 'x' }] },
      used_by: 'x',
      drafts: { pending: 1 },
    }));
    const { fetchContentStatus } = await api();

    expect(await fetchContentStatus('Lenses/A.md', 'abc', true)).toEqual({
      kind: 'ok',
      status: {
        path: 'Lenses/A.md',
        content: true,
        issues: [],
        cause_cards: { caused_here: [{ id: 'c', what_broke: 'x' }], broken_by: [] },
        used_by: [],
        drafts: { pending: 1, issues: [], new_elsewhere: [] },
      },
    });
  });

  it('passes on how long a busy platform asks to be left alone', async () => {
    mockFetch.mockResolvedValueOnce(Response.json(
      { error: 'The platform is not ready: The content is not loaded yet', code: 'unavailable' },
      { status: 503, headers: { 'Retry-After': '60' } },
    ));
    const { fetchContentStatus } = await api();

    expect(await fetchContentStatus('Lenses/A.md', 'abc', false)).toEqual({
      kind: 'error',
      message: 'The platform is not ready: The content is not loaded yet',
      retryAfterMs: 60_000,
    });
  });

  // RFC 9110 allows an HTTP date, and a proxy may send one.
  it('reads a Retry-After given as an HTTP date', async () => {
    const { fetchContentStatus } = await api();
    const busy = (retryAfter: string) => mockFetch.mockResolvedValueOnce(Response.json(
      { error: 'The platform is not ready', code: 'unavailable' },
      { status: 503, headers: { 'Retry-After': retryAfter } },
    ));

    busy(new Date(Date.now() + 45_000).toUTCString());
    const result = await fetchContentStatus('Lenses/A.md', 'abc', false);
    const waits = result.kind === 'error' ? result.retryAfterMs : undefined;
    expect(waits).toBeGreaterThan(43_000);
    expect(waits).toBeLessThanOrEqual(45_000);

    busy('Wed, 21 Oct 2015 07:28:00 GMT');
    expect(await fetchContentStatus('Lenses/A.md', 'abc', false))
      .toEqual({ kind: 'error', message: 'The platform is not ready' });
  });
});
