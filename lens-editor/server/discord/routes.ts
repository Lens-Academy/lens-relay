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
