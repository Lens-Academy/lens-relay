//! In-memory index of CriticMarkup suggestions per document.
//!
//! Populated at startup (all docs are loaded then anyway) and kept current by
//! the search worker on debounced content updates. Lets `GET /suggestions`
//! answer from memory instead of loading every doc in a folder from storage.
//! See docs/plans/2026-07-02-suggestions-index.md.

use crate::critic_scanner::Suggestion;
use dashmap::DashMap;

#[derive(Default)]
pub struct SuggestionsIndex {
    // Only docs with non-empty suggestions are stored. Deleted docs are not
    // removed here; queries filter by the folder's current filemeta, and the
    // index is rebuilt from scratch on restart.
    by_uuid: DashMap<String, Vec<Suggestion>>,
}

impl SuggestionsIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replace the suggestions for a document. An empty vec removes the entry.
    pub fn update(&self, doc_uuid: &str, suggestions: Vec<Suggestion>) {
        if suggestions.is_empty() {
            self.by_uuid.remove(doc_uuid);
        } else {
            self.by_uuid.insert(doc_uuid.to_string(), suggestions);
        }
    }

    pub fn get(&self, doc_uuid: &str) -> Option<Vec<Suggestion>> {
        self.by_uuid.get(doc_uuid).map(|r| r.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::critic_scanner::scan_suggestions;

    #[test]
    fn update_stores_and_get_returns_suggestions() {
        // Prevents: index lookups returning nothing for docs that have
        // suggestions (review page would silently show an empty list)
        let index = SuggestionsIndex::new();
        let suggestions = scan_suggestions("Hello {++world++} end");
        assert!(!suggestions.is_empty());
        index.update("uuid-1", suggestions.clone());
        assert_eq!(index.get("uuid-1"), Some(suggestions));
    }

    #[test]
    fn update_with_empty_vec_removes_entry() {
        // Prevents: resolved suggestions lingering in the index forever and
        // reappearing on the review page after being accepted/rejected
        let index = SuggestionsIndex::new();
        index.update("uuid-1", scan_suggestions("Hi {++there++}"));
        index.update("uuid-1", Vec::new());
        assert_eq!(index.get("uuid-1"), None);
    }

    #[test]
    fn get_unknown_uuid_returns_none() {
        // Prevents: fabricating entries for docs that were never scanned
        let index = SuggestionsIndex::new();
        assert_eq!(index.get("nope"), None);
    }
}
