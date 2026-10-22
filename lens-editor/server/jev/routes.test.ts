import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJevRoutes, requestChars, type JevConfig } from './routes';
import { signShareToken, type ShareTokenPayload } from '../share-token';
import { EDU_FOLDER } from '../edit-share-auth';

const token = (o: Partial<ShareTokenPayload> = {}) => signShareToken({
  purpose: 'share', role: 'edit', folder: EDU_FOLDER,
  expiry: Math.floor(Date.now() / 1000) + 3600, ...o,
});
// jev's reply to a call of up to 1000 questions, every answer p.
const jevReply = (p: number) => new Response(JSON.stringify({ answers: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`q${i}`, { noul: p }])) }), { status: 200 });

function mount(config: Partial<JevConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jev-'));
  writeFileSync(join(dir, 'corpus.json'), JSON.stringify({ meta: { title: 't' }, rows: [] }));
  const jev = vi.fn<typeof fetch>(async () => jevReply(0.7));
  const app = new Hono();
  app.route('/api/jev', createJevRoutes({ apiKey: 'key', cacheDir: dir, corpusPath: join(dir, 'corpus.json'), charsPerHour: 100_000, fetchImpl: jev, ...config }));
  return { app, jev };
}
const Q = { instructions: 'Is `paragraph` bad?' };
// One paragraph request's cost against the hourly budget.
const ONE = requestChars({ question: Q, state: { paragraph: 'a' } });
const ask = (app: Hono, texts: string[], headers: Record<string, string> = { 'X-Share-Token': token() }) =>
  app.request('/api/jev/ask', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'jev-1.14.0', requests: texts.map((t) => ({ question: Q, state: { paragraph: t } })) }),
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
    expect(sent).toEqual({ model: 'jev-1.14.0', state: { paragraph: 'a' }, questions: { q0: { type: 'noul', instructions: 'Is `paragraph` bad?' } } });
  });
  it('refuses a request that would pass the hourly budget of new texts', async () => {
    const { app, jev } = mount({ charsPerHour: 3 * ONE });
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
    body: JSON.stringify({ model: 'jev-1.14.0', requests: texts.map((t) => ({ question: { instructions: 'q', criteria }, state: { paragraph: t } })) }),
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
    app.route('/api/jev', createJevRoutes({ apiKey: 'k', cacheDir: dir, corpusPath: join(dir, 'c.json'), charsPerHour: 100_000, fetchImpl: jev }));
    expect((await askQ(app, ['a'])).status).toBe(200);
    const lines = readFileSync(join(dir, 'answers.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(lines[lines.length - 1]).p).toBe(0.7);
  });
  it('refunds the budget when jev fails, and retries a 429', async () => {
    const { app, jev } = mount({ charsPerHour: 3 * ONE });
    jev.mockImplementation(async () => new Response('bad', { status: 400 }));
    expect((await askQ(app, ['a', 'b', 'c'])).status).toBe(502);
    jev.mockImplementationOnce(async () => new Response('slow down', { status: 429 })).mockImplementation(async () => jevReply(0.2));
    expect((await askQ(app, ['d'])).status).toBe(200);
  });
});

