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

use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{
    Any, Array, ArrayPrelim, ArrayRef, Doc, GetString, Map, MapPrelim, MapRef, Options, Out,
    ReadTxn, StateVector, Text, TextRef, Transact, TransactionMut, Update, WriteTxn,
};

/// AI identity to attribute server-side writes to, carried from the MCP
/// session into `Server::create_document*`.
#[derive(Debug, Clone)]
pub struct AiAttribution {
    pub client_id: u64,
    pub actor: String,
}

/// Apply a text edit to `doc`'s "contents" Y.Text so the inserted items carry
/// `ai_client_id`, registering `actor` in the "users" map in the same update.
///
/// The caller must hold whatever lock guards `doc` against concurrent writers
/// for the duration of this call (the MCP edit path holds the awareness write
/// guard), so the read-mutate-apply sequence is atomic with respect to other
/// server-side writers.
pub fn apply_attributed_edit<F>(
    doc: &Doc,
    ai_client_id: u64,
    actor: &str,
    now_ms: u64,
    mutate: F,
) -> Result<(), String>
where
    F: FnOnce(&mut TransactionMut, &TextRef),
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

    {
        let mut txn = scratch.transact_mut();
        let text = txn.get_or_insert_text("contents");
        mutate(&mut txn, &text);
        register_actor(&mut txn, actor, ai_client_id, now_ms);
    }

    // Delta relative to the live doc, applied back like a remote update.
    let delta = scratch.transact().encode_state_as_update_v1(&sv);
    {
        let mut txn = doc.transact_mut();
        let update = Update::decode_v1(&delta)
            .map_err(|e| format!("provenance: failed to decode delta: {}", e))?;
        txn.apply_update(update);
    }

    Ok(())
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
        })
        .unwrap();
        apply_attributed_edit(&doc, AI_ID, ACTOR, 2000, |txn, text| {
            text.insert(txn, 0, "y");
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
        })
        .unwrap();

        let txn = doc.transact();
        let sv = txn.state_vector();
        assert!(sv.get(&human_id) > 0);
        assert!(sv.get(&AI_ID) > 0);
        assert_eq!(contents(&doc), "human text ai text");
    }
}
