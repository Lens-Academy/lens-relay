import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createValidationServer, createValidationStore } from './server.mjs';

test('release manifest includes nine merged changes including md-equivalent wikilinks', async () => {
  const store = await createValidationStore();
  const snapshot = await store.getSnapshot();
  assert.equal(snapshot.items.length, 9);
  const wikilinks = snapshot.items.find(item => item.id === 'pr-50');
  assert.equal(wikilinks.group, 'automated');
  assert.match(wikilinks.summary, /\.md/);
});

test('dashboard marks automated evidence accurately and supplies an inline favicon', async () => {
  const app = await readFile(new URL('./public/app.js', import.meta.url), 'utf8');
  const page = await readFile(new URL('./public/index.html', import.meta.url), 'utf8');
  assert.match(app, /Automated checks passed/);
  assert.match(page, /rel="icon" href="data:image\/svg\+xml/);
});

const fixture = {
  title: 'Release validation',
  items: [
    { id: 'pr-1', group: 'human', title: 'Try it', instructions: ['Do the thing'], pr: { number: 1, url: 'https://example.com/pr/1' }, asana: [{ title: 'Task', url: 'https://example.com/task/1' }] },
    { id: 'pr-2', group: 'automated', title: 'Covered', instructions: ['No action'], pr: { number: 2, url: 'https://example.com/pr/2' }, asana: [{ title: 'Task', url: 'https://example.com/task/2' }] }
  ]
};

async function withFixture(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'batch-validation-'));
  const manifestPath = path.join(dir, 'manifest.json');
  const statePath = path.join(dir, 'state.json');
  await writeFile(manifestPath, JSON.stringify(fixture));
  try { await run({ dir, manifestPath, statePath }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('store supplies pending human and pre-verified automated defaults', async () => {
  await withFixture(async ({ manifestPath, statePath }) => {
    const store = await createValidationStore({ manifestPath, statePath });
    const snapshot = await store.getSnapshot();
    assert.deepEqual(snapshot.items.map(item => [item.id, item.validation.status, item.validation.notes]), [
      ['pr-1', 'pending', ''],
      ['pr-2', 'verified', 'Covered by automated tests and code review.']
    ]);
  });
});

test('store persists a valid status and notes atomically', async () => {
  await withFixture(async ({ manifestPath, statePath }) => {
    const store = await createValidationStore({ manifestPath, statePath });
    await store.updateValidation('pr-1', { status: 'verified', notes: 'Looks right on a wrapped task item.' });
    const saved = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(saved.validations['pr-1'].status, 'verified');
    assert.equal(saved.validations['pr-1'].notes, 'Looks right on a wrapped task item.');
  });
});

test('store rejects unknown items and invalid updates', async () => {
  await withFixture(async ({ manifestPath, statePath }) => {
    const store = await createValidationStore({ manifestPath, statePath });
    await assert.rejects(() => store.updateValidation('missing', { status: 'pending', notes: '' }), /Unknown item/);
    await assert.rejects(() => store.updateValidation('pr-1', { status: 'maybe', notes: '' }), /status/);
    await assert.rejects(() => store.updateValidation('pr-1', { status: 'verified', notes: 42 }), /notes/);
  });
});

test('HTTP API authenticates, exposes readable state, and round-trips updates', async () => {
  await withFixture(async ({ dir, manifestPath, statePath }) => {
    const publicDir = path.join(dir, 'public');
    const server = await createValidationServer({ manifestPath, statePath, publicDir, token: 'secret' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/validation`)).status, 401);
      const initial = await fetch(`http://127.0.0.1:${port}/api/validation`, { headers: { 'x-validation-token': 'secret' } }).then(r => r.json());
      assert.equal(initial.items.length, 2);
      const response = await fetch(`http://127.0.0.1:${port}/api/validation/pr-1`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-validation-token': 'secret' },
        body: JSON.stringify({ status: 'issue', notes: 'Still broken' })
      });
      assert.equal(response.status, 200);
      const state = await fetch(`http://127.0.0.1:${port}/api/state.json`, { headers: { 'x-validation-token': 'secret' } }).then(r => r.json());
      assert.equal(state.validations['pr-1'].status, 'issue');
    } finally {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
