use crate::server::Server;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use y_sweet_core::doc_sync::DocWithSyncKv;
use y_sweet_core::share_token::McpAccess;
use yrs::{Any, Doc, GetString, Map, ReadTxn, Text, Transact, WriteTxn};

pub(crate) fn default_access() -> McpAccess {
    McpAccess {
        writable: true,
        folder_uuid: None,
        folder_name: None,
        raw_token: None,
        role: y_sweet_core::share_token::ShareRole::Admin,
    }
}

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
    build_test_server_in("Lens", entries).await
}

/// [`build_test_server`] with the folder named `folder` (e.g. "Lens Edu").
pub(crate) async fn build_test_server_in(
    folder: &str,
    entries: &[(&str, &str, &str)],
) -> Arc<Server> {
    let server = Server::new_for_test();

    let filemeta_entries: Vec<(&str, &str)> = entries
        .iter()
        .map(|(path, uuid, _)| (*path, *uuid))
        .collect();
    let folder_doc = create_folder_doc(&filemeta_entries);
    set_folder_name(&folder_doc, folder);

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
        .create_session(default_access(), None, None);
    if let Some(mut session) = server.mcp_sessions.get_session_mut(&sid) {
        session.read_docs.insert(doc_id.to_string());
    }
    sid
}

/// Create a session WITHOUT any docs marked as read.
pub(crate) fn setup_session_no_reads(server: &Arc<Server>) -> String {
    server
        .mcp_sessions
        .create_session(default_access(), None, None)
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
    build_blob_test_server_with_bytes(path, uuid, content.as_bytes(), "application/json").await
}

/// Like [`build_blob_test_server_with_file`] for arbitrary bytes and mimetype
/// (image attachments are registered as filemeta type "image").
pub(crate) async fn build_blob_test_server_with_bytes(
    path: &str,
    uuid: &str,
    content: &[u8],
    mimetype: &str,
) -> Arc<Server> {
    build_slow_blob_test_server(&[(path, uuid, content, mimetype)], Duration::ZERO).await
}

