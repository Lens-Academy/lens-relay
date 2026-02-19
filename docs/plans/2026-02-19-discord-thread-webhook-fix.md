# Discord Thread Webhook Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix Discord message sending in threads/forum posts by creating webhooks on the parent channel and executing them with `thread_id`.

**Architecture:** Discord doesn't allow webhook creation on threads (type 11) or forum posts (type 12). Currently `getOrCreateWebhook()` tries to create a webhook directly on the thread channel ID, which fails with "Unknown Channel" (code 10003). Fix: detect threads via `fetchChannelInfo()`, create the webhook on `parent_id` instead, and append `&thread_id=` when executing the webhook. The webhook cache key stays as the original channel ID so each thread reuses its parent's webhook efficiently.

**Tech Stack:** TypeScript, Hono (server), Discord REST API v10, Vitest (tests)

---

## Context

### The Bug

The `discussion` field in Lens Edu document YAML frontmatter links to Discord threads (type 11), not regular channels. When a user sends a message from the Discussion panel:

1. Frontend POSTs to `/api/discord/channels/:channelId/messages`
2. Backend calls `sendWebhookMessage(channelId, ...)`
3. Which calls `getOrCreateWebhook(channelId)` → `GET /channels/{threadId}/webhooks`
4. Discord returns 404 "Unknown Channel" (code 10003) — **threads don't support webhooks**

Reading works because `GET /channels/{threadId}/messages` is valid for threads. Only webhook operations fail.

### The Fix

Discord's webhook API supports threads via a `thread_id` query parameter:
- Create webhook on the **parent channel** (from `channel.parent_id`)
- Execute webhook with `?wait=true&thread_id={threadId}`

### Discord Channel Types

| Type | Name | Supports webhooks? |
|------|------|--------------------|
| 0 | Text channel | Yes |
| 5 | Announcement channel | Yes |
| 10 | Announcement thread | No (use parent) |
| 11 | Public thread | No (use parent) |
| 12 | Private thread | No (use parent) |
| 15 | Forum post | No (use parent channel) |

### Files

- **Modify:** `lens-editor/server/discord/discord-client.ts` — thread detection + webhook routing
- **Modify:** `lens-editor/server/discord/types.ts` — add `parent_id` to `DiscordChannel`
- **Create:** `lens-editor/server/discord/discord-client.test.ts` — unit tests
- **No frontend changes** — the frontend already passes the thread channel ID; the backend handles the rest

---

### Task 1: Add `parent_id` to DiscordChannel type

**Files:**
- Modify: `lens-editor/server/discord/types.ts:22-26`

**Step 1: Update the type**

In `types.ts`, add `parent_id` to the `DiscordChannel` interface:

```typescript
export interface DiscordChannel {
  id: string;
  name: string;
  type: number;
  parent_id?: string | null;
}
```

This field is returned by Discord's `GET /channels/:id` endpoint for threads and child channels. It's the ID of the parent text/forum channel.

**Step 2: Commit**

```bash
jj describe -m "feat(discord): add parent_id to DiscordChannel type"
```

---

### Task 2: Write failing tests for thread-aware webhook sending

**Files:**
- Create: `lens-editor/server/discord/discord-client.test.ts`

**Step 1: Write the test file**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We need to mock global fetch before importing the module
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// Set required env var before importing
vi.stubEnv('DISCORD_BOT_TOKEN', 'test-bot-token');

// Import after mocks are set up
const { sendWebhookMessage } = await import('./discord-client.ts');

// Helper to create a mock Response
function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

