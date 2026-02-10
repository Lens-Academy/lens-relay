import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { streamSSE } from 'hono/streaming';
import {
  fetchChannelMessages,
  fetchChannelInfo,
  RateLimitError,
  DiscordApiError,
} from './discord-client.js';
import {
  startGateway,
  getGatewayStatus,
  gatewayEvents,
} from './gateway.js';

const app = new Hono();

// Logging
app.use('*', logger());

// CORS for /api/* (needed in production; Vite proxy handles dev)
app.use('/api/*', cors());

// Health check
app.get('/health', (c) => c.json({ status: 'ok' }));

// SSE endpoint: stream Gateway events for a specific channel
app.get('/api/channels/:channelId/events', async (c) => {
  const { channelId } = c.req.param();

  return streamSSE(c, async (stream) => {
    // Send initial connection status
    await stream.writeSSE({
      event: 'status',
      data: JSON.stringify({ gateway: getGatewayStatus() }),
    });

    // Forward Gateway events for this channel
    const handler = async (message: unknown) => {
      try {
        await stream.writeSSE({
          event: 'message',
          data: JSON.stringify(message),
          id: (message as { id: string }).id,
        });
      } catch {
        // Client disconnected, handler will be cleaned up by onAbort
      }
    };

    gatewayEvents.on(`message:${channelId}`, handler);

    stream.onAbort(() => {
      gatewayEvents.off(`message:${channelId}`, handler);
    });

    // Keep connection alive with periodic heartbeat
    while (true) {
      await stream.writeSSE({ event: 'heartbeat', data: '' });
      await stream.sleep(30000);
    }
  });
});

// Gateway status endpoint
app.get('/api/gateway/status', (c) => {
  return c.json({ status: getGatewayStatus() });
});

// GET /api/channels/:channelId/messages
app.get('/api/channels/:channelId/messages', async (c) => {
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
    // Token missing or unexpected error
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[discord-bridge] Error fetching messages:', message);
    return c.json({ error: message }, 500);
  }
});

// GET /api/channels/:channelId
app.get('/api/channels/:channelId', async (c) => {
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
    console.error('[discord-bridge] Error fetching channel:', message);
    return c.json({ error: message }, 500);
  }
});

// Port detection: workspace convention
const cwdMatch = process.cwd().match(/ws(\d+)/);
const wsNum = cwdMatch ? parseInt(cwdMatch[1], 10) : 1;
const defaultPort = 8091 + (wsNum - 1) * 100;
const port = parseInt(
  process.env.DISCORD_BRIDGE_PORT || String(defaultPort),
  10
);

// Start Gateway connection (no-op if DISCORD_BOT_TOKEN is missing)
startGateway();

serve({ fetch: app.fetch, port }, () => {
  console.log(`[discord-bridge] Listening on port ${port}`);
});
