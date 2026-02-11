---
phase: 04-connection-resilience
plan: 01
subsystem: ui
tags: [sse, eventsource, reconnection, heartbeat, status-indicator, discord-gateway]

# Dependency graph
requires:
  - phase: 02-live-streaming
    provides: SSE streaming infrastructure (EventSource, gatewayEvents, heartbeat)
  - phase: 03-posting-messages
    provides: ComposeBox with DisplayNameProvider context
provides:
  - Gateway lifecycle events broadcast from bridge to SSE clients
  - Client-side SSE reconnection with automatic message history reload
  - Heartbeat timeout detection (75s stale connection detection)
  - Terminal disconnect handling with manual reconnect
  - StatusIndicator component with text labels (Live/Reconnecting/Disconnected)
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "SSE status forwarding: gateway lifecycle events emitted via EventEmitter, forwarded to all SSE clients"
    - "Stale closure avoidance: use setFetchTrigger state updater instead of capturing refetch in SSE useEffect"
    - "Heartbeat timeout: 2.5x heartbeat interval (75s) for stale connection detection"
    - "SSE reconnect trigger: state variable dependency forces EventSource recreation on terminal CLOSED"

key-files:
  created: []
  modified:
    - discord-bridge/src/gateway.ts
    - discord-bridge/src/index.ts
    - lens-editor/src/components/DiscussionPanel/useMessages.ts
    - lens-editor/src/components/DiscussionPanel/DiscussionPanel.tsx
    - lens-editor/src/components/DiscussionPanel/DiscussionPanel.test.tsx

key-decisions:
  - "onopen only clears 'Connection lost' error, not fetch errors"
  - "sseReconnectTrigger state variable forces EventSource recreation for terminal CLOSED recovery"
  - "75s heartbeat timeout (2.5x the 30s interval) balances false-positive avoidance with timely detection"

patterns-established:
  - "StatusIndicator: local component with switch-based rendering for connection states"
  - "MockEventSource test helpers: _simulateError/_simulateTerminalError/_simulateReconnect for SSE testing"

# Metrics
duration: 6min
completed: 2026-02-11
---

# Phase 4 Plan 1: Connection Resilience Summary

**SSE connection resilience with gateway status broadcasting, heartbeat timeout, terminal disconnect handling, and text-labeled status indicator**

## Performance

- **Duration:** 6 min
- **Started:** 2026-02-11T10:25:18Z
- **Completed:** 2026-02-11T10:31:34Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Gateway lifecycle events (connect, reconnect, disconnect) broadcast from Discord bridge to all SSE browser clients
- SSE reconnection automatically reloads message history to fill gaps from disconnection period
- Heartbeat timeout (75s) detects stale connections and shows "Reconnecting" status
- Terminal EventSource.CLOSED state handled with "Disconnected" status and "Reconnect" button
- StatusIndicator component replaces inline dots with text-labeled status (Live/Reconnecting/Disconnected)
- 4 new connection resilience tests covering all status states

## Task Commits

Each task was committed atomically:

1. **Task 1: Bridge-side gateway status broadcasting and SSE forwarding** - `699283cc` (feat)
2. **Task 2: Client-side reconnection, heartbeat timeout, terminal disconnect, and status UI** - `f3ee30e9` (feat)

**Plan metadata:** (pending)

## Files Created/Modified
- `discord-bridge/src/gateway.ts` - Added status event emission on ClientReady, ShardReconnecting, ShardResume, ShardDisconnect
- `discord-bridge/src/index.ts` - Added SSE status event forwarding handler with abort cleanup
- `lens-editor/src/components/DiscussionPanel/useMessages.ts` - Added reconnection refetch, heartbeat timeout, terminal disconnect handling, reconnect function
- `lens-editor/src/components/DiscussionPanel/DiscussionPanel.tsx` - Added StatusIndicator component, disconnected banner with Reconnect button
- `lens-editor/src/components/DiscussionPanel/DiscussionPanel.test.tsx` - Enhanced MockEventSource with test helpers, added 4 connection resilience tests, added DisplayNameProvider wrapper

## Decisions Made
- **onopen clears only SSE errors:** `setError(prev => prev === 'Connection lost' ? null : prev)` prevents SSE reconnection from clearing fetch errors (e.g., 500 from REST API)
- **sseReconnectTrigger pattern:** A state variable added as dependency to the SSE useEffect forces EventSource recreation when terminal CLOSED state is reached, since browsers don't auto-reconnect CLOSED EventSources
- **75s heartbeat timeout:** 2.5x the 30s heartbeat interval provides good balance -- fast enough to detect stale connections, slow enough to avoid false positives from network jitter

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Added DisplayNameProvider wrapper to test renders**
- **Found during:** Task 2 (test execution)
- **Issue:** All tests rendering DiscussionPanel failed because ComposeBox (added in Phase 3) uses `useDisplayName()` which requires `DisplayNameProvider` context
- **Fix:** Added a `Wrapper` component that provides `DisplayNameProvider` and passed it to all `render()` calls via `{ wrapper: Wrapper }`
- **Files modified:** `DiscussionPanel.test.tsx`
- **Verification:** All 20 tests pass
- **Committed in:** `f3ee30e9` (Task 2 commit)

**2. [Rule 1 - Bug] Fixed race condition in "retries fetch when retry button clicked" test**
- **Found during:** Task 2 (test execution)
- **Issue:** Between `waitFor` finding the Retry button and `fireEvent.click`, EventSource `onopen` fired and re-rendered the component, removing the Retry button
- **Fix:** Combined finding and clicking the button within a single `waitFor` callback
- **Files modified:** `DiscussionPanel.test.tsx`
- **Verification:** Test passes reliably
- **Committed in:** `f3ee30e9` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (2 bugs)
**Impact on plan:** Both fixes were necessary for test suite correctness. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 4 (Connection Resilience) is complete -- this was the final phase
- All 4 phases of the Discord Discussion Panel project are now implemented
- The system provides: document-to-channel mapping, REST message fetching, live SSE streaming, message posting, and full connection resilience

---
*Phase: 04-connection-resilience*
*Completed: 2026-02-11*
