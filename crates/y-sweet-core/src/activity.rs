//! Per-document activity log for direct AI edits (`activity_v0`).
//!
//! Each direct (non-suggestion) MCP edit records one event in a top-level
//! `Y.Map("activity_v0")` inside the content doc, written in the same
//! transaction as the text change so edit and audit record persist together.
//! Events are pruned after [`RETENTION_MS`] (seven days); the map never grows
//! beyond one week of AI activity. The server derives an in-memory
//! [`crate::recent_changes_index::RecentChangesIndex`] from these maps at
//! startup and on debounced updates, and the editor reads the map directly
//! for the in-file "recent changes" overlay.
//!
//! See docs/plans/2026-08-27-direct-mcp-edits-plan.md §3.2.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use yrs::{Any, Map, MapRef, ReadTxn, TransactionMut, WriteTxn};

pub const ACTIVITY_MAP: &str = "activity_v0";
/// Rolling retention window for events: seven days.
pub const RETENTION_MS: u64 = 7 * 24 * 60 * 60 * 1000;
/// Cap on stored old/new text per event (bytes, cut at a char boundary).
pub const TEXT_CAP: usize = 4096;
const SCHEMA_VERSION: f64 = 1.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActivityEvent {
    /// Map key; unique per event (`{ts}-{client}-{clock_from}`).
    pub id: String,
    /// Epoch milliseconds.
    pub ts: u64,
    /// Provenance actor key, e.g. `ai:opus-5:luc`.
    pub actor: String,
    /// Display label, e.g. `Luc's AI` (same as CriticMarkup author).
    pub author: String,
    /// `direct` for now; reserved for `suggestion` later.
    pub mode: String,
    /// `insert` | `delete` | `replace`.
    pub kind: String,
    pub old: String,
    pub new: String,
    pub old_truncated: bool,
    pub new_truncated: bool,
    pub ctx_before: String,
    pub ctx_after: String,
    /// Accepted-view UTF-8 byte offset of the change at event time.
    pub pos: usize,
    /// Yjs client ID under which the inserted items were minted.
    pub client: u64,
    /// Half-open clock range `[clock_from, clock_to)` of the minted text items
    /// (UTF-16 units, like every Yjs clock).
    pub clock_from: u32,
    pub clock_to: u32,
    /// Encoded `Y.RelativePosition` (v1) at the start of the changed region,
    /// base64 in JSON, raw bytes in the Y.Map. `None` when no anchor could be
    /// taken.
    #[serde(default, with = "opt_base64")]
    pub anchor: Option<Vec<u8>>,
}

mod opt_base64 {
    use base64::Engine;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &Option<Vec<u8>>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(bytes) => {
                s.serialize_some(&base64::engine::general_purpose::STANDARD.encode(bytes))
            }
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<u8>>, D::Error> {
        let s: Option<String> = Option::deserialize(d)?;
        match s {
            Some(s) => base64::engine::general_purpose::STANDARD
                .decode(s)
                .map(Some)
                .map_err(serde::de::Error::custom),
            None => Ok(None),
        }
    }
}

impl ActivityEvent {
    pub fn event_id(ts: u64, client: u64, clock_from: u32) -> String {
        format!("{}-{}-{}", ts, client, clock_from)
    }

