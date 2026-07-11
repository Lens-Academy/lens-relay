import path from 'path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import type { ServerResponse } from 'node:http';
import type { Hono } from 'hono';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { bridgeBundlePlugin } from './vite-plugin-bridge-bundle';
import { getWorkspacePortsFromPaths } from './server/workspace-ports.mjs';

// Extract workspace number from directory name (e.g., "lens-editor-ws2" → 2)
// or parent directory (e.g., "ws2/lens-editor" → 2).
// Used to auto-assign ports: ws1 gets 5173/8090, ws2 gets 5273/8190, etc.
// No workspace suffix → 5173/8090 (default)
const workspacePorts = getWorkspacePortsFromPaths(
  path.basename(__dirname),
  path.basename(path.dirname(__dirname)),
);
const defaultVitePort = workspacePorts.vite;
const defaultRelayPort = workspacePorts.relay;
const defaultBridgePort = workspacePorts.discordBridge;

// https://vite.dev/config/
export default defineConfig(() => {
  // Use local relay-server when VITE_LOCAL_RELAY is set
  const useLocalRelay = process.env.VITE_LOCAL_RELAY === 'true';
  const relayPort = parseInt(process.env.RELAY_PORT || String(defaultRelayPort), 10);
  const relayTarget = useLocalRelay
    ? `http://localhost:${relayPort}`
    : 'https://relay.lensacademy.org';

  const bridgePort = parseInt(process.env.DISCORD_BRIDGE_PORT || String(defaultBridgePort), 10);

  // Server token for minting relay doc tokens (optional for local relay)
  const relayServerToken = process.env.RELAY_SERVER_TOKEN;

  // The add-video / add-article pipelines run in-process in the dev plugins and
  // read RELAY_URL / EDITOR_BASE_URL from the environment. Their defaults point
  // at the production docker network, so in local mode we redirect them at the
  // local relay and dev server — otherwise imports would never reach the relay.
  if (useLocalRelay) {
    // The dev server runs over HTTPS (basicSsl), so EDITOR_BASE_URL must be
    // https too — otherwise the relay_url links in the import UI point at a
    // dead http origin. Honour VITE_PORT if the dev server is on a custom port.
    const vitePort = parseInt(process.env.VITE_PORT || String(defaultVitePort), 10);
    process.env.RELAY_URL ??= `http://localhost:${relayPort}`;
    process.env.EDITOR_BASE_URL ??= `https://localhost:${vitePort}`;
  }

  console.log(`[vite] Workspace ${workspacePorts.workspace.label}: Vite port ${defaultVitePort}, Relay port ${relayPort}`);
  console.log(`[vite] Relay target: ${relayTarget}`);
  console.log(`[vite] Discord bridge port ${bridgePort}`);

  /**
   * Vite plugin that validates share tokens on /api/relay/ proxy requests.
   * Ensures browser requests carry a valid X-Share-Token before being forwarded
   * to the relay server with the injected server auth token.
   */
  function relayProxyAuthPlugin(): Plugin {
    async function resolveFolderName(folderUuid: string): Promise<string | undefined> {
      const headers: Record<string, string> = {};
      if (relayServerToken) {
        headers.Authorization = `Bearer ${relayServerToken}`;
      }
      const res = await fetch(`${relayTarget}/folder/${encodeURIComponent(folderUuid)}/name`, { headers });
      if (!res.ok) return undefined;
      const data = await res.json() as { name?: string };
      return data.name;
    }

    return {
      name: 'relay-proxy-auth',
      configureServer(server) {
        // Validate share token on /api/relay/ proxy requests
        server.middlewares.use('/api/relay', async (req, res, next) => {
          const { validateProxyToken, checkProxyAccessWithBody } = await import('./server/relay-proxy-auth.ts');

          const shareToken = req.headers['x-share-token'] as string | undefined;
          const auth = validateProxyToken(shareToken);
          if (!auth) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid or expired share token' }));
            return;
          }

          const fullUrl = req.url || '/';
          const queryIdx = fullUrl.indexOf('?');
          const pathOnly = queryIdx >= 0 ? fullUrl.slice(0, queryIdx) : fullUrl;
          const query = queryIdx >= 0 ? fullUrl.slice(queryIdx + 1) : '';
          let parsedBody: unknown = undefined;
          if ((req.method || 'GET') === 'POST' && pathOnly === '/move') {
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            const rawBody = Buffer.concat(chunks);
            (req as any).relayProxyBody = rawBody;
            try {
              parsedBody = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : undefined;
            } catch {
              parsedBody = undefined;
            }
          }

          const allowedFolderName = !auth.isAllFolders && (req.method || 'GET') === 'POST' && pathOnly === '/move'
            ? await resolveFolderName(auth.payload.folder)
            : undefined;
          const access = checkProxyAccessWithBody(req.method || 'GET', pathOnly, query, auth, parsedBody, allowedFolderName);
          if (!access.allowed) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: access.reason || 'Access denied' }));
            return;
          }

          delete req.headers['x-share-token'];
          next();
        });

        // Validate share token on /open/ proxy requests (path-based document resolution)
        server.middlewares.use('/open', async (req, res, next) => {
          const { validateProxyToken } = await import('./server/relay-proxy-auth.ts');

          const shareToken = req.headers['x-share-token'] as string | undefined;
          const auth = validateProxyToken(shareToken);
          if (!auth) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid or expired share token' }));
            return;
          }

          delete req.headers['x-share-token'];
          next();
        });
      },
    };
  }

  /**
   * Vite plugin that adds /api/auth/token endpoint for share token validation.
   * This is dev-only — configureServer only runs in `vite dev`, not production builds.
   */
  function shareTokenAuthPlugin(): Plugin {
    return {
      name: 'share-token-auth',
      configureServer(server) {
        server.middlewares.use('/api/auth/token', async (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
          }

          // Read request body
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk as Buffer);
          }
          const body = JSON.parse(Buffer.concat(chunks).toString());

          try {
            // Dynamic import to avoid loading server modules at config time
            const { createAuthHandler } = await import('./server/auth-middleware.ts');
            const handler = createAuthHandler({
              relayServerUrl: relayTarget,
              relayServerToken: relayServerToken,
            });
            const result = await handler(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (error: any) {
            const status = error.status || 500;
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
          }
        });
      },
    };
  }

  /**
   * Dev-only helper: serve a prod Hono router at a middleware path, built
   * lazily on first request so server-only deps load on demand. Mounting the
   * real router keeps dev behavior (auth, CORS, validation) in sync with
   * prod by construction. `beforeRequest` may respond early (config gating);
   * returning true stops the request.
   */
  function honoDevPlugin(opts: {
    name: string;
    path: string;
    loadApp: () => Promise<Hono>;
    beforeRequest?: (res: ServerResponse) => Promise<boolean>;
  }): Plugin {
    let listener: ReturnType<typeof import('@hono/node-server').getRequestListener> | null = null;

    return {
      name: opts.name,
      configureServer(server) {
        server.middlewares.use(opts.path, async (req, res) => {
          try {
            if (opts.beforeRequest && await opts.beforeRequest(res)) return;
            if (!listener) {
              const { getRequestListener } = await import('@hono/node-server');
              listener = getRequestListener((await opts.loadApp()).fetch);
            }
            console.log(`[${opts.name}] ${req.method} ${opts.path}${req.url || '/'}`);
            await listener(req, res);
          } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
          }
        });
      },
    };
  }

  /** Dev /api/add-video endpoints for transcript processing. */
  function addVideoPlugin(): Plugin {
    return honoDevPlugin({
      name: 'add-video-api',
      path: '/api/add-video',
      loadApp: async () => {
        const { createAddVideoRoutes } = await import('./server/add-video/routes.ts');
        const { JobQueue } = await import('./server/add-video/queue.ts');
        const { processVideo } = await import('./server/add-video/pipeline.ts');
        return createAddVideoRoutes(new JobQueue({ processJob: processVideo }));
      },
    });
  }

  /** Dev /api/add-article endpoints for article importing. */
  function addArticlePlugin(): Plugin {
    return honoDevPlugin({
      name: 'add-article-api',
      path: '/api/add-article',
      loadApp: async () => {
        const { createAddArticleRoutes } = await import('./server/add-article/routes.ts');
        const { ArticleJobQueue } = await import('./server/add-article/queue.ts');
        const { processArticle } = await import('./server/add-article/pipeline.ts');
        return createAddArticleRoutes(new ArticleJobQueue({ processJob: processArticle }));
      },
    });
  }

  /**
   * Dev /api/promotion endpoints, so the editor does not hit Vite's SPA
   * fallback for promotion API calls. Config is re-checked per request
   * (matching the prod server's gating) before the router is consulted.
   */
  function promotionPlugin(): Plugin {
    return honoDevPlugin({
      name: 'promotion-api',
      path: '/api/promotion',
      beforeRequest: async (res) => {
        const { loadPromotionConfig, promotionConfigReady } = await import('./server/promotion/config.ts');
        const promotionConfig = loadPromotionConfig();
        if (!promotionConfig.enabled) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Promotion is disabled' }));
          return true;
        }
        if (!promotionConfigReady(promotionConfig)) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Promotion is enabled but not fully configured' }));
          return true;
        }
        return false;
      },
      loadApp: async () => {
        const { loadPromotionConfig } = await import('./server/promotion/config.ts');
        const { createGitPromotionService } = await import('./server/promotion/git.ts');
        const { createGitHubPromotionService } = await import('./server/promotion/github.ts');
        const { createPromotionRoutes } = await import('./server/promotion/routes.ts');
        const { createPromotionRouteService } = await import('./server/app.ts');
        const promotionConfig = loadPromotionConfig();
        const gitPromotion = createGitPromotionService(promotionConfig);
        const githubPromotion = createGitHubPromotionService(promotionConfig);
        return createPromotionRoutes(createPromotionRouteService(gitPromotion, githubPromotion));
      },
    });
  }

  /**
   * Dev-only plugin to proxy blob downloads from presigned R2 URLs server-side,
   * mirroring the prod-server /api/blob-fetch endpoint. Needed for dev:local:r2.
   */
  function blobFetchPlugin(): Plugin {
    return {
      name: 'blob-fetch',
      configureServer(server) {
        server.middlewares.use('/api/blob-fetch', async (req, res) => {
          if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
          const urlParam = new URL(req.url || '', 'http://localhost').searchParams.get('url');
          if (!urlParam) { res.writeHead(400); res.end('url required'); return; }
          let parsed: URL;
          try { parsed = new URL(urlParam); } catch { res.writeHead(400); res.end('invalid url'); return; }
          if (!parsed.hostname.endsWith('.r2.cloudflarestorage.com')) {
            res.writeHead(400); res.end('url not allowed'); return;
          }
          try {
            const resp = await fetch(urlParam);
            if (!resp.ok) { res.writeHead(502); res.end(`Upstream error: ${resp.status}`); return; }
            const contentType = resp.headers.get('content-type') ?? 'application/octet-stream';
            const body = Buffer.from(await resp.arrayBuffer());
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(body);
          } catch (err) {
            res.writeHead(502);
            res.end(`Fetch failed: ${err}`);
          }
        });
      },
    };
  }

  /**
   * Dev-only plugin to proxy blob uploads to presigned R2 URLs server-side,
   * avoiding CORS when the relay returns an absolute R2 upload URL.
   */
  function blobUploadPlugin(): Plugin {
    return {
      name: 'blob-upload',
      configureServer(server) {
        server.middlewares.use('/api/blob-upload', async (req, res) => {
          if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
          const urlParam = new URL(req.url || '', 'http://localhost').searchParams.get('url');
          if (!urlParam) { res.writeHead(400); res.end('url required'); return; }
          let parsed: URL;
          try { parsed = new URL(urlParam); } catch { res.writeHead(400); res.end('invalid url'); return; }
          if (!parsed.hostname.endsWith('.r2.cloudflarestorage.com')) {
            res.writeHead(400); res.end('url not allowed'); return;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = Buffer.concat(chunks);
          const contentType = req.headers['content-type'] ?? 'application/octet-stream';
          try {
            const resp = await fetch(urlParam, {
              method: 'PUT',
              headers: { 'Content-Type': contentType, 'Content-Length': String(body.byteLength) },
              body,
            });
            res.writeHead(resp.ok ? 200 : 502);
            res.end(resp.ok ? '' : `Upstream error: ${resp.status}`);
          } catch (err) {
            res.writeHead(502);
            res.end(`Upload failed: ${err}`);
          }
        });
      },
    };
  }

  /**
   * Dev-only plugin to serve blob files directly from the filesystem store.
   * In production, blobs are served via presigned R2 URLs. In local dev with
   * a filesystem store, we serve them directly to avoid auth complexity.
   */
  function blobServePlugin(): Plugin {
    const storePath = '/tmp/lens-relay-local-store';
    return {
      name: 'blob-serve',
      configureServer(server) {
        // GET /api/blob/:docId/:hash → read from filesystem store
        server.middlewares.use('/api/blob/', async (req, res) => {
          if (req.method !== 'GET') {
            res.writeHead(405);
            res.end();
            return;
          }
          const { readFile } = await import('fs/promises');
          // URL is /api/blob/{docId}/{hash}
          const parts = (req.url || '').split('/').filter(Boolean);
          if (parts.length < 2) {
            res.writeHead(400);
            res.end('Missing docId/hash');
            return;
          }
          const docId = parts[0];
          const hash = parts[1].split('?')[0]; // strip query params
          const filePath = path.join(storePath, 'files', docId, hash);
          try {
            const data = await readFile(filePath);
            res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
            res.end(data);
          } catch {
            res.writeHead(404);
            res.end('Blob not found');
          }
        });
      },
    };
  }

  return {
    plugins: [react(), tailwindcss(), basicSsl(), bridgeBundlePlugin(), relayProxyAuthPlugin(), shareTokenAuthPlugin(), addVideoPlugin(), addArticlePlugin(), promotionPlugin(), blobFetchPlugin(), blobUploadPlugin(), ...(useLocalRelay ? [blobServePlugin()] : [])],
    server: {
      port: parseInt(process.env.VITE_PORT || String(defaultVitePort), 10),
      host: true,
      allowedHosts: ['dev.vps', '.walrus-bitterling.ts.net'],
      proxy: {
        // Proxy API requests to relay-server (adds server token server-side)
        '/api/relay': {
          target: relayTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/relay/, ''),
          secure: !useLocalRelay,
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq, req) => {
              const rawBody = (req as any).relayProxyBody as Buffer | undefined;
              if (rawBody) {
                proxyReq.setHeader('Content-Length', String(rawBody.length));
                proxyReq.write(rawBody);
              }
            });
            if (relayServerToken) {
              proxy.on('proxyReq', (proxyReq) => {
                proxyReq.setHeader('Authorization', `Bearer ${relayServerToken}`);
              });
            }
          },
        },
        // Proxy WebSocket connections to relay-server
        '/ws/relay': {
          target: relayTarget,
          changeOrigin: true,
          ws: true,
          rewrite: (path) => path.replace(/^\/ws\/relay/, ''),
          secure: !useLocalRelay,
        },
        // Proxy /open/* path-based document resolution to relay-server
        '/open': {
          target: relayTarget,
          changeOrigin: true,
          secure: !useLocalRelay,
          configure: (proxy) => {
            if (relayServerToken) {
              proxy.on('proxyReq', (proxyReq) => {
                proxyReq.setHeader('Authorization', `Bearer ${relayServerToken}`);
              });
            }
          },
        },
        // Proxy Discord bridge requests to sidecar
        '/api/discord': {
          target: `http://localhost:${bridgePort}`,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/discord/, '/api'),
        },
      },
    },
  };
});
