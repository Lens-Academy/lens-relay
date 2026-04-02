import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createAddVideoRoutes } from './routes';

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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videos: [
          {
            video_id: 'abc',
            title: 'Test',
            channel: 'Ch',
            url: 'https://youtube.com/watch?v=abc',
            transcript_type: 'word_level',
            transcript_raw: { events: [] },
          },
        ],
      }),
    });

    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.jobs).toHaveLength(1);
    expect(data.jobs[0].id).toBe('job1');
    expect(data.jobs[0].status).toBe('queued');
    expect(data.jobs[0].relay_url).toBeDefined();
  });

  it('rejects empty videos array', async () => {
    const resp = await app.request('/api/add-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videos: [] }),
    });

    expect(resp.status).toBe(400);
  });

  it('rejects missing videos field', async () => {
    const resp = await app.request('/api/add-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

    const resp = await app.request('/api/add-video/status');
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.jobs).toHaveLength(2);
  });
});
