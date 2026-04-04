import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { JobQueue } from './queue';
import type { VideoPayload } from './types';
import { verifyShareToken, signShareToken } from '../share-token';

const EDU_FOLDER = 'ea4015da-24af-4d9d-ac49-8c902cb17121';
const ALL_FOLDERS = '00000000-0000-0000-0000-000000000000';

export function createAddVideoRoutes(queue: JobQueue): Hono {
  const router = new Hono();

  // CORS: bookmarklet runs on youtube.com and POSTs cross-origin
  router.use('/*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }));

  // install-token: exchanges a share-purpose token for an add-video token
  // Registered BEFORE the add-video auth middleware so it uses different auth rules
  router.post('/install-token', async (c) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Authorization header required' }, 401);
    }
    const payload = verifyShareToken(authHeader.slice(7));
    if (!payload) {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }
    if (payload.purpose !== 'share') {
      return c.json({ error: 'Share token required' }, 403);
    }
    if (payload.role !== 'edit') {
      return c.json({ error: 'Edit access required' }, 403);
    }
    if (payload.folder !== EDU_FOLDER && payload.folder !== ALL_FOLDERS) {
      return c.json({ error: 'Access denied: wrong folder scope' }, 403);
    }

    const addVideoToken = signShareToken({
      purpose: 'add-video',
      role: 'edit',
      folder: EDU_FOLDER,
      expiry: payload.expiry,
    });

    return c.json({ token: addVideoToken });
  });

  // Auth middleware for add-video routes (skips /install-token)
  router.use('/*', async (c, next) => {
    if (c.req.path.endsWith('/install-token')) {
      return next();
    }

    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Authorization header required' }, 401);
    }

    const payload = verifyShareToken(authHeader.slice(7));
    if (!payload) {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }

    if (payload.purpose !== 'add-video') {
      return c.json({ error: 'Add-video token required' }, 403);
    }

    if (payload.role !== 'edit') {
      return c.json({ error: 'Edit access required' }, 403);
    }

    if (payload.folder !== EDU_FOLDER && payload.folder !== ALL_FOLDERS) {
      return c.json({ error: 'Access denied: wrong folder scope' }, 403);
    }

    return next();
  });

  router.post('/', async (c) => {
    const body = await c.req.json<{ videos?: VideoPayload[] }>();

    if (!body.videos || !Array.isArray(body.videos) || body.videos.length === 0) {
      return c.json({ error: 'videos array is required and must not be empty' }, 400);
    }

    // Validate each video payload
    for (const video of body.videos) {
      if (!video.video_id || !video.title || !video.channel || !video.url) {
        return c.json({ error: 'Each video must have video_id, title, channel, and url' }, 400);
      }
      if (video.transcript_type !== 'word_level' && video.transcript_type !== 'sentence_level') {
        return c.json({ error: 'transcript_type must be "word_level" or "sentence_level"' }, 400);
      }
      if (!video.transcript_raw?.events || !Array.isArray(video.transcript_raw.events)) {
        return c.json({ error: 'transcript_raw must have an events array' }, 400);
      }
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
