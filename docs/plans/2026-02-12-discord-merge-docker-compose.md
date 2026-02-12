# Discord Bridge Merge & Production Docker Compose

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Merge the discord-bridge sidecar into lens-editor's backend and add a production docker-compose file, reducing production containers from 5 to 4.

**Architecture:** Move the 4 discord-bridge source files into `lens-editor/server/discord/`, mount the Hono routes directly on the prod-server instead of reverse-proxying to a separate container, and add `discord.js` as a lens-editor dependency. Then create `docker-compose.prod.yaml` at the repo root to replace the manual `docker run` commands documented in `docs/server-ops.md`.

**Tech Stack:** Node.js, Hono, discord.js, Docker Compose

---

### Task 1: Add discord.js dependency to lens-editor

**Files:**
- Modify: `lens-editor/package.json`

**Step 1: Install discord.js**

Run: `cd /home/penguin/code/lens-relay/ws3/lens-editor && npm install discord.js@^14.25.1`

**Step 2: Verify installation**

Run: `cd /home/penguin/code/lens-relay/ws3/lens-editor && node -e "require('discord.js')"`
Expected: No error

**Step 3: Commit**

```bash
jj new -m "feat: add discord.js dependency to lens-editor"
```

---

### Task 2: Move discord-bridge source files into lens-editor

**Files:**
- Create: `lens-editor/server/discord/types.ts` (from `discord-bridge/src/types.ts`)
- Create: `lens-editor/server/discord/discord-client.ts` (from `discord-bridge/src/discord-client.ts`)
- Create: `lens-editor/server/discord/gateway.ts` (from `discord-bridge/src/gateway.ts`)
- Create: `lens-editor/server/discord/routes.ts` (new — extracted route definitions from `discord-bridge/src/index.ts`)

The key change: `discord-bridge/src/index.ts` mixes route definitions with server startup (`serve()`). We split it: route definitions go into `routes.ts` as a Hono sub-app, server startup stays in `prod-server.ts`.

**Step 1: Copy types.ts verbatim**

Copy `discord-bridge/src/types.ts` → `lens-editor/server/discord/types.ts`. No changes needed.

**Step 2: Copy discord-client.ts, fix imports**

Copy `discord-bridge/src/discord-client.ts` → `lens-editor/server/discord/discord-client.ts`.

Change the import on line 1:
```typescript
// Before:
import type { DiscordMessage, DiscordChannel } from './types.js';
// After:
import type { DiscordMessage, DiscordChannel } from './types.ts';
```

The lens-editor server files use `.ts` extensions (see `prod-server.ts:6` importing `./auth-middleware.ts`), while discord-bridge used `.js` extensions. Update all relative imports in this file to use `.ts`.

Also remove the dead variable on line 157:
```typescript
// Delete this line:
const botTokenId = getToken(); // used to identify our bot
```
This variable is assigned but never used.

**Step 3: Copy gateway.ts, no changes needed**

Copy `discord-bridge/src/gateway.ts` → `lens-editor/server/discord/gateway.ts`. No import changes needed (it only imports from `discord.js` and `events`).

**Step 4: Create routes.ts — extract routes from index.ts as a Hono sub-app**

Create `lens-editor/server/discord/routes.ts`:

```typescript
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { streamSSE } from 'hono/streaming';
import {
  fetchChannelMessages,
  fetchChannelInfo,
  sendWebhookMessage,
  RateLimitError,
  DiscordApiError,
} from './discord-client.ts';
import {
  startGateway,
  getGatewayStatus,
  gatewayEvents,
} from './gateway.ts';

export const discordRoutes = new Hono();

// Logging + CORS for all discord routes
discordRoutes.use('*', logger());
discordRoutes.use('*', cors());

// SSE endpoint: stream Gateway events for a specific channel
discordRoutes.get('/channels/:channelId/events', async (c) => {
  const { channelId } = c.req.param();

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: 'status',
      data: JSON.stringify({ gateway: getGatewayStatus() }),
    });

    const handler = async (message: unknown) => {
      try {
        await stream.writeSSE({
          event: 'message',
          data: JSON.stringify(message),
          id: (message as { id: string }).id,
        });
      } catch {
        // Client disconnected
      }
    };

    gatewayEvents.on(`message:${channelId}`, handler);

    const statusHandler = async (data: unknown) => {
      try {
        await stream.writeSSE({
          event: 'status',
          data: JSON.stringify(data),
        });
      } catch {
        // Client disconnected
      }
    };
    gatewayEvents.on('status', statusHandler);

    stream.onAbort(() => {
      gatewayEvents.off(`message:${channelId}`, handler);
      gatewayEvents.off('status', statusHandler);
    });

    while (true) {
      await stream.writeSSE({ event: 'heartbeat', data: '' });
      await stream.sleep(30000);
    }
  });
});

// Gateway status endpoint
discordRoutes.get('/gateway/status', (c) => {
  return c.json({ status: getGatewayStatus() });
});

// GET /channels/:channelId/messages
discordRoutes.get('/channels/:channelId/messages', async (c) => {
  const { channelId } = c.req.param();
  const limitParam = c.req.query('limit') || '50';
  const limit = Math.min(Math.max(parseInt(limitParam, 10) || 50, 1), 100);

  try {
    const messages = await fetchChannelMessages(channelId, limit);
    return c.json(messages);
  } catch (err) {
    if (err instanceof RateLimitError) {
      return c.json(
        { error: 'Rate limited by Discord', retryAfter: err.retryAfter },
        429
      );
    }
    if (err instanceof DiscordApiError) {
      return c.json(
        { error: 'Discord API error', details: err.body },
        err.status as 400
      );
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[discord] Error fetching messages:', message);
    return c.json({ error: message }, 500);
  }
});

// GET /channels/:channelId
discordRoutes.get('/channels/:channelId', async (c) => {
  const { channelId } = c.req.param();

  try {
    const channel = await fetchChannelInfo(channelId);
    return c.json(channel);
  } catch (err) {
    if (err instanceof RateLimitError) {
      return c.json(
        { error: 'Rate limited by Discord', retryAfter: err.retryAfter },
        429
      );
    }
    if (err instanceof DiscordApiError) {
      return c.json(
        { error: 'Discord API error', details: err.body },
        err.status as 400
      );
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[discord] Error fetching channel:', message);
    return c.json({ error: message }, 500);
  }
});

// POST /channels/:channelId/messages — webhook message proxy
discordRoutes.post('/channels/:channelId/messages', async (c) => {
  const { channelId } = c.req.param();

  let body: { content: string; username: string };
  try {
    body = await c.req.json<{ content: string; username: string }>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.content?.trim()) {
    return c.json({ error: 'Message content is required' }, 400);
  }
  if (!body.username?.trim()) {
    return c.json({ error: 'Username is required' }, 400);
  }
  if (body.content.length > 2000) {
    return c.json({ error: 'Message exceeds 2000 character limit' }, 400);
  }

  const displayName = `${body.username.trim()} (unverified)`;

  try {
    const result = await sendWebhookMessage(channelId, body.content, displayName);
    return c.json(result, 200);
  } catch (err) {
    if (err instanceof RateLimitError) {
      return c.json(
        { error: 'Rate limited', retryAfter: err.retryAfter },
        429
      );
    }
    if (err instanceof DiscordApiError) {
      return c.json(
        { error: 'Discord API error', details: err.body },
        err.status as 400
      );
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[discord] Send error:', message);
    return c.json({ error: message }, 500);
  }
});

/**
 * Initialize the Discord Gateway connection.
 * Call once at server startup. No-op if DISCORD_BOT_TOKEN is missing.
 */
export function initDiscordGateway(): void {
  startGateway();
}
```

Note: The routes are mounted under `/api/discord` in the parent app (Task 3), so paths here are relative — `/channels/:channelId/messages` becomes `/api/discord/channels/:channelId/messages` at the top level.

**Step 5: Verify TypeScript compilation**

Run: `cd /home/penguin/code/lens-relay/ws3/lens-editor && npx tsc -p tsconfig.node.json --noEmit`
Expected: No errors. Uses the project's tsconfig which has the correct `moduleResolution: "bundler"` setting for `.ts` import extensions.

**Step 6: Commit**

```bash
jj new -m "refactor: move discord-bridge source into lens-editor/server/discord/"
```

---

### Task 3: Wire discord routes into prod-server.ts

**Files:**
- Modify: `lens-editor/server/prod-server.ts`

**Step 1: Replace the discord proxy block with direct route mounting**

Current `prod-server.ts` (line 9):
```typescript
const discordBridgeUrl = process.env.DISCORD_BRIDGE_URL || 'http://discord-bridge:8091';
```

