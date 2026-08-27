//! In-memory index of recent direct-edit activity per document.
//!
//! Mirrors [`crate::suggestions_index::SuggestionsIndex`]: populated at
//! startup from each content doc's `activity_v0` map (all docs are loaded
//! then anyway), refreshed by the search worker on debounced updates, and
//! written through by the MCP edit path under the doc's awareness write
//! lock. `GET /recent-changes` answers from here without loading content
//! docs. Deleted docs are not removed; queries filter through the folder's
//! current `filemeta_v0`, and the index is rebuilt from scratch on restart.
//! See docs/plans/2026-08-27-direct-mcp-edits-plan.md §3.3.

use crate::activity::{ActivityEvent, Excerpt, MAX_EVENTS_PER_DOC, RETENTION_MS};
use dashmap::DashMap;

#[derive(Default, Clone)]
struct Entry {
    events: Vec<ActivityEvent>,
    excerpts: Vec<Excerpt>,
}

#[derive(Default)]
pub struct RecentChangesIndex {
    by_uuid: DashMap<String, Entry>,
}

impl RecentChangesIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replace the events (and their excerpts) for a document. An empty
    /// event vec removes the entry. Events are capped at
    /// [`MAX_EVENTS_PER_DOC`] (newest kept).
    pub fn update(&self, doc_uuid: &str, mut events: Vec<ActivityEvent>, excerpts: Vec<Excerpt>) {
        if events.is_empty() {
            self.by_uuid.remove(doc_uuid);
        } else {
            events.sort_by_key(|e| e.ts);
            cap_events(&mut events);
            self.by_uuid
                .insert(doc_uuid.to_string(), Entry { events, excerpts });
        }
    }

    /// Append one event (write-through from the edit path). Keeps the vec
    /// sorted by timestamp, drops anything past retention or beyond the
    /// per-doc cap. `excerpts` replaces the stored excerpts when given;
    /// otherwise the previous excerpts stay until [`Self::set_excerpts`].
    pub fn push(&self, doc_uuid: &str, event: ActivityEvent, excerpts: Option<Vec<Excerpt>>) {
        let cutoff = event.ts.saturating_sub(RETENTION_MS);
        let mut entry = self.by_uuid.entry(doc_uuid.to_string()).or_default();
        entry.events.retain(|e| e.ts >= cutoff && e.id != event.id);
        let idx = entry.events.partition_point(|e| e.ts <= event.ts);
        entry.events.insert(idx, event);
        cap_events(&mut entry.events);
        if let Some(excerpts) = excerpts {
            entry.excerpts = excerpts;
        }
    }

    /// Replace only the excerpts of an existing entry (no-op for unknown
    /// docs, so a late excerpt build can't resurrect a removed entry).
    pub fn set_excerpts(&self, doc_uuid: &str, excerpts: Vec<Excerpt>) {
        if let Some(mut entry) = self.by_uuid.get_mut(doc_uuid) {
            entry.excerpts = excerpts;
        }
    }

    /// Drop events older than the retention window as of `now_ms` from one
    /// entry (used when a doc is evicted from memory: the entry must keep
    /// answering, but not with expired events). Removes the entry when
    /// nothing is left.
    pub fn prune(&self, doc_uuid: &str, now_ms: u64) {
        let cutoff = now_ms.saturating_sub(RETENTION_MS);
        let remove = match self.by_uuid.get_mut(doc_uuid) {
            Some(mut entry) => {
                entry.events.retain(|e| e.ts >= cutoff);
                entry.events.is_empty()
            }
            None => false,
        };
        if remove {
            self.by_uuid.remove(doc_uuid);
        }
    }

    /// Retention sweep over every entry. Returns the number of entries
    /// removed. Cheap (one pass over the map); run periodically.
    pub fn sweep(&self, now_ms: u64) -> usize {
        let cutoff = now_ms.saturating_sub(RETENTION_MS);
        let before = self.by_uuid.len();
        self.by_uuid.retain(|_, entry| {
            entry.events.retain(|e| e.ts >= cutoff);
            !entry.events.is_empty()
        });
        before - self.by_uuid.len()
    }

    pub fn get(&self, doc_uuid: &str) -> Option<Vec<ActivityEvent>> {
        self.by_uuid.get(doc_uuid).map(|r| r.events.clone())
    }

    pub fn excerpts(&self, doc_uuid: &str) -> Option<Vec<Excerpt>> {
        self.by_uuid.get(doc_uuid).map(|r| r.excerpts.clone())
    }

    /// Events for a document with `ts >= since_ms`.
    pub fn get_since(&self, doc_uuid: &str, since_ms: u64) -> Option<Vec<ActivityEvent>> {
        let events: Vec<ActivityEvent> = self
            .by_uuid
            .get(doc_uuid)?
            .events
            .iter()
            .filter(|e| e.ts >= since_ms)
            .cloned()
            .collect();
        if events.is_empty() {
            None
        } else {
            Some(events)
        }
    }

    pub fn len(&self) -> usize {
        self.by_uuid.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_uuid.is_empty()
    }
}

