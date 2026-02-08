# Codebase Concerns

**Analysis Date:** 2026-02-08

## Tech Debt

**HMAC auth error handling:**
- Issue: `CwtAuthenticator::new_ecdsa_p256()` at `crates/y-sweet-core/src/cwt.rs:89` maps all key parsing errors to generic `CwtError::InvalidCose` instead of returning proper error types
- Files: `crates/y-sweet-core/src/cwt.rs` (line 89)
- Impact: Debugging authentication failures is difficult; error context is lost during key initialization
- Fix approach: Create specific error variants for key parsing failures (e.g., `CwtError::InvalidKeyFormat`, `CwtError::InvalidKeyLength`) and propagate root cause to caller

**Exposed implementation details:**
- Issue: `DocConnection::DOC_NAME` constant at `crates/y-sweet-core/src/doc_connection.rs:25` is marked as TODO to not be exposed but is currently public
- Files: `crates/y-sweet-core/src/doc_connection.rs` (line 24-25)
- Impact: Internal implementation detail leaked to public API, couples external code to internal naming
- Fix approach: Make `DOC_NAME` private and only expose through accessor methods

**Test-only panics in production code:**
- Issue: Multiple panics scattered in production code meant for test validation:
  - `crates/y-sweet-core/src/sync_kv.rs`: panics on "feature_flags" type mismatch
  - `crates/y-sweet-core/src/auth.rs`: Multiple panics for invalid channel names and permission type validation
  - `crates/relay/src/server.rs`: Panics in response handlers (expected status code assertions)
- Files: `crates/y-sweet-core/src/sync_kv.rs`, `crates/y-sweet-core/src/auth.rs`, `crates/relay/src/server.rs`
- Impact: Unexpected panics crash the server in production if invalid input is received
- Fix approach: Replace test panics with proper error handling returning `Err()` or logging warnings

## Known Bugs

**WebSocket file descriptor leak:**
- Symptoms: Sockets accumulate in CLOSE-WAIT state, ~70 FDs leak per hour. Server must restart every 39 days even with high FD limit
- Files: `crates/relay/` (upstream y-sweet issue, not our code)
- Trigger: Clients disconnect from WebSocket connections without proper close handshake
- Workaround: `--ulimit nofile=65536:524288` extends time-to-restart from ~14 hours to ~39 days. Monitoring script `/usr/local/bin/relay-fd-monitor.sh` tracks usage. Manual restart needed periodically.
- Production impact: **HIGH** - Affects availability; production must restart monthly to prevent FD exhaustion

**Error display gap in Sidebar:**
- Symptoms: Document creation errors are logged to console but not shown to user
- Files: `lens-editor/src/components/Sidebar/Sidebar.tsx` (line 87)
- Trigger: Network error or server error during document creation
- Workaround: User sees operation silently fail with only console error visible
- Fix approach: Show error toast/modal to user with retry option

## Security Considerations

**Unwrap/panic usage in production paths:**
- Risk: Multiple `unwrap()` and `panic!()` calls in critical paths can crash server if assumptions are violated
- Files:
  - `crates/relay/src/main.rs`: `unwrap()` on host parsing, listener creation
  - `crates/y-sweet-worker/src/lib.rs`: `unwrap()` on route parameter extraction
  - `crates/relay/src/cli.rs`: `unreachable!()` on token type validation
- Current mitigation: Type system ensures some assumptions (e.g., valid token types checked before unreachable), but parsing failures are unguarded
- Recommendations:
  - Replace all `unwrap()` with `?` operator in async handlers
  - Use `map_err()` to convert parsing failures to proper HTTP error responses
  - Add integration tests for malformed requests/URLs

**Hardcoded credentials in test fixtures:**
- Risk: Test tokens/credentials may accidentally leak via version control
- Files: `lens-editor/src/lib/relay-api.ts:7` contains hardcoded `SERVER_TOKEN`
- Current mitigation: Token appears to be for production relay with scoped permissions
- Recommendations:
  - Move to environment variable even for test/demo mode
  - Audit git history for any leaked secrets

**Missing token expiration checks in some paths:**
- Risk: Not all WebSocket message handlers verify token expiration uniformly
- Files: `crates/y-sweet-core/src/doc_connection.rs` (lines 204-242)
- Current mitigation: Expiration checked in `send()` and `handle_msg()` but not all message types may be covered
- Recommendations: Add integration test verifying expired tokens are rejected on all message types

