import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJevRoutes, type JevConfig } from './routes';
import { signShareToken, type ShareTokenPayload } from '../share-token';

const token = (o: Partial<ShareTokenPayload> = {}) => signShareToken({
  purpose: 'share', role: 'edit', folder: 'b0000001-0000-4000-8000-000000000001',
  expiry: Math.floor(Date.now() / 1000) + 3600, ...o,
});
const jevReply = (p: number) => new Response(JSON.stringify({ answers: { q: { noul: p } } }), { status: 200 });

function mount(config: Partial<JevConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jev-'));
  writeFileSync(join(dir, 'corpus.json'), JSON.stringify({ meta: { title: 't' }, rows: [] }));
  const jev = vi.fn<typeof fetch>(async () => jevReply(0.7));
  const app = new Hono();
  app.route('/api/jev', createJevRoutes({ apiKey: 'key', cacheDir: dir, corpusPath: join(dir, 'corpus.json'), textsPerHour: 100, fetchImpl: jev, ...config }));
  return { app, jev };
}
const ask = (app: Hono, texts: string[], headers: Record<string, string> = { 'X-Share-Token': token() }) =>
  app.request('/api/jev/ask', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'jev-1.14.0', question: { instructions: 'Is `paragraph` bad?' }, texts }),
  });

describe('jev routes', () => {
  it('answers 503 without a key', async () => {
    expect((await ask(mount({ apiKey: undefined }).app, ['a'])).status).toBe(503);
  });
  it('needs an edit share link', async () => {
    const { app } = mount();
    expect((await ask(app, ['a'], {})).status).toBe(401);
    expect((await ask(app, ['a'], { 'X-Share-Token': token({ role: 'view' }) })).status).toBe(403);
  });
  it('asks jev once per new text and answers repeats from its cache', async () => {
    const { app, jev } = mount();
    expect(await (await ask(app, ['a', 'b'])).json()).toEqual({ ps: [0.7, 0.7], cached: 0 });
    expect(await (await ask(app, ['a', 'b'])).json()).toEqual({ ps: [0.7, 0.7], cached: 2 });
    expect(jev).toHaveBeenCalledTimes(2);
    const sent = JSON.parse(String(jev.mock.calls[0][1]!.body));
    expect(sent).toEqual({ model: 'jev-1.14.0', state: { paragraph: 'a' }, questions: { q: { type: 'noul', instructions: 'Is `paragraph` bad?' } } });
  });
  it('refuses a request that would pass the hourly budget of new texts', async () => {
    const { app, jev } = mount({ textsPerHour: 3 });
    expect((await ask(app, ['a', 'b'])).status).toBe(200);
    expect((await ask(app, ['c', 'd'])).status).toBe(429);
    expect(jev).toHaveBeenCalledTimes(2);
  });
  it('serves the corpus, or 404 without one', async () => {
    const auth = { headers: { 'X-Share-Token': token() } };
    expect((await mount().app.request('/api/jev/corpus', auth)).status).toBe(200);
    expect((await mount({ corpusPath: '/nonexistent/corpus.json' }).app.request('/api/jev/corpus', auth)).status).toBe(404);
  });
});