describe('sendWebhookMessage', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('sends to regular channel without thread_id', async () => {
    // 1. fetchChannelInfo → regular text channel (type 0)
    fetchMock.mockResolvedValueOnce(
      mockResponse({ id: '111', name: 'general', type: 0, parent_id: null })
    );
    // 2. List webhooks → empty (no existing webhook)
    fetchMock.mockResolvedValueOnce(mockResponse([]));
    // 3. Create webhook
    fetchMock.mockResolvedValueOnce(
      mockResponse({ id: 'wh1', token: 'wh-token-1' })
    );
    // 4. Execute webhook
    fetchMock.mockResolvedValueOnce(
      mockResponse({ id: 'msg1', content: 'hello', author: {}, timestamp: '', type: 0 })
    );

    await sendWebhookMessage('111', 'hello', 'TestUser');

    // Webhook should be created on channel 111 (not a thread)
    const createCall = fetchMock.mock.calls[2];
    expect(createCall[0]).toBe('https://discord.com/api/v10/channels/111/webhooks');

    // Execute URL should NOT have thread_id
    const execCall = fetchMock.mock.calls[3];
    expect(execCall[0]).toBe('https://discord.com/api/v10/webhooks/wh1/wh-token-1?wait=true');
    expect(execCall[0]).not.toContain('thread_id');
  });

  it('sends to thread using parent channel webhook + thread_id', async () => {
    // 1. fetchChannelInfo → public thread (type 11) with parent
    fetchMock.mockResolvedValueOnce(
      mockResponse({ id: '222', name: 'my-thread', type: 11, parent_id: '100' })
    );
    // 2. List webhooks on PARENT channel 100 → empty
    fetchMock.mockResolvedValueOnce(mockResponse([]));
    // 3. Create webhook on PARENT channel 100
    fetchMock.mockResolvedValueOnce(
      mockResponse({ id: 'wh2', token: 'wh-token-2' })
    );
    // 4. Execute webhook with thread_id
    fetchMock.mockResolvedValueOnce(
      mockResponse({ id: 'msg2', content: 'hi thread', author: {}, timestamp: '', type: 0 })
    );

    await sendWebhookMessage('222', 'hi thread', 'TestUser');

    // Webhook should be created on PARENT channel 100
    const createCall = fetchMock.mock.calls[2];
    expect(createCall[0]).toBe('https://discord.com/api/v10/channels/100/webhooks');

    // Execute URL should include thread_id=222
    const execCall = fetchMock.mock.calls[3];
    expect(execCall[0]).toContain('thread_id=222');
    expect(execCall[0]).toContain('wait=true');
  });

  it('sends to forum post using parent channel webhook + thread_id', async () => {
    // Forum posts are type 11 threads inside a type 15 forum channel
    fetchMock.mockResolvedValueOnce(
      mockResponse({ id: '333', name: 'forum-post', type: 11, parent_id: '200' })
    );
    fetchMock.mockResolvedValueOnce(mockResponse([]));
    fetchMock.mockResolvedValueOnce(
      mockResponse({ id: 'wh3', token: 'wh-token-3' })
    );
    fetchMock.mockResolvedValueOnce(
      mockResponse({ id: 'msg3', content: 'forum msg', author: {}, timestamp: '', type: 0 })
    );

    await sendWebhookMessage('333', 'forum msg', 'TestUser');

    // Webhook on parent channel 200
    const createCall = fetchMock.mock.calls[2];
    expect(createCall[0]).toBe('https://discord.com/api/v10/channels/200/webhooks');

    // thread_id=333
    const execCall = fetchMock.mock.calls[3];
    expect(execCall[0]).toContain('thread_id=333');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd lens-editor && npx vitest run server/discord/discord-client.test.ts
```

Expected: FAIL — `sendWebhookMessage` currently doesn't call `fetchChannelInfo` and doesn't handle threads.

**Step 3: Commit**

```bash
jj describe -m "test(discord): add failing tests for thread-aware webhook sending"
```

---

### Task 3: Implement thread-aware webhook logic

**Files:**
- Modify: `lens-editor/server/discord/discord-client.ts:128-204`

**Step 1: Add thread type constants and helper**

Add after line 127 (the `fetchChannelInfo` closing brace), replacing the existing webhook section (lines 128-204):

```typescript
// --- Webhook-based message sending ---

/** Discord channel types that are threads (cannot host webhooks directly). */
const THREAD_TYPES = new Set([10, 11, 12]); // announcement thread, public thread, private thread

interface ChannelWebhook {
  id: string;
  token: string;
}

const WEBHOOK_NAME = 'Lens Editor Bridge';

// In-memory cache: webhookChannelId -> webhook credentials
// For threads, the key is the parent channel ID.
const webhookCache = new Map<string, ChannelWebhook>();

/**
 * Resolve where to create the webhook and whether to use thread_id.
 * Threads can't host webhooks — use the parent channel instead.
 */
async function resolveWebhookTarget(
  channelId: string
): Promise<{ webhookChannelId: string; threadId: string | null }> {
  const channel = await fetchChannelInfo(channelId);

  if (THREAD_TYPES.has(channel.type) && channel.parent_id) {
    return { webhookChannelId: channel.parent_id, threadId: channelId };
  }

  return { webhookChannelId: channelId, threadId: null };
}

/**
 * Get or create a webhook for the given channel.
 * Bot must have MANAGE_WEBHOOKS permission on the target channel.
 */
async function getOrCreateWebhook(
  webhookChannelId: string
): Promise<ChannelWebhook> {
  const cached = webhookCache.get(webhookChannelId);
  if (cached) return cached;

  // Check for existing webhook we own
  const listUrl = `${DISCORD_API_BASE}/channels/${webhookChannelId}/webhooks`;
  const listRes = await fetch(listUrl, { headers: authHeaders() });
  const webhooks = await handleResponse<
    Array<{ id: string; token?: string; name: string; user?: { id: string } }>
  >(listRes);

  const existing = webhooks.find(
    (w) => w.name === WEBHOOK_NAME && w.token
  );

  if (existing) {
    const entry = { id: existing.id, token: existing.token! };
    webhookCache.set(webhookChannelId, entry);
    return entry;
  }

  // Create a new webhook
  const createUrl = `${DISCORD_API_BASE}/channels/${webhookChannelId}/webhooks`;
  const createRes = await fetch(createUrl, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ name: WEBHOOK_NAME }),
  });
  const created = await handleResponse<{ id: string; token: string }>(
    createRes
  );

  const entry = { id: created.id, token: created.token };
  webhookCache.set(webhookChannelId, entry);
  console.log(
    `[discord-client] Created webhook for channel ${webhookChannelId}`
  );
  return entry;
}

