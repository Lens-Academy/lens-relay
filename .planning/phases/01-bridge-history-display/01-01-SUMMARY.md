---
phase: 01-bridge-history-display
plan: 01
subsystem: utility-functions
tags: [frontmatter, discord, avatar, timestamp, tdd, vitest]
requires: []
provides:
  - extractFrontmatter function for Y.Doc text parsing
  - parseDiscordUrl function for channel URL decomposition
  - getAvatarUrl function for Discord CDN avatar URLs
  - formatTimestamp shared function (ISO string + epoch millis)
affects:
  - 01-02 (DiscussionPanel UI depends on these utilities)
  - 01-03 (Discord bridge uses parseDiscordUrl and formatTimestamp)
tech-stack:
  added: [front-matter]
  patterns: [pure-function-utilities, tdd-red-green-refactor, shared-module-extraction]
key-files:
  created:
    - lens-editor/src/lib/frontmatter.ts
    - lens-editor/src/lib/frontmatter.test.ts
    - lens-editor/src/lib/discord-url.ts
    - lens-editor/src/lib/discord-url.test.ts
    - lens-editor/src/lib/discord-avatar.ts
    - lens-editor/src/lib/discord-avatar.test.ts
    - lens-editor/src/lib/format-timestamp.ts
    - lens-editor/src/lib/format-timestamp.test.ts
  modified:
    - lens-editor/package.json
    - lens-editor/package-lock.json
    - lens-editor/src/components/CommentsPanel/CommentsPanel.tsx
key-decisions:
  - "formatTimestamp accepts string|number union type for dual Discord API (ISO strings) and CommentsPanel (epoch millis) compatibility"
  - "front-matter npm package used for YAML parsing (robust, well-tested) rather than hand-rolling regex"
  - "Default Discord avatar index uses BigInt arithmetic to handle snowflake IDs correctly"
duration: 4min
completed: 2026-02-10
---

# Phase 1 Plan 01: Utility Functions Summary

**Four pure TDD-tested utility modules: frontmatter extraction via front-matter package, Discord URL parsing with regex, CDN avatar URL construction with animated/default support, and shared timestamp formatting extracted from CommentsPanel.**

## Performance

- Duration: 4 minutes
- TDD cycle: RED (29 failing tests) -> GREEN (31 passing tests) -> REFACTOR (CommentsPanel extraction, 75 total tests pass)

## Accomplishments

1. **frontmatter.ts** - Extracts YAML frontmatter from markdown text using the `front-matter` npm package. Handles missing delimiters, malformed YAML, and Windows line endings gracefully (returns null). 9 test cases.

2. **discord-url.ts** - Parses Discord channel URLs (`https://discord.com/channels/{guildId}/{channelId}`) into structured objects. Handles http/https, www prefix, trailing slashes. Returns null for invalid inputs. 9 test cases.

3. **discord-avatar.ts** - Constructs Discord CDN avatar URLs. Supports custom avatars (PNG), animated avatars (GIF, hash starts with `a_`), and default avatars (computed from user ID using BigInt shift). Configurable size parameter. 5 test cases.

4. **format-timestamp.ts** - Formats timestamps as relative ("just now", "5m ago", "3h ago", "2d ago") or absolute ("Jun 1", "Jan 15, 2024"). Accepts both ISO 8601 strings (Discord API) and epoch milliseconds (CommentsPanel). 8 test cases.

5. **CommentsPanel refactor** - Removed the local `formatTimestamp` function definition and replaced it with an import from the shared module. All 44 existing CommentsPanel tests pass without modification.

## Task Commits

| Task | Name | Change ID | Type |
|------|------|-----------|------|
| 1 | Install front-matter and create tests (RED) | tluzoyrxtnll | test |
| 2 | Implement utilities and refactor CommentsPanel (GREEN) | kwqnsltpxypx | feat |

## Files Created/Modified

**Created:**
- `lens-editor/src/lib/frontmatter.ts` - extractFrontmatter()
- `lens-editor/src/lib/frontmatter.test.ts` - 9 test cases
- `lens-editor/src/lib/discord-url.ts` - parseDiscordUrl()
- `lens-editor/src/lib/discord-url.test.ts` - 9 test cases
- `lens-editor/src/lib/discord-avatar.ts` - getAvatarUrl()
- `lens-editor/src/lib/discord-avatar.test.ts` - 5 test cases
- `lens-editor/src/lib/format-timestamp.ts` - formatTimestamp()
- `lens-editor/src/lib/format-timestamp.test.ts` - 8 test cases

**Modified:**
- `lens-editor/package.json` - added front-matter dependency
- `lens-editor/package-lock.json` - lockfile update
- `lens-editor/src/components/CommentsPanel/CommentsPanel.tsx` - replaced local formatTimestamp with shared import

## Decisions Made

1. **formatTimestamp accepts `string | number`** - The Discord API returns ISO 8601 strings, while CommentsPanel passes epoch millis. A union type input avoids breaking the existing CommentsPanel while supporting Discord data.

2. **front-matter package for YAML parsing** - Using the established npm package rather than hand-rolling regex ensures robust edge case handling (malformed YAML, empty frontmatter, various delimiters).

3. **BigInt for Discord snowflake ID arithmetic** - Discord user IDs are 64-bit snowflakes that exceed Number.MAX_SAFE_INTEGER. Default avatar index calculation uses `(BigInt(userId) >> 22n) % 6n` for correctness.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Unrelated `discord-bridge/` files from another workspace appeared in jj working copy during commits. Required careful file-specific restoration to exclude them.

## Next Phase Readiness

Plan 01-02 (Discord bridge sidecar proxy) can proceed immediately. All four utility functions are available:
- `extractFrontmatter(text)` -> `DocFrontmatter | null`
- `parseDiscordUrl(url)` -> `DiscordChannel | null`
- `getAvatarUrl(userId, avatarHash, size?)` -> `string`
- `formatTimestamp(input: string | number)` -> `string`
