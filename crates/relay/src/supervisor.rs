//! Worker supervisor with bounded retry + escalation.
//!
//! Wraps a worker future in a retry loop. On panic, the supervisor logs,
//! invokes the `on_panic` hook (used for metrics), and retries. After
//! `PANIC_BUDGET` panics within `PANIC_WINDOW`, it returns
//! `SupervisorOutcome::BudgetExceeded`, signaling the caller to exit the
//! process so Docker `restart: unless-stopped` cycles the container.
//!
//! See `docs/superpowers/specs/2026-05-20-link-indexer-resilience-design.md`.

use futures::future::FutureExt;
use std::any::Any;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::pin::Pin;
use tokio::time::{Duration, Instant};

pub const PANIC_BUDGET: u32 = 5;
pub const PANIC_WINDOW: Duration = Duration::from_secs(60);

/// Outcome of a supervised worker run.
#[derive(Debug)]
pub enum SupervisorOutcome {
    /// Worker exited cleanly (channel closed). Supervisor stops.
    CleanExit,
    /// Worker exceeded the panic budget within the window. Caller should
    /// log a CRITICAL line and exit the process.
    BudgetExceeded {
        count: u32,
        first_msg: String,
        last_msg: String,
    },
}

/// Run `make_fut` repeatedly, threading `state: &mut R` through each call.
/// On panic: count, log, retry. After `PANIC_BUDGET` panics within
/// `PANIC_WINDOW`, return `BudgetExceeded`.
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

