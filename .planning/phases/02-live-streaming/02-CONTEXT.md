# Phase 2: Live Streaming - Context

**Gathered:** 2026-02-10
**Status:** Ready for planning

<domain>
## Phase Boundary

After loading history (Phase 1), new messages posted in Discord appear in the panel in real time without page reload. Includes Discord markdown rendering and smart auto-scroll behavior. Posting messages from the editor is Phase 3.

</domain>

<decisions>
## Implementation Decisions

### Discord bot / Gateway strategy
- Phase 1 used LucDevBot2 (from lens-platform) with REST only — no Gateway connection
- Phase 2 needs a persistent Gateway (WebSocket) connection to receive real-time Discord events
- **Conflict concern:** lens-platform already maintains a Gateway connection using LucDevBot2. Two applications sharing the same bot token for Gateway connections may interfere with each other
- **Decision:** Researcher investigates whether relay-server and lens-platform can share the LucDevBot2 bot token for simultaneous Gateway connections, or whether a dedicated bot is needed
- **User wants to review** the researcher's proposal before it's locked in — this is not "Claude's discretion"

### Multi-instance scenarios to consider
- Dev-to-dev: ws1 and ws2 workspaces running simultaneously
- Prod-to-prod: relay-server and lens-platform (separate application at `code/lens-platform`) both connecting to Discord Gateway

### Claude's Discretion
- Discord markdown rendering approach (which library, how to handle edge cases)
- Auto-scroll implementation (threshold, animation)
- "New messages" indicator design and behavior
- SSE vs WebSocket choice for browser-to-bridge communication
- Connection status display

</decisions>

<specifics>
## Specific Ideas

- lens-platform (at `code/lens-platform`) is the existing Discord bot application that already uses the Gateway with LucDevBot2 — researcher should check its bot setup to understand the conflict surface

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 02-live-streaming*
*Context gathered: 2026-02-10*
