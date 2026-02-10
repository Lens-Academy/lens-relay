# Project State: Discord Discussion Panel

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-08)

**Core value:** Users can participate in the Discord discussion about a document without leaving the editor.
**Current focus:** Phase 2 - Live Streaming (Discord markdown rendering complete)

## Position

- **Current phase:** 2 of 4 (Live Streaming)
- **Plan:** 2 of 3 in phase complete
- **Status:** In progress
- **Last activity:** 2026-02-10 - Completed 02-02-PLAN.md (Discord markdown rendering)

Progress: `[#####...] 4/6 plans (67%)`

## Recent Decisions

| Decision | Made In | Rationale |
|----------|---------|-----------|
| AST-to-React rendering for Discord markdown | 02-02 | Safe XSS-free rendering without dangerouslySetInnerHTML |
| Graceful fallback for unresolved Discord mentions | 02-02 | Mentions need API calls to resolve; show styled placeholder badges |
| div wrapper instead of p for message content | 02-02 | DiscordMarkdown renders block-level elements (pre, blockquote) invalid inside p |
| ConnectedDiscussionPanel wrapper pattern | 01-03 | Separates YDocProvider context from testable component |
| APP badge for bot messages | 01-03 | Matches Discord native UI, user-requested enhancement |
| host: true in vite.config.ts | 01-03 | Required for dev.vps tunnel access |
| LucDevBot2 token from lens-platform | 01-02 | REST-only bridge (no Gateway), safe to reuse existing bot |
| formatTimestamp accepts `string\|number` union | 01-01 | Dual Discord API (ISO) and CommentsPanel (epoch) compatibility |
| front-matter npm package for YAML parsing | 01-01 | Robust edge case handling vs hand-rolled regex |
| BigInt for Discord snowflake ID arithmetic | 01-01 | User IDs exceed Number.MAX_SAFE_INTEGER |

## Blockers

(None)

## Session Continuity

- **Last session:** 2026-02-10
- **Stopped at:** Completed 02-02-PLAN.md (Discord markdown rendering)
- **Resume file:** .planning/phases/02-live-streaming/02-03-PLAN.md

---
*Last updated: 2026-02-10 after completing plan 02-02*