## Performance Bottlenecks

**Large authentication file:**
- Problem: `crates/y-sweet-core/src/auth.rs` is 3,821 lines - monolithic auth module with multiple concerns
- Files: `crates/y-sweet-core/src/auth.rs`
- Cause: Token generation, HMAC verification, legacy token support, CWT handling all in one file
- Improvement path: Split into submodules (`legacy_tokens.rs`, `cwt_generation.rs`, `verification.rs`) to improve maintainability and testability

**Indexer write operations trigger full document re-indexing:**
- Problem: Link indexer uses thread-local guard to prevent loops, but any indexer write triggers observer again
- Files: `crates/y-sweet-core/src/link_indexer.rs` (lines 37-60)
- Cause: Y.js observer fires on any doc change, even indexer's own writes. Guard prevents infinite loop but means each write is observed
- Improvement path: Use origin-based filtering (like LENS_EDITOR_ORIGIN) instead of thread-local flag to avoid re-processing indexer writes

**Lack of streaming for large document updates:**
- Problem: Document updates are loaded entirely into memory before processing
- Files: `crates/y-sweet-core/src/doc_sync.rs`, `crates/relay/src/server.rs`
- Cause: Current architecture uses `Bytes` for entire update payload
- Improvement path: Implement chunked update processing for documents >10MB (monitor usage first)

## Fragile Areas

**Y.Map dual-write requirement for Obsidian compatibility:**
- Files: `lens-editor/src/lib/relay-api.ts` (lines 143-153)
- Why fragile: Code must write to both `filemeta_v0` (modern) and legacy `docs` Y.Map. If either write fails or one is skipped, Obsidian marks document for deletion. No validation that both writes succeed atomically.
- Safe modification:
  1. Always wrap both writes in single `transact()` call
  2. After transaction, verify both maps contain entry before returning
  3. Add unit tests for this pattern in all create/rename/delete operations
- Test coverage: `lens-editor/src/lib/relay-api.ts` has integration tests but missing explicit dual-write validation tests

**WebSocket connection lifecycle:**
- Files: `crates/relay/src/server.rs` (WebSocket handler), `crates/y-sweet-core/src/doc_connection.rs`
- Why fragile: Multiple async operations (auth, sync, awareness) must coordinate on connection close. FD leak suggests close logic is incomplete. No mechanism to flush pending updates on close.
- Safe modification:
  1. Add explicit close/cleanup phase with timeout
  2. Log close reasons (normal vs error) for debugging
  3. Test graceful vs abrupt closes
- Test coverage: No explicit WebSocket close tests in `crates/relay/tests/`

**Frontend error handling lacks user feedback:**
- Files: `lens-editor/src/components/Sidebar/Sidebar.tsx` (line 87), possibly other CRUD handlers
- Why fragile: Silent failures on document operations leave user in unclear state (is document created? partially created?). Users can't distinguish temporary network errors from permanent failures.
- Safe modification:
  1. Add error boundary/toast component
  2. Show operation status (pending/success/error) with retry
  3. Log errors with unique IDs for support reference
- Test coverage: Integration tests exist but missing error scenario coverage