And lines 66-69:
```typescript
  } else if (url.startsWith('/api/discord/') || url === '/api/discord') {
    req.url = url.replace(/^\/api\/discord/, '/api');
    proxy.web(req, res, { target: discordBridgeUrl, changeOrigin: true });
  } else {
```

Replace the full file with:

```typescript
import http from 'node:http';
import httpProxy from 'http-proxy';
import { Hono } from 'hono';
import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createAuthHandler, AuthError } from './auth-middleware.ts';
import { discordRoutes, initDiscordGateway } from './discord/routes.ts';

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

// Static files from Vite build output
app.use('/*', serveStatic({ root: './dist' }));
// SPA fallback
app.get('/*', serveStatic({ root: './dist', path: 'index.html' }));

const honoListener = getRequestListener(app.fetch);

// Node HTTP server: relay proxy bypasses Hono, everything else goes through it
const server = http.createServer((req, res) => {
  const url = req.url || '/';

  if (url.startsWith('/api/relay/') || url === '/api/relay') {
    req.url = url.replace(/^\/api\/relay/, '') || '/';
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
```

Key changes:
- Removed `discordBridgeUrl` variable
- Removed `http-proxy` discord branch from the `createServer` handler
- Added `app.route('/api/discord', discordRoutes)` — Hono handles discord directly
- Added `initDiscordGateway()` call at startup
- The `else if` for discord in the request handler is gone — all non-relay requests go to Hono, which now serves discord routes + auth + static files

**Step 2: Verify the server starts**

Run: `cd /home/penguin/code/lens-relay/ws3/lens-editor && npx tsx server/prod-server.ts &`
Expected: `[lens-editor] Production server on port 3000` and `[gateway] DISCORD_BOT_TOKEN not set, Gateway disabled`

Then kill it: `kill %1`

**Step 3: Commit**

```bash
jj new -m "refactor: wire discord routes directly into prod-server, remove proxy"
```

---

### Task 4: Update Vite dev config for discord routes

**Files:**
- Modify: `lens-editor/vite.config.ts`

In dev mode, the frontend calls `/api/discord/...`. Currently this is proxied to the discord-bridge sidecar. After the merge, we have two options:

