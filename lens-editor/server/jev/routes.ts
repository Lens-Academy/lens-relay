import { Hono, type Context } from 'hono';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readRelayDocAtPath } from '../add-video/relay-docs.ts';
import { shareTokenFromHeaders } from '../share-token.ts';
import { requireEduShareToken } from '../edit-share-auth.ts';

/**
 * Jev for the check workbench (src/components/JevCheckPanel):
 *
 *   GET  /api/jev/corpus  → {meta, rows:[{id, path, line, kind, title, courses, text}]}
 *   POST /api/jev/ask     {model, requests:[{question:{instructions, criteria?}, state}]} → {ps:[...], cached:n}
 *   POST /api/jev/files   {paths:[...]} → {files:{path: markdown}}, read live from the relay
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
  /** Characters of new (uncached) requests one share link may send to jev per hour (cost
   *  guard). Counted in characters, since a whole-file request carries ~24x a paragraph's. */
  charsPerHour: number;
  fetchImpl?: typeof fetch;
  /** A file's current markdown by relay path, or null; the relay by default. */
  readFile?: (path: string) => Promise<string | null>;
  /** Read course files from this checkout of lens-edu-staging instead of the relay (dev:
   *  yjs's dev mode breaks server-side relay reads under Vite). */
  filesDir?: string;
}

const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const MAX_TEXTS = 5000;
const WORKERS = 8;
// One jev call holds one state and every question about it, up to jev's 64k tokens per call
// (state plus all questions; ~2.65 characters a token, measured) and a bounded count.
const CALL_MAX_CHARS = 150_000;
const CALL_MAX_QUESTIONS = 100;
// Relay reads per /files request: at most this many files, this many at a time.
const MAX_FILES = 300;
const FILE_WORKERS = 4;

export function loadJevConfig(env: NodeJS.ProcessEnv = process.env): JevConfig {
  const cacheDir = env.JEV_CACHE_DIR || join(homedir(), '.cache', 'jev-workbench');
  const limit = Number(env.JEV_CHARS_PER_HOUR);
  return {
    apiKey: env.JEV_API_KEY?.trim() || undefined,
    cacheDir,
    corpusPath: env.JEV_CORPUS_PATH || join(cacheDir, 'corpus.json'),
    filesDir: env.JEV_FILES_DIR || undefined,
    // About 20,000 paragraph requests an hour: a T1 paragraph request (question, both criteria,
    // paragraph) is about 650 characters at the corpus median.
    charsPerHour: Number.isFinite(limit) && limit > 0 ? limit : 13_000_000,
  };
}

type Question = { instructions: string; criteria?: { true: string; false: string } | null };

