# Phase 2: Live Streaming - Research

**Researched:** 2026-02-10
**Domain:** Discord Gateway (WebSocket), Server-Sent Events, Discord markdown rendering, chat auto-scroll
**Confidence:** HIGH

## Summary

Phase 2 adds real-time streaming of Discord messages to the existing DiscussionPanel. The existing Phase 1 architecture has a Node.js discord-bridge sidecar (Hono + @hono/node-server) that proxies Discord REST API calls, and a React DiscussionPanel that fetches and renders messages. Phase 2 must add: (1) a persistent Discord Gateway (WebSocket) connection in the bridge sidecar to receive MESSAGE_CREATE events in real time, (2) an SSE endpoint on the bridge that streams those events to browser clients, (3) Discord-flavored markdown rendering, and (4) smart auto-scroll with a "new messages" indicator.

The critical architectural decision is the Discord bot/Gateway strategy. Research confirms that **two processes using the same bot token with the same shard ID will both receive all Gateway events, causing duplicate processing**. However, this is actually safe for the relay-server bridge because it is read-only (it only listens for events, never sends commands or responds). The lens-platform bot (Python, discord.py) and the relay bridge (Node.js, discord.js) can both connect to the Gateway with the same LucDevBot2 token simultaneously. Both will receive MESSAGE_CREATE events -- but since the bridge only forwards them to SSE clients and never acts on them (no slash commands, no reactions, no message sending), there is no conflict. The lens-platform handles its own slash commands independently. For small bots (under 2500 guilds), Discord recommends shard [0, 1] which is the default when no shard info is specified. Both processes will use this default.

For the dev-to-dev scenario (ws1 + ws2), each workspace runs its own bridge sidecar on different ports (8091 vs 8191). Both will connect to the Gateway simultaneously, both will receive events, and both will forward to their respective SSE clients. This works fine since they are independent processes.

**Primary recommendation:** Reuse the LucDevBot2 token for Gateway in the bridge sidecar (safe for read-only use). Use discord.js v14 for the Gateway connection. Use Hono's built-in `streamSSE` helper for the SSE endpoint. Use `discord-markdown-parser` for markdown AST generation with a custom React renderer. Implement auto-scroll with IntersectionObserver on a bottom sentinel element.

## Discord Bot / Gateway Strategy

**This section addresses the user-requested investigation. The user wants to review this proposal before it is locked in.**

### Can relay-server and lens-platform share the LucDevBot2 token for simultaneous Gateway connections?

**Answer: Yes, safely, because the bridge is read-only.**

#### How Discord Gateway sharing works

1. **Both processes connect with shard [0, 1]** (the default for small bots under 2500 guilds). Discord does NOT invalidate the old session when a new one connects on the same shard -- both sessions remain active and both receive all events.

2. **Both processes receive identical MESSAGE_CREATE events.** This is the documented behavior -- it is the same mechanism that causes the well-known "bot runs twice" bug when a bot accidentally starts two processes.

3. **Why this is safe for our use case:**
   - The bridge sidecar is **read-only**: it receives MESSAGE_CREATE events and forwards them to SSE clients. It never sends messages, registers slash commands, adds reactions, or modifies any Discord state.
   - The lens-platform bot handles its own slash commands, voice states, enrollment, etc. independently.
   - There is no state shared between the two processes that could conflict.
   - If either process restarts, the other continues unaffected.

4. **Session start limits:** Bots get 1000 identify calls per 24 hours (global across all sessions). Each Gateway connection uses one identify call. Restarts consume additional calls. With two processes (lens-platform + bridge), normal usage consumes ~2 per day, well within limits.

#### Multi-instance scenarios

| Scenario | What happens | Safe? |
|----------|-------------|-------|
| **Prod: relay-server + lens-platform** | Both connect with shard [0,1], both receive events. Bridge is read-only, no conflict. | Yes |
| **Dev: ws1 + ws2** | Two bridge sidecars both connect to Gateway. Both receive events. Two SSE streams, independent. Each uses 1 identify call. | Yes |
| **Dev+Prod overlap** | Up to 3-4 simultaneous Gateway connections. All receive events. All read-only. ~4 identify calls consumed per restart cycle. | Yes |

