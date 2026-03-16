use crate::server::Server;
use std::collections::HashMap;
use std::sync::Arc;
use y_sweet_core::doc_sync::DocWithSyncKv;
use yrs::{Any, Doc, GetString, Map, ReadTxn, Text, Transact, WriteTxn};

pub(crate) const RELAY_ID: &str = "cb696037-0f72-4e93-8717-4e433129d789";
pub(crate) const FOLDER0_UUID: &str = "aaaa0000-0000-0000-0000-000000000000";

pub(crate) fn folder0_id() -> String {
    format!("{}-{}", RELAY_ID, FOLDER0_UUID)
}

pub(crate) fn set_folder_name(doc: &Doc, name: &str) {
    let mut txn = doc.transact_mut();
    let config = txn.get_or_insert_map("folder_config");
    config.insert(&mut txn, "name", Any::String(name.into()));
}

/// Create a folder Y.Doc with filemeta_v0 populated.
pub(crate) fn create_folder_doc(entries: &[(&str, &str)]) -> Doc {
    let doc = Doc::new();
    {
        let mut txn = doc.transact_mut();
        let filemeta = txn.get_or_insert_map("filemeta_v0");
        for (path, uuid) in entries {
            let mut map = HashMap::new();
            map.insert("id".to_string(), Any::String((*uuid).into()));
            map.insert("type".to_string(), Any::String("markdown".into()));
            map.insert("version".to_string(), Any::Number(0.0));
            filemeta.insert(&mut txn, *path, Any::Map(map.into()));
        }
    }
    doc
}

/// Create a test server with docs and a session with the doc marked as read.
pub(crate) async fn build_test_server(entries: &[(&str, &str, &str)]) -> Arc<Server> {
    let server = Server::new_for_test();

    let filemeta_entries: Vec<(&str, &str)> = entries
        .iter()
        .map(|(path, uuid, _)| (*path, *uuid))
        .collect();
    let folder_doc = create_folder_doc(&filemeta_entries);
    set_folder_name(&folder_doc, "Lens");

    let resolver = server.doc_resolver();
    resolver.update_folder_from_doc(&folder0_id(), &folder_doc);

    for (_, uuid, content) in entries {
        let doc_id = format!("{}-{}", RELAY_ID, uuid);
        let content_owned = content.to_string();
        let dwskv = DocWithSyncKv::new(&doc_id, None, || (), None)
            .await
            .expect("Failed to create test DocWithSyncKv");

        {
            let awareness = dwskv.awareness();
            let mut guard = awareness.write().unwrap();
            let mut txn = guard.doc.transact_mut();
            let text = txn.get_or_insert_text("contents");
            text.insert(&mut txn, 0, &content_owned);
        }

        server.docs().insert(doc_id, dwskv);
    }

    server
}

/// Create a session with a doc marked as already read.
pub(crate) fn setup_session_with_read(server: &Arc<Server>, doc_id: &str) -> String {
    let sid = server
        .mcp_sessions
        .create_session("2025-03-26".into(), None);
    server.mcp_sessions.mark_initialized(&sid);
    if let Some(mut session) = server.mcp_sessions.get_session_mut(&sid) {
        session.read_docs.insert(doc_id.to_string());
    }
    sid
}

/// Create a session WITHOUT any docs marked as read.
pub(crate) fn setup_session_no_reads(server: &Arc<Server>) -> String {
    let sid = server
        .mcp_sessions
        .create_session("2025-03-26".into(), None);
    server.mcp_sessions.mark_initialized(&sid);
    sid
}

/// Read the Y.Doc content back for verification.
pub(crate) fn read_doc_content(server: &Arc<Server>, doc_id: &str) -> String {
    let doc_ref = server.docs().get(doc_id).expect("doc should exist");
    let awareness = doc_ref.awareness();
    let guard = awareness.read().unwrap();
    let txn = guard.doc.transact();
    txn.get_text("contents")
        .map(|text| text.get_string(&txn))
        .unwrap_or_default()
}
