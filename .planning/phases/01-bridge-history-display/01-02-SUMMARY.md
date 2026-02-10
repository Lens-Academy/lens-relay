---
phase: 01-bridge-history-display
plan: 02
subsystem: infra
tags: [hono, discord-api, proxy, vite, typescript, node]

requires: []
provides:
  - "Discord bridge sidecar proxy at discord-bridge/"
  - "Vite proxy route /api/discord -> sidecar"
  - "Real Discord API fixtures for component tests"
affects: [01-03, 02-live-streaming, 03-posting-messages]

tech-stack:
  added: [hono, "@hono/node-server", tsx]
  patterns: ["sidecar proxy for API key isolation", "Vite dev proxy for CORS-free development"]

key-files:
  created:
    - discord-bridge/package.json
    - discord-bridge/src/index.ts
    - discord-bridge/src/discord-client.ts
    - discord-bridge/src/types.ts
    - discord-bridge/tsconfig.json
    - lens-editor/src/components/DiscussionPanel/__fixtures__/discord-messages.json
    - lens-editor/src/components/DiscussionPanel/__fixtures__/discord-channel.json
  modified:
    - lens-editor/vite.config.ts
    - lens-editor/package.json

key-decisions:
  - "Used Hono + @hono/node-server for minimal sidecar (14KB vs Express 572KB)"
  - "In-memory caching with TTL (60s messages, 5min channel info) to avoid Discord rate limits"
  - "Workspace-aware port detection (ws1=8091, ws2=8191)"

duration: 10min
completed: 2026-02-10
---

# Phase 1 Plan 02: Discord Bridge Sidecar Summary

**Hono-based sidecar proxy keeping Discord bot token server-side with in-memory caching, Vite proxy config, and real API fixtures captured from Luc Dev server**

## Performance

- **Duration:** 10 min
- **Started:** 2026-02-10T12:00:00Z
- **Completed:** 2026-02-10T12:10:00Z
- **Tasks:** 4
- **Files modified:** 9

## Accomplishments
- Discord bridge sidecar at `discord-bridge/` with Hono HTTP framework
- REST proxy for `/api/channels/:channelId/messages` and `/api/channels/:channelId`
- In-memory caching with 60s/5min TTL to avoid Discord rate limits
- Rate limit (429) and error handling with structured error responses
- Vite proxy route `/api/discord/*` -> sidecar for CORS-free development
- Real Discord API fixtures captured from #general channel (50 messages)

## Task Commits

Each task was committed atomically:

1. **Task 1: Create discord-bridge sidecar project** - `oqwnkxst` (feat)
2. **Task 2: Configure Vite proxy + npm scripts** - `umlsrzmy` (feat)
3. **Task 3: Human verification** - checkpoint (approved via orchestrator)
4. **Task 4: Capture real Discord API fixtures** - `ttzuomto` (feat)

**Plan metadata:** (combined with phase completion commit)

## Files Created/Modified
- `discord-bridge/package.json` - Sidecar project definition with hono, tsx
- `discord-bridge/tsconfig.json` - TypeScript config (ES2022, ESNext, bundler)
- `discord-bridge/src/types.ts` - DiscordUser, DiscordMessage, DiscordChannel interfaces
- `discord-bridge/src/discord-client.ts` - REST API wrapper with caching and rate limit handling
- `discord-bridge/src/index.ts` - Hono server with health, messages, channel endpoints
- `lens-editor/vite.config.ts` - Added /api/discord proxy route
- `lens-editor/package.json` - Added discord:start and discord:setup scripts
- `lens-editor/src/components/DiscussionPanel/__fixtures__/discord-messages.json` - 50 real Discord messages
- `lens-editor/src/components/DiscussionPanel/__fixtures__/discord-channel.json` - #general channel info

## Decisions Made
- Used Hono instead of Express (14KB vs 572KB, TypeScript-native)
- In-memory cache instead of Redis (sidecar is single-process, no persistence needed)
- Workspace-aware port detection from cwd path (ws1=8091, ws2=8191)
- Used LucDevBot2 token from lens-platform for verification

## Deviations from Plan

None - plan executed as written.

## Issues Encountered
None

## User Setup Required

**External services require manual configuration.** See [01-USER-SETUP.md](./01-USER-SETUP.md) for:
- DISCORD_BOT_TOKEN environment variable
- Discord Developer Portal configuration
- Bot permissions and intents

## Next Phase Readiness
- Bridge sidecar ready for DiscussionPanel integration (Plan 01-03)
- Fixtures captured for component test mocking
- Vite proxy configured for seamless frontend development

---
*Phase: 01-bridge-history-display*
*Completed: 2026-02-10*
