# Link Indexer Resilience & Panic Recovery

**Date:** 2026-05-20
**Status:** Approved — ready for TDD-first implementation

## Problem

On 2026-05-18T19:37:45, the link indexer worker in production panicked with
`yrs-0.19.2/src/doc.rs:950 SharedAcqFailed` ("there's another active read-write
transaction at the moment"). The `catch_unwind` in `server.rs:820` logged a
CRITICAL message and let the worker task exit. No restart logic existed.

For ~22 hours afterward, every folder doc update arriving from clients was
notified to a dead channel (`Link indexer channel send failed (receiver dropped
— worker dead?)`). The `DocumentResolver` was never updated, so files created
in that window existed in `filemeta_v0` but were missing from the resolver.

The user-visible symptom: `POST /move` returned 400 "Folder destination must
not end with '.md'" for any newly-created file. `Server::move_path`
(`server.rs:2119`) calls `resolve_path`, misses, and falls through to
`move_folder_path` which rejects markdown-looking new paths because it assumes
the source is a folder. A separate UTF-8 panic (`search_index.rs:284`) killed
the search worker on 2026-05-19 but did not contribute to the rename outage.

Restart-the-process was the only available recovery. We need:
1. The panics themselves eliminated where possible.
2. When a worker does panic, the service self-heals without operator
   intervention.

## Goal

- Two known panic sites do not panic anymore: the UTF-8 byte slice in
  `render_snippet_with_mark` and the `SharedAcqFailed` in the link indexer.
- A panic in either background worker (link indexer, search index) is recovered
  automatically — either by restarting the worker task or, if panics persist,
  by exiting the process so Docker's `restart: unless-stopped` cycles the
  container.
- No defensive fallback in `move_path` or any other user-facing path. The
  resolver is the source of truth; the fix lives in keeping the resolver fresh.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Recovery model | Bounded worker retry, then process exit | Erlang-style supervision. Catches transient panics without spin loops; lets Docker handle truly broken state. |
| Retry budget | 5 panics within 60 seconds | Wide enough for a few flakes; tight enough to escalate on real corruption. |
| Pre-exit delay | 30 seconds before `std::process::exit(1)`, cancellable by SIGTERM | Avoids hot container restart loops on deterministic panics; cancellation token integration means `docker stop` doesn't wait out the full delay. |
| Process exit mechanism | `std::process::exit(1)` (already used in persistence-stalled path at `server.rs:960`); Docker `restart: unless-stopped` is configured. |
| Defensive fallback in `move_path` | None | Would add a second resolution path that hides the symptom of a dead worker. Rejected. |
| UTF-8 fix | Reuse existing `snap_char_boundary_backward` (line 459) for both slice sites | Helper already exists in the file; introducing parallel `safe_prefix/suffix` would duplicate. |
| `SharedAcqFailed` investigation depth | Reproduce with a stress test, fix the root cause | Restart mechanism is the safety net, not the fix. |
| Concurrency test runtime | Multi-thread tokio (`flavor = "multi_thread"`) | yrs `RefCell`-based panics do not surface on a single-threaded runtime. |
| Transaction idempotency invariant | Every `transact_mut_with("link-indexer")` block must be safe to interrupt and re-execute | The supervisor cannot unwind partial commits — yrs commits on `TransactionMut::drop`, and the partial mutation persists to R2 via the observer. |
| Time clock | `tokio::time::Instant` everywhere in the supervisor | So `tokio::time::pause()`/`advance()` works in tests. |
| Supervisor closure shape | HRTB: `for<'r> FnMut(&'r mut R) -> Pin<Box<dyn Future + Send + 'r>>` | Canonical Rust pattern for "callback producing a future borrowing from caller state." Each retry takes a fresh borrow. |
| Other `tokio::spawn` panic sources | `on_document_update` spawn at `server.rs:2748` is in scope (wrap in `catch_unwind` + log); persistence-watchdog and similar are out of scope. | The `on_document_update` task is in the rename-failure code path. The others aren't. |
| Broker callback (sync portion) | Not wrapped | Already protected per-request by axum's panic-to-500. Wrapping would silently absorb the 500 signal. |
| Monitoring channels | Structured tracing logs + Prometheus counters/gauge + `/ready` extension | Reuses existing infrastructure (tracing, `RelayMetrics`, `/ready`). No new daemons, no new ports. |

## Architecture

Three independent changes, all in `crates/`:

```
                ┌──────────────────────────────┐
                │ search_index.rs              │
A. UTF-8 fix    │  render_snippet_with_mark    │  Pure function. Reuse existing
                │  + snap_char_boundary_*      │  snap helpers.
                └──────────────────────────────┘

                ┌──────────────────────────────┐
                │ doc_sync.rs / server.rs      │
B. Concurrency  │  observe_update_v1 callbacks │  Root-cause the read-during-
   fix          │  + link_indexer commit paths │  write panic; audit and fix.
                └──────────────────────────────┘

                ┌──────────────────────────────┐
                │ server.rs: spawn_workers     │
C. Resilience   │  supervise(run_worker)       │  Wrap each worker in a
                │  → process::exit on budget   │  bounded-retry supervisor.
                └──────────────────────────────┘
```

A and C can ship without B; B's investigation may discover the right fix is
structural, in which case the spec section is updated.

## A. UTF-8 boundary slice in `render_snippet_with_mark`

### Bug

`crates/y-sweet-core/src/search_index.rs`:

```rust
// line 277-278:
let prefix_len = 20.min(fragment.len());
let is_at_start = full_body.starts_with(&fragment[..prefix_len]);

// line 283-284:
let suffix_len = 20.min(fragment.len());
let is_at_end = full_body.ends_with(&fragment[fragment.len() - suffix_len..]);
```

`fragment.len()` is a byte count. `prefix_len = 20` slices `fragment[..20]`,
which panics if byte 20 lands inside a multi-byte UTF-8 character. The prod
panic was triggered by `→` (3 bytes, U+2192) and `—` (3 bytes, U+2014) near
position 20.

### Fix

The file already has `snap_char_boundary_forward(s, pos)` and
`snap_char_boundary_backward(s, pos)` at lines 450 and 459. Use them:

```rust
let prefix_end = snap_char_boundary_backward(fragment, 20.min(fragment.len()));
let is_at_start = full_body.starts_with(&fragment[..prefix_end]);

let suffix_start =
    snap_char_boundary_forward(fragment, fragment.len().saturating_sub(20));
let is_at_end = full_body.ends_with(&fragment[suffix_start..]);
```

`snap_char_boundary_backward(s, pos)` clamps `pos` down to the nearest char
boundary (returns ≤ `pos`). `snap_char_boundary_forward(s, pos)` clamps up
(returns ≥ `pos`). Both return positions valid for `&s[..pos]` and `&s[pos..]`.

The semantic change at multi-byte boundaries: the slice may be 1–3 bytes
shorter than the literal 20. That means `starts_with` / `ends_with` is
slightly more likely to return `false` (the prefix/suffix we compare is
strictly contained in what we would have compared). The visible consequence
is an extra `...` prepended or appended when it would not have been needed.
Acceptable — same direction of error as a search snippet that happens to
sit just past a multi-byte char.

### Refactor for testability

The slice math is private to `render_snippet_with_mark`, but the tests need
to exercise it directly without constructing a `tantivy::snippet::Snippet`
(awkward API). Extract two pure helpers:

```rust
/// Returns true if the snippet fragment starts exactly at the start of the
/// full body (no leading ellipsis needed).
fn fragment_at_body_start(fragment: &str, full_body: &str) -> bool {
    if fragment.is_empty() { return true; }
    let end = snap_char_boundary_backward(fragment, 20.min(fragment.len()));
    full_body.starts_with(&fragment[..end])
}

/// Returns true if the snippet fragment ends exactly at the end of the
/// full body (no trailing ellipsis needed).
fn fragment_at_body_end(fragment: &str, full_body: &str) -> bool {
    if fragment.is_empty() { return true; }
    let start =
        snap_char_boundary_forward(fragment, fragment.len().saturating_sub(20));
    full_body.ends_with(&fragment[start..])
}
```

Use them at the original sites. The `render_snippet_with_mark` body shrinks
to three lines for the ellipsis decision.

### Tests

In `search_index.rs`'s test module:

1. `fragment_at_body_start_no_panic_with_multibyte_at_boundary` —
   `fragment = "hello → world"` (`→` at bytes 6..9), `full_body = "X" + fragment`.
   Returns `false` (no panic). Without the snap, this used to panic when
   `prefix_len` landed inside `→`.

2. `fragment_at_body_start_true_when_fragment_is_at_start` —
   `fragment = "hello world"`, `full_body = fragment`. Returns `true`.

3. `fragment_at_body_start_false_when_fragment_not_at_start` —
   `fragment = "world"`, `full_body = "hello world"`. Returns `false`.

4. `fragment_at_body_start_handles_short_fragment` —
   `fragment = "ab"`, `full_body = "abcdef"`. Returns `true` (the snap to
   2 bytes is shorter than 20, still valid).

5. `fragment_at_body_start_handles_empty_fragment` —
   `fragment = ""`. Returns `true` (degenerate).

6. Mirror tests 1–5 for `fragment_at_body_end`.

7. `fragment_at_body_start_false_positive_under_multibyte_shortening` —
   A fragment that IS at the start of the body, but the snap to a char
   boundary shortens the comparison prefix to ≤ 19 bytes, and the
   comparison still returns `true` (the shortened prefix is still a true
   prefix of `full_body`). This pins the "false negative" direction: we
   only add `...` when wrong, never miss a `...` we should have added.
   Concrete inputs:
   `fragment = "hello → world!"` (`→` at bytes 6..9, total 16 bytes),
   `full_body = "hello → world! tail"`. Snap clamps prefix to 6 (before
   the `→`). `"hello ".starts_with("hello ")` is true. Test asserts
   `fragment_at_body_start(...)` returns `true`.

8. `render_snippet_with_mark_does_not_panic_on_multibyte_boundary` —
   integration test. Build a snippet via `tantivy::snippet::Snippet` if
   reasonable; if the constructor API is private, skip this test and rely
   on tests 1–7. (The helpers cover the panic path; the integration test
   is belt-and-braces.) Decision made now: skip the Snippet construction;
   ship the pure-function tests only.

## B. `SharedAcqFailed` in the link indexer

### What we actually know

The prod panic message: *"there's another active read-write transaction at
the moment: SharedAcqFailed"*. Source: `yrs-0.19.2/src/doc.rs:950`. Verified
by reading the yrs source:

```rust
// yrs doc.rs:948-951
fn transact(&self) -> Transaction {
    self.try_transact()
        .expect("there's another active read-write transaction at the moment")
}
```

This is the **read-only** `transact()` panicking because a `transact_mut*`
is already active on the same Doc. (The `transact_mut()` panic at line 963
has a different message: *"there's another active transaction at the
moment"*.) Yrs uses `RefCell` for `Doc.store`; `try_transact()` calls
`store.try_borrow()`, which fails with `SharedAcqFailed` when a `borrow_mut()`
is outstanding.

**This changes the investigation completely.** The offending call is not a
`transact_mut*` — it's a `transact()` (or any read-only method that
internally takes one — `state_vector()`, `get_text()`, `get_map()`, etc.)
running synchronously while a `transact_mut_with("link-indexer")` is alive
on the same Doc.

### Investigation targets, in priority order

1. **Observer callbacks fired during link-indexer commit.**
   `crates/y-sweet-core/src/doc_sync.rs:56` registers
   `doc.observe_update_v1(|txn, event| { ... })`. This fires synchronously
   inside `TransactionMut::drop` when the link-indexer commits. The callback
   uses `txn.state_vector()` on line 82 — that uses the existing txn (safe),
   not a new one. But it also calls `callback(event, is_indexer)` on line 91,
   which is the broker callback constructed at `server.rs:2702`. Audit every
   line of that callback for any synchronous Doc access (`docs.get(...)`
   followed by a read on the inner doc).

2. **Notably suspect:** `server.rs:2706-2715` calls
   `parent.update_subdoc_state_vector(...)`. The function itself
   (`doc_sync.rs:216`) only touches sync_kv metadata — no Doc transaction.
   Probably safe. But this is exactly the kind of thing to confirm by reading,
   not assuming.

3. **Link-indexer code that reads inside its own commit window.**
   `apply_rename_updates` (link_indexer.rs ~line 1224) and
   `apply_backlink_diff` (~413) both open `transact_mut_with("link-indexer")`
   and write to the folder doc. Inside those blocks, do they call any
   helper that opens a *separate* read transaction on the same Doc?
   Grep all calls within `transact_mut_with` blocks for things like
   `doc.transact()`, `awareness.read()`, `read_folder_name(&guard.doc, ...)`.

4. **Cross-Doc concurrency.**
   Less likely but possible: the worker holds a write txn on folder Doc A
   and a method internally opens a read txn on Doc B which (via shared
   internal state) maps back to A. Yrs subdocs share a store with the parent
   in some configurations; verify our folder docs are NOT subdocs of each
   other.

### Reproduction test

`crates/relay/tests/link_indexer_concurrency.rs`, new file. The supporting
helpers do not exist; they ship with this test:

```rust
async fn build_concurrency_server(n_files: usize) -> Arc<Server>;
// Wraps Server::new_for_test, inserts one folder doc named "Concurrency"
// with n_files markdown entries (uuid = i.to_string padded), inserts
// content docs for each. Calls server.doc_resolver().rebuild() once.

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_moves_and_indexing_do_not_panic_yrs() {
    let server = build_concurrency_server(50).await;
    let mut tasks = Vec::new();

    // 50 tasks each doing 10 moves on its own file.
    for i in 0..50 {
        let s = server.clone();
        tasks.push(tokio::spawn(async move {
            for j in 0..10 {
                let _ = s.move_document(
                    &uuid_for(i),
                    &format!("/renamed_{}_{}.md", i, j),
                    None,
                ).await;
            }
        }));
    }

    // 5 tasks each doing 20 folder-doc syncs (which trigger
    // on_document_update → worker re-runs).
    for _ in 0..5 {
        let s = server.clone();
        tasks.push(tokio::spawn(async move {
            for _ in 0..20 {
                touch_folder_doc(&s, "Concurrency").await;
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }));
    }

    for t in tasks { t.await.expect("task panicked"); }

    // Post-conditions: worker is alive (send a final update, wait up to 2s
    // for resolver to reflect it), and resolver state is internally
    // consistent (every uuid present maps back to a path that resolves to
    // the same uuid).
    let final_uuid = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    insert_filemeta_entry(&server, "Concurrency", "/sentinel.md", final_uuid).await;
    wait_for_resolver(&server, "Concurrency/sentinel.md", Duration::from_secs(2))
        .await
        .expect("resolver did not catch the sentinel — worker is dead");
    assert_resolver_consistent(&server.doc_resolver());
}
```

Pass condition: no task panics AND the sentinel post-condition holds.

### Investigation time-box

Two days, not half a day, with pre-budgeted instrumentation:
- Day 1: read the call paths in priority order (#1 above), write the stress
  test, see if it reproduces.
- Day 2: if no repro, add `tracing::debug!` at every `transact*` and every
  `awareness.read()`/`awareness.write()` site in `link_indexer.rs` and the
  observer callback, gated by an env var, then re-run the stress test.

If still no repro after two days: ship A and C without B, file a ticket
with the diagnostic patch on a branch, and escalate the supervisor budget
(or add the env-var instrumentation behind a feature flag for prod
collection). The supervisor handles future recurrences.

### Fix shape (TBD pending repro)

Likely candidates, by guess:
- A synchronous Doc read inside the observer callback (or inside something
  the callback calls) on the same Doc that link-indexer is committing.
- A nested `awareness.write()` deep in a function that already has a
  `transact_mut_with` open via a parent's guard.

The fix is one of: move the read outside the write-txn window, switch to
the existing-txn read (`txn.get_map(...)` instead of `doc.transact()`), or
serialize the two paths with an external lock. Not committing to a specific
shape until the repro names the caller.

## C. Worker resilience

### Current behavior

`server.rs:814-832` (link indexer) and `:852-870` (search index):

```rust
tokio::spawn(async move {
    let result = std::panic::AssertUnwindSafe(run_worker(...));
    if let Err(e) = catch_unwind(result).await {
        tracing::error!(
            "CRITICAL: ...panicked: {msg}. ...is now dead — restart the server."
        );
    } else {
        tracing::error!("CRITICAL: ...exited unexpectedly (channel closed).");
    }
});
```

One panic, then dead. Operator-driven recovery only.

### Channel ownership and supervisor signature

`LinkIndexer::run_worker` currently takes `mpsc::Receiver<String>` by value
(see `link_indexer.rs:1453`). If it panics, the receiver drops; subsequent
sends from `on_document_update` fail with the "channel closed" error
observed in prod.

To retry, the receiver must live OUTSIDE the worker future. Change the
signature to take `&mut Receiver`. The supervisor owns the receiver across
retries; the worker borrows it for the duration of a single run.

```rust
// link_indexer.rs — signature change:
pub async fn run_worker(
    self: Arc<Self>,
    rx: &mut mpsc::Receiver<String>,
    docs: Arc<DashMap<String, DocWithSyncKv>>,
    doc_resolver: Arc<DocumentResolver>,
) { /* same body */ }
```

The body only uses `rx.recv()` and `rx.try_recv()`, neither of which
consumes `rx`. The change is signature-only.

### Supervisor

New module `crates/relay/src/supervisor.rs`. The supervisor owns no state
between runs other than panic accounting. Mutable state needed across
retries (the channel receiver) is passed in by `&mut` and threaded through
the closure via higher-ranked trait bounds.

```rust
use futures::future::FutureExt;  // for catch_unwind
use std::any::Any;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::pin::Pin;
use tokio::time::{Duration, Instant};

pub const PANIC_BUDGET: u32 = 5;
pub const PANIC_WINDOW: Duration = Duration::from_secs(60);

pub enum SupervisorOutcome {
    /// Worker exited cleanly (channel closed). Supervisor stops.
    CleanExit,
    /// Worker exceeded panic budget within the window. Caller should
    /// log a CRITICAL line and exit the process.
    BudgetExceeded { count: u32, first_msg: String, last_msg: String },
}

/// Run `make_fut` repeatedly, threading `state: &mut R` through each call.
/// On panic: count, log, retry. After `PANIC_BUDGET` panics within
/// `PANIC_WINDOW`, return `BudgetExceeded`.
///
/// The higher-ranked bound `for<'r> FnMut(&'r mut R) -> ... + 'r` is what
/// lets each retry borrow `state` afresh. `'static` is *not* on the future,
/// because the future borrows from `state`.
pub async fn supervise<R, F>(
    name: &'static str,
    state: &mut R,
    mut make_fut: F,
    on_panic: impl Fn(&str, &str, u32, u32),
) -> SupervisorOutcome
where
    F: for<'r> FnMut(&'r mut R) -> Pin<Box<dyn Future<Output = ()> + Send + 'r>>,
{
    let mut panic_count: u32 = 0;
    let mut first_panic_at = Instant::now();
    let mut first_msg = String::new();

    loop {
        let fut = make_fut(state);
        match AssertUnwindSafe(fut).catch_unwind().await {
            Ok(()) => return SupervisorOutcome::CleanExit,
            Err(payload) => {
                let msg = extract_panic_msg(&*payload);
                let now = Instant::now();
                if panic_count == 0 || now.duration_since(first_panic_at) > PANIC_WINDOW {
                    panic_count = 1;
                    first_panic_at = now;
                    first_msg = msg.clone();
                } else {
                    panic_count += 1;
                }
                on_panic(name, &msg, panic_count, PANIC_BUDGET);
                tracing::error!(
                    worker = name,
                    attempt = panic_count,
                    budget = PANIC_BUDGET,
                    panic_msg = %msg,
                    "Worker panicked; restarting"
                );
                if panic_count >= PANIC_BUDGET {
                    return SupervisorOutcome::BudgetExceeded {
                        count: panic_count,
                        first_msg,
                        last_msg: msg,
                    };
                }
            }
        }
    }
}

