import { createServer } from 'node:http';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaults = {
  manifestPath: path.join(here, 'data', 'manifest.json'),
  statePath: path.join(here, 'data', 'validation-state.json'),
  publicDir: path.join(here, 'public')
};
const statuses = new Set(['pending', 'verified', 'issue']);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

function validateManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.items)) throw new Error('manifest must contain items');
  const ids = new Set();
  for (const item of manifest.items) {
    if (!item.id || ids.has(item.id)) throw new Error(`Invalid item id: ${item.id}`);
    if (!['human', 'automated'].includes(item.group)) throw new Error(`Invalid group: ${item.id}`);
    if (!item.title || !Array.isArray(item.instructions) || !item.pr?.url || !Array.isArray(item.asana)) throw new Error(`Invalid item: ${item.id}`);
    ids.add(item.id);
  }
  return ids;
}

function validateUpdate(update) {
  if (!update || !statuses.has(update.status)) throw new Error('status must be pending, verified, or issue');
  if (typeof update.notes !== 'string') throw new Error('notes must be a string');
  if (update.notes.length > 10_000) throw new Error('notes must be at most 10000 characters');
  return { status: update.status, notes: update.notes };
}

export async function createValidationStore(options = {}) {
  const manifestPath = options.manifestPath ?? defaults.manifestPath;
  const statePath = options.statePath ?? defaults.statePath;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const ids = validateManifest(manifest);
  let state;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = { version: 1, updatedAt: new Date().toISOString(), validations: {} };
  }
  state.validations ??= {};
  for (const item of manifest.items) {
    const existing = state.validations[item.id];
    const automated = item.group === 'automated';
    state.validations[item.id] = {
      status: statuses.has(existing?.status) ? existing.status : automated ? 'verified' : 'pending',
      notes: typeof existing?.notes === 'string' ? existing.notes : automated ? 'Covered by automated tests and code review.' : '',
      updatedAt: existing?.updatedAt ?? null
    };
  }
  await atomicJson(statePath, state);
  let queue = Promise.resolve();
  return {
    async getSnapshot() {
      return { ...manifest, stateUpdatedAt: state.updatedAt, items: manifest.items.map(item => ({ ...item, validation: { ...state.validations[item.id] } })) };
    },
    async getState() { return structuredClone(state); },
    async updateValidation(id, raw) {
      if (!ids.has(id)) throw new Error(`Unknown item: ${id}`);
      const update = validateUpdate(raw);
      const operation = queue.then(async () => {
        const now = new Date().toISOString();
        state.validations[id] = { ...update, updatedAt: now };
        state.updatedAt = now;
        await atomicJson(statePath, state);
        return { ...state.validations[id] };
      });
      queue = operation.catch(() => {});
      return operation;
    }
  };
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': types['.json'], 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function body(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 20_000) throw new Error('Request body too large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new Error('Request body must be valid JSON'); }
}

async function staticFile(response, publicDir, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const requested = path.resolve(publicDir, relative);
  if (!requested.startsWith(`${path.resolve(publicDir)}${path.sep}`)) { response.writeHead(403); response.end('Forbidden'); return; }
  try {
    await access(requested);
    response.writeHead(200, { 'content-type': types[path.extname(requested)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    response.end(await readFile(requested));
  } catch { response.writeHead(404); response.end('Not found'); }
}

export async function createValidationServer(options = {}) {
  const store = await createValidationStore(options);
  const publicDir = options.publicDir ?? defaults.publicDir;
  const token = options.token;
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const suppliedToken = request.headers['x-validation-token'] ?? url.searchParams.get('token');
      if (url.pathname.startsWith('/api/') && token && suppliedToken !== token) return json(response, 401, { error: 'Invalid validation token' });
      if (request.method === 'GET' && url.pathname === '/api/validation') return json(response, 200, await store.getSnapshot());
      if (request.method === 'GET' && url.pathname === '/api/state.json') return json(response, 200, await store.getState());
      const match = url.pathname.match(/^\/api\/validation\/([a-z0-9-]+)$/);
      if (request.method === 'PUT' && match) return json(response, 200, { validation: await store.updateValidation(match[1], await body(request)) });
      if (url.pathname.startsWith('/api/')) return json(response, 404, { error: 'API route not found' });
      await staticFile(response, publicDir, url.pathname);
    } catch (error) { json(response, /Unknown item/.test(error.message) ? 404 : 400, { error: error.message }); }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST ?? '0.0.0.0';
  const port = Number.parseInt(process.env.PORT ?? '9101', 10);
  const token = process.env.VALIDATION_TOKEN ?? randomBytes(18).toString('hex');
  const server = await createValidationServer({ token });
  server.listen(port, host, () => console.log(`Batch validation: http://${host}:${port}/?token=${token}`));
}
