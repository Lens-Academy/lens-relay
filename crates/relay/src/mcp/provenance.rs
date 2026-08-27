//! AI provenance for MCP edits (docs/plans/2026-07-18-provenance-design.md).
//!
//! Every Y.Text item permanently carries the clientID of the doc instance that
//! created it, and the editor resolves clientIDs to actors through the
//! document's "users" PermanentUserData map. The server's own doc runs under
//! an arbitrary clientID shared by every subsystem, so MCP edits applied
//! directly would be indistinguishable from anything else the server writes.
//!
//! Instead, each MCP session owns a dedicated AI clientID. Edits are applied
//! in a scratch `Doc` created with that clientID (synced from the live doc's
//! state), and the resulting delta update is applied back to the live doc —
//! exactly how a remote client's edit arrives, just in-process. The scratch
//! transaction also registers the session's actor string in the "users" map
//! (idempotently, with a `registeredAt` timestamp), so there is no window of
//! unattributed AI text.

use std::collections::HashMap;
use yrs::branch::{Branch, BranchPtr};
use yrs::types::text::YChange;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{
    Any, Array, ArrayPrelim, ArrayRef, Assoc, DeleteSet, Doc, GetString, Map, MapPrelim, MapRef,
    Options, Out, ReadTxn, Snapshot, StateVector, StickyIndex, Text, TextRef, Transact,
    TransactionMut, Update, WriteTxn,
};

/// AI identity to attribute server-side writes to, carried from the MCP
/// session into `Server::create_document*`.
#[derive(Debug, Clone)]
pub struct AiAttribution {
    pub client_id: u64,
    pub actor: String,
    /// CriticMarkup author shown in the review UI: "AI" or "{name}'s AI".
    pub suggestion_author: String,
}

/// Apply a text edit to `doc`'s "contents" Y.Text so the inserted items carry
/// `ai_client_id`, registering `actor` in the "users" map in the same update.
///
/// The caller must hold whatever lock guards `doc` against concurrent writers
/// for the duration of this call (the MCP edit path holds the awareness write
/// guard), so the read-mutate-apply sequence is atomic with respect to other
/// server-side writers.
///
/// `mutate` may inspect the scratch doc (e.g. [`visible_runs`]) before
/// deciding what to write, and may write to other root types (e.g. the
/// activity map) in the same transaction. If it returns `Err`, the scratch
/// doc is discarded and the live doc is left untouched.
pub fn apply_attributed_edit<F, T>(
    doc: &Doc,
    ai_client_id: u64,
    actor: &str,
    now_ms: u64,
    mutate: F,
) -> Result<T, String>
where
    F: FnOnce(&mut TransactionMut, &TextRef) -> Result<T, String>,
{
    // Snapshot the live doc.
    let (sv, full_state) = {
        let txn = doc.transact();
        (
            txn.state_vector(),
            txn.encode_state_as_update_v1(&StateVector::default()),
        )
    };

    // Scratch doc minting items under the AI clientID. skip_gc so the scratch
    // never garbage-collects tombstones out from under the delta encoding.
    let scratch = Doc::with_options(Options {
        client_id: ai_client_id,
        skip_gc: true,
        ..Options::default()
    });

    {
        let mut txn = scratch.transact_mut();
        let update = Update::decode_v1(&full_state)
            .map_err(|e| format!("provenance: failed to decode live doc state: {}", e))?;
        txn.apply_update(update);
    }

    let outcome = {
        let mut txn = scratch.transact_mut();
        let text = txn.get_or_insert_text("contents");
        let outcome = mutate(&mut txn, &text)?;
        register_actor(&mut txn, actor, ai_client_id, now_ms);
        outcome
    };

    // Delta relative to the live doc, applied back like a remote update.
    let delta = scratch.transact().encode_state_as_update_v1(&sv);
    {
        let mut txn = doc.transact_mut();
        let update = Update::decode_v1(&delta)
            .map_err(|e| format!("provenance: failed to decode delta: {}", e))?;
        txn.apply_update(update);
    }

    Ok(outcome)
}

/// A maximal run of consecutive visible Y.Text characters created by one
/// item: `[from, to)` are UTF-8 byte offsets into the text (the docs use
/// `OffsetKind::Bytes`); `clock` is the item's start clock (UTF-16 units).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Run {
    pub from: usize,
    pub to: usize,
    pub client: u64,
    pub clock: u32,
}