fn extract_panic_msg(payload: &(dyn Any + Send + 'static)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        s.to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic payload".to_string()
    }
}
```

The `on_panic` callback is the metrics hook (see "Monitoring" below). It
takes `(worker_name, panic_msg, attempt, budget)` so the metric
incrementation lives at the call site rather than inside the supervisor.
Decouples observability from supervision logic.

### Call site

In `spawn_workers`, before the `tokio::spawn`, capture the needed values
into local bindings so they're available inside the `async move`:

```rust
pub fn spawn_workers(self: &Arc<Self>, receivers: WorkerReceivers) {
    // ... existing setup ...

    // Bindings captured by the spawned task:
    let indexer = self.link_indexer.clone().expect("link_indexer present");
    let docs = self.docs.clone();
    let resolver = self.doc_resolver.clone();
    let metrics = self.metrics.clone();         // Arc<RelayMetrics>
    let worker_status = self.worker_status.clone();  // Arc<WorkerStatusMap>
    let cancellation_token = self.cancellation_token.clone();
    let mut rx = receivers.index_rx;

    tokio::spawn(async move {
        // `indexer`, `docs`, `resolver`, `metrics`, `worker_status`,
        // `cancellation_token`, `rx` are all owned by this task.
        let outcome = supervise(
            "link_indexer",
            &mut rx,
            |rx| {
                // These captures are cloned-out Arcs from the outer move;
                // each iteration produces a fresh set so the inner future
                // doesn't borrow from the closure.
                let indexer = indexer.clone();
                let docs = docs.clone();
                let resolver = resolver.clone();
                Box::pin(async move {
                    indexer.run_worker(rx, docs, resolver).await
                })
            },
            |worker, msg, attempt, _budget| {
                metrics.relay_server_worker_panics_total
                    .with_label_values(&[worker])
                    .inc();
                worker_status.record_panic(worker, msg);
                let _ = attempt;
            },
        ).await;

        match outcome {
            SupervisorOutcome::CleanExit => {
                tracing::info!(
                    worker = "link_indexer",
                    "exited cleanly (channel closed)"
                );
            }
            SupervisorOutcome::BudgetExceeded { count, first_msg, last_msg } => {
                metrics.relay_server_worker_panic_budget_exceeded_total
                    .with_label_values(&["link_indexer"])
                    .inc();
                metrics.relay_server_worker_alive
                    .with_label_values(&["link_indexer"])
                    .set(0);
                worker_status.mark_dead("link_indexer");
                tracing::error!(
                    worker = "link_indexer",
                    panic_count = count,
                    first_panic_msg = %first_msg,
                    last_panic_msg = %last_msg,
                    "CRITICAL: panic budget exceeded; exiting process for container restart"
                );
                graceful_exit_after_delay(cancellation_token).await;
            }
        }
    });

    // ... identical pattern for search worker (see below) ...
}
```

The `search_worker` task gets the **same refactor in parallel**: change
its signature to take `rx: &mut mpsc::Receiver<String>` (currently takes
by value at `server.rs:370`), wrap in `supervise(...)` with worker name
`"search_index"`, and `graceful_exit_after_delay` on budget exceeded.
The metrics increments use the same Counter/Gauge with `"search_index"`
as the label value. No structural difference.

The `for<'r> FnMut(&'r mut R)` HRTB form means each call to `make_fut`
gets a fresh `&'r mut R` borrow that lives only for `'r` (the duration of
that one future). Between calls, the borrow ends; the next call can take
a new one. This is the canonical pattern for "callback that produces a
future borrowing from caller state."

### `graceful_exit_after_delay`

```rust
async fn graceful_exit_after_delay(cancellation_token: CancellationToken) {
    const PRE_EXIT_DELAY: Duration = Duration::from_secs(30);
    tokio::select! {
        _ = tokio::time::sleep(PRE_EXIT_DELAY) => {
            tracing::error!("Pre-exit delay elapsed; calling process::exit(1)");
        }
        _ = cancellation_token.cancelled() => {
            tracing::warn!("Cancellation requested during pre-exit delay; exiting immediately");
        }
    }
    std::process::exit(1);
}
```

The 30s delay avoids Docker hot-restart loops on deterministic post-budget
panics. SIGTERM during the delay collapses it: the existing
`cancellation_token` (already plumbed through `serve_internal` at
`server.rs:3522` for graceful shutdown) is awaited in `select!`, so a
`docker stop` exits without waiting out the full 30s. The graceful
shutdown handler downstream still runs because we go through
`process::exit(1)` — same teardown rhythm as the persistence-stalled exit
at `server.rs:958-960`.

### `on_document_update` spawned task

`server.rs:2748`:

```rust
tokio::spawn(async move {
    indexer.on_document_update(&doc_key).await;
});
```

A panic here is silently absorbed by Tokio. `on_document_update` itself is
short (a DashMap entry + a channel send) so the risk is low, but it's
exactly the kind of "panic that disappears" that this design exists to
prevent. Wrap the body in `catch_unwind` and log on panic, incrementing
the same `worker_panics_total` counter with label `on_document_update`:

```rust
tokio::spawn(async move {
    let fut = AssertUnwindSafe(async move {
        indexer.on_document_update(&doc_key).await;
    });
    if let Err(payload) = fut.catch_unwind().await {
        let msg = extract_panic_msg(&*payload);
        metrics.worker_panics_total
            .with_label_values(&["on_document_update"])
            .inc();
        tracing::error!(
            worker = "on_document_update",
            doc = %doc_key,
            panic_msg = %msg,
            "panicked; one update lost"
        );
    }
});
```

We don't restart this — it's a fire-and-forget per-update task. We just
want the panic visible in logs and metrics.

### Broker callback (synchronous portion)

The broker callback at `server.rs:2702-2779` runs *synchronously* inside
`TransactionMut::drop`. A panic there propagates through the commit and
back into whatever code opened the write transaction (`apply_backlink_diff`,
`apply_rename_updates`, or user-driven paths like `move_document`).

Inside the worker, the supervisor catches it. **Outside the worker** —
e.g., a panic during the broker callback fired by a `move_document` HTTP
handler — the panic propagates up through `Server::move_document` and is
returned to the user as an axum panic-to-500. Axum's default panic
handling catches the panic per-request; the process stays alive. We
accept this risk explicitly: a broker-callback panic during a user
request returns 500 to that user, and metrics surface the panic via
`worker_panics_total{worker="broker_callback"}` if we instrument it.

Decision: do *not* wrap the broker callback in `catch_unwind` for now. It
already lives inside a per-request handler that axum protects; an extra
wrap would absorb panics silently and lose the 500 signal to the client.
If a future incident shows a broker-callback panic with material impact,
revisit.

Out of scope: other `tokio::spawn` sites in the codebase (search-pending
compaction, persistence watchdog, etc.). They can get the same treatment
if a future incident warrants.

## Transaction idempotency invariant

The supervisor cannot unwind partial Doc mutations. Yrs `TransactionMut::drop`
calls `commit()` (yrs `transaction.rs:358-360`); a panic mid-mutation drops
the txn, commits whatever has been applied so far, and fires
`observe_update_v1` for that partial update. That partial update is then
durable: the observer at `doc_sync.rs:66` pushes it to `sync_kv`, which
persists to R2. Cycling the process does not undo it.

**Invariant:** every block inside `transact_mut_with("link-indexer")` must
be safe to be cut off at an arbitrary point AND safe to re-execute from the
top against the partially-mutated Doc.

In practice this means: prefer many small idempotent operations to one big
multi-step mutation. The existing `apply_backlink_diff` (link_indexer.rs:413)
already follows this — it inserts/removes individual keys, and the worker's
re-run *re-derives* `new_targets` from the current Doc state via
`extract_links`, so a partial state plus a re-run converges to the correct
final state. Idempotency here depends on the worker re-deriving inputs from
the current Doc, not on retrying with cached inputs.

### Audit task (part of Bug B)

For each `transact_mut_with("link-indexer")` in `crates/y-sweet-core/src/link_indexer.rs`,
produce a row in this table during Bug B work:

| Function (line) | Mutations performed | Re-derives inputs each call? | Idempotent on partial re-run? | Refactor needed |
|-----------------|---------------------|------------------------------|-------------------------------|-----------------|

Sites known so far (not yet audited):
- `apply_backlink_diff` (line 413): add + remove individual keys. Inputs re-derived. **Believed idempotent**; audit confirms.
- `apply_rename_updates` (line 1292): more complex — touches filemeta_v0, "docs" map, backlinks_v0, and content docs in coordinated steps. Audit must check each step. If the function does a multi-step coordinated mutation, the audit lists the steps and identifies the failure scenarios.

Acceptance criteria for the audit:
1. Table filled in for every `transact_mut_with("link-indexer")` site.
2. For any site marked "Refactor needed", a sub-task is created with the
   minimum change to restore idempotency.
3. A test exists that interrupts each non-trivial mutation halfway and
   re-runs the worker, asserting end state matches a clean run.

If the audit surfaces a non-idempotent mutation that's expensive to fix,
that's a separate plan; we ship A and C without B, with the audit results
recorded so future work knows where to look.

This invariant is added now as a load-bearing assumption of the supervisor.
Future contributors writing new indexer transactions should respect it.

## Tests

### A — UTF-8

`search_index.rs` test module (pure-function tests, see Section A).

### B — Concurrency repro

`crates/relay/tests/link_indexer_concurrency.rs`, single test
`concurrent_moves_and_indexing_do_not_panic_yrs` (see Section B). Uses
`#[tokio::test(flavor = "multi_thread", worker_threads = 4)]`.

