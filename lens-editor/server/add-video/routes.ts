import { Hono } from 'hono';
import type { JobQueue } from './queue';
import type { VideoPayload } from './types';

export function createAddVideoRoutes(queue: JobQueue): Hono {
  const router = new Hono();

  router.post('/', async (c) => {
    const body = await c.req.json<{ videos?: VideoPayload[] }>();

    if (!body.videos || !Array.isArray(body.videos) || body.videos.length === 0) {
      return c.json({ error: 'videos array is required and must not be empty' }, 400);
    }

    const jobs = body.videos.map((video) => queue.add(video));

    return c.json({
      jobs: jobs.map((j) => ({
        id: j.id,
        video_id: j.video_id,
        title: j.title,
        status: j.status,
        relay_url: j.relay_url,
      })),
    });
  });

  router.get('/status', (c) => {
    return c.json({ jobs: queue.status() });
  });

  return router;
}