/// Walk the visible items of `text` and return their provenance runs, or
/// `None` when the walk cannot be trusted (callers must then treat the
/// text as unattributed).
///
/// Uses `Text::diff_range` with `hi` = the current state and `lo` = an empty
/// snapshot, which tags every visible item with its ID. Two guards around
/// yrs 0.19 quirks:
///
/// - `split_by_snapshot(hi)` looks up `ID(client, state)` for every client
///   in `hi.state_map` — one clock past the client's last block — and
///   `BlockStore::find_pivot` mis-computes its search pivot for that lookup
///   when the client's total clock length is 1 (divide by zero) or 2 split
///   over two blocks (index out of bounds). Any client with ≥ 3 clock units
///   is safe. When "short" clients exist, the walk runs on a throwaway copy
///   of the doc in which each short client has a 3-char dummy item appended
///   (only a doc created with that client id can mint under it), and the
///   trailing dummy runs are dropped.
/// - `hi` carries an empty delete set so nothing is split or walked per
///   deletion. A tombstone that still had string content would therefore be
///   emitted as if visible, so any run whose ID is in the real delete set,
///   or a byte total that disagrees with the text, returns `None`.
pub fn visible_runs(txn: &mut TransactionMut, text: &TextRef) -> Option<Vec<Run>> {
    let full = txn.snapshot();
    let expected_len = text.get_string(txn).len();
    let short_clients: Vec<u64> = full
        .state_map
        .iter()
        .filter(|(_, &state)| state > 0 && state <= 2)
        .map(|(&client, _)| client)
        .collect();

    if short_clients.is_empty() {
        return runs_via_diff(txn, text, &full, expected_len);
    }

    let state = txn.encode_state_as_update_v1(&StateVector::default());
    let copy = Doc::with_options(Options {
        skip_gc: true,
        ..Options::default()
    });
    {
        let mut ctxn = copy.transact_mut();
        ctxn.apply_update(Update::decode_v1(&state).ok()?);
    }
    for client in short_clients {
        let helper = Doc::with_options(Options {
            client_id: client,
            skip_gc: true,
            ..Options::default()
        });
        let base = copy
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        {
            let mut htxn = helper.transact_mut();
            htxn.apply_update(Update::decode_v1(&base).ok()?);
            let t = htxn.get_or_insert_text("contents");
            let len = t.get_string(&htxn).len() as u32;
            t.insert(&mut htxn, len, "\u{0}\u{0}\u{0}");
        }
        let augmented = helper
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let mut ctxn = copy.transact_mut();
        ctxn.apply_update(Update::decode_v1(&augmented).ok()?);
    }
    let mut ctxn = copy.transact_mut();
    let ctext = ctxn.get_or_insert_text("contents");
    let cfull = ctxn.snapshot();
    let clen = ctext.get_string(&ctxn).len();
    let mut runs = runs_via_diff(&mut ctxn, &ctext, &cfull, clen)?;
    // Drop the dummies. A dummy appended right after its own client's last
    // item merges with it into one block, so clip rather than filter.
    runs.retain(|r| r.from < expected_len);
    for r in &mut runs {
        r.to = r.to.min(expected_len);
    }
    if runs.last().map(|r| r.to).unwrap_or(0) != expected_len {
        return None;
    }
    Some(runs)
}

fn runs_via_diff(
    txn: &mut TransactionMut,
    text: &TextRef,
    full: &Snapshot,
    expected_len: usize,
) -> Option<Vec<Run>> {
    let hi = Snapshot::new(full.state_map.clone(), DeleteSet::default());
    let lo = Snapshot::new(StateVector::default(), DeleteSet::default());
    let diffs = text.diff_range(txn, Some(&hi), Some(&lo), YChange::identity);
    let mut runs = Vec::with_capacity(diffs.len());
    let mut pos = 0usize;
    for d in diffs {
        let s = match d.insert {
            Out::Any(Any::String(s)) => s,
            _ => return None,
        };
        let id = d.ychange?.id;
        if full.delete_set.is_deleted(&id) {
            return None;
        }
        let to = pos + s.len();
        runs.push(Run {
            from: pos,
            to,
            client: id.client,
            clock: id.clock,
        });
        pos = to;
    }
    if pos != expected_len {
        return None;
    }
    Some(runs)
}

