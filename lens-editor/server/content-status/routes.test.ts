import { afterEach, describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createContentStatusRoutes, loadContentStatusConfig, type ContentStatusConfig } from './routes';
import { signShareToken, type ShareTokenPayload } from '../share-token';

const EDU_FOLDER = 'ea4015da-24af-4d9d-ac49-8c902cb17121';
const ALL_FOLDERS = '00000000-0000-0000-0000-000000000000';
const OTHER_FOLDER = 'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e';
const BLOB = 'ce013625030ba8dba906f756967f9e9ca394464a';

function token(overrides: Partial<ShareTokenPayload> = {}): string {
  return signShareToken({
    purpose: 'share',
    role: 'view',
    folder: EDU_FOLDER,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  });
}

/** The route, with `platform` as the global fetch it reaches the platform through. */
function mount(
  config: Partial<ContentStatusConfig> = {},
  platform = vi.fn<typeof fetch>(async () => Response.json({ path: 'Lenses/X.md', content: true })),
) {
  vi.stubGlobal('fetch', platform);
  const app = new Hono();
  app.route('/api/content-status', createContentStatusRoutes({
    enabled: true,
    platformUrl: 'https://platform.test/',
    secret: 'sek',
    retryDelayMs: 1,
    ...config,
  }));
  return { app, platform };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function get(app: Hono, query: string, headers: Record<string, string> = { 'X-Share-Token': token() }) {
  return app.request(`/api/content-status?${query}`, { headers });
}

const QUERY = `path=${encodeURIComponent('Lenses/X & Y.md')}&blob=${BLOB}&drafts=1`;

describe('content status routes', () => {
  it('answers 404 "disabled" to everything unless CONTENT_STATUS_ENABLED is true', async () => {
    expect(loadContentStatusConfig({}).enabled).toBe(false);
    expect(loadContentStatusConfig({ CONTENT_STATUS_ENABLED: 'false' }).enabled).toBe(false);
    expect(loadContentStatusConfig({ CONTENT_STATUS_ENABLED: 'true' }).enabled).toBe(true);

    const { app, platform } = mount({ enabled: false });
    const resp = await get(app, QUERY);
    expect(resp.status).toBe(404);
    expect(await resp.json()).toEqual({ error: 'Content status is disabled', code: 'disabled' });
    expect(platform).not.toHaveBeenCalled();
  });

  it('forwards to the platform with the validation key and returns its answer', async () => {
    const { app, platform } = mount();

    const resp = await get(app, QUERY);

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ path: 'Lenses/X.md', content: true });
    expect(platform).toHaveBeenCalledTimes(1);
    const [url, init] = platform.mock.calls[0];
    expect(url).toBe(`https://platform.test/api/content/file-status?path=Lenses%2FX+%26+Y.md&blob=${BLOB}&drafts=1`);
    expect(init?.headers).toEqual({ 'X-Validation-Key': 'sek' });
  });

  it('lets any role in the Lens Edu folder or an all-folders token read, and nobody else', async () => {
    const { app } = mount();
    for (const role of ['view', 'suggest', 'edit', 'admin'] as const) {
      expect((await get(app, QUERY, { 'X-Share-Token': token({ role }) })).status, role).toBe(200);
    }
    expect((await get(app, QUERY, { Authorization: `Bearer ${token({ folder: ALL_FOLDERS })}` })).status).toBe(200);

    expect((await get(app, QUERY, {})).status).toBe(401);
    expect((await get(app, QUERY, { 'X-Share-Token': 'not-a-token' })).status).toBe(401);
    expect((await get(app, QUERY, { 'X-Share-Token': token({ expiry: 1 }) })).status).toBe(401);
    expect((await get(app, QUERY, { 'X-Share-Token': token({ folder: OTHER_FOLDER }) })).status).toBe(403);
    expect((await get(app, QUERY, { 'X-Share-Token': token({ purpose: 'add-video' }) })).status).toBe(403);
  });

  it('refuses malformed paths and blob ids before calling the platform', async () => {
    const { app, platform } = mount();
    for (const path of ['', '/Lenses/X.md', 'Lenses/../X.md', 'Lenses//X.md', 'a\\b.md']) {
      const resp = await get(app, `path=${encodeURIComponent(path)}&blob=${BLOB}`);
      expect(resp.status, path).toBe(400);
    }
    expect((await get(app, 'path=Lenses/X.md&blob=xyz')).status).toBe(400);
    expect((await get(app, 'path=Lenses/X.md')).status).toBe(400);
    expect(platform).not.toHaveBeenCalled();
  });

  it('says 503 "not_configured" when enabled without a platform URL or key', async () => {
    const { app } = mount({ secret: undefined });
    const resp = await get(app, QUERY);
    expect(resp.status).toBe(503);
    expect(await resp.json()).toMatchObject({ code: 'not_configured' });
  });

  it('retries gateway errors and network failures, then answers 502', async () => {
    const flaky = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    expect((await get(mount({}, flaky).app, QUERY)).status).toBe(200);
    expect(flaky).toHaveBeenCalledTimes(3);

    const down = vi.fn<typeof fetch>(async () => new Response('gateway timeout', { status: 504 }));
    const resp = await get(mount({}, down).app, QUERY);
    expect(down).toHaveBeenCalledTimes(3);
    expect(resp.status).toBe(502);
    expect(await resp.json()).toMatchObject({ code: 'unavailable' });

    const refused = vi.fn<typeof fetch>(async () => new Response('no', { status: 401 }));
    expect((await get(mount({}, refused).app, QUERY)).status).toBe(502);
    expect(refused).toHaveBeenCalledTimes(1);
  });

  // The platform's 503 is its own answer (the content is not loaded yet, a
  // cold build), not the edge failing to reach it: asking again at once only
  // adds load, and the panel waits as long as Retry-After says.
  it('passes a platform 503 and its Retry-After on, without asking again', async () => {
    const busy = vi.fn<typeof fetch>(async () =>
      Response.json({ detail: 'The content is not loaded yet' }, { status: 503, headers: { 'Retry-After': '60' } }));

    const resp = await get(mount({}, busy).app, QUERY);

    expect(resp.status).toBe(503);
    expect(resp.headers.get('Retry-After')).toBe('60');
    expect(await resp.json()).toEqual({
      error: 'The platform is not ready: The content is not loaded yet',
      code: 'unavailable',
    });
    expect(busy).toHaveBeenCalledTimes(1);
  });

  it('logs a platform problem when it starts and when it ends, not on every request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const platform = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ detail: 'Invalid validation key' }, { status: 401 }))
        .mockResolvedValueOnce(Response.json({ detail: 'Invalid validation key' }, { status: 401 }))
        .mockImplementation(async () => Response.json({ path: 'Lenses/X.md', content: true }));
      const { app } = mount({}, platform);

      for (let i = 0; i < 4; i++) await get(app, QUERY);

      expect(warn.mock.calls).toEqual([['Content status: the platform answered 401: {"detail":"Invalid validation key"}']]);
      expect(info.mock.calls).toEqual([['Content status: the platform answers again']]);
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });

  it('passes a platform 404 through as "not_found"', async () => {
    const missing = vi.fn<typeof fetch>(async () => Response.json({ detail: 'no build layer' }, { status: 404 }));
    const resp = await get(mount({}, missing).app, QUERY);
    expect(resp.status).toBe(404);
    expect(await resp.json()).toMatchObject({ code: 'not_found' });
  });

  it('gives up with 504 when the platform does not answer within the budget', async () => {
    const hanging = vi.fn<typeof fetch>((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    }));
    const started = Date.now();
    const resp = await get(mount({ timeoutMs: 50 }, hanging).app, QUERY);
    expect(resp.status).toBe(504);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(hanging).toHaveBeenCalledTimes(1);
  });
});
