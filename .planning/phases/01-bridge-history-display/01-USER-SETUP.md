# Phase 1: User Setup Required

**Generated:** 2026-02-10
**Phase:** 01-bridge-history-display
**Status:** Complete (using LucDevBot2 from lens-platform)

## Environment Variables

| Status | Variable | Source | Add to |
|--------|----------|--------|--------|
| [x] | `DISCORD_BOT_TOKEN` | Discord Developer Portal -> Your App -> Bot -> Token | Shell env or `.env` in discord-bridge/ |

## Dashboard Configuration

- [x] **Create a Discord bot application** (if not already done)
  - Location: Discord Developer Portal -> New Application
- [x] **Enable MESSAGE_CONTENT privileged intent**
  - Location: Discord Developer Portal -> Your App -> Bot -> Privileged Gateway Intents -> MESSAGE CONTENT
- [x] **Invite bot to the guild containing target channels**
  - Location: Discord Developer Portal -> Your App -> OAuth2 -> URL Generator -> Scopes: bot -> Permissions: Read Messages/View Channels, Read Message History

## Running the Bridge

```bash
export DISCORD_BOT_TOKEN="your-bot-token"
cd discord-bridge && npm run dev
```

## Verification

```bash
# Health check
curl http://localhost:8091/health

# Fetch messages (replace CHANNEL_ID)
curl http://localhost:8091/api/channels/CHANNEL_ID/messages?limit=5
```

---
**Status:** Complete — verified with LucDevBot2 token from lens-platform against Luc Dev server #general channel.