/// [`visible_runs`] for callers that only hold a read transaction (index
/// workers under the awareness read guard): runs are computed on a
/// throwaway copy of the doc, so nothing in the live store is split.
pub fn visible_runs_copy<T: ReadTxn>(txn: &T) -> Option<Vec<Run>> {
    let state = txn.encode_state_as_update_v1(&StateVector::default());
    let copy = Doc::with_options(Options {
        skip_gc: true,
        ..Options::default()
    });
    let mut ctxn = copy.transact_mut();
    ctxn.apply_update(Update::decode_v1(&state).ok()?);
    let text = ctxn.get_or_insert_text("contents");
    visible_runs(&mut ctxn, &text)
}

/// Current byte offset of an encoded anchor (see [`sticky_anchor`]) in
/// the live text, or `None` when it no longer resolves.
pub fn resolve_anchor<T: ReadTxn>(txn: &T, anchor: &[u8]) -> Option<usize> {
    let idx = StickyIndex::decode_v1(anchor).ok()?;
    idx.get_offset(txn).map(|o| o.index as usize)
}

/// Encoded `Y.RelativePosition` (v1, decodable by yjs) pointing at
/// `byte_offset` in `text`, associated to the character after it, falling
/// back to the one before at end of text. `None` only for an empty text.
pub fn sticky_anchor(txn: &TransactionMut, text: &TextRef, byte_offset: usize) -> Option<Vec<u8>> {
    let branch = BranchPtr::from(AsRef::<Branch>::as_ref(text));
    let idx = StickyIndex::at(txn, branch, byte_offset as u32, Assoc::After)
        .or_else(|| StickyIndex::at(txn, branch, byte_offset as u32, Assoc::Before))?;
    Some(idx.encode_v1())
}

/// Reverse map of the "users" PermanentUserData map: clientID → actor key
/// (`human:<name>` / `ai:<model>:<behalf>`).
pub fn client_actor_map<T: ReadTxn>(txn: &T) -> HashMap<u64, String> {
    let mut out = HashMap::new();
    let Some(users) = txn.get_map("users") else {
        return out;
    };
    for (actor, value) in users.iter(txn) {
        let Out::YMap(user_map) = value else { continue };
        let Some(Out::YArray(ids)) = user_map.get(txn, "ids") else {
            continue;
        };
        for item in ids.iter(txn) {
            let id = match item {
                Out::Any(Any::Number(n)) => n as u64,
                Out::Any(Any::BigInt(n)) => n as u64,
                _ => continue,
            };
            // Provenance-prefixed actors win over any legacy raw user id.
            let entry = out.entry(id).or_insert_with(|| actor.to_string());
            if !is_provenance_actor(entry) && is_provenance_actor(actor) {
                *entry = actor.to_string();
            }
        }
    }
    out
}

fn is_provenance_actor(actor: &str) -> bool {
    actor.starts_with("human:") || actor.starts_with("ai:")
}

/// Clients responsible for the characters in `[from, to)` (byte offsets).
pub fn clients_in_range(runs: &[Run], from: usize, to: usize) -> Vec<u64> {
    let mut clients: Vec<u64> = runs
        .iter()
        .filter(|r| r.from < to && r.to > from)
        .map(|r| r.client)
        .collect();
    clients.sort_unstable();
    clients.dedup();
    clients
}

/// Register `client_id` under `actor` in the "users" PermanentUserData map.
///
/// Mirrors `register_pud_client_id_on_doc` in y-sweet-core's doc_connection.rs
/// (ids + ds arrays, canonical Yjs PUD layout) and additionally writes the
/// `meta` timestamp map used by the editor to date text runs. Idempotent.
fn register_actor(txn: &mut TransactionMut, actor: &str, client_id: u64, now_ms: u64) {
    let users: MapRef = txn.get_or_insert_map("users");

    // Already registered under this actor?
    if let Some(Out::YMap(user_map)) = users.get(txn, actor) {
        if let Some(Out::YArray(ids)) = user_map.get(txn, "ids") {
            let seen = ids.iter(txn).any(|item| match item {
                Out::Any(Any::Number(n)) => n as u64 == client_id,
                Out::Any(Any::BigInt(n)) => n as u64 == client_id,
                _ => false,
            });
            if seen {
                return;
            }
        }
    }

    let user_map: MapRef = match users.get(txn, actor) {
        Some(Out::YMap(m)) => m,
        _ => users.insert(txn, actor, MapPrelim::default()),
    };

    let ids: ArrayRef = match user_map.get(txn, "ids") {
        Some(Out::YArray(a)) => a,
        _ => user_map.insert(txn, "ids", ArrayPrelim::default()),
    };
    ids.push_back(txn, Any::Number(client_id as f64));

    if !matches!(user_map.get(txn, "ds"), Some(Out::YArray(_))) {
        user_map.insert(txn, "ds", ArrayPrelim::default());
    }

    let meta: MapRef = match user_map.get(txn, "meta") {
        Some(Out::YMap(m)) => m,
        _ => user_map.insert(txn, "meta", MapPrelim::default()),
    };
    let record = Any::Map(std::sync::Arc::new(std::collections::HashMap::from([(
        "registeredAt".to_string(),
        Any::Number(now_ms as f64),
    )])));
    meta.insert(txn, client_id.to_string(), record);
}