describe('jev routes, any state', () => {
  it('sends each request its own question and state, in key order', async () => {
    const { app, jev } = mount();
    const state = { __format_description: 'd', document: { paragraph_0: 'x' } };
    const res = await app.request('/api/jev/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Share-Token': token() },
      body: JSON.stringify({ model: 'jev-1.14.0', requests: [{ question: { instructions: 'Is `paragraph_0` ok?' }, state }] }),
    });
    expect(await res.json()).toEqual({ ps: [0.7], cached: 0 });
    const sent = JSON.parse(String(jev.mock.calls[0][1]!.body));
    expect(Object.keys(sent.state)).toEqual(['__format_description', 'document']);
    expect(sent.questions.q0.instructions).toBe('Is `paragraph_0` ok?');
  });
  it('counts characters sent, so a whole-file request uses more of the hour', async () => {
    const { app } = mount({ charsPerHour: 1000 });
    const big = { question: Q, state: { document: 'x'.repeat(2000), paragraph: 'a' } };
    const res = await app.request('/api/jev/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Share-Token': token() },
      body: JSON.stringify({ model: 'jev-1.14.0', requests: [big] }),
    });
    expect(res.status).toBe(429);
    expect((await ask(app, ['a'])).status).toBe(200);
  });
  it('reads files live, once a minute per path', async () => {
    const readFile = vi.fn(async (p: string) => (p === 'Lens Edu/a.md' ? '# A' : null));
    const { app } = mount({ readFile });
    const files = (paths: string[]) => app.request('/api/jev/files', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Share-Token': token() }, body: JSON.stringify({ paths }),
    }).then((r) => r.json());
    expect(await files(['Lens Edu/a.md', 'Lens Edu/nope.md'])).toEqual({ files: { 'Lens Edu/a.md': '# A' } });
    await files(['Lens Edu/a.md']);
    expect(readFile).toHaveBeenCalledTimes(2);
  });
});

describe('jev routes, failure stops the batch', () => {
  it('asks no more after a failure, and refunds only what was never answered', async () => {
    const { app, jev } = mount({ charsPerHour: 50 * ONE + 50 });
    let calls = 0;
    jev.mockImplementation(async () => { calls++; return calls === 1 ? new Response('bad', { status: 400 }) : jevReply(0.5); });
    const texts = Array.from({ length: 40 }, (_, i) => `t${i}`);
    expect((await ask(app, texts)).status).toBe(502);
    expect(calls).toBeLessThanOrEqual(8); // at most one in flight per worker
    jev.mockImplementation(async () => jevReply(0.5));
    // Everything not answered was refunded: 40 new texts still fit in the hour of 50.
    expect((await ask(app, texts.map((t) => t + 'x'))).status).toBe(200);
  });
});

describe('jev routes, too long', () => {
  it('answers null for a request jev refuses as too long, and the rest go through', async () => {
    const { app, jev } = mount();
    jev.mockImplementation(async (_u, init) => String(init!.body).includes('huge')
      ? new Response('{"detail":{"error_type":"max_tokens_exceeded"}}', { status: 400 }) : jevReply(0.3));
    const res = await ask(app, ['huge', 'small']);
    expect(await res.json()).toEqual({ ps: [null, 0.3], cached: 0, tooLong: 1 });
  });
});

