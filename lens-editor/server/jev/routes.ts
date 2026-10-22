import { Hono, type MiddlewareHandler } from 'hono';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { roleAtLeast, shareTokenFromHeaders, verifyShareToken } from '../share-token.ts';

/**
 * Jev for the check workbench (src/components/JevCheckPanel):
 *
 *   GET  /api/jev/corpus  → {meta, rows:[{id, path, line, kind, title, courses, text}]}
 *   POST /api/jev/ask     {model, question:{instructions, criteria?}, texts:[...]} → {ps:[...], cached:n}
 *                         or {model, requests:[{question, state}]}, for any state jev is shown
 *   POST /api/jev/files   {paths:[...]} → {files:{path: markdown}} (the corpus snapshot's files)
 *
 * Every answer is appended to <cacheDir>/answers.jsonl and reused when the same
 * (model, question, text) comes again, so re-running a phrasing is free. Edit share
 * links only; the TypeSafe key stays here. Without JEV_API_KEY every route is 503
 * and the workbench says so. The corpus is built offline (lens docs
 * course-dev-set/live-checks/build_corpus.py) and placed at JEV_CORPUS_PATH.
 */

export interface JevConfig {
  apiKey?: string;
  cacheDir: string;
  corpusPath: string;
  /** New (uncached) texts one share link may send to jev per hour (cost guard). */
  textsPerHour: number;
  fetchImpl?: typeof fetch;
}

const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const MAX_TEXTS = 5000;
const WORKERS = 8;

export function loadJevConfig(env: NodeJS.ProcessEnv = process.env): JevConfig {
  const cacheDir = env.JEV_CACHE_DIR || join(homedir(), '.cache', 'jev-workbench');
  const limit = Number(env.JEV_TEXTS_PER_HOUR);
  return {
    apiKey: env.JEV_API_KEY?.trim() || undefined,
    cacheDir,
    corpusPath: env.JEV_CORPUS_PATH || join(cacheDir, 'corpus.json'),
    textsPerHour: Number.isFinite(limit) && limit > 0 ? limit : 20_000,
  };
}

type Question = { instructions: string; criteria?: { true: string; false: string } | null };

function requireEditLink(): MiddlewareHandler {
  return async (c, next) => {
    const token = shareTokenFromHeaders(c.req.header('X-Share-Token'), c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Authorization header required' }, 401);
    const payload = verifyShareToken(token);
    if (!payload) return c.json({ error: 'Invalid or expired token' }, 401);
    if (payload.purpose !== 'share' || !roleAtLeast(payload.role, 'edit')) return c.json({ error: 'An edit link is required' }, 403);
    c.set('jevBudgetKey' as never, token.slice(-24) as never);
    return next();
  };
}

/** answers.jsonl as a map from hash to p, loaded once and appended to as answers come. */
function answerCache(dir: string) {
  const file = join(dir, 'answers.jsonl');
  let map: Map<string, number> | null = null;
  const load = () => {
    if (map) return map;
    map = new Map();
    mkdirSync(dir, { recursive: true });
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf8');
      // A crash or a full disk mid-append leaves a partial last line: skip bad lines, and end
      // the file with a newline so the next append starts a line of its own.
      for (const line of raw.split('\n')) {
        if (!line) continue;
        try { const r = JSON.parse(line); if (typeof r.h === 'string' && typeof r.p === 'number') map.set(r.h, r.p); } catch { /* partial line */ }
      }
      if (raw && !raw.endsWith('\n')) appendFileSync(file, '\n');
    }
    return map;
  };
  return {
    get: (h: string) => load().get(h),
    put: (h: string, p: number, model: string) => { load().set(h, p); appendFileSync(file, JSON.stringify({ h, p, model, ts: Date.now() }) + '\n'); },
  };
}

type Req = { question: Question; state: Record<string, unknown> };
// The cache key of what jev is shown: a lone paragraph keys by its text, as every cached
// answer before other states existed did; any other state by its JSON (key order included,
// since jev reads it).
const stateKey = (st: Record<string, unknown>) => {
  const k = Object.keys(st);
  return k.length === 1 && k[0] === 'paragraph' && typeof st.paragraph === 'string' ? st.paragraph : JSON.stringify(st);
};
const reqHash = (model: string, r: Req) => hashOf(model, r.question, stateKey(r.state));
const hashOf = (model: string, q: Question, text: string) =>
  createHash('sha256').update(JSON.stringify([model, q.instructions, q.criteria ?? null, text])).digest('hex');

