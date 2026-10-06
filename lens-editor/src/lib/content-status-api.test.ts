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

    await expect(fetchContentStatus('Lenses/A & B.md', 'abc', true)).resolves.toEqual({ kind: 'ok', status });

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
});
