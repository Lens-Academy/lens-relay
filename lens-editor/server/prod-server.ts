import http from 'node:http';
import httpProxy from 'http-proxy';
import { Hono } from 'hono';
import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createAuthHandler, AuthError } from './auth-middleware.ts';
import { validateProxyToken, checkProxyAccess } from './relay-proxy-auth.ts';
import { discordRoutes, initDiscordGateway } from './discord/routes.ts';
import { createAddVideoRoutes } from './add-video/routes.ts';
import { JobQueue } from './add-video/queue.ts';
import { processVideo } from './add-video/pipeline.ts';

const relayUrl = process.env.RELAY_URL || 'http://relay-server:8080';
const relayServerToken = process.env.RELAY_SERVER_TOKEN;
const port = parseInt(process.env.PORT || '3000', 10);

// Reverse proxy for relay-server only (discord is now inline)
const proxy = httpProxy.createProxyServer();
proxy.on('error', (err, _req, res) => {
  console.error('[proxy] Error:', err.message);
  if ('writeHead' in res && typeof (res as http.ServerResponse).writeHead === 'function') {
    const sres = res as http.ServerResponse;
    if (!sres.headersSent) {
      sres.writeHead(502, { 'Content-Type': 'application/json' });
      sres.end(JSON.stringify({ error: 'Bad gateway' }));
    }
  }
});

// Auth handler
const authHandler = createAuthHandler({
  relayServerUrl: relayUrl,
  relayServerToken,
});

// Hono app for auth, discord, and static files
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

// Static files from Vite build output
app.use('/*', serveStatic({ root: './dist' }));
// SPA fallback
app.get('/*', serveStatic({ root: './dist', path: 'index.html' }));

const honoListener = getRequestListener(app.fetch);

// Node HTTP server: relay proxy bypasses Hono, everything else goes through it
const server = http.createServer((req, res) => {
  const url = req.url || '/';

  if (url.startsWith('/api/relay/') || url === '/api/relay') {
    // Validate share token from X-Share-Token header
    const shareToken = req.headers['x-share-token'] as string | undefined;
    const auth = validateProxyToken(shareToken);
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or expired share token' }));
      return;
    }

    // Check folder-scoped access for this endpoint
    const relayPath = url.replace(/^\/api\/relay/, '') || '/';
    const queryIdx = relayPath.indexOf('?');
    const pathOnly = queryIdx >= 0 ? relayPath.slice(0, queryIdx) : relayPath;
    const query = queryIdx >= 0 ? relayPath.slice(queryIdx + 1) : '';
    const access = checkProxyAccess(req.method || 'GET', pathOnly, query, auth);
    if (!access.allowed) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: access.reason || 'Access denied' }));
      return;
    }

    req.url = relayPath;
    if (relayServerToken) {
      req.headers['authorization'] = `Bearer ${relayServerToken}`;
    }
    // Remove share token header before proxying to relay
    delete req.headers['x-share-token'];
    proxy.web(req, res, { target: relayUrl, changeOrigin: true });
  } else if (url.startsWith('/open/')) {
    // Proxy /open/* path-based document resolution to relay-server
    // No share token required — this is a direct browser navigation.
    // The relay server resolves the path to a doc ID; the SPA then
    // uses the user's own share token from localStorage for doc access.
    if (relayServerToken) {
      req.headers['authorization'] = `Bearer ${relayServerToken}`;
    }
    proxy.web(req, res, { target: relayUrl, changeOrigin: true });
  } else {
    honoListener(req, res);
  }
});

// Start Discord Gateway (eager — connects on startup, no-op without DISCORD_BOT_TOKEN)
initDiscordGateway();

server.listen(port, () => {
  console.log(`[lens-editor] Production server on port ${port}`);
});