export function createJevRoutes(config: JevConfig = loadJevConfig()): Hono {
  const app = new Hono();
  if (!config.apiKey) {
    app.all('*', c => c.json({ error: 'Jev is not configured on this server (JEV_API_KEY)', code: 'disabled' }, 503));
    return app;
  }
  const doFetch = config.fetchImpl ?? fetch;
  const cache = answerCache(config.cacheDir);
  const used = new Map<string, { start: number; n: number }>();

  async function askOne(model: string, q: Question, state: Record<string, unknown>): Promise<number> {
    const noul: Record<string, unknown> = { type: 'noul', instructions: q.instructions };
    if (q.criteria) noul.criteria = q.criteria;
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(JEV_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, state, questions: { q: noul } }),
      });
      if (res.ok) {
        const p = (await res.json()).answers?.q?.noul;
        if (typeof p !== 'number') throw new Error('jev answered without a probability');
        return p;
      }
      if (attempt >= 3 || (res.status < 500 && res.status !== 429)) throw new Error(`jev ${res.status}: ${(await res.text()).slice(0, 200)}`);
      await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
    }
  }

  app.use('*', requireEditLink());

  app.get('/corpus', c => {
    if (!existsSync(config.corpusPath)) return c.json({ error: `no corpus at ${config.corpusPath}` }, 404);
    return c.body(readFileSync(config.corpusPath, 'utf8'), 200, { 'Content-Type': 'application/json' });
  });

  // The corpus snapshot's raw files, for presentations that show jev the whole document.
  const filesPath = join(dirname(config.corpusPath), 'files.json');
  let files: Record<string, string> | null = null;
  app.post('/files', async c => {
    const { paths } = await c.req.json().catch(() => ({}));
    if (!Array.isArray(paths)) return c.json({ error: 'need paths[]' }, 400);
    if (!files) {
      if (!existsSync(filesPath)) return c.json({ error: `no files at ${filesPath}` }, 404);
      files = JSON.parse(readFileSync(filesPath, 'utf8')).files as Record<string, string>;
    }
    return c.json({ files: Object.fromEntries(paths.filter((p: unknown) => typeof p === 'string' && files![p as string] !== undefined).map((p: string) => [p, files![p]])) });
  });

  app.post('/ask', async c => {
    const body = await c.req.json().catch(() => ({}));
    const { model } = body;
    const isQ = (q: unknown): q is Question => typeof (q as Question)?.instructions === 'string';
    const reqs: Req[] | null = Array.isArray(body.requests)
      ? (body.requests.every((r: Req) => isQ(r?.question) && r.state && typeof r.state === 'object' && !Array.isArray(r.state)) ? body.requests : null)
      : (isQ(body.question) && Array.isArray(body.texts) && body.texts.every((t: unknown) => typeof t === 'string'))
        ? body.texts.map((t: string) => ({ question: body.question, state: { paragraph: t } })) : null;
    if (typeof model !== 'string' || !reqs) return c.json({ error: 'need model, and question + texts[] or requests[{question, state}]' }, 400);
    if (reqs.length > MAX_TEXTS) return c.json({ error: `at most ${MAX_TEXTS} requests at once` }, 400);
    // Each distinct uncached request is asked once, however often it repeats.
    const hashes = reqs.map((r) => reqHash(model, r));
    const todo = new Map<string, Req>();
    reqs.forEach((r, i) => { if (cache.get(hashes[i]) === undefined) todo.set(hashes[i], r); });

    const key = c.get('jevBudgetKey' as never) as string;
    const now = Date.now();
    let w = used.get(key);
    if (!w || now - w.start >= 3600_000) used.set(key, w = { start: now, n: 0 });
    if (w.n + todo.size > config.textsPerHour) {
      return c.json({ error: `this link has sent ${w.n} new texts to jev this hour; the limit is ${config.textsPerHour}` }, 429);
    }
    w.n += todo.size;

    // On the first failure every worker stops taking new requests; once all have settled, the
    // requests never answered are refunded to the link's hour.
    let answered = 0;
    let failure: Error | null = null;
    const queue = [...todo];
    await Promise.all(Array.from({ length: WORKERS }, async () => {
      for (let item = queue.shift(); item && !failure; item = queue.shift()) {
        const [h, r] = item;
        try { cache.put(h, await askOne(model, r.question, r.state), model); answered++; }
        catch (e) { failure ??= e as Error; }
      }
    }));
    if (failure) {
      w.n -= todo.size - answered;
      return c.json({ error: (failure as Error).message }, 502);
    }
    return c.json({ ps: hashes.map((h) => cache.get(h)!), cached: hashes.filter((h) => !todo.has(h)).length });
  });
  return app;
}