#[cfg(test)]
mod tests {
    use super::*;

    const AI_ID: u64 = 0x00ac_e551;
    const ACTOR: &str = "ai:fable-5:luc";

    fn doc_with_text(text: &str) -> Doc {
        let doc = Doc::new();
        {
            let mut txn = doc.transact_mut();
            let t = txn.get_or_insert_text("contents");
            t.insert(&mut txn, 0, text);
        }
        doc
    }

    fn contents(doc: &Doc) -> String {
        let txn = doc.transact();
        txn.get_text("contents").unwrap().get_string(&txn)
    }

    #[test]
    fn edit_applies_and_mints_items_under_ai_client_id() {
        let doc = doc_with_text("hello world");

        apply_attributed_edit(&doc, AI_ID, ACTOR, 1000, |txn, text| {
            text.insert(txn, 5, " brave");
            Ok(())
        })
        .unwrap();

        assert_eq!(contents(&doc), "hello brave world");
        // The state vector proves items were minted under the AI clientID.
        let txn = doc.transact();
        assert!(txn.state_vector().get(&AI_ID) > 0);
    }

    #[test]
    fn edit_registers_actor_with_timestamp() {
        let doc = doc_with_text("abc");
        apply_attributed_edit(&doc, AI_ID, ACTOR, 1234, |txn, text| {
            text.insert(txn, 3, "def");
            Ok(())
        })
        .unwrap();

        let txn = doc.transact();
        let users = txn.get_map("users").expect("users map exists");
        let entry = match users.get(&txn, ACTOR) {
            Some(Out::YMap(m)) => m,
            other => panic!("expected actor entry, got {:?}", other),
        };
        let ids: Vec<u64> = match entry.get(&txn, "ids") {
            Some(Out::YArray(a)) => a
                .iter(&txn)
                .filter_map(|v| match v {
                    Out::Any(Any::Number(n)) => Some(n as u64),
                    _ => None,
                })
                .collect(),
            other => panic!("expected ids array, got {:?}", other),
        };
        assert_eq!(ids, vec![AI_ID]);
        assert!(matches!(entry.get(&txn, "ds"), Some(Out::YArray(_))));

        let meta = match entry.get(&txn, "meta") {
            Some(Out::YMap(m)) => m,
            other => panic!("expected meta map, got {:?}", other),
        };
        match meta.get(&txn, &AI_ID.to_string()) {
            Some(Out::Any(Any::Map(record))) => {
                assert_eq!(record.get("registeredAt"), Some(&Any::Number(1234.0)));
            }
            other => panic!("expected meta record, got {:?}", other),
        }
    }

    #[test]
    fn second_edit_does_not_duplicate_registration() {
        let doc = doc_with_text("abc");
        apply_attributed_edit(&doc, AI_ID, ACTOR, 1000, |txn, text| {
            text.insert(txn, 0, "x");
            Ok(())
        })
        .unwrap();
        apply_attributed_edit(&doc, AI_ID, ACTOR, 2000, |txn, text| {
            text.insert(txn, 0, "y");
            Ok(())
        })
        .unwrap();

        assert_eq!(contents(&doc), "yxabc");
        let txn = doc.transact();
        let users = txn.get_map("users").unwrap();
        let entry = match users.get(&txn, ACTOR) {
            Some(Out::YMap(m)) => m,
            _ => panic!("actor entry missing"),
        };
        let ids_len = match entry.get(&txn, "ids") {
            Some(Out::YArray(a)) => a.len(&txn),
            _ => panic!("ids missing"),
        };
        assert_eq!(ids_len, 1);
        // First registration timestamp wins.
        let meta = match entry.get(&txn, "meta") {
            Some(Out::YMap(m)) => m,
            _ => panic!("meta missing"),
        };
        match meta.get(&txn, &AI_ID.to_string()) {
            Some(Out::Any(Any::Map(record))) => {
                assert_eq!(record.get("registeredAt"), Some(&Any::Number(1000.0)));
            }
            other => panic!("expected meta record, got {:?}", other),
        }
    }

