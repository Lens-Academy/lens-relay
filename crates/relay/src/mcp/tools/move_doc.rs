use crate::server::Server;
use serde_json::Value;
use std::sync::Arc;

/// Execute the `move` tool: move or rename a file or folder.
pub async fn execute(server: &Arc<Server>, arguments: &Value) -> Result<String, String> {
    let path = arguments
        .get("path")
        .or_else(|| arguments.get("file_path"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter: path".to_string())?;

    let new_path = arguments
        .get("new_path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter: new_path".to_string())?;

    let target_folder = arguments.get("target_folder").and_then(|v| v.as_str());

    let result = server
        .move_path(path, new_path, target_folder)
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;
    use y_sweet_core::doc_sync::DocWithSyncKv;
    use yrs::{Any, Map, Text, Transact, WriteTxn};

    const RELAY_ID: &str = "cb696037-0f72-4e93-8717-4e433129d789";
    const FOLDER_UUID: &str = "b0000001-0000-4000-8000-000000000001";

    async fn build_move_server(entries: &[(&str, &str, &str)]) -> Arc<Server> {
        let server = Server::new_for_test();
        let folder_doc_id = format!("{}-{}", RELAY_ID, FOLDER_UUID);
        let folder_doc = DocWithSyncKv::new(&folder_doc_id, None, || (), None)
            .await
            .unwrap();
        {
            let awareness = folder_doc.awareness();
            let guard = awareness.write().unwrap();
            let mut txn = guard.doc.transact_mut();
            let config = txn.get_or_insert_map("folder_config");
            config.insert(&mut txn, "name", Any::String("Lens".into()));
            let filemeta = txn.get_or_insert_map("filemeta_v0");
            let docs_map = txn.get_or_insert_map("docs");
            for (path, uuid, entry_type) in entries {
                let mut fields = HashMap::new();
                fields.insert("id".to_string(), Any::String((*uuid).into()));
                fields.insert("type".to_string(), Any::String((*entry_type).into()));
                fields.insert("version".to_string(), Any::Number(0.0));
                filemeta.insert(&mut txn, *path, Any::Map(fields.into()));
                docs_map.insert(&mut txn, *path, Any::String((*uuid).into()));
            }
        }
        server.docs().insert(folder_doc_id, folder_doc);

        for (path, uuid, entry_type) in entries {
            if *entry_type != "markdown" {
                continue;
            }
            let doc_id = format!("{}-{}", RELAY_ID, uuid);
            let content_doc = DocWithSyncKv::new(&doc_id, None, || (), None)
                .await
                .unwrap();
            {
                let awareness = content_doc.awareness();
                let guard = awareness.write().unwrap();
                let mut txn = guard.doc.transact_mut();
                let text = txn.get_or_insert_text("contents");
                text.insert(&mut txn, 0, &format!("content for {}", path));
            }
            server.docs().insert(doc_id, content_doc);
        }
        server.doc_resolver().rebuild(server.docs());
        server
    }

    #[tokio::test]
    async fn move_accepts_path_for_file_move() {
        let server = build_move_server(&[(
            "/Old.md",
            "11111111-1111-4111-8111-111111111111",
            "markdown",
        )])
        .await;

        let output = execute(
            &server,
            &json!({
                "path": "Lens/Old.md",
                "new_path": "/New.md",
            }),
        )
        .await
        .unwrap();

        assert!(output.contains("Moved Lens/Old.md -> Lens/New.md"));
    }

    #[tokio::test]
    async fn move_accepts_file_path_alias_for_file_move() {
        let server = build_move_server(&[(
            "/Old.md",
            "11111111-1111-4111-8111-111111111111",
            "markdown",
        )])
        .await;

        let output = execute(
            &server,
            &json!({
                "file_path": "Lens/Old.md",
                "new_path": "/New.md",
            }),
        )
        .await
        .unwrap();

        assert!(output.contains("Moved Lens/Old.md -> Lens/New.md"));
    }

    #[tokio::test]
    async fn move_accepts_path_for_folder_rename() {
        let server = build_move_server(&[
            ("/Old", "22222222-2222-4222-8222-222222222222", "folder"),
            (
                "/Old/Child.md",
                "33333333-3333-4333-8333-333333333333",
                "markdown",
            ),
        ])
        .await;

        let output = execute(
            &server,
            &json!({
                "path": "Lens/Old",
                "new_path": "/New",
            }),
        )
        .await
        .unwrap();

        assert!(output.contains("Moved Lens/Old -> Lens/New"));
    }
}
