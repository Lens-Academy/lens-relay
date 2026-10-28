import { Hono, type Context } from 'hono';
import { requireEduShareToken } from '../edit-share-auth.ts';
import { createHistory, groupSessions, repoPath, type Version } from './history.ts';

/**
 * A Lens Edu file's history (src/components/HistoryPanel):
 *
 *   GET /api/history/log?path=Lens Edu/x.md          → {sessions: Session[], asOf: ms}, newest first
 *   GET /api/history/file?path=Lens Edu/x.md&sha=…   → {text}, or 404 if the file did not exist then
 *
 * Read from the promote feature's git copy of lens-edu-staging (HISTORY_REPO_DIR, default
 * PROMOTION_REPO_DIR). This module fetches the public repo itself, at most once a minute, into a
 * ref of its own (HISTORY_REF, default refs/history/staging), so it never touches promotion's refs
 * (whose fetch runs only while an admin has a page open). HISTORY_REMOTE_URL='' reads the ref as
 * it stands. asOf is the ref tip's commit time, so the panel can say how fresh it is. Any Lens Edu
 * link may read it, view links included: the same history is public on GitHub. The middleware
 * also lets all-folders links through, so repoPath() is what keeps the Lens team folder out.
 */

export interface HistorySource {
  log(path: string): Promise<Version[]>;
  show(sha: string, path: string): Promise<string | null>;
  asOf(): Promise<number>;
}

export function historySourceFromEnv(env: NodeJS.ProcessEnv = process.env): HistorySource | null {
  const repoDir = env.HISTORY_REPO_DIR || env.PROMOTION_REPO_DIR;
  if (!repoDir) return null;
  return createHistory({
    repoDir,
    ref: env.HISTORY_REF || 'refs/history/staging',
    remoteUrl: env.HISTORY_REMOTE_URL ?? 'https://github.com/Lens-Academy/lens-edu-staging.git',
    branch: env.HISTORY_BRANCH || 'staging',
  });
}

export function createHistoryRoutes(source: HistorySource | null = historySourceFromEnv()) {
  const app = new Hono();
  app.use('*', async (c, next) => (source ? next() : c.json({ error: 'History is not configured' }, 503)));
  app.use('*', requireEduShareToken({ minRole: 'view' }));
  const outside = (c: Context) => c.json({ error: 'History covers Lens Edu files only' }, 403);

  app.get('/log', async c => {
    const path = repoPath(c.req.query('path') ?? '');
    if (!path) return outside(c);
    const versions = await source!.log(path);
    return c.json({ sessions: groupSessions(versions), asOf: await source!.asOf() });
  });

  app.get('/file', async c => {
    const path = repoPath(c.req.query('path') ?? '');
    if (!path) return outside(c);
    const sha = c.req.query('sha') ?? '';
    if (!/^[0-9a-f]{40}$/.test(sha)) return c.json({ error: 'sha must be a full commit id' }, 400);
    const text = await source!.show(sha, path);
    return text === null ? c.json({ error: 'No such version of this file' }, 404) : c.json({ text });
  });
  return app;
}
