use crate::server::Server;
use serde_json::Value;
use std::sync::Arc;

/// Execute the `create` tool: create a new document at the specified path.
pub async fn execute(server: &Arc<Server>, arguments: &Value) -> Result<String, String> {
    let file_path = arguments
        .get("file_path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter: file_path".to_string())?;

    let content = arguments
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("_");

    // Reject if AI included CriticMarkup in content
    super::critic_markup::reject_if_contains_markup(content, "content")?;

    // Validate: must end with .md
    if !file_path.ends_with(".md") {
        return Err("file_path must end with '.md'".to_string());
    }

    // Split at first '/' into folder name + in-folder path
    let slash_pos = file_path
        .find('/')
        .ok_or_else(|| "file_path must include a folder name (e.g. 'Lens/Doc.md')".to_string())?;

    let folder_name = &file_path[..slash_pos];
    let in_folder_path = format!("/{}", &file_path[slash_pos + 1..]);

    let _result = server
        .create_document(folder_name, &in_folder_path, content)
        .await
        .map_err(|e| e.to_string())?;

    Ok(format!("Created {}", file_path))
}
