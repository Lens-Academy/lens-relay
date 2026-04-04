import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createAddVideoRoutes } from './routes';
import { signShareToken, verifyShareToken } from '../share-token';
import type { ShareTokenPayload } from '../share-token';

const EDU_FOLDER = 'ea4015da-24af-4d9d-ac49-8c902cb17121';
const LENS_FOLDER = 'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e';

function makeAddVideoToken(overrides: Partial<ShareTokenPayload> = {}): string {
  return signShareToken({
    purpose: 'add-video',
    role: 'edit',
    folder: EDU_FOLDER,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  });
}

const validVideo = {
  video_id: 'abc',
  title: 'Test',
  channel: 'Ch',
  url: 'https://youtube.com/watch?v=abc',
  transcript_type: 'word_level' as const,
  transcript_raw: { events: [] },
};

describe('POST /api/add-video', () => {
  let app: Hono;
  let mockQueue: { add: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockQueue = {
      add: vi.fn(() => ({
        id: 'job1',
        video_id: 'abc',
        title: 'Test',
        channel: 'Ch',
        status: 'queued',
        relay_url: 'https://editor.lensacademy.org/path/to/doc',
      })),
      status: vi.fn(() => []),
    };
    app = new Hono();
    app.route('/api/add-video', createAddVideoRoutes(mockQueue as any));
  });

  it('accepts valid video payload and returns job info', async () => {
    const resp = await app.request('/api/add-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${makeAddVideoToken()}` },
      body: JSON.stringify({
        videos: [validVideo],
      }),
    });

    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.jobs).toHaveLength(1);
    expect(data.jobs[0].id).toBe('job1');
    expect(data.jobs[0].status).toBe('queued');
    expect(data.jobs[0].relay_url).toBeDefined();
  });

  it('rejects request with no auth header', async () => {
    const resp = await app.request('/api/add-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videos: [validVideo] }),
    });

    expect(resp.status).toBe(401);
  });

  it('rejects request with invalid token', async () => {
    const resp = await app.request('/api/add-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer invalid-token' },
      body: JSON.stringify({ videos: [validVideo] }),
    });

    expect(resp.status).toBe(401);
  });

  it('rejects share-purpose token (wrong purpose)', async () => {
    const token = signShareToken({
      purpose: 'share',
      role: 'edit',
      folder: EDU_FOLDER,
      expiry: Math.floor(Date.now() / 1000) + 3600,
    });
    const resp = await app.request('/api/add-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ videos: [validVideo] }),
    });

    expect(resp.status).toBe(403);
  });

  it('rejects view-role token', async () => {
    const token = makeAddVideoToken({ role: 'view' });
    const resp = await app.request('/api/add-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ videos: [validVideo] }),
    });

    expect(resp.status).toBe(403);
  });

  it('rejects token for wrong folder', async () => {
    const token = makeAddVideoToken({ folder: LENS_FOLDER });
    const resp = await app.request('/api/add-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ videos: [validVideo] }),
    });

    expect(resp.status).toBe(403);
  });

  it('accepts all-folders token', async () => {
    const token = makeAddVideoToken({ folder: '00000000-0000-0000-0000-000000000000' });
    const resp = await app.request('/api/add-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ videos: [validVideo] }),
    });

    expect(resp.status).toBe(200);
  });

  it('rejects empty videos array', async () => {
    const resp = await app.request('/api/add-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${makeAddVideoToken()}` },
      body: JSON.stringify({ videos: [] }),
    });

    expect(resp.status).toBe(400);
  });

  it('rejects missing videos field', async () => {
    const resp = await app.request('/api/add-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${makeAddVideoToken()}` },
      body: JSON.stringify({}),
    });

    expect(resp.status).toBe(400);
  });
});

describe('GET /api/add-video/status', () => {
  it('returns all jobs', async () => {
    const mockQueue = {
      add: vi.fn(),
      status: vi.fn(() => [
        { id: 'j1', video_id: 'a', status: 'done' },
        { id: 'j2', video_id: 'b', status: 'processing' },
      ]),
    };
    const app = new Hono();
    app.route('/api/add-video', createAddVideoRoutes(mockQueue as any));

    const resp = await app.request('/api/add-video/status', {
      headers: { 'Authorization': `Bearer ${makeAddVideoToken()}` },
    });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.jobs).toHaveLength(2);
  });

  it('rejects status request with no auth header', async () => {
    const mockQueue = {
      add: vi.fn(),
      status: vi.fn(() => []),
    };
    const app = new Hono();
    app.route('/api/add-video', createAddVideoRoutes(mockQueue as any));

    const resp = await app.request('/api/add-video/status');
    expect(resp.status).toBe(401);
  });
});

describe('POST /api/add-video/install-token', () => {
  let app: Hono;
  let mockQueue: { add: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };

  function makeShareToken(overrides: Partial<ShareTokenPayload> = {}): string {
    return signShareToken({
      purpose: 'share',
      role: 'edit',
      folder: EDU_FOLDER,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      ...overrides,
    });
  }

  beforeEach(() => {
    mockQueue = {
      add: vi.fn(),
      status: vi.fn(() => []),
    };
    app = new Hono();
    app.route('/api/add-video', createAddVideoRoutes(mockQueue as any));
  });

  it('mints add-video token from valid share token', async () => {
    const shareToken = makeShareToken();
    const resp = await app.request('/api/add-video/install-token', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${shareToken}` },
    });

    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.token).toBeDefined();

    const payload = verifyShareToken(data.token);
    expect(payload).not.toBeNull();
    expect(payload!.purpose).toBe('add-video');
    expect(payload!.role).toBe('edit');
    expect(payload!.folder).toBe(EDU_FOLDER);
  });

  it('mints token from all-folders share token scoped to edu folder', async () => {
    const shareToken = makeShareToken({ folder: '00000000-0000-0000-0000-000000000000' });
    const resp = await app.request('/api/add-video/install-token', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${shareToken}` },
    });

    expect(resp.status).toBe(200);
    const data = await resp.json();
    const payload = verifyShareToken(data.token);
    expect(payload).not.toBeNull();
    expect(payload!.folder).toBe(EDU_FOLDER);
  });

  it('rejects non-edit role', async () => {
    const shareToken = makeShareToken({ role: 'view' });
    const resp = await app.request('/api/add-video/install-token', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${shareToken}` },
    });

    expect(resp.status).toBe(403);
  });

  it('rejects wrong folder', async () => {
    const shareToken = makeShareToken({ folder: LENS_FOLDER });
    const resp = await app.request('/api/add-video/install-token', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${shareToken}` },
    });

    expect(resp.status).toBe(403);
  });

  it('rejects add-video purpose token (must be share)', async () => {
    const addVideoToken = makeAddVideoToken();
    const resp = await app.request('/api/add-video/install-token', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${addVideoToken}` },
    });

    expect(resp.status).toBe(403);
  });

  it('rejects no auth header', async () => {
    const resp = await app.request('/api/add-video/install-token', {
      method: 'POST',
    });

    expect(resp.status).toBe(401);
  });
});