### C — Supervisor

`crates/relay/src/supervisor.rs` test module. Uses `tokio::time::Instant`
throughout so `tokio::time::pause()`/`advance()` works.

1. `supervise_returns_clean_exit_on_normal_completion` —
   `make_fut` returns a future that completes Ok immediately. Outcome:
   `CleanExit`.

2. `supervise_recovers_from_single_panic` —
   First call returns a panicking future; second call returns Ok. Outcome:
   `CleanExit`. Assert exactly one panic was logged (via `tracing-test`).

3. `supervise_returns_budget_exceeded_after_n_panics` —
   `make_fut` always panics. Outcome: `BudgetExceeded { count: 5, .. }`.
   Assert the future was called 5 times.

4. `supervise_resets_count_after_window` — uses `tokio::time::pause()`.
   The supervisor only returns when it terminates, so "count was reset"
   must be observed via the final outcome. Test sequence:
   - `make_fut` is a stateful closure with a script: panic, panic, panic,
     panic, `tokio::time::advance(70s)`, return Ok.
   - Expected outcome: `CleanExit` (the 5th call returns Ok, so we never
     reach the budget — and the advance proves the supervisor didn't
     time out the window prematurely either).
   - Companion test `supervise_does_not_reset_count_within_window` runs
     panic×5 with no advance, expects `BudgetExceeded { count: 5, .. }`.
   - Companion test `supervise_resets_then_panics_again` runs
     panic×4, `advance(70s)`, panic×5. Expected outcome:
     `BudgetExceeded { count: 5, .. }` — the second cluster's count
     started fresh after the window reset.

