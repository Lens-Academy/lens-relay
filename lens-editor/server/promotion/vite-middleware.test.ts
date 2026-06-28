import { afterEach, describe, expect, it } from 'vitest';
import http, { type Server } from 'node:http';
import path from 'node:path';
import { createServer, type ViteDevServer } from 'vite';

const originalPromotionEnabled = process.env.PROMOTION_ENABLED;
const originalPromotionProductionRepoUrl = process.env.PROMOTION_PRODUCTION_REPO_URL;

let server: ViteDevServer | null = null;
let httpServer: Server | null = null;

describe('Vite promotion API middleware', () => {
  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    if (httpServer) {
      await new Promise<void>((resolve, reject) => {
        httpServer?.close(error => error ? reject(error) : resolve());
      });
      httpServer = null;
    }
    if (originalPromotionEnabled === undefined) {
      delete process.env.PROMOTION_ENABLED;
    } else {
      process.env.PROMOTION_ENABLED = originalPromotionEnabled;
    }
    if (originalPromotionProductionRepoUrl === undefined) {
      delete process.env.PROMOTION_PRODUCTION_REPO_URL;
    } else {
      process.env.PROMOTION_PRODUCTION_REPO_URL = originalPromotionProductionRepoUrl;
    }
  });

  it('returns promotion JSON instead of the SPA fallback when promotion is disabled', async () => {
    process.env.PROMOTION_ENABLED = 'false';
    server = await createServer({
      configFile: path.resolve(import.meta.dirname, '../../vite.config.ts'),
      server: { middlewareMode: true },
    });
    httpServer = http.createServer(server.middlewares);
    await new Promise<void>(resolve => httpServer?.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('HTTP server did not bind to a port');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/promotion/changes`, {
      headers: { Accept: 'application/json' },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual({ error: 'Promotion is disabled' });
  });

  it('returns promotion JSON when promotion is enabled but not fully configured', async () => {
    process.env.PROMOTION_ENABLED = 'true';
    process.env.PROMOTION_PRODUCTION_REPO_URL = 'git@example.com:Lens-Academy/lens-edu-production.git';
    server = await createServer({
      configFile: path.resolve(import.meta.dirname, '../../vite.config.ts'),
      server: { middlewareMode: true },
    });
    httpServer = http.createServer(server.middlewares);
    await new Promise<void>(resolve => httpServer?.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('HTTP server did not bind to a port');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/promotion/changes`, {
      headers: { Accept: 'application/json' },
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual({ error: 'Promotion is enabled but not fully configured' });
  });
});