- Run the discord routes in a separate dev process (extra complexity)
- Proxy to the same Vite dev server (not possible — Vite can't serve Hono routes on `/api/discord`)

The simplest approach: in dev mode, keep the proxy pointing at a local port where you can optionally run the discord routes. But since `discord:start` script already exists in package.json pointing at `../discord-bridge`, we replace it with a script that starts the routes from the new location.

**Step 1: Add a dev discord server script**

Create `lens-editor/server/discord/dev-server.ts`:

```typescript
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { discordRoutes, initDiscordGateway } from './routes.ts';

// In dev, Vite rewrites /api/discord → /api before proxying here.
// Mount discordRoutes under /api so paths match: /api/channels/:id/messages etc.
const app = new Hono();
app.route('/api', discordRoutes);

const port = parseInt(process.env.DISCORD_BRIDGE_PORT || '8091', 10);

initDiscordGateway();

serve({ fetch: app.fetch, port }, () => {
  console.log(`[discord-dev] Listening on port ${port}`);
});
```

**Why the `/api` mount:** The Vite proxy (`vite.config.ts:110`) rewrites `/api/discord/channels/123/messages` → `/api/channels/123/messages` before forwarding to this dev server. The original `discord-bridge/src/index.ts` defined routes under `/api/...`, so the rewrite worked. Our `discordRoutes` defines routes as `/channels/...` (no prefix), so we mount under `/api` to match. In production, `prod-server.ts` mounts under `/api/discord` instead (no rewrite needed).

**Step 2: Update package.json discord:start script**

In `lens-editor/package.json`, change:
```json
"discord:start": "cd ../discord-bridge && npm run dev",
```
to:
```json
"discord:start": "tsx watch server/discord/dev-server.ts",
```

**Step 3: Remove the Vite proxy bridge port workspace calculation**

In `lens-editor/vite.config.ts`, the discord proxy config (lines 107-111) can stay as-is — it still proxies `/api/discord` to `localhost:8091` (or workspace-adjusted port). The only difference is that port is now served by `server/discord/dev-server.ts` instead of the separate `discord-bridge` package.

No changes needed to vite.config.ts.

**Step 4: Test dev mode**

Terminal 1: `cd /home/penguin/code/lens-relay/ws3/lens-editor && npm run discord:start`
Expected: `[discord-dev] Listening on port 8091` (or workspace-adjusted port)

Terminal 2: `cd /home/penguin/code/lens-relay/ws3/lens-editor && npm run dev:local`
Expected: Vite starts, discord proxy still works

**Step 5: Commit**

```bash
jj new -m "refactor: discord dev server now runs from lens-editor/server/discord/"
```

---

### Task 5: Update lens-editor Dockerfile for discord support

**Files:**
- Modify: `lens-editor/Dockerfile`

The current Dockerfile copies `server/prod-server.ts server/auth-middleware.ts server/share-token.ts` explicitly. We need to also copy the `server/discord/` directory.

**Step 1: Update COPY line**

In `lens-editor/Dockerfile`, change line 14:
```dockerfile
COPY --from=builder /app/dist ./dist
COPY server/prod-server.ts server/auth-middleware.ts server/share-token.ts ./server/
COPY shared/ ./shared/
```
to:
```dockerfile
COPY --from=builder /app/dist ./dist
COPY server/ ./server/
COPY shared/ ./shared/
```

This copies the entire `server/` directory instead of listing individual files. Simpler and won't break when more files are added.

Note: The `dev-server.ts` will be included but it's harmless — it's never invoked in production (only `prod-server.ts` is called by CMD).

**Step 2: Commit**

```bash
jj new -m "build: include discord server files in lens-editor Docker image"
```

---

### Task 6: Update integration tests

**Files:**
- Modify: `lens-editor/src/components/DiscussionPanel/DiscussionPanel.integration.test.tsx`

**Step 1: Verify integration test URLs still work**

The integration test at line 14 references:
```typescript
const BRIDGE_URL = process.env.DISCORD_BRIDGE_URL || 'http://localhost:8091';
```

And hits `${BRIDGE_URL}/api/channels/${CHANNEL_ID}/messages`. The dev-server (Task 4) mounts `discordRoutes` under `/api`, so `/api/channels/...` resolves correctly. Same port, same paths — no URL changes needed.

**Step 2: Update comments referencing "discord-bridge"**

Change line 4 in `DiscussionPanel.integration.test.tsx`:
```typescript
// Before:
 * Integration smoke tests that hit a running discord-bridge sidecar.
// After:
 * Integration smoke tests that hit a running discord dev server (npm run discord:start).
```

Also update `lens-editor/src/components/DiscussionPanel/useMessages.ts` line 39:
```typescript
// Before:
 * Hook: fetches messages from the discord-bridge proxy API.
// After:
 * Hook: fetches messages from the discord proxy API.
```

**Step 3: Run unit tests to verify nothing broke**

Run: `cd /home/penguin/code/lens-relay/ws3/lens-editor && npm run test:run`
Expected: All tests pass. Discord-related unit tests mock their fetch calls and don't need a running server.

**Step 4: Commit**

```bash
jj new -m "test: update discord integration test comment"
```

---

### Task 7: Delete the discord-bridge directory

**Files:**
- Delete: `discord-bridge/` (entire directory)

**Step 1: Verify nothing else references discord-bridge**

Run: `cd /home/penguin/code/lens-relay/ws3 && grep -r "discord-bridge" --include="*.ts" --include="*.json" --include="*.md" --include="*.yaml" --include="*.toml" -l | grep -v node_modules | grep -v discord-bridge/`

Expected: Only `CLAUDE.md` and possibly `docs/` files that describe the old architecture. These are documentation updates (Task 9).

**Step 2: Delete the directory**

Run: `rm -rf /home/penguin/code/lens-relay/ws3/discord-bridge`

**Step 3: Commit**

```bash
jj new -m "chore: remove discord-bridge directory (merged into lens-editor)"
```

---

### Task 8: Create docker-compose.prod.yaml

**Files:**
- Create: `docker-compose.prod.yaml` (repo root)

This replaces the manual `docker run` commands documented in `docs/server-ops.md` lines 266-306.

**Step 1: Create the compose file**

Create `docker-compose.prod.yaml` at the repo root:

```yaml
# Production deployment for Hetzner VPS (46.224.127.155)
#
# Usage:
#   docker compose -f docker-compose.prod.yaml up -d
#   docker compose -f docker-compose.prod.yaml logs -f
#   docker compose -f docker-compose.prod.yaml down
#
# Prerequisites:
#   - /root/relay.toml — relay server configuration
#   - /root/auth.env — Cloudflare R2 credentials (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
#   - /root/relay-git-sync-data/ — git sync data, SSH keys, patched files
#   - TUNNEL_TOKEN environment variable or in .env file

services:
  cloudflared:
    image: cloudflare/cloudflared:latest
    container_name: cloudflared
    restart: unless-stopped
    command: tunnel --no-autoupdate run --token ${TUNNEL_TOKEN}

  relay-server:
    build:
      context: crates/
      dockerfile: Dockerfile
    image: relay-server:custom
    container_name: relay-server
    restart: unless-stopped
    ulimits:
      nofile:
        soft: 65536
        hard: 524288
    volumes:
      - /root/relay.toml:/app/relay.toml:ro
    env_file:
      - /root/auth.env

  lens-editor:
    build:
      context: lens-editor/
      dockerfile: Dockerfile
    image: lens-editor:custom
    container_name: lens-editor
    restart: unless-stopped
    environment:
      - RELAY_URL=http://relay-server:8080
      - RELAY_SERVER_TOKEN=${RELAY_SERVER_TOKEN}
      - DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN}
      - PORT=3000

  relay-git-sync:
    image: docker.system3.md/relay-git-sync:latest
    container_name: relay-git-sync
    restart: unless-stopped
    ports:
      - "127.0.0.1:8001:8000"
    volumes:
      - /root/relay-git-sync-data:/data
      - /root/relay-git-sync-data/webhook_handler.py:/app/webhook_handler.py
      - /root/relay-git-sync-data/persistence.py:/app/persistence.py
    environment:
      - RELAY_GIT_DATA_DIR=/data
      - RELAY_SERVER_URL=http://relay-server:8080
      - RELAY_SERVER_API_KEY=${RELAY_SERVER_API_KEY}
      - WEBHOOK_SECRET=${WEBHOOK_SECRET}
```

Notes:
- All services are on the default compose network (no need for explicit `relay-network` — compose creates one automatically). Services reference each other by name (e.g., `http://relay-server:8080`).
- SSH keys for relay-git-sync are in the volume mount at `/data/ssh/` (not passed as env vars — multi-line PEM keys don't work in `.env` files). The patched `persistence.py` reads them from `/data/ssh/config`.
- **Cloudflare Tunnel dashboard** needs updating to also route `editor.lensacademy.org` → `lens-editor:3000`. This is a manual step in Zero Trust → Networks → Tunnels → Configure.

**Step 2: Create a .env.example for the required variables**

Create `.env.example` at the repo root:

```bash
# Production environment variables for docker-compose.prod.yaml
# Copy to .env and fill in values.

# Cloudflare Tunnel token (from Zero Trust dashboard → Tunnels → Configure)
TUNNEL_TOKEN=

# Relay server token for lens-editor auth proxy
RELAY_SERVER_TOKEN=

# Discord bot token (from Discord Developer Portal)
DISCORD_BOT_TOKEN=

# relay-git-sync secrets (SSH keys are in /root/relay-git-sync-data/ssh/, not env vars)
RELAY_SERVER_API_KEY=
WEBHOOK_SECRET=
```

**Step 3: Verify compose file syntax**

Run: `cd /home/penguin/code/lens-relay/ws3 && docker compose -f docker-compose.prod.yaml config --quiet`
Expected: No errors

**Step 4: Commit**

```bash
jj new -m "infra: add docker-compose.prod.yaml for production deployment"
```

---

### Task 9: Update documentation

**Files:**
- Modify: `docs/server-ops.md`
- Modify: `CLAUDE.md`

**Step 1: Update server-ops.md**

In `docs/server-ops.md`, update the "Docker Containers" section (lines 27-44) to:
- Remove the note about 3 separate containers with individual `docker run` commands
- Reference `docker-compose.prod.yaml` instead
- Remove the "Recreating Containers" section (lines 263-306) — compose handles this
- Add lens-editor to the container list

Replace the "Recreating Containers" section (lines 263-306) with:

```markdown
## Deploying / Updating

```bash
cd /path/to/lens-relay
docker compose -f docker-compose.prod.yaml build
docker compose -f docker-compose.prod.yaml up -d
```

To rebuild a single service:
```bash
docker compose -f docker-compose.prod.yaml build relay-server
docker compose -f docker-compose.prod.yaml up -d relay-server
```
```

**Step 2: Update CLAUDE.md architecture diagram**

In `CLAUDE.md`, the architecture diagram mentions `lens-editor` and the discord bridge as separate. Update to reflect the merge. Remove mentions of discord-bridge as a separate component from the Components table.

**Step 3: Commit**

```bash
jj new -m "docs: update server-ops and CLAUDE.md for discord merge and docker-compose"
```

---

### Task 10: Clean up stale Fly.io, legacy configs, and Tailscale from Dockerfile

**Files:**
- Delete: `crates/fly.toml`
- Delete: `crates/fly.staging.toml`
- Delete: `crates/entrypoint.sh`
- Modify: `crates/Dockerfile` (remove Tailscale)
- Modify: `crates/run.sh` (remove Tailscale startup logic)

These are unused configs from upstream (Fly.io), a legacy entrypoint superseded by `run.sh`, and Tailscale binaries that aren't needed (cloudflared handles tunnel ingress).

**Step 1: Verify Fly.io files are not referenced anywhere**

Run: `cd /home/penguin/code/lens-relay/ws3 && grep -r "fly.toml\|fly.staging\|entrypoint.sh" --include="*.ts" --include="*.yaml" --include="*.toml" --include="*.sh" -l | grep -v node_modules`
Expected: No results (or only the files themselves)

**Step 2: Delete stale files**

```bash
rm crates/fly.toml crates/fly.staging.toml crates/entrypoint.sh
```

**Step 3: Remove Tailscale from crates/Dockerfile**

Remove lines 14-17 (Tailscale COPY and mkdir):
```dockerfile
# Remove these lines:
COPY --from=docker.io/tailscale/tailscale:stable /usr/local/bin/tailscaled /usr/local/bin/tailscaled
COPY --from=docker.io/tailscale/tailscale:stable /usr/local/bin/tailscale /usr/local/bin/tailscale
RUN mkdir -p /var/run/tailscale /var/cache/tailscale /var/lib/tailscale
```

This reduces the Docker image size by removing unused binaries.

**Step 4: Remove Tailscale startup from crates/run.sh**

Remove lines 26-37 (the `if [ -n "$TAILSCALE_AUTHKEY" ]` block). The simplified `run.sh` becomes:

```bash
#!/bin/bash
set -e
trap "exit" TERM INT

if [ -n "$1" ]; then
    echo "Using URL from argument: $1"
fi

echo "Starting Relay Server..."
./relay config validate
if [ -n "$1" ]; then
    exec ./relay serve --host=0.0.0.0 --url="$1"
else
    exec ./relay serve --host=0.0.0.0
fi
```

Also remove the `use_legacy_var` function and Y_SWEET backwards-compat block (lines 13-24) — these are dead code from upstream that we don't use.

**Step 5: Commit**

```bash
jj new -m "chore: remove Fly.io configs, legacy entrypoint, and Tailscale from relay Dockerfile"
```

---

## Summary of Changes

| Step | What | Files touched |
|------|------|--------------|
| 1 | Add discord.js to lens-editor | `lens-editor/package.json` |
| 2 | Move discord source files | 4 new files in `lens-editor/server/discord/` |
| 3 | Wire routes into prod-server | `lens-editor/server/prod-server.ts` |
| 4 | Dev server for discord routes | `lens-editor/server/discord/dev-server.ts`, `lens-editor/package.json` |
| 5 | Update Dockerfile | `lens-editor/Dockerfile` |
| 6 | Update integration tests | 1 comment change, run test suite |
| 7 | Delete discord-bridge | `discord-bridge/` removed |
| 8 | Create docker-compose | `docker-compose.prod.yaml`, `.env.example` |
| 9 | Update docs | `docs/server-ops.md`, `CLAUDE.md` |
| 10 | Clean up stale configs | Remove `fly.toml`, `fly.staging.toml`, `entrypoint.sh` |

## Verification

After all tasks, verify end-to-end:

1. **Unit tests pass:** `cd lens-editor && npm run test:run`
2. **Prod server starts:** `cd lens-editor && RELAY_URL=http://localhost:8090 npx tsx server/prod-server.ts` — should log startup + gateway disabled
3. **Discord routes respond:** With prod server running, `curl -s localhost:3000/api/discord/gateway/status` — should return `{"status":"disconnected"}`
4. **Dev server discord routes:** `npm run discord:start &` then `curl -s localhost:8091/api/gateway/status` — should return `{"status":"disconnected"}`
5. **Docker build works:** `cd lens-editor && docker build -t lens-editor:test .`
6. **Compose validates:** `docker compose -f docker-compose.prod.yaml config --quiet`
