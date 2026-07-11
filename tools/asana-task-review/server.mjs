import { createServer } from 'node:http';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaults = {
  tasksPath: path.join(here, 'data', 'tasks.json'),
  statePath: path.join(here, 'data', 'review-state.json'),
  publicDir: path.join(here, 'public')
};

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function validateTasks(document) {
  if (!document || !Array.isArray(document.tasks)) throw new Error('tasks.json must contain a tasks array');
  const ids = new Set();
  for (const task of document.tasks) {
    if (!task.gid || ids.has(task.gid)) throw new Error(`Invalid or duplicate task gid: ${task.gid}`);
    const required = ['name', 'description', 'url', 'section', 'fit', 'repository', 'size', 'confidence', 'delivery', 'rationale', 'verification'];
    for (const field of required) {
      if (typeof task[field] !== 'string' || !task[field]) throw new Error(`Task ${task.gid} has invalid ${field}`);
    }
    if (typeof task.selected !== 'boolean' || typeof task.visualValidation !== 'boolean') {
      throw new Error(`Task ${task.gid} has invalid boolean classification`);
    }
    ids.add(task.gid);
  }
  return ids;
}

function validateUpdate(update) {
  if (!update || typeof update !== 'object') throw new Error('Review update must be an object');
  if (typeof update.selected !== 'boolean') throw new Error('selected must be a boolean');
  if (typeof update.comment !== 'string') throw new Error('comment must be a string');
  if (update.comment.length > 10_000) throw new Error('comment must be at most 10000 characters');
  return { selected: update.selected, comment: update.comment };
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, filePath);
}

export async function createReviewStore(options = {}) {
  const tasksPath = options.tasksPath ?? defaults.tasksPath;
  const statePath = options.statePath ?? defaults.statePath;
  const taskDocument = JSON.parse(await readFile(tasksPath, 'utf8'));
  const taskIds = validateTasks(taskDocument);
  if (options.expectedTaskCount && taskIds.size !== options.expectedTaskCount) {
    throw new Error(`Expected ${options.expectedTaskCount} tasks, found ${taskIds.size}`);
  }
  let state;

  try {
    state = JSON.parse(await readFile(statePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = { version: 1, updatedAt: new Date().toISOString(), reviews: {} };
  }

  for (const task of taskDocument.tasks) {
    const existing = state.reviews?.[task.gid];
    state.reviews ??= {};
    state.reviews[task.gid] = {
      selected: typeof existing?.selected === 'boolean' ? existing.selected : task.selected,
      comment: typeof existing?.comment === 'string' ? existing.comment : '',
      updatedAt: existing?.updatedAt ?? null
    };
  }
  await writeJsonAtomic(statePath, state);
  let writeQueue = Promise.resolve();

  return {
    async getSnapshot() {
      return {
        generatedAt: taskDocument.generatedAt,
        source: taskDocument.source,
        stateUpdatedAt: state.updatedAt,
        tasks: taskDocument.tasks.map(task => ({ ...task, review: { ...state.reviews[task.gid] } }))
      };
    },

    async updateReview(gid, rawUpdate) {
      if (!taskIds.has(gid)) throw new Error(`Unknown task: ${gid}`);
      const update = validateUpdate(rawUpdate);
      const operation = writeQueue.then(async () => {
        const timestamp = new Date().toISOString();
        state.reviews[gid] = { ...update, updatedAt: timestamp };
        state.updatedAt = timestamp;
        await writeJsonAtomic(statePath, state);
        return { ...state.reviews[gid] };
      });
      writeQueue = operation.catch(() => {});
      return operation;
    }
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 20_000) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Request body must be valid JSON');
  }
}

async function serveStatic(response, publicDir, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const requested = path.resolve(publicDir, relative);
  const root = `${path.resolve(publicDir)}${path.sep}`;
  if (!requested.startsWith(root)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }
  try {
    await access(requested);
    const body = await readFile(requested);
    response.writeHead(200, {
      'content-type': contentTypes[path.extname(requested)] ?? 'application/octet-stream',
      'cache-control': 'no-cache'
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
}

export async function createReviewServer(options = {}) {
  const store = await createReviewStore({
    ...options,
    expectedTaskCount: options.expectedTaskCount ?? (options.tasksPath ? undefined : 33)
  });
  const publicDir = options.publicDir ?? defaults.publicDir;
  const token = options.token;

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/api/') && token && request.headers['x-review-token'] !== token) {
        sendJson(response, 401, { error: 'Invalid review session token' });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/tasks') {
        sendJson(response, 200, await store.getSnapshot());
        return;
      }

      const reviewMatch = url.pathname.match(/^\/api\/reviews\/(\d+)$/);
      if (request.method === 'PUT' && reviewMatch) {
        const review = await store.updateReview(reviewMatch[1], await readJsonBody(request));
        sendJson(response, 200, { review });
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        sendJson(response, 404, { error: 'API route not found' });
        return;
      }
      await serveStatic(response, publicDir, url.pathname);
    } catch (error) {
      const status = /Unknown task/.test(error.message) ? 404 : 400;
      sendJson(response, status, { error: error.message });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST ?? '0.0.0.0';
  const port = Number.parseInt(process.env.PORT ?? '9103', 10);
  const token = process.env.REVIEW_TOKEN ?? randomBytes(18).toString('hex');
  const server = await createReviewServer({ token });
  server.listen(port, host, () => {
    console.log(`Asana task review listening on http://${host}:${port}/?token=${token}`);
  });
}
