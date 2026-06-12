import http from 'node:http';
import { Readable } from 'node:stream';
import httpProxy from 'http-proxy';
import { getRequestListener } from '@hono/node-server';
import { validateProxyToken, checkProxyAccessWithBody } from './relay-proxy-auth.ts';
import { initDiscordGateway } from './discord/routes.ts';
import { createApp } from './app.ts';

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

async function resolveFolderName(folderUuid: string): Promise<string | undefined> {
  const headers: Record<string, string> = {};
  if (relayServerToken) {
    headers.Authorization = `Bearer ${relayServerToken}`;
  }
  const res = await fetch(`${relayUrl}/folder/${encodeURIComponent(folderUuid)}/name`, { headers });
  if (!res.ok) return undefined;
  const data = await res.json() as { name?: string };
  return data.name;
}

// Hono app for auth, discord, import pipelines, and static files
const app = createApp({ relayUrl, relayServerToken });

const honoListener = getRequestListener(app.fetch);

// Node HTTP server: relay proxy bypasses Hono, everything else goes through it
const server = http.createServer(async (req, res) => {
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
    let parsedBody: unknown = undefined;
    let rawBody: Buffer | undefined;
    if ((req.method || 'GET') === 'POST' && pathOnly === '/move') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      rawBody = Buffer.concat(chunks);
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

    req.url = relayPath;
    if (relayServerToken) {
      req.headers['authorization'] = `Bearer ${relayServerToken}`;
    }
    // Remove share token header before proxying to relay
    delete req.headers['x-share-token'];
    proxy.web(req, res, {
      target: relayUrl,
      changeOrigin: true,
      ...(rawBody ? { buffer: Readable.from([rawBody]) } : {}),
    });
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
