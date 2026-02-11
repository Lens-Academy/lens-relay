---
phase: 03-posting-messages
plan: 01
subsystem: api
tags: [discord, bot-api, hono, proxy, validation]

# Dependency graph
requires:
  - phase: 01-read-only-panel
    provides: discord-bridge sidecar with Hono HTTP server, error handling patterns
provides:
  - POST /api/channels/:channelId/messages bot message proxy endpoint
  - sendBotMessage function for Discord bot API message posting
affects: [03-posting-messages, lens-editor compose UI]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Bot API proxy pattern: browser sends content+username, bridge formats with suffix and posts via bot token"

key-files:
  created: []
  modified:
    - discord-bridge/src/discord-client.ts
    - discord-bridge/src/index.ts

key-decisions:
  - "Bot API instead of webhooks: uses existing DISCORD_BOT_TOKEN, no additional webhook URL needed"
  - "Server-side formatting: message content formatted as '**DisplayName (unverified):** content'"
  - "Username validation: requires non-empty username, content ≤2000 chars"

patterns-established:
  - "Bot API proxy: never expose bot token to browser; bridge constructs request internally"
  - "Server-side username suffix: ' (unverified)' formatted in endpoint handler, not in client code"

# Metrics
duration: 10min
completed: 2026-02-11
---

# Phase 3 Plan 1: Bot Message Proxy Endpoint Summary

**POST bot message proxy endpoint in discord-bridge with input validation, server-side (unverified) suffix, using bot API**

## Performance

- **Duration:** 10 min (original + refactoring)
- **Started:** 2026-02-11T09:09:30Z
- **Completed:** 2026-02-11T09:40:00Z
- **Tasks:** 2 + 1 orchestrator refactoring
- **Files modified:** 3

## Accomplishments
- sendBotMessage function exported from discord-client (POST to Discord bot API)
- POST /api/channels/:channelId/messages endpoint with input validation (content required ≤2000 chars, username required)
- Server-side "(unverified)" suffix formatted into message content
- Bot token never exposed in any API response or client-facing code

## Task Commits

1. **Task 1: Add WebhookPayload type and executeWebhook function** - `a495d5e7` (feat) [original webhook approach]
2. **Task 2: Add POST webhook proxy endpoint** - `a3c950a0` (feat) [original webhook approach]
3. **Orchestrator: Switch from webhook to bot API** - `e03c1867` (refactor) [replaced webhook with sendBotMessage]

## Files Modified
- `discord-bridge/src/discord-client.ts` - Added sendBotMessage function (removed executeWebhook, webhook URL resolution)
- `discord-bridge/src/index.ts` - POST endpoint uses sendBotMessage with formatted content
- `discord-bridge/src/types.ts` - Removed WebhookPayload (no longer needed)

## Decisions Made
- User preferred bot API over webhooks: simpler setup (no webhook URL needed), uses existing bot token
- Message format: `**DisplayName (unverified):** content` — bot posts the formatted message content
- Messages appear under the bot's identity in Discord (vs webhook which would show custom avatar/name)

## Deviations from Plan

- **Major:** Plan specified webhook-based approach with DISCORD_WEBHOOK_MAP/DISCORD_WEBHOOK_URL env vars. User redirected to bot API approach mid-execution. Refactored in commit `e03c1867`.

---
*Phase: 03-posting-messages*
*Completed: 2026-02-11*
