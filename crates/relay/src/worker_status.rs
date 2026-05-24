//! Cross-channel state for the worker supervisor and `/ready` endpoint.
//!
//! The supervisor records panics here via `record_panic`; the `/ready`
//! handler reads via `snapshot()`. DashMap gives lock-free reads from
//! `/ready` even while the supervisor writes.
//!
//! Sliding window (5 min) for `panics_in_window`; older entries are
//! trimmed lazily on `snapshot()`.
//!
//! See `docs/superpowers/specs/2026-05-20-link-indexer-resilience-design.md`
//! section 3.

use dashmap::DashMap;
use tokio::time::{Duration, Instant};

pub const PANIC_WINDOW: Duration = Duration::from_secs(300);

#[derive(Default)]
pub struct WorkerStatusMap {
    entries: DashMap<&'static str, WorkerStatus>,
}

#[derive(Default)]
pub struct WorkerStatus {
    pub alive: bool,
    pub panics: Vec<(Instant, String)>,
}

impl WorkerStatusMap {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mark a worker as alive on spawn. Idempotent.
    pub fn register(&self, worker: &'static str) {
        let mut e = self.entries.entry(worker).or_default();
        e.alive = true;
    }

    /// Record a panic for the worker with the current Instant.
    pub fn record_panic(&self, worker: &'static str, msg: &str) {
        let mut e = self.entries.entry(worker).or_default();
        e.panics.push((Instant::now(), msg.to_string()));
    }

    /// Flip the worker's alive flag to false. Called when the supervisor
    /// decides to exit the process.
    pub fn mark_dead(&self, worker: &'static str) {
        if let Some(mut e) = self.entries.get_mut(worker) {
            e.alive = false;
        }
    }

    /// Snapshot for /ready: (worker_name, alive, panics_in_window).
    /// Trims expired panics on the fly.
    pub fn snapshot(&self) -> Vec<(&'static str, bool, u32)> {
        let cutoff = Instant::now().checked_sub(PANIC_WINDOW);
        self.entries
            .iter()
            .map(|e| {
                let recent = match cutoff {
                    Some(c) => e.panics.iter().filter(|(t, _)| *t > c).count() as u32,
                    None => e.panics.len() as u32,
                };
                (*e.key(), e.alive, recent)
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_then_snapshot_reports_alive_and_zero_panics() {
        let map = WorkerStatusMap::new();
        map.register("link_indexer");

        let snap = map.snapshot();
        assert_eq!(snap.len(), 1);
        let (name, alive, panics) = snap[0];
        assert_eq!(name, "link_indexer");
        assert!(alive);
        assert_eq!(panics, 0);
    }

    #[test]
    fn record_panic_increments_panics_in_window() {
        let map = WorkerStatusMap::new();
        map.register("link_indexer");
        map.record_panic("link_indexer", "boom");
        map.record_panic("link_indexer", "boom2");

        let snap = map.snapshot();
        let (_, _, panics) = snap.iter().find(|(n, _, _)| *n == "link_indexer").unwrap();
        assert_eq!(*panics, 2);
    }

    #[test]
    fn mark_dead_flips_alive_to_false() {
        let map = WorkerStatusMap::new();
        map.register("search_index");
        map.mark_dead("search_index");

        let snap = map.snapshot();
        let (_, alive, _) = snap.iter().find(|(n, _, _)| *n == "search_index").unwrap();
        assert!(!*alive);
    }

    /// Sliding window: panics older than PANIC_WINDOW (5 min) are NOT
    /// counted. We fake aging by inserting an old Instant directly.
    #[test]
    fn snapshot_trims_panics_older_than_window() {
        let map = WorkerStatusMap::new();
        map.register("link_indexer");

        // Insert an "ancient" panic by reaching into the entry.
        {
            let mut e = map.entries.get_mut("link_indexer").unwrap();
            let ancient = Instant::now()
                .checked_sub(PANIC_WINDOW + Duration::from_secs(10))
                .expect("ancient instant should be representable");
            e.panics.push((ancient, "old panic".to_string()));
        }
        // And one recent panic.
        map.record_panic("link_indexer", "recent");

        let snap = map.snapshot();
        let (_, _, panics) = snap.iter().find(|(n, _, _)| *n == "link_indexer").unwrap();
        assert_eq!(*panics, 1, "only the recent panic should count");
    }

    #[test]
    fn multiple_workers_tracked_independently() {
        let map = WorkerStatusMap::new();
        map.register("link_indexer");
        map.register("search_index");
        map.record_panic("link_indexer", "boom");
        map.mark_dead("search_index");

        let snap = map.snapshot();
        let li = snap.iter().find(|(n, _, _)| *n == "link_indexer").unwrap();
        let si = snap.iter().find(|(n, _, _)| *n == "search_index").unwrap();
        assert!(li.1);
        assert_eq!(li.2, 1);
        assert!(!si.1);
        assert_eq!(si.2, 0);
    }
}
