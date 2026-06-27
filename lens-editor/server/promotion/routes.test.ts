import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { createPromotionRoutes, type PromotionRouteService } from './routes';
import { signShareToken } from '../share-token';
import type { ShareTokenPayload } from '../share-token';
import { PromotionError } from './types';

const EDU_FOLDER = 'ea4015da-24af-4d9d-ac49-8c902cb17121';
const ALL_FOLDERS = '00000000-0000-0000-0000-000000000000';
const OTHER_FOLDER = 'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e';

function makeToken(overrides: Partial<ShareTokenPayload> = {}): string {
  return signShareToken({
    purpose: 'share',
    role: 'edit',
    folder: EDU_FOLDER,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  });
}

function createMockService(): PromotionRouteService {
  return {
    getChanges: vi.fn(async () => ({ files: [{ path: 'lesson.md' }] })),
    getStatus: vi.fn(async (path: string) => ({ path, status: 'modified' })),
    getDiff: vi.fn(async (path: string) => ({ path, diff: '@@ diff @@' })),
    createPromotionPr: vi.fn(async input => ({
      branch: 'promote/test',
      prNumber: 42,
      prUrl: 'https://github.test/pull/42',
      mainSha: '1111111111111111111111111111111111111111',
      autoMergeEnabled: true,
    })),
  } as PromotionRouteService;
}

function createApp(service = createMockService()): { app: Hono; service: PromotionRouteService } {
  const app = new Hono();
  app.route('/api/promotion', createPromotionRoutes(service));
  return { app, service };
}

describe('promotion routes auth', () => {
  it('rejects requests without a token with 401 JSON', async () => {
    const { app } = createApp();

    const resp = await app.request('/api/promotion/changes');

    expect(resp.status).toBe(401);
    expect(await resp.json()).toMatchObject({ error: expect.any(String) });
  });

  it('rejects invalid tokens with 401 JSON', async () => {
    const { app } = createApp();

    const resp = await app.request('/api/promotion/changes', {
      headers: { 'X-Share-Token': 'not-a-real-token' },
    });

    expect(resp.status).toBe(401);
    expect(await resp.json()).toMatchObject({ error: expect.any(String) });
  });

  it('rejects expired tokens with 401 JSON', async () => {
    const { app } = createApp();

    const resp = await app.request('/api/promotion/changes', {
      headers: { 'X-Share-Token': makeToken({ expiry: Math.floor(Date.now() / 1000) - 60 }) },
    });

    expect(resp.status).toBe(401);
    expect(await resp.json()).toMatchObject({ error: expect.any(String) });
  });

  it('rejects view-only users with 403 JSON', async () => {
    const { app } = createApp();

    const resp = await app.request('/api/promotion/changes', {
      headers: { 'X-Share-Token': makeToken({ role: 'view' }) },
    });

    expect(resp.status).toBe(403);
    expect(await resp.json()).toMatchObject({ error: expect.any(String) });
  });

  it('rejects non-share purpose tokens with 403 JSON', async () => {
    const { app } = createApp();

    const resp = await app.request('/api/promotion/changes', {
      headers: { 'X-Share-Token': makeToken({ purpose: 'add-video' }) },
    });

    expect(resp.status).toBe(403);
    expect(await resp.json()).toMatchObject({ error: expect.any(String) });
  });

  it('rejects edit share tokens scoped to the wrong folder with 403 JSON', async () => {
    const { app } = createApp();

    const resp = await app.request('/api/promotion/changes', {
      headers: { 'X-Share-Token': makeToken({ folder: OTHER_FOLDER }) },
    });

    expect(resp.status).toBe(403);
    expect(await resp.json()).toMatchObject({ error: expect.any(String) });
  });

  it('accepts edit share tokens scoped to all folders', async () => {
    const { app, service } = createApp();

    const resp = await app.request('/api/promotion/changes', {
      headers: { 'X-Share-Token': makeToken({ folder: ALL_FOLDERS }) },
    });

    expect(resp.status).toBe(200);
    expect(service.getChanges).toHaveBeenCalledOnce();
  });
});

