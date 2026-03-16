use crate::server::Server;
use serde_json::Value;
use std::sync::Arc;

/// Execute the `move` tool: move a document to a new path within or across folders.
pub async fn execute(server: &Arc<Server>, arguments: &Value) -> Result<String, String> {
    let file_path = arguments
        .get("file_path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter: file_path".to_string())?;

    let new_path = arguments
        .get("new_path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter: new_path".to_string())?;

    let target_folder = arguments.get("target_folder").and_then(|v| v.as_str());

    // Resolve file_path to a UUID via doc_resolver
    let doc_info = server
        .doc_resolver()
        .resolve_path(file_path)
        .ok_or_else(|| format!("Document not found: {}", file_path))?;

    let result = server
        .move_document(&doc_info.uuid, new_path, target_folder)
        .await
        .map_err(|e| e.to_string())?;

    Ok(format!(
        "Moved {}{} -> {}{} ({} links rewritten)",
        result.old_folder_name,
        result.old_path,
        result.new_folder_name,
        result.new_path,
        result.links_rewritten,
    ))
}
