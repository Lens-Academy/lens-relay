use anyhow::Result;
use serde::Serialize;
use std::path::Path;

/// A single search result with relevance score and snippet.
#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub doc_id: String,
    pub title: String,
    pub folder: String,
    pub snippet: String,
    pub score: f32,
}

/// Full-text search index backed by tantivy.
pub struct SearchIndex;

impl SearchIndex {
    /// Create a new SearchIndex with MmapDirectory at the given path.
    pub fn new(_path: &Path) -> Result<Self> {
        todo!("SearchIndex::new not implemented")
    }

    /// Create a new SearchIndex backed by RAM (for tests).
    pub fn new_in_memory() -> Result<Self> {
        todo!("SearchIndex::new_in_memory not implemented")
    }

    /// Add or update a document in the index.
    pub fn add_document(
        &self,
        _doc_id: &str,
        _title: &str,
        _body: &str,
        _folder: &str,
    ) -> Result<()> {
        todo!("add_document not implemented")
    }

    /// Remove a document from the index by doc_id.
    pub fn remove_document(&self, _doc_id: &str) -> Result<()> {
        todo!("remove_document not implemented")
    }

    /// Search the index and return ranked results with snippets.
    pub fn search(&self, _query: &str, _limit: usize) -> Result<Vec<SearchResult>> {
        todo!("search not implemented")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_index() -> SearchIndex {
        SearchIndex::new_in_memory().expect("failed to create in-memory index")
    }

    #[test]
    fn empty_index_returns_empty_results() {
        let index = create_index();
        let results = index.search("anything", 10).unwrap();
        assert!(results.is_empty(), "expected no results from empty index");
    }

    #[test]
    fn search_by_title_finds_document() {
        let index = create_index();
        index
            .add_document("doc1", "Quantum Physics", "Introduction to quantum mechanics.", "Lens")
            .unwrap();
        let results = index.search("Quantum", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].doc_id, "doc1");
        assert_eq!(results[0].title, "Quantum Physics");
        assert!(results[0].score > 0.0, "score should be positive");
    }