**Link indexer update ordering:**
- Files: `crates/y-sweet-core/src/link_indexer.rs`
- Why fragile: Indexer watches document updates but there's no guarantee processing order with concurrent edits. If multiple documents are edited simultaneously, index may be stale.
- Safe modification:
  1. Add update batching with debounce (current timeout mechanism exists, verify it's working)
  2. Add integration test for concurrent multi-doc edits
  3. Monitor index staleness metrics in production
- Test coverage: Single-document indexing tested; multi-document concurrent scenarios missing

## Scaling Limits

**In-memory storage with no persistence bounds:**
- Current capacity: Local relay-server uses in-memory storage (filesystem fallback available)
- Limit: Entire document set must fit in RAM. No pagination or lazy-loading
- Scaling path:
  1. Monitor memory usage of document store in dev
  2. If >100MB during local testing, implement persistence layer
  3. For production, use S3/R2 (already configured) but implement efficient caching strategy

**No connection pooling or rate limiting:**
- Current capacity: Single relay-server instance handles all WebSocket connections
- Limit: No explicit per-IP rate limiting; all connections share single event dispatcher
- Scaling path:
  1. Add configurable rate limiting (events/sec per user/IP)
  2. Implement connection pooling with maximum limits
  3. Add metrics for connection saturation

**Single-threaded link indexer:**
- Current capacity: Processing updates sequentially
- Limit: If document content changes frequently (>100 edits/sec), indexer may fall behind
- Scaling path:
  1. Monitor indexer lag metrics
  2. Implement parallel processing for independent documents
  3. Add update batching with configurable flush interval

## Dependencies at Risk

**Upstream y-sweet with WebSocket FD leak:**
- Risk: Upstream fork (`No-Instructions/relay-server`) has known FD leak bug that blocks production reliability
- Impact: Requires manual server restarts every 39 days; no permanent fix available
- Migration plan:
  1. Monitor yrs/y-sweet upstream for fixes
  2. If fix released, upgrade and test thoroughly
  3. Alternative: Switch to different CRDT implementation (expensive, major refactor)

**Outdated Node.js dependencies in lens-editor:**
- Risk: `package.json` likely has outdated transitive dependencies. No automated security scanning visible
- Impact: Potential security vulnerabilities in client-side code
- Migration plan:
  1. Add `npm audit` to CI/CD (if using GitHub Actions)
  2. Implement automated dependency updates (Dependabot)
  3. Regular audit runs (weekly recommended)

**Hard-coded relay tokens in code:**
- Risk: `SERVER_TOKEN` in `lens-editor/src/lib/relay-api.ts:7` is hardcoded
- Impact: Token rotation requires code redeploy; if token is leaked, requires code change
- Migration plan:
  1. Move to environment variable in `.env.example`
  2. Update docs to show token configuration
  3. Implement token refresh mechanism

## Missing Critical Features

**No distributed tracing across relay-git-sync:**
- Problem: Webhook→relay-server→git-sync→GitHub spans multiple services with no correlation IDs
- Blocks: Troubleshooting sync failures requires manually checking multiple service logs
- Recommendation: Add OpenTelemetry support with trace propagation across services

**No metrics for document staleness:**
- Problem: Index may fall behind during high-frequency edits (no visibility)
- Blocks: Can't detect or alert on synchronization lag
- Recommendation: Add metrics for indexer update latency, publish metrics to Prometheus/Grafana

**No automated backup verification:**
- Problem: Documents stored in R2 but no test recovery procedure
- Blocks: Can't verify backups are usable until actual disaster
- Recommendation: Implement monthly test recovery of random documents from R2

## Test Coverage Gaps

**WebSocket protocol edge cases:**
- What's not tested: Malformed sync messages, concurrent message interleaving, connection drops mid-message, large message handling (>1MB)
- Files: `crates/relay/src/server.rs` (WebSocket handler), `crates/y-sweet-core/src/sync/`
- Risk: Server may crash or hang on unexpected input; no known failures but lack of tests suggests gaps
- Priority: **HIGH** - WebSocket protocol is critical path

**Authentication token edge cases:**
- What's not tested: Expired token with pending writes, token swap mid-connection, audience claim validation with non-matching domains
- Files: `crates/y-sweet-core/src/auth.rs`, `crates/y-sweet-core/src/cwt.rs`
- Risk: Security-relevant bugs undetected; token validation may have bypasses
- Priority: **HIGH** - Directly affects security

**Multi-document concurrent editing:**
- What's not tested: Simultaneous edits to multiple documents, cross-document link updates with racing changes
- Files: `crates/y-sweet-core/src/link_indexer.rs`, `lens-editor/` integration tests
- Risk: Index inconsistency, stale backlinks under high concurrency
- Priority: **MEDIUM** - Impacts collaborative experience but not security-critical

**Obsidian sync compatibility:**
- What's not tested: Dual Y.Map write atomicity, orphaned document cleanup, partial sync recovery
- Files: `lens-editor/src/lib/relay-api.ts`, integration tests
- Risk: Silent data loss if both maps aren't updated atomically
- Priority: **HIGH** - Data loss risk

**Error handling recovery:**
- What's not tested: Network reconnection after extended outage, partial update loss, corrupted CRDT state recovery
- Files: Frontend connection logic, backend recovery handlers
- Risk: Users stuck in disconnected state or data corruption on resume
- Priority: **MEDIUM** - Impacts usability but not critical

---

*Concerns audit: 2026-02-08*