    pub fn kind_for(old: &str, new: &str) -> &'static str {
        match (old.is_empty(), new.is_empty()) {
            (true, _) => "insert",
            (false, true) => "delete",
            (false, false) => "replace",
        }
    }

    fn to_any(&self) -> Any {
        let mut m: HashMap<String, Any> = HashMap::new();
        m.insert("v".into(), Any::Number(SCHEMA_VERSION));
        m.insert("ts".into(), Any::Number(self.ts as f64));
        m.insert("actor".into(), Any::String(self.actor.as_str().into()));
        m.insert("author".into(), Any::String(self.author.as_str().into()));
        m.insert("mode".into(), Any::String(self.mode.as_str().into()));
        m.insert("kind".into(), Any::String(self.kind.as_str().into()));
        m.insert("old".into(), Any::String(self.old.as_str().into()));
        m.insert("new".into(), Any::String(self.new.as_str().into()));
        m.insert("old_truncated".into(), Any::Bool(self.old_truncated));
        m.insert("new_truncated".into(), Any::Bool(self.new_truncated));
        m.insert(
            "ctx_before".into(),
            Any::String(self.ctx_before.as_str().into()),
        );
        m.insert(
            "ctx_after".into(),
            Any::String(self.ctx_after.as_str().into()),
        );
        m.insert("pos".into(), Any::Number(self.pos as f64));
        m.insert("client".into(), Any::Number(self.client as f64));
        m.insert("clock_from".into(), Any::Number(self.clock_from as f64));
        m.insert("clock_to".into(), Any::Number(self.clock_to as f64));
        if let Some(anchor) = &self.anchor {
            m.insert("anchor".into(), Any::Buffer(anchor.as_slice().into()));
        }
        Any::Map(Arc::new(m))
    }

    fn from_any(id: &str, value: &Any) -> Option<Self> {
        let Any::Map(m) = value else { return None };
        let s = |k: &str| -> Option<String> {
            match m.get(k) {
                Some(Any::String(v)) => Some(v.to_string()),
                _ => None,
            }
        };
        let n = |k: &str| -> Option<f64> {
            match m.get(k) {
                Some(Any::Number(v)) => Some(*v),
                Some(Any::BigInt(v)) => Some(*v as f64),
                _ => None,
            }
        };
        let b = |k: &str| -> bool { matches!(m.get(k), Some(Any::Bool(true))) };
        Some(ActivityEvent {
            id: id.to_string(),
            ts: n("ts")? as u64,
            actor: s("actor")?,
            author: s("author").unwrap_or_default(),
            mode: s("mode").unwrap_or_else(|| "direct".into()),
            kind: s("kind")?,
            old: s("old").unwrap_or_default(),
            new: s("new").unwrap_or_default(),
            old_truncated: b("old_truncated"),
            new_truncated: b("new_truncated"),
            ctx_before: s("ctx_before").unwrap_or_default(),
            ctx_after: s("ctx_after").unwrap_or_default(),
            pos: n("pos").unwrap_or(0.0) as usize,
            client: n("client")? as u64,
            clock_from: n("clock_from")? as u32,
            clock_to: n("clock_to")? as u32,
            anchor: match m.get("anchor") {
                Some(Any::Buffer(bytes)) => Some(bytes.to_vec()),
                _ => None,
            },
        })
    }
}

/// One piece of an [`Excerpt`]: unchanged text, text inserted by an event
/// (still surviving in the doc), or text an event removed (shown in place).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExcerptSegment {
    /// `text` | `insert` | `delete`
    pub kind: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
}

/// A window of the current accepted-view text around one cluster of
/// nearby changes, for the recent-changes page. Long unchanged stretches
/// between excerpts are skipped (`skipped_before`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Excerpt {
    /// Accepted-view UTF-8 byte offset where the excerpt starts (for `?pos=`).
    pub pos: usize,
    /// 1-based line number of `pos`.
    pub line: usize,
    /// Characters of unchanged text skipped between the previous excerpt
    /// (or the document start) and this one.
    pub skipped_before: usize,
    /// Characters of unchanged text after this excerpt to the end of the
    /// document (only meaningful on the last excerpt).
    pub skipped_after: usize,
    pub segments: Vec<ExcerptSegment>,
}

/// Truncate `text` to at most [`TEXT_CAP`] bytes on a char boundary.
/// Returns `(text, truncated)`.
pub fn cap_text(text: &str) -> (String, bool) {
    if text.len() <= TEXT_CAP {
        return (text.to_string(), false);
    }
    let mut end = TEXT_CAP;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), true)
}

/// Read all well-formed events from the doc's `activity_v0` map, sorted by
/// timestamp then id. Malformed entries are skipped.
pub fn read_events<T: ReadTxn>(txn: &T) -> Vec<ActivityEvent> {
    let Some(map) = txn.get_map(ACTIVITY_MAP) else {
        return Vec::new();
    };
    let mut events: Vec<ActivityEvent> = map
        .iter(txn)
        .filter_map(|(key, value)| match value {
            yrs::Out::Any(any) => ActivityEvent::from_any(key, &any),
            _ => None,
        })
        .collect();
    events.sort_by(|a, b| a.ts.cmp(&b.ts).then_with(|| a.id.cmp(&b.id)));
    events
}

/// Events with `ts >= since_ms`, sorted.
pub fn read_events_since<T: ReadTxn>(txn: &T, since_ms: u64) -> Vec<ActivityEvent> {
    let mut events = read_events(txn);
    events.retain(|e| e.ts >= since_ms);
    events
}

/// Remove events older than the retention window. Returns the number pruned.
/// Only creates the map if it already exists (never adds a map to a doc that
/// has no activity).
pub fn prune_expired(txn: &mut TransactionMut, now_ms: u64) -> usize {
    let Some(map) = txn.get_map(ACTIVITY_MAP) else {
        return 0;
    };
    prune_map(txn, &map, now_ms)
}

