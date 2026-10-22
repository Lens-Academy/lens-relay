import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

describe('jev routes, review fixes', () => {
  const askQ = (app: Hono, texts: string[], criteria?: { true: string; false: string }) => app.request('/api/jev/ask', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Share-Token': token() },
    body: JSON.stringify({ model: 'jev-1.14.0', question: { instructions: 'q', criteria }, texts }),
  });
  it('treats different criteria as a different question', async () => {
    const { app, jev } = mount();
    await askQ(app, ['a'], { true: 'x', false: 'y' });
    await askQ(app, ['a'], { true: 'x2', false: 'y' });
    expect(jev).toHaveBeenCalledTimes(2);
  });
  it('asks once for a text repeated in one request', async () => {
    const { app, jev } = mount();
    expect(await (await askQ(app, ['a', 'a', 'a'])).json()).toEqual({ ps: [0.7, 0.7, 0.7], cached: 0 });
    expect(jev).toHaveBeenCalledTimes(1);
  });
  it('survives a truncated cache line and keeps the file appendable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-'));
    writeFileSync(join(dir, 'answers.jsonl'), '{"h":"zz","p":0.1}\n{"h":"tr');
    const jev = vi.fn<typeof fetch>(async () => jevReply(0.7));
    const app = new Hono();
    app.route('/api/jev', createJevRoutes({ apiKey: 'k', cacheDir: dir, corpusPath: join(dir, 'c.json'), textsPerHour: 100, fetchImpl: jev }));
    expect((await askQ(app, ['a'])).status).toBe(200);
    const lines = readFileSync(join(dir, 'answers.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(lines[lines.length - 1]).p).toBe(0.7);
  });
  it('refunds the budget when jev fails, and retries a 429', async () => {
    const { app, jev } = mount({ textsPerHour: 3 });
    jev.mockImplementation(async () => new Response('bad', { status: 400 }));
    expect((await askQ(app, ['a', 'b', 'c'])).status).toBe(502);
    jev.mockImplementationOnce(async () => new Response('slow down', { status: 429 })).mockImplementation(async () => jevReply(0.2));
    expect((await askQ(app, ['d'])).status).toBe(200);
  });
});