describe('promotion route service delegation', () => {
  let app: Hono;
  let service: PromotionRouteService;

  beforeEach(() => {
    ({ app, service } = createApp());
  });

  it('returns changes for edit users', async () => {
    const resp = await app.request('/api/promotion/changes', {
      headers: { 'X-Share-Token': makeToken() },
    });

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ files: [{ path: 'lesson.md' }] });
    expect(service.getChanges).toHaveBeenCalledOnce();
  });

  it('accepts Authorization Bearer tokens', async () => {
    const resp = await app.request('/api/promotion/changes', {
      headers: { Authorization: `Bearer ${makeToken()}` },
    });

    expect(resp.status).toBe(200);
    expect(service.getChanges).toHaveBeenCalledOnce();
  });

  it('requires a path for status requests', async () => {
    const resp = await app.request('/api/promotion/status', {
      headers: { 'X-Share-Token': makeToken() },
    });

    expect(resp.status).toBe(400);
    expect(await resp.json()).toMatchObject({ error: expect.any(String) });
    expect(service.getStatus).not.toHaveBeenCalled();
  });

  it('passes the status path through to the service', async () => {
    const resp = await app.request('/api/promotion/status?path=Dir%2FLesson.md', {
      headers: { 'X-Share-Token': makeToken() },
    });

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ path: 'Dir/Lesson.md', status: 'modified' });
    expect(service.getStatus).toHaveBeenCalledWith('Dir/Lesson.md');
  });

  it('requires a path for diff requests', async () => {
    const resp = await app.request('/api/promotion/diff', {
      headers: { 'X-Share-Token': makeToken() },
    });

    expect(resp.status).toBe(400);
    expect(await resp.json()).toMatchObject({ error: expect.any(String) });
    expect(service.getDiff).not.toHaveBeenCalled();
  });

  it('passes the diff path through to the service', async () => {
    const resp = await app.request('/api/promotion/diff?path=lesson.md', {
      headers: { 'X-Share-Token': makeToken() },
    });

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ path: 'lesson.md', diff: '@@ diff @@' });
    expect(service.getDiff).toHaveBeenCalledWith('lesson.md');
  });

  it('passes selected paths and optional title to the PR service', async () => {
    const resp = await app.request('/api/promotion/pr', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Share-Token': makeToken(),
      },
      body: JSON.stringify({
        paths: ['lesson.md', 'other.md'],
        title: 'Promote selected files',
      }),
    });

    expect(resp.status).toBe(200);
    expect(service.createPromotionPr).toHaveBeenCalledWith({
      paths: ['lesson.md', 'other.md'],
      title: 'Promote selected files',
    });
    expect(await resp.json()).toMatchObject({
      branch: 'promote/test',
      prNumber: 42,
      prUrl: 'https://github.test/pull/42',
      mainSha: '1111111111111111111111111111111111111111',
      autoMergeEnabled: true,
    });
  });

  it('rejects PR requests without a paths array', async () => {
    const resp = await app.request('/api/promotion/pr', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Share-Token': makeToken(),
      },
      body: JSON.stringify({ title: 'No paths' }),
    });

    expect(resp.status).toBe(400);
    expect(await resp.json()).toMatchObject({ error: expect.any(String) });
    expect(service.createPromotionPr).not.toHaveBeenCalled();
  });

  it('returns 400 JSON for malformed PR JSON', async () => {
    const resp = await app.request('/api/promotion/pr', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Share-Token': makeToken(),
      },
      body: '{',
    });

    expect(resp.status).toBe(400);
    expect(await resp.json()).toMatchObject({ error: expect.any(String) });
    expect(service.createPromotionPr).not.toHaveBeenCalled();
  });

  it('returns JSON 404 for unknown promotion API routes', async () => {
    const resp = await app.request('/api/promotion/unknown', {
      headers: { 'X-Share-Token': makeToken() },
    });

    expect(resp.status).toBe(404);
    expect(resp.headers.get('content-type')).toContain('application/json');
    expect(await resp.json()).toEqual({ error: 'Promotion route not found' });
  });
});

describe('promotion route errors', () => {
  it('maps PromotionError status and code to JSON', async () => {
    const service = createMockService();
    vi.mocked(service.getChanges).mockRejectedValueOnce(
      new PromotionError(409, 'Nothing to promote', 'nothing_to_promote'),
    );
    const { app } = createApp(service);

    const resp = await app.request('/api/promotion/changes', {
      headers: { 'X-Share-Token': makeToken() },
    });

    expect(resp.status).toBe(409);
    expect(await resp.json()).toEqual({
      error: 'Nothing to promote',
      code: 'nothing_to_promote',
    });
  });

  it('falls back to 500 JSON for invalid PromotionError statuses', async () => {
    const service = createMockService();
    vi.mocked(service.getChanges).mockRejectedValueOnce(
      new PromotionError(-1, 'Invalid status', 'invalid_status'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { app } = createApp(service);

    const resp = await app.request('/api/promotion/changes', {
      headers: { 'X-Share-Token': makeToken() },
    });

    expect(resp.status).toBe(500);
    expect(await resp.json()).toEqual({
      error: 'Promotion request failed',
      code: 'invalid_status',
    });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('does not expose sensitive details from 5xx PromotionError responses', async () => {
    const service = createMockService();
    vi.mocked(service.getChanges).mockRejectedValueOnce(
      new PromotionError(
        500,
        'git failed for git@github.com:Lens-Academy/private.git: secret-token',
        'git_failed',
      ),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { app } = createApp(service);

    const resp = await app.request('/api/promotion/changes', {
      headers: { 'X-Share-Token': makeToken() },
    });

    expect(resp.status).toBe(500);
    expect(await resp.json()).toEqual({
      error: 'Promotion request failed',
      code: 'git_failed',
    });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('maps unexpected errors to 500 JSON without exposing details', async () => {
    const service = createMockService();
    vi.mocked(service.getChanges).mockRejectedValueOnce(new Error('database password leaked'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { app } = createApp(service);

    const resp = await app.request('/api/promotion/changes', {
      headers: { 'X-Share-Token': makeToken() },
    });

    expect(resp.status).toBe(500);
    expect(await resp.json()).toEqual({ error: 'Promotion request failed' });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
