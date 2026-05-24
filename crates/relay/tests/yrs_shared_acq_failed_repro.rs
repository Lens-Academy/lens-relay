//! Bug B regression test: yrs `SharedAcqFailed` from `DocWithSyncKv` lock misuse.
//!
//! Production incident 2026-05-18: the link_indexer worker panicked with
//! `there's another active read-write transaction at the moment:
//! SharedAcqFailed` (yrs/doc.rs:950). The supervisor wasn't in place yet,
//! so the worker died and stopped updating the DocumentResolver — files
//! created over the following 22 hours couldn't be renamed.
//!
//! **Root cause**: `DocWithSyncKv::compact_user_data` (and
//! `register_client_id`) took `awareness.read()` (shared lock) but then
//! invoked `doc.transact_mut()` internally. The outer shared lock allows
//! concurrent readers to coexist; meanwhile the inner transact_mut clashes
//! with a concurrent reader's `doc.transact()`, and yrs's internal
//! `RefCell` panics with `SharedAcqFailed`.
//!
//! **Fix**: take `awareness.write()` in those two methods. The exclusive
//! outer lock blocks readers while the internal write transaction runs.
//!
//! See `docs/superpowers/specs/2026-05-20-link-indexer-resilience-design.md`
//! section Bug B.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use yrs::{ReadTxn, Transact};

/// Production regression: `DocWithSyncKv::compact_user_data` must not
/// panic when racing with a concurrent reader using the link_indexer's
/// `awareness.read() + doc.transact()` pattern.
///
/// Before the fix this asserted `n > 0` panics; after the fix
/// (awareness.write() inside compact_user_data) we lock in the
/// post-fix expectation: zero panics.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn compact_user_data_does_not_race_with_concurrent_read_txn() {
    use y_sweet_core::doc_sync::DocWithSyncKv;

    let dwskv = Arc::new(
        DocWithSyncKv::new("compact-race-test", None, || {}, None)
            .await
            .unwrap(),
    );

    let panics = Arc::new(AtomicUsize::new(0));
    let stop = Arc::new(AtomicBool::new(false));

    // Compactor: repeatedly call compact_user_data.
    let dwskv_w = dwskv.clone();
    let stop_w = stop.clone();
    let panics_w = panics.clone();
    let compactor = std::thread::spawn(move || {
        while !stop_w.load(Ordering::SeqCst) {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                dwskv_w.compact_user_data();
            }));
            if result.is_err() {
                panics_w.fetch_add(1, Ordering::SeqCst);
            }
        }
    });

    // Reader: mirror the link_indexer pattern.
    let dwskv_r = dwskv.clone();
    let stop_r = stop.clone();
    let panics_r = panics.clone();
    let reader = std::thread::spawn(move || {
        while !stop_r.load(Ordering::SeqCst) {
            let awareness = dwskv_r.awareness();
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let guard = awareness.read().unwrap();
                let txn = guard.doc.transact();
                let _ = txn.get_map("users");
            }));
            if result.is_err() {
                panics_r.fetch_add(1, Ordering::SeqCst);
            }
        }
    });

    std::thread::sleep(Duration::from_millis(500));
    stop.store(true, Ordering::SeqCst);
    compactor.join().unwrap();
    reader.join().unwrap();

    let n = panics.load(Ordering::SeqCst);
    assert_eq!(
        n, 0,
        "compact_user_data must not panic when racing with concurrent readers \
         (the awareness.write() fix should serialize); got {n} panics"
    );
}
