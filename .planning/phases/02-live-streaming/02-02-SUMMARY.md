---
phase: 02-live-streaming
plan: 02
subsystem: ui
tags: [discord, markdown, react, parser, ast]

# Dependency graph
requires:
  - phase: 01-bridge-history
    provides: MessageItem component rendering plain text messages
provides:
  - DiscordMarkdown component for Discord-flavored markdown rendering
  - MessageItem integration with formatted content display
affects: [02-live-streaming, ui-polish]

# Tech tracking
tech-stack:
  added: [discord-markdown-parser]
  patterns: [AST-to-React rendering, memoized parsing]

key-files:
  created:
    - lens-editor/src/components/DiscussionPanel/DiscordMarkdown.tsx
  modified:
    - lens-editor/src/components/DiscussionPanel/MessageItem.tsx
    - lens-editor/package.json
    - lens-editor/package-lock.json

key-decisions:
  - "AST-to-React rendering (no dangerouslySetInnerHTML) for safe markdown display"
  - "Graceful fallback for unresolved Discord mentions (show styled badge with raw ID)"
  - "Changed message wrapper from <p> to <div> for valid block-level nesting"

patterns-established:
  - "DiscordMarkdown: parse-then-render pattern with useMemo for content caching"
  - "Unresolved Discord entities (mentions, emoji) show placeholder badges rather than crashing"

# Metrics
duration: 7min
completed: 2026-02-10
---

# Phase 2 Plan 02: Discord Markdown Rendering Summary

**Discord markdown AST-to-React renderer via discord-markdown-parser with bold, italic, code, quotes, spoilers, and link support**

## Performance

- **Duration:** 7 min
- **Started:** 2026-02-10T14:11:18Z
- **Completed:** 2026-02-10T14:18:30Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- Created DiscordMarkdown component that parses Discord-flavored markdown into an AST and renders as React elements
- Integrated DiscordMarkdown into MessageItem, replacing plain text rendering in both header and grouped message variants
- Handles all standard Discord formatting: bold, italic, underline, strikethrough, inline code, code blocks, blockquotes, spoilers, links, and line breaks
- Graceful fallback for Discord-specific features (mentions, custom emoji) that require additional API calls to resolve

## Task Commits

Each task was committed atomically:

1. **Task 1: Install discord-markdown-parser and create DiscordMarkdown component** - `7ee1e5c6` (feat)
2. **Task 2: Replace plain text rendering with DiscordMarkdown in MessageItem** - `178f1518` (feat)

## Files Created/Modified
- `lens-editor/src/components/DiscussionPanel/DiscordMarkdown.tsx` - Discord markdown AST parser and React renderer with support for all standard formatting types
- `lens-editor/src/components/DiscussionPanel/MessageItem.tsx` - Updated to use DiscordMarkdown instead of plain text for message content
- `lens-editor/package.json` - Added discord-markdown-parser dependency
- `lens-editor/package-lock.json` - Updated lockfile

## Decisions Made
- Used AST-to-React rendering approach (no dangerouslySetInnerHTML) for safe, XSS-free markdown display
- Discord-specific nodes (user/channel/role mentions, custom emoji) render as styled placeholder badges since resolving IDs to names requires additional Discord API calls -- planned for a future phase
- Changed message content wrapper from `<p>` to `<div>` because DiscordMarkdown renders block-level elements (blockquote, pre) which are invalid inside `<p>` tags
- Removed `whitespace-pre-wrap` CSS since the markdown renderer handles line breaks via `<br>` tags

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- jj working copy management with concurrent workspace execution caused file tracking issues -- files written to disk were lost when jj auto-snapshotted and concurrent commits were inserted. Resolved by rebasing working copy to the correct parent commit and re-applying changes.
- The `discord-markdown-parser` package was already in node_modules from a prior npm install (present in lockfile) so the initial `npm install` didn't modify package.json. The dependency was added to package.json by the concurrent workspace's commit.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Message content now renders with full Discord markdown formatting
- Ready for Plan 03 (live streaming) which builds on the rendered message display
- Future enhancement: resolve Discord mentions by ID to display usernames/channel names

---
*Phase: 02-live-streaming*
*Completed: 2026-02-10*