fn cap_events(events: &mut Vec<ActivityEvent>) {
    if events.len() > MAX_EVENTS_PER_DOC {
        let excess = events.len() - MAX_EVENTS_PER_DOC;
        events.drain(..excess);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(ts: u64) -> ActivityEvent {
        ActivityEvent {
            id: ActivityEvent::event_id(ts, 1, 0),
            ts,
            actor: "ai:x".into(),
            author: "AI".into(),
            mode: "direct".into(),
            kind: "insert".into(),
            old: String::new(),
            new: "x".into(),
            old_truncated: false,
            new_truncated: false,
            ctx_before: String::new(),
            ctx_after: String::new(),
            pos: 0,
            client: 1,
            clock_from: 0,
            clock_to: 1,
            anchor: None,
        }
    }

    #[test]
    fn push_keeps_order_and_filters_since() {
        let idx = RecentChangesIndex::new();
        idx.push("d", ev(30), None);
        idx.push("d", ev(10), None);
        idx.push("d", ev(20), None);
        let ts: Vec<u64> = idx.get("d").unwrap().into_iter().map(|e| e.ts).collect();
        assert_eq!(ts, vec![10, 20, 30]);
        assert_eq!(idx.get_since("d", 20).unwrap().len(), 2);
        assert!(idx.get_since("d", 31).is_none());
        assert!(idx.get("missing").is_none());
    }

    #[test]
    fn update_with_empty_removes() {
        let idx = RecentChangesIndex::new();
        idx.update("d", vec![ev(1)], vec![]);
        assert_eq!(idx.len(), 1);
        idx.update("d", vec![], vec![]);
        assert!(idx.is_empty());
    }

    #[test]
    fn set_excerpts_prune_and_sweep() {
        let idx = RecentChangesIndex::new();
        idx.set_excerpts("missing", vec![]);
        assert!(idx.is_empty());
        idx.push("d", ev(10), None);
        idx.push("d", ev(RETENTION_MS + 100), None);
        idx.push("e", ev(5), None);
        idx.prune("d", RETENTION_MS + 200);
        assert_eq!(idx.get("d").unwrap().len(), 1);
        assert_eq!(idx.sweep(RETENTION_MS + 200), 1);
        assert!(idx.get("e").is_none());
        assert_eq!(idx.len(), 1);
    }

    #[test]
    fn caps_events_per_doc() {
        let idx = RecentChangesIndex::new();
        let events: Vec<ActivityEvent> = (0..MAX_EVENTS_PER_DOC as u64 + 20)
            .map(|i| ev(i * 1000))
            .collect();
        idx.update("d", events, vec![]);
        let got = idx.get("d").unwrap();
        assert_eq!(got.len(), MAX_EVENTS_PER_DOC);
        assert_eq!(got[0].ts, 20 * 1000);
        idx.push("d", ev(600 * 1000), None);
        assert_eq!(idx.get("d").unwrap().len(), MAX_EVENTS_PER_DOC);
    }

    #[test]
    fn push_drops_expired() {
        let idx = RecentChangesIndex::new();
        idx.push("d", ev(1), None);
        idx.push("d", ev(RETENTION_MS + 10), None);
        assert_eq!(idx.get("d").unwrap().len(), 1);
    }
}