5. `supervise_captures_first_and_last_panic_messages` —
   panic with message "first", then 4 more panics with message "later".
   `BudgetExceeded.first_msg == "first"`, `last_msg == "later"`.

The `std::process::exit(1)` and the 30s `sleep` are NOT in the supervisor
itself — they're at the call site in `server.rs`. Tests cover the
supervisor outcome; the exit decision is one line of glue, not unit-tested.

### Integration test — channel survives a worker panic

`crates/relay/tests/link_indexer_channel_survives_panic.rs`. The point: prove
that after a worker panic, the receiver-by-mut-ref refactor preserves the
channel so subsequent sends from `on_document_update` still land.

To avoid polluting production code with a test-only "poison" sentinel, the
test exercises the supervisor directly with a synthetic worker function
that has the same signature as `run_worker`:

```rust
#[tokio::test(flavor = "multi_thread")]
async fn channel_survives_worker_panic() {
    let (tx, mut rx) = mpsc::channel::<String>(16);
    let processed = Arc::new(Mutex::new(Vec::<String>::new()));

    let processed_for_worker = processed.clone();
    let worker = move |rx: &mut mpsc::Receiver<String>| {
        let processed = processed_for_worker.clone();
        Box::pin(async move {
            while let Some(msg) = rx.recv().await {
                if msg == "poison" {
                    panic!("worker poisoned by test");
                }
                processed.lock().unwrap().push(msg);
            }
        }) as Pin<Box<dyn Future<Output = ()> + Send + '_>>
    };

    let supervisor_handle = tokio::spawn(async move {
        supervise(
            "test_worker",
            &mut rx,
            worker,
            |_, _, _, _| {},
        ).await
    });

    tx.send("hello".into()).await.unwrap();
    tx.send("poison".into()).await.unwrap();
    // After the panic, supervisor restarts the worker. The next message
    // must still land on the same channel.
    tx.send("world".into()).await.unwrap();
    drop(tx);

    let outcome = supervisor_handle.await.unwrap();
    assert!(matches!(outcome, SupervisorOutcome::CleanExit));
    assert_eq!(*processed.lock().unwrap(), vec!["hello", "world"]);
}
```