/// Update observability state (metrics + worker status map) for a
/// terminal supervisor outcome. Separated from `handle_worker_outcome` so
/// it can be unit-tested without triggering `process::exit`. Called
/// immediately before the process exits on `BudgetExceeded`, so
/// Prometheus scrapers see the gauge drop and /ready reflects the dead
/// worker.
pub fn apply_outcome(
    name: &'static str,
    outcome: &SupervisorOutcome,
    metrics: &y_sweet_core::metrics::RelayMetrics,
    status: &crate::worker_status::WorkerStatusMap,
) {
    match outcome {
        SupervisorOutcome::CleanExit => {}
        SupervisorOutcome::BudgetExceeded { .. } => {
            metrics.record_worker_budget_exceeded(name);
            metrics.set_worker_alive(name, false);
            status.mark_dead(name);
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;
    use tokio::sync::mpsc;

    // === Bug C: production panic-loses-messages replication ===
    //
    // Prod bug (2026-05-18): the link indexer worker panicked once,
    // catch_unwind logged CRITICAL, the task exited, and every subsequent
    // folder doc update was lost for 22 hours. The supervisor must
    // recover the worker across panic so subsequent messages keep
    // flowing.
    //
    // These tests assert the OBSERVABLE PROPERTY (messages survive a
    // worker panic) by directing real `tokio::sync::mpsc` traffic
    // through the supervisor. The worker function is a synthetic
    // stand-in shaped like the real `LinkIndexer::run_worker`, because
    // we don't have a reliable way to make the real worker panic from
    // outside (no test-only hooks in production code, per testing
    // anti-pattern guidance).

    fn no_op_panic_hook(_w: &str, _m: &str, _a: u32, _b: u32) {}

    /// Worker function with the same shape as the production
    /// `run_worker`: takes `&mut Receiver<T>`, returns a future.
    /// Panics when it sees the sentinel 0.
    fn poison_worker_step<'r>(
        rx: &'r mut mpsc::Receiver<u32>,
        processed: Arc<AtomicU32>,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'r>> {
        Box::pin(async move {
            while let Some(n) = rx.recv().await {
                if n == 0 {
                    panic!("poison");
                }
                processed.fetch_add(n, Ordering::SeqCst);
            }
        })
    }

    /// Prod-bug replication: a worker panics on one message; the
    /// supervisor must restart it so subsequent messages on the same
    /// channel are still processed.
    ///
    /// Today: supervise() is unimplemented (todo!) — test fails.
    /// After the fix: messages 1 + 2 both processed; outcome CleanExit.
    #[tokio::test(flavor = "multi_thread")]
    async fn messages_survive_worker_panic_via_supervisor() {
        let (tx, mut rx) = mpsc::channel::<u32>(16);
        let processed = Arc::new(AtomicU32::new(0));
        let processed_for_worker = processed.clone();

        let supervisor_handle = tokio::spawn(async move {
            supervise(
                "test_worker",
                &mut rx,
                move |rx| poison_worker_step(rx, processed_for_worker.clone()),
                no_op_panic_hook,
            )
            .await
        });

        tx.send(1).await.unwrap(); // processed
        tx.send(0).await.unwrap(); // panic
        tx.send(2).await.unwrap(); // processed AFTER recovery — prod bug loses this
        drop(tx);

        let outcome = supervisor_handle.await.unwrap();
        assert!(matches!(outcome, SupervisorOutcome::CleanExit));
        assert_eq!(
            processed.load(Ordering::SeqCst),
            3,
            "after the supervisor restart, message 2 should be processed (sum = 1 + 2)"
        );
    }

    /// Bounded-escalation property: persistent panics eventually return
    /// BudgetExceeded so the caller can exit the process for container
    /// restart. Without a bound, the supervisor would spin forever.
    #[tokio::test(flavor = "multi_thread")]
    async fn persistent_panics_escalate_to_budget_exceeded() {
        let (tx, mut rx) = mpsc::channel::<u32>(16);
        let panic_count = Arc::new(AtomicU32::new(0));
        let panic_count_for_hook = panic_count.clone();

        let supervisor_handle = tokio::spawn(async move {
            supervise(
                "test_worker",
                &mut rx,
                |rx| {
                    Box::pin(async move {
                        // Always panic on the first message we receive.
                        if rx.recv().await.is_some() {
                            panic!("always-poison");
                        }
                    })
                },
                move |_, _, _, _| {
                    panic_count_for_hook.fetch_add(1, Ordering::SeqCst);
                },
            )
            .await
        });

        // Send PANIC_BUDGET poison messages.
        for _ in 0..PANIC_BUDGET {
            tx.send(0).await.unwrap();
        }
        drop(tx);

        let outcome = supervisor_handle.await.unwrap();
        match outcome {
            SupervisorOutcome::BudgetExceeded { count, .. } => {
                assert_eq!(count, PANIC_BUDGET);
            }
            other => panic!("expected BudgetExceeded, got {:?}", other),
        }
        assert_eq!(panic_count.load(Ordering::SeqCst), PANIC_BUDGET);
    }

    // === Observability wiring ===
    //
    // After Bug C, every worker panic must be visible in Prometheus so an
    // operator can see panic activity and budget exhaustion. The supervisor
    // exposes hooks (`on_panic` callback + `SupervisorOutcome`); these tests
    // verify the metric updates that production wires into those hooks.

    use prometheus::Registry;
    use y_sweet_core::metrics::RelayMetrics;

    /// Driving `supervise()` with a metrics-recording `on_panic` callback
    /// must increment `worker_panics_total{worker=<name>}` for each panic.
    /// Today, production wires `|_, _, _, _| {}` — silent. After observability
    /// lands, the on_panic must call `metrics.record_worker_panic(worker)`.
    #[tokio::test(flavor = "multi_thread")]
    async fn supervisor_on_panic_increments_worker_panics_total() {
        let registry = Registry::new();
        let metrics = RelayMetrics::new_with_registry(&registry).unwrap();

        let (tx, mut rx) = mpsc::channel::<u32>(16);
        let metrics_for_hook = metrics.clone();

        let supervisor_handle = tokio::spawn(async move {
            supervise(
                "metrics_test_worker",
                &mut rx,
                |rx| {
                    Box::pin(async move {
                        if rx.recv().await.is_some() {
                            panic!("metric-test-poison");
                        }
                    })
                },
                move |worker, _msg, _attempt, _budget| {
                    metrics_for_hook.record_worker_panic(worker);
                },
            )
            .await
        });

        // Send 3 panic-inducing messages — each triggers a panic + restart.
        for _ in 0..3 {
            tx.send(0).await.unwrap();
        }
        drop(tx);
        let _ = supervisor_handle.await.unwrap();

        let recorded = metrics
            .worker_panics_total
            .with_label_values(&["metrics_test_worker"])
            .get();
        assert_eq!(
            recorded, 3.0,
            "each panic should increment worker_panics_total"
        );
    }

    /// BudgetExceeded outcome must drive `worker_panic_budget_exceeded_total`
    /// up by 1 and set `worker_alive` to 0. Today, production runs
    /// `std::process::exit(1)` with no metric updates — operator never sees
    /// the increment unless they catch the metric scrape mid-exit. After
    /// observability lands, an `apply_outcome` helper sets these
    /// before the process exits, and Prometheus scrapes the change.
    #[test]
    fn budget_exceeded_records_metrics_and_marks_dead() {
        let registry = Registry::new();
        let metrics = RelayMetrics::new_with_registry(&registry).unwrap();
        let status = crate::worker_status::WorkerStatusMap::new();

        // Pre-set alive so we can observe the transition.
        metrics.set_worker_alive("budget_test_worker", true);
        assert_eq!(
            metrics
                .worker_alive
                .with_label_values(&["budget_test_worker"])
                .get(),
            1.0
        );

        let outcome = SupervisorOutcome::BudgetExceeded {
            count: PANIC_BUDGET,
            first_msg: "first".to_string(),
            last_msg: "last".to_string(),
        };
        apply_outcome("budget_test_worker", &outcome, &metrics, &status);

        assert_eq!(
            metrics
                .worker_panic_budget_exceeded_total
                .with_label_values(&["budget_test_worker"])
                .get(),
            1.0
        );
        assert_eq!(
            metrics
                .worker_alive
                .with_label_values(&["budget_test_worker"])
                .get(),
            0.0,
            "alive gauge should drop to 0 when the supervisor decides to exit"
        );
    }

    /// BudgetExceeded outcome must also call `mark_dead` on the
    /// WorkerStatusMap so /ready stops reporting the worker as alive.
    /// This is the cross-channel state the supervisor and /ready endpoint
    /// share.
    #[test]
    fn budget_exceeded_marks_worker_dead_in_status_map() {
        let registry = Registry::new();
        let metrics = RelayMetrics::new_with_registry(&registry).unwrap();
        let status = crate::worker_status::WorkerStatusMap::new();
        status.register("status_test_worker");

        let outcome = SupervisorOutcome::BudgetExceeded {
            count: PANIC_BUDGET,
            first_msg: "first".to_string(),
            last_msg: "last".to_string(),
        };
        apply_outcome("status_test_worker", &outcome, &metrics, &status);

        let snap = status.snapshot();
        let (_, alive, _) = snap
            .iter()
            .find(|(n, _, _)| *n == "status_test_worker")
            .expect("worker should appear in snapshot");
        assert!(!*alive, "BudgetExceeded must flip alive to false");
    }

    /// CleanExit outcome must NOT touch metrics: the worker stopped because
    /// the channel closed (e.g., graceful shutdown), not because of a panic.
    #[test]
    fn clean_exit_does_not_touch_metrics() {
        let registry = Registry::new();
        let metrics = RelayMetrics::new_with_registry(&registry).unwrap();
        let status = crate::worker_status::WorkerStatusMap::new();

        metrics.set_worker_alive("clean_test_worker", true);
        apply_outcome(
            "clean_test_worker",
            &SupervisorOutcome::CleanExit,
            &metrics,
            &status,
        );

        assert_eq!(
            metrics
                .worker_panic_budget_exceeded_total
                .with_label_values(&["clean_test_worker"])
                .get(),
            0.0
        );
        assert_eq!(
            metrics
                .worker_alive
                .with_label_values(&["clean_test_worker"])
                .get(),
            1.0,
            "clean exit must not flip alive=0"
        );
    }
}
