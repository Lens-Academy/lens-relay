import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createHistoryRoutes, type HistorySource } from './routes';
import { signShareToken, type ShareTokenPayload } from '../share-token';
import { EDU_FOLDER } from '../edit-share-auth';

const SHA = 'a'.repeat(40);
const LENS_FOLDER = 'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e';
const ALL = '00000000-0000-0000-0000-000000000000';
const token = (o: Partial<ShareTokenPayload> = {}) => signShareToken({
  purpose: 'share', role: 'view', folder: EDU_FOLDER,
  expiry: Math.floor(Date.now() / 1000) + 3600, ...o,
});

function mount(source: HistorySource | null = fake()) {
  const app = new Hono();
  app.route('/api/history', createHistoryRoutes(source));
  return app;
}
function fake(): HistorySource {
  return {
    log: vi.fn(async () => [{ sha: SHA, ts: 5000, author: 'Elias' }]),
    show: vi.fn(async (_sha: string, path: string) => (path === 'Lenses/a.md' ? 'hello\n' : null)),
    asOf: vi.fn(async () => 7000),
  };
}
const get = (app: Hono, url: string, t: string | null = token()) =>
  app.request(url, { headers: t ? { 'X-Share-Token': t } : {} });

describe('history routes', () => {
  it('answers 503 when no git copy is configured', async () => {
    expect((await get(mount(null), '/api/history/log?path=Lens%20Edu/Lenses/a.md')).status).toBe(503);
  });

  it('needs a share link, and refuses a link for the Lens team folder', async () => {
    const app = mount();
    expect((await get(app, '/api/history/log?path=Lens%20Edu/Lenses/a.md', null)).status).toBe(401);
    expect((await get(app, '/api/history/log?path=Lens%20Edu/Lenses/a.md', token({ folder: LENS_FOLDER }))).status).toBe(403);
  });

  it('refuses paths outside Lens Edu even for an all-folders link, without touching git', async () => {
    const source = fake();
    const app = mount(source);
    for (const p of ['Lens/09-Transcripts/x.md', 'Lens Edu/../Lens/x.md']) {
      const res = await get(app, `/api/history/log?path=${encodeURIComponent(p)}`, token({ folder: ALL, role: 'edit' }));
      expect(res.status).toBe(403);
      const file = await get(app, `/api/history/file?path=${encodeURIComponent(p)}&sha=${SHA}`, token({ folder: ALL }));
      expect(file.status).toBe(403);
    }
    expect(source.log).not.toHaveBeenCalled();
    expect(source.show).not.toHaveBeenCalled();
  });

  it('lists sessions for a view link, reading the repo path', async () => {
    const source = fake();
    const res = await get(mount(source), '/api/history/log?path=Lens%20Edu/Lenses/a.md');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(source.log).toHaveBeenCalledWith('Lenses/a.md');
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({ head: SHA, base: null, authors: ['Elias'] });
    expect(body.asOf).toBe(7000);
  });

  it('returns a version, 404 where the file did not exist, 400 for a bad sha', async () => {
    const app = mount();
    const ok = await get(app, `/api/history/file?path=Lens%20Edu/Lenses/a.md&sha=${SHA}`);
    expect(await ok.json()).toEqual({ text: 'hello\n' });
    expect((await get(app, `/api/history/file?path=Lens%20Edu/Lenses/b.md&sha=${SHA}`)).status).toBe(404);
    expect((await get(app, '/api/history/file?path=Lens%20Edu/Lenses/a.md&sha=HEAD')).status).toBe(400);
  });
});