/// Like [`build_blob_test_server_with_bytes`] for several `(path, uuid,
/// content, mimetype)` files, in a store whose every read waits `delay`.
pub(crate) async fn build_slow_blob_test_server(
    files: &[(&str, &str, &[u8], &str)],
    delay: Duration,
) -> Arc<Server> {
    use sha2::{Digest, Sha256};

    let store = MemoryStore::with_delay(delay);
    let mut filemeta_entries = Vec::new();
    for (path, uuid, content, mimetype) in files {
        let hash = format!("{:x}", Sha256::digest(content));
        let doc_id = format!("{}-{}", RELAY_ID, uuid);
        store
            .data
            .insert(format!("files/{}/{}", doc_id, hash), content.to_vec());
        filemeta_entries.push((*path, *uuid, hash, *mimetype));
    }
    let server = server_with_store(store).await;

    // Create and load folder DocWithSyncKv with filemeta entries including hash
    let folder_doc_id = folder0_id();
    let dwskv = DocWithSyncKv::new(&folder_doc_id, None, || (), None)
        .await
        .expect("Failed to create folder DocWithSyncKv");

    {
        let awareness = dwskv.awareness();
        let guard = awareness.write().unwrap();
        let mut txn = guard.doc.transact_mut();
        let filemeta = txn.get_or_insert_map("filemeta_v0");
        for (path, uuid, hash, mimetype) in filemeta_entries {
            let mut map = HashMap::new();
            let entry_type = if mimetype.starts_with("image/") {
                "image"
            } else {
                "file"
            };
            map.insert("id".to_string(), Any::String(uuid.into()));
            map.insert("type".to_string(), Any::String(entry_type.into()));
            map.insert("version".to_string(), Any::Number(0.0));
            map.insert("hash".to_string(), Any::String(hash.into()));
            map.insert("mimetype".to_string(), Any::String(mimetype.into()));
            map.insert(
                "synctime".to_string(),
                Any::Number(
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as f64,
                ),
            );
            filemeta.insert(&mut txn, path, Any::Map(map.into()));
        }
        let config = txn.get_or_insert_map("folder_config");
        config.insert(&mut txn, "name", Any::String("Lens".into()));
    }

    server.docs().insert(folder_doc_id.clone(), dwskv);

    // Update resolver from the loaded folder doc
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

/// An in-memory store for tests. Every read waits `delay` first, as R2 can
/// after a restart.
struct MemoryStore {
    data: Arc<dashmap::DashMap<String, Vec<u8>>>,
    delay: Duration,
}

impl MemoryStore {
    fn with_delay(delay: Duration) -> Self {
        Self {
            data: Arc::default(),
            delay,
        }
    }
}

#[async_trait::async_trait]
impl y_sweet_core::store::Store for MemoryStore {
    async fn init(&self) -> y_sweet_core::store::Result<()> {
        Ok(())
    }
    async fn get(&self, key: &str) -> y_sweet_core::store::Result<Option<Vec<u8>>> {
        if !self.delay.is_zero() {
            tokio::time::sleep(self.delay).await;
        }
        Ok(self.data.get(key).map(|v| v.clone()))
    }
    async fn set(&self, key: &str, value: Vec<u8>) -> y_sweet_core::store::Result<()> {
        self.data.insert(key.to_owned(), value);
        Ok(())
    }
    async fn remove(&self, key: &str) -> y_sweet_core::store::Result<()> {
        self.data.remove(key);
        Ok(())
    }
    async fn exists(&self, key: &str) -> y_sweet_core::store::Result<bool> {
        Ok(self.data.contains_key(key))
    }
}

/// A server without workers on `store`.
async fn server_with_store(store: MemoryStore) -> Arc<Server> {
    Arc::new(
        Server::new_without_workers(
            Some(Box::new(store)),
            Duration::from_secs(60),
            None,
            None,
            Vec::new(),
            tokio_util::sync::CancellationToken::new(),
            false,
            None,
        )
        .await
        .expect("server creation should succeed"),
    )
}

/// Build a test server with a store and a loaded folder doc (for create_blob_file tests).
///
/// The server has:
/// - An in-memory store (required for blob writes)
/// - A folder Y.Doc loaded into `server.docs()` with folder_config name "Lens"
///   and empty filemeta_v0/docs maps
/// - The folder doc registered in the resolver
pub(crate) async fn build_blob_test_server_with_folder() -> Arc<Server> {
    let server = server_with_store(MemoryStore::with_delay(Duration::ZERO)).await;

    // Create and load folder DocWithSyncKv
    let folder_doc_id = folder0_id();
    let dwskv = DocWithSyncKv::new(&folder_doc_id, None, || (), None)
        .await
        .expect("Failed to create folder DocWithSyncKv");

    // Set folder_config name and initialize filemeta_v0/docs maps
    {
        let awareness = dwskv.awareness();
        let guard = awareness.write().unwrap();
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

/// Rename folder 0 (its `folder_config.name`) and rebuild its resolver paths,
/// for servers whose builder names the folder "Lens".
pub(crate) fn rename_folder0(server: &Arc<Server>, name: &str) {
    let awareness = server
        .docs()
        .get(&folder0_id())
        .expect("folder doc should be loaded")
        .awareness();
    {
        let guard = awareness.write().unwrap();
        set_folder_name(&guard.doc, name);
    }
    server
        .doc_resolver()
        .update_folder(&folder0_id(), server.docs());
}

/// One scripted answer of [`mock_platform`]'s `/api/content/check`.
#[derive(Clone)]
pub(crate) struct MockReply {
    status: u16,
    body: serde_json::Value,
    retry_after: Option<String>,
    delay: Duration,
}

impl MockReply {
    pub(crate) fn ok(body: serde_json::Value) -> Self {
        Self {
            status: 200,
            body,
            retry_after: None,
            delay: Duration::ZERO,
        }
    }

    pub(crate) fn status(status: u16) -> Self {
        Self {
            status,
            body: serde_json::json!({"detail": "mock"}),
            ..Self::ok(serde_json::Value::Null)
        }
    }

    /// The answer's JSON body (an error status says `{"detail": "mock"}`).
    pub(crate) fn body(mut self, body: serde_json::Value) -> Self {
        self.body = body;
        self
    }

    /// A `Retry-After` header: seconds, or an HTTP date.
    pub(crate) fn retry_after(mut self, value: impl ToString) -> Self {
        self.retry_after = Some(value.to_string());
        self
    }

    pub(crate) fn delay(mut self, delay: Duration) -> Self {
        self.delay = delay;
        self
    }
}

/// A request [`mock_platform`] received, with its body un-gzipped and parsed.
#[derive(Clone, Debug)]
pub(crate) struct MockRequest {
    pub path: String,
    pub key: String,
    pub encoding: String,
    pub body: serde_json::Value,
}

pub(crate) struct MockPlatform {
    url: String,
    requests: Arc<std::sync::Mutex<Vec<MockRequest>>>,
}

impl MockPlatform {
    /// The platform config that reaches this mock, with key "sek".
    pub(crate) fn platform(&self) -> super::validate_content::Platform {
        super::validate_content::Platform {
            url: self.url.clone(),
            secret: "sek".to_string(),
        }
    }

    pub(crate) fn requests(&self) -> Vec<MockRequest> {
        self.requests.lock().unwrap().clone()
    }
}

/// A stand-in for lens-platform's validator endpoints. `POST
/// /api/content/check` answers `replies` in order (the last one repeats);
/// `POST /api/content/validate-adhoc` answers an empty result.
pub(crate) async fn mock_platform(replies: Vec<MockReply>) -> MockPlatform {
    use axum::extract::Request;
    use axum::response::IntoResponse;
    use axum::routing::post;

    async fn record(req: Request) -> MockRequest {
        use std::io::Read;
        let (path, key, encoding) = {
            let header = |name: &str| {
                req.headers()
                    .get(name)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string()
            };
            let path = req.uri().path().to_string();
            (path, header("x-validation-key"), header("content-encoding"))
        };
        let bytes = axum::body::to_bytes(req.into_body(), 256 << 20)
            .await
            .unwrap();
        let mut raw = Vec::new();
        if encoding == "gzip" {
            flate2::read::GzDecoder::new(&bytes[..])
                .read_to_end(&mut raw)
                .unwrap();
        } else {
            raw = bytes.to_vec();
        }
        MockRequest {
            path,
            key,
            encoding,
            body: serde_json::from_slice(&raw).unwrap_or(serde_json::Value::Null),
        }
    }

    let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
    let replies = Arc::new(std::sync::Mutex::new(
        replies
            .into_iter()
            .collect::<std::collections::VecDeque<_>>(),
    ));
    let check_requests = requests.clone();
    let adhoc_requests = requests.clone();
    let app = axum::Router::new()
        .route(
            "/api/content/check",
            post(move |req: Request| {
                let requests = check_requests.clone();
                let replies = replies.clone();
                async move {
                    let recorded = record(req).await;
                    requests.lock().unwrap().push(recorded);
                    let reply = {
                        let mut queue = replies.lock().unwrap();
                        if queue.len() > 1 {
                            queue.pop_front()
                        } else {
                            queue.front().cloned()
                        }
                    }
                    .expect("mock platform needs at least one reply");
                    tokio::time::sleep(reply.delay).await;
                    let mut response = axum::Json(reply.body).into_response();
                    *response.status_mut() =
                        axum::http::StatusCode::from_u16(reply.status).unwrap();
                    if let Some(value) = reply.retry_after {
                        response
                            .headers_mut()
                            .insert("retry-after", value.parse().unwrap());
                    }
                    response
                }
            }),
        )
        .route(
            "/api/content/validate-adhoc",
            post(move |req: Request| {
                let requests = adhoc_requests.clone();
                async move {
                    let recorded = record(req).await;
                    requests.lock().unwrap().push(recorded);
                    axum::Json(serde_json::json!({"summary": {}, "issues": [], "counts": {}}))
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    MockPlatform { url, requests }
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
