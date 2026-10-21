import { Hono, type MiddlewareHandler } from 'hono';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { roleAtLeast, shareTokenFromHeaders, verifyShareToken } from '../share-token.ts';

/**
 * Jev for the check workbench (src/components/JevCheckPanel):
 *
 *   GET  /api/jev/corpus  → {meta, rows:[{id, path, line, kind, title, courses, text}]}
 *   POST /api/jev/ask     {model, question:{instructions, criteria?}, texts:[...]} → {ps:[...], cached:n}
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
    if (existsSync(file)) for (const line of readFileSync(file, 'utf8').split('\n')) if (line) { const r = JSON.parse(line); map.set(r.h, r.p); }
    return map;
  };
  return {
    get: (h: string) => load().get(h),
    put: (h: string, p: number, model: string) => { load().set(h, p); appendFileSync(file, JSON.stringify({ h, p, model, ts: Date.now() }) + '\n'); },
  };
}

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

  async function askOne(model: string, q: Question, text: string): Promise<number> {
    const noul: Record<string, unknown> = { type: 'noul', instructions: q.instructions };
    if (q.criteria) noul.criteria = q.criteria;
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(JEV_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, state: { paragraph: text }, questions: { q: noul } }),
      });
      if (res.ok) return (await res.json()).answers.q.noul as number;
      if (attempt >= 3 || res.status < 500) throw new Error(`jev ${res.status}: ${(await res.text()).slice(0, 200)}`);
      await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
    }
  }

  app.use('*', requireEditLink());

  app.get('/corpus', c => {
    if (!existsSync(config.corpusPath)) return c.json({ error: `no corpus at ${config.corpusPath}` }, 404);
    return c.body(readFileSync(config.corpusPath, 'utf8'), 200, { 'Content-Type': 'application/json' });
  });

  app.post('/ask', async c => {
    const { model, question, texts } = await c.req.json().catch(() => ({}));
    if (typeof model !== 'string' || typeof question?.instructions !== 'string' || !Array.isArray(texts) || !texts.every(t => typeof t === 'string')) {
      return c.json({ error: 'need model, question.instructions, texts[]' }, 400);
    }
    if (texts.length > MAX_TEXTS) return c.json({ error: `at most ${MAX_TEXTS} texts per request` }, 400);
    const ps: number[] = new Array(texts.length);
    const todo: number[] = [];
    texts.forEach((t, i) => { const hit = cache.get(hashOf(model, question, t)); if (hit === undefined) todo.push(i); else ps[i] = hit; });

    const key = c.get('jevBudgetKey' as never) as string;
    const now = Date.now();
    let w = used.get(key);
    if (!w || now - w.start >= 3600_000) used.set(key, w = { start: now, n: 0 });
    if (w.n + todo.length > config.textsPerHour) {
      return c.json({ error: `this link has sent ${w.n} new texts to jev this hour; the limit is ${config.textsPerHour}` }, 429);
    }
    w.n += todo.length;

    try {
      let next = 0;
      await Promise.all(Array.from({ length: WORKERS }, async () => {
        while (next < todo.length) {
          const i = todo[next++];
          const p = await askOne(model, question, texts[i]);
          cache.put(hashOf(model, question, texts[i]), p, model);
          ps[i] = p;
        }
      }));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
    return c.json({ ps, cached: texts.length - todo.length });
  });
  return app;
}
