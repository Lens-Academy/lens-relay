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

/// Build a test server with a blob file in the store and filemeta entry with hash.
///
/// `path` should be like "/data.json" (the in-folder path with leading slash).
/// `uuid` is the document UUID. `content` is the blob content to store.
pub(crate) async fn build_blob_test_server_with_file(
    path: &str,
    uuid: &str,
    content: &str,
) -> Arc<Server> {
    use async_trait::async_trait;
    use dashmap::DashMap;
    use sha2::{Digest, Sha256};
    use std::time::Duration;
    use tokio_util::sync::CancellationToken;
    use y_sweet_core::store::Result as StoreResult;
    use y_sweet_core::store::Store;

    struct MemoryStore {
        data: Arc<DashMap<String, Vec<u8>>>,
    }

    #[async_trait]
    impl Store for MemoryStore {
        async fn init(&self) -> StoreResult<()> {
            Ok(())
        }
        async fn get(&self, key: &str) -> StoreResult<Option<Vec<u8>>> {
            Ok(self.data.get(key).map(|v| v.clone()))
        }
        async fn set(&self, key: &str, value: Vec<u8>) -> StoreResult<()> {
            self.data.insert(key.to_owned(), value);
            Ok(())
        }
        async fn remove(&self, key: &str) -> StoreResult<()> {
            self.data.remove(key);
            Ok(())
        }
        async fn exists(&self, key: &str) -> StoreResult<bool> {
            Ok(self.data.contains_key(key))
        }
    }

    // Compute hash
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let hash = format!("{:x}", hasher.finalize());

    let doc_id = format!("{}-{}", RELAY_ID, uuid);

    // Create store and write blob
    let store_data: Arc<DashMap<String, Vec<u8>>> = Arc::new(DashMap::new());
    let blob_key = format!("files/{}/{}", doc_id, hash);
    store_data.insert(blob_key, content.as_bytes().to_vec());

    let server = Arc::new(
        Server::new_without_workers(
            Some(Box::new(MemoryStore {
                data: store_data,
            })),
            Duration::from_secs(60),
            None,
            None,
            Vec::new(),
            CancellationToken::new(),
            false,
            None,
        )
        .await
        .expect("server creation should succeed"),
    );

    // Create folder doc with filemeta entry including hash
    let folder_doc = {
        let doc = Doc::new();
        {
            let mut txn = doc.transact_mut();
            let filemeta = txn.get_or_insert_map("filemeta_v0");
            let mut map = HashMap::new();
            map.insert("id".to_string(), Any::String(uuid.into()));
            map.insert("type".to_string(), Any::String("file".into()));
            map.insert("version".to_string(), Any::Number(0.0));
            map.insert("hash".to_string(), Any::String(hash.into()));
            filemeta.insert(&mut txn, path, Any::Map(map.into()));
            let config = txn.get_or_insert_map("folder_config");
            config.insert(&mut txn, "name", Any::String("Lens".into()));
        }
        doc
    };

    server
        .doc_resolver()
        .update_folder_from_doc(&folder0_id(), &folder_doc);

    server
}

/// Build a test server with a store and a loaded folder doc (for create_blob_file tests).
///
/// The server has:
/// - An in-memory store (required for blob writes)
/// - A folder Y.Doc loaded into `server.docs()` with folder_config name "Lens"
///   and empty filemeta_v0/docs maps
/// - The folder doc registered in the resolver
pub(crate) async fn build_blob_test_server_with_folder() -> Arc<Server> {
    use async_trait::async_trait;
    use dashmap::DashMap;
    use std::time::Duration;
    use tokio_util::sync::CancellationToken;
    use y_sweet_core::store::Result as StoreResult;
    use y_sweet_core::store::Store;

    struct MemoryStore {
        data: Arc<DashMap<String, Vec<u8>>>,
    }

    #[async_trait]
    impl Store for MemoryStore {
        async fn init(&self) -> StoreResult<()> {
            Ok(())
        }
        async fn get(&self, key: &str) -> StoreResult<Option<Vec<u8>>> {
            Ok(self.data.get(key).map(|v| v.clone()))
        }
        async fn set(&self, key: &str, value: Vec<u8>) -> StoreResult<()> {
            self.data.insert(key.to_owned(), value);
            Ok(())
        }
        async fn remove(&self, key: &str) -> StoreResult<()> {
            self.data.remove(key);
            Ok(())
        }
        async fn exists(&self, key: &str) -> StoreResult<bool> {
            Ok(self.data.contains_key(key))
        }
    }

    let store = MemoryStore {
        data: Arc::new(DashMap::new()),
    };
    let server = Arc::new(
        Server::new_without_workers(
            Some(Box::new(store)),
            Duration::from_secs(60),
            None,
            None,
            Vec::new(),
            CancellationToken::new(),
            false,
            None,
        )
        .await
        .expect("server creation should succeed"),
    );

    // Create and load folder DocWithSyncKv
    let folder_doc_id = folder0_id();
    let dwskv = DocWithSyncKv::new(&folder_doc_id, None, || (), None)
        .await
        .expect("Failed to create folder DocWithSyncKv");

    // Set folder_config name and initialize filemeta_v0/docs maps
    {
        let awareness = dwskv.awareness();
        let mut guard = awareness.write().unwrap();
        let mut txn = guard.doc.transact_mut();
        let config = txn.get_or_insert_map("folder_config");
        config.insert(&mut txn, "name", Any::String("Lens".into()));
        // Initialize maps; add root "/" folder entry so find_all_folder_docs detects this
        let filemeta = txn.get_or_insert_map("filemeta_v0");
        let mut root_map = HashMap::new();
        root_map.insert("type".to_string(), Any::String("folder".into()));
        filemeta.insert(&mut txn, "/", Any::Map(root_map.into()));
        txn.get_or_insert_map("docs");
    }

    // Insert into server docs
    server.docs().insert(folder_doc_id.clone(), dwskv);

    // Update resolver from the folder doc
    {
        let doc_ref = server.docs().get(&folder_doc_id).unwrap();
        let awareness = doc_ref.awareness();
        let guard = awareness.read().unwrap();
        server
            .doc_resolver()
            .update_folder_from_doc(&folder_doc_id, &guard.doc);
    }

    server
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