This test does NOT touch the real `LinkIndexer::run_worker`. It verifies
the supervisor's contract — "after a panic, the same `&mut Receiver` is
still wired to live senders" — which is the property that the
receiver-by-mut-ref refactor is supposed to deliver. A separate test
exercises the real worker end-to-end (the concurrency test in Section B),
where the assertion is "no panics; resolver stays consistent."

## Operational observability

Three monitoring channels, all reusing existing infrastructure. No new
ports, no new daemons, no new dependencies.

### 1. Structured tracing logs

Every supervisor event emits a tracing record with structured fields:

| Field | Meaning |
|-------|---------|
| `worker` | `"link_indexer"`, `"search_index"`, `"on_document_update"` |
| `attempt` | 1..PANIC_BUDGET; absent on clean exit / budget-exceeded |
| `budget` | PANIC_BUDGET constant |
| `panic_msg` | First line of the panic payload |
| `panic_count` | Total panics in current window (on budget-exceeded) |
| `first_panic_msg` / `last_panic_msg` | On budget-exceeded only |

Records emitted:

- ERROR per panic: `worker={name} attempt={n}/{budget} panic_msg=<msg>` — message `"Worker panicked; restarting"`
- ERROR on budget exceeded: `worker={name} panic_count=<n> first_panic_msg=<...> last_panic_msg=<...>` — message `"CRITICAL: panic budget exceeded; exiting process for container restart"`
- INFO on clean exit: `worker={name}` — message `"exited cleanly (channel closed)"`