fn prune_map(txn: &mut TransactionMut, map: &MapRef, now_ms: u64) -> usize {
    let cutoff = now_ms.saturating_sub(RETENTION_MS);
    let expired: Vec<String> = map
        .iter(txn)
        .filter_map(|(key, value)| {
            let ts = match value {
                yrs::Out::Any(Any::Map(m)) => match m.get("ts") {
                    Some(Any::Number(ts)) => *ts as u64,
                    Some(Any::BigInt(ts)) => *ts as u64,
                    _ => 0,
                },
                _ => 0, // malformed → prune
            };
            if ts < cutoff {
                Some(key.to_string())
            } else {
                None
            }
        })
        .collect();
    for key in &expired {
        map.remove(txn, key);
    }
    expired.len()
}

/// Append an event to the doc's `activity_v0` map, pruning expired events in
/// the same transaction. Must be called inside the transaction that carries
/// the corresponding text change.
pub fn append_event(txn: &mut TransactionMut, event: &ActivityEvent, now_ms: u64) {
    let map: MapRef = txn.get_or_insert_map(ACTIVITY_MAP);
    prune_map(txn, &map, now_ms);
    map.insert(txn, event.id.clone(), event.to_any());
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{Doc, Transact};

    fn sample(ts: u64, clock_from: u32) -> ActivityEvent {
        ActivityEvent {
            id: ActivityEvent::event_id(ts, 42, clock_from),
            ts,
            actor: "ai:fable-5:luc".into(),
            author: "Luc's AI".into(),
            mode: "direct".into(),
            kind: "replace".into(),
            old: "old".into(),
            new: "new".into(),
            old_truncated: false,
            new_truncated: false,
            ctx_before: "before ".into(),
            ctx_after: " after".into(),
            pos: 7,
            client: 42,
            clock_from,
            clock_to: clock_from + 3,
            anchor: Some(vec![0, 42, 5, 0]),
        }
    }

    #[test]
    fn round_trips_through_ymap() {
        let doc = Doc::new();
        let ev = sample(1_000_000, 10);
        {
            let mut txn = doc.transact_mut();
            append_event(&mut txn, &ev, 1_000_000);
        }
        let txn = doc.transact();
        let read = read_events(&txn);
        assert_eq!(read, vec![ev]);
    }

    #[test]
    fn append_prunes_expired_events() {
        let doc = Doc::new();
        let old = sample(1_000, 0);
        let recent = sample(RETENTION_MS + 5_000, 10);
        {
            let mut txn = doc.transact_mut();
            append_event(&mut txn, &old, 1_000);
        }
        {
            let mut txn = doc.transact_mut();
            append_event(&mut txn, &recent, RETENTION_MS + 5_000);
        }
        let txn = doc.transact();
        let ids: Vec<String> = read_events(&txn).into_iter().map(|e| e.id).collect();
        assert_eq!(ids, vec![recent.id.clone()]);
    }

    #[test]
    fn prune_without_map_is_noop() {
        let doc = Doc::new();
        let mut txn = doc.transact_mut();
        assert_eq!(prune_expired(&mut txn, u64::MAX / 2), 0);
        assert!(txn.get_map(ACTIVITY_MAP).is_none());
    }

    #[test]
    fn events_are_sorted_and_malformed_skipped() {
        let doc = Doc::new();
        {
            let mut txn = doc.transact_mut();
            append_event(&mut txn, &sample(3_000, 0), 3_000);
            append_event(&mut txn, &sample(2_000, 0), 3_000);
            let map = txn.get_or_insert_map(ACTIVITY_MAP);
            map.insert(&mut txn, "junk", Any::String("nope".into()));
        }
        let txn = doc.transact();
        let ts: Vec<u64> = read_events(&txn).into_iter().map(|e| e.ts).collect();
        assert_eq!(ts, vec![2_000, 3_000]);
        assert_eq!(read_events_since(&txn, 2_500).len(), 1);
    }

    #[test]
    fn cap_text_respects_char_boundaries() {
        let s = "é".repeat(TEXT_CAP); // 2 bytes each
        let (capped, truncated) = cap_text(&s);
        assert!(truncated);
        assert!(capped.len() <= TEXT_CAP);
        assert!(capped.chars().all(|c| c == 'é'));
        assert_eq!(cap_text("short"), ("short".to_string(), false));
    }

    #[test]
    fn json_encodes_anchor_as_base64() {
        let ev = sample(1, 0);
        let json = serde_json::to_value(&ev).unwrap();
        assert_eq!(json["anchor"], serde_json::json!("ACoFAA=="));
        let back: ActivityEvent = serde_json::from_value(json).unwrap();
        assert_eq!(back, ev);
    }
}