// Edit links for Lens Edu (or all folders) only: the routes read and ask with the server's own
// relay token, which can read every folder, so the link's folder must be checked here.
const requireEditLink = requireEduShareToken({ minRole: 'edit' });
const budgetKey = (c: Context) => (shareTokenFromHeaders(c.req.header('X-Share-Token'), c.req.header('Authorization')) ?? '').slice(-24);

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
type Batch = { state: Record<string, unknown>; questions: Question[] };
/** What a request costs against the hourly budget: the characters jev is sent. */
const questionChars = (q: Question) => q.instructions.length + (q.criteria ? q.criteria.true.length + q.criteria.false.length : 0);
/** What one question about one state costs against the hourly budget: the characters jev reads. */
export const requestChars = (r: Req) => JSON.stringify(r.state).length + questionChars(r.question);
// The cache key of what jev is shown: a lone paragraph keys by its text, as every cached
// answer before other states existed did; any other state by its JSON (key order included,
// since jev reads it).
const stateKey = (st: Record<string, unknown>) => {
  const k = Object.keys(st);
  return k.length === 1 && k[0] === 'paragraph' && typeof st.paragraph === 'string' ? st.paragraph : JSON.stringify(st);
};
const reqHash = (model: string, r: Req) => hashOf(model, r.question, stateKey(r.state));
/** Files by relay path ("Lens Edu/x.md") from a checkout of the Lens Edu folder's repo. */
const readFromDir = (dir: string) => async (path: string): Promise<string | null> => {
  const rel = path.replace(/^Lens Edu\//, '');
  if (rel === path || rel.split('/').includes('..')) return null;
  return existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), 'utf8') : null;
};
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

  // One call: jev reads `state` once and answers every question on it, the same answers as
  // asking each alone. A call jev refuses as too long (a big state) answers null for all of them.
  async function askBatch(model: string, state: Record<string, unknown>, qs: Question[], long: boolean): Promise<(number | null)[]> {
    const questions = Object.fromEntries(qs.map((q, i) => [`q${i}`, { type: 'noul', instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}) }]));
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(JEV_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', ...(long ? { 'TypeSafe-Danger-Zone-Long-Context': 'true' } : {}) },
        body: JSON.stringify({ model, state, questions }),
      });
      if (res.ok) {
        const answers = (await res.json()).answers ?? {};
        return qs.map((_, i) => {
          const p = answers[`q${i}`]?.noul;
          if (typeof p !== 'number') throw new Error('jev answered without a probability');
          return p;
        });
      }
      const body = await res.text();
      if (res.status === 400 && body.includes('max_tokens_exceeded')) return qs.map(() => null);
      if (attempt >= 3 || (res.status < 500 && res.status !== 429)) throw new Error(`jev ${res.status}: ${body.slice(0, 200)}`);
      await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
    }
  }

  app.use('*', requireEditLink);

  app.get('/corpus', c => {
    if (!existsSync(config.corpusPath)) return c.json({ error: `no corpus at ${config.corpusPath}` }, 404);
    return c.body(readFileSync(config.corpusPath, 'utf8'), 200, { 'Content-Type': 'application/json' });
  });

  // Course files as they are now, for presentations that show jev the whole file. Read
  // through the relay (a minute's cache), so an edit made in the editor reaches the next Run.
  const readFile = config.readFile ?? (config.filesDir ? readFromDir(config.filesDir) : (p: string) => readRelayDocAtPath(p));
  const fileCache = new Map<string, { at: number; text: string | null }>();
  app.post('/files', async c => {
    const { paths } = await c.req.json().catch(() => ({}));
    // Course files only, never the rest of the relay; and a bounded load on it per request.
    const edu = (p: unknown) => typeof p === 'string' && p.startsWith('Lens Edu/') && !p.split('/').includes('..');
    if (!Array.isArray(paths) || !paths.every(edu) || paths.length > MAX_FILES) {
      return c.json({ error: `need paths[]: at most ${MAX_FILES}, each under "Lens Edu/"` }, 400);
    }
    const now = Date.now();
    const todo = (paths as string[]).filter((p) => !((fileCache.get(p)?.at ?? 0) > now - 60_000));
    try {
      let next = 0;
      await Promise.all(Array.from({ length: FILE_WORKERS }, async () => {
        while (next < todo.length) { const p = todo[next++]; fileCache.set(p, { at: now, text: await readFile(p) }); }
      }));
    } catch (e) {
      return c.json({ error: `reading files from the relay: ${(e as Error).message}` }, 502);
    }
    return c.json({ files: Object.fromEntries((paths as string[]).flatMap((p) => { const t = fileCache.get(p)?.text; return typeof t === 'string' ? [[p, t]] : []; })) });
  });

  app.post('/ask', async c => {
    const body = await c.req.json().catch(() => ({}));
    const { model } = body;
    const isQ = (q: unknown): q is Question => typeof (q as Question)?.instructions === 'string';
    const isState = (st: unknown) => !!st && typeof st === 'object' && !Array.isArray(st);
    // Each item is one state with its questions ({state, questions}) or with one ({state, question});
    // ps answers every question, in order.
    const items: unknown[] | null = Array.isArray(body.requests) ? body.requests : null;
    const reqs: Req[] | null = items && items.every((r) => isState((r as Req)?.state) && (isQ((r as Req).question) || (Array.isArray((r as Batch).questions) && (r as Batch).questions.every(isQ))))
      ? items.flatMap((r) => ((r as Batch).questions ?? [(r as Req).question]).map((question) => ({ question, state: (r as Req).state }))) : null;
    if (typeof model !== 'string' || !reqs) return c.json({ error: 'need model and requests[{state, questions[]}]' }, 400);
    // jev's long context (TypeSafe-Danger-Zone-Long-Context): larger states, answers TypeSafe
    // does not certify, so cached apart from normal answers.
    const long = body.longContext === true;
    if (reqs.length > MAX_TEXTS) return c.json({ error: `at most ${MAX_TEXTS} requests at once` }, 400);
    // Each distinct uncached request is asked once, however often it repeats.
    const hashes = reqs.map((r) => reqHash(long ? `${model}+long` : model, r));
    const todo = new Map<string, Req>();
    reqs.forEach((r, i) => { if (cache.get(hashes[i]) === undefined) todo.set(hashes[i], r); });

    const key = budgetKey(c);
    const now = Date.now();
    let w = used.get(key);
    if (!w || now - w.start >= 3600_000) used.set(key, w = { start: now, n: 0 });
    // Questions about the same state share a call, as many as fit.
    const calls: { state: Record<string, unknown>; hs: string[]; qs: Question[]; cost: number }[] = [];
    const open = new Map<string, (typeof calls)[number]>();
    for (const [h, r] of todo) {
      const k = stateKey(r.state);
      let call = open.get(k);
      if (!call || call.qs.length >= CALL_MAX_QUESTIONS || call.cost + questionChars(r.question) > CALL_MAX_CHARS) {
        calls.push(call = { state: r.state, hs: [], qs: [], cost: JSON.stringify(r.state).length });
        open.set(k, call);
      }
      call.hs.push(h); call.qs.push(r.question); call.cost += questionChars(r.question);
    }
    const total = calls.reduce((a, x) => a + x.cost, 0);
    if (w.n + total > config.charsPerHour) {
      return c.json({ error: `this link has sent ${w.n} characters to jev this hour; this run needs ${total} more, and the limit is ${config.charsPerHour}` }, 429);
    }
    w.n += total;

    // On the first failure every worker stops taking new requests; once all have settled, the
    // requests never answered are refunded to the link's hour.
    let answered = 0;
    let failure: Error | null = null;
    const tooLong = new Set<string>();
    const queue = [...calls];
    await Promise.all(Array.from({ length: WORKERS }, async () => {
      for (let call = queue.shift(); call && !failure; call = queue.shift()) {
        try {
          const ps = await askBatch(model, call.state, call.qs, long);
          ps.forEach((p, i) => (p === null ? tooLong.add(call!.hs[i]) : cache.put(call!.hs[i], p, model)));
          answered += call.cost;
        }
        catch (e) { failure ??= e as Error; }
      }
    }));
    if (failure) {
      w.n -= total - answered; // refund what was never answered
      return c.json({ error: (failure as Error).message }, 502);
    }
    return c.json({ ps: hashes.map((h) => (tooLong.has(h) ? null : cache.get(h)!)), cached: hashes.filter((h) => !todo.has(h)).length, ...(tooLong.size ? { tooLong: tooLong.size } : {}) });
  });
  return app;
}