    #[test]
    fn deletions_propagate_to_live_doc() {
        let doc = doc_with_text("delete me please");
        apply_attributed_edit(&doc, AI_ID, ACTOR, 1000, |txn, text| {
            text.remove_range(txn, 0, 10);
            Ok(())
        })
        .unwrap();
        assert_eq!(contents(&doc), "please");
    }

    #[test]
    fn human_items_keep_their_original_client_id() {
        let doc = doc_with_text("human text ");
        let human_id = doc.client_id();

        apply_attributed_edit(&doc, AI_ID, ACTOR, 1000, |txn, text| {
            let len = text.get_string(txn).len() as u32;
            text.insert(txn, len, "ai text");
            Ok(())
        })
        .unwrap();

        let txn = doc.transact();
        let sv = txn.state_vector();
        assert!(sv.get(&human_id) > 0);
        assert!(sv.get(&AI_ID) > 0);
        assert_eq!(contents(&doc), "human text ai text");
    }

    // --- visible_runs ---

    fn runs_of(doc: &Doc) -> Option<Vec<Run>> {
        let mut txn = doc.transact_mut();
        let text = txn.get_or_insert_text("contents");
        visible_runs(&mut txn, &text)
    }

    #[test]
    fn runs_single_client() {
        let doc = doc_with_text("hello");
        let runs = runs_of(&doc).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!((runs[0].from, runs[0].to), (0, 5));
        assert_eq!(runs[0].client, doc.client_id());
        assert_eq!(runs[0].clock, 0);
    }

    #[test]
    fn runs_mixed_clients_after_attributed_edit() {
        let doc = doc_with_text("human text");
        let human = doc.client_id();
        apply_attributed_edit(&doc, AI_ID, ACTOR, 1000, |txn, text| {
            text.insert(txn, 5, " AI");
            Ok(())
        })
        .unwrap();
        assert_eq!(contents(&doc), "human AI text");
        let runs = runs_of(&doc).unwrap();
        let summary: Vec<(usize, usize, u64)> =
            runs.iter().map(|r| (r.from, r.to, r.client)).collect();
        assert_eq!(summary, vec![(0, 5, human), (5, 8, AI_ID), (8, 13, human)]);
        assert_eq!(clients_in_range(&runs, 6, 7), vec![AI_ID]);
        assert_eq!(clients_in_range(&runs, 4, 6), {
            let mut v = vec![human, AI_ID];
            v.sort_unstable();
            v
        });
        assert!(clients_in_range(&runs, 5, 5).is_empty());
    }

    #[test]
    fn runs_skip_deleted_and_use_byte_offsets() {
        let doc = doc_with_text("héllo wörld");
        {
            let mut txn = doc.transact_mut();
            let text = txn.get_or_insert_text("contents");
            // delete "llo " (bytes 3..7)
            text.remove_range(&mut txn, 3, 4);
        }
        assert_eq!(contents(&doc), "héwörld");
        let runs = runs_of(&doc).unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!((runs[0].from, runs[0].to), (0, 3));
        assert_eq!((runs[1].from, runs[1].to), (3, "héwörld".len()));
        // second run starts after "héllo " = 6 UTF-16 units
        assert_eq!(runs[1].clock, 6);
    }