#### Risks and mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Hitting 1000 identify/day limit | Very Low (need 1000 restarts) | Add reconnect backoff; use Resume instead of Identify when possible (discord.js handles this automatically) |
| Discord changes shard behavior | Very Low | Monitor discord.js changelog; small bots (<2500 guilds) are lowest priority for sharding changes |
| lens-platform starts using a different bot | None currently | If it happens, bridge simply keeps using LucDevBot2 independently |

#### Proposal for user review

**Recommended approach: Reuse LucDevBot2 token. No dedicated bot needed.**

Rationale:
- Zero additional Discord Developer Portal setup
- No new bot to invite to the guild
- No new environment variables beyond what already exists
- Read-only Gateway usage has no conflict surface
- discord.js handles resume/reconnect automatically, minimizing identify calls

**If the user prefers a dedicated bot:** Create a new Discord application, generate a bot token, invite it to the guild with "Read Messages" permission, and use a separate `DISCORD_BRIDGE_BOT_TOKEN` env var. This adds operational complexity for zero functional benefit in the current architecture.

**Confidence: MEDIUM** -- The claim that two processes can share a token safely is well-supported by multiple community sources and the Discord API discussion (#5990) where a Discord maintainer confirmed "You can already set up multiple services with their own Gateway connections." However, the specific behavior of duplicate shard sessions is not explicitly documented in official Gateway docs -- it is inferred from widespread community experience with the "bot runs twice" pattern.

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `discord.js` | ^14.25.1 | Discord Gateway connection in bridge sidecar | Standard Node.js Discord library; handles WebSocket, heartbeat, resume, reconnect, rate limiting automatically |
| `discord-markdown-parser` | ^1.3.1 | Parse Discord markdown to AST | Built on simple-markdown (same parser Discord uses internally); zero production dependencies; actively maintained (last release Dec 2025); supports all Discord markdown features |
| Hono `streamSSE` | (built-in to hono ^4.x) | SSE endpoint for browser clients | Already using Hono in bridge; built-in streaming helper with `writeSSE`, `onAbort`, connection cleanup |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `hono` | ^4.11.9 | HTTP framework (already installed) | Existing bridge dependency, add SSE endpoint |
| `@hono/node-server` | ^1.19.9 | Node.js adapter (already installed) | Existing bridge dependency |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| discord.js (full) | `@discordjs/ws` (standalone WebSocket) | Lower-level, less abstraction, but requires manual heartbeat/resume. discord.js Client auto-handles everything. The weight difference is negligible for a sidecar. |
| discord-markdown-parser | `discord-markdown` (brussell98) | Outputs HTML strings not AST; last updated 2018; not actively maintained |
| discord-markdown-parser | Hand-rolled regex | Discord markdown has subtle rules (nested formatting, escaping, code block interactions). Library handles all edge cases. |
| discord-markdown-parser | `react-markdown` (remark) | General markdown, not Discord-specific. Doesn't handle Discord mentions, spoilers, timestamps, or Discord's specific formatting quirks. |
| SSE (server-sent events) | WebSocket (bridge-to-browser) | WebSocket is bidirectional but we only need server-to-client push for Phase 2. SSE is simpler, auto-reconnects, works through HTTP proxies, and Hono has built-in support. WebSocket would require additional library (e.g., `ws`) and Vite proxy config for WS. |
| SSE | Polling | Polling adds latency (up to poll interval) and wastes bandwidth. SSE gives sub-second delivery with a single persistent connection. |

### Installation

**discord-bridge/ (add Gateway client):**
```bash
cd discord-bridge
npm install discord.js
```

**lens-editor/ (add markdown parser -- browser-safe, zero deps):**
```bash
cd lens-editor
npm install discord-markdown-parser
```

## Architecture Patterns

### Recommended Changes to Project Structure

```
discord-bridge/
  src/
    index.ts                  # Hono server (existing) + SSE endpoint (NEW)
    discord-client.ts         # Discord REST API wrapper (existing)
    gateway.ts                # NEW: Discord Gateway connection manager
    types.ts                  # Shared types (extend with Gateway event types)

lens-editor/
  src/
    components/
      DiscussionPanel/
        DiscussionPanel.tsx   # Add SSE subscription, new messages indicator
        MessageList.tsx       # Add auto-scroll logic with sentinel
        MessageItem.tsx       # Add markdown rendering (replace plain text)
        DiscordMarkdown.tsx   # NEW: Discord markdown -> React elements
        useMessages.ts        # Extend: SSE subscription after initial fetch
        useAutoScroll.ts      # NEW: Auto-scroll hook with threshold detection
        NewMessagesBar.tsx    # NEW: "New messages" indicator component
```

### Pattern 1: Gateway Connection Manager

**What:** A module that manages the discord.js Client lifecycle, connecting to the Gateway and emitting events that the SSE endpoint can forward to browsers.

**When to use:** Always running when the bridge sidecar starts.

**Example:**
```typescript
// discord-bridge/src/gateway.ts
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { EventEmitter } from 'events';

// EventEmitter for decoupling Gateway events from SSE delivery
export const gatewayEvents = new EventEmitter();

let client: Client | null = null;

export function startGateway(): void {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.warn('[gateway] DISCORD_BOT_TOKEN not set, Gateway disabled');
    return;
  }

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.on(Events.MessageCreate, (message) => {
    // Emit channel-scoped event with serializable data
    gatewayEvents.emit(`message:${message.channelId}`, {
      id: message.id,
      content: message.content,
      author: {
        id: message.author.id,
        username: message.author.username,
        global_name: message.author.globalName,
        avatar: message.author.avatar,
        bot: message.author.bot,
      },
      timestamp: message.createdAt.toISOString(),
      type: message.type,
    });
  });

  client.on(Events.ClientReady, (c) => {
    console.log(`[gateway] Connected as ${c.user.tag}`);
  });

  client.login(token);
}

export function getGatewayStatus(): 'connected' | 'connecting' | 'disconnected' {
  if (!client) return 'disconnected';
  if (client.isReady()) return 'connected';
  return 'connecting';
}
```

### Pattern 2: SSE Endpoint with Channel Filtering

**What:** An SSE endpoint that streams MESSAGE_CREATE events for a specific channel to connected browser clients.

**When to use:** Browser connects after loading message history, stays connected for live updates.

**Example:**
```typescript
// Addition to discord-bridge/src/index.ts
import { streamSSE } from 'hono/streaming';
import { gatewayEvents, getGatewayStatus } from './gateway.js';

// GET /api/channels/:channelId/events (SSE)
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
        // Client disconnected, handler will be cleaned up below
      }
    };

    gatewayEvents.on(`message:${channelId}`, handler);

    stream.onAbort(() => {
      gatewayEvents.off(`message:${channelId}`, handler);
    });

    // Keep connection alive with periodic heartbeat
    while (true) {
      await stream.writeSSE({
        event: 'heartbeat',
        data: JSON.stringify({ t: Date.now() }),
      });
      await stream.sleep(30000); // 30s heartbeat
    }
  });
});

// GET /api/gateway/status
app.get('/api/gateway/status', (c) => {
  return c.json({ status: getGatewayStatus() });
});
```

### Pattern 3: Browser SSE Client with EventSource

**What:** The browser connects to the SSE endpoint after loading initial message history, then appends new messages as they arrive.

**When to use:** Inside useMessages hook, after initial fetch completes.

**Example:**
```typescript
// Extension to useMessages.ts
useEffect(() => {
  if (!channelId) return;

  const eventSource = new EventSource(`/api/discord/channels/${channelId}/events`);

  eventSource.addEventListener('message', (e) => {
    const newMessage: DiscordMessage = JSON.parse(e.data);
    setMessages((prev) => [...prev, newMessage]);
  });

  eventSource.addEventListener('status', (e) => {
    const { gateway } = JSON.parse(e.data);
    setGatewayStatus(gateway);
  });

  eventSource.onerror = () => {
    // EventSource auto-reconnects; update status indicator
    setGatewayStatus('reconnecting');
  };

  return () => {
    eventSource.close();
  };
}, [channelId]);
```

### Pattern 4: Auto-Scroll with IntersectionObserver Sentinel

**What:** An invisible sentinel element at the bottom of the message list. When visible (user is at bottom), new messages auto-scroll into view. When not visible (user scrolled up), auto-scroll stops and a "new messages" indicator appears.

**When to use:** Always, in the MessageList component.

**Example:**
```typescript
// lens-editor/src/components/DiscussionPanel/useAutoScroll.ts
import { useRef, useState, useCallback, useEffect } from 'react';

interface AutoScrollResult {
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  isAtBottom: boolean;
  scrollToBottom: () => void;
  unseenCount: number;
  resetUnseen: () => void;
}

export function useAutoScroll(messageCount: number): AutoScrollResult {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [unseenCount, setUnseenCount] = useState(0);
  const prevCountRef = useRef(messageCount);

  // Track whether sentinel is visible
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsAtBottom(entry.isIntersecting);
        if (entry.isIntersecting) {
          setUnseenCount(0); // Reset when user scrolls to bottom
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  // When new messages arrive
  useEffect(() => {
    const newCount = messageCount - prevCountRef.current;
    prevCountRef.current = messageCount;

    if (newCount <= 0) return;

    if (isAtBottom) {
      // Auto-scroll to new message
      sentinelRef.current?.scrollIntoView({ behavior: 'smooth' });
    } else {
      // User scrolled up, increment unseen counter
      setUnseenCount((c) => c + newCount);
    }
  }, [messageCount, isAtBottom]);

  const scrollToBottom = useCallback(() => {
    sentinelRef.current?.scrollIntoView({ behavior: 'smooth' });
    setUnseenCount(0);
  }, []);

  const resetUnseen = useCallback(() => setUnseenCount(0), []);

  return { sentinelRef, containerRef, isAtBottom, scrollToBottom, unseenCount, resetUnseen };
}
```

### Pattern 5: Discord Markdown Rendering

**What:** Parse Discord-flavored markdown into an AST using discord-markdown-parser, then render the AST to React elements.

**When to use:** For every message's content in MessageItem.

**Example:**
```typescript
// lens-editor/src/components/DiscussionPanel/DiscordMarkdown.tsx
import { parse } from 'discord-markdown-parser';
import type { ReactNode } from 'react';

interface ASTNode {
  type: string;
  content?: ASTNode[] | string;
  target?: string;
  lang?: string;
  id?: string;
}

function renderNodes(nodes: ASTNode[]): ReactNode[] {
  return nodes.map((node, i) => renderNode(node, i));
}

function renderNode(node: ASTNode, key: number): ReactNode {
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.content as string;

  switch (node.type) {
    case 'strong':
      return <strong key={key}>{renderNodes(node.content as ASTNode[])}</strong>;
    case 'em':
      return <em key={key}>{renderNodes(node.content as ASTNode[])}</em>;
    case 'underline':
      return <u key={key}>{renderNodes(node.content as ASTNode[])}</u>;
    case 'strikethrough':
      return <del key={key}>{renderNodes(node.content as ASTNode[])}</del>;
    case 'inlineCode':
      return (
        <code key={key} className="bg-gray-100 px-1 py-0.5 rounded text-sm font-mono">
          {node.content as string}
        </code>
      );
    case 'codeBlock':
      return (
        <pre key={key} className="bg-gray-100 p-2 rounded text-sm font-mono overflow-x-auto my-1">
          <code>{node.content as string}</code>
        </pre>
      );
    case 'blockQuote':
      return (
        <blockquote key={key} className="border-l-4 border-gray-300 pl-2 my-1">
          {renderNodes(node.content as ASTNode[])}
        </blockquote>
      );
    case 'spoiler':
      return (
        <span key={key} className="bg-gray-700 text-gray-700 hover:bg-transparent hover:text-inherit rounded px-0.5 cursor-pointer transition-colors">
          {renderNodes(node.content as ASTNode[])}
        </span>
      );
    case 'url':
    case 'autolink':
      return (
        <a key={key} href={node.target} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
          {renderNodes(node.content as ASTNode[])}
        </a>
      );
    case 'br':
      return <br key={key} />;
    default:
      // Fallback: render content if present
      if (Array.isArray(node.content)) {
        return <span key={key}>{renderNodes(node.content)}</span>;
      }
      return <span key={key}>{String(node.content ?? '')}</span>;
  }
}

interface DiscordMarkdownProps {
  content: string;
}

export function DiscordMarkdown({ content }: DiscordMarkdownProps) {
  if (!content) return null;
  const ast = parse(content, 'normal');
  return <>{renderNodes(ast as ASTNode[])}</>;
}
```

### Pattern 6: "New Messages" Indicator Bar

**What:** A floating bar at the bottom of the message list that appears when the user has scrolled up and new messages arrive.

**When to use:** When unseenCount > 0 from useAutoScroll.

**Example:**
```typescript
// lens-editor/src/components/DiscussionPanel/NewMessagesBar.tsx
interface NewMessagesBarProps {
  count: number;
  onClick: () => void;
}

export function NewMessagesBar({ count, onClick }: NewMessagesBarProps) {
  if (count === 0) return null;

  return (
    <button
      onClick={onClick}
      className="absolute bottom-2 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-full shadow-lg hover:bg-blue-700 transition-colors z-10"
    >
      {count === 1 ? '1 new message' : `${count} new messages`}
    </button>
  );
}
```

### Anti-Patterns to Avoid

- **Creating a dedicated bot when not needed:** For read-only Gateway usage, sharing LucDevBot2 is safe and simpler. A dedicated bot adds operational overhead for no benefit.
- **Polling the REST API instead of using Gateway:** Polling the messages endpoint every N seconds would hit rate limits quickly and add 1-5s latency. Gateway delivers events in under 1 second.
- **Using WebSocket for bridge-to-browser when SSE suffices:** Phase 2 is server-to-client only (no message sending). SSE is simpler, auto-reconnects via EventSource API, and works through Vite's HTTP proxy without additional WebSocket proxy config.
- **Reconnecting SSE manually:** The browser's `EventSource` API auto-reconnects on disconnection. Do not implement custom retry logic -- just handle the `onerror` event for UI status updates.
- **Parsing markdown on every render:** Parse the AST once when the message arrives. If using React, memoize the parsed result with `useMemo` keyed on `message.content`.
- **Auto-scrolling unconditionally:** Always check if the user is at the bottom before scrolling. Unconditional scrolling is the #1 UX complaint in chat implementations.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Discord Gateway connection | Raw WebSocket with heartbeat/resume logic | `discord.js` Client | Gateway protocol has heartbeat, sequence tracking, resume, reconnect, identify rate limiting, compression. discord.js handles all of it. |
| Discord markdown parsing | Regex for **bold**, *italic*, etc. | `discord-markdown-parser` | Discord markdown has 15+ formatting types with complex nesting rules, escape sequences, and code block interactions. |
| SSE streaming | Manual `res.write()` with headers | Hono `streamSSE` helper | Handles headers, keepalive, connection cleanup, abort detection automatically. |
| SSE client reconnection | Custom retry/backoff logic | Browser `EventSource` API | Built-in auto-reconnect with exponential backoff. It's a Web Standard. |
| Scroll position detection | Manual scroll event math | `IntersectionObserver` on sentinel | More performant than scroll event listeners; no scroll position calculations; handles edge cases like container resizing. |

**Key insight:** The Gateway protocol is the single most complex piece here. discord.js abstracts away heartbeating (Opcode 1), session resume (Opcode 6), identify rate limiting, guild-unavailable handling, and WebSocket compression. Building this by hand would be hundreds of lines of error-prone code.

## Common Pitfalls

### Pitfall 1: EventSource and Vite Proxy

**What goes wrong:** SSE events don't arrive in the browser during development; the connection appears to hang.
**Why it happens:** Vite's HTTP proxy may buffer SSE responses. Some proxy configurations don't properly handle `Transfer-Encoding: chunked` or `Content-Type: text/event-stream`.
**How to avoid:** Ensure the Vite proxy for `/api/discord` passes through SSE responses without buffering. The existing Vite proxy config should work since it uses `changeOrigin: true` and `rewrite`. If buffering occurs, verify that no compression middleware is applied to the SSE route.
**Warning signs:** EventSource connection stays in "connecting" state; messages appear in batches rather than individually.

### Pitfall 2: Memory Leak from EventSource Not Being Closed

**What goes wrong:** Multiple EventSource connections accumulate when switching between documents.
**Why it happens:** The useEffect cleanup function doesn't call `eventSource.close()`, or the component unmounts before the cleanup runs.
**How to avoid:** Always call `eventSource.close()` in the useEffect cleanup. Use `AbortController` pattern if needed. The existing `key={activeDocId}` on EditorArea forces full unmount/remount, which triggers cleanup.
**Warning signs:** Network tab shows multiple SSE connections for the same channel; memory usage grows over time.

### Pitfall 3: Message Ordering with SSE + Initial Fetch

**What goes wrong:** Duplicate messages or gaps when SSE events arrive during or just after the initial REST fetch.
**Why it happens:** The REST fetch returns the latest 50 messages, but a MESSAGE_CREATE event may fire for a message that was already included in the REST response. Or an event fires after the REST request but before SSE connects.
**How to avoid:** (1) Connect SSE first, buffer events. (2) Fetch initial messages via REST. (3) Deduplicate: only append SSE messages whose ID is not already in the message list. Discord message IDs are snowflakes (monotonically increasing), so comparison is simple.
**Warning signs:** The same message appears twice in the panel; messages appear to be missing.

### Pitfall 4: Gateway Intent Mismatch

**What goes wrong:** Gateway connects but no MESSAGE_CREATE events are received.
**Why it happens:** The GuildMessages or MessageContent privileged intent is not enabled. Phase 1 research noted that MESSAGE_CONTENT must be enabled in the Discord Developer Portal.
**How to avoid:** Verify that LucDevBot2 has the MESSAGE_CONTENT privileged intent enabled in the Discord Developer Portal (Bot > Privileged Gateway Intents). This was already required for the REST API in Phase 1, so it should already be enabled.
**Warning signs:** Gateway connects (ClientReady fires) but messageCreate event never fires.

### Pitfall 5: SSE Connection Limit per Domain

**What goes wrong:** Opening many documents with different discussion channels exhausts the browser's connection limit.
**Why it happens:** HTTP/1.1 browsers limit to 6 concurrent connections per domain. Each SSE connection is persistent, so 7+ channels would block other HTTP requests.
**How to avoid:** Only maintain ONE SSE connection at a time -- for the currently active document. Close the previous connection when switching documents. The component lifecycle already handles this (useEffect cleanup on channelId change).
**Warning signs:** New document loads fail or hang after opening several discussion documents.

### Pitfall 6: Gateway Reconnection After Sleep/Network Change

**What goes wrong:** After laptop sleep or network change, the Gateway connection drops and doesn't recover.
**Why it happens:** discord.js should auto-resume, but edge cases exist.
**How to avoid:** discord.js handles reconnection automatically. Add logging for the `shardReconnecting` and `shardResume` events so you can monitor behavior. The SSE heartbeat (30s interval) will also help detect dropped browser connections.
**Warning signs:** Gateway status shows "disconnected" persistently; bridge sidecar logs show no reconnection attempts.

## Code Examples

### discord.js Minimal Client for Gateway (Verified Pattern)

```typescript
// Source: discord.js guide + official docs
// Minimal client that only receives message events
import { Client, GatewayIntentBits, Events } from 'discord.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,          // Required base intent
    GatewayIntentBits.GuildMessages,   // Receive MESSAGE_CREATE in guilds
    GatewayIntentBits.MessageContent,  // Receive message content (privileged)
  ],
});

client.on(Events.ClientReady, (c) => {
  console.log(`Gateway ready as ${c.user.tag}`);
});

client.on(Events.MessageCreate, (message) => {
  // message.channelId, message.content, message.author, etc.
  console.log(`[${message.channelId}] ${message.author.username}: ${message.content}`);
});

// discord.js handles heartbeat, resume, reconnect automatically
await client.login(process.env.DISCORD_BOT_TOKEN);
```

### Hono SSE Streaming (Verified Pattern)

```typescript
// Source: hono.dev/docs/helpers/streaming
import { streamSSE } from 'hono/streaming';

app.get('/api/channels/:channelId/events', async (c) => {
  const { channelId } = c.req.param();

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: 'connected',
      data: JSON.stringify({ channelId }),
      id: '0',
    });

    const handler = async (data: unknown) => {
      await stream.writeSSE({
        event: 'message',
        data: JSON.stringify(data),
      });
    };

    gatewayEvents.on(`message:${channelId}`, handler);

    stream.onAbort(() => {
      gatewayEvents.off(`message:${channelId}`, handler);
    });

    // Keepalive heartbeat
    while (true) {
      await stream.writeSSE({ event: 'heartbeat', data: '' });
      await stream.sleep(30000);
    }
  });
});
```

### Browser EventSource (Web Standard)

```typescript
// Source: MDN Web API docs
const eventSource = new EventSource('/api/discord/channels/123/events');

eventSource.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  // Append to message list
});

eventSource.addEventListener('status', (e) => {
  const { gateway } = JSON.parse(e.data);
  // Update status indicator
});

eventSource.onerror = () => {
  // EventSource auto-reconnects
  // Update UI to show "reconnecting..."
};

// Cleanup
eventSource.close();
```

### IntersectionObserver for Scroll Detection (Web Standard)

```typescript
// Source: MDN IntersectionObserver API
const sentinel = document.querySelector('#scroll-sentinel');
const observer = new IntersectionObserver(
  ([entry]) => {
    const isAtBottom = entry.isIntersecting;
    // If at bottom, auto-scroll new messages into view
    // If not at bottom, show "new messages" indicator
  },
  { threshold: 0.1 }
);

observer.observe(sentinel);
```

### Message Deduplication (SSE + REST overlap)

```typescript
// Discord snowflake IDs are monotonically increasing
// Simple dedup: only append messages with ID > last known ID
function appendNewMessage(
  messages: DiscordMessage[],
  newMsg: DiscordMessage
): DiscordMessage[] {
  // Check if message already exists (by ID)
  if (messages.some((m) => m.id === newMsg.id)) {
    return messages; // Already have it
  }
  return [...messages, newMsg];
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Polling REST API for new messages | Gateway WebSocket for real-time events | Always (Gateway is the standard) | Sub-second delivery vs polling interval delay |
| Long polling for server-to-browser | SSE (Server-Sent Events) | Mature standard | Auto-reconnect, simpler than WebSocket for uni-directional |
| Manual scroll event listeners for chat | IntersectionObserver sentinel | 2019+ (broad browser support) | More performant, no scroll position math |
| `discord-markdown` (brussell98, HTML output) | `discord-markdown-parser` (ItzDerock, AST output) | 2023+ | AST enables React rendering; actively maintained; zero deps |
| discord.js v13 | discord.js v14.25.1 | 2022 | Requires Node 18+; uses `GatewayIntentBits` enum; `Events` enum for event names |

**Deprecated/outdated:**
- `discord-markdown` package: Last updated 2018 (v2.1.0). Not actively maintained. Outputs HTML strings which require `dangerouslySetInnerHTML` in React.
- Scroll event listeners for auto-scroll: IntersectionObserver is more performant and handles edge cases better.
- Manual heartbeat/resume for Discord Gateway: discord.js handles this completely. Never hand-roll Gateway protocol.

## Open Questions

1. **discord-markdown-parser AST types**
   - What we know: The library exports a `parse()` function that returns an AST array. Node types include text, strong, em, codeBlock, blockQuote, spoiler, etc.
   - What's unclear: The exact TypeScript type definitions for AST nodes are not fully documented. The library exports types but they may need augmentation.
   - Recommendation: Install the library and inspect its TypeScript definitions. Build the renderer incrementally, handling node types as they appear in real Discord messages from the test channel.

2. **SSE through Vite proxy buffering**
   - What we know: Vite's proxy is based on `http-proxy` which generally passes through streaming responses.
   - What's unclear: Whether Vite's dev server adds any compression or buffering that would interfere with SSE.
   - Recommendation: Test early. If buffering occurs, disable compression for the SSE route or use a direct connection to the bridge port (bypass Vite proxy) during development.

3. **Gateway connection startup time**
   - What we know: discord.js needs to complete the identify/ready handshake before receiving events. This typically takes 1-5 seconds.
   - What's unclear: Whether there's a race condition where a message posted immediately after bridge startup could be missed.
   - Recommendation: Accept this as a known limitation. The initial REST fetch provides recent history; the Gateway provides ongoing events. A brief gap at startup is acceptable.

## Sources

### Primary (HIGH confidence)
- Discord API discussion #5990 -- Discord maintainer confirms multiple Gateway connections with same token are supported with different intents
- Hono streaming docs (hono.dev/docs/helpers/streaming) -- SSE helper API, writeSSE, onAbort, sleep
- discord.js guide (discordjs.guide) -- Client setup, intents, event handling
- discord-markdown-parser GitHub (ItzDerock/discord-markdown-parser) -- AST parser, zero deps, v1.3.1 released Dec 2025
- MDN Web APIs -- EventSource, IntersectionObserver (Web Standards)

### Secondary (MEDIUM confidence)
- Discord API Gateway docs (discord.com/developers/docs/events/gateway) -- Session start limits (1000/day), identify rate limits, shard behavior
- Community reports on duplicate events with same shard -- Multiple GitHub issues (discordjs/discord.js #7355, #5581, #6601) confirm both sessions receive events
- Glitch community forum -- Confirms "bot runs twice" pattern when two processes connect with same token

### Tertiary (LOW confidence)
- Specific behavior when two processes use shard [0,1] simultaneously -- Inferred from community experience, not explicitly documented in official Gateway docs. The official docs describe sharding for scaling (splitting guilds) but don't explicitly address the "two connections on same shard" scenario. Community evidence is strong but not official.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- discord.js and Hono SSE are well-documented, widely used
- Architecture (SSE + Gateway pattern): HIGH -- Standard real-time architecture, all components are well-established
- Discord markdown rendering: HIGH -- discord-markdown-parser is actively maintained, zero deps, built on same parser Discord uses
- Auto-scroll pattern: HIGH -- IntersectionObserver is a mature Web Standard, pattern is well-established
- Bot token sharing safety: MEDIUM -- Supported by Discord maintainer confirmation and community experience, but specific shard duplication behavior not explicitly documented in official docs
- Pitfalls: HIGH -- Well-documented failure modes from community experience

**Research date:** 2026-02-10
**Valid until:** 2026-03-12 (30 days -- Discord API and discord.js are stable)