These structured fields enable log aggregator queries (Loki/ELK):
- Alert: `count_over_time({service="relay-server"} | json | panic_msg != "" [10m]) > 0` → "any worker panic in last 10 min"
- Dashboard: panel grouping `worker` by `panic_msg` over time → identifies recurring panics by message prefix

Replace the old `"...is now dead — restart the server."` strings at
`server.rs:828`, `:830`, `:867`, `:870` when the supervisor lands — those
messages will be misleading once the supervisor handles restarts.

### 2. Prometheus metrics (extend `RelayMetrics`)

Add three new metrics to `crates/y-sweet-core/src/metrics.rs` alongside the
existing webhook/event metrics. Names follow the existing
`relay_server_*` prefix convention (see e.g. `relay_server_webhook_requests_total`
at metrics.rs:43):

```rust
// Counter: total panics observed by any supervisor, labelled by worker.
pub relay_server_worker_panics_total: CounterVec,  // labels: ["worker"]

// Counter: times a worker exceeded its panic budget and triggered
// process exit. Should be ~0 in steady state. Strong alert signal.
pub relay_server_worker_panic_budget_exceeded_total: CounterVec,  // labels: ["worker"]

// Gauge: 1 if the worker's supervisor task is still running and
// processing; 0 if the supervisor has decided to exit the process
// (the gauge is set to 0 *before* the 30s pre-exit sleep, so
// scrapers see the change immediately). Process restart resets the
// gauge to 1; the durable record of an exit lives in
// `_worker_panic_budget_exceeded_total`.
pub relay_server_worker_alive: GaugeVec,  // labels: ["worker"]
```

