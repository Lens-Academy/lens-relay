import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { createAuthHandler, AuthError } from './auth-middleware.ts';
import { discordRoutes } from './discord/routes.ts';
import { createAddVideoRoutes } from './add-video/routes.ts';
import { JobQueue } from './add-video/queue.ts';
import { processVideo } from './add-video/pipeline.ts';
import { createAddArticleRoutes } from './add-article/routes.ts';
import { ArticleJobQueue } from './add-article/queue.ts';
import { processArticle } from './add-article/pipeline.ts';
import { loadPromotionConfig, promotionConfigReady } from './promotion/config.ts';
import { createGitPromotionService } from './promotion/git.ts';
import { createGitHubPromotionService } from './promotion/github.ts';
import { validatePromotionPaths } from './promotion/path-validation.ts';
import { createPromotionRoutes, type PromotionRouteService } from './promotion/routes.ts';
import type {
  PromotionChangesResponse,
  PromotionPrResponse,
} from './promotion/types.ts';

export interface AppConfig {
  relayUrl: string;
  relayServerToken?: string;
}

interface PromotionGitService {
  getChanges(): Promise<PromotionChangesResponse>;
  getStatus(path: string): Promise<unknown>;
  getDiff(path: string): Promise<unknown>;
  createPromotionBranch(input: { paths: string[] }): Promise<{
    branch: string;
    mainSha: string;
    sourceStagingSha: string;
  }>;
}

interface PromotionGitHubService {
  createPullRequest(input: {
    branch: string;
    mainSha: string;
    sourceStagingSha: string;
    paths: string[];
    title?: string;
  }): Promise<PromotionPrResponse>;
}

export function createPromotionRouteService(
  gitPromotion: PromotionGitService,
  githubPromotion: PromotionGitHubService,
): PromotionRouteService {
  return {
    getChanges: () => gitPromotion.getChanges(),
    getStatus: path => gitPromotion.getStatus(path),
    getDiff: path => gitPromotion.getDiff(path),
    async createPromotionPr(input) {
      const changes = await gitPromotion.getChanges();
      const paths = validatePromotionPaths(input.paths, changes.files);
      const branch = await gitPromotion.createPromotionBranch({ paths });
      return githubPromotion.createPullRequest({
        branch: branch.branch,
        mainSha: branch.mainSha,
        sourceStagingSha: branch.sourceStagingSha,
        paths,
        ...(input.title !== undefined ? { title: input.title } : {}),
      });
    },
  };
}

/**
 * Build the production Hono app: auth, discord, add-video, add-article, blob
 * proxies, and static files. Extracted from prod-server.ts so integration
 * tests can exercise the real production route composition without starting
 * the HTTP server / relay proxy.
 */
export function createApp(config: AppConfig): Hono {
  const authHandler = createAuthHandler({
    relayServerUrl: config.relayUrl,
    relayServerToken: config.relayServerToken,
  });

  const app = new Hono();

  app.post('/api/auth/token', async (c) => {
    try {
      const body = await c.req.json();
      const result = await authHandler(body);
      return c.json(result);
    } catch (error) {
      if (error instanceof AuthError) {
        return c.json({ error: error.message }, error.status as 400);
      }
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // Mount discord routes under /api/discord
  app.route('/api/discord', discordRoutes);

  // Add video transcript pipeline
  const addVideoQueue = new JobQueue({ processJob: processVideo });
  app.route('/api/add-video', createAddVideoRoutes(addVideoQueue));

  // Add article import pipeline
  const addArticleQueue = new ArticleJobQueue({ processJob: processArticle });
  app.route('/api/add-article', createAddArticleRoutes(addArticleQueue));

  // Blob content proxy — fetches presigned R2 URLs server-side to avoid CORS
  app.get('/api/blob-fetch', async (c) => {
    const url = c.req.query('url');
    if (!url) return c.json({ error: 'url parameter required' }, 400);
    try {
      const resp = await fetch(url);
      if (!resp.ok) return c.text(`Upstream error: ${resp.status}`, 502);
      const contentType = resp.headers.get('content-type') ?? 'application/octet-stream';
      const body = await resp.arrayBuffer();
      return c.body(body, 200, { 'Content-Type': contentType });
    } catch (err) {
      return c.text(`Fetch failed: ${err}`, 502);
    }
  });

  // Blob upload proxy — PUTs to presigned R2 URLs server-side to avoid CORS
  app.post('/api/blob-upload', async (c) => {
    const url = c.req.query('url');
    if (!url) return c.json({ error: 'url parameter required' }, 400);
    let parsed: URL;
    try { parsed = new URL(url); } catch { return c.json({ error: 'invalid url' }, 400); }
    if (!parsed.hostname.endsWith('.r2.cloudflarestorage.com'))
      return c.json({ error: 'url not allowed' }, 400);
    const body = await c.req.arrayBuffer();
    const contentType = c.req.header('content-type') ?? 'application/octet-stream';
    try {
      const resp = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': contentType, 'Content-Length': String(body.byteLength) },
        body,
      });
      if (!resp.ok) return c.text(`Upstream error: ${resp.status}`, 502);
      return c.text('', 200);
    } catch (err) {
      return c.text(`Upload failed: ${err}`, 502);
    }
  });

  const promotionConfig = loadPromotionConfig();
  if (!promotionConfig.enabled) {
    app.all('/api/promotion/*', c => c.json({ error: 'Promotion is disabled' }, 404));
  } else if (!promotionConfigReady(promotionConfig)) {
    app.all('/api/promotion/*', c => c.json({ error: 'Promotion is enabled but not fully configured' }, 503));
  } else {
    const gitPromotion = createGitPromotionService(promotionConfig);
    const githubPromotion = createGitHubPromotionService(promotionConfig);
    app.route('/api/promotion', createPromotionRoutes(createPromotionRouteService(gitPromotion, githubPromotion)));
  }

  // Static files from Vite build output
  app.use('/*', serveStatic({ root: './dist' }));
  // SPA fallback
  app.get('/*', serveStatic({ root: './dist', path: 'index.html' }));

  return app;
}