/**
 * Send a message to a Discord channel or thread via a bot-managed webhook.
 * For threads, the webhook is created on the parent channel and executed
 * with ?thread_id= to route the message into the thread.
 */
export async function sendWebhookMessage(
  channelId: string,
  content: string,
  username: string
): Promise<DiscordMessage> {
  const { webhookChannelId, threadId } = await resolveWebhookTarget(channelId);
  const webhook = await getOrCreateWebhook(webhookChannelId);

  let url = `${DISCORD_API_BASE}/webhooks/${webhook.id}/${webhook.token}?wait=true`;
  if (threadId) {
    url += `&thread_id=${threadId}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, username }),
  });

  return handleResponse<DiscordMessage>(res);
}
```

**Step 2: Run tests to verify they pass**

```bash
cd lens-editor && npx vitest run server/discord/discord-client.test.ts
```

Expected: All 3 tests PASS.

**Step 3: Run full test suite**

```bash
cd lens-editor && npx vitest run
```

Expected: All existing tests still pass.

**Step 4: Commit**

```bash
jj describe -m "fix(discord): support sending messages to threads via parent webhook

Threads (types 10, 11, 12) cannot host webhooks. sendWebhookMessage()
now detects threads via fetchChannelInfo(), creates the webhook on the
parent channel, and executes it with ?thread_id= to route the message
into the thread."
```

---

### Task 4: Deploy and verify on production

**Step 1: Rebuild and deploy lens-editor**

The Discord bridge runs inside the lens-editor container on prod. No Rust changes needed.

```bash
# Push code changes to GitHub, pull on prod
ssh relay-prod 'cd /root/lens-relay && git pull'

# Rebuild and restart lens-editor container
ssh relay-prod 'cd /root/lens-relay && docker compose -f docker-compose.prod.yaml build lens-editor && docker compose -f docker-compose.prod.yaml up -d --force-recreate lens-editor'
```

**Step 2: Verify in browser**

Open https://editor.lensacademy.org/6135b1c6/Lens-Edu/modules/Fundamental-Difficulties.md (with auth token from #lens-internal).

1. Type a test message in the Discussion panel
2. Click Send
3. Verify the message appears in the thread (both in the editor and in Discord)
4. Delete the test message from Discord if needed

**Step 3: Check prod lens-editor logs for the webhook creation**

```bash
ssh relay-prod 'docker logs lens-editor --since 5m 2>&1 | grep -i webhook'
```

Expected: `[discord-client] Created webhook for channel 1448070015533191360` (the parent channel ID, not the thread ID)

---

## Rollback Plan

If the fix causes issues, the previous lens-editor image can be restored:

```bash
ssh relay-prod 'cd /root/lens-relay && git checkout HEAD~1 -- lens-editor/ && docker compose -f docker-compose.prod.yaml build lens-editor && docker compose -f docker-compose.prod.yaml up -d --force-recreate lens-editor'
```

The webhook created on the parent channel is harmless and can be left in place or manually deleted from Discord server settings.