    #[test]
    fn search_by_body_finds_document() {
        let index = create_index();
        index
            .add_document("doc1", "Physics Notes", "The Schrodinger equation is fundamental.", "Lens")
            .unwrap();
        let results = index.search("Schrodinger", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].doc_id, "doc1");
    }

    #[test]
    fn title_match_scores_higher_than_body_only_match() {
        let index = create_index();
        // doc1 has "gravity" in body only
        index
            .add_document(
                "doc1",
                "Physics Notes",
                "Gravity is a fundamental force of nature.",
                "Lens",
            )
            .unwrap();
        // doc2 has "gravity" in title
        index
            .add_document("doc2", "Gravity Explained", "An overview of forces.", "Lens")
            .unwrap();
        let results = index.search("gravity", 10).unwrap();
        assert!(results.len() >= 2, "expected at least 2 results");
        // The title match (doc2) should score higher
        assert_eq!(
            results[0].doc_id, "doc2",
            "title match should rank first, got {:?}",
            results.iter().map(|r| (&r.doc_id, r.score)).collect::<Vec<_>>()
        );
        assert!(
            results[0].score > results[1].score,
            "title match score ({}) should be higher than body-only score ({})",
            results[0].score,
            results[1].score
        );
    }

    #[test]
    fn snippet_contains_mark_tags() {
        let index = create_index();
        index
            .add_document(
                "doc1",
                "Photosynthesis",
                "Plants convert sunlight into energy through photosynthesis.",
                "Lens",
            )
            .unwrap();
        let results = index.search("photosynthesis", 10).unwrap();
        assert!(!results.is_empty(), "expected results");
        let snippet = &results[0].snippet;
        assert!(
            snippet.contains("<mark>") && snippet.contains("</mark>"),
            "snippet should contain <mark> tags, got: {snippet}"
        );
    }

    #[test]
    fn snippet_does_not_contain_bold_tags() {
        let index = create_index();
        index
            .add_document(
                "doc1",
                "Photosynthesis",
                "Plants convert sunlight into energy through photosynthesis.",
                "Lens",
            )
            .unwrap();
        let results = index.search("photosynthesis", 10).unwrap();
        assert!(!results.is_empty(), "expected results");
        let snippet = &results[0].snippet;
        assert!(
            !snippet.contains("<b>") && !snippet.contains("</b>"),
            "snippet should NOT contain <b> tags, got: {snippet}"
        );
    }

    #[test]
    fn update_document_replaces_old_content() {
        let index = create_index();
        index
            .add_document("doc1", "Original Title", "Original body content.", "Lens")
            .unwrap();
        // Update with new content
        index
            .add_document("doc1", "Updated Title", "Completely different body text.", "Lens")
            .unwrap();
        // Old content should not be found
        let old_results = index.search("Original", 10).unwrap();
        assert!(
            old_results.is_empty(),
            "old content should not be findable after update"
        );
        // New content should be found
        let new_results = index.search("Updated", 10).unwrap();
        assert_eq!(new_results.len(), 1);
        assert_eq!(new_results[0].doc_id, "doc1");
        assert_eq!(new_results[0].title, "Updated Title");
    }

    #[test]
    fn remove_document_makes_it_unsearchable() {
        let index = create_index();
        index
            .add_document("doc1", "Temporary Doc", "This will be removed.", "Lens")
            .unwrap();
        // Verify it exists
        let results = index.search("Temporary", 10).unwrap();
        assert_eq!(results.len(), 1);
        // Remove it
        index.remove_document("doc1").unwrap();
        // Should no longer be found
        let results = index.search("Temporary", 10).unwrap();
        assert!(
            results.is_empty(),
            "removed document should not appear in results"
        );
    }

    #[test]
    fn empty_query_returns_empty_results() {
        let index = create_index();
        index
            .add_document("doc1", "Some Doc", "Some content.", "Lens")
            .unwrap();
        let results = index.search("", 10).unwrap();
        assert!(results.is_empty(), "empty query should return no results");
    }

    #[test]
    fn whitespace_query_returns_empty_results() {
        let index = create_index();
        index
            .add_document("doc1", "Some Doc", "Some content.", "Lens")
            .unwrap();
        let results = index.search("   \t\n  ", 10).unwrap();
        assert!(
            results.is_empty(),
            "whitespace-only query should return no results"
        );
    }

    #[test]
    fn search_respects_limit() {
        let index = create_index();
        index
            .add_document("doc1", "Alpha", "Common search term here.", "Lens")
            .unwrap();
        index
            .add_document("doc2", "Beta", "Common search term here too.", "Lens")
            .unwrap();
        index
            .add_document("doc3", "Gamma", "Common search term again.", "Lens")
            .unwrap();
        let results = index.search("common", 1).unwrap();
        assert_eq!(
            results.len(),
            1,
            "should return at most 1 result when limit=1"
        );
    }

    #[test]
    fn phrase_search_works() {
        let index = create_index();
        index
            .add_document(
                "doc1",
                "Notes",
                "The quick brown fox jumps over the lazy dog.",
                "Lens",
            )
            .unwrap();
        index
            .add_document("doc2", "Other Notes", "The quick red car drives fast.", "Lens")
            .unwrap();
        // Phrase search should only match doc1
        let results = index.search("\"quick brown fox\"", 10).unwrap();
        assert_eq!(results.len(), 1, "phrase search should match exactly one doc");
        assert_eq!(results[0].doc_id, "doc1");
    }

    #[test]
    fn and_semantics_by_default() {
        let index = create_index();
        index
            .add_document("doc1", "Notes", "The cat sat on the mat.", "Lens")
            .unwrap();
        index
            .add_document("doc2", "Other", "The dog ran in the park.", "Lens")
            .unwrap();
        index
            .add_document("doc3", "Both", "The cat ran across the yard.", "Lens")
            .unwrap();
        // "cat ran" with AND semantics should only match doc3
        let results = index.search("cat ran", 10).unwrap();
        assert_eq!(
            results.len(),
            1,
            "AND semantics: only docs with both terms should match, got {} results",
            results.len()
        );
        assert_eq!(results[0].doc_id, "doc3");
    }

    #[test]
    fn lenient_parsing_handles_malformed_query() {
        let index = create_index();
        index
            .add_document("doc1", "Test Doc", "Some content for testing.", "Lens")
            .unwrap();
        // Malformed query should not error
        let result = index.search("test AND", 10);
        assert!(
            result.is_ok(),
            "malformed query should not error: {:?}",
            result.err()
        );
    }

    #[test]
    fn folder_is_stored_in_results() {
        let index = create_index();
        index
            .add_document("doc1", "Test", "Content here.", "Lens Edu")
            .unwrap();
        let results = index.search("Content", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].folder, "Lens Edu");
    }
}
