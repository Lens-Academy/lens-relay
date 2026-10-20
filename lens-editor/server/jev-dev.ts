// Dev-only jev endpoints for the check workbench. Production will call lens-platform instead.
//   GET  /api/jev/corpus            -> {meta, rows:[{id, page, course, text}]}   (~/.cache/jev-workbench/corpus.json)
//   POST /api/jev/ask {model, question:{instructions, criteria?}, texts:[...]} -> {ps:[...], cached:n}
// Every answer is appended to ~/.cache/jev-workbench/answers.jsonl and reused when the same
// (model, question, text) is asked again. Key: JEV_KEY or ~/.typesafe.ai-apikey.txt.
import type { Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = join(homedir(), '.cache', 'jev-workbench');
const ANSWERS = join(DIR, 'answers.jsonl');
const URL = 'https://api.typesafe.ai/v1/systemone';

type Question = { instructions: string; criteria?: { true: string; false: string } | null };

function key(): string {
  const k = process.env.JEV_KEY ?? readFileSync(join(homedir(), '.typesafe.ai-apikey.txt'), 'utf8');
  return k.trim();
}

const cache = new Map<string, number>();
let loaded = false;
function loadCache() {
  if (loaded) return;
  loaded = true;
  mkdirSync(DIR, { recursive: true });
  if (!existsSync(ANSWERS)) return;
  for (const line of readFileSync(ANSWERS, 'utf8').split('\n')) {
    if (!line) continue;
    const r = JSON.parse(line);
    cache.set(r.h, r.p);
  }
}

const hashOf = (model: string, q: Question, text: string) =>
  createHash('sha256').update(JSON.stringify([model, q.instructions, q.criteria ?? null, text])).digest('hex');

async function askOne(model: string, q: Question, text: string): Promise<number> {
  const noul: Record<string, unknown> = { type: 'noul', instructions: q.instructions };
  if (q.criteria) noul.criteria = q.criteria;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, state: { paragraph: text }, questions: { q: noul } }),
    });
    if (res.ok) return (await res.json()).answers.q.noul as number;
    if (attempt >= 3 || res.status < 500) throw new Error(`jev ${res.status}: ${(await res.text()).slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
}

async function askMany(model: string, q: Question, texts: string[]) {
  loadCache();
  const ps: number[] = new Array(texts.length);
  const todo: number[] = [];
  texts.forEach((t, i) => {
    const hit = cache.get(hashOf(model, q, t));
    if (hit === undefined) todo.push(i); else ps[i] = hit;
  });
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const i = todo[next++];
      const p = await askOne(model, q, texts[i]);
      const h = hashOf(model, q, texts[i]);
      cache.set(h, p);
      appendFileSync(ANSWERS, JSON.stringify({ h, p, model, ts: Date.now() }) + '\n');
      ps[i] = p;
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { ps, cached: texts.length - todo.length };
}

async function body(req: AsyncIterable<Buffer>) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString());
}

export function jevDevPlugin(): Plugin {
  return {
    name: 'jev-dev',
    configureServer(server) {
      server.middlewares.use('/api/jev/corpus', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(readFileSync(join(DIR, 'corpus.json')));
      });
      server.middlewares.use('/api/jev/ask', async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        try {
          if (req.method !== 'POST') throw Object.assign(new Error('POST only'), { status: 405 });
          const { model, question, texts } = await body(req as AsyncIterable<Buffer>);
          if (typeof model !== 'string' || !question?.instructions || !Array.isArray(texts)) {
            throw Object.assign(new Error('need model, question.instructions, texts[]'), { status: 400 });
          }
          res.end(JSON.stringify(await askMany(model, question, texts)));
        } catch (e: any) {
          res.statusCode = e.status ?? 502;
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    },
  };
}
