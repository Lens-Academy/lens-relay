import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createReviewServer, createReviewStore } from './server.mjs';

const fixtureTasks = {
  generatedAt: '2026-07-11T00:00:00Z',
  source: 'test',
  tasks: [
    {
      gid: '1',
      name: 'Recommended task',
      description: 'A task',
      selected: true,
      fit: 'autonomous',
      repository: 'lens-relay',
      size: 'S',
      confidence: 'high',
      visualValidation: false,
      delivery: 'pr-only',
      rationale: 'Bounded',
      verification: 'A test',
      section: 'ToDo',
      url: 'https://app.asana.com/0/0/1'
    },
    {
      gid: '2',
      name: 'Deferred task',
      description: 'Another task',
      selected: false,
      fit: 'defer',
      repository: 'lens-relay',
      size: 'L',
      confidence: 'high',
      visualValidation: true,
      delivery: 'pr-only',
      rationale: 'Broad',
      verification: 'Clarify first',
      section: 'Inbox',
      url: 'https://app.asana.com/0/0/2'
    }
  ]
};

async function withFixture(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'asana-review-'));
  const tasksPath = path.join(dir, 'tasks.json');
  const statePath = path.join(dir, 'review-state.json');
  await writeFile(tasksPath, JSON.stringify(fixtureTasks));
  try {
    await run({ dir, tasksPath, statePath });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('store defaults selections from Codex recommendations', async () => {
  await withFixture(async ({ tasksPath, statePath }) => {
    const store = await createReviewStore({ tasksPath, statePath });
    const snapshot = await store.getSnapshot();
    assert.equal(snapshot.tasks[0].review.selected, true);
    assert.equal(snapshot.tasks[1].review.selected, false);
    assert.equal(snapshot.tasks[0].review.comment, '');
  });
});

test('store persists selection and comment atomically', async () => {
  await withFixture(async ({ tasksPath, statePath }) => {
    const store = await createReviewStore({ tasksPath, statePath });
    const review = await store.updateReview('1', { selected: false, comment: 'Needs a smaller scope.' });
    assert.equal(review.selected, false);
    assert.equal(review.comment, 'Needs a smaller scope.');

    const saved = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(saved.reviews['1'].selected, false);
    assert.equal(saved.reviews['1'].comment, 'Needs a smaller scope.');
  });
});

test('store rejects unknown task IDs and malformed updates', async () => {
  await withFixture(async ({ tasksPath, statePath }) => {
    const store = await createReviewStore({ tasksPath, statePath });
    await assert.rejects(() => store.updateReview('missing', { selected: true, comment: '' }), /Unknown task/);
    await assert.rejects(() => store.updateReview('1', { selected: 'yes', comment: '' }), /selected/);
    await assert.rejects(() => store.updateReview('1', { selected: true, comment: 42 }), /comment/);
  });
});

test('concurrent updates survive in memory and after reopening from disk', async () => {
  await withFixture(async ({ tasksPath, statePath }) => {
    const store = await createReviewStore({ tasksPath, statePath });
    await Promise.all([
      store.updateReview('1', { selected: false, comment: 'First note' }),
      store.updateReview('2', { selected: true, comment: 'Second note' })
    ]);

    const reopened = await createReviewStore({ tasksPath, statePath });
    const snapshot = await reopened.getSnapshot();
    assert.deepEqual(
      snapshot.tasks.map(task => [task.gid, task.review.selected, task.review.comment]),
      [['1', false, 'First note'], ['2', true, 'Second note']]
    );
  });
});

test('HTTP API requires its session token and round-trips updates', async () => {
  await withFixture(async ({ tasksPath, statePath, dir }) => {
    const publicDir = path.join(dir, 'public');
    const server = await createReviewServer({ tasksPath, statePath, publicDir, token: 'test-token' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const denied = await fetch(`http://127.0.0.1:${port}/api/tasks`);
      assert.equal(denied.status, 401);

      const initial = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
        headers: { 'x-review-token': 'test-token' }
      }).then(response => response.json());
      assert.equal(initial.tasks.length, 2);

      const response = await fetch(`http://127.0.0.1:${port}/api/reviews/2`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-review-token': 'test-token' },
        body: JSON.stringify({ selected: true, comment: 'Pilot candidate' })
      });
      assert.equal(response.status, 200);
      const updated = await response.json();
      assert.equal(updated.review.selected, true);
      assert.equal(updated.review.comment, 'Pilot candidate');
    } finally {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
