import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { JobQueue } from './queue';
import type { VideoPayload } from './types';
import { verifyShareToken, signShareToken } from '../share-token';
import { checkRelayVideoIds } from './relay-docs';

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

    // Check for existing videos on the relay by video ID
    const editorBase = process.env.EDITOR_BASE_URL || 'https://editor.lensacademy.org';
    const relayFolder = process.env.RELAY_TRANSCRIPT_FOLDER || 'Lens Edu/video_transcripts';

    const videoIds = body.videos.map((v) => v.video_id);
    let foundMap: Record<string, string | null> = {};
    try {
      foundMap = await checkRelayVideoIds(videoIds);
    } catch (err) {
      // If the relay is unreachable, log and proceed (don't block on check failure)
      console.error('Duplicate check failed, proceeding without check:', err);
    }

    // Partition into queued vs already_exists
    const results: Array<{
      video_id: string;
      title: string;
      status: 'queued' | 'already_exists';
      id?: string;
      relay_url: string;
    }> = [];

    for (const video of body.videos) {
      const existingPath = foundMap[video.video_id];
      if (existingPath) {
        results.push({
          video_id: video.video_id,
          title: video.title,
          status: 'already_exists',
          relay_url: `${editorBase}/open/${encodeURI(relayFolder.split('/')[0] + existingPath)}`,
        });
      } else {
        const job = queue.add(video);
        results.push({
          video_id: job.video_id,
          title: job.title,
          status: 'queued',
          id: job.id,
          relay_url: job.relay_url!,
        });
      }
    }

    return c.json({ results, jobs: results });
  });

  router.get('/status', (c) => {
    return c.json({ jobs: queue.status() });
  });

  return router;
}
