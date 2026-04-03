import path from 'path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Extract workspace number from directory name (e.g., "lens-editor-ws2" → 2)
// or parent directory (e.g., "ws2/lens-editor" → 2).
// Used to auto-assign ports: ws1 gets 5173/8090, ws2 gets 5273/8190, etc.
// No workspace suffix → 5173/8090 (default)
const workspaceMatch = path.basename(__dirname).match(/-ws(\d+)$/)
  || path.basename(path.dirname(__dirname)).match(/^ws(\d+)$/);
const wsNum = workspaceMatch ? parseInt(workspaceMatch[1], 10) : 1;
const portOffset = (wsNum - 1) * 100; // ws1=0, ws2=100, ws3=200...
const defaultVitePort = 5173 + portOffset;
const defaultRelayPort = 8090 + portOffset;
const defaultBridgePort = 8091 + portOffset;

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

  console.log(`[vite] Workspace ${wsNum}: Vite port ${defaultVitePort}, Relay port ${relayPort}`);
  console.log(`[vite] Relay target: ${relayTarget}`);
  console.log(`[vite] Discord bridge port ${bridgePort}`);

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
   * Vite plugin that adds /api/add-video endpoints for transcript processing.
   * Dev-only — configureServer only runs in `vite dev`.
   */
  function addVideoPlugin(): Plugin {
    let queue: any = null;

    return {
      name: 'add-video-api',
      configureServer(server) {
        // POST /api/add-video
        server.middlewares.use('/api/add-video', async (req, res) => {
          // Set CORS headers for cross-origin bookmarklet requests
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

          if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
          }

          try {
            // Lazy init queue
            if (!queue) {
              const { JobQueue } = await import('./server/add-video/queue.ts');
              const { processVideo } = await import('./server/add-video/pipeline.ts');
              queue = new JobQueue({ processJob: processVideo });
            }

            // req.url is stripped of the /api/add-video prefix by Vite middleware
            const subPath = req.url || '/';
            console.log(`[add-video] ${req.method} /api/add-video${subPath}`);

            if (req.method === 'GET' && subPath === '/status') {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ jobs: queue.status() }));
              return;
            }

            if (req.method === 'POST' && (subPath === '/' || subPath === '')) {
              const chunks: Buffer[] = [];
              for await (const chunk of req) {
                chunks.push(chunk as Buffer);
              }
              const body = JSON.parse(Buffer.concat(chunks).toString());

              if (!body.videos || !Array.isArray(body.videos) || body.videos.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'videos array is required and must not be empty' }));
                return;
              }

              const jobs = body.videos.map((video: any) => queue.add(video));
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                jobs: jobs.map((j: any) => ({
                  id: j.id,
                  video_id: j.video_id,
                  title: j.title,
                  status: j.status,
                  relay_url: j.relay_url,
                })),
              }));
              return;
            }

            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
          } catch (error: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
          }
        });
      },
    };
  }

  return {
    plugins: [react(), tailwindcss(), basicSsl(), shareTokenAuthPlugin(), addVideoPlugin()],
    server: {
      port: parseInt(process.env.VITE_PORT || String(defaultVitePort), 10),
      host: true,
      allowedHosts: ['dev.vps'],
      proxy: {
        // Proxy API requests to relay-server (adds server token server-side)
        '/api/relay': {
          target: relayTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/relay/, ''),
          secure: !useLocalRelay,
          configure: (proxy) => {
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
