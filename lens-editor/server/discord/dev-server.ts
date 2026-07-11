import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { discordRoutes, initDiscordGateway } from './routes.ts';
import path from 'node:path';
import { getWorkspacePortsFromPaths } from '../workspace-ports.mjs';

// In dev, Vite rewrites /api/discord → /api before proxying here.
// Mount discordRoutes under /api so paths match: /api/channels/:id/messages etc.
const app = new Hono();
app.route('/api', discordRoutes);

const workspacePorts = getWorkspacePortsFromPaths(
  path.basename(process.cwd()),
  path.basename(path.dirname(process.cwd())),
);
const port = parseInt(process.env.DISCORD_BRIDGE_PORT || String(workspacePorts.discordBridge), 10);

initDiscordGateway();

serve({ fetch: app.fetch, port }, () => {
  console.log(`[discord-dev] Listening on port ${port}`);
});
