use crate::server::Server;
use serde_json::Value;
use std::sync::Arc;

use super::blob;

/// Execute the `create` tool: create a new document or file at the specified path.
pub async fn execute(server: &Arc<Server>, arguments: &Value) -> Result<String, String> {
    let file_path = arguments
        .get("file_path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter: file_path".to_string())?;

    let content = arguments
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    // Blob files (.json) — different storage path
    if blob::is_blob_file(file_path) {
        return create_blob_file(server, file_path, content).await;
    }

    // --- Markdown path (existing behavior) ---
    super::critic_markup::reject_if_contains_markup(content, "content")?;

    if !file_path.ends_with(".md") {
        return Err("file_path must end with '.md' or '.json'".to_string());
    }

    let md_content = if content.is_empty() { "_" } else { content };

    // Split at first '/' into folder name + in-folder path
    let slash_pos = file_path
        .find('/')
        .ok_or_else(|| "file_path must include a folder name (e.g. 'Lens/Doc.md')".to_string())?;

    let folder_name = &file_path[..slash_pos];
    let in_folder_path = format!("/{}", &file_path[slash_pos + 1..]);

    let _result = server
        .create_document(folder_name, &in_folder_path, md_content)
        .await
        .map_err(|e| e.to_string())?;

    Ok(format!("Created {}", file_path))
}

async fn create_blob_file(
    server: &Arc<Server>,
    file_path: &str,
    content: &str,
) -> Result<String, String> {
    let slash_pos = file_path
        .find('/')
        .ok_or_else(|| "file_path must include a folder name".to_string())?;
    let folder_name = &file_path[..slash_pos];
    let in_folder_path = format!("/{}", &file_path[slash_pos + 1..]);

    server
        .create_blob_file(folder_name, &in_folder_path, content.as_bytes())
        .await
        .map_err(|e| e.to_string())?;

    Ok(format!("Created {}", file_path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tools::blob;
    use crate::mcp::tools::test_helpers::*;
    use serde_json::json;

    #[tokio::test]
    async fn create_json_stores_blob() {
        let server = build_blob_test_server_with_folder().await;
        let result = execute(
            &server,
            &json!({
                "file_path": "Lens/data.json",
                "content": r#"{"hello": "world"}"#,
            }),
        )
        .await;
        assert!(result.is_ok(), "Create should succeed: {:?}", result.err());
        assert!(result.unwrap().contains("Created Lens/data.json"));
        // Verify hash exists in resolver
        let hash = server.doc_resolver().get_file_hash("Lens/data.json");
        assert!(hash.is_some(), "Should have hash in resolver");
    }

    #[tokio::test]
    async fn create_json_no_criticmarkup() {
        let server = build_blob_test_server_with_folder().await;
        execute(
            &server,
            &json!({
                "file_path": "Lens/test.json",
                "content": r#"{"key": "value"}"#,
            }),
        )
        .await
        .unwrap();
        let hash = server
            .doc_resolver()
            .get_file_hash("Lens/test.json")
            .unwrap();
        let doc_info = server
            .doc_resolver()
            .resolve_path("Lens/test.json")
            .unwrap();
        let data = blob::read_blob(&server, &doc_info.doc_id, &hash)
            .await
            .unwrap();
        let content = String::from_utf8(data).unwrap();
        assert_eq!(content, r#"{"key": "value"}"#);
        assert!(!content.contains("{++"), "Should not contain CriticMarkup");
    }

    #[tokio::test]
    async fn create_md_still_works() {
        let server = build_blob_test_server_with_folder().await;
        let result = execute(
            &server,
            &json!({
                "file_path": "Lens/Doc.md",
                "content": "Hello world",
            }),
        )
        .await;
        assert!(result.is_ok(), "MD create should succeed: {:?}", result.err());
    }
}
