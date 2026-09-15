//! MCP `delete` tool: move a file or folder to `<folder>/_trash/`.
//!
//! Thin wrapper over [`Server::trash_path`] (`crates/relay/src/server/trash.rs`).
//! The Admin/Edit role gate lives in `dispatch_tool` next to the read-only
//! gate; the folder-scope prefix check applies to `path` like every tool.

use crate::server::{trash_restore_hint, Server};
use serde_json::{json, Value};
use std::sync::Arc;

/// Execute the `delete` tool. Returns pretty JSON:
/// `{ trashed: [<new paths>], trashed_at, restore_hint }`.
pub async fn execute(server: &Arc<Server>, arguments: &Value) -> Result<String, String> {
    let path = arguments
        .get("path")
        .or_else(|| arguments.get("file_path"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .ok_or_else(|| "Missing required parameter: path".to_string())?;
    let force = match arguments.get("force") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(other) => {
            return Err(format!(
                "Invalid parameter: force must be a boolean, got {}",
                other
            ))
        }
    };

    let result = server
        .trash_path(path, force)
        .await
        .map_err(|e| e.message())?;

    let body = json!({
        "trashed": result.trashed_paths(),
        "trashed_at": result.trashed_at,
        "restore_hint": trash_restore_hint(result.root_trash_path()),
    });
    serde_json::to_string_pretty(&body).map_err(|e| e.to_string())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::mcp::tools::test_helpers::RELAY_ID;
    use std::collections::HashMap;
    use y_sweet_core::doc_sync::DocWithSyncKv;
    use y_sweet_core::link_indexer::TRASHED_AT_FIELD;
    use yrs::{Any, Map, ReadTxn, Text, Transact, WriteTxn};

    const FOLDER_UUID: &str = "b0000001-0000-4000-8000-000000000001";

    fn folder_doc_id() -> String {
        format!("{}-{}", RELAY_ID, FOLDER_UUID)
    }

    /// Folder "Lens" with the given entries; markdown entries get a content
    /// doc whose text is the given content. Backlinks are indexed from the
    /// content so inbound-link refusal can be exercised.
    pub(crate) async fn build_server(entries: &[(&str, &str, &str, &str)]) -> Arc<Server> {
        let server = Server::new_for_test();
        let folder_doc = DocWithSyncKv::new(&folder_doc_id(), None, || (), None)
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
            for (path, uuid, entry_type, _) in entries {
                let mut fields = HashMap::new();
                fields.insert("id".to_string(), Any::String((*uuid).into()));
                fields.insert("type".to_string(), Any::String((*entry_type).into()));
                fields.insert("version".to_string(), Any::Number(0.0));
                if *entry_type == "image" {
                    fields.insert("hash".to_string(), Any::String("abc123".into()));
                }
                filemeta.insert(&mut txn, *path, Any::Map(fields.into()));
                docs_map.insert(&mut txn, *path, Any::String((*uuid).into()));
            }
        }
        server.docs().insert(folder_doc_id(), folder_doc);

        for (_, uuid, entry_type, content) in entries {
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
                text.insert(&mut txn, 0, content);
            }
            server.docs().insert(doc_id, content_doc);
        }
        server.doc_resolver().rebuild(server.docs());

        // Index backlinks from content (what the link-indexer worker does).
        let folder_awareness = server.docs().get(&folder_doc_id()).unwrap().awareness();
        for (_, uuid, entry_type, _) in entries {
            if *entry_type != "markdown" {
                continue;
            }
            let doc_id = format!("{}-{}", RELAY_ID, uuid);
            let content_awareness = server.docs().get(&doc_id).unwrap().awareness();
            let folder_guard = folder_awareness.write().unwrap();
            let content_guard = content_awareness.read().unwrap();
            y_sweet_core::link_indexer::index_content_into_folder(
                uuid,
                &content_guard.doc,
                &folder_guard.doc,
            )
            .unwrap();
        }
        server
    }

    pub(crate) fn filemeta_snapshot(server: &Arc<Server>) -> HashMap<String, HashMap<String, Any>> {
        let awareness = server.docs().get(&folder_doc_id()).unwrap().awareness();
        let guard = awareness.read().unwrap();
        let txn = guard.doc.transact();
        let filemeta = txn.get_map("filemeta_v0").unwrap();
        filemeta
            .iter(&txn)
            .map(|(p, v)| {
                (
                    p.to_string(),
                    y_sweet_core::link_indexer::extract_filemeta_fields(&v, &txn),
                )
            })
            .collect()
    }

    fn legacy_docs_keys(server: &Arc<Server>) -> Vec<String> {
        let awareness = server.docs().get(&folder_doc_id()).unwrap().awareness();
        let guard = awareness.read().unwrap();
        let txn = guard.doc.transact();
        let mut keys: Vec<String> = txn
            .get_map("docs")
            .map(|m| m.keys(&txn).map(|k| k.to_string()).collect())
            .unwrap_or_default();
        keys.sort();
        keys
    }

    fn content_of(server: &Arc<Server>, uuid: &str) -> String {
        let doc_id = format!("{}-{}", RELAY_ID, uuid);
        let awareness = server.docs().get(&doc_id).unwrap().awareness();
        let guard = awareness.read().unwrap();
        let txn = guard.doc.transact();
        txn.get_text("contents")
            .map(|t| yrs::GetString::get_string(&t, &txn))
            .unwrap_or_default()
    }

    const A: &str = "11111111-1111-4111-8111-111111111111";
    const B: &str = "22222222-2222-4222-8222-222222222222";
    const DIR: &str = "33333333-3333-4333-8333-333333333333";
    const C: &str = "44444444-4444-4444-8444-444444444444";
    const IMG: &str = "55555555-5555-4555-8555-555555555555";

    #[tokio::test]
    async fn delete_moves_file_under_trash_and_stamps_trashed_at() {
        let server = build_server(&[("/Notes/A.md", A, "markdown", "plain")]).await;
        let out = execute(&server, &json!({"path": "Lens/Notes/A.md"}))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["trashed"], json!(["Lens/_trash/Notes/A.md"]));
        assert!(v["trashed_at"].as_u64().unwrap() > 0);
        assert!(v["restore_hint"]
            .as_str()
            .unwrap()
            .contains("move Lens/_trash/Notes/A.md back"));

        let meta = filemeta_snapshot(&server);
        assert!(meta.get("/Notes/A.md").is_none());
        let moved = meta.get("/_trash/Notes/A.md").expect("moved entry");
        assert_eq!(moved.get("id"), Some(&Any::String(A.into())));
        assert!(matches!(moved.get(TRASHED_AT_FIELD), Some(Any::Number(n)) if *n > 0.0));
        // Ancestors created, legacy docs map follows.
        assert_eq!(
            meta.get("/_trash").and_then(|m| m.get("type")),
            Some(&Any::String("folder".into()))
        );
        assert!(meta.contains_key("/_trash/Notes"));
        assert!(legacy_docs_keys(&server).contains(&"/_trash/Notes/A.md".to_string()));
        assert!(!legacy_docs_keys(&server).contains(&"/Notes/A.md".to_string()));
        // Resolver follows the move.
        assert_eq!(
            server.doc_resolver().path_for_uuid(A).as_deref(),
            Some("Lens/_trash/Notes/A.md")
        );
    }

    #[tokio::test]
    async fn delete_refuses_with_inbound_links_and_names_referencing_docs() {
        let server = build_server(&[
            ("/A.md", A, "markdown", "target"),
            ("/B.md", B, "markdown", "see [[A]] and again [[A]]"),
        ])
        .await;
        let err = execute(&server, &json!({"path": "Lens/A.md"}))
            .await
            .unwrap_err();
        assert!(
            err.starts_with("Cannot delete Lens/A.md: 1 document outside it still links to it"),
            "{err}"
        );
        assert!(err.contains("  - Lens/B.md (1 link)"), "{err}");
        assert!(
            err.contains("Fix or remove those references first"),
            "{err}"
        );
        assert!(err.contains("force: true"), "{err}");
        // Nothing moved.
        let meta = filemeta_snapshot(&server);
        assert!(meta.contains_key("/A.md"));
        assert!(!meta.contains_key("/_trash/A.md"));
    }

    #[tokio::test]
    async fn force_trashes_without_touching_referencing_doc() {
        let server = build_server(&[
            ("/A.md", A, "markdown", "target"),
            ("/B.md", B, "markdown", "see [[A]]"),
        ])
        .await;
        let out = execute(&server, &json!({"path": "Lens/A.md", "force": true}))
            .await
            .unwrap();
        assert!(out.contains("Lens/_trash/A.md"));
        assert_eq!(
            content_of(&server, B),
            "see [[A]]",
            "links must not be rewritten"
        );
        assert!(filemeta_snapshot(&server).contains_key("/_trash/A.md"));
    }

    #[tokio::test]
    async fn links_from_inside_the_subtree_do_not_block_a_folder_delete() {
        let server = build_server(&[
            ("/Dir", DIR, "folder", ""),
            ("/Dir/A.md", A, "markdown", "see [[C]]"),
            ("/Dir/C.md", C, "markdown", "see [[A]]"),
            ("/Dir/pic.png", IMG, "image", ""),
        ])
        .await;
        let out = execute(&server, &json!({"path": "Lens/Dir"}))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            v["trashed"],
            json!([
                "Lens/_trash/Dir",
                "Lens/_trash/Dir/A.md",
                "Lens/_trash/Dir/C.md",
                "Lens/_trash/Dir/pic.png"
            ])
        );
        let meta = filemeta_snapshot(&server);
        for p in [
            "/_trash/Dir",
            "/_trash/Dir/A.md",
            "/_trash/Dir/C.md",
            "/_trash/Dir/pic.png",
        ] {
            let e = meta.get(p).unwrap_or_else(|| panic!("{p} missing"));
            assert!(e.get(TRASHED_AT_FIELD).is_some(), "{p} unstamped");
        }
        // The folder entry kept its uuid (not re-minted by ensure_ancestor_folders).
        assert_eq!(
            meta["/_trash/Dir"].get("id"),
            Some(&Any::String(DIR.into()))
        );
        // Blob keeps its hash.
        assert_eq!(
            meta["/_trash/Dir/pic.png"].get("hash"),
            Some(&Any::String("abc123".into()))
        );
        assert!(!meta.contains_key("/Dir"));
        assert!(!meta.contains_key("/Dir/A.md"));
    }

    #[tokio::test]
    async fn delete_rejects_trash_root_already_trashed_folder_root_and_missing() {
        let server = build_server(&[
            ("/_trash", DIR, "folder", ""),
            ("/_trash/Old.md", A, "markdown", "x"),
            ("/Live.md", B, "markdown", "y"),
        ])
        .await;
        let err = execute(&server, &json!({"path": "Lens/_trash"}))
            .await
            .unwrap_err();
        assert!(
            err.contains("Cannot delete the _trash folder itself"),
            "{err}"
        );
        let err = execute(&server, &json!({"path": "Lens/_trash/Old.md"}))
            .await
            .unwrap_err();
        assert!(err.contains("already in the trash"), "{err}");
        let err = execute(&server, &json!({"path": "Lens"}))
            .await
            .unwrap_err();
        assert!(err.contains("Cannot delete a shared folder root"), "{err}");
        let err = execute(&server, &json!({"path": "Lens/Nope.md"}))
            .await
            .unwrap_err();
        assert!(err.contains("Path not found: Lens/Nope.md"), "{err}");
        let err = execute(&server, &json!({"path": "Other/x.md"}))
            .await
            .unwrap_err();
        assert!(err.contains("Path not found"), "{err}");
        let err = execute(&server, &json!({})).await.unwrap_err();
        assert!(err.contains("Missing required parameter: path"), "{err}");
        let err = execute(&server, &json!({"path": "Lens/Live.md", "force": "yes"}))
            .await
            .unwrap_err();
        assert!(err.contains("force must be a boolean"), "{err}");
        // Nothing moved by the failures.
        assert!(filemeta_snapshot(&server).contains_key("/Live.md"));
    }

    #[tokio::test]
    async fn second_delete_of_the_same_file_path_gets_a_numeric_suffix() {
        let server = build_server(&[
            ("/_trash/A.md", B, "markdown", "old"),
            ("/A.md", A, "markdown", "new"),
        ])
        .await;
        let out = execute(&server, &json!({"path": "Lens/A.md"}))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["trashed"], json!(["Lens/_trash/A-2.md"]));
        assert!(v["restore_hint"]
            .as_str()
            .unwrap()
            .contains("Lens/_trash/A-2.md"));
        let meta = filemeta_snapshot(&server);
        assert_eq!(meta["/_trash/A.md"].get("id"), Some(&Any::String(B.into())));
        assert_eq!(
            meta["/_trash/A-2.md"].get("id"),
            Some(&Any::String(A.into()))
        );
        assert!(meta["/_trash/A-2.md"].get(TRASHED_AT_FIELD).is_some());
        assert!(!meta.contains_key("/A.md"));
        assert!(legacy_docs_keys(&server).contains(&"/_trash/A-2.md".to_string()));

        // A third one takes the next free number.
        let server = build_server(&[
            ("/_trash/A.md", B, "markdown", "old"),
            ("/_trash/A-2.md", C, "markdown", "older"),
            ("/A.md", A, "markdown", "new"),
        ])
        .await;
        let out = execute(&server, &json!({"path": "Lens/A.md"}))
            .await
            .unwrap();
        assert!(out.contains("Lens/_trash/A-3.md"), "{out}");
    }

    #[tokio::test]
    async fn second_delete_of_the_same_folder_keeps_the_subtree_together() {
        let server = build_server(&[
            ("/_trash/Dir", DIR, "folder", ""),
            ("/_trash/Dir/X.md", B, "markdown", "old"),
            ("/Dir", C, "folder", ""),
            ("/Dir/X.md", A, "markdown", "new"),
            ("/Dir/pic.png", IMG, "image", ""),
        ])
        .await;
        let out = execute(&server, &json!({"path": "Lens/Dir"}))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            v["trashed"],
            json!([
                "Lens/_trash/Dir-2",
                "Lens/_trash/Dir-2/X.md",
                "Lens/_trash/Dir-2/pic.png"
            ])
        );
        let meta = filemeta_snapshot(&server);
        assert_eq!(
            meta["/_trash/Dir"].get("id"),
            Some(&Any::String(DIR.into()))
        );
        assert_eq!(
            meta["/_trash/Dir/X.md"].get("id"),
            Some(&Any::String(B.into()))
        );
        assert_eq!(
            meta["/_trash/Dir-2"].get("id"),
            Some(&Any::String(C.into()))
        );
        assert_eq!(
            meta["/_trash/Dir-2/X.md"].get("id"),
            Some(&Any::String(A.into()))
        );
        for p in [
            "/_trash/Dir-2",
            "/_trash/Dir-2/X.md",
            "/_trash/Dir-2/pic.png",
        ] {
            assert!(meta[p].get(TRASHED_AT_FIELD).is_some(), "{p} unstamped");
        }
        assert!(!meta.contains_key("/Dir"));

        // Children lingering without a folder entry still count as occupied.
        let server = build_server(&[
            ("/_trash/Dir/X.md", B, "markdown", "old"),
            ("/Dir", C, "folder", ""),
            ("/Dir/X.md", A, "markdown", "new"),
        ])
        .await;
        let out = execute(&server, &json!({"path": "Lens/Dir"}))
            .await
            .unwrap();
        assert!(out.contains("Lens/_trash/Dir-2/X.md"), "{out}");
    }

    #[tokio::test]
    async fn restore_via_move_clears_trashed_at() {
        let server = build_server(&[("/Notes/A.md", A, "markdown", "plain")]).await;
        execute(&server, &json!({"path": "Lens/Notes/A.md"}))
            .await
            .unwrap();
        assert!(filemeta_snapshot(&server)["/_trash/Notes/A.md"]
            .get(TRASHED_AT_FIELD)
            .is_some());

        let out = crate::mcp::tools::move_doc::execute(
            &server,
            &json!({"path": "Lens/_trash/Notes/A.md", "new_path": "/Notes/A.md"}),
        )
        .await
        .unwrap();
        assert!(
            out.contains("Moved Lens/_trash/Notes/A.md -> Lens/Notes/A.md"),
            "{out}"
        );
        let meta = filemeta_snapshot(&server);
        let restored = meta.get("/Notes/A.md").expect("restored entry");
        assert!(
            restored.get(TRASHED_AT_FIELD).is_none(),
            "trashed_at must be cleared"
        );
        assert!(!meta.contains_key("/_trash/Notes/A.md"));
        // Deleting again works (stamp is fresh).
        execute(&server, &json!({"path": "Lens/Notes/A.md"}))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn moving_within_trash_keeps_the_stamp_and_folder_restore_clears_it() {
        let server = build_server(&[
            ("/Dir", DIR, "folder", ""),
            ("/Dir/A.md", A, "markdown", "x"),
            ("/Dir/pic.png", IMG, "image", ""),
        ])
        .await;
        execute(&server, &json!({"path": "Lens/Dir"}))
            .await
            .unwrap();
        // Rename inside the trash: still trashed, stamp kept.
        crate::mcp::tools::move_doc::execute(
            &server,
            &json!({"path": "Lens/_trash/Dir/A.md", "new_path": "/_trash/Dir/A2.md"}),
        )
        .await
        .unwrap();
        assert!(filemeta_snapshot(&server)["/_trash/Dir/A2.md"]
            .get(TRASHED_AT_FIELD)
            .is_some());
        // Folder restore clears every entry (markdown and blob).
        crate::mcp::tools::move_doc::execute(
            &server,
            &json!({"path": "Lens/_trash/Dir", "new_path": "/Dir"}),
        )
        .await
        .unwrap();
        let meta = filemeta_snapshot(&server);
        for p in ["/Dir", "/Dir/A2.md", "/Dir/pic.png"] {
            assert!(
                meta.get(p)
                    .unwrap_or_else(|| panic!("{p} missing"))
                    .get(TRASHED_AT_FIELD)
                    .is_none(),
                "{p} still stamped"
            );
        }
    }

    #[tokio::test]
    async fn trash_records_a_recent_changes_event() {
        let server = build_server(&[("/A.md", A, "markdown", "plain")]).await;
        execute(&server, &json!({"path": "Lens/A.md"}))
            .await
            .unwrap();
        let events = server
            .recent_changes_index()
            .get(A)
            .expect("event recorded");
        let ev = events.last().unwrap();
        assert_eq!(ev.kind, "trash");
        assert_eq!(ev.old, "Lens/A.md");
        assert_eq!(ev.new, "Lens/_trash/A.md");
    }
}