    #[test]
    fn runs_survive_singleton_client_without_panicking() {
        // A client whose only block is one 1-length item: the shape that
        // makes `find_pivot` divide by zero in yrs 0.19.
        let doc = doc_with_text("ab");
        let single = Doc::with_options(Options {
            client_id: 12,
            ..Options::default()
        });
        {
            let update = doc
                .transact()
                .encode_state_as_update_v1(&StateVector::default());
            let mut txn = single.transact_mut();
            txn.apply_update(Update::decode_v1(&update).unwrap());
            let text = txn.get_or_insert_text("contents");
            text.insert(&mut txn, 1, "X");
        }
        {
            let delta = single
                .transact()
                .encode_state_as_update_v1(&doc.transact().state_vector());
            let mut txn = doc.transact_mut();
            txn.apply_update(Update::decode_v1(&delta).unwrap());
        }
        assert_eq!(contents(&doc), "aXb");
        let runs = runs_of(&doc).unwrap();
        let summary: Vec<(usize, usize, u64)> =
            runs.iter().map(|r| (r.from, r.to, r.client)).collect();
        assert_eq!(
            summary,
            vec![(0, 1, doc.client_id()), (1, 2, 12), (2, 3, doc.client_id())]
        );
    }

    #[test]
    fn runs_survive_two_one_length_blocks() {
        // Two unmerged 1-length blocks for one client: the shape that makes
        // `find_pivot` index out of bounds when looking up clock == state.
        let doc = doc_with_text("ab");
        {
            let mut txn = doc.transact_mut();
            let text = txn.get_or_insert_text("contents");
            text.insert(&mut txn, 1, "X");
        }
        assert_eq!(contents(&doc), "aXb");
        let runs = runs_of(&doc).unwrap();
        assert_eq!(runs.iter().map(|r| r.to - r.from).sum::<usize>(), 3);
        assert_eq!(runs.len(), 3);
    }

    #[test]
    fn runs_on_doc_restored_from_persisted_update() {
        let doc = doc_with_text("persisted text");
        apply_attributed_edit(&doc, AI_ID, ACTOR, 1000, |txn, text| {
            text.insert(txn, 9, " AI");
            Ok(())
        })
        .unwrap();
        let bytes = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let restored = Doc::new();
        {
            let mut txn = restored.transact_mut();
            txn.apply_update(Update::decode_v1(&bytes).unwrap());
        }
        let runs = runs_of(&restored).unwrap();
        assert_eq!(
            runs.iter().map(|r| r.to - r.from).sum::<usize>(),
            "persisted AI text".len()
        );
        assert!(runs
            .iter()
            .any(|r| r.client == AI_ID && r.from == 9 && r.to == 12));
    }

    #[test]
    fn sticky_anchor_resolves_and_falls_back_at_end() {
        let doc = doc_with_text("héllo");
        let mut txn = doc.transact_mut();
        let text = txn.get_or_insert_text("contents");
        let mid = sticky_anchor(&txn, &text, 3).expect("anchor inside text");
        let end = sticky_anchor(&txn, &text, 6).expect("anchor at end falls back to Before");
        assert_ne!(mid, end);
        // Round-trip through yrs: decodes to the same byte offset.
        let decoded = StickyIndex::decode_v1(&mid).unwrap();
        assert_eq!(decoded.get_offset(&txn).map(|o| o.index), Some(3));
        // The end anchor (Assoc::Before on the last char) is decodable; its
        // in-editor resolution is covered by the frontend tests.
        assert!(StickyIndex::decode_v1(&end).is_ok());
    }

    #[test]
    fn runs_copy_matches_live_runs_and_anchor_resolves() {
        let doc = doc_with_text("human ");
        apply_attributed_edit(&doc, AI_ID, ACTOR, 1000, |txn, text| {
            text.insert(txn, 6, "ai");
            Ok(())
        })
        .unwrap();
        let (anchor, live) = {
            let mut txn = doc.transact_mut();
            let text = txn.get_or_insert_text("contents");
            let anchor = sticky_anchor(&txn, &text, 6).unwrap();
            (anchor, visible_runs(&mut txn, &text).unwrap())
        };
        let txn = doc.transact();
        assert_eq!(visible_runs_copy(&txn).unwrap(), live);
        assert_eq!(resolve_anchor(&txn, &anchor), Some(6));
        assert_eq!(resolve_anchor(&txn, b"junk"), None);
    }

    #[test]
    fn client_actor_map_reads_users() {
        let doc = doc_with_text("x");
        apply_attributed_edit(&doc, AI_ID, ACTOR, 1000, |txn, text| {
            text.insert(txn, 0, "y");
            Ok(())
        })
        .unwrap();
        let txn = doc.transact();
        let map = client_actor_map(&txn);
        assert_eq!(map.get(&AI_ID).map(String::as_str), Some(ACTOR));
        assert!(!map.contains_key(&doc.client_id()));
    }
}
