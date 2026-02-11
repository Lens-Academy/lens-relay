import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { streamSSE } from 'hono/streaming';
import {
  fetchChannelMessages,
  fetchChannelInfo,
  executeWebhook,
  validateWebhookUsername,
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

// POST /api/channels/:channelId/messages — webhook proxy
app.post('/api/channels/:channelId/messages', async (c) => {
  const { channelId } = c.req.param();

  // Parse JSON body
  let body: { content: string; username: string };
  try {
    body = await c.req.json<{ content: string; username: string }>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // Validate required fields
  if (!body.content?.trim()) {
    return c.json({ error: 'Message content is required' }, 400);
  }
  if (!body.username?.trim()) {
    return c.json({ error: 'Username is required' }, 400);
  }

  // Validate content length (Discord max: 2000 chars)
  if (body.content.length > 2000) {
    return c.json({ error: 'Message exceeds 2000 character limit' }, 400);
  }

  // Append " (unverified)" suffix server-side (POST-03)
  const finalUsername = `${body.username.trim()} (unverified)`;

  // Validate the final username (with suffix)
  const usernameError = validateWebhookUsername(finalUsername);
  if (usernameError) {
    return c.json({ error: usernameError }, 400);
  }

  try {
    const result = await executeWebhook(channelId, {
      content: body.content,
      username: finalUsername,
    });
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
    if (message.includes('No webhook URL configured')) {
      return c.json({ error: message }, 503);
    }
    console.error('[discord-bridge] Webhook error:', message);
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

if (!process.env.DISCORD_WEBHOOK_URL && !process.env.DISCORD_WEBHOOK_MAP) {
  console.warn(
    '[discord-bridge] No webhook URL configured. POST /api/channels/:channelId/messages will return 503.'
  );
  console.warn(
    '[discord-bridge] Set DISCORD_WEBHOOK_URL or DISCORD_WEBHOOK_MAP to enable message posting.'
  );
}

serve({ fetch: app.fetch, port }, () => {
  console.log(`[discord-bridge] Listening on port ${port}`);
});
