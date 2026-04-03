use crate::server::Server;
use serde_json::Value;
use std::sync::Arc;

/// Execute the `search` tool: full-text ranked search via Tantivy index.
pub async fn execute(server: &Arc<Server>, arguments: &Value) -> Result<String, String> {
    let query = arguments
        .get("query")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter: query".to_string())?;

    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok("No results found.".to_string());
    }

    let limit = arguments
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|v| (v as usize).min(100))
        .unwrap_or(20);

    // Check search index availability
    let search_index = server
        .search_index()
        .clone()
        .ok_or_else(|| "Search index is not enabled on this server.".to_string())?;

    if !server.search_is_ready() {
        return Err("Search index is being built, please try again shortly.".to_string());
    }

    // Run search in blocking context (tantivy is sync)
    let results = tokio::task::spawn_blocking(move || search_index.search(&query, limit))
        .await
        .map_err(|e| format!("Search task failed: {}", e))?
        .map_err(|e| format!("Search error: {}", e))?;

    if results.is_empty() {
        return Ok("No results found.".to_string());
    }

    let total = results.len();
    let mut output = Vec::with_capacity(total + 1);
    output.push(format!("{} result{}:", total, if total == 1 { "" } else { "s" }));

    for r in &results {
        output.push(String::new());
        output.push(format!("## {} ({})", r.title, r.folder));
        if !r.snippet.is_empty() {
            output.push(r.snippet.clone());
        }
    }

    Ok(output.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn search_no_index_returns_error() {
        // Server::new_for_test() has search_index: None
        let server = Server::new_for_test();

        let result = execute(
            &server,
            &json!({"query": "photosynthesis"}),
        )
        .await;

        assert!(result.is_err());
        assert!(
            result.unwrap_err().contains("not enabled"),
            "Should indicate search is not enabled"
        );
    }

    #[tokio::test]
    async fn search_empty_query_returns_no_results() {
        let server = Server::new_for_test();

        let result = execute(
            &server,
            &json!({"query": "  "}),
        )
        .await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "No results found.");
    }

    #[tokio::test]
    async fn search_with_index() {
        let tmp = tempfile::tempdir().unwrap();
        let search_index = Arc::new(
            y_sweet_core::search_index::SearchIndex::new(tmp.path()).unwrap(),
        );

        // Index a test document
        search_index
            .add_document("doc-1", "Photosynthesis", "Plants convert sunlight into energy.", "Lens")
            .unwrap();

        let server = Server::new_for_test_with_search(search_index.clone());

        let result = execute(
            &server,
            &json!({"query": "photosynthesis"}),
        )
        .await
        .unwrap();

        assert!(result.contains("1 result"), "Expected 1 result, got: {}", result);
        assert!(result.contains("Photosynthesis"), "Expected title in output, got: {}", result);
        assert!(result.contains("Lens"), "Expected folder in output, got: {}", result);
    }

    #[tokio::test]
    async fn search_respects_limit() {
        let tmp = tempfile::tempdir().unwrap();
        let search_index = Arc::new(
            y_sweet_core::search_index::SearchIndex::new(tmp.path()).unwrap(),
        );

        // Index multiple documents with the same keyword
        for i in 0..5 {
            search_index
                .add_document(
                    &format!("doc-{}", i),
                    &format!("Doc {}", i),
                    "biology plants photosynthesis",
                    "Lens",
                )
                .unwrap();
        }

        let server = Server::new_for_test_with_search(search_index.clone());

        let result = execute(
            &server,
            &json!({"query": "biology", "limit": 2}),
        )
        .await
        .unwrap();

        assert!(result.starts_with("2 result"), "Expected 2 results, got: {}", result);
    }
}
