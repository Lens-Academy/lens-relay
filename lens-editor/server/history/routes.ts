import { Hono, type Context } from 'hono';
import { requireEduShareToken } from '../edit-share-auth.ts';
import { createHistory, groupSessions, repoPath, type Version } from './history.ts';

/**
 * A Lens Edu file's history (src/components/HistoryPanel):
 *
 *   GET /api/history/log?path=Lens Edu/x.md          → {sessions: Session[]}, newest first
 *   GET /api/history/file?path=Lens Edu/x.md&sha=…   → {text}, or 404 if the file did not exist then
 *
 * Read from the promote feature's git copy of lens-edu-staging (HISTORY_REPO_DIR, default
 * PROMOTION_REPO_DIR), whose staging ref the promote status poll keeps fetched. Any Lens Edu
 * link may read it, view links included: the same history is public on GitHub. The middleware
 * also lets all-folders links through, so repoPath() is what keeps the Lens team folder out.
 */

export interface HistorySource {
  log(path: string): Promise<Version[]>;
  show(sha: string, path: string): Promise<string | null>;
}

export function historySourceFromEnv(env: NodeJS.ProcessEnv = process.env): HistorySource | null {
  const repoDir = env.HISTORY_REPO_DIR || env.PROMOTION_REPO_DIR;
  if (!repoDir) return null;
  return createHistory({ repoDir, ref: env.HISTORY_REF || 'refs/remotes/staging/staging' });
}

export function createHistoryRoutes(source: HistorySource | null = historySourceFromEnv()) {
  const app = new Hono();
  app.use('*', async (c, next) => (source ? next() : c.json({ error: 'History is not configured' }, 503)));
  app.use('*', requireEduShareToken({ minRole: 'view' }));
  const outside = (c: Context) => c.json({ error: 'History covers Lens Edu files only' }, 403);

  app.get('/log', async c => {
    const path = repoPath(c.req.query('path') ?? '');
    if (!path) return outside(c);
    return c.json({ sessions: groupSessions(await source!.log(path)) });
  });

  app.get('/file', async c => {
    const path = repoPath(c.req.query('path') ?? '');
    if (!path) return outside(c);
    const sha = c.req.query('sha') ?? '';
    if (!/^[0-9a-f]{40}$/.test(sha)) return c.json({ error: 'sha must be a full commit id' }, 400);
    const text = await source!.show(sha, path);
    return text === null ? c.json({ error: 'The file did not exist at that version' }, 404) : c.json({ text });
  });
  return app;
}