describe('jev routes, folder scope', () => {
  const files = (app: Hono, paths: string[], tok = token()) => app.request('/api/jev/files', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Share-Token': tok }, body: JSON.stringify({ paths }),
  });
  it('refuses a link for another folder on every route', async () => {
    const readFile = vi.fn(async () => 'secret');
    const { app } = mount({ readFile });
    const other = token({ folder: 'b0000001-0000-4000-8000-000000000001' });
    expect((await files(app, ['Lens Edu/a.md'], other)).status).toBe(403);
    expect((await ask(app, ['a'], { 'X-Share-Token': other })).status).toBe(403);
    expect(readFile).not.toHaveBeenCalled();
  });
  it('never reads outside Lens Edu, even for an all-folders link', async () => {
    const readFile = vi.fn(async () => 'secret');
    const { app } = mount({ readFile });
    for (const tok of [token(), token({ folder: '00000000-0000-0000-0000-000000000000' })]) {
      const res = await files(app, ['Lens/08-Legal/contract.md', 'Lens Edu/../Lens/x.md'], tok);
      expect(res.status).toBe(400);
    }
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe('jev routes, long context', () => {
  it('sends the long-context header only when asked, and caches those answers apart', async () => {
    const { app, jev } = mount();
    const send = (longContext?: boolean) => app.request('/api/jev/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Share-Token': token() },
      body: JSON.stringify({ model: 'jev-1.14.0', requests: [{ question: Q, state: { paragraph: 'a' } }], ...(longContext ? { longContext } : {}) }),
    });
    await send(); await send(true); await send(true);
    expect(jev).toHaveBeenCalledTimes(2);
    const headers = jev.mock.calls.map((c) => (c[1]!.headers as Record<string, string>)['TypeSafe-Danger-Zone-Long-Context']);
    expect(headers).toEqual([undefined, 'true']);
  });
});

describe('jev routes, one call per shown text', () => {
  const batch = (app: Hono, requests: unknown[]) => app.request('/api/jev/ask', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Share-Token': token() },
    body: JSON.stringify({ model: 'jev-1.14.0', requests }),
  });
  const q = (i: number) => ({ instructions: `Is \`sentence_${i}\` bad?` });
  it('asks every question about one state in one call, and caches each answer', async () => {
    const { app, jev } = mount();
    const state = { document: { sentence_0: 'a', sentence_1: 'b', sentence_2: 'c' } };
    expect(await (await batch(app, [{ state, questions: [q(0), q(1)] }, { state, question: q(2) }])).json()).toEqual({ ps: [0.7, 0.7, 0.7], cached: 0 });
    expect(jev).toHaveBeenCalledTimes(1);
    expect(Object.keys(JSON.parse(String(jev.mock.calls[0][1]!.body)).questions)).toEqual(['q0', 'q1', 'q2']);
    expect(await (await batch(app, [{ state, questions: [q(1), q(3)] }])).json()).toEqual({ ps: [0.7, 0.7], cached: 1 });
    expect(JSON.parse(String(jev.mock.calls[1][1]!.body)).questions).toEqual({ q0: { type: 'noul', ...q(3) } });
  });
  it("splits a state's questions across calls past 1000, and charges the state once per call", async () => {
    const { app, jev } = mount({ charsPerHour: 1e9 });
    const state = { document: 'x'.repeat(1000) };
    expect((await batch(app, [{ state, questions: Array.from({ length: 1500 }, (_, i) => q(i)) }])).status).toBe(200);
    expect(jev).toHaveBeenCalledTimes(2);
    const { app: app2 } = mount({ charsPerHour: 3000 });
    // 20 questions about a 1000-character state fit an hour of 3000; asked one by one they would not.
    expect((await batch(app2, [{ state, questions: Array.from({ length: 20 }, (_, i) => q(i)) }])).status).toBe(200);
  });
  it('refuses a malformed batch', async () => {
    const { app } = mount();
    expect((await batch(app, [{ state: { a: 'x' }, questions: [{ nope: 1 }] }])).status).toBe(400);
  });
});

describe('jev routes, review round on #195', () => {
  const batch = (app: Hono, requests: unknown[], longContext = false) => app.request('/api/jev/ask', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Share-Token': token() },
    body: JSON.stringify({ model: 'jev-1.14.0', requests, ...(longContext ? { longContext } : {}) }),
  });
  const q = (i: number) => ({ instructions: `Is \`s_${i}\` bad?` });
  it('with long context, a state over the normal call size still takes one call', async () => {
    const { app, jev } = mount({ charsPerHour: 1e9 });
    const state = { document: 'x'.repeat(200_000) };
    expect((await batch(app, [{ state, questions: Array.from({ length: 40 }, (_, i) => q(i)) }], true)).status).toBe(200);
    expect(jev).toHaveBeenCalledTimes(1);
  });
  it('refunds exactly the calls that failed', async () => {
    const a = { state: { d: 'a'.repeat(100) }, question: q(0) }, b = { state: { d: 'b'.repeat(100) }, question: q(0) };
    const one = requestChars(a);
    const { app, jev } = mount({ charsPerHour: 2 * one });
    jev.mockImplementation(async (_u, init) => (String(init!.body).includes('bbbb') ? new Response('bad', { status: 400 }) : jevReply(0.5)));
    expect((await batch(app, [a, b])).status).toBe(502);
    jev.mockImplementation(async () => jevReply(0.5));
    const c = { state: { d: 'c'.repeat(100) }, question: q(0) }, d = { state: { d: 'd'.repeat(100) }, question: q(0) };
    expect((await batch(app, [c, d])).status).toBe(429); // a's cost was kept
    expect((await batch(app, [c])).status).toBe(200); // b's was refunded
  });
});