Initialized to `1` (`_worker_alive`) on worker spawn;
`_worker_panics_total` increments via the `on_panic` callback in
`supervise(...)`; `_worker_panic_budget_exceeded_total` increments and
`_worker_alive` is set to `0` at the call site immediately before
`graceful_exit_after_delay`.

Scraping: already exposed at `/metrics` on the metrics port
(`server.rs:3510`). No change.

Alert candidates (in operator's Prometheus config, not ours):
- `relay_server_worker_panic_budget_exceeded_total > 0` (any time) → page
- `rate(relay_server_worker_panics_total[10m]) > 0` → warn
- `relay_server_worker_alive == 0` → page (worker has decided to die)

### 3. `WorkerStatusMap` — shared state between supervisor and `/ready`

The supervisor's internal `panic_count` is a local variable, not exposed.
The Prometheus counter is monotonic and won't give a "panics in the last
N seconds" value. So we add a small shared structure for cross-channel
state, with one record per worker name:

```rust
// In a new file: crates/relay/src/worker_status.rs

use dashmap::DashMap;
use std::sync::Arc;
use tokio::time::{Duration, Instant};

const WINDOW: Duration = Duration::from_secs(300);  // 5 min sliding window

#[derive(Default)]
pub struct WorkerStatusMap {
    /// worker name -> recent panic timestamps (Instant, msg)
    entries: DashMap<&'static str, WorkerStatus>,
}

#[derive(Default)]
pub struct WorkerStatus {
    pub alive: bool,
    /// Sliding window of recent panic instants; trimmed on access.
    pub panics: Vec<(Instant, String)>,
}

impl WorkerStatusMap {
    pub fn register(&self, worker: &'static str) {
        self.entries.entry(worker).or_default().alive = true;
    }
    pub fn record_panic(&self, worker: &'static str, msg: &str) {
        let mut e = self.entries.entry(worker).or_default();
        e.panics.push((Instant::now(), msg.to_string()));
    }
    pub fn mark_dead(&self, worker: &'static str) {
        if let Some(mut e) = self.entries.get_mut(worker) { e.alive = false; }
    }
    /// Read snapshot for /ready, trimming expired panics on the fly.
    pub fn snapshot(&self) -> Vec<(&'static str, bool, u32)> {
        let cutoff = Instant::now() - WINDOW;
        self.entries.iter().map(|e| {
            let recent = e.panics.iter().filter(|(t, _)| *t > cutoff).count() as u32;
            (*e.key(), e.alive, recent)
        }).collect()
    }
}
```

`Server` holds `Arc<WorkerStatusMap>`. The supervisor's `on_panic` callback
calls `record_panic`; the budget-exceeded branch calls `mark_dead`. The
`/ready` handler reads via `snapshot()`. DashMap gives us cheap lock-free
reads from `/ready` even while the supervisor writes.

The sliding-window trim happens lazily on `snapshot()`. If a worker is
quiet for hours, its panics vector still holds stale entries until the
next `snapshot()` call — fine, the entries are small. If size becomes a
concern, trim inside `record_panic` too.

### 4. `/ready` endpoint extension

The existing `/ready` (`server.rs:4054`) returns `{"ok": true}` unconditionally.
Extend it to also report worker state:

```rust
#[derive(Serialize)]
struct ReadyResponse {
    ok: bool,
    workers: Vec<WorkerReadiness>,
}

#[derive(Serialize)]
struct WorkerReadiness {
    name: String,
    alive: bool,
    panics_in_window: u32,
}

async fn ready(State(server): State<Arc<Server>>) -> Json<ReadyResponse> {
    let workers: Vec<_> = server.worker_status.snapshot().into_iter()
        .map(|(name, alive, panics)| WorkerReadiness {
            name: name.to_string(), alive, panics_in_window: panics,
        })
        .collect();
    let ok = workers.iter().all(|w| w.alive);
    Json(ReadyResponse { ok, workers })
}
```

#### Backward compatibility

Existing probes that check HTTP 200 OK continue to work (status code
unchanged). Probes that parse `{"ok": true}` continue to work (field
preserved). **Behavioural change**: `/ready` may now return `{"ok": false}`
with HTTP 200 during the pre-exit window. Probes that match on the
literal string `{"ok": true}` see this as a difference; probes that
parse JSON and check `ok` field continue to do the right thing (treat
`ok: false` as not ready).

#### Interaction with relay-watchdog

The relay-watchdog (`docs/relay-watchdog.md`) currently restarts the
container when HTTP is unresponsive. Once `/ready` reflects worker
state, the watchdog *could* additionally treat `{"ok": false}` as
"restart needed" — but this duplicates the supervisor's own
`graceful_exit_after_delay` cycle. The two would race: whichever fires
first restarts the container, the other is preempted.

**Decision**: the watchdog continues to look only at HTTP responsiveness,
not at the `ok` field. The supervisor owns the worker-liveness restart
decision. Operators reading `/ready` for monitoring get accurate
information; the watchdog's job stays narrow. We update the
relay-watchdog doc to make this contract explicit when the supervisor
lands.

### What this gives us

After this monitoring lands:
- Every panic is counted (metric) AND logged (structured).
- A single panic doesn't degrade the service; budget-exceeded does and is
  loudly signalled in three channels (CRITICAL log, counter increment,
  `worker_alive=0`).
- The watchdog gets a meaningful `/ready` signal that catches the case
  this incident proved is real: HTTP healthy, workers dead.
- Operators can build dashboards against existing Prometheus infrastructure
  without us shipping any new agent.

### What is still out of scope

- Per-message labels on `worker_panics_total` (panic messages are
  high-cardinality; we keep them in logs, not metrics).
- A dedicated `/healthz` distinct from `/ready` (overkill — one endpoint
  reporting worker readiness is enough).
- Pushing metrics to an external system. The `/metrics` endpoint is
  pull-based, the standard Prometheus pattern.

## Order of work

1. **A — UTF-8 fix.** Pure-function tests, fastest TDD loop. Derisks the
   test infrastructure for the project.
2. **C — Worker supervisor.** Concrete safety net before touching the
   harder concurrency bug.
3. **B — `SharedAcqFailed` investigation and fix.** Highest risk, lowest
   confidence; ships with the safety net in place.

Each ships as its own commit (and likely its own PR for review).

## Non-goals

- Defensive fallback in `move_path` (rejected).
- A dedicated `/healthz` endpoint separate from `/ready`. We extend the
  existing `/ready` instead.
- Replacing `tokio::mpsc::channel` with a different transport.
- Wrapping the synchronous portion of the broker callback at
  `server.rs:2702`. Already protected per-request by axum's panic-to-500.
  Revisit if a future incident proves otherwise.
- Catching panics in `tokio::spawn` sites outside the worker tasks and
  `on_document_update`. Other spawns can be addressed in a follow-up if a
  future incident points there.
- Per-panic-message metric labels (high cardinality). Messages go to logs.

## Risks

- **`SharedAcqFailed` may be unreproducible.** Mitigation: ship A and C
  first. The supervisor will recover from future occurrences.
- **The supervisor masks recurring bugs in logs.** Mitigation: each panic is
  logged at ERROR with the message; budget-exceeded is CRITICAL with both
  endpoints (first and last panic). A log alert on "Worker panicked: " is
  the operational counter.
- **Partial commits during a panicking transaction persist to R2.**
  Mitigation: the transaction-idempotency invariant; audit existing
  `transact_mut_with("link-indexer")` blocks.
- **Channel-by-mut-ref signature change ripples through tests.** Mitigation:
  confined to `LinkIndexer::run_worker` and `search_worker` signatures.
  Internal callers and the public surface unchanged.
- **Docker restart loop on deterministic post-budget panic.** Mitigation:
  30s pre-exit delay, plus the watchdog observes a process flap.
