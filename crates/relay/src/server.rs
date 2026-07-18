use anyhow::{anyhow, Result};
use axum::{
    body::Bytes,
    extract::DefaultBodyLimit,
    extract::{
        multipart::Multipart,
        ws::{CloseFrame, Message, WebSocket},
        MatchedPath, Path, Query, Request, State, WebSocketUpgrade,
    },
    http::{
        header::{HeaderName, HeaderValue},
        StatusCode,
    },
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, head, post},
    Json, Router,
};
use axum_extra::typed_header::TypedHeader;
use dashmap::{mapref::entry::Entry, mapref::one::MappedRef, DashMap};
use futures::{SinkExt, StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    sync::{
        atomic::{AtomicU64, Ordering as AtomicOrdering},
        Arc, RwLock,
    },
    time::Duration,
};
use tempfile::NamedTempFile;
use tokio::{
    net::TcpListener,
    sync::mpsc::{channel, Receiver},
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use tracing::{span, Instrument, Level};
use url::Url;
use y_sweet_core::{
    api_types::{
        validate_doc_name, validate_file_hash, AuthDocRequest, Authorization, ClientToken,
        DocCreationRequest, DocumentVersionEntry, DocumentVersionResponse, FileDownloadUrlResponse,
        FileHistoryEntry, FileHistoryResponse, FileUploadUrlResponse, NewDocResponse,
    },
    auth::{Authenticator, ExpirationTimeEpochMillis, Permission, DEFAULT_EXPIRATION_SECONDS},
    critic_scanner,
    doc_connection::DocConnection,
    doc_resolver::{DocInfo, DocumentResolver},
    doc_sync::DocWithSyncKv,
    event::{
        DebouncedSyncProtocolEventSender, DocumentUpdatedEvent, EventDispatcher, EventEnvelope,
        EventSender, SyncProtocolEventSender, UnifiedEventDispatcher, WebhookSender,
    },
    link_indexer::{self, LinkIndexer},
    metrics::RelayMetrics,
    search_index::SearchIndex,
    store::Store,
    suggestions_index::SuggestionsIndex,
    sync::awareness::Awareness,
    sync_kv::SyncKv,
    webhook::WebhookConfig,
};
use yrs::{GetString, Map, ReadTxn, Text, Transact, WriteTxn};

const RELAY_SERVER_VERSION: &str = env!("GIT_VERSION");

#[derive(Clone, Debug)]
pub struct AllowedHost {
    pub host: String,
    pub scheme: String, // "http" or "https"
}

fn current_time_epoch_millis() -> u64 {
    let now = std::time::SystemTime::now();
    let duration_since_epoch = now.duration_since(std::time::UNIX_EPOCH).unwrap();
    duration_since_epoch.as_millis() as u64
}

async fn auth_metrics_middleware(
    State(server_state): State<Arc<Server>>,
    matched_path: Option<MatchedPath>,
    req: Request,
    next: Next,
) -> Response {
    let method = req.method().to_string();
    let resp = next.run(req).await;
    let status = resp.status();

    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        let path = matched_path
            .as_ref()
            .map(|m| m.as_str())
            .unwrap_or("unknown");
        let error_type = resp
            .extensions()
            .get::<AuthErrorType>()
            .map(|e| e.0)
            .unwrap_or("unknown");
        let status_str = status.as_u16().to_string();

        server_state
            .metrics
            .record_http_auth_error(error_type, &status_str, path, &method);
    }

    resp
}

fn validate_file_token(
    server_state: &Arc<Server>,
    token: &str,
    doc_id: &str,
) -> Result<Permission, AppError> {
    let authenticator = server_state.authenticator.as_ref().ok_or_else(|| {
        AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            anyhow!("No authenticator configured"),
        )
    })?;

    let permission = authenticator
        .verify_token_auto(token, current_time_epoch_millis())
        .map_err(|auth_error| {
            AppError::auth(
                StatusCode::UNAUTHORIZED,
                anyhow!("Invalid token"),
                auth_error.to_metric_label(),
            )
        })?;

    match &permission {
        Permission::File(file_permission) => {
            if file_permission.doc_id != doc_id {
                return Err(AppError::auth(
                    StatusCode::UNAUTHORIZED,
                    anyhow!("Token not valid for this document"),
                    "access_wrong_document",
                ));
            }
        }
        _ => {
            return Err(AppError::auth(
                StatusCode::BAD_REQUEST,
                anyhow!("Token must be a file token"),
                "wrong_token_type",
            ));
        }
    }

    Ok(permission)
}

/// Newtype for passing auth error context through response extensions.
#[derive(Clone, Debug)]
pub struct AuthErrorType(pub &'static str);

#[derive(Debug)]
pub struct AppError {
    pub status: StatusCode,
    pub error: anyhow::Error,
    auth_error_type: Option<&'static str>,
}

impl AppError {
    fn new(status: StatusCode, error: anyhow::Error) -> Self {
        Self {
            status,
            error,
            auth_error_type: None,
        }
    }

    pub fn auth(status: StatusCode, error: anyhow::Error, error_type: &'static str) -> Self {
        Self {
            status,
            error,
            auth_error_type: Some(error_type),
        }
    }
}

impl std::error::Error for AppError {}
impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let mut response =
            (self.status, format!("Something went wrong: {}", self.error)).into_response();
        if let Some(error_type) = self.auth_error_type {
            response.extensions_mut().insert(AuthErrorType(error_type));
        }
        response
    }
}
impl<E> From<(StatusCode, E)> for AppError
where
    E: Into<anyhow::Error>,
{
    fn from((status_code, err): (StatusCode, E)) -> Self {
        Self {
            status: status_code,
            error: err.into(),
            auth_error_type: None,
        }
    }
}
impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Status code: {} {}", self.status, self.error)?;
        Ok(())
    }
}

/// Error type for `Server::move_document()` that preserves HTTP status code semantics.
#[derive(Debug)]
pub enum MoveDocumentError {
    /// 400: invalid input (bad path format, unknown target folder)
    BadRequest(String),
    /// 404: UUID or folder documents not found
    NotFound(String),
    /// 409: destination path already exists
    Conflict(String),
    /// 500: internal error (lock failure, storage error, etc.)
    Internal(String),
}

impl std::fmt::Display for MoveDocumentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadRequest(msg) => write!(f, "{}", msg),
            Self::NotFound(msg) => write!(f, "{}", msg),
            Self::Conflict(msg) => write!(f, "{}", msg),
            Self::Internal(msg) => write!(f, "{}", msg),
        }
    }
}

impl std::error::Error for MoveDocumentError {}

impl From<MoveDocumentError> for AppError {
    fn from(e: MoveDocumentError) -> Self {
        let status = match &e {
            MoveDocumentError::BadRequest(_) => StatusCode::BAD_REQUEST,
            MoveDocumentError::NotFound(_) => StatusCode::NOT_FOUND,
            MoveDocumentError::Conflict(_) => StatusCode::CONFLICT,
            MoveDocumentError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        AppError::new(status, anyhow!("{}", e))
    }
}

/// Error type for `Server::create_document()` that preserves HTTP status code semantics.
#[derive(Debug)]
pub enum CreateDocumentError {
    /// 400: invalid input (bad path format)
    BadRequest(String),
    /// 404: folder not found
    NotFound(String),
    /// 409: path already exists in folder
    Conflict(String),
    /// 500: internal error
    Internal(String),
}

impl std::fmt::Display for CreateDocumentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadRequest(msg) => write!(f, "{}", msg),
            Self::NotFound(msg) => write!(f, "{}", msg),
            Self::Conflict(msg) => write!(f, "{}", msg),
            Self::Internal(msg) => write!(f, "{}", msg),
        }
    }
}

impl std::error::Error for CreateDocumentError {}

impl From<CreateDocumentError> for AppError {
    fn from(e: CreateDocumentError) -> Self {
        let status = match &e {
            CreateDocumentError::BadRequest(_) => StatusCode::BAD_REQUEST,
            CreateDocumentError::NotFound(_) => StatusCode::NOT_FOUND,
            CreateDocumentError::Conflict(_) => StatusCode::CONFLICT,
            CreateDocumentError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        AppError::new(status, anyhow!("{}", e))
    }
}

/// Result of a successful `Server::create_document()` call.
pub struct CreateDocumentResult {
    pub uuid: String,
    pub full_doc_id: String,
    pub folder_name: String,
    pub in_folder_path: String,
}

fn validate_file_path(path: &str) -> std::result::Result<(), &'static str> {
    if path.contains('"') {
        return Err("File names cannot contain double quotes");
    }
    Ok(())
}

#[derive(Deserialize)]
struct FileDownloadQueryParams {
    hash: Option<String>,
}

#[derive(Deserialize)]
struct FileUploadQueryParams {
    hash: Option<String>,
    content_type: Option<String>,
    content_length: Option<u64>,
}

#[derive(Deserialize)]
struct FileUploadParams {
    token: Option<String>,
    // Used in local dev (no auth) instead of a signed file token
    hash: Option<String>,
}

#[derive(Deserialize)]
struct FileDownloadParams {
    token: String,
    hash: String,
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    #[serde(default = "default_search_limit")]
    limit: usize,
}

fn default_search_limit() -> usize {
    20
}

#[derive(Deserialize)]
struct SuggestionsQuery {
    folder_id: String,
}

#[derive(Deserialize)]
struct MoveDocRequest {
    uuid: String,
    new_path: String,
    target_folder: Option<String>,
}

#[derive(Deserialize)]
struct MovePathRequest {
    path: String,
    new_path: String,
    target_folder: Option<String>,
}

#[derive(Serialize)]
struct MoveDocResponse {
    old_path: String,
    new_path: String,
    old_folder: String,
    new_folder: String,
    links_rewritten: usize,
}

// ---------------------------------------------------------------------------
// Search index background worker
// ---------------------------------------------------------------------------

const SEARCH_DEBOUNCE: Duration = Duration::from_secs(2);

/// Background worker for incremental search index updates.
///
/// Follows the same debounce pattern as LinkIndexer::run_worker:
/// - Content docs: debounce 2 seconds, then re-read Y.Text("contents") and upsert
/// - Folder docs: process immediately, detect added/removed docs, update search index
const SEARCH_POLL_INTERVAL: Duration = Duration::from_millis(250);

fn search_is_ready(entry: &link_indexer::PendingEntry) -> bool {
    entry.last_updated.elapsed() >= SEARCH_DEBOUNCE
        || entry.first_queued.elapsed() >= SEARCH_DEBOUNCE
}

/// Handle the outcome of a supervised worker. CleanExit logs INFO and stops.
/// BudgetExceeded logs CRITICAL with the panic context and exits the process
/// so Docker `restart: unless-stopped` cycles the container.
const WORKER_PRE_EXIT_DELAY: Duration = Duration::from_secs(30);

/// Why the pre-exit wait unblocked. Used for logging only; either path
/// ends in `process::exit(1)`.
#[derive(Debug, PartialEq, Eq)]
enum WorkerExitReason {
    DelayElapsed,
    CancellationRequested,
}

/// Wait up to `delay` for either the time to elapse or the cancellation
/// token to fire. Returns which fired so the caller can log. Extracted
/// from `graceful_exit_after_delay` to be unit-testable without
/// triggering `process::exit`.
async fn wait_for_worker_exit_signal(
    cancellation_token: CancellationToken,
    delay: Duration,
) -> WorkerExitReason {
    tokio::select! {
        _ = tokio::time::sleep(delay) => WorkerExitReason::DelayElapsed,
        _ = cancellation_token.cancelled() => WorkerExitReason::CancellationRequested,
    }
}

/// Pre-exit window: sleeps for WORKER_PRE_EXIT_DELAY (30s) so Prometheus
/// scrapers see `worker_alive=0` before the container restart cycle.
/// A SIGTERM during the window cancels the token and we exit immediately.
/// Always terminates in `process::exit(1)`.
async fn graceful_exit_after_delay(cancellation_token: CancellationToken) {
    let reason = wait_for_worker_exit_signal(cancellation_token, WORKER_PRE_EXIT_DELAY).await;
    match reason {
        WorkerExitReason::DelayElapsed => {
            tracing::error!("Pre-exit delay elapsed; calling process::exit(1)");
        }
        WorkerExitReason::CancellationRequested => {
            tracing::warn!("Cancellation requested during pre-exit delay; exiting immediately");
        }
    }
    std::process::exit(1);
}

async fn handle_worker_outcome(
    name: &'static str,
    outcome: crate::supervisor::SupervisorOutcome,
    metrics: &RelayMetrics,
    status: &crate::worker_status::WorkerStatusMap,
    cancellation_token: CancellationToken,
) {
    use crate::supervisor::SupervisorOutcome;
    crate::supervisor::apply_outcome(name, &outcome, metrics, status);
    match outcome {
        SupervisorOutcome::CleanExit => {
            tracing::info!(worker = name, "exited cleanly (channel closed)");
        }
        SupervisorOutcome::BudgetExceeded {
            count,
            first_msg,
            last_msg,
        } => {
            tracing::error!(
                worker = name,
                panic_count = count,
                first_panic_msg = %first_msg,
                last_panic_msg = %last_msg,
                "CRITICAL: panic budget exceeded; exiting process for container restart"
            );
            graceful_exit_after_delay(cancellation_token).await;
        }
    }
}

async fn search_worker(
    rx: &mut tokio::sync::mpsc::Receiver<String>,
    search_index: Arc<SearchIndex>,
    docs: Arc<DashMap<String, DocWithSyncKv>>,
    pending: Arc<DashMap<String, link_indexer::PendingEntry>>,
    suggestions_index: Arc<SuggestionsIndex>,
) {
    tracing::info!("Search index worker started");

    // Cache of folder doc -> { uuid -> (path, title) } for detecting adds/removes
    let filemeta_cache: DashMap<String, std::collections::HashMap<String, String>> = DashMap::new();

    loop {
        // 1. Wait for work: either a new channel message or poll timeout
        tokio::select! {
            msg = rx.recv() => {
                match msg {
                    Some(_) => { /* already in pending map */ }
                    None => break,
                }
            }
            _ = tokio::time::sleep(SEARCH_POLL_INTERVAL) => {}
        }

        // 2. Drain remaining channel messages (non-blocking)
        while rx.try_recv().is_ok() {}

        // ⚠️ LOCK ORDERING: DashMap shard locks < awareness RwLock
        //
        // We must NOT call is_folder_doc() inside pending.iter() — that would
        // hold a DashMap shard read guard while acquiring an awareness read lock,
        // creating a lock ordering cycle with WebSocket callbacks (which hold
        // awareness WRITE and then write to search_pending synchronously).
        // See docs/plans/2026-03-08-debounce-deadlock-fix.md for full analysis.

        // 3a. Snapshot pending keys+values (only DashMap shard locks, no external locks)
        let snapshot: Vec<(String, link_indexer::PendingEntry)> = pending
            .iter()
            .map(|e| (e.key().clone(), e.value().clone()))
            .collect();
        // Iterator dropped — all shard locks released.

        // 3b. Filter to ready (safe to acquire awareness locks now)
        let ready: Vec<String> = snapshot
            .into_iter()
            .filter(|(key, entry)| {
                let is_folder = link_indexer::is_folder_doc(key, &docs).is_some();
                is_folder || search_is_ready(entry)
            })
            .map(|(key, _)| key)
            .collect();

        // 4. Process each ready doc
        for doc_id in ready {
            pending.remove(&doc_id);

            if let Some(content_uuids) = link_indexer::is_folder_doc(&doc_id, &docs) {
                // Folder doc — detect added/removed documents
                search_handle_folder_update(
                    &doc_id,
                    &content_uuids,
                    &docs,
                    &search_index,
                    &filemeta_cache,
                    &suggestions_index,
                )
                .await;
            } else {
                // Content doc — reindex into search
                search_handle_content_update(&doc_id, &docs, &search_index, &suggestions_index);
            }
        }
    }
}

/// Handle a content doc update: read body, look up title from folder metadata, upsert into search
/// index, and rescan for CriticMarkup to keep the suggestions index current.
pub(crate) fn search_handle_content_update(
    doc_id: &str,
    docs: &DashMap<String, DocWithSyncKv>,
    search_index: &SearchIndex,
    suggestions_index: &SuggestionsIndex,
) {
    let Some((_relay_id, doc_uuid)) = link_indexer::parse_doc_id(doc_id) else {
        return;
    };

    // Read Y.Text("contents") body
    let body = {
        let awareness = {
            let Some(doc_ref) = docs.get(doc_id) else {
                return;
            };
            doc_ref.awareness() // Arc clone
        }; // DashMap shard lock released
        let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
        let txn = guard.doc.transact();
        match txn.get_text("contents") {
            Some(text) => text.get_string(&txn),
            None => String::new(),
        }
    };

    // Find which folder doc contains this UUID and extract title
    let (title, folder_name) = search_find_title_and_folder(doc_uuid, docs);

    match search_index.add_document(doc_uuid, &title, &body, &folder_name) {
        Ok(()) => tracing::debug!("Search indexed content doc: {} ({})", doc_uuid, title),
        Err(e) => tracing::error!("Search index failed for {}: {:?}", doc_uuid, e),
    }

    suggestions_index.update(doc_uuid, critic_scanner::scan_suggestions(&body));
}

/// Find the title and folder name for a content doc UUID by scanning all folder docs' filemeta_v0.
fn search_find_title_and_folder(
    doc_uuid: &str,
    docs: &DashMap<String, DocWithSyncKv>,
) -> (String, String) {
    let folder_doc_ids = link_indexer::find_all_folder_docs(docs);

    for folder_doc_id in &folder_doc_ids {
        let awareness = {
            let Some(doc_ref) = docs.get(folder_doc_id) else {
                continue;
            };
            doc_ref.awareness() // Arc clone
        }; // DashMap shard lock released
        let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
        let txn = guard.doc.transact();
        let Some(filemeta) = txn.get_map("filemeta_v0") else {
            continue;
        };

        for (path, value) in filemeta.iter(&txn) {
            if let Some(id) = link_indexer::extract_id_from_filemeta_entry(&value, &txn) {
                if id == doc_uuid {
                    // Extract title: strip leading "/" and trailing ".md", take basename
                    let path_str: &str = path;
                    let title = path_str
                        .strip_prefix('/')
                        .unwrap_or(path_str)
                        .strip_suffix(".md")
                        .unwrap_or(path_str)
                        .rsplit('/')
                        .next()
                        .unwrap_or(path_str)
                        .to_string();

                    let folder_name =
                        y_sweet_core::doc_resolver::read_folder_name(&guard.doc, folder_doc_id);

                    return (title, folder_name);
                }
            }
        }
    }

    // Not found in any folder doc — use UUID as title
    (doc_uuid.to_string(), "Unknown".to_string())
}

/// Handle folder doc update: detect added/removed UUIDs, update search index accordingly.
async fn search_handle_folder_update(
    folder_doc_id: &str,
    content_uuids: &[String],
    docs: &DashMap<String, DocWithSyncKv>,
    search_index: &SearchIndex,
    filemeta_cache: &DashMap<String, std::collections::HashMap<String, String>>,
    suggestions_index: &SuggestionsIndex,
) {
    // Build current uuid -> title map from filemeta
    let current_map: std::collections::HashMap<String, String> = {
        let awareness = {
            let Some(doc_ref) = docs.get(folder_doc_id) else {
                return;
            };
            doc_ref.awareness() // Arc clone
        }; // DashMap shard lock released
        let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
        let txn = guard.doc.transact();
        let Some(filemeta) = txn.get_map("filemeta_v0") else {
            return;
        };

        let mut map = std::collections::HashMap::new();
        for (path, value) in filemeta.iter(&txn) {
            if let Some(id) = link_indexer::extract_id_from_filemeta_entry(&value, &txn) {
                let path_str: &str = path;
                let title = path_str
                    .strip_prefix('/')
                    .unwrap_or(path_str)
                    .strip_suffix(".md")
                    .unwrap_or(path_str)
                    .rsplit('/')
                    .next()
                    .unwrap_or(path_str)
                    .to_string();
                map.insert(id, title);
            }
        }
        map
    };

    // Get old snapshot from cache
    let old_map = filemeta_cache.get(folder_doc_id).map(|r| r.clone());

    // Update cache with current snapshot
    filemeta_cache.insert(folder_doc_id.to_string(), current_map.clone());

    if let Some(old_map) = old_map {
        // Detect removed UUIDs
        for uuid in old_map.keys() {
            if !current_map.contains_key(uuid) {
                match search_index.remove_document(uuid) {
                    Ok(()) => tracing::info!("Search: removed doc {}", uuid),
                    Err(e) => tracing::error!("Search: failed to remove {}: {:?}", uuid, e),
                }
                // On a cross-folder move this can briefly wipe the entry if the
                // destination folder's update was processed first (same
                // semantics as the search-index removal above); the next
                // content update rescans and restores it.
                suggestions_index.update(uuid, Vec::new());
            }
        }

        // Detect added or renamed UUIDs — queue them for content indexing
        let Some((relay_id, _)) = link_indexer::parse_doc_id(folder_doc_id) else {
            return;
        };
        for (uuid, new_title) in &current_map {
            let old_title = old_map.get(uuid);
            if old_title.is_none() || old_title != Some(new_title) {
                // New or renamed — reindex content
                let content_id = format!("{}-{}", relay_id, uuid);
                if docs.contains_key(&content_id) {
                    search_handle_content_update(
                        &content_id,
                        docs,
                        search_index,
                        suggestions_index,
                    );
                }
            }
        }
    } else {
        // First time seeing this folder doc — index all content docs
        let Some((relay_id, _)) = link_indexer::parse_doc_id(folder_doc_id) else {
            return;
        };
        for uuid in content_uuids {
            let content_id = format!("{}-{}", relay_id, uuid);
            if docs.contains_key(&content_id) {
                search_handle_content_update(&content_id, docs, search_index, suggestions_index);
            }
        }
    }
}

pub struct Server {
    docs: Arc<DashMap<String, DocWithSyncKv>>,
    doc_worker_tracker: TaskTracker,
    store: Option<Arc<Box<dyn Store>>>,
    checkpoint_freq: Duration,
    authenticator: Option<Authenticator>,
    url: Option<Url>,
    allowed_hosts: Vec<AllowedHost>,
    cancellation_token: CancellationToken,
    /// Whether to garbage collect docs that are no longer in use.
    /// Disabled for single-doc mode, since we only have one doc.
    /// Uses AtomicBool so it can be temporarily disabled during startup loading.
    doc_gc: std::sync::atomic::AtomicBool,
    event_dispatcher: Option<Arc<dyn EventDispatcher>>,
    sync_protocol_event_sender: Arc<SyncProtocolEventSender>,
    metrics: Arc<RelayMetrics>,
    link_indexer: Option<Arc<LinkIndexer>>,
    search_index: Option<Arc<SearchIndex>>,
    search_ready: Arc<std::sync::atomic::AtomicBool>,
    search_tx: Option<tokio::sync::mpsc::Sender<String>>,
    search_pending: Option<Arc<DashMap<String, link_indexer::PendingEntry>>>,
    suggestions_index: Arc<SuggestionsIndex>,
    suggestions_ready: Arc<std::sync::atomic::AtomicBool>,
    doc_resolver: Arc<DocumentResolver>,
    pub(crate) mcp_sessions: Arc<crate::mcp::session::SessionManager>,
    pub(crate) mcp_api_key: Option<String>,
    pub(crate) share_token_secret: Option<String>,
    /// Timestamp (epoch ms) of the most recent dirty signal from any doc.
    last_dirty_signal: Arc<AtomicU64>,
    /// Timestamp (epoch ms) of the most recent successful persist of any doc.
    last_successful_persist: Arc<AtomicU64>,
    /// Cross-channel state shared between worker supervisor and /ready endpoint.
    pub(crate) worker_status: Arc<crate::worker_status::WorkerStatusMap>,
}

/// Holds channel receivers for background workers.
/// Returned by `Server::new()`, consumed by `Server::spawn_workers()`.
pub struct WorkerReceivers {
    index_rx: Receiver<String>,
    search_rx: Option<(
        tokio::sync::mpsc::Receiver<String>,
        Arc<DashMap<String, link_indexer::PendingEntry>>,
    )>,
}

impl Server {
    pub async fn new(
        store: Option<Box<dyn Store>>,
        checkpoint_freq: Duration,
        authenticator: Option<Authenticator>,
        url: Option<Url>,
        allowed_hosts: Vec<AllowedHost>,
        cancellation_token: CancellationToken,
        doc_gc: bool,
        webhook_configs: Option<Vec<WebhookConfig>>,
    ) -> Result<(Self, WorkerReceivers)> {
        // Initialize metrics early so all senders can use them
        let metrics = RelayMetrics::new()
            .map_err(|e| anyhow!("Failed to initialize webhook metrics: {}", e))?;

        let sync_protocol_event_sender =
            Arc::new(SyncProtocolEventSender::new().with_metrics(metrics.clone()));

        let debounced_sync_sender = Arc::new(DebouncedSyncProtocolEventSender::new(
            sync_protocol_event_sender.clone(),
            metrics.clone(),
        ));

        let event_dispatcher = if let Some(configs) = webhook_configs {
            let webhook_sender = Arc::new(
                WebhookSender::new(configs.clone(), metrics.clone())
                    .map_err(|e| anyhow!("Failed to create webhook sender: {}", e))?,
            );

            let senders: Vec<Arc<dyn EventSender>> =
                vec![webhook_sender, debounced_sync_sender.clone()];

            Some(
                Arc::new(UnifiedEventDispatcher::new(senders, metrics.clone()))
                    as Arc<dyn EventDispatcher>,
            )
        } else {
            tracing::info!(
                "No webhook configs provided, creating sync protocol-only event dispatcher"
            );
            let senders: Vec<Arc<dyn EventSender>> = vec![debounced_sync_sender.clone()];
            Some(
                Arc::new(UnifiedEventDispatcher::new(senders, metrics.clone()))
                    as Arc<dyn EventDispatcher>,
            )
        };

        tracing::info!("Event dispatcher created successfully");

        let docs = Arc::new(DashMap::new());
        let doc_resolver = Arc::new(DocumentResolver::new());
        let (link_indexer, index_rx) = LinkIndexer::new();
        let link_indexer = Arc::new(link_indexer);

        // Create SearchIndex with MmapDirectory in a temp directory
        let index_path = std::env::temp_dir().join("lens-relay-search-index");
        // Clean the directory on startup to ensure a fresh index
        if index_path.exists() {
            let _ = std::fs::remove_dir_all(&index_path);
        }
        let search_index = match SearchIndex::new(&index_path) {
            Ok(si) => {
                tracing::info!("SearchIndex created at {:?}", index_path);
                Some(Arc::new(si))
            }
            Err(e) => {
                tracing::error!("Failed to create SearchIndex: {:?}", e);
                None
            }
        };
        let search_ready = Arc::new(std::sync::atomic::AtomicBool::new(false));

        // Create search channel and pending map (workers spawned later via spawn_workers)
        let (search_tx_final, search_pending_final, search_rx_for_worker) =
            if search_index.is_some() {
                let (search_tx, search_rx) = tokio::sync::mpsc::channel::<String>(1000);
                let search_pending: Arc<DashMap<String, link_indexer::PendingEntry>> =
                    Arc::new(DashMap::new());
                (
                    Some(search_tx),
                    Some(search_pending.clone()),
                    Some((search_rx, search_pending)),
                )
            } else {
                (None, None, None)
            };

        let mcp_api_key = std::env::var("MCP_API_KEY").ok();
        let share_token_secret = std::env::var("SHARE_TOKEN_SECRET").ok();
        if mcp_api_key.is_some() || share_token_secret.is_some() {
            tracing::info!("MCP endpoint enabled (MCP_API_KEY or SHARE_TOKEN_SECRET is set)");
        } else {
            tracing::info!(
                "MCP endpoint disabled (neither MCP_API_KEY nor SHARE_TOKEN_SECRET set)"
            );
        }

        let server = Self {
            docs,
            doc_worker_tracker: TaskTracker::new(),
            store: store.map(Arc::new),
            checkpoint_freq,
            authenticator,
            url,
            allowed_hosts,
            cancellation_token,
            doc_gc: std::sync::atomic::AtomicBool::new(doc_gc),
            event_dispatcher,
            sync_protocol_event_sender,
            metrics,
            link_indexer: Some(link_indexer),
            search_index,
            search_ready,
            search_tx: search_tx_final,
            search_pending: search_pending_final,
            suggestions_index: Arc::new(SuggestionsIndex::new()),
            suggestions_ready: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            doc_resolver,
            mcp_sessions: Arc::new(crate::mcp::session::SessionManager::new()),
            mcp_api_key,
            share_token_secret,
            last_dirty_signal: Arc::new(AtomicU64::new(0)),
            last_successful_persist: Arc::new(AtomicU64::new(0)),
            worker_status: Arc::new(crate::worker_status::WorkerStatusMap::new()),
        };

        let receivers = WorkerReceivers {
            index_rx,
            search_rx: search_rx_for_worker,
        };

        Ok((server, receivers))
    }

    /// Spawn background workers for link indexing and search index updates.
    /// Must be called after `startup_reindex` to avoid race conditions where
    /// workers process notifications while startup is still writing to Y.Docs.
    pub fn spawn_workers(self: &Arc<Self>, receivers: WorkerReceivers) {
        let WorkerReceivers {
            mut index_rx,
            search_rx,
        } = receivers;

        // Drain stale messages that accumulated during doc loading and startup_reindex.
        // startup_reindex already indexed everything synchronously, so these are redundant.
        let mut drained = 0usize;
        while index_rx.try_recv().is_ok() {
            drained += 1;
        }
        if drained > 0 {
            tracing::info!(
                "Drained {} stale link indexer messages from startup",
                drained
            );
        }

        // Also drain the link indexer's pending map so the worker starts clean
        if let Some(ref indexer) = self.link_indexer {
            indexer.clear_pending();
        }

        // Spawn supervised link indexing worker.
        if let Some(ref indexer) = self.link_indexer {
            let docs_for_indexer = self.docs.clone();
            let indexer_for_worker = indexer.clone();
            let resolver_for_indexer = self.doc_resolver.clone();
            let metrics_for_indexer = self.metrics.clone();
            let metrics_for_hook = self.metrics.clone();
            let status_for_indexer = self.worker_status.clone();
            let status_for_hook = self.worker_status.clone();
            let cancel_for_indexer = self.cancellation_token.clone();
            self.metrics.set_worker_alive("link_indexer", true);
            self.worker_status.register("link_indexer");
            tokio::spawn(async move {
                let outcome = crate::supervisor::supervise(
                    "link_indexer",
                    &mut index_rx,
                    |rx| {
                        let indexer = indexer_for_worker.clone();
                        let docs = docs_for_indexer.clone();
                        let resolver = resolver_for_indexer.clone();
                        Box::pin(async move { indexer.run_worker(rx, docs, resolver).await })
                    },
                    move |worker, msg, _attempt, _budget| {
                        metrics_for_hook.record_worker_panic(worker);
                        status_for_hook.record_panic("link_indexer", msg);
                        let _ = worker;
                    },
                )
                .await;
                handle_worker_outcome(
                    "link_indexer",
                    outcome,
                    &metrics_for_indexer,
                    &status_for_indexer,
                    cancel_for_indexer,
                )
                .await;
            });
        }

        // Spawn supervised search index worker.
        if let Some((mut search_rx, search_pending)) = search_rx {
            // Drain stale search messages too (startup_reindex builds the search index)
            let mut search_drained = 0usize;
            while search_rx.try_recv().is_ok() {
                search_drained += 1;
            }
            search_pending.clear();
            if search_drained > 0 {
                tracing::info!(
                    "Drained {} stale search index messages from startup",
                    search_drained
                );
            }
            if let Some(ref si) = self.search_index {
                let si_for_worker = si.clone();
                let suggestions_for_worker = self.suggestions_index.clone();
                let docs_for_search = self.docs.clone();
                let metrics_for_search = self.metrics.clone();
                let metrics_for_hook = self.metrics.clone();
                let status_for_search = self.worker_status.clone();
                let status_for_hook = self.worker_status.clone();
                let cancel_for_search = self.cancellation_token.clone();
                self.metrics.set_worker_alive("search_index", true);
                self.worker_status.register("search_index");
                tokio::spawn(async move {
                    let outcome = crate::supervisor::supervise(
                        "search_index",
                        &mut search_rx,
                        |rx| {
                            let si = si_for_worker.clone();
                            let docs = docs_for_search.clone();
                            let pending = search_pending.clone();
                            let suggestions = suggestions_for_worker.clone();
                            Box::pin(async move {
                                search_worker(rx, si, docs, pending, suggestions).await
                            })
                        },
                        move |worker, msg, _attempt, _budget| {
                            metrics_for_hook.record_worker_panic(worker);
                            status_for_hook.record_panic("search_index", msg);
                            let _ = worker;
                        },
                    )
                    .await;
                    handle_worker_outcome(
                        "search_index",
                        outcome,
                        &metrics_for_search,
                        &status_for_search,
                        cancel_for_search,
                    )
                    .await;
                });
            }
        }

        // Spawn persistence watchdog
        {
            let last_dirty = self.last_dirty_signal.clone();
            let last_persist = self.last_successful_persist.clone();
            let cancel = self.cancellation_token.clone();
            tokio::spawn(async move {
                Self::persistence_watchdog(last_dirty, last_persist, cancel).await;
            });
        }

        // Spawn periodic MCP session cleanup (prunes app sessions idle > TTL)
        {
            let sessions = self.mcp_sessions.clone();
            let cancel = self.cancellation_token.clone();
            tokio::spawn(async move {
                Self::mcp_session_cleanup_loop(sessions, cancel).await;
            });
        }

        tracing::info!("Background workers started (link indexer, search index)");
    }

    /// Periodically prune idle MCP app sessions. Runs every 5 minutes until
    /// the cancellation token fires.
    async fn mcp_session_cleanup_loop(
        sessions: Arc<crate::mcp::session::SessionManager>,
        cancellation_token: CancellationToken,
    ) {
        loop {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(5 * 60)) => {
                    sessions.cleanup_stale(crate::mcp::session::SessionManager::ttl());
                }
                _ = cancellation_token.cancelled() => {
                    tracing::info!("MCP session cleanup loop shutting down");
                    return;
                }
            }
        }
    }

    /// Monitors persistence liveness. If documents have been marked dirty but no
    /// successful persist has occurred within 10 minutes, initiates graceful shutdown.
    async fn persistence_watchdog(
        last_dirty: Arc<AtomicU64>,
        last_persist: Arc<AtomicU64>,
        cancellation_token: CancellationToken,
    ) {
        // Grace period for startup — don't trigger while docs are still loading
        tokio::time::sleep(Duration::from_secs(120)).await;

        loop {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(60)) => {},
                _ = cancellation_token.cancelled() => {
                    tracing::info!("Persistence watchdog shutting down");
                    return;
                }
            }

            let dirty_ts = last_dirty.load(AtomicOrdering::Relaxed);
            let persist_ts = last_persist.load(AtomicOrdering::Relaxed);

            // Only trigger if a dirty signal has occurred more recently than
            // the last successful persist (meaning changes are pending)
            if dirty_ts > persist_ts {
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                let stale_ms = now_ms.saturating_sub(persist_ts);

                if stale_ms > 10 * 60 * 1000 {
                    tracing::error!(
                        stale_secs = stale_ms / 1000,
                        last_dirty_ms = dirty_ts,
                        last_persist_ms = persist_ts,
                        "Persistence stalled for {}s while docs are dirty — initiating shutdown",
                        stale_ms / 1000
                    );
                    cancellation_token.cancel();

                    // Hard timeout if graceful shutdown hangs
                    tokio::time::sleep(Duration::from_secs(60)).await;
                    tracing::error!("Graceful shutdown timed out — forcing exit");
                    std::process::exit(1);
                }
            }
        }
    }

    /// Get the DocumentResolver for path-to-UUID resolution.
    pub fn doc_resolver(&self) -> &Arc<DocumentResolver> {
        &self.doc_resolver
    }

    /// List the user-facing names of all folders on this relay,
    /// deduplicated and in stable (sorted) order.
    pub fn all_folder_names(&self) -> Vec<String> {
        let mut names = std::collections::BTreeSet::new();
        for folder_doc_id in link_indexer::find_all_folder_docs(&self.docs) {
            let Some(doc_ref) = self.docs.get(&folder_doc_id) else {
                continue;
            };
            let awareness = doc_ref.awareness();
            let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
            names.insert(y_sweet_core::doc_resolver::read_folder_name(
                &guard.doc,
                &folder_doc_id,
            ));
        }
        names.into_iter().collect()
    }

    /// Resolve a folder UUID to its display name by finding any document in that folder.
    pub fn folder_name_for_uuid(&self, folder_uuid: &str) -> Option<String> {
        for folder_doc_id in link_indexer::find_all_folder_docs(&self.docs) {
            if let Some((_, fid)) = link_indexer::parse_doc_id(&folder_doc_id) {
                if fid != folder_uuid {
                    continue;
                }
                let Some(doc_ref) = self.docs.get(&folder_doc_id) else {
                    continue;
                };
                let awareness = doc_ref.awareness();
                let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
                return Some(y_sweet_core::doc_resolver::read_folder_name(
                    &guard.doc,
                    &folder_doc_id,
                ));
            }
        }

        for path in self.doc_resolver().all_paths() {
            if let Some(info) = self.doc_resolver().resolve_path(&path) {
                if let Some((_, fid)) = link_indexer::parse_doc_id(&info.folder_doc_id) {
                    if fid == folder_uuid {
                        return Some(info.folder_name.clone());
                    }
                }
            }
        }
        None
    }

    /// Get the DashMap of all loaded documents.
    pub fn docs(&self) -> &Arc<DashMap<String, DocWithSyncKv>> {
        &self.docs
    }

    /// Get the search index, if enabled.
    pub fn search_index(&self) -> &Option<Arc<SearchIndex>> {
        &self.search_index
    }

    /// Get the backing store, if configured.
    pub fn store(&self) -> &Option<Arc<Box<dyn Store>>> {
        &self.store
    }

    /// Whether the search index has finished its initial build.
    pub fn search_is_ready(&self) -> bool {
        self.search_ready.load(std::sync::atomic::Ordering::Acquire)
    }

    /// Get the link indexer, if enabled.
    pub fn link_indexer(&self) -> &Option<Arc<LinkIndexer>> {
        &self.link_indexer
    }

    /// Create a new document with content at the specified path within a folder.
    ///
    /// Handles: folder resolution, conflict checking, UUID generation, content doc
    /// creation with CriticMarkup-wrapped content, folder metadata updates,
    /// doc_resolver registration, explicit persistence, and search index update.
    pub async fn create_document(
        &self,
        folder_name: &str,
        in_folder_path: &str,
        content: &str,
        attribution: Option<&crate::mcp::provenance::AiAttribution>,
    ) -> std::result::Result<CreateDocumentResult, CreateDocumentError> {
        validate_file_path(in_folder_path)
            .map_err(|message| CreateDocumentError::BadRequest(message.to_string()))?;

        // 1. Find all folder docs, match folder_name
        let docs = self.docs();
        let folder_doc_ids = link_indexer::find_all_folder_docs(docs);
        if folder_doc_ids.is_empty() {
            return Err(CreateDocumentError::NotFound(
                "No folder documents found".into(),
            ));
        }

        let mut folder_match: Option<String> = None;
        let mut available_folders: Vec<String> = Vec::new();

        for folder_doc_id in &folder_doc_ids {
            let awareness = {
                let Some(doc_ref) = docs.get(folder_doc_id) else {
                    continue;
                };
                doc_ref.awareness() // Arc clone
            }; // DashMap shard lock released
            let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
            let name = y_sweet_core::doc_resolver::read_folder_name(&guard.doc, folder_doc_id);
            if name == folder_name {
                folder_match = Some(folder_doc_id.clone());
            }
            available_folders.push(name);
        }

        let folder_doc_id = folder_match.ok_or_else(|| {
            CreateDocumentError::NotFound(format!(
                "Unknown folder '{}'. Available folders: {}",
                folder_name,
                available_folders.join(", ")
            ))
        })?;

        // 2. Check path doesn't already exist in filemeta_v0
        {
            let awareness = {
                let Some(doc_ref) = docs.get(&folder_doc_id) else {
                    return Err(CreateDocumentError::Internal(
                        "Folder doc not loaded".into(),
                    ));
                };
                doc_ref.awareness() // Arc clone
            }; // DashMap shard lock released
            let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
            let txn = guard.doc.transact();
            if let Some(filemeta) = txn.get_map("filemeta_v0") {
                if filemeta.get(&txn, in_folder_path).is_some() {
                    return Err(CreateDocumentError::Conflict(format!(
                        "Path '{}' already exists in folder '{}'",
                        in_folder_path, folder_name
                    )));
                }
            }
        }

        // 3. Generate UUID v4 and compute full_doc_id
        let uuid = uuid::Uuid::new_v4().to_string();
        let relay_id = link_indexer::parse_doc_id(&folder_doc_id)
            .map(|(r, _)| r.to_string())
            .unwrap_or_default();

        let full_doc_id = if relay_id.is_empty() {
            uuid.clone()
        } else {
            format!("{}-{}", relay_id, uuid)
        };

        // 4. Create content doc on server
        self.get_or_create_doc(&full_doc_id).await.map_err(|e| {
            CreateDocumentError::Internal(format!("Failed to create content doc: {}", e))
        })?;

        // 5. Write initial CriticMarkup-wrapped content to content doc
        {
            let awareness = {
                let doc_ref = docs.get(&full_doc_id).ok_or_else(|| {
                    CreateDocumentError::Internal("Content doc not loaded after creation".into())
                })?;
                doc_ref.awareness() // Arc clone
            }; // DashMap shard lock released
            let guard = awareness.write().unwrap_or_else(|e| e.into_inner());
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;
            let wrapped = format!(
                "{{++{{\"author\":\"AI\",\"timestamp\":{}}}@@{}++}}",
                timestamp, content
            );
            match attribution {
                Some(attr) => crate::mcp::provenance::apply_attributed_edit(
                    &guard.doc,
                    attr.client_id,
                    &attr.actor,
                    timestamp,
                    |txn, text| text.insert(txn, 0, &wrapped),
                )
                .map_err(CreateDocumentError::Internal)?,
                None => {
                    let mut txn = guard.doc.transact_mut();
                    let text = txn.get_or_insert_text("contents");
                    text.insert(&mut txn, 0, &wrapped);
                }
            }
        }

        // 6. Write folder metadata (filemeta_v0 + legacy docs map)
        {
            let awareness = {
                let doc_ref = docs
                    .get(&folder_doc_id)
                    .ok_or_else(|| CreateDocumentError::Internal("Folder doc not loaded".into()))?;
                doc_ref.awareness() // Arc clone
            }; // DashMap shard lock released
            let guard = awareness.write().unwrap_or_else(|e| e.into_inner());
            let mut txn = guard.doc.transact_mut_with("mcp");

            let filemeta = txn.get_or_insert_map("filemeta_v0");
            let docs_map = txn.get_or_insert_map("docs");

            // Create intermediate folder entries for nested paths
            let ancestors_created = link_indexer::ensure_ancestor_folders(
                &filemeta,
                &docs_map,
                &mut txn,
                in_folder_path,
            );
            if ancestors_created > 0 {
                tracing::info!(
                    "Created {} ancestor folder entries for path {}",
                    ancestors_created,
                    in_folder_path
                );
            }

            let mut map = std::collections::HashMap::new();
            map.insert("id".to_string(), yrs::Any::String(uuid.clone().into()));
            map.insert("type".to_string(), yrs::Any::String("markdown".into()));
            map.insert("version".to_string(), yrs::Any::Number(0.0));
            filemeta.insert(&mut txn, in_folder_path, yrs::Any::Map(map.into()));
            docs_map.insert(
                &mut txn,
                in_folder_path,
                yrs::Any::String(uuid.clone().into()),
            );
        }

        // 7. Update doc_resolver
        let file_path = format!("{}{}", folder_name, in_folder_path);
        self.doc_resolver().upsert_doc(
            &uuid,
            &file_path,
            y_sweet_core::doc_resolver::DocInfo {
                uuid: uuid.clone(),
                relay_id: relay_id.clone(),
                folder_doc_id: folder_doc_id.clone(),
                folder_name: folder_name.to_string(),
                doc_id: full_doc_id.clone(),
                hash: None,
            },
        );

        // 8. Explicit persist for immediate durability (content + folder docs)
        {
            let content_sync_kv = docs.get(&full_doc_id).map(|r| r.sync_kv());
            let folder_sync_kv = docs.get(&folder_doc_id).map(|r| r.sync_kv());
            // DashMap shard locks released; safe to .await
            if let Some(sync_kv) = content_sync_kv {
                if let Err(e) = sync_kv.persist().await {
                    tracing::error!("Failed to persist content doc {}: {:?}", full_doc_id, e);
                }
            }
            if let Some(sync_kv) = folder_sync_kv {
                if let Err(e) = sync_kv.persist().await {
                    tracing::error!("Failed to persist folder doc {}: {:?}", folder_doc_id, e);
                }
            }
        }

        // 9. Update search index
        if let Some(ref search_index) = self.search_index {
            search_handle_content_update(
                &full_doc_id,
                &self.docs,
                search_index,
                &self.suggestions_index,
            );
        }

        tracing::info!(
            "Document created: {} at {}{} (doc_id: {})",
            uuid,
            folder_name,
            in_folder_path,
            full_doc_id,
        );

        Ok(CreateDocumentResult {
            uuid,
            full_doc_id,
            folder_name: folder_name.to_string(),
            in_folder_path: in_folder_path.to_string(),
        })
    }

    /// Create a document with direct content write (no CriticMarkup wrapping).
    /// Used by internal HTTP API for programmatic document creation.
    /// Accepts any file extension; uses "file" type for non-.md, "markdown" for .md.
    pub async fn create_document_direct(
        &self,
        folder_name: &str,
        in_folder_path: &str,
        content: &str,
        attribution: Option<&crate::mcp::provenance::AiAttribution>,
    ) -> std::result::Result<CreateDocumentResult, CreateDocumentError> {
        validate_file_path(in_folder_path)
            .map_err(|message| CreateDocumentError::BadRequest(message.to_string()))?;

        // 1. Find all folder docs, match folder_name
        let docs = self.docs();
        let folder_doc_ids = link_indexer::find_all_folder_docs(docs);
        if folder_doc_ids.is_empty() {
            return Err(CreateDocumentError::NotFound(
                "No folder documents found".into(),
            ));
        }

        let mut folder_match: Option<String> = None;
        let mut available_folders: Vec<String> = Vec::new();

        for folder_doc_id in &folder_doc_ids {
            let awareness = {
                let Some(doc_ref) = docs.get(folder_doc_id) else {
                    continue;
                };
                doc_ref.awareness() // Arc clone
            }; // DashMap shard lock released
            let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
            let name = y_sweet_core::doc_resolver::read_folder_name(&guard.doc, folder_doc_id);
            if name == folder_name {
                folder_match = Some(folder_doc_id.clone());
            }
            available_folders.push(name);
        }

        let folder_doc_id = folder_match.ok_or_else(|| {
            CreateDocumentError::NotFound(format!(
                "Unknown folder '{}'. Available folders: {}",
                folder_name,
                available_folders.join(", ")
            ))
        })?;

        // 2. Check path doesn't already exist in filemeta_v0
        {
            let awareness = {
                let Some(doc_ref) = docs.get(&folder_doc_id) else {
                    return Err(CreateDocumentError::Internal(
                        "Folder doc not loaded".into(),
                    ));
                };
                doc_ref.awareness() // Arc clone
            }; // DashMap shard lock released
            let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
            let txn = guard.doc.transact();
            if let Some(filemeta) = txn.get_map("filemeta_v0") {
                if filemeta.get(&txn, in_folder_path).is_some() {
                    return Err(CreateDocumentError::Conflict(format!(
                        "Path '{}' already exists in folder '{}'",
                        in_folder_path, folder_name
                    )));
                }
            }
        }

        // 3. Generate UUID v4 and compute full_doc_id
        let uuid = uuid::Uuid::new_v4().to_string();
        let relay_id = link_indexer::parse_doc_id(&folder_doc_id)
            .map(|(r, _)| r.to_string())
            .unwrap_or_default();

        let full_doc_id = if relay_id.is_empty() {
            uuid.clone()
        } else {
            format!("{}-{}", relay_id, uuid)
        };

        // 4. Create content doc on server
        self.get_or_create_doc(&full_doc_id).await.map_err(|e| {
            CreateDocumentError::Internal(format!("Failed to create content doc: {}", e))
        })?;

        // 5. Write content directly (no CriticMarkup wrapping)
        {
            let awareness = {
                let doc_ref = docs.get(&full_doc_id).ok_or_else(|| {
                    CreateDocumentError::Internal("Content doc not loaded after creation".into())
                })?;
                doc_ref.awareness() // Arc clone
            }; // DashMap shard lock released
            let guard = awareness.write().unwrap_or_else(|e| e.into_inner());
            match attribution {
                Some(attr) => {
                    let timestamp = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_millis() as u64;
                    crate::mcp::provenance::apply_attributed_edit(
                        &guard.doc,
                        attr.client_id,
                        &attr.actor,
                        timestamp,
                        |txn, text| text.insert(txn, 0, content),
                    )
                    .map_err(CreateDocumentError::Internal)?
                }
                None => {
                    let mut txn = guard.doc.transact_mut();
                    let text = txn.get_or_insert_text("contents");
                    text.insert(&mut txn, 0, content);
                }
            }
        }

        // 6. Write folder metadata (filemeta_v0; legacy docs map only for markdown)
        let file_type = if in_folder_path.ends_with(".md") {
            "markdown"
        } else {
            "file"
        };
        {
            let awareness = {
                let doc_ref = docs
                    .get(&folder_doc_id)
                    .ok_or_else(|| CreateDocumentError::Internal("Folder doc not loaded".into()))?;
                doc_ref.awareness() // Arc clone
            }; // DashMap shard lock released
            let guard = awareness.write().unwrap_or_else(|e| e.into_inner());
            let mut txn = guard.doc.transact_mut_with("api");

            let filemeta = txn.get_or_insert_map("filemeta_v0");
            let docs_map = txn.get_or_insert_map("docs");

            // Create intermediate folder entries for nested paths
            let ancestors_created = link_indexer::ensure_ancestor_folders(
                &filemeta,
                &docs_map,
                &mut txn,
                in_folder_path,
            );
            if ancestors_created > 0 {
                tracing::info!(
                    "Created {} ancestor folder entries for path {}",
                    ancestors_created,
                    in_folder_path
                );
            }

            let mut map = std::collections::HashMap::new();
            map.insert("id".to_string(), yrs::Any::String(uuid.clone().into()));
            map.insert("type".to_string(), yrs::Any::String(file_type.into()));
            map.insert("version".to_string(), yrs::Any::Number(0.0));
            filemeta.insert(&mut txn, in_folder_path, yrs::Any::Map(map.into()));
            // Only write legacy docs map for markdown files (Obsidian compat)
            if file_type == "markdown" {
                docs_map.insert(
                    &mut txn,
                    in_folder_path,
                    yrs::Any::String(uuid.clone().into()),
                );
            }
        }

        // 7. Update doc_resolver
        let file_path = format!("{}{}", folder_name, in_folder_path);
        self.doc_resolver().upsert_doc(
            &uuid,
            &file_path,
            y_sweet_core::doc_resolver::DocInfo {
                uuid: uuid.clone(),
                relay_id: relay_id.clone(),
                folder_doc_id: folder_doc_id.clone(),
                folder_name: folder_name.to_string(),
                doc_id: full_doc_id.clone(),
                hash: None,
            },
        );

        // 8. Explicit persist for immediate durability (content + folder docs)
        {
            let content_sync_kv = docs.get(&full_doc_id).map(|r| r.sync_kv());
            let folder_sync_kv = docs.get(&folder_doc_id).map(|r| r.sync_kv());
            // DashMap shard locks released; safe to .await
            if let Some(sync_kv) = content_sync_kv {
                if let Err(e) = sync_kv.persist().await {
                    tracing::error!("Failed to persist content doc {}: {:?}", full_doc_id, e);
                }
            }
            if let Some(sync_kv) = folder_sync_kv {
                if let Err(e) = sync_kv.persist().await {
                    tracing::error!("Failed to persist folder doc {}: {:?}", folder_doc_id, e);
                }
            }
        }

        // 9. Update search index
        if let Some(ref search_index) = self.search_index {
            search_handle_content_update(
                &full_doc_id,
                &self.docs,
                search_index,
                &self.suggestions_index,
            );
        }

        tracing::info!(
            "Document created (direct): {} at {}{} (doc_id: {}, type: {})",
            uuid,
            folder_name,
            in_folder_path,
            full_doc_id,
            file_type,
        );

        Ok(CreateDocumentResult {
            uuid,
            full_doc_id,
            folder_name: folder_name.to_string(),
            in_folder_path: in_folder_path.to_string(),
        })
    }

    /// Replace the full content of an existing document's Y.Text.
    /// Used for programmatic content updates (no CriticMarkup, no diff).
    pub async fn write_document_content(
        &self,
        folder_name: &str,
        in_folder_path: &str,
        content: &str,
    ) -> std::result::Result<(), CreateDocumentError> {
        // 1. Find the folder doc
        let docs = self.docs();
        let folder_doc_ids = link_indexer::find_all_folder_docs(docs);
        if folder_doc_ids.is_empty() {
            return Err(CreateDocumentError::NotFound(
                "No folder documents found".into(),
            ));
        }

        let mut folder_match: Option<String> = None;
        for folder_doc_id in &folder_doc_ids {
            let awareness = {
                let Some(doc_ref) = docs.get(folder_doc_id) else {
                    continue;
                };
                doc_ref.awareness()
            }; // DashMap shard lock released
            let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
            let name = y_sweet_core::doc_resolver::read_folder_name(&guard.doc, folder_doc_id);
            if name == folder_name {
                folder_match = Some(folder_doc_id.clone());
                break;
            }
        }

        let folder_doc_id = folder_match.ok_or_else(|| {
            CreateDocumentError::NotFound(format!("Unknown folder '{}'", folder_name))
        })?;

        // 2. Look up doc_id from filemeta_v0
        let uuid = {
            let awareness = {
                let Some(doc_ref) = docs.get(&folder_doc_id) else {
                    return Err(CreateDocumentError::Internal(
                        "Folder doc not loaded".into(),
                    ));
                };
                doc_ref.awareness()
            }; // DashMap shard lock released
            let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
            let txn = guard.doc.transact();
            let filemeta = txn.get_map("filemeta_v0").ok_or_else(|| {
                CreateDocumentError::NotFound(format!(
                    "Path '{}' not found in folder '{}'",
                    in_folder_path, folder_name
                ))
            })?;
            let value = filemeta.get(&txn, in_folder_path).ok_or_else(|| {
                CreateDocumentError::NotFound(format!(
                    "Path '{}' not found in folder '{}'",
                    in_folder_path, folder_name
                ))
            })?;
            link_indexer::extract_id_from_filemeta_entry(&value, &txn).ok_or_else(|| {
                CreateDocumentError::Internal(format!(
                    "Could not extract doc id for path '{}'",
                    in_folder_path
                ))
            })?
        };

        // 3. Compute full_doc_id
        let relay_id = link_indexer::parse_doc_id(&folder_doc_id)
            .map(|(r, _)| r.to_string())
            .unwrap_or_default();
        let full_doc_id = if relay_id.is_empty() {
            uuid.clone()
        } else {
            format!("{}-{}", relay_id, uuid)
        };

        // Ensure the content doc is loaded
        self.ensure_doc_loaded(&full_doc_id).await.map_err(|e| {
            CreateDocumentError::Internal(format!("Failed to load content doc: {}", e))
        })?;

        // 4. Clear Y.Text and write new content
        {
            let awareness = {
                let doc_ref = docs.get(&full_doc_id).ok_or_else(|| {
                    CreateDocumentError::Internal("Content doc not loaded".into())
                })?;
                doc_ref.awareness()
            }; // DashMap shard lock released
            let guard = awareness.write().unwrap_or_else(|e| e.into_inner());
            let mut txn = guard.doc.transact_mut_with("api");
            let text = txn.get_or_insert_text("contents");
            let len = text.len(&txn);
            if len > 0 {
                text.remove_range(&mut txn, 0, len);
            }
            text.insert(&mut txn, 0, content);
        }

        // 5. Persist
        {
            let sync_kv = docs.get(&full_doc_id).map(|r| r.sync_kv());
            if let Some(sync_kv) = sync_kv {
                if let Err(e) = sync_kv.persist().await {
                    tracing::error!("Failed to persist content doc {}: {:?}", full_doc_id, e);
                }
            }
        }

        // 6. Update search index
        if let Some(ref search_index) = self.search_index {
            search_handle_content_update(
                &full_doc_id,
                &self.docs,
                search_index,
                &self.suggestions_index,
            );
        }

        tracing::info!(
            "Document content updated (direct): {}{} (doc_id: {})",
            folder_name,
            in_folder_path,
            full_doc_id,
        );

        Ok(())
    }

    /// Update the hash field in filemeta_v0 for an existing blob file.
    ///
    /// This removes the old `Any::Map` entry and re-inserts it with the updated hash,
    /// since `Any::Map` entries are opaque and cannot be mutated in place.
    pub async fn update_blob_hash(
        &self,
        folder_doc_id: &str,
        file_path: &str,
        new_hash: &str,
    ) -> std::result::Result<(), String> {
        // Extract in_folder_path: strip folder name prefix to get "/data.json"
        let slash_pos = file_path.find('/').ok_or("Invalid file path")?;
        let in_folder_path = &file_path[slash_pos..];

        // Update filemeta in a scoped block so borrows are released before persist
        {
            let awareness = {
                let doc_ref = self
                    .docs()
                    .get(folder_doc_id)
                    .ok_or("Folder doc not loaded")?;
                doc_ref.awareness()
            };
            let guard = awareness.write().unwrap_or_else(|e| e.into_inner());
            let mut txn = guard.doc.transact_mut_with("mcp");
            let filemeta = txn.get_or_insert_map("filemeta_v0");

            // Read the existing Any::Map entry, update hash, and re-insert
            if let Some(yrs::Out::Any(yrs::Any::Map(old_map))) = filemeta.get(&txn, in_folder_path)
            {
                let mut new_map = std::collections::HashMap::new();
                for (k, v) in old_map.iter() {
                    if k == "hash" {
                        new_map.insert(k.to_string(), yrs::Any::String(new_hash.into()));
                    } else {
                        new_map.insert(k.to_string(), v.clone());
                    }
                }
                filemeta.insert(&mut txn, in_folder_path, yrs::Any::Map(new_map.into()));
            } else {
                return Err(format!("Filemeta entry not found for {}", in_folder_path));
            }
        }

        // Persist folder doc
        {
            let folder_sync_kv = self.docs().get(folder_doc_id).map(|r| r.sync_kv());
            if let Some(sync_kv) = folder_sync_kv {
                if let Err(e) = sync_kv.persist().await {
                    tracing::error!("Failed to persist folder doc {}: {:?}", folder_doc_id, e);
                }
            }
        }

        Ok(())
    }

    /// Create a new blob (non-Y.Doc) file at the specified path within a folder.
    ///
    /// Unlike `create_document`, this does NOT create a Y.Doc or wrap content in
    /// CriticMarkup. Instead it writes raw bytes to the object store and records a
    /// "file" entry (with hash) in filemeta_v0. The file is NOT added to the legacy
    /// "docs" map (only markdown documents go there for Obsidian compatibility).
    pub async fn create_blob_file(
        &self,
        folder_name: &str,
        in_folder_path: &str,
        data: &[u8],
        mimetype: &str,
    ) -> std::result::Result<CreateDocumentResult, CreateDocumentError> {
        validate_file_path(in_folder_path)
            .map_err(|message| CreateDocumentError::BadRequest(message.to_string()))?;

        // 1. Find folder doc (same logic as create_document)
        let docs = self.docs();
        let folder_doc_ids = link_indexer::find_all_folder_docs(docs);
        if folder_doc_ids.is_empty() {
            return Err(CreateDocumentError::NotFound(
                "No folder documents found".into(),
            ));
        }

        let mut folder_match: Option<String> = None;
        let mut available_folders: Vec<String> = Vec::new();

        for folder_doc_id in &folder_doc_ids {
            let awareness = {
                let Some(doc_ref) = docs.get(folder_doc_id) else {
                    continue;
                };
                doc_ref.awareness()
            };
            let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
            let name = y_sweet_core::doc_resolver::read_folder_name(&guard.doc, folder_doc_id);
            if name == folder_name {
                folder_match = Some(folder_doc_id.clone());
                break;
            }
            available_folders.push(name);
        }

        let folder_doc_id = folder_match.ok_or_else(|| {
            CreateDocumentError::NotFound(format!(
                "Folder '{}' not found. Available: {:?}",
                folder_name, available_folders
            ))
        })?;

        // 2. Check path doesn't already exist
        {
            let awareness = {
                let Some(doc_ref) = docs.get(&folder_doc_id) else {
                    return Err(CreateDocumentError::Internal(
                        "Folder doc not loaded".into(),
                    ));
                };
                doc_ref.awareness()
            };
            let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
            let txn = guard.doc.transact();
            if let Some(filemeta) = txn.get_map("filemeta_v0") {
                if filemeta.get(&txn, in_folder_path).is_some() {
                    return Err(CreateDocumentError::Conflict(format!(
                        "Path '{}' already exists in folder '{}'",
                        in_folder_path, folder_name
                    )));
                }
            }
        }

        // 3. Generate UUID and compute full_doc_id
        let uuid = uuid::Uuid::new_v4().to_string();
        let relay_id = link_indexer::parse_doc_id(&folder_doc_id)
            .map(|(r, _)| r.to_string())
            .unwrap_or_default();
        let full_doc_id = if relay_id.is_empty() {
            uuid.clone()
        } else {
            format!("{}-{}", relay_id, uuid)
        };

        // 4. Write blob to store
        let store = self
            .store()
            .as_ref()
            .ok_or_else(|| CreateDocumentError::Internal("No store configured".to_string()))?;
        let hash = crate::mcp::tools::blob::sha256_hex(data);
        let key = format!("files/{}/{}", full_doc_id, hash);
        store
            .set(&key, data.to_vec())
            .await
            .map_err(|e| CreateDocumentError::Internal(format!("Store write error: {}", e)))?;

        // 5. Update filemeta_v0 (type "file" with hash, no legacy docs entry)
        {
            let awareness = {
                let doc_ref = docs
                    .get(&folder_doc_id)
                    .ok_or_else(|| CreateDocumentError::Internal("Folder doc not loaded".into()))?;
                doc_ref.awareness()
            };
            let guard = awareness.write().unwrap_or_else(|e| e.into_inner());
            let mut txn = guard.doc.transact_mut_with("mcp");

            let filemeta = txn.get_or_insert_map("filemeta_v0");
            let docs_map = txn.get_or_insert_map("docs");

            link_indexer::ensure_ancestor_folders(&filemeta, &docs_map, &mut txn, in_folder_path);

            // Images are registered as "image" so clients render them as inline
            // embeds; other blobs use the generic "file" type.
            let file_type = if mimetype.starts_with("image/") {
                "image"
            } else {
                "file"
            };
            let mut map = std::collections::HashMap::new();
            map.insert("id".to_string(), yrs::Any::String(uuid.clone().into()));
            map.insert("type".to_string(), yrs::Any::String(file_type.into()));
            map.insert("version".to_string(), yrs::Any::Number(0.0));
            map.insert("hash".to_string(), yrs::Any::String(hash.clone().into()));
            map.insert("mimetype".to_string(), yrs::Any::String(mimetype.into()));
            map.insert(
                "synctime".to_string(),
                yrs::Any::Number(
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as f64,
                ),
            );
            filemeta.insert(&mut txn, in_folder_path, yrs::Any::Map(map.into()));
            // Note: do NOT add to legacy "docs" map — only markdown docs go there
        }

        // 6. Update doc_resolver
        let file_path = format!("{}{}", folder_name, in_folder_path);
        self.doc_resolver().upsert_doc(
            &uuid,
            &file_path,
            y_sweet_core::doc_resolver::DocInfo {
                uuid: uuid.clone(),
                relay_id: relay_id.clone(),
                folder_doc_id: folder_doc_id.clone(),
                folder_name: folder_name.to_string(),
                doc_id: full_doc_id.clone(),
                hash: Some(hash),
            },
        );

        // 7. Persist folder doc
        {
            let folder_sync_kv = docs.get(&folder_doc_id).map(|r| r.sync_kv());
            if let Some(sync_kv) = folder_sync_kv {
                if let Err(e) = sync_kv.persist().await {
                    tracing::error!("Failed to persist folder doc {}: {:?}", folder_doc_id, e);
                }
            }
        }

        tracing::info!(
            "Blob file created: {} at {}{} (doc_id: {})",
            uuid,
            folder_name,
            in_folder_path,
            full_doc_id,
        );

        Ok(CreateDocumentResult {
            uuid,
            full_doc_id,
            folder_name: folder_name.to_string(),
            in_folder_path: in_folder_path.to_string(),
        })
    }

    /// Move a document to a new path within or across folders.
    ///
    /// This is the shared implementation used by both the HTTP handler and MCP tool.
    /// It handles: validation, metadata gathering, pre-loading backlinker docs from
    /// storage, acquiring locks, calling link_indexer::move_document(), persisting
    /// mutated docs, updating search index, and notifying the link indexer.
    pub async fn move_document(
        &self,
        uuid: &str,
        new_path: &str,
        target_folder: Option<&str>,
    ) -> std::result::Result<link_indexer::MoveResult, MoveDocumentError> {
        validate_file_path(new_path)
            .map_err(|message| MoveDocumentError::BadRequest(message.to_string()))?;

        // Validate new_path format
        if !new_path.starts_with('/') {
            return Err(MoveDocumentError::BadRequest(
                "new_path must start with '/'".into(),
            ));
        }
        if !new_path.ends_with(".md") {
            return Err(MoveDocumentError::BadRequest(
                "new_path must end with '.md'".into(),
            ));
        }

        // Sync block 1: Gather metadata from folder docs.
        // Non-Send guards must not cross .await points, so we extract owned data here.
        let (folder_doc_ids, source_folder_doc_id, target_folder_doc_id, relay_id, needed_uuids) = {
            let docs = &self.docs;

            // 1. Find all folder doc IDs
            let folder_doc_ids = link_indexer::find_all_folder_docs(docs);
            if folder_doc_ids.is_empty() {
                return Err(MoveDocumentError::NotFound(
                    "No folder documents found".into(),
                ));
            }

            // 2. Find which folder doc contains the UUID, and read folder names.
            let mut source_folder_doc_id: Option<String> = None;
            let mut folder_names: Vec<(String, String)> = Vec::new();

            for folder_doc_id in &folder_doc_ids {
                let awareness = {
                    let Some(doc_ref) = docs.get(folder_doc_id) else {
                        continue;
                    };
                    doc_ref.awareness() // Arc clone
                }; // DashMap shard lock released
                let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
                let folder_name =
                    y_sweet_core::doc_resolver::read_folder_name(&guard.doc, folder_doc_id);
                folder_names.push((folder_doc_id.clone(), folder_name));

                // Check if this folder contains the UUID
                let txn = guard.doc.transact();
                if let Some(filemeta) = txn.get_map("filemeta_v0") {
                    for (_path, value) in filemeta.iter(&txn) {
                        if let Some(id) = link_indexer::extract_id_from_filemeta_entry(&value, &txn)
                        {
                            if id == uuid {
                                source_folder_doc_id = Some(folder_doc_id.clone());
                                break;
                            }
                        }
                    }
                }
            }

            let source_folder_doc_id = source_folder_doc_id.ok_or_else(|| {
                MoveDocumentError::NotFound(format!(
                    "UUID {} not found in any folder document",
                    uuid
                ))
            })?;

            // 3. Determine target folder doc ID
            let target_folder_doc_id = if let Some(target_name) = target_folder {
                let found = folder_names
                    .iter()
                    .find(|(_, name)| name == target_name)
                    .map(|(id, _)| id.clone());
                found.ok_or_else(|| {
                    MoveDocumentError::BadRequest(format!(
                        "Target folder '{}' not found",
                        target_name
                    ))
                })?
            } else {
                source_folder_doc_id.clone()
            };

            // 4. Check if new_path already exists in target folder doc
            {
                let awareness = {
                    let Some(doc_ref) = docs.get(&target_folder_doc_id) else {
                        return Err(MoveDocumentError::Internal(
                            "Target folder doc not loaded".into(),
                        ));
                    };
                    doc_ref.awareness() // Arc clone
                }; // DashMap shard lock released
                let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
                let txn = guard.doc.transact();
                if let Some(filemeta) = txn.get_map("filemeta_v0") {
                    if filemeta.get(&txn, new_path).is_some() {
                        return Err(MoveDocumentError::Conflict(format!(
                            "Path '{}' already exists in target folder",
                            new_path
                        )));
                    }
                }
            }

            // 5. Collect only the needed content UUIDs: backlinkers + the moved doc itself.
            let mut needed_uuids: Vec<String> = vec![uuid.to_string()];
            for folder_doc_id in &folder_doc_ids {
                let awareness = {
                    let Some(doc_ref) = docs.get(folder_doc_id) else {
                        continue;
                    };
                    doc_ref.awareness() // Arc clone
                }; // DashMap shard lock released
                let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
                let txn = guard.doc.transact();

                if let Some(backlinks) = txn.get_map("backlinks_v0") {
                    for bl_uuid in link_indexer::read_backlinks_array(&backlinks, &txn, uuid) {
                        if !needed_uuids.contains(&bl_uuid) {
                            needed_uuids.push(bl_uuid);
                        }
                    }
                }
            }

            // 6. Find the relay_id prefix from the source folder doc
            let relay_id = link_indexer::parse_doc_id(&source_folder_doc_id)
                .map(|(r, _)| r.to_string())
                .unwrap_or_default();

            (
                folder_doc_ids,
                source_folder_doc_id,
                target_folder_doc_id,
                relay_id,
                needed_uuids,
            )
        }; // All DashMap refs and awareness guards dropped here

        // Helper: prefix a UUID with the relay_id to form a content doc ID.
        let to_content_id = |uuid: &str| -> String {
            if relay_id.is_empty() {
                uuid.to_string()
            } else {
                format!("{}-{}", relay_id, uuid)
            }
        };

        // Pre-load backlinker + moved docs from storage if not already in DashMap.
        for uuid in &needed_uuids {
            let content_id = to_content_id(uuid);
            if !self.docs.contains_key(&content_id) {
                if let Err(e) = self.load_doc(&content_id, None).await {
                    tracing::warn!(
                        "Failed to load backlinker doc {} from storage: {:?}",
                        content_id,
                        e
                    );
                }
            }
        }

        // Sync block 2: Clone Arcs out of DashMap, then acquire write locks.
        // Phase 1: Extract awareness Arcs and sync_kv Arcs from DashMap refs.
        let (
            folder_awareness,
            folder_sync_kvs,
            content_doc_ids,
            content_awareness,
            content_sync_kvs,
        ) = {
            let docs = &self.docs;

            let (folder_awareness, folder_sync_kvs): (Vec<_>, Vec<_>) = folder_doc_ids
                .iter()
                .filter_map(|id| {
                    let doc_ref = docs.get(id)?;
                    Some((doc_ref.awareness(), doc_ref.sync_kv()))
                })
                .unzip();

            let mut content_doc_ids: Vec<String> =
                needed_uuids.iter().map(|u| to_content_id(u)).collect();
            // Sort to ensure consistent lock ordering across concurrent calls,
            // preventing ABBA deadlocks when acquiring awareness write locks.
            content_doc_ids.sort();

            let (content_awareness, content_sync_kvs): (Vec<_>, Vec<_>) = content_doc_ids
                .iter()
                .filter_map(|id| {
                    let doc_ref = docs.get(id)?;
                    Some((doc_ref.awareness(), doc_ref.sync_kv()))
                })
                .unzip();

            (
                folder_awareness,
                folder_sync_kvs,
                content_doc_ids,
                content_awareness,
                content_sync_kvs,
            )
        }; // All DashMap shard locks released

        // Phase 2: Acquire awareness write locks (no DashMap guards held).
        let result = {
            let doc_resolver = self.doc_resolver.clone();

            let folder_guards: Vec<_> = folder_awareness
                .iter()
                .map(|a| a.write().unwrap_or_else(|e| e.into_inner()))
                .collect();

            let folder_doc_refs: Vec<&yrs::Doc> = folder_guards.iter().map(|g| &g.doc).collect();
            let folder_name_strings: Vec<String> = folder_doc_ids
                .iter()
                .zip(folder_guards.iter())
                .map(|(id, g)| y_sweet_core::doc_resolver::read_folder_name(&g.doc, id))
                .collect();
            let folder_name_refs: Vec<&str> =
                folder_name_strings.iter().map(|s| s.as_str()).collect();

            let source_idx = folder_doc_ids
                .iter()
                .position(|id| id == &source_folder_doc_id)
                .ok_or_else(|| {
                    MoveDocumentError::Internal("Source folder doc not in folder list".into())
                })?;
            let target_idx = folder_doc_ids
                .iter()
                .position(|id| id == &target_folder_doc_id)
                .ok_or_else(|| {
                    MoveDocumentError::Internal("Target folder doc not in folder list".into())
                })?;

            let content_guards: Vec<_> = content_awareness
                .iter()
                .map(|a| a.write().unwrap_or_else(|e| e.into_inner()))
                .collect();

            let mut content_docs: std::collections::HashMap<String, &yrs::Doc> =
                std::collections::HashMap::new();
            for (i, guard) in content_guards.iter().enumerate() {
                let doc_id = &content_doc_ids[i];
                if let Some((_r, u)) = link_indexer::parse_doc_id(doc_id) {
                    content_docs.insert(u.to_string(), &guard.doc);
                }
            }

            link_indexer::move_document(
                uuid,
                new_path,
                folder_doc_refs[source_idx],
                folder_doc_refs[target_idx],
                &folder_doc_refs,
                &folder_name_refs,
                &doc_resolver,
                &content_docs,
            )
            .map_err(|e| MoveDocumentError::Internal(e.to_string()))?
        }; // All awareness write guards dropped here

        // Persist all mutated folder docs and content docs
        for sync_kv in &folder_sync_kvs {
            if let Err(e) = sync_kv.persist().await {
                tracing::error!("Failed to persist folder doc after move: {:?}", e);
            }
        }
        for sync_kv in &content_sync_kvs {
            if let Err(e) = sync_kv.persist().await {
                tracing::error!("Failed to persist content doc after move: {:?}", e);
            }
        }

        // Update search index for the moved document
        if let Some(ref search_index) = self.search_index {
            let content_doc_id = to_content_id(uuid);
            search_handle_content_update(
                &content_doc_id,
                &self.docs,
                search_index,
                &self.suggestions_index,
            );
        }

        // Trigger link indexer on_document_update for folder docs
        // so background worker picks up the filemeta change
        if let Some(ref indexer) = self.link_indexer {
            indexer.on_document_update(&source_folder_doc_id).await;
            if source_folder_doc_id != target_folder_doc_id {
                indexer.on_document_update(&target_folder_doc_id).await;
            }
        }

        tracing::info!(
            "Document {} moved: {} -> {} (folder: {} -> {}, {} links rewritten)",
            uuid,
            result.old_path,
            result.new_path,
            result.old_folder_name,
            result.new_folder_name,
            result.links_rewritten,
        );

        Ok(result)
    }

    /// Move a markdown document, rename a metadata-only folder, or rename a
    /// non-markdown file metadata entry by user-facing path.
    pub async fn move_path(
        &self,
        path: &str,
        new_path: &str,
        target_folder: Option<&str>,
    ) -> std::result::Result<link_indexer::MoveResult, MoveDocumentError> {
        validate_file_path(new_path)
            .map_err(|message| MoveDocumentError::BadRequest(message.to_string()))?;

        if !new_path.starts_with('/') {
            return Err(MoveDocumentError::BadRequest(
                "new_path must start with '/'".into(),
            ));
        }

        // The in-memory doc_resolver is eventually consistent — kept current by
        // the link-indexer worker — so a freshly-created file can be present in
        // filemeta_v0 (the source of truth) before the resolver knows it. A
        // resolver miss must not turn a file rename into a folder move (which
        // rejects ".md" destinations with the observed "Move failed: 400"), so
        // on a miss we resolve directly from filemeta_v0.
        // See move_path_renames_file_missing_from_stale_resolver.
        let resolved = self
            .doc_resolver()
            .resolve_path(path)
            .or_else(|| self.resolve_move_path_fallback(path, new_path));

        if let Some(info) = resolved {
            let source_type = self
                .filemeta_type_for_uuid(&info.uuid)
                .unwrap_or_else(|| "markdown".to_string());
            match source_type.as_str() {
                "markdown" => {
                    return self
                        .move_document(&info.uuid, new_path, target_folder)
                        .await;
                }
                "folder" => {
                    return self.move_folder_path(path, new_path, target_folder).await;
                }
                _ => {
                    return self
                        .move_filemeta_entry_path(path, new_path, target_folder, &info)
                        .await;
                }
            }
        }

        self.move_folder_path(path, new_path, target_folder).await
    }

    /// Resolve a user-facing path to a [`DocInfo`] by scanning loaded folder
    /// docs' `filemeta_v0` directly (the source of truth), bypassing the
    /// eventually-consistent `doc_resolver`. Used as the resolver-miss fallback
    /// for moves and path opens, and by `handle_debug_resolve`.
    fn resolve_path_via_filemeta(&self, path: &str) -> Option<DocInfo> {
        for folder_doc_id in link_indexer::find_all_folder_docs(&self.docs) {
            // ⚠️ LOCK ORDERING: clone the awareness Arc out and drop the DashMap
            // shard ref BEFORE locking awareness (see run_worker / search_worker).
            let awareness = match self.docs.get(&folder_doc_id) {
                Some(doc_ref) => doc_ref.awareness(),
                None => continue,
            };
            let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
            let folder_name =
                y_sweet_core::doc_resolver::read_folder_name(&guard.doc, &folder_doc_id);
            // Every match below has the form "{folder_name}/{entry}", so skip
            // folders that can't contain the path. Keeps a miss (e.g. a bot
            // probing /open/*) from iterating every filemeta entry on the server.
            let Some(entry_suffix) = path
                .strip_prefix(&folder_name)
                .and_then(|rest| rest.strip_prefix('/'))
            else {
                continue;
            };
            let relay_id = link_indexer::parse_doc_id(&folder_doc_id)
                .map(|(r, _)| r.to_string())
                .unwrap_or_default();
            let txn = guard.doc.transact();
            let Some(filemeta) = txn.get_map("filemeta_v0") else {
                continue;
            };
            for (entry_path, value) in filemeta.iter(&txn) {
                let Some(uuid) = link_indexer::extract_id_from_filemeta_entry(&value, &txn) else {
                    continue;
                };
                let path_str: &str = &entry_path;
                let stripped = path_str.strip_prefix('/').unwrap_or(path_str);
                if stripped == entry_suffix {
                    let hash = link_indexer::extract_hash_from_filemeta_entry(&value, &txn);
                    let doc_id = format!("{}-{}", relay_id, uuid);
                    return Some(DocInfo {
                        uuid,
                        relay_id,
                        folder_doc_id: folder_doc_id.clone(),
                        folder_name,
                        doc_id,
                        hash,
                    });
                }
            }
        }
        None
    }

    /// Resolver-miss fallback for [`Server::move_path`]: resolve the path from
    /// `filemeta_v0` and log the resolver staleness (with the path the resolver
    /// currently holds for the uuid: None = missing, Some(other) = stale path).
    /// Returns None when the path is unknown to filemeta too — a genuinely
    /// unknown path or a legitimate folder move, so that case stays quiet.
    fn resolve_move_path_fallback(&self, path: &str, new_path: &str) -> Option<DocInfo> {
        match self.resolve_path_via_filemeta(path) {
            Some(info) => {
                let resolver_path = self.doc_resolver().path_for_uuid(&info.uuid);
                tracing::warn!(
                    requested_path = %path,
                    new_path = %new_path,
                    uuid = %info.uuid,
                    folder = %info.folder_name,
                    in_filemeta = true,
                    resolver_path_for_uuid = ?resolver_path,
                    "move: doc_resolver stale — path missing from resolver but present in filemeta_v0; using filemeta fallback"
                );
                Some(info)
            }
            None => {
                tracing::debug!(
                    requested_path = %path,
                    new_path = %new_path,
                    in_filemeta = false,
                    "move: resolver miss and path not in any loaded folder's filemeta_v0; treating as a folder move"
                );
                None
            }
        }
    }

    fn filemeta_type_for_uuid(&self, uuid: &str) -> Option<String> {
        for folder_doc_id in link_indexer::find_all_folder_docs(&self.docs) {
            // ⚠️ LOCK ORDERING: drop the shard ref before locking awareness.
            let awareness = match self.docs.get(&folder_doc_id) {
                Some(doc_ref) => doc_ref.awareness(),
                None => continue,
            };
            let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
            let txn = guard.doc.transact();
            let Some(filemeta) = txn.get_map("filemeta_v0") else {
                continue;
            };
            for (_, value) in filemeta.iter(&txn) {
                if link_indexer::extract_id_from_filemeta_entry(&value, &txn).as_deref()
                    == Some(uuid)
                {
                    return link_indexer::extract_type_from_filemeta_entry(&value, &txn);
                }
            }
        }
        None
    }

    async fn move_filemeta_entry_path(
        &self,
        path: &str,
        new_path: &str,
        target_folder: Option<&str>,
        info: &DocInfo,
    ) -> std::result::Result<link_indexer::MoveResult, MoveDocumentError> {
        if new_path == "/" || new_path.ends_with('/') || new_path.contains("//") {
            return Err(MoveDocumentError::BadRequest(
                "Invalid file destination path".into(),
            ));
        }
        if new_path
            .split('/')
            .filter(|s| !s.is_empty())
            .any(|segment| segment == "." || segment == "..")
        {
            return Err(MoveDocumentError::BadRequest(
                "File destination must not contain '.' or '..' segments".into(),
            ));
        }
        if let Some(target) = target_folder {
            if target != info.folder_name {
                return Err(MoveDocumentError::BadRequest(
                    "Non-markdown file cross-folder move is not supported".into(),
                ));
            }
        }

        let prefix = format!("{}/", info.folder_name);
        let old_path = path
            .strip_prefix(&prefix)
            .map(|rest| format!("/{}", rest.trim_start_matches('/')))
            .ok_or_else(|| MoveDocumentError::NotFound(format!("Path not found: {}", path)))?;

        let folder_sync_kv = {
            let doc_ref = self.docs.get(&info.folder_doc_id).ok_or_else(|| {
                MoveDocumentError::Internal("Source folder doc not loaded".into())
            })?;
            let sync_kv = doc_ref.sync_kv();
            let awareness = doc_ref.awareness();
            let guard = awareness.write().unwrap_or_else(|e| e.into_inner());
            let mut txn = guard.doc.transact_mut_with("link-indexer");
            let filemeta = txn
                .get_map("filemeta_v0")
                .ok_or_else(|| MoveDocumentError::NotFound("No filemeta_v0".into()))?;
            let value = filemeta
                .get(&txn, &old_path)
                .ok_or_else(|| MoveDocumentError::NotFound(format!("Path not found: {}", path)))?;
            let entry_type =
                link_indexer::extract_type_from_filemeta_entry(&value, &txn).unwrap_or_default();
            if entry_type == "markdown" || entry_type == "folder" {
                return Err(MoveDocumentError::BadRequest(format!(
                    "{} is not a non-markdown file",
                    path
                )));
            }
            if filemeta.get(&txn, new_path).is_some() && old_path != new_path {
                return Err(MoveDocumentError::Conflict(format!(
                    "Path '{}' already exists in target folder",
                    new_path
                )));
            }
            let fields = link_indexer::extract_filemeta_fields(&value, &txn);

            let filemeta = txn.get_or_insert_map("filemeta_v0");
            let docs_map = txn.get_or_insert_map("docs");
            filemeta.remove(&mut txn, old_path.as_str());
            docs_map.remove(&mut txn, old_path.as_str());
            filemeta.insert(&mut txn, new_path, yrs::Any::Map(fields.clone().into()));
            sync_kv
        };

        if let Err(e) = folder_sync_kv.persist().await {
            tracing::error!(
                "Failed to persist folder doc after file metadata move: {:?}",
                e
            );
        }

        self.doc_resolver.rebuild(&self.docs);
        if let Some(ref indexer) = self.link_indexer {
            indexer.on_document_update(&info.folder_doc_id).await;
        }

        Ok(link_indexer::MoveResult {
            old_path,
            new_path: new_path.to_string(),
            old_folder_name: info.folder_name.clone(),
            new_folder_name: info.folder_name.clone(),
            links_rewritten: 0,
        })
    }

    async fn move_folder_path(
        &self,
        path: &str,
        new_path: &str,
        target_folder: Option<&str>,
    ) -> std::result::Result<link_indexer::MoveResult, MoveDocumentError> {
        if new_path.ends_with(".md") {
            return Err(MoveDocumentError::BadRequest(
                "Folder destination must not end with '.md'".into(),
            ));
        }
        if new_path == "/" || new_path.ends_with('/') || new_path.contains("//") {
            return Err(MoveDocumentError::BadRequest(
                "Invalid folder destination path".into(),
            ));
        }
        if new_path
            .split('/')
            .filter(|s| !s.is_empty())
            .any(|segment| segment == "." || segment == "..")
        {
            return Err(MoveDocumentError::BadRequest(
                "Folder destination must not contain '.' or '..' segments".into(),
            ));
        }

        let folder_doc_ids = link_indexer::find_all_folder_docs(&self.docs);
        let mut source_folder_doc_id = None;
        let mut source_folder_name = None;
        let mut old_in_folder_path = None;

        for folder_doc_id in &folder_doc_ids {
            let Some(doc_ref) = self.docs.get(folder_doc_id) else {
                continue;
            };
            let awareness = doc_ref.awareness();
            let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
            let name = y_sweet_core::doc_resolver::read_folder_name(&guard.doc, folder_doc_id);
            let prefix = format!("{}/", name);
            if let Some(rest) = path.strip_prefix(&prefix) {
                source_folder_doc_id = Some(folder_doc_id.clone());
                source_folder_name = Some(name);
                old_in_folder_path = Some(format!("/{}", rest.trim_start_matches('/')));
                break;
            }
        }

        let source_folder_doc_id = source_folder_doc_id
            .ok_or_else(|| MoveDocumentError::NotFound(format!("Folder not found: {}", path)))?;
        let source_folder_name = source_folder_name.unwrap_or_default();
        let old_path = old_in_folder_path.unwrap_or_default();
        if new_path == old_path || new_path.starts_with(&format!("{}/", old_path)) {
            return Err(MoveDocumentError::BadRequest(
                "Cannot move a folder to itself or one of its descendants".into(),
            ));
        }

        if let Some(target) = target_folder {
            if target != source_folder_name {
                return Err(MoveDocumentError::BadRequest(
                    "Folder cross-folder move is not supported".into(),
                ));
            }
        }

        let entries_to_move: Vec<(
            String,
            String,
            String,
            String,
            std::collections::HashMap<String, yrs::Any>,
        )> = {
            let doc_ref = self.docs.get(&source_folder_doc_id).ok_or_else(|| {
                MoveDocumentError::Internal("Source folder doc not loaded".into())
            })?;
            let awareness = doc_ref.awareness();
            let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
            let txn = guard.doc.transact();
            let filemeta = txn
                .get_map("filemeta_v0")
                .ok_or_else(|| MoveDocumentError::NotFound("No filemeta_v0".into()))?;

            let old_prefix = format!("{}/", old_path);
            let new_prefix = format!("{}/", new_path);
            let source_paths: std::collections::HashSet<String> = filemeta
                .keys(&txn)
                .filter(|p| *p == old_path || p.starts_with(&old_prefix))
                .map(|p| p.to_string())
                .collect();
            if source_paths.is_empty() {
                return Err(MoveDocumentError::NotFound(format!(
                    "Folder not found: {}",
                    path
                )));
            }
            if let Some(old_value) = filemeta.get(&txn, &old_path) {
                if link_indexer::extract_type_from_filemeta_entry(&old_value, &txn).as_deref()
                    != Some("folder")
                {
                    return Err(MoveDocumentError::BadRequest(format!(
                        "{} is not a folder",
                        path
                    )));
                }
            }
            if filemeta.get(&txn, new_path).is_some() && !source_paths.contains(new_path) {
                return Err(MoveDocumentError::Conflict(format!(
                    "Path '{}' already exists in target folder",
                    new_path
                )));
            }
            let mut moves = Vec::new();
            for source_path in &source_paths {
                let destination = if source_path == &old_path {
                    new_path.to_string()
                } else {
                    format!("{}{}", new_prefix, &source_path[old_prefix.len()..])
                };
                if filemeta.get(&txn, &destination).is_some()
                    && !source_paths.contains(&destination)
                {
                    return Err(MoveDocumentError::Conflict(format!(
                        "Path '{}' already exists in target folder",
                        destination
                    )));
                }
                if let Some(value) = filemeta.get(&txn, source_path) {
                    let entry_type = link_indexer::extract_type_from_filemeta_entry(&value, &txn)
                        .unwrap_or_default();
                    let id = link_indexer::extract_id_from_filemeta_entry(&value, &txn)
                        .unwrap_or_default();
                    let fields = link_indexer::extract_filemeta_fields(&value, &txn);
                    moves.push((source_path.clone(), destination, entry_type, id, fields));
                }
            }
            moves.sort_by(|a, b| a.0.cmp(&b.0));
            moves
        };

        let markdown_moves: Vec<(String, String)> = entries_to_move
            .iter()
            .filter_map(|(_, dst, entry_type, id, _)| {
                (entry_type == "markdown" && !id.is_empty()).then(|| (id.clone(), dst.clone()))
            })
            .collect();

        let mut links_rewritten = 0usize;
        for (uuid, destination) in markdown_moves {
            let result = self.move_document(&uuid, &destination, None).await?;
            links_rewritten += result.links_rewritten;
        }

        let folder_sync_kv = {
            let doc_ref = self.docs.get(&source_folder_doc_id).ok_or_else(|| {
                MoveDocumentError::Internal("Source folder doc not loaded".into())
            })?;
            let sync_kv = doc_ref.sync_kv();
            let awareness = doc_ref.awareness();
            let guard = awareness.write().unwrap_or_else(|e| e.into_inner());
            let mut txn = guard.doc.transact_mut_with("link-indexer");
            let filemeta = txn.get_or_insert_map("filemeta_v0");
            let docs_map = txn.get_or_insert_map("docs");

            for (source, _, entry_type, _, _) in &entries_to_move {
                if entry_type != "markdown" {
                    filemeta.remove(&mut txn, source);
                    docs_map.remove(&mut txn, source);
                }
            }
            for (source, destination, entry_type, id, fields) in &entries_to_move {
                if entry_type == "markdown" {
                    continue;
                }
                filemeta.insert(
                    &mut txn,
                    destination.as_str(),
                    yrs::Any::Map(fields.clone().into()),
                );
                if entry_type == "folder" {
                    if !id.is_empty() {
                        docs_map.insert(
                            &mut txn,
                            destination.as_str(),
                            yrs::Any::String(id.to_string().into()),
                        );
                    }
                }
                if source == &old_path {
                    continue;
                }
            }
            sync_kv
        };

        if let Err(e) = folder_sync_kv.persist().await {
            tracing::error!("Failed to persist folder doc after folder move: {:?}", e);
        }

        self.doc_resolver.rebuild(&self.docs);
        if let Some(ref indexer) = self.link_indexer {
            indexer.on_document_update(&source_folder_doc_id).await;
        }

        Ok(link_indexer::MoveResult {
            old_path,
            new_path: new_path.to_string(),
            old_folder_name: source_folder_name.clone(),
            new_folder_name: source_folder_name,
            links_rewritten,
        })
    }

    /// Convenience wrapper for tests: creates a Server and discards the WorkerReceivers.
    /// Workers are not spawned, which is fine for tests that don't need background indexing.
    #[cfg(test)]
    pub async fn new_without_workers(
        store: Option<Box<dyn Store>>,
        checkpoint_freq: Duration,
        authenticator: Option<Authenticator>,
        url: Option<Url>,
        allowed_hosts: Vec<AllowedHost>,
        cancellation_token: CancellationToken,
        doc_gc: bool,
        webhook_configs: Option<Vec<WebhookConfig>>,
    ) -> Result<Self> {
        let (server, _receivers) = Self::new(
            store,
            checkpoint_freq,
            authenticator,
            url,
            allowed_hosts,
            cancellation_token,
            doc_gc,
            webhook_configs,
        )
        .await?;
        Ok(server)
    }

    /// Create a minimal Server for testing. No store, no auth, no search.
    #[cfg(test)]
    pub fn new_for_test() -> Arc<Self> {
        Arc::new(Self {
            docs: Arc::new(DashMap::new()),
            doc_worker_tracker: TaskTracker::new(),
            store: None,
            checkpoint_freq: Duration::from_secs(60),
            authenticator: None,
            url: None,
            allowed_hosts: Vec::new(),
            cancellation_token: CancellationToken::new(),
            doc_gc: std::sync::atomic::AtomicBool::new(false),
            event_dispatcher: None,
            sync_protocol_event_sender: Arc::new(
                y_sweet_core::event::SyncProtocolEventSender::new(),
            ),
            metrics: RelayMetrics::new().expect("metrics init should not fail in tests"),
            link_indexer: None,
            search_index: None,
            search_ready: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            search_tx: None,
            search_pending: None,
            suggestions_index: Arc::new(SuggestionsIndex::new()),
            suggestions_ready: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            doc_resolver: Arc::new(DocumentResolver::new()),
            mcp_sessions: Arc::new(crate::mcp::session::SessionManager::new()),
            mcp_api_key: None,
            share_token_secret: None,
            last_dirty_signal: Arc::new(AtomicU64::new(0)),
            last_successful_persist: Arc::new(AtomicU64::new(0)),
            worker_status: Arc::new(crate::worker_status::WorkerStatusMap::new()),
        })
    }

    /// Create a minimal Server for testing with a search index.
    #[cfg(test)]
    pub fn new_for_test_with_search(search_index: Arc<SearchIndex>) -> Arc<Self> {
        let server = Arc::new(Self {
            docs: Arc::new(DashMap::new()),
            doc_worker_tracker: TaskTracker::new(),
            store: None,
            checkpoint_freq: Duration::from_secs(60),
            authenticator: None,
            url: None,
            allowed_hosts: Vec::new(),
            cancellation_token: CancellationToken::new(),
            doc_gc: std::sync::atomic::AtomicBool::new(false),
            event_dispatcher: None,
            sync_protocol_event_sender: Arc::new(
                y_sweet_core::event::SyncProtocolEventSender::new(),
            ),
            metrics: RelayMetrics::new().expect("metrics init should not fail in tests"),
            link_indexer: None,
            search_index: Some(search_index),
            search_ready: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            search_tx: None,
            search_pending: None,
            suggestions_index: Arc::new(SuggestionsIndex::new()),
            suggestions_ready: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            doc_resolver: Arc::new(DocumentResolver::new()),
            mcp_sessions: Arc::new(crate::mcp::session::SessionManager::new()),
            mcp_api_key: None,
            share_token_secret: None,
            last_dirty_signal: Arc::new(AtomicU64::new(0)),
            last_successful_persist: Arc::new(AtomicU64::new(0)),
            worker_status: Arc::new(crate::worker_status::WorkerStatusMap::new()),
        });
        server
    }

    pub async fn doc_exists(&self, doc_id: &str) -> bool {
        // Reject system keys
        if Self::validate_doc_id(doc_id).is_err() {
            return false;
        }
        if self.docs.contains_key(doc_id) {
            return true;
        }
        if let Some(store) = &self.store {
            store
                .exists(&format!("{}/data.ysweet", doc_id))
                .await
                .unwrap_or_default()
        } else {
            false
        }
    }

    /// Resolve a (possibly prefix-shortened) doc ID to a full doc ID.
    /// Tries exact match first, then prefix match against in-memory docs.
    /// Returns None if no match or multiple matches (ambiguous prefix).
    ///
    /// Note: Prefix matching only works for docs loaded in memory. Docs that have
    /// been garbage-collected but still exist in the store require an exact match.
    /// In practice, the frontend's client-side resolution (from metadata) handles
    /// the common case; this endpoint is only for cold page loads where the doc
    /// is typically still warm in memory.
    pub async fn resolve_doc_id(&self, input: &str) -> Option<String> {
        // Exact match — fast path (checks both in-memory and store)
        if self.docs.contains_key(input) {
            return Some(input.to_string());
        }

        // Prefix match against in-memory docs (early exit after 2 matches)
        let mut matches = self
            .docs
            .iter()
            .filter(|entry| entry.key().starts_with(input))
            .take(2);

        match (matches.next(), matches.next()) {
            (Some(first), None) => Some(first.key().clone()), // Unique match
            _ => None,                                        // No match or ambiguous
        }
    }

    pub async fn create_doc(&self) -> Result<String> {
        let doc_id = nanoid::nanoid!();
        self.load_doc(&doc_id, None).await?;
        tracing::info!(doc_id=?doc_id, "Created doc");
        Ok(doc_id)
    }

    pub async fn reload_webhook_config(&self) -> Result<String, anyhow::Error> {
        // For now, webhook configuration reloading is not supported with the new event system
        // This would require a more complex architecture to hot-reload the event dispatcher
        // In the meantime, server restart is required to change webhook configuration
        Err(anyhow::anyhow!(
            "Webhook configuration reloading is not yet supported with the new event system. Please restart the server to load new configuration."
        ))
    }

    fn validate_doc_id(doc_id: &str) -> Result<()> {
        // Reject system configuration paths that are reserved for internal use
        if doc_id.starts_with(".config/") || doc_id == ".config" {
            return Err(anyhow::anyhow!(
                "Document ID cannot access system configuration directory '.config'"
            ));
        }
        Ok(())
    }

    pub fn load_doc<'a>(
        &'a self,
        doc_id: &'a str,
        routing_channel: Option<String>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(self.load_doc_with_user(doc_id, routing_channel, None))
    }

    /// Ensure a document is loaded into memory, reloading from storage if GC evicted it.
    pub async fn ensure_doc_loaded(&self, doc_id: &str) -> Result<()> {
        if !self.docs.contains_key(doc_id) {
            self.load_doc(doc_id, None).await?;
        }
        Ok(())
    }

    pub async fn load_doc_with_user(
        &self,
        doc_id: &str,
        routing_channel: Option<String>,
        user: Option<String>,
    ) -> Result<()> {
        Self::validate_doc_id(doc_id)?;
        let (send, recv) = channel(1024);

        // Determine routing channel: use provided channel or fallback to doc_id
        let routing_channel_name = routing_channel
            .clone()
            .unwrap_or_else(|| doc_id.to_string());

        // If this doc routes to a different channel (i.e., it's a subdoc),
        // ensure the parent is loaded and hold a reference to prevent GC.
        let parent_awareness_guard = if routing_channel_name != doc_id {
            if !self.docs.contains_key(&routing_channel_name) {
                self.load_doc(&routing_channel_name, None).await?;
            }
            self.docs
                .get(&routing_channel_name)
                .map(|parent| parent.awareness())
        } else {
            None
        };

        // Create event callback with the determined routing channel and user
        let event_callback = {
            let event_dispatcher = self.event_dispatcher.clone();
            let routing_channel_for_callback = routing_channel_name.clone();
            let user_for_callback = user.clone();
            let link_indexer_for_callback = self.link_indexer.clone();
            let search_tx_for_callback = self.search_tx.clone();
            let search_pending_for_callback = self.search_pending.clone();
            let doc_key_for_indexer = doc_id.to_string();
            let docs = self.docs.clone();
            let doc_id_for_callback = doc_id.to_string();
            let metrics_for_callback = self.metrics.clone();
            // Capture parent awareness to keep it alive (prevents GC while subdoc exists)
            let _parent_awareness = parent_awareness_guard;

            if let Some(dispatcher) = event_dispatcher {
                Some(
                    Arc::new(move |mut event: DocumentUpdatedEvent, is_indexer: bool| {
                        // Keep parent awareness alive by referencing it in the closure
                        let _ = &_parent_awareness;

                        // Update parent's subdoc state vector index
                        if routing_channel_for_callback != doc_id_for_callback {
                            if let Some(state_vector) = &event.state_vector {
                                if let Some(parent) = docs.get(&routing_channel_for_callback) {
                                    parent.update_subdoc_state_vector(
                                        &doc_id_for_callback,
                                        state_vector.clone(),
                                    );
                                }
                            }
                        }

                        // Add user to event if available
                        if let Some(ref user) = user_for_callback {
                            event.user = Some(user.clone());
                        }

                        // Log the full event payload as JSON after user assignment
                        match serde_json::to_string(&event) {
                            Ok(json_str) => {
                                tracing::debug!("Document updated event dispatched: {}", json_str);
                            }
                            Err(e) => {
                                tracing::debug!(
                                "Document updated event dispatched for doc_id: {} (JSON serialization failed: {})",
                                event.doc_id, e
                            );
                            }
                        }

                        // Step 1: Create the envelope with predetermined routing channel
                        let envelope =
                            EventEnvelope::new(routing_channel_for_callback.clone(), event);

                        // Step 2: Send via dispatcher
                        dispatcher.send_event(envelope);

                        // Notify link indexer (if this update is not from the indexer itself)
                        if !is_indexer {
                            if let Some(ref indexer) = link_indexer_for_callback {
                                let indexer = indexer.clone();
                                let doc_key = doc_key_for_indexer.clone();
                                let metrics = metrics_for_callback.clone();
                                tokio::spawn(async move {
                                    let doc_key_for_log = doc_key.clone();
                                    if let Some(msg) = crate::supervisor::run_with_panic_recovery(
                                        "on_document_update",
                                        &metrics,
                                        async move {
                                            indexer.on_document_update(&doc_key).await;
                                        },
                                    )
                                    .await
                                    {
                                        tracing::error!(
                                            worker = "on_document_update",
                                            doc = %doc_key_for_log,
                                            panic_msg = %msg,
                                            "fire-and-forget task panicked; one update lost"
                                        );
                                    }
                                });
                            }

                            // ⚠️ This runs synchronously inside an awareness write lock.
                            // Any lock acquired here must be LOWER than awareness in the
                            // lock ordering. DashMap shard locks (via .entry()) are lower,
                            // so this is safe — but code iterating this DashMap must NOT
                            // hold shard locks while acquiring awareness locks.

                            // Notify search index worker (with deduplication)
                            if let Some(ref tx) = search_tx_for_callback {
                                if let Some(ref pending) = search_pending_for_callback {
                                    let now = tokio::time::Instant::now();
                                    let is_new = match pending.entry(doc_key_for_indexer.clone()) {
                                        Entry::Occupied(mut e) => {
                                            e.get_mut().last_updated = now;
                                            false
                                        }
                                        Entry::Vacant(e) => {
                                            e.insert(link_indexer::PendingEntry::new(now));
                                            true
                                        }
                                    };
                                    if is_new {
                                        if let Err(e) = tx.try_send(doc_key_for_indexer.clone()) {
                                            tracing::error!("Search index channel send failed (worker dead?): {e}");
                                        }
                                    }
                                }
                            }
                        }
                    }) as y_sweet_core::webhook::WebhookCallback,
                )
            } else {
                // Server::new always constructs an event_dispatcher (with
                // webhooks if configured, otherwise sync-protocol-only). The
                // None case is reachable only via #[cfg(test)] helpers that
                // bypass the doc-creation pipeline, so no callback is needed.
                None
            }
        };

        let last_dirty_for_callback = self.last_dirty_signal.clone();
        let dwskv = DocWithSyncKv::new(
            doc_id,
            self.store.clone(),
            move || {
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                last_dirty_for_callback.store(now_ms, AtomicOrdering::Relaxed);
                if let Err(e) = send.try_send(()) {
                    match e {
                        tokio::sync::mpsc::error::TrySendError::Closed(_) => {
                            tracing::error!(
                                "Dirty signal channel closed — persistence worker is dead"
                            );
                        }
                        tokio::sync::mpsc::error::TrySendError::Full(_) => {
                            // Normal: signals coalesce when channel is full. The persistence
                            // worker will pick up the dirty state on its next cycle.
                        }
                    }
                }
            },
            event_callback,
        )
        .await?;

        // If channel is provided in token, store it in document metadata
        if let Some(channel_name) = routing_channel {
            dwskv.set_channel(&channel_name);
        }

        dwskv
            .sync_kv()
            .persist()
            .await
            .map_err(|e| anyhow!("Error persisting: {:?}", e))?;

        {
            let sync_kv = dwskv.sync_kv();
            let checkpoint_freq = self.checkpoint_freq;
            let doc_id = doc_id.to_string();
            let cancellation_token = self.cancellation_token.clone();

            // Spawn a task to save the document to the store when it changes.
            let last_persist = self.last_successful_persist.clone();
            self.doc_worker_tracker.spawn(
                Self::doc_persistence_worker(
                    recv,
                    sync_kv,
                    checkpoint_freq,
                    doc_id.clone(),
                    cancellation_token.clone(),
                    last_persist,
                )
                .instrument(span!(Level::INFO, "save_loop", doc_id=?doc_id)),
            );

            if self.doc_gc.load(std::sync::atomic::Ordering::Relaxed) {
                self.doc_worker_tracker.spawn(
                    Self::doc_gc_worker(
                        self.docs.clone(),
                        doc_id.clone(),
                        checkpoint_freq,
                        cancellation_token,
                    )
                    .instrument(span!(Level::INFO, "gc_loop", doc_id=?doc_id)),
                );
            }
        }

        self.docs.insert(doc_id.to_string(), dwskv);

        Ok(())
    }

    /// Load all documents from storage into memory.
    ///
    /// Enumerates all doc IDs in the store and calls `load_doc()` for each.
    /// Used on startup to populate the in-memory doc map before reindexing backlinks.
    pub async fn load_all_docs(&self) -> Result<usize> {
        let store = self
            .store
            .as_ref()
            .ok_or_else(|| anyhow!("No store configured — cannot load docs from storage"))?;

        let doc_ids = store
            .list_doc_ids()
            .await
            .map_err(|e| anyhow!("Failed to list doc IDs from storage: {:?}", e))?;

        let total = doc_ids.len();
        tracing::info!("Loading {} documents from storage...", total);

        // Temporarily disable GC during bulk loading — all docs would be
        // immediately GCed since no clients are connected yet.
        let gc_was_enabled = self
            .doc_gc
            .swap(false, std::sync::atomic::Ordering::Relaxed);

        let loaded = std::sync::atomic::AtomicUsize::new(0);
        let failed = std::sync::atomic::AtomicUsize::new(0);
        let loaded_ref = &loaded;
        let failed_ref = &failed;

        // Load docs in parallel — each load_doc is an R2 round-trip (~200ms),
        // so sequential loading of 300+ docs takes minutes. With concurrency
        // of 32 it drops to seconds.
        futures::stream::iter(doc_ids.iter().enumerate())
            .for_each_concurrent(32, |(_, doc_id)| async move {
                if self.docs.contains_key(doc_id) {
                    loaded_ref.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    return;
                }

                match self.load_doc(doc_id, None).await {
                    Ok(()) => {
                        let n = loaded_ref.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                        if n % 50 == 0 || n == total {
                            tracing::info!("  Loaded {}/{} documents", n, total);
                        }
                    }
                    Err(e) => {
                        tracing::warn!("  Failed to load doc {}: {:?}", doc_id, e);
                        failed_ref.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    }
                }
            })
            .await;

        let loaded = loaded.load(std::sync::atomic::Ordering::Relaxed);
        let failed = failed.load(std::sync::atomic::Ordering::Relaxed);

        // Restore GC setting
        self.doc_gc
            .store(gc_was_enabled, std::sync::atomic::Ordering::Relaxed);

        tracing::info!(
            "Document loading complete: {} loaded, {} failed, {} total in storage",
            loaded,
            failed,
            total
        );
        Ok(loaded)
    }

    /// Write folder display names from config into folder Y.Docs.
    ///
    /// For each configured folder, finds the folder doc whose doc_id ends with
    /// the configured UUID, reads the current `folder_config.name` from the Y.Doc,
    /// and writes the configured name if different. Persists changed docs to storage.
    async fn apply_folder_names(
        &self,
        folders: &[y_sweet_core::config::FolderConfig],
    ) -> Result<()> {
        if folders.is_empty() {
            return Ok(());
        }

        let folder_doc_ids = link_indexer::find_all_folder_docs(&self.docs);
        let mut applied = 0;

        for folder_config in folders {
            // Find the folder doc whose doc_id ends with this UUID
            let Some(folder_doc_id) = folder_doc_ids.iter().find(|id| {
                link_indexer::parse_doc_id(id)
                    .map(|(_, uuid)| uuid == folder_config.uuid)
                    .unwrap_or(false)
            }) else {
                tracing::warn!(
                    "Folder config for '{}' (uuid={}) — no matching folder doc found",
                    folder_config.name,
                    folder_config.uuid
                );
                continue;
            };

            let (awareness, sync_kv) = {
                let Some(doc_ref) = self.docs.get(folder_doc_id) else {
                    continue;
                };
                (doc_ref.awareness(), doc_ref.sync_kv()) // Arc clones
            }; // DashMap shard lock released

            // Read current name and compare
            let needs_update = {
                let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
                let current_name =
                    y_sweet_core::doc_resolver::read_folder_name(&guard.doc, folder_doc_id);
                current_name != folder_config.name
            };

            if !needs_update {
                tracing::debug!(
                    "Folder '{}' already has correct name, skipping",
                    folder_config.name
                );
                continue;
            }

            // Write the folder name
            {
                let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
                let mut txn = guard.doc.transact_mut();
                let config_map = txn.get_or_insert_map("folder_config");
                config_map.insert(
                    &mut txn,
                    "name",
                    yrs::Any::String(folder_config.name.clone().into()),
                );
            }

            // Persist to storage
            sync_kv.persist().await.map_err(|e| {
                anyhow!(
                    "Failed to persist folder name for '{}': {:?}",
                    folder_config.name,
                    e
                )
            })?;

            tracing::info!(
                "Applied folder name '{}' to doc {}",
                folder_config.name,
                folder_doc_id
            );
            applied += 1;
        }

        if applied > 0 {
            tracing::info!("Applied {} folder name(s) from config", applied);
        }

        Ok(())
    }

    /// Scan every loaded content doc for CriticMarkup and (re)build the
    /// suggestions index, then mark it ready. Called from `startup_reindex`
    /// while all docs are in memory; incremental updates afterwards come from
    /// the search worker.
    pub(crate) fn rebuild_suggestions_index(&self) {
        // Snapshot keys first: iterating the DashMap while acquiring awareness
        // locks would violate the lock ordering (shard < awareness), see the
        // search_worker comment.
        let doc_ids: Vec<String> = self.docs.iter().map(|e| e.key().clone()).collect();
        let mut indexed = 0;
        for doc_id in &doc_ids {
            let Some((_relay_id, doc_uuid)) = link_indexer::parse_doc_id(doc_id) else {
                continue;
            };
            let awareness = {
                let Some(doc_ref) = self.docs.get(doc_id) else {
                    continue;
                };
                doc_ref.awareness() // Arc clone
            }; // DashMap shard lock released
            let content = {
                let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
                let txn = guard.doc.transact();
                match txn.get_text("contents") {
                    Some(text) => text.get_string(&txn),
                    // Folder docs and blobs have no "contents" text
                    None => continue,
                }
            };
            let suggestions = critic_scanner::scan_suggestions(&content);
            if !suggestions.is_empty() {
                indexed += 1;
            }
            self.suggestions_index.update(doc_uuid, suggestions);
        }
        self.suggestions_ready
            .store(true, std::sync::atomic::Ordering::Release);
        tracing::info!(
            "Suggestions index built: {} of {} docs have suggestions",
            indexed,
            doc_ids.len()
        );
    }

    /// Load all documents from storage and reindex all backlinks.
    ///
    /// Called once on startup, before accepting connections.
    /// No-op if no store is configured (in-memory mode).
    pub async fn startup_reindex(
        &self,
        folders: &[y_sweet_core::config::FolderConfig],
    ) -> Result<()> {
        if self.store.is_none() {
            tracing::info!("No store configured, skipping startup reindex");
            // Even without a store, mark search as ready (empty index)
            self.search_ready
                .store(true, std::sync::atomic::Ordering::Release);
            self.suggestions_ready
                .store(true, std::sync::atomic::Ordering::Release);
            return Ok(());
        }

        let loaded = self.load_all_docs().await?;
        tracing::info!("Loaded {} documents, now reindexing backlinks...", loaded);

        // Apply folder names from config before reindexing
        self.apply_folder_names(folders).await?;

        if let Some(ref indexer) = self.link_indexer {
            indexer.reindex_all_backlinks(&self.docs)?;
        }

        // Build document resolver (bidirectional path <-> UUID mapping)
        self.doc_resolver.rebuild(&self.docs);
        tracing::info!(
            "Document resolver built: {} documents",
            self.doc_resolver.all_paths().len()
        );

        // Build the suggestions index while everything is in memory
        self.rebuild_suggestions_index();

        // Build search index from all loaded documents
        if let Some(ref search_index) = self.search_index {
            tracing::info!("Building search index from loaded documents...");
            let mut indexed = 0;

            // Find all folder docs and build uuid -> (title, folder_name) map
            let folder_doc_ids = link_indexer::find_all_folder_docs(&self.docs);
            let mut uuid_metadata: std::collections::HashMap<String, (String, String)> =
                std::collections::HashMap::new();

            for folder_doc_id in &folder_doc_ids {
                let awareness = {
                    let Some(doc_ref) = self.docs.get(folder_doc_id) else {
                        continue;
                    };
                    doc_ref.awareness() // Arc clone
                }; // DashMap shard lock released
                let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
                let folder_name =
                    y_sweet_core::doc_resolver::read_folder_name(&guard.doc, folder_doc_id);
                let txn = guard.doc.transact();
                let Some(filemeta) = txn.get_map("filemeta_v0") else {
                    continue;
                };

                for (path, value) in filemeta.iter(&txn) {
                    if let Some(uuid) = link_indexer::extract_id_from_filemeta_entry(&value, &txn) {
                        // Extract title: strip leading "/" and trailing ".md", take basename
                        let title = path
                            .strip_prefix('/')
                            .unwrap_or(&path)
                            .strip_suffix(".md")
                            .unwrap_or(&path)
                            .rsplit('/')
                            .next()
                            .unwrap_or(&path)
                            .to_string();
                        uuid_metadata.insert(uuid, (title, folder_name.clone()));
                    }
                }
            }

            tracing::info!(
                "Found {} documents in {} folder doc(s) for search indexing",
                uuid_metadata.len(),
                folder_doc_ids.len()
            );

            // For each UUID in the metadata map, find the content doc and index it
            for (uuid, (title, folder_name)) in &uuid_metadata {
                // Try to find the content doc — it might be under any relay_id prefix
                // Search through all loaded docs for one ending with this UUID.
                // Clone the awareness Arc out of the DashMap iter to avoid holding
                // shard locks across the awareness read lock.
                let awareness = {
                    let mut found = None;
                    for entry in self.docs.iter() {
                        if let Some((_relay_id, doc_uuid)) = link_indexer::parse_doc_id(entry.key())
                        {
                            if doc_uuid == uuid {
                                found = Some(entry.value().awareness());
                                break;
                            }
                        }
                    }
                    found
                }; // DashMap iter / shard locks released
                let mut body = String::new();
                if let Some(awareness) = awareness {
                    let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
                    let txn = guard.doc.transact();
                    if let Some(text) = txn.get_text("contents") {
                        body = text.get_string(&txn);
                    }
                }

                match search_index.add_document_buffered(uuid, title, &body, folder_name) {
                    Ok(()) => indexed += 1,
                    Err(e) => {
                        tracing::error!("Failed to index doc {} into search: {:?}", uuid, e);
                    }
                }
            }

            if let Err(e) = search_index.flush() {
                tracing::error!("Failed to flush search index: {}", e);
            }
            tracing::info!("Search index built: {} documents indexed", indexed);
        }

        // Mark search as ready after indexing is complete
        self.search_ready
            .store(true, std::sync::atomic::Ordering::Release);
        tracing::info!("Search index is now ready for queries");

        Ok(())
    }

    async fn doc_gc_worker(
        docs: Arc<DashMap<String, DocWithSyncKv>>,
        doc_id: String,
        checkpoint_freq: Duration,
        cancellation_token: CancellationToken,
    ) {
        let mut checkpoints_without_refs = 0;

        loop {
            tokio::select! {
                _ = tokio::time::sleep(checkpoint_freq) => {
                    if let Some(doc) = docs.get(&doc_id) {
                        let awareness = Arc::downgrade(&doc.awareness());
                        if awareness.strong_count() > 1 {
                            checkpoints_without_refs = 0;
                            tracing::debug!("doc is still alive - it has {} references", awareness.strong_count());
                        } else {
                            checkpoints_without_refs += 1;
                            tracing::info!("doc has only one reference, candidate for GC. checkpoints_without_refs: {}", checkpoints_without_refs);
                        }
                    } else {
                        break;
                    }

                    if checkpoints_without_refs >= 2 {
                        tracing::info!("GCing doc");
                        if let Some(doc) = docs.get(&doc_id) {
                            // Compact PUD before shutdown: dedup ids, clear ds.
                            // The mutations create tombstones which yrs GC will
                            // clean up, and the update observer marks SyncKv
                            // dirty so the compacted state gets persisted.
                            let result = doc.compact_user_data();
                            if !result.is_empty() {
                                tracing::debug!(
                                    ids_removed = result.ids_removed,
                                    ds_removed = result.ds_removed,
                                    "Compacted PermanentUserData"
                                );
                            }
                            doc.sync_kv().shutdown();
                        }
                        docs.remove(&doc_id);
                        break;
                    }
                }
                _ = cancellation_token.cancelled() => {
                    break;
                }
            };
        }
        tracing::info!("Exiting gc_loop");
    }

    async fn doc_persistence_worker(
        mut recv: Receiver<()>,
        sync_kv: Arc<SyncKv>,
        checkpoint_freq: Duration,
        doc_id: String,
        cancellation_token: CancellationToken,
        last_successful_persist: Arc<AtomicU64>,
    ) {
        let mut last_save = std::time::Instant::now();
        let mut consecutive_failures: u32 = 0;

        loop {
            let is_done = tokio::select! {
                v = recv.recv() => v.is_none(),
                _ = cancellation_token.cancelled() => true,
                _ = tokio::time::sleep(checkpoint_freq) => {
                    sync_kv.is_shutdown()
                }
            };

            tracing::debug!("Received signal. done: {}", is_done);
            let now = std::time::Instant::now();
            if !is_done && now - last_save < checkpoint_freq {
                let sleep = tokio::time::sleep(checkpoint_freq - (now - last_save));
                tokio::pin!(sleep);
                tracing::info!("Throttling.");

                loop {
                    tokio::select! {
                        _ = &mut sleep => {
                            break;
                        }
                        v = recv.recv() => {
                            tracing::info!("Received dirty while throttling.");
                            if v.is_none() {
                                break;
                            }
                        }
                        _ = cancellation_token.cancelled() => {
                            tracing::info!("Received cancellation while throttling.");
                            break;
                        }

                    }
                    tracing::info!("Done throttling.");
                }
            }
            tracing::debug!("Persisting.");
            if let Err(e) = sync_kv.persist().await {
                consecutive_failures += 1;
                if consecutive_failures >= 10 {
                    tracing::error!(
                        ?e,
                        consecutive_failures,
                        "Persist failing repeatedly for {}",
                        doc_id
                    );
                } else {
                    tracing::error!(?e, "Error persisting.");
                }
            } else {
                if consecutive_failures > 0 {
                    tracing::info!(
                        "Persist succeeded after {} consecutive failures",
                        consecutive_failures
                    );
                }
                consecutive_failures = 0;
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                last_successful_persist.store(now_ms, AtomicOrdering::Relaxed);
                tracing::debug!("Done persisting.");
            }
            last_save = std::time::Instant::now();

            if is_done {
                break;
            }
        }
        tracing::info!("Terminating loop for {}", doc_id);
    }

    pub async fn get_or_create_doc(
        &self,
        doc_id: &str,
    ) -> Result<MappedRef<'_, String, DocWithSyncKv, DocWithSyncKv>> {
        if !self.docs.contains_key(doc_id) {
            tracing::info!(doc_id=?doc_id, "Loading doc");
            self.load_doc(doc_id, None).await?;
        }

        Ok(self
            .docs
            .get(doc_id)
            .ok_or_else(|| anyhow!("Failed to get-or-create doc"))?
            .map(|d| d))
    }

    pub async fn get_or_create_doc_with_channel(
        &self,
        doc_id: &str,
        routing_channel: Option<String>,
    ) -> Result<MappedRef<'_, String, DocWithSyncKv, DocWithSyncKv>> {
        self.get_or_create_doc_with_channel_and_user(doc_id, routing_channel, None)
            .await
    }

    pub async fn get_or_create_doc_with_channel_and_user(
        &self,
        doc_id: &str,
        routing_channel: Option<String>,
        user: Option<String>,
    ) -> Result<MappedRef<'_, String, DocWithSyncKv, DocWithSyncKv>> {
        if !self.docs.contains_key(doc_id) {
            tracing::info!(doc_id=?doc_id, channel=?routing_channel, user=?user, "Loading doc with channel and user");
            self.load_doc_with_user(doc_id, routing_channel, user)
                .await?;
        }

        Ok(self
            .docs
            .get(doc_id)
            .ok_or_else(|| anyhow!("Failed to get-or-create doc"))?
            .map(|d| d))
    }

    pub fn check_auth(
        &self,
        auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
    ) -> Result<(), AppError> {
        if let Some(auth) = &self.authenticator {
            if let Some(TypedHeader(headers::Authorization(bearer))) = auth_header {
                if let Ok(()) =
                    auth.verify_server_token(bearer.token(), current_time_epoch_millis())
                {
                    return Ok(());
                }
                return Err(AppError::auth(
                    StatusCode::UNAUTHORIZED,
                    anyhow!("Unauthorized."),
                    "invalid_server_token",
                ));
            }
            Err(AppError::auth(
                StatusCode::UNAUTHORIZED,
                anyhow!("Unauthorized."),
                "missing_token",
            ))
        } else {
            Ok(())
        }
    }

    pub async fn redact_error_middleware(req: Request, next: Next) -> impl IntoResponse {
        let resp = next.run(req).await;
        if resp.status().is_server_error() || resp.status().is_client_error() {
            // If we should redact errors, copy over only the status code and
            // not the response body.
            return resp.status().into_response();
        }
        resp
    }

    pub async fn version_header_middleware(req: Request, next: Next) -> impl IntoResponse {
        let mut resp = next.run(req).await;
        resp.headers_mut().insert(
            HeaderName::from_static("relay-server-version"),
            HeaderValue::from_static(RELAY_SERVER_VERSION),
        );
        resp
    }

    pub fn routes_with_metrics(self: &Arc<Self>) -> Router {
        self.routes().layer(middleware::from_fn_with_state(
            self.clone(),
            auth_metrics_middleware,
        ))
    }

    pub fn single_doc_routes_with_metrics(self: &Arc<Self>) -> Router {
        self.single_doc_routes()
            .layer(middleware::from_fn_with_state(
                self.clone(),
                auth_metrics_middleware,
            ))
    }

    pub fn routes(self: &Arc<Self>) -> Router {
        let mut router = Router::new()
            .route("/ready", get(ready))
            .route("/check_store", post(check_store))
            .route("/check_store", get(check_store_deprecated))
            .route("/doc/ws/:doc_id", get(handle_socket_upgrade_deprecated))
            .route("/doc/new", post(new_doc))
            .route("/doc/:doc_id/auth", post(auth_doc))
            .route("/doc/:doc_id/folder", get(get_doc_folder))
            .route("/doc/resolve/:prefix", get(resolve_doc))
            .route("/doc/:doc_id/as-update", get(get_doc_as_update_deprecated))
            .route("/doc/:doc_id/update", post(update_doc_deprecated))
            .route("/d/:doc_id/as-update", get(get_doc_as_update))
            .route("/d/:doc_id/update", post(update_doc))
            .route("/d/:doc_id/versions", get(handle_doc_versions))
            .route(
                "/d/:doc_id/ws/:doc_id2",
                get(handle_socket_upgrade_full_path),
            )
            .route("/webhook/reload", post(reload_webhook_config_endpoint))
            .route("/search", get(handle_search))
            .route("/folder/:folder_uuid/name", get(handle_folder_name))
            .route("/move", post(handle_move_path))
            .route("/doc/move", post(handle_move_document))
            .route("/doc/upsert", post(handle_upsert_document))
            .route("/doc/check", post(handle_check_documents))
            .route("/doc/check-video-ids", post(handle_check_video_ids))
            .route("/doc/check-source-urls", post(handle_check_source_urls))
            .route(
                "/doc/attachment",
                post(handle_upsert_attachment).layer(DefaultBodyLimit::max(30 * 1024 * 1024)),
            )
            .route("/open/*path", get(handle_open_by_path))
            .route("/debug/resolve", get(handle_debug_resolve))
            .route("/suggestions", get(handle_suggestions));

        // Register /mcp if MCP_API_KEY or SHARE_TOKEN_SECRET is set
        if self.mcp_api_key.is_some() || self.share_token_secret.is_some() {
            // Bearer auth: POST/GET/DELETE /mcp (for Claude Code / .mcp.json)
            let bearer_routes = Router::new()
                .route(
                    "/",
                    post(crate::mcp::transport::handle_mcp_post)
                        .get(crate::mcp::transport::handle_mcp_get)
                        .delete(crate::mcp::transport::handle_mcp_delete),
                )
                .layer(middleware::from_fn_with_state(
                    self.clone(),
                    crate::mcp::transport::mcp_auth_middleware,
                ));

            // Path-key auth: POST/GET/DELETE /mcp/:key (for claude.ai connectors)
            let path_key_routes = Router::new().route(
                "/:key",
                post(crate::mcp::transport::handle_mcp_post_with_key)
                    .get(crate::mcp::transport::handle_mcp_get_with_key)
                    .delete(crate::mcp::transport::handle_mcp_delete_with_key),
            );

            let mcp_routes = bearer_routes
                .merge(path_key_routes)
                .with_state(self.clone());
            router = router.nest("/mcp", mcp_routes);
        }

        // Only add file endpoints if a store is configured
        if let Some(store) = &self.store {
            // Add presigned URL endpoints for all stores
            router = router
                .route("/f/:doc_id/upload-url", post(handle_file_upload_url))
                .route("/f/:doc_id/download-url", get(handle_file_download_url));

            // Add file operations that work with any store
            router = router
                .route("/f/:doc_id/history", get(handle_file_history))
                .route("/f/:doc_id", delete(handle_file_delete))
                .route("/f/:doc_id/:hash", delete(handle_file_delete_by_hash))
                .route("/f/:doc_id", head(handle_file_head));

            // Only add direct upload/download endpoints if store supports direct uploads
            if store.supports_direct_uploads() {
                let upload_routes = Router::new()
                    .route(
                        "/f/:doc_id/upload",
                        post(handle_file_upload)
                            .put(handle_file_upload_raw)
                            .layer(DefaultBodyLimit::max(100 * 1024 * 1024)), // 100MB for file uploads
                    )
                    .route("/f/:doc_id/download", get(handle_file_download))
                    .layer(DefaultBodyLimit::max(250 * 1024 * 1024));
                router = router.merge(upload_routes);
            }
        }

        // Unauthenticated blob read — local dev only (no auth key configured)
        if self.authenticator.is_none() {
            if let Some(_store) = &self.store {
                router = router.route("/blob/:doc_id/:hash", get(handle_blob_read));
            }
        }

        router
            .layer(DefaultBodyLimit::max(10 * 1024 * 1024)) // 10MB default
            .with_state(self.clone())
    }

    pub fn single_doc_routes(self: &Arc<Self>) -> Router {
        Router::new()
            .route("/ws/:doc_id", get(handle_socket_upgrade_single))
            .route("/as-update", get(get_doc_as_update_single))
            .route("/update", post(update_doc_single))
            .with_state(self.clone())
    }

    pub fn metrics_routes(self: &Arc<Self>) -> Router {
        Router::new()
            .route("/metrics", get(metrics_endpoint))
            .with_state(self.clone())
    }

    async fn serve_internal(
        self: Arc<Self>,
        listener: TcpListener,
        redact_errors: bool,
        routes: Router,
    ) -> Result<()> {
        let token = self.cancellation_token.clone();

        let app = routes.layer(middleware::from_fn(Self::version_header_middleware));
        let app = if redact_errors {
            app.layer(middleware::from_fn(Self::redact_error_middleware))
        } else {
            app
        };

        tracing::info!("Starting HTTP server...");
        axum::serve(listener, app.into_make_service())
            .with_graceful_shutdown(async move {
                tracing::info!("Waiting for cancellation token...");
                token.cancelled().await;
                tracing::info!("Cancellation token triggered, starting graceful shutdown");
            })
            .await?;

        tracing::info!("HTTP server stopped, shutting down event dispatcher...");

        // Explicitly shutdown event dispatcher before waiting on doc workers
        if let Some(event_dispatcher) = &self.event_dispatcher {
            tracing::info!("Shutting down event dispatcher...");
            event_dispatcher.shutdown();
            tracing::info!("Event dispatcher shutdown complete");
        }

        tracing::info!("Closing doc worker tracker...");
        self.doc_worker_tracker.close();
        tracing::info!("Waiting for doc workers to finish...");
        self.doc_worker_tracker.wait().await;
        tracing::info!("All doc workers stopped");

        Ok(())
    }

    pub async fn serve(self, listener: TcpListener, redact_errors: bool) -> Result<()> {
        let s = Arc::new(self);
        let routes = s.routes_with_metrics();
        s.serve_internal(listener, redact_errors, routes).await
    }

    pub async fn serve_doc(self, listener: TcpListener, redact_errors: bool) -> Result<()> {
        let s = Arc::new(self);
        let routes = s.single_doc_routes_with_metrics();
        s.serve_internal(listener, redact_errors, routes).await
    }

    pub async fn serve_metrics(self, listener: TcpListener) -> Result<()> {
        let s = Arc::new(self);
        let routes = s.metrics_routes();
        s.serve_internal(listener, false, routes).await
    }

    async fn ensure_socket_doc_access(
        &self,
        doc_id: &str,
        authorization: Authorization,
    ) -> Result<(), AppError> {
        if !matches!(authorization, Authorization::Full) && !self.doc_exists(doc_id).await {
            return Err(AppError::new(
                StatusCode::NOT_FOUND,
                anyhow!("Doc {} not found", doc_id),
            ));
        }

        Ok(())
    }

    fn verify_doc_token(&self, token: Option<&str>, doc: &str) -> Result<Authorization, AppError> {
        if let Some(authenticator) = &self.authenticator {
            if let Some(token) = token {
                let authorization = authenticator
                    .verify_doc_token(token, doc, current_time_epoch_millis())
                    .map_err(|e| {
                        AppError::auth(StatusCode::UNAUTHORIZED, e.into(), "invalid_doc_token")
                    })?;
                Ok(authorization)
            } else {
                Err(AppError::auth(
                    StatusCode::UNAUTHORIZED,
                    anyhow!("No token provided."),
                    "missing_token",
                ))
            }
        } else {
            Ok(Authorization::Full)
        }
    }

    fn get_single_doc_id(&self) -> Result<String, AppError> {
        self.docs
            .iter()
            .next()
            .map(|entry| entry.key().clone())
            .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, anyhow!("No document found")))
    }
}

#[derive(Deserialize)]
struct HandlerParams {
    token: Option<String>,
}

async fn get_doc_as_update(
    State(server_state): State<Arc<Server>>,
    Path(doc_id): Path<String>,
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
) -> Result<Response, AppError> {
    // All authorization types allow reading the document.
    let token = get_token_from_header(auth_header);
    let _ = server_state.verify_doc_token(token.as_deref(), &doc_id)?;

    let dwskv = server_state
        .get_or_create_doc(&doc_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let update = dwskv.as_update();
    tracing::debug!("update: {:?}", update);
    Ok(update.into_response())
}

async fn get_doc_as_update_deprecated(
    Path(doc_id): Path<String>,
    State(server_state): State<Arc<Server>>,
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
) -> Result<Response, AppError> {
    tracing::warn!("/doc/:doc_id/as-update is deprecated; call /doc/:doc_id/auth instead and then call as-update on the returned base URL.");
    get_doc_as_update(State(server_state), Path(doc_id), auth_header).await
}

async fn update_doc_deprecated(
    Path(doc_id): Path<String>,
    State(server_state): State<Arc<Server>>,
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
    body: Bytes,
) -> Result<Response, AppError> {
    tracing::warn!("/doc/:doc_id/update is deprecated; call /doc/:doc_id/auth instead and then call update on the returned base URL.");
    update_doc(Path(doc_id), State(server_state), auth_header, body).await
}

async fn get_doc_as_update_single(
    State(server_state): State<Arc<Server>>,
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
) -> Result<Response, AppError> {
    let doc_id = server_state.get_single_doc_id()?;
    get_doc_as_update(State(server_state), Path(doc_id), auth_header).await
}

async fn update_doc(
    Path(doc_id): Path<String>,
    State(server_state): State<Arc<Server>>,
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
    body: Bytes,
) -> Result<Response, AppError> {
    let token = get_token_from_header(auth_header);
    let authorization = server_state.verify_doc_token(token.as_deref(), &doc_id)?;
    update_doc_inner(doc_id, server_state, authorization, body).await
}

async fn update_doc_inner(
    doc_id: String,
    server_state: Arc<Server>,
    authorization: Authorization,
    body: Bytes,
) -> Result<Response, AppError> {
    if !matches!(authorization, Authorization::Full) {
        return Err(AppError::auth(
            StatusCode::FORBIDDEN,
            anyhow!("Unauthorized."),
            "insufficient_permissions",
        ));
    }

    let dwskv = server_state
        .get_or_create_doc(&doc_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    if let Err(err) = dwskv.apply_update(&body) {
        tracing::error!(?err, "Failed to apply update");
        return Err(AppError::new(StatusCode::INTERNAL_SERVER_ERROR, err));
    }

    Ok(StatusCode::OK.into_response())
}

async fn update_doc_single(
    State(server_state): State<Arc<Server>>,
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
    body: Bytes,
) -> Result<Response, AppError> {
    let doc_id = server_state.get_single_doc_id()?;
    let token = get_token_from_header(auth_header);
    let authorization = server_state.verify_doc_token(token.as_deref(), &doc_id)?;
    update_doc_inner(doc_id, server_state, authorization, body).await
}

async fn handle_socket_upgrade(
    ws: WebSocketUpgrade,
    Path(doc_id): Path<String>,
    authorization: Authorization,
    State(server_state): State<Arc<Server>>,
) -> Result<Response, AppError> {
    handle_socket_upgrade_with_channel(ws, Path(doc_id), authorization, None, State(server_state))
        .await
}

async fn handle_socket_upgrade_with_channel(
    ws: WebSocketUpgrade,
    Path(doc_id): Path<String>,
    authorization: Authorization,
    routing_channel: Option<String>,
    State(server_state): State<Arc<Server>>,
) -> Result<Response, AppError> {
    handle_socket_upgrade_with_channel_and_user(
        ws,
        Path(doc_id),
        authorization,
        routing_channel,
        None,
        None, // No token available at this level
        State(server_state),
    )
    .await
}

async fn handle_socket_upgrade_with_channel_and_user(
    ws: WebSocketUpgrade,
    Path(doc_id): Path<String>,
    authorization: Authorization,
    routing_channel: Option<String>,
    user: Option<String>,
    token: Option<String>,
    State(server_state): State<Arc<Server>>,
) -> Result<Response, AppError> {
    server_state
        .ensure_socket_doc_access(&doc_id, authorization)
        .await?;

    // Extract expiration time from token
    let expiration_time = if let Some(authenticator) = &server_state.authenticator {
        if let Some(token_str) = token.as_deref() {
            authenticator
                .decode_token(token_str)
                .ok()
                .and_then(|payload| payload.expiration_millis)
                .map(|exp| exp.0)
        } else {
            None
        }
    } else {
        None
    };

    let user_for_pud = user.clone();
    let dwskv = server_state
        .get_or_create_doc_with_channel_and_user(&doc_id, routing_channel, user)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let awareness = dwskv.awareness();
    let sync_kv = dwskv.sync_kv();
    let cancellation_token = server_state.cancellation_token.clone();
    let sync_protocol_event_sender = server_state.sync_protocol_event_sender.clone();
    let metrics = server_state.metrics.clone();
    let doc_id_clone = doc_id.clone();

    Ok(ws.on_upgrade(move |socket| {
        handle_socket(
            socket,
            awareness,
            sync_kv,
            authorization,
            expiration_time,
            user_for_pud,
            cancellation_token,
            sync_protocol_event_sender,
            doc_id_clone,
            metrics,
        )
    }))
}

fn verify_socket_token(
    server_state: &Arc<Server>,
    doc_id: &str,
    token: Option<&str>,
) -> Result<(Authorization, Option<String>, Option<String>), AppError> {
    let (permission, channel) = if let Some(authenticator) = &server_state.authenticator {
        let token = token.ok_or_else(|| {
            AppError::auth(
                StatusCode::UNAUTHORIZED,
                anyhow!("No token provided."),
                "missing_token",
            )
        })?;

        authenticator
            .verify_token_with_channel(token, current_time_epoch_millis())
            .map_err(|e| {
                tracing::debug!("Token verification failed: {:?}", e);
                AppError::auth(StatusCode::UNAUTHORIZED, e.into(), "invalid_token")
            })?
    } else {
        (Permission::Server, None)
    };

    let (authorization, user) = match permission {
        Permission::Doc(doc_perm) => {
            if doc_perm.doc_id != doc_id {
                return Err(AppError::auth(
                    StatusCode::FORBIDDEN,
                    anyhow!("Token not valid for this document"),
                    "access_wrong_document",
                ));
            }
            (doc_perm.authorization, doc_perm.user)
        }
        Permission::Server => (Authorization::Full, None),
        Permission::Prefix(prefix_perm) => {
            if !doc_id.starts_with(&prefix_perm.prefix) {
                return Err(AppError::auth(
                    StatusCode::FORBIDDEN,
                    anyhow!("Token not valid for this document"),
                    "prefix_mismatch",
                ));
            }
            (prefix_perm.authorization, prefix_perm.user)
        }
        Permission::File(_) => {
            return Err(AppError::auth(
                StatusCode::FORBIDDEN,
                anyhow!("File token not valid for document access"),
                "wrong_token_type",
            ));
        }
    };

    Ok((authorization, channel, user))
}

async fn handle_socket_upgrade_deprecated(
    ws: WebSocketUpgrade,
    Path(doc_id): Path<String>,
    Query(params): Query<HandlerParams>,
    State(server_state): State<Arc<Server>>,
) -> Result<Response, AppError> {
    tracing::warn!(
        "/doc/ws/:doc_id is deprecated; call /doc/:doc_id/auth instead and use the returned URL."
    );
    let (authorization, channel, user) =
        verify_socket_token(&server_state, &doc_id, params.token.as_deref())?;

    handle_socket_upgrade_with_channel_and_user(
        ws,
        Path(doc_id),
        authorization,
        channel,
        user,
        params.token.clone(), // Pass the token from query params
        State(server_state),
    )
    .await
}

async fn handle_socket_upgrade_full_path(
    ws: WebSocketUpgrade,
    Path((doc_id, doc_id2)): Path<(String, String)>,
    Query(params): Query<HandlerParams>,
    State(server_state): State<Arc<Server>>,
) -> Result<Response, AppError> {
    tracing::debug!("WebSocket upgrade request for doc: {}", doc_id);

    if doc_id != doc_id2 {
        tracing::debug!("Doc ID mismatch: {} != {}", doc_id, doc_id2);
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            anyhow!("For Yjs compatibility, the doc_id appears twice in the URL. It must be the same in both places, but we got {} and {}.", doc_id, doc_id2),
        ));
    }

    let (authorization, channel, user) =
        verify_socket_token(&server_state, &doc_id, params.token.as_deref())?;

    handle_socket_upgrade_with_channel_and_user(
        ws,
        Path(doc_id),
        authorization,
        channel,
        user,
        params.token.clone(), // Pass the token from query params
        State(server_state),
    )
    .await
}

async fn handle_socket_upgrade_single(
    ws: WebSocketUpgrade,
    Path(doc_id): Path<String>,
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
    State(server_state): State<Arc<Server>>,
) -> Result<Response, AppError> {
    let single_doc_id = server_state.get_single_doc_id()?;
    if doc_id != single_doc_id {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            anyhow!("Document not found"),
        ));
    }

    let token = get_token_from_header(auth_header);
    let authorization = server_state.verify_doc_token(token.as_deref(), &doc_id)?;
    handle_socket_upgrade(ws, Path(single_doc_id), authorization, State(server_state)).await
}

async fn handle_socket(
    socket: WebSocket,
    awareness: Arc<RwLock<Awareness>>,
    sync_kv: Arc<SyncKv>,
    authorization: Authorization,
    expiration_time: Option<u64>,
    user: Option<String>,
    cancellation_token: CancellationToken,
    sync_protocol_event_sender: Arc<SyncProtocolEventSender>,
    doc_id: String,
    metrics: Arc<RelayMetrics>,
) {
    let (mut sink, mut stream) = socket.split();
    let (send, mut recv) = channel(1024);

    tokio::spawn(async move {
        while let Some(msg) = recv.recv().await {
            let _ = sink.send(msg).await;
        }
    });

    let send_clone = send.clone();
    let mut conn = DocConnection::new_with_expiration(
        awareness,
        authorization,
        expiration_time,
        move |bytes| {
            if let Err(e) = send_clone.try_send(Message::Binary(bytes.to_vec())) {
                tracing::warn!(?e, "Error sending message");
            }
        },
    );
    conn.set_sync_kv(sync_kv);
    if let Some(user) = user {
        conn.set_user(user);
    }
    let connection = Arc::new(conn);

    // Register the connection with the sync protocol event sender
    sync_protocol_event_sender.register_doc_connection(doc_id.clone(), Arc::downgrade(&connection));

    loop {
        tokio::select! {
            Some(msg) = stream.next() => {
                let msg = match msg {
                    Ok(Message::Binary(bytes)) => bytes,
                    Ok(Message::Close(_)) => break,
                    Err(_e) => {
                        // The stream will complain about things like
                        // connections being lost without handshake.
                        continue;
                    }
                    msg => {
                        tracing::warn!(?msg, "Received non-binary message");
                        continue;
                    }
                };

                match connection.send(&msg).await {
                    Ok(_) => {},
                    Err(e) if e.to_string().contains("Token expired") => {
                        metrics.record_http_auth_error(
                            "expired",
                            "1008",
                            "websocket_connection",
                            "WS",
                        );
                        tracing::warn!(
                            doc_id = %doc_id,
                            "Closing connection due to token expiration"
                        );
                        let _ = send.try_send(Message::Close(Some(CloseFrame {
                            code: 1008, // Policy Violation - indicates a policy violation
                            reason: "Token expired".into(),
                        })));
                        break;
                    }
                    Err(e) => {
                        tracing::warn!(?e, "Error handling message");
                    }
                }
            }
            _ = cancellation_token.cancelled() => {
                tracing::debug!("Closing doc connection due to server cancel...");
                break;
            }
        }
    }
}

async fn check_store(
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
    State(server_state): State<Arc<Server>>,
) -> Result<Json<Value>, AppError> {
    server_state.check_auth(auth_header)?;

    if server_state.store.is_none() {
        return Ok(Json(json!({"ok": false, "error": "No store set."})));
    };

    // The check_store endpoint for the native server is kind of moot, since
    // the server will not start if store is not ok.
    Ok(Json(json!({"ok": true})))
}

async fn check_store_deprecated(
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
    State(server_state): State<Arc<Server>>,
) -> Result<Json<Value>, AppError> {
    tracing::warn!(
        "GET check_store is deprecated, use POST check_store with an empty body instead."
    );
    check_store(auth_header, State(server_state)).await
}

#[derive(serde::Serialize)]
struct ReadyResponse {
    ok: bool,
    workers: Vec<WorkerReadiness>,
}

#[derive(serde::Serialize)]
struct WorkerReadiness {
    name: String,
    alive: bool,
    panics_in_window: u32,
}

/// Always returns 200 OK as long as the process is listening. The body
/// reports per-worker liveness so operators can distinguish "process up
/// but a worker has died" from "fully healthy". `ok` is true iff every
/// registered worker is still alive; an empty worker set is vacuously OK.
async fn ready(State(server): State<Arc<Server>>) -> Json<ReadyResponse> {
    let workers: Vec<WorkerReadiness> = server
        .worker_status
        .snapshot()
        .into_iter()
        .map(|(name, alive, panics_in_window)| WorkerReadiness {
            name: name.to_string(),
            alive,
            panics_in_window,
        })
        .collect();
    let ok = workers.iter().all(|w| w.alive);
    Json(ReadyResponse { ok, workers })
}

async fn handle_open_by_path(
    State(server_state): State<Arc<Server>>,
    Path(path): Path<String>,
    request: Request,
) -> Result<Response, AppError> {
    // Fall back to filemeta_v0 (the source of truth) when the eventually-
    // consistent resolver doesn't know the path yet — e.g. a just-created file.
    let resolved = server_state.doc_resolver().resolve_path(&path).or_else(|| {
        let info = server_state.resolve_path_via_filemeta(&path)?;
        tracing::warn!(
            requested_path = %path,
            uuid = %info.uuid,
            folder = %info.folder_name,
            "open: doc_resolver stale — path missing from resolver but present in filemeta_v0; using filemeta fallback"
        );
        Some(info)
    });
    match resolved {
        Some(info) => {
            let short_uuid = &info.uuid[..8.min(info.uuid.len())];
            let encoded_path = path.replace(' ', "-");
            let mut redirect_url = format!("/{}/{}", short_uuid, encoded_path);
            if let Some(query) = request.uri().query() {
                redirect_url.push('?');
                redirect_url.push_str(query);
            }
            Ok(axum::response::Redirect::temporary(&redirect_url).into_response())
        }
        None => Err(AppError::new(
            StatusCode::NOT_FOUND,
            anyhow!("No document found at path '{}'", path),
        )),
    }
}

/// 503 until the given index has finished its startup build.
fn require_index_ready(ready: &std::sync::atomic::AtomicBool, what: &str) -> Result<(), AppError> {
    if ready.load(std::sync::atomic::Ordering::Acquire) {
        Ok(())
    } else {
        Err(AppError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            anyhow!("{} is being built, please try again shortly", what),
        ))
    }
}

async fn handle_search(
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
    State(server_state): State<Arc<Server>>,
    Query(params): Query<SearchQuery>,
) -> Result<Json<Value>, AppError> {
    server_state.check_auth(auth_header)?;
    require_index_ready(&server_state.search_ready, "Search index")?;

    let limit = params.limit.min(100); // Cap at 100
    let q = params.q.trim().to_string();

    if q.is_empty() {
        return Ok(Json(json!({
            "results": [],
            "total_hits": 0,
            "query": ""
        })));
    }

    let search_index = server_state.search_index.clone().ok_or_else(|| {
        AppError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            anyhow!("Search index not available"),
        )
    })?;

    // Run search in blocking context (tantivy is sync)
    let results = tokio::task::spawn_blocking(move || search_index.search(&q, limit))
        .await
        .map_err(|e| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, e.into()))?
        .map_err(|e| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let total_hits = results.len();
    Ok(Json(json!({
        "results": results,
        "total_hits": total_hits,
        "query": params.q
    })))
}

async fn handle_folder_name(
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
    State(server_state): State<Arc<Server>>,
    Path(folder_uuid): Path<String>,
) -> Result<Json<Value>, AppError> {
    server_state.check_auth(auth_header)?;
    match server_state.folder_name_for_uuid(&folder_uuid) {
        Some(name) => Ok(Json(json!({ "name": name }))),
        None => Err(AppError::new(
            StatusCode::NOT_FOUND,
            anyhow!("Folder '{}' not found", folder_uuid),
        )),
    }
}

/// List CriticMarkup suggestions for all documents in a folder.
///
/// GET /suggestions?folder_id=...
/// Response: { "files": [{ "path": "...", "doc_id": "...", "suggestions": [...] }] }
///
/// Answers from the in-memory suggestions index — it must NOT load content
/// docs on demand. The previous per-request full-folder scan loaded every doc
/// from storage and triggered the 2026-07-02 prod hang (see
/// docs/plans/2026-07-02-suggestions-index.md).
async fn handle_suggestions(
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
    State(server_state): State<Arc<Server>>,
    Query(params): Query<SuggestionsQuery>,
) -> Result<Json<Value>, AppError> {
    server_state.check_auth(auth_header)?;
    require_index_ready(&server_state.suggestions_ready, "Suggestions index")?;

    let folder_id = &params.folder_id;

    // Load the folder doc and get content UUIDs from filemeta_v0
    server_state
        .ensure_doc_loaded(folder_id)
        .await
        .map_err(|e| AppError::new(StatusCode::NOT_FOUND, anyhow!("Folder not found: {}", e)))?;

    let content_uuids = link_indexer::is_folder_doc(folder_id, &server_state.docs)
        .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, anyhow!("Not a folder document")))?;

    // Get path mapping from filemeta_v0
    let path_map = {
        let doc_ref = server_state.docs.get(folder_id).ok_or_else(|| {
            AppError::new(StatusCode::NOT_FOUND, anyhow!("Folder doc not loaded"))
        })?;
        let awareness = doc_ref.awareness();
        let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
        let txn = guard.doc.transact();
        let filemeta = txn
            .get_map("filemeta_v0")
            .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, anyhow!("No filemeta_v0")))?;
        let mut map = std::collections::HashMap::new();
        for (path, value) in filemeta.iter(&txn) {
            if let Some(id) = link_indexer::extract_id_from_filemeta_entry(&value, &txn) {
                map.insert(id, path.to_string());
            }
        }
        map
    };

    // relay_id = first 36 chars of compound folder_id
    if folder_id.len() < 36 {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            anyhow!("Invalid folder_id"),
        ));
    }
    let relay_id = &folder_id[..36];

    let mut files = Vec::new();

    // Stale index entries for docs deleted from the folder are filtered
    // naturally: only UUIDs currently in filemeta_v0 are consulted.
    for content_uuid in &content_uuids {
        let Some(suggestions) = server_state.suggestions_index.get(content_uuid) else {
            continue;
        };
        let doc_id = format!("{}-{}", relay_id, content_uuid);
        let path = path_map
            .get(content_uuid)
            .cloned()
            .unwrap_or_else(|| content_uuid.clone());

        files.push(serde_json::json!({
            "path": path,
            "doc_id": doc_id,
            "suggestions": suggestions,
        }));
    }

    Ok(Json(serde_json::json!({ "files": files })))
}

/// Move a document to a new path within or across folders.
///
/// POST /doc/move
/// Body: { "uuid": "...", "new_path": "/Biology/Photosynthesis.md", "target_folder": "Lens Edu" }
/// Response: { "old_path", "new_path", "old_folder", "new_folder", "links_rewritten" }
async fn handle_move_document(
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
    State(server_state): State<Arc<Server>>,
    Json(body): Json<MoveDocRequest>,
) -> Result<Json<MoveDocResponse>, AppError> {
    server_state.check_auth(auth_header)?;
    let result = server_state
        .move_document(&body.uuid, &body.new_path, body.target_folder.as_deref())
        .await
        .map_err(AppError::from)?;

    Ok(Json(MoveDocResponse {
        old_path: result.old_path,
        new_path: result.new_path,
        old_folder: result.old_folder_name,
        new_folder: result.new_folder_name,
        links_rewritten: result.links_rewritten,
    }))
}

/// Move a document or rename a folder by user-facing path.
///
/// POST /move
/// Body: { "path": "Lens/Old.md", "new_path": "/New.md", "target_folder": "Lens Edu" }
/// Response: { "old_path", "new_path", "old_folder", "new_folder", "links_rewritten" }
async fn handle_move_path(
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
    State(server_state): State<Arc<Server>>,
    Json(body): Json<MovePathRequest>,
) -> Result<Json<MoveDocResponse>, AppError> {
    server_state.check_auth(auth_header)?;
    let result = server_state
        .move_path(&body.path, &body.new_path, body.target_folder.as_deref())
        .await
        .map_err(|e| {
            // Move failures are returned to the client with an empty body, so
            // without this they are invisible in the logs.
            tracing::warn!(
                path = %body.path,
                new_path = %body.new_path,
                target_folder = ?body.target_folder,
                error = ?e,
                "move_path request failed"
            );
            AppError::from(e)
        })?;

    Ok(Json(MoveDocResponse {
        old_path: result.old_path,
        new_path: result.new_path,
        old_folder: result.old_folder_name,
        new_folder: result.new_folder_name,
        links_rewritten: result.links_rewritten,
    }))
}

/// POST /doc/upsert
/// Creates a document if it doesn't exist, or replaces its content if it does.
/// No CriticMarkup wrapping — content is written directly to Y.Text.
/// Accepts any file extension; uses "file" type for non-.md, "markdown" for .md.
#[derive(Deserialize)]
struct UpsertDocRequest {
    folder: String,
    path: String,
    content: String,
}

#[derive(Serialize)]
struct UpsertDocResponse {
    doc_id: String,
    path: String,
    created: bool,
}

async fn handle_upsert_document(
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
    State(server_state): State<Arc<Server>>,
    Json(body): Json<UpsertDocRequest>,
) -> Result<Json<UpsertDocResponse>, AppError> {
    server_state.check_auth(auth_header)?;

    // Ensure path starts with /
    let path = if body.path.starts_with('/') {
        body.path.clone()
    } else {
        format!("/{}", body.path)
    };

    let is_blob = path.to_ascii_lowercase().ends_with(".json");

    if is_blob {
        // JSON files → blob storage (create-only, no updates)
        match server_state
            .create_blob_file(
                &body.folder,
                &path,
                body.content.as_bytes(),
                "application/json",
            )
            .await
        {
            Ok(result) => Ok(Json(UpsertDocResponse {
                doc_id: result.full_doc_id,
                path: format!("{}{}", body.folder, path),
                created: true,
            })),
            Err(CreateDocumentError::Conflict(msg)) => {
                Err(AppError::new(StatusCode::CONFLICT, anyhow!("{}", msg)))
            }
            Err(CreateDocumentError::NotFound(msg)) => {
                Err(AppError::new(StatusCode::NOT_FOUND, anyhow!("{}", msg)))
            }
            Err(CreateDocumentError::BadRequest(msg)) => {
                Err(AppError::new(StatusCode::BAD_REQUEST, anyhow!("{}", msg)))
            }
            Err(e) => Err(AppError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                anyhow!("{}", e),
            )),
        }
    } else {
        // Markdown/other → Y.Doc (existing behavior with upsert semantics)
        match server_state
            .create_document_direct(&body.folder, &path, &body.content, None)
            .await
        {
            Ok(result) => Ok(Json(UpsertDocResponse {
                doc_id: result.full_doc_id,
                path: format!("{}{}", body.folder, path),
                created: true,
            })),
            Err(CreateDocumentError::Conflict(_)) => {
                // Already exists — update content instead
                server_state
                    .write_document_content(&body.folder, &path, &body.content)
                    .await
                    .map_err(|e| {
                        AppError::new(StatusCode::INTERNAL_SERVER_ERROR, anyhow!("{}", e))
                    })?;
                Ok(Json(UpsertDocResponse {
                    doc_id: String::new(),
                    path: format!("{}{}", body.folder, path),
                    created: false,
                }))
            }
            Err(CreateDocumentError::NotFound(msg)) => {
                Err(AppError::new(StatusCode::NOT_FOUND, anyhow!("{}", msg)))
            }
            Err(CreateDocumentError::BadRequest(msg)) => {
                Err(AppError::new(StatusCode::BAD_REQUEST, anyhow!("{}", msg)))
            }
            Err(e) => Err(AppError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                anyhow!("{}", e),
            )),
        }
    }
}

#[derive(Deserialize)]
struct CheckDocsRequest {
    folder: String,
    paths: Vec<String>,
}

#[derive(Serialize)]
struct CheckDocsResponse {
    exists: std::collections::HashMap<String, bool>,
}

async fn handle_check_documents(
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
    State(server_state): State<Arc<Server>>,
    Json(body): Json<CheckDocsRequest>,
) -> Result<Json<CheckDocsResponse>, AppError> {
    server_state.check_auth(auth_header)?;

    let docs = server_state.docs();
    let folder_doc_ids = link_indexer::find_all_folder_docs(docs);

    // Find the matching folder doc
    let mut folder_doc_id: Option<String> = None;
    for fid in &folder_doc_ids {
        let awareness = {
            let Some(doc_ref) = docs.get(fid) else {
                continue;
            };
            doc_ref.awareness()
        };
        let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
        let name = y_sweet_core::doc_resolver::read_folder_name(&guard.doc, fid);
        if name == body.folder {
            folder_doc_id = Some(fid.clone());
            break;
        }
    }

    let Some(folder_doc_id) = folder_doc_id else {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            anyhow!("Unknown folder '{}'", body.folder),
        ));
    };

    // Read filemeta_v0 once, check all paths
    let awareness = {
        let Some(doc_ref) = docs.get(&folder_doc_id) else {
            return Err(AppError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                anyhow!("Folder doc not loaded"),
            ));
        };
        doc_ref.awareness()
    };
    let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
    let txn = guard.doc.transact();

    let mut exists = std::collections::HashMap::new();
    let filemeta = txn.get_map("filemeta_v0");
    for path in &body.paths {
        let normalized = if path.starts_with('/') {
            path.clone()
        } else {
            format!("/{}", path)
        };
        let found = filemeta
            .as_ref()
            .map(|fm| fm.get(&txn, normalized.as_str()).is_some())
            .unwrap_or(false);
        exists.insert(path.clone(), found);
    }

    Ok(Json(CheckDocsResponse { exists }))
}

#[derive(Deserialize)]
struct CheckVideoIdsRequest {
    folder: String,
    subfolder: Option<String>,
    video_ids: Vec<String>,
}

#[derive(Serialize)]
struct CheckVideoIdsResponse {
    found: std::collections::HashMap<String, Option<String>>,
}

async fn handle_check_video_ids(
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
    State(server_state): State<Arc<Server>>,
    Json(body): Json<CheckVideoIdsRequest>,
) -> Result<Json<CheckVideoIdsResponse>, AppError> {
    server_state.check_auth(auth_header)?;

    let prefix = match &body.subfolder {
        Some(sub) => format!("{}/{}/", body.folder, sub),
        None => format!("{}/", body.folder),
    };

    let all_paths = server_state.doc_resolver().all_paths();
    let matching_paths: Vec<String> = all_paths
        .into_iter()
        .filter(|p| p.starts_with(&prefix) && p.ends_with(".md"))
        .collect();

    let mut found: std::collections::HashMap<String, Option<String>> =
        body.video_ids.iter().map(|id| (id.clone(), None)).collect();

    for path in &matching_paths {
        if found.values().all(|v| v.is_some()) {
            break;
        }

        let doc_id = match server_state.doc_resolver().resolve_path(path) {
            Some(doc_info) => doc_info.doc_id,
            None => continue,
        };

        if server_state.ensure_doc_loaded(&doc_id).await.is_err() {
            continue;
        }

        let content = match read_doc_head(&server_state, &doc_id, 500) {
            Some(c) => c,
            None => continue,
        };

        let rel_path = format!("/{}", &path[body.folder.len()..].trim_start_matches('/'));

        for (video_id, slot) in found.iter_mut() {
            if slot.is_none()
                && (content.contains(&format!("watch?v={}", video_id))
                    || content.contains(&format!("/shorts/{}", video_id)))
            {
                *slot = Some(rel_path.clone());
            }
        }
    }

    Ok(Json(CheckVideoIdsResponse { found }))
}

/// Read up to `max_bytes` (rounded down to a UTF-8 char boundary) of a loaded
/// doc's `contents` Y.Text. The caller must have ensured the doc is loaded.
/// Returns None when the doc is not present in the store.
fn read_doc_head(server_state: &Arc<Server>, doc_id: &str, max_bytes: usize) -> Option<String> {
    let doc_ref = server_state.docs().get(doc_id)?;
    let awareness = doc_ref.awareness();
    drop(doc_ref);
    let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
    let txn = guard.doc.transact();
    let full = txn
        .get_text("contents")
        .map(|t| t.get_string(&txn))
        .unwrap_or_default();
    if full.len() <= max_bytes {
        return Some(full);
    }
    let mut end = max_bytes;
    while end > 0 && !full.is_char_boundary(end) {
        end -= 1;
    }
    Some(full[..end].to_string())
}

/// Extract the `source_url` value from a markdown doc's YAML frontmatter head
/// (the block between the leading `---` fences). Returns None if absent.
fn extract_frontmatter_source_url(head: &str) -> Option<String> {
    let mut in_frontmatter = false;
    for line in head.lines() {
        let trimmed = line.trim_end();
        if trimmed == "---" {
            if in_frontmatter {
                break; // closing fence — not in frontmatter
            }
            in_frontmatter = true;
            continue;
        }
        if in_frontmatter {
            if let Some(rest) = trimmed.trim_start().strip_prefix("source_url:") {
                let value = rest.trim().trim_matches('"').trim();
                return (!value.is_empty()).then(|| value.to_string());
            }
        }
    }
    None
}

/// Normalize a source URL for dedup comparison: trim whitespace and a trailing
/// slash (the common variant). Intentionally conservative — scheme/host case and
/// query strings are left intact so genuinely different URLs aren't merged.
fn normalize_source_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

#[derive(Deserialize)]
struct CheckSourceUrlsRequest {
    folder: String,
    subfolder: Option<String>,
    source_urls: Vec<String>,
}

#[derive(Serialize)]
struct CheckSourceUrlsResponse {
    found: std::collections::HashMap<String, Option<String>>,
}

/// For each given source URL, find an existing article doc whose `source_url`
/// frontmatter matches (normalized) — the URL-based duplicate check the
/// add-article importer uses. Mirrors `handle_check_video_ids`, but matches the
/// frontmatter field precisely rather than substring-scanning the body.
async fn handle_check_source_urls(
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
    State(server_state): State<Arc<Server>>,
    Json(body): Json<CheckSourceUrlsRequest>,
) -> Result<Json<CheckSourceUrlsResponse>, AppError> {
    server_state.check_auth(auth_header)?;

    let prefix = match &body.subfolder {
        Some(sub) => format!("{}/{}/", body.folder, sub),
        None => format!("{}/", body.folder),
    };

    let matching_paths: Vec<String> = server_state
        .doc_resolver()
        .all_paths()
        .into_iter()
        .filter(|p| p.starts_with(&prefix) && p.ends_with(".md"))
        .collect();

    let queries: Vec<(String, String)> = body
        .source_urls
        .iter()
        .map(|u| (u.clone(), normalize_source_url(u)))
        .collect();
    let mut found: std::collections::HashMap<String, Option<String>> =
        body.source_urls.iter().map(|u| (u.clone(), None)).collect();

    for path in &matching_paths {
        if found.values().all(|v| v.is_some()) {
            break;
        }
        let doc_id = match server_state.doc_resolver().resolve_path(path) {
            Some(info) => info.doc_id,
            None => continue,
        };
        if server_state.ensure_doc_loaded(&doc_id).await.is_err() {
            continue;
        }
        let head = match read_doc_head(&server_state, &doc_id, 4000) {
            Some(h) => h,
            None => continue,
        };
        let stored = match extract_frontmatter_source_url(&head) {
            Some(s) => normalize_source_url(&s),
            None => continue,
        };
        let rel_path = format!("/{}", &path[body.folder.len()..].trim_start_matches('/'));
        for (orig, norm) in &queries {
            if *norm == stored {
                if let Some(slot) = found.get_mut(orig) {
                    if slot.is_none() {
                        *slot = Some(rel_path.clone());
                    }
                }
            }
        }
    }

    Ok(Json(CheckSourceUrlsResponse { found }))
}

#[derive(Deserialize)]
struct AttachmentQuery {
    folder: String,
    path: String,
    mimetype: Option<String>,
}

/// Create a binary attachment (e.g. an image extracted from an imported PDF) as
/// a relay blob + `filemeta_v0` entry, so markdown can reference it
/// (`![[/attachments/x.png]]`). Raw bytes in the body; folder/path/mimetype in
/// the query. Create-only: an existing path is treated as already-hosted.
async fn handle_upsert_attachment(
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
    State(server_state): State<Arc<Server>>,
    Query(query): Query<AttachmentQuery>,
    body: axum::body::Bytes,
) -> Result<Json<UpsertDocResponse>, AppError> {
    server_state.check_auth(auth_header)?;

    let path = if query.path.starts_with('/') {
        query.path.clone()
    } else {
        format!("/{}", query.path)
    };
    let mimetype = query
        .mimetype
        .as_deref()
        .unwrap_or("application/octet-stream");

    match server_state
        .create_blob_file(&query.folder, &path, &body, mimetype)
        .await
    {
        Ok(result) => Ok(Json(UpsertDocResponse {
            doc_id: result.full_doc_id,
            path: format!("{}{}", query.folder, path),
            created: true,
        })),
        // Already hosted at this path — idempotent success.
        Err(CreateDocumentError::Conflict(_)) => Ok(Json(UpsertDocResponse {
            doc_id: String::new(),
            path: format!("{}{}", query.folder, path),
            created: false,
        })),
        Err(CreateDocumentError::NotFound(msg)) => {
            Err(AppError::new(StatusCode::NOT_FOUND, anyhow!("{}", msg)))
        }
        Err(CreateDocumentError::BadRequest(msg)) => {
            Err(AppError::new(StatusCode::BAD_REQUEST, anyhow!("{}", msg)))
        }
        Err(e) => Err(AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            anyhow!("{:?}", e),
        )),
    }
}

async fn new_doc(
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
    State(server_state): State<Arc<Server>>,
    Json(body): Json<DocCreationRequest>,
) -> Result<Json<NewDocResponse>, AppError> {
    let token = get_token_from_header(auth_header);

    if let Some(authenticator) = &server_state.authenticator {
        if let Some(token) = token.as_deref() {
            // First try server token
            if authenticator
                .verify_server_token(token, current_time_epoch_millis())
                .is_ok()
            {
                // Server token allows creating any document
            } else {
                // Try prefix token - we need to check if the doc_id matches the prefix
                if let Some(doc_id) = &body.doc_id {
                    let permission = authenticator
                        .verify_token_auto(token, current_time_epoch_millis())
                        .map_err(|auth_error| {
                            AppError::auth(
                                StatusCode::UNAUTHORIZED,
                                anyhow!("Invalid token: {}", auth_error),
                                auth_error.to_metric_label(),
                            )
                        })?;

                    match permission {
                        Permission::Prefix(prefix_perm) => {
                            // Check if the document ID starts with the prefix
                            if !doc_id.starts_with(&prefix_perm.prefix) {
                                return Err(AppError::auth(
                                    StatusCode::FORBIDDEN,
                                    anyhow!(
                                        "Document ID '{}' does not match prefix '{}'",
                                        doc_id,
                                        prefix_perm.prefix
                                    ),
                                    "prefix_mismatch",
                                ));
                            }
                            // Check if we have Full permissions (needed for creation)
                            if prefix_perm.authorization != Authorization::Full {
                                return Err(AppError::auth(
                                    StatusCode::FORBIDDEN,
                                    anyhow!("Prefix token requires Full authorization to create documents"),
                                    "insufficient_permissions",
                                ));
                            }
                        }
                        _ => {
                            return Err(AppError::auth(
                                StatusCode::FORBIDDEN,
                                anyhow!("Only server or prefix tokens can create documents"),
                                "wrong_token_type",
                            ));
                        }
                    }
                } else {
                    // No doc_id provided - only server tokens can create with auto-generated ID
                    return Err(AppError::auth(
                        StatusCode::FORBIDDEN,
                        anyhow!("Prefix tokens must specify a docId that matches their prefix"),
                        "wrong_token_type",
                    ));
                }
            }
        } else {
            return Err(AppError::auth(
                StatusCode::UNAUTHORIZED,
                anyhow!("No token provided"),
                "missing_token",
            ));
        }
    }

    let doc_id = if let Some(doc_id) = body.doc_id {
        if !validate_doc_name(doc_id.as_str()) {
            Err((StatusCode::BAD_REQUEST, anyhow!("Invalid document name")))?
        }

        server_state
            .get_or_create_doc(doc_id.as_str())
            .await
            .map_err(|e| {
                tracing::error!(?e, "Failed to create doc");
                (StatusCode::INTERNAL_SERVER_ERROR, e)
            })?;

        doc_id
    } else {
        server_state.create_doc().await.map_err(|d| {
            tracing::error!(?d, "Failed to create doc");
            (StatusCode::INTERNAL_SERVER_ERROR, d)
        })?
    };

    Ok(Json(NewDocResponse { doc_id }))
}

fn generate_base_url(
    url: &Option<Url>,
    allowed_hosts: &[AllowedHost],
    request_host: &str,
) -> Result<String, AppError> {
    // Priority 1: Explicit URL prefix
    if let Some(prefix) = url {
        return Ok(prefix.as_str().trim_end_matches('/').to_string());
    }

    // Priority 2: Context-derived URL from Host header
    if let Some(allowed) = allowed_hosts.iter().find(|h| h.host == request_host) {
        return Ok(format!("{}://{}", allowed.scheme, request_host));
    }

    // Priority 3: Fallback to old behavior for backward compatibility
    if allowed_hosts.is_empty() {
        return Ok(format!("http://{}", request_host));
    }

    // Reject unknown hosts when allowed_hosts is configured
    Err(AppError::new(
        StatusCode::BAD_REQUEST,
        anyhow!("Host '{}' not in allowed hosts list", request_host),
    ))
}

fn generate_context_aware_urls(
    url: &Option<Url>,
    allowed_hosts: &[AllowedHost],
    request_host: &str,
    doc_id: &str,
) -> Result<(String, String), AppError> {
    // Priority 1: Explicit URL prefix
    if let Some(prefix) = url {
        let ws_scheme = if prefix.scheme() == "https" {
            "wss"
        } else {
            "ws"
        };
        let mut ws_url = prefix.clone();
        ws_url.set_scheme(ws_scheme).unwrap();
        let ws_url = ws_url
            .join(&format!("/d/{}/ws", doc_id))
            .unwrap()
            .to_string();

        let base_url = format!("{}/d/{}", prefix.as_str().trim_end_matches('/'), doc_id);
        return Ok((ws_url, base_url));
    }

    // Priority 2: Context-derived URL from Host header
    if let Some(allowed) = allowed_hosts.iter().find(|h| h.host == request_host) {
        let ws_scheme = if allowed.scheme == "https" {
            "wss"
        } else {
            "ws"
        };
        let ws_url = format!("{}://{}/d/{}/ws", ws_scheme, request_host, doc_id);
        let base_url = format!("{}://{}/d/{}", allowed.scheme, request_host, doc_id);
        return Ok((ws_url, base_url));
    }

    // Priority 3: Fallback to old behavior for backward compatibility
    // This handles the case where no URL prefix and no allowed hosts are set
    if allowed_hosts.is_empty() {
        let ws_url = format!("ws://{}/d/{}/ws", request_host, doc_id);
        let base_url = format!("http://{}/d/{}", request_host, doc_id);
        return Ok((ws_url, base_url));
    }

    // Reject unknown hosts when allowed_hosts is configured
    Err(AppError::new(
        StatusCode::BAD_REQUEST,
        anyhow!("Host '{}' not in allowed hosts list", request_host),
    ))
}

async fn auth_doc(
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
    TypedHeader(host): TypedHeader<headers::Host>,
    State(server_state): State<Arc<Server>>,
    Path(doc_id): Path<String>,
    body: Option<Json<AuthDocRequest>>,
) -> Result<Json<ClientToken>, AppError> {
    server_state.check_auth(auth_header)?;

    let Json(AuthDocRequest {
        authorization,
        valid_for_seconds,
        ..
    }) = body.unwrap_or_default();

    if !server_state.doc_exists(&doc_id).await {
        Err((StatusCode::NOT_FOUND, anyhow!("Doc {} not found", doc_id)))?;
    }

    let valid_for_seconds = valid_for_seconds.unwrap_or(DEFAULT_EXPIRATION_SECONDS);
    let expiration_time =
        ExpirationTimeEpochMillis(current_time_epoch_millis() + valid_for_seconds * 1000);

    let token = if let Some(auth) = &server_state.authenticator {
        let token = auth
            .gen_doc_token_auto(&doc_id, authorization, expiration_time, None)
            .map_err(|e| {
                AppError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    anyhow!("Failed to generate token: {}", e),
                )
            })?;
        Some(token)
    } else {
        None
    };

    let (url, base_url) = generate_context_aware_urls(
        &server_state.url,
        &server_state.allowed_hosts,
        &host.to_string(),
        &doc_id,
    )?;

    Ok(Json(ClientToken {
        url,
        base_url: Some(base_url),
        doc_id,
        token,
        authorization,
    }))
}

async fn resolve_doc(
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
    State(server_state): State<Arc<Server>>,
    Path(prefix): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    server_state.check_auth(auth_header)?;

    match server_state.resolve_doc_id(&prefix).await {
        Some(doc_id) => Ok(Json(serde_json::json!({ "docId": doc_id }))),
        None => Err(AppError::new(
            StatusCode::NOT_FOUND,
            anyhow!("No unique doc matching prefix '{}'", prefix),
        )),
    }
}

async fn get_doc_folder(
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
    State(server_state): State<Arc<Server>>,
    Path(doc_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    server_state.check_auth(auth_header)?;

    // Extract the UUID portion from compound doc_id (relay_id-uuid)
    let uuid = link_indexer::parse_doc_id(&doc_id)
        .map(|(_, uuid)| uuid)
        .ok_or_else(|| AppError::new(StatusCode::BAD_REQUEST, anyhow!("Invalid doc_id format")))?;

    match server_state.doc_resolver().folder_uuid_for_doc(uuid) {
        Some(folder_uuid) => Ok(Json(serde_json::json!({ "folderUuid": folder_uuid }))),
        None => Err(AppError::new(
            StatusCode::NOT_FOUND,
            anyhow!("Document not found in any folder"),
        )),
    }
}

#[derive(Deserialize)]
struct DebugResolveQuery {
    path: String,
}

/// GET /debug/resolve?path=<folder>/<subpath>/<name>.md
///
/// Read-only diagnostic comparing the eventually-consistent `doc_resolver`
/// against `filemeta_v0` (the source of truth) for a single path. `stale: true`
/// means the file exists in filemeta but the resolver cannot resolve it at this
/// path — the condition that makes a rename fail with "Move failed: 400".
/// `resolver_path_for_uuid` shows where the resolver currently thinks the doc
/// lives (None = missing entirely; a different path = stale entry).
async fn handle_debug_resolve(
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
    State(server_state): State<Arc<Server>>,
    Query(params): Query<DebugResolveQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    server_state.check_auth(auth_header)?;

    let path = params.path;
    let resolver_hit = server_state.doc_resolver().resolve_path(&path);
    let filemeta_hit = server_state.resolve_path_via_filemeta(&path);
    let resolver_path_for_uuid = filemeta_hit
        .as_ref()
        .and_then(|i| server_state.doc_resolver().path_for_uuid(&i.uuid));

    Ok(Json(serde_json::json!({
        "path": path,
        "resolver_hit": resolver_hit.is_some(),
        "resolver_uuid": resolver_hit.as_ref().map(|i| i.uuid.clone()),
        "in_filemeta": filemeta_hit.is_some(),
        "filemeta_uuid": filemeta_hit.as_ref().map(|i| i.uuid.clone()),
        "filemeta_folder": filemeta_hit.as_ref().map(|i| i.folder_name.clone()),
        "resolver_path_for_uuid": resolver_path_for_uuid,
        "stale": filemeta_hit.is_some() && resolver_hit.is_none(),
    })))
}

fn get_token_from_header(
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
) -> Option<String> {
    if let Some(TypedHeader(headers::Authorization(bearer))) = auth_header {
        Some(bearer.token().to_string())
    } else {
        None
    }
}

async fn handle_file_upload_url(
    State(server_state): State<Arc<Server>>,
    Path(doc_id): Path<String>,
    TypedHeader(host): TypedHeader<headers::Host>,
    Query(params): Query<FileUploadQueryParams>,
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
) -> Result<Json<FileUploadUrlResponse>, AppError> {
    tracing::info!(doc_id = %doc_id, "Generating file upload URL");

    let token = get_token_from_header(auth_header);

    // Local dev fast path: no authenticator configured → accept any upload, validate by hash only.
    // Mirrors the unauthenticated blob-read route registered when authenticator.is_none().
    if server_state.authenticator.is_none() {
        let hash = params.hash.ok_or_else(|| {
            AppError::new(
                StatusCode::BAD_REQUEST,
                anyhow!("hash query parameter required"),
            )
        })?;
        if !validate_file_hash(&hash) {
            return Err(AppError::new(
                StatusCode::BAD_REQUEST,
                anyhow!("Invalid file hash format"),
            ));
        }
        let store = server_state.store.as_ref().ok_or_else(|| {
            AppError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                anyhow!("No store configured for file uploads"),
            )
        })?;
        let key = format!("files/{}/{}", doc_id, hash);
        let upload_url = store
            .generate_upload_url(&key, params.content_type.as_deref(), params.content_length)
            .await
            .map_err(|e| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, e.into()))?;
        let Some(url) = upload_url else {
            return Err(AppError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                anyhow!("Failed to generate upload URL"),
            ));
        };
        // For local filesystem store the URL is a relative path (/f/{doc}/upload).
        // Return it as-is so the caller can route it through their own proxy without
        // constructing an absolute http:// URL (which would cause mixed-content issues
        // when the client is on https).
        let response_url = if url.starts_with("http") {
            url
        } else {
            format!("{}?hash={}", url, hash)
        };
        return Ok(Json(FileUploadUrlResponse {
            upload_url: response_url,
        }));
    }

    let Some(authenticator) = &server_state.authenticator else {
        unreachable!("authenticator checked above")
    };

    let Some(token) = token.as_deref() else {
        return Err(AppError::auth(
            StatusCode::UNAUTHORIZED,
            anyhow!("No token provided"),
            "missing_token",
        ));
    };

    let permission = authenticator
        .verify_token_auto(token, current_time_epoch_millis())
        .map_err(|_| {
            AppError::auth(
                StatusCode::UNAUTHORIZED,
                anyhow!("Invalid token"),
                "invalid_token",
            )
        })?;

    // upload_token is the token that will be appended to the local upload URL.
    // For file tokens we reuse the original; for server tokens we mint a new file token.
    enum UploadTokenSource {
        Original,
        MintNew {
            content_type: Option<String>,
            content_length: Option<u64>,
        },
    }

    let (file_hash, content_type_owned, content_length, token_source) = match permission {
        Permission::File(file_permission) => {
            // File token must be for this doc and have Full permission
            if file_permission.doc_id != doc_id {
                return Err(AppError::auth(
                    StatusCode::UNAUTHORIZED,
                    anyhow!("Token not valid for this document"),
                    "access_wrong_document",
                ));
            }
            if !matches!(file_permission.authorization, Authorization::Full) {
                return Err(AppError::auth(
                    StatusCode::FORBIDDEN,
                    anyhow!("Insufficient permissions to upload files"),
                    "insufficient_permissions",
                ));
            }
            (
                file_permission.file_hash,
                file_permission.content_type,
                file_permission.content_length,
                UploadTokenSource::Original,
            )
        }
        Permission::Server => {
            // Server token: hash (and optional metadata) must come from query params
            let hash = params.hash.ok_or_else(|| {
                AppError::new(
                    StatusCode::BAD_REQUEST,
                    anyhow!("Hash query parameter required when using server token"),
                )
            })?;
            let ct = params.content_type.clone();
            let cl = params.content_length;
            (
                hash,
                params.content_type,
                params.content_length,
                UploadTokenSource::MintNew {
                    content_type: ct,
                    content_length: cl,
                },
            )
        }
        _ => {
            return Err(AppError::new(
                StatusCode::BAD_REQUEST,
                anyhow!("Token type cannot be used for file uploads"),
            ));
        }
    };

    // Validate the file hash
    if !validate_file_hash(&file_hash) {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            anyhow!("Invalid file hash format"),
        ));
    }

    // Check if we have a store configured
    if server_state.store.is_none() {
        return Err(AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            anyhow!("No store configured for file uploads"),
        ));
    }

    let key = format!("files/{}/{}", doc_id, file_hash);
    let upload_url = server_state
        .store
        .as_ref()
        .unwrap()
        .generate_upload_url(&key, content_type_owned.as_deref(), content_length)
        .await
        .map_err(|e| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, e.into()))?;

    let Some(url) = upload_url else {
        return Err(AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            anyhow!("Failed to generate upload URL"),
        ));
    };

    if !url.starts_with("http") {
        let base_url = generate_base_url(
            &server_state.url,
            &server_state.allowed_hosts,
            &host.to_string(),
        )?;
        let upload_token = match token_source {
            UploadTokenSource::Original => token.to_string(),
            UploadTokenSource::MintNew {
                content_type: ct,
                content_length: cl,
            } => {
                let expiration_time = ExpirationTimeEpochMillis(
                    current_time_epoch_millis() + DEFAULT_EXPIRATION_SECONDS * 1000,
                );
                authenticator
                    .gen_file_token_auto(
                        &file_hash,
                        &doc_id,
                        Authorization::Full,
                        expiration_time,
                        ct.as_deref(),
                        cl,
                        None,
                    )
                    .map_err(|e| {
                        AppError::new(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            anyhow!("Failed to generate file token: {}", e),
                        )
                    })?
            }
        };
        let full_url = format!("{}{}?token={}", base_url, url, upload_token);
        Ok(Json(FileUploadUrlResponse {
            upload_url: full_url,
        }))
    } else {
        // S3/cloud storage URL - return as-is
        Ok(Json(FileUploadUrlResponse { upload_url: url }))
    }
}

async fn handle_file_download_url(
    State(server_state): State<Arc<Server>>,
    Path(doc_id): Path<String>,
    TypedHeader(host): TypedHeader<headers::Host>,
    Query(params): Query<FileDownloadQueryParams>,
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
) -> Result<Json<FileDownloadUrlResponse>, AppError> {
    tracing::info!(doc_id = %doc_id, hash = ?params.hash, "Generating file download URL");

    // Get token
    let token = get_token_from_header(auth_header);

    // Local dev fast path: no authenticator configured → accept any download, validate hash only.
    if server_state.authenticator.is_none() {
        let hash = params.hash.ok_or_else(|| {
            AppError::new(
                StatusCode::BAD_REQUEST,
                anyhow!("hash query parameter required"),
            )
        })?;
        if !validate_file_hash(&hash) {
            return Err(AppError::new(
                StatusCode::BAD_REQUEST,
                anyhow!("Invalid file hash format"),
            ));
        }
        let Json(response) =
            generate_file_download_url(&server_state, &doc_id, &hash, &host.to_string()).await?;
        return Ok(Json(response));
    }

    // Check if we have authentication configured
    if let Some(authenticator) = &server_state.authenticator {
        if let Some(token) = token.as_deref() {
            // Extract hash from query parameter if present
            let query_hash = params.hash;

            // Verify the token and determine its type
            let permission = authenticator
                .verify_token_auto(token, current_time_epoch_millis())
                .map_err(|_| {
                    AppError::auth(
                        StatusCode::UNAUTHORIZED,
                        anyhow!("Invalid token"),
                        "invalid_token",
                    )
                })?;

            match permission {
                Permission::File(file_permission) => {
                    // Check if file token is for this doc_id
                    if file_permission.doc_id != doc_id {
                        return Err(AppError::auth(
                            StatusCode::UNAUTHORIZED,
                            anyhow!("Token not valid for this document"),
                            "access_wrong_document",
                        ));
                    }

                    // Both ReadOnly and Full can download files
                    if !matches!(
                        file_permission.authorization,
                        Authorization::ReadOnly | Authorization::Full
                    ) {
                        return Err(AppError::auth(
                            StatusCode::FORBIDDEN,
                            anyhow!("Insufficient permissions to download file"),
                            "insufficient_permissions",
                        ));
                    }

                    let file_hash = file_permission.file_hash;

                    // Validate the file hash
                    if !validate_file_hash(&file_hash) {
                        return Err(AppError::new(
                            StatusCode::BAD_REQUEST,
                            anyhow!("Invalid file hash format in token"),
                        ));
                    }

                    // Generate download URL using hash from token
                    let Json(download_response) = generate_file_download_url(
                        &server_state,
                        &doc_id,
                        &file_hash,
                        &host.to_string(),
                    )
                    .await?;
                    // Add token to the URL
                    let mut download_url = download_response.download_url;
                    if !download_url.starts_with("http") || download_url.contains("/f/") {
                        // This is our local endpoint, add token
                        let separator = if download_url.contains('?') { "&" } else { "?" };
                        download_url = format!("{}{}token={}", download_url, separator, token);
                    }
                    return Ok(Json(FileDownloadUrlResponse { download_url }));
                }
                Permission::Server => {
                    // Server token is valid, use hash from query parameter
                    if let Some(hash) = query_hash {
                        // Validate the file hash from query parameter
                        if !validate_file_hash(&hash) {
                            return Err(AppError::new(
                                StatusCode::BAD_REQUEST,
                                anyhow!("Invalid file hash format in query parameter"),
                            ));
                        }

                        // Generate download URL using hash from query parameter
                        let Json(download_response) = generate_file_download_url(
                            &server_state,
                            &doc_id,
                            &hash,
                            &host.to_string(),
                        )
                        .await?;
                        // Add file token to the URL (not the server token)
                        let mut download_url = download_response.download_url;
                        if !download_url.starts_with("http") || download_url.contains("/f/") {
                            // This is our local endpoint, generate a proper file token
                            let expiration_time = ExpirationTimeEpochMillis(
                                current_time_epoch_millis() + DEFAULT_EXPIRATION_SECONDS * 1000,
                            );
                            let file_token = authenticator
                                .gen_file_token_auto(
                                    &hash,
                                    &doc_id,
                                    Authorization::Full,
                                    expiration_time,
                                    None,
                                    None,
                                    None,
                                )
                                .map_err(|e| {
                                    AppError::new(
                                        StatusCode::INTERNAL_SERVER_ERROR,
                                        anyhow!("Failed to generate file token: {}", e),
                                    )
                                })?;
                            let separator = if download_url.contains('?') { "&" } else { "?" };
                            download_url =
                                format!("{}{}token={}", download_url, separator, file_token);
                        }
                        return Ok(Json(FileDownloadUrlResponse { download_url }));
                    } else {
                        return Err(AppError::new(
                            StatusCode::BAD_REQUEST,
                            anyhow!("Hash query parameter required when using server token"),
                        ));
                    }
                }
                Permission::Doc(_) => {
                    return Err(AppError::new(
                        StatusCode::BAD_REQUEST,
                        anyhow!("Document tokens cannot be used for file operations"),
                    ));
                }
                Permission::Prefix(prefix_perm) => {
                    // Check if doc_id matches the prefix
                    if !doc_id.starts_with(&prefix_perm.prefix) {
                        return Err(AppError::auth(
                            StatusCode::FORBIDDEN,
                            anyhow!("Token not valid for this document"),
                            "prefix_mismatch",
                        ));
                    }

                    // Both ReadOnly and Full can download files
                    if !matches!(
                        prefix_perm.authorization,
                        Authorization::ReadOnly | Authorization::Full
                    ) {
                        return Err(AppError::auth(
                            StatusCode::FORBIDDEN,
                            anyhow!("Insufficient permissions to download file"),
                            "insufficient_permissions",
                        ));
                    }

                    // Use hash from query parameter for prefix tokens
                    if let Some(hash) = query_hash {
                        // Validate the file hash from query parameter
                        if !validate_file_hash(&hash) {
                            return Err(AppError::new(
                                StatusCode::BAD_REQUEST,
                                anyhow!("Invalid file hash format in query parameter"),
                            ));
                        }

                        // Generate download URL using hash from query parameter
                        let Json(download_response) = generate_file_download_url(
                            &server_state,
                            &doc_id,
                            &hash,
                            &host.to_string(),
                        )
                        .await?;
                        // Add file token to the URL (not the prefix token)
                        let mut download_url = download_response.download_url;
                        if !download_url.starts_with("http") || download_url.contains("/f/") {
                            // This is our local endpoint, generate a proper file token
                            let expiration_time = ExpirationTimeEpochMillis(
                                current_time_epoch_millis() + DEFAULT_EXPIRATION_SECONDS * 1000,
                            );
                            let file_token = authenticator
                                .gen_file_token_auto(
                                    &hash,
                                    &doc_id,
                                    prefix_perm.authorization,
                                    expiration_time,
                                    None,
                                    None,
                                    None,
                                )
                                .map_err(|e| {
                                    AppError::new(
                                        StatusCode::INTERNAL_SERVER_ERROR,
                                        anyhow!("Failed to generate file token: {}", e),
                                    )
                                })?;
                            let separator = if download_url.contains('?') { "&" } else { "?" };
                            download_url =
                                format!("{}{}token={}", download_url, separator, file_token);
                        }
                        return Ok(Json(FileDownloadUrlResponse { download_url }));
                    } else {
                        return Err(AppError::new(
                            StatusCode::BAD_REQUEST,
                            anyhow!("Hash query parameter required when using prefix token"),
                        ));
                    }
                }
            }
        } else {
            return Err(AppError::auth(
                StatusCode::UNAUTHORIZED,
                anyhow!("No token provided"),
                "missing_token",
            ));
        }
    } else {
        // No auth configured
        return Err(AppError::auth(
            StatusCode::UNAUTHORIZED,
            anyhow!("Authentication is required for file operations"),
            "no_authenticator",
        ));
    }
}

async fn generate_file_download_url(
    server_state: &Arc<Server>,
    doc_id: &str,
    file_hash: &str,
    host: &str,
) -> Result<Json<FileDownloadUrlResponse>, AppError> {
    // Check if we have a store configured
    if server_state.store.is_none() {
        return Err(AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            anyhow!("No store configured for file downloads"),
        ));
    }

    // Generate the download URL - using doc_id/file_hash path structure
    let key = format!("files/{}/{}", doc_id, file_hash);
    let download_url = server_state
        .store
        .as_ref()
        .unwrap()
        .generate_download_url(&key)
        .await
        .map_err(|e| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, e.into()))?;

    if let Some(url) = download_url {
        // Check if this is a local endpoint (relative path) and convert to full URL
        if !url.starts_with("http") {
            let base_url = generate_base_url(&server_state.url, &server_state.allowed_hosts, host)?;
            let full_url = format!("{}{}", base_url, url);
            Ok(Json(FileDownloadUrlResponse {
                download_url: full_url,
            }))
        } else {
            // S3/cloud storage URL - return as-is
            Ok(Json(FileDownloadUrlResponse { download_url: url }))
        }
    } else {
        Err(AppError::new(
            StatusCode::NOT_FOUND,
            anyhow!("File not found"),
        ))
    }
}

/// Delete all files for a document
///
/// This endpoint accepts either:
/// - A file token with the doc_id (hash not required)
/// - A doc token with the doc_id
/// - A server token
///
/// Returns 204 No Content on success
async fn handle_file_delete(
    State(server_state): State<Arc<Server>>,
    Path(doc_id): Path<String>,
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
) -> Result<StatusCode, AppError> {
    // Get token
    let token = get_token_from_header(auth_header);

    // Verify token is for this doc_id and has required permission
    if let Some(authenticator) = &server_state.authenticator {
        if let Some(token) = token.as_deref() {
            // Verify token is for this doc_id
            let auth = authenticator
                .verify_file_token_for_doc(token, &doc_id, current_time_epoch_millis())
                .map_err(|e| {
                    AppError::auth(
                        StatusCode::UNAUTHORIZED,
                        anyhow!("Invalid token: {}", e),
                        "invalid_token",
                    )
                })?;

            // Only Full permission can delete files
            if !matches!(auth, Authorization::Full) {
                return Err(AppError::auth(
                    StatusCode::FORBIDDEN,
                    anyhow!("Insufficient permissions to delete files"),
                    "insufficient_permissions",
                ));
            }

            // Check if we have a store configured
            if server_state.store.is_none() {
                return Err(AppError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    anyhow!("No store configured for file operations"),
                ));
            }

            // List all files in the document's directory
            let prefix = format!("files/{}/", doc_id);
            let store = server_state.store.as_ref().unwrap();

            let file_infos = store
                .list(&prefix)
                .await
                .map_err(|e| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, e.into()))?;

            if file_infos.is_empty() {
                tracing::info!("No files to delete for document: {}", doc_id);
                return Ok(StatusCode::NO_CONTENT);
            }

            // Delete each file
            let mut deleted_count = 0;
            for file_info in file_infos {
                let key = file_info.key;
                if let Err(e) = store.remove(&format!("files/{}/{}", doc_id, key)).await {
                    tracing::error!("Failed to delete file {}/{}: {}", doc_id, key, e);
                    continue;
                }
                deleted_count += 1;
            }

            tracing::info!("Deleted {} files for document: {}", deleted_count, doc_id);
            return Ok(StatusCode::NO_CONTENT);
        } else {
            return Err(AppError::auth(
                StatusCode::UNAUTHORIZED,
                anyhow!("No token provided"),
                "missing_token",
            ));
        }
    } else {
        // No auth configured
        return Err(AppError::auth(
            StatusCode::UNAUTHORIZED,
            anyhow!("Authentication is required for file operations"),
            "no_authenticator",
        ));
    }
}

/// Delete a specific file by hash
///
/// This endpoint accepts either:
/// - A file token with the doc_id (hash not required)
/// - A doc token with the doc_id
/// - A server token
///
/// The hash to delete is specified in the URL path.
/// Returns 204 No Content on success, 404 if file not found
async fn handle_file_delete_by_hash(
    State(server_state): State<Arc<Server>>,
    Path((doc_id, file_hash)): Path<(String, String)>,
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
) -> Result<StatusCode, AppError> {
    // Get token
    let token = get_token_from_header(auth_header);

    // Verify token is for this doc_id and has required permission
    if let Some(authenticator) = &server_state.authenticator {
        if let Some(token) = token.as_deref() {
            // Verify token is for this doc_id
            let auth = authenticator
                .verify_file_token_for_doc(token, &doc_id, current_time_epoch_millis())
                .map_err(|e| {
                    AppError::auth(
                        StatusCode::UNAUTHORIZED,
                        anyhow!("Invalid token: {}", e),
                        "invalid_token",
                    )
                })?;

            // Only Full permission can delete files
            if !matches!(auth, Authorization::Full) {
                return Err(AppError::auth(
                    StatusCode::FORBIDDEN,
                    anyhow!("Insufficient permissions to delete file"),
                    "insufficient_permissions",
                ));
            }

            // Validate the file hash format
            if !validate_file_hash(&file_hash) {
                return Err(AppError::new(
                    StatusCode::BAD_REQUEST,
                    anyhow!("Invalid file hash format"),
                ));
            }

            // Check if we have a store configured
            if server_state.store.is_none() {
                return Err(AppError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    anyhow!("No store configured for file operations"),
                ));
            }

            // Construct the file path
            let key = format!("files/{}/{}", doc_id, file_hash);

            // Check if the file exists before trying to delete it
            let exists = server_state
                .store
                .as_ref()
                .unwrap()
                .exists(&key)
                .await
                .map_err(|e| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, e.into()))?;

            if !exists {
                // If the file is already gone, return 204 No Content since DELETE is idempotent
                tracing::debug!("File already deleted: {}/{}", doc_id, file_hash);
                return Ok(StatusCode::NO_CONTENT);
            }

            // Delete the file
            server_state
                .store
                .as_ref()
                .unwrap()
                .remove(&key)
                .await
                .map_err(|e| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, e.into()))?;

            tracing::info!("Deleted file: {}/{}", doc_id, file_hash);
            return Ok(StatusCode::NO_CONTENT);
        } else {
            return Err(AppError::auth(
                StatusCode::UNAUTHORIZED,
                anyhow!("No token provided"),
                "missing_token",
            ));
        }
    } else {
        // No auth configured
        return Err(AppError::auth(
            StatusCode::UNAUTHORIZED,
            anyhow!("Authentication is required for file operations"),
            "no_authenticator",
        ));
    }
}

/// Handle HEAD request to check if a file exists in S3 storage
///
/// Returns:
/// - 200 OK if the file exists
/// - 404 Not Found if the file doesn't exist
/// - Other status codes for authentication/authorization errors

/// Get the history of all files for a document
///
/// This endpoint accepts either:
/// - A file token with the doc_id (hash not required)
/// - A doc token with the doc_id
/// - A server token
async fn handle_file_history(
    State(server_state): State<Arc<Server>>,
    Path(doc_id): Path<String>,
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
) -> Result<Json<FileHistoryResponse>, AppError> {
    // Get token
    let token = get_token_from_header(auth_header);

    // Verify token is for this doc_id
    if let Some(authenticator) = &server_state.authenticator {
        if let Some(token) = token.as_deref() {
            // Verify token is for this doc_id - this now accepts both doc and file tokens
            let auth = authenticator
                .verify_file_token_for_doc(token, &doc_id, current_time_epoch_millis())
                .map_err(|e| {
                    AppError::auth(
                        StatusCode::UNAUTHORIZED,
                        anyhow!("Invalid token: {}", e),
                        "invalid_token",
                    )
                })?;

            // Both ReadOnly and Full can view file history
            if !matches!(auth, Authorization::ReadOnly | Authorization::Full) {
                return Err(AppError::auth(
                    StatusCode::FORBIDDEN,
                    anyhow!("Insufficient permissions to view file history"),
                    "insufficient_permissions",
                ));
            }
        } else {
            return Err(AppError::auth(
                StatusCode::UNAUTHORIZED,
                anyhow!("No token provided"),
                "missing_token",
            ));
        }
    }

    // Check if we have a store configured
    if server_state.store.is_none() {
        return Err(AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            anyhow!("No store configured for file operations"),
        ));
    }

    // List files in the document's directory
    let prefix = format!("files/{}/", doc_id);
    let store = server_state.store.as_ref().unwrap();

    let file_infos = store
        .list(&prefix)
        .await
        .map_err(|e| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, e.into()))?;

    // Convert the raw file info into the API response format
    let files = file_infos
        .into_iter()
        .map(|info| FileHistoryEntry {
            hash: info.key,
            size: info.size,
            created_at: info.last_modified,
        })
        .collect();

    Ok(Json(FileHistoryResponse { files }))
}

async fn handle_doc_versions(
    State(server_state): State<Arc<Server>>,
    Path(doc_id): Path<String>,
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
) -> Result<Json<DocumentVersionResponse>, AppError> {
    let token = get_token_from_header(auth_header);

    if let Some(authenticator) = &server_state.authenticator {
        if let Some(token) = token.as_deref() {
            let auth = authenticator
                .verify_doc_token(token, &doc_id, current_time_epoch_millis())
                .map_err(|e| {
                    AppError::auth(
                        StatusCode::UNAUTHORIZED,
                        anyhow!("Invalid token: {}", e),
                        "invalid_token",
                    )
                })?;

            if !matches!(auth, Authorization::ReadOnly | Authorization::Full) {
                return Err(AppError::auth(
                    StatusCode::FORBIDDEN,
                    anyhow!("Insufficient permissions to view document versions"),
                    "insufficient_permissions",
                ));
            }
        } else {
            return Err(AppError::auth(
                StatusCode::UNAUTHORIZED,
                anyhow!("No token provided"),
                "missing_token",
            ));
        }
    }

    let store = match &server_state.store {
        Some(s) => s,
        None => {
            return Err(AppError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                anyhow!("No store configured for operations"),
            ))
        }
    };

    let key = format!("{}/data.ysweet", doc_id);
    let versions = store
        .list_versions(&key)
        .await
        .map_err(|e| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, e.into()))?;

    let entries = versions
        .into_iter()
        .map(|v| DocumentVersionEntry {
            version_id: v.version_id,
            created_at: v.last_modified,
            is_latest: v.is_latest,
        })
        .collect();

    Ok(Json(DocumentVersionResponse { versions: entries }))
}

async fn handle_file_head(
    State(server_state): State<Arc<Server>>,
    Path(doc_id): Path<String>,
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
) -> Result<StatusCode, AppError> {
    // Get token
    let token = get_token_from_header(auth_header);

    // Verify token is for this doc_id
    if let Some(authenticator) = &server_state.authenticator {
        if let Some(token) = token.as_deref() {
            // Verify token is for this doc_id
            let auth = authenticator
                .verify_file_token_for_doc(token, &doc_id, current_time_epoch_millis())
                .map_err(|e| {
                    AppError::auth(
                        StatusCode::UNAUTHORIZED,
                        anyhow!("Invalid token: {}", e),
                        "invalid_token",
                    )
                })?;

            // Both ReadOnly and Full can check if a file exists
            if !matches!(auth, Authorization::ReadOnly | Authorization::Full) {
                return Err(AppError::auth(
                    StatusCode::FORBIDDEN,
                    anyhow!("Insufficient permissions to access file"),
                    "insufficient_permissions",
                ));
            }

            // Verify the token and get the file hash
            let permission = authenticator
                .verify_token_auto(token, current_time_epoch_millis())
                .map_err(|_| {
                    AppError::auth(
                        StatusCode::UNAUTHORIZED,
                        anyhow!("Invalid token"),
                        "invalid_token",
                    )
                })?;

            if let Permission::File(file_permission) = permission {
                let file_hash = file_permission.file_hash;

                // Validate the file hash
                if !validate_file_hash(&file_hash) {
                    return Err(AppError::new(
                        StatusCode::BAD_REQUEST,
                        anyhow!("Invalid file hash format in token"),
                    ));
                }

                // Check if we have a store configured
                if server_state.store.is_none() {
                    return Err(AppError::new(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        anyhow!("No store configured for file operations"),
                    ));
                }

                // Construct the file path with proper format - using doc_id/file_hash
                let key = format!("files/{}/{}", doc_id, file_hash);

                // Check if the file exists with a direct call to S3
                let exists = server_state
                    .store
                    .as_ref()
                    .unwrap()
                    .exists(&key)
                    .await
                    .map_err(|e| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, e.into()))?;

                if exists {
                    tracing::debug!("File exists: {}/{}", doc_id, file_hash);
                    return Ok(StatusCode::OK);
                } else {
                    tracing::debug!("File not found: {}/{}", doc_id, file_hash);
                    return Err(AppError::new(
                        StatusCode::NOT_FOUND,
                        anyhow!("File not found"),
                    ));
                }
            } else {
                return Err(AppError::new(
                    StatusCode::BAD_REQUEST,
                    anyhow!("Token is not a file token"),
                ));
            }
        } else {
            return Err(AppError::auth(
                StatusCode::UNAUTHORIZED,
                anyhow!("No token provided"),
                "missing_token",
            ));
        }
    } else {
        // No auth configured
        return Err(AppError::auth(
            StatusCode::UNAUTHORIZED,
            anyhow!("Authentication is required for file operations"),
            "no_authenticator",
        ));
    }
}

async fn reload_webhook_config_endpoint(
    State(server_state): State<Arc<Server>>,
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
) -> Result<Json<Value>, AppError> {
    // Get token
    let token = get_token_from_header(auth_header);

    // Verify token is server token (for server admin operations)
    if let Some(authenticator) = &server_state.authenticator {
        if let Some(token) = token.as_deref() {
            // Verify this is a server admin token
            authenticator
                .verify_server_token(token, current_time_epoch_millis())
                .map_err(|e| {
                    AppError::auth(
                        StatusCode::UNAUTHORIZED,
                        anyhow!("Invalid token: {}", e),
                        "invalid_token",
                    )
                })?;
        } else {
            return Err(AppError::auth(
                StatusCode::UNAUTHORIZED,
                anyhow!("No token provided"),
                "missing_token",
            ));
        }
    }

    // Reload webhook configuration
    match server_state.reload_webhook_config().await {
        Ok(status) => Ok(Json(json!({
            "status": "success",
            "message": status
        }))),
        Err(e) => {
            tracing::error!("Failed to reload webhook config: {}", e);
            Err(AppError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                anyhow!("Failed to reload webhook configuration: {}", e),
            ))
        }
    }
}

async fn metrics_endpoint(State(_server_state): State<Arc<Server>>) -> Result<String, AppError> {
    use prometheus::{Encoder, TextEncoder};

    let encoder = TextEncoder::new();
    let metric_families = prometheus::gather();
    let mut buffer = Vec::new();

    encoder.encode(&metric_families, &mut buffer).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            anyhow!("Failed to encode metrics: {}", e),
        )
    })?;

    Ok(String::from_utf8(buffer).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            anyhow!("Failed to convert metrics to string: {}", e),
        )
    })?)
}

#[cfg(test)]
mod test {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::{Method, Request};
    use serde_json::Value as JsonValue;
    use tower::util::ServiceExt;
    use y_sweet_core::api_types::Authorization;
    use y_sweet_core::auth::ExpirationTimeEpochMillis;
    use y_sweet_core::critic_scanner::scan_suggestions;
    use y_sweet_core::doc_sync::DocWithSyncKv;
    use yrs::GetString;
    use yrs::{Any, Map, ReadTxn, Text, Transact, WriteTxn};

    const TEST_RELAY_ID: &str = "cb696037-0f72-4e93-8717-4e433129d789";
    const TEST_FOLDER_UUID: &str = "b0000001-0000-4000-8000-000000000001";

    async fn insert_test_folder_doc(
        server: &Arc<Server>,
        folder_name: &str,
        entries: &[(&str, &str, &str)],
    ) -> String {
        let folder_doc_id = format!("{}-{}", TEST_RELAY_ID, TEST_FOLDER_UUID);
        let dwskv = DocWithSyncKv::new(&folder_doc_id, None, || (), None)
            .await
            .unwrap();
        {
            let awareness = dwskv.awareness();
            let guard = awareness.write().unwrap();
            let mut txn = guard.doc.transact_mut();
            let config = txn.get_or_insert_map("folder_config");
            config.insert(&mut txn, "name", Any::String(folder_name.into()));
            let filemeta = txn.get_or_insert_map("filemeta_v0");
            let docs_map = txn.get_or_insert_map("docs");
            for (path, uuid, entry_type) in entries {
                let mut map = std::collections::HashMap::new();
                map.insert("id".to_string(), Any::String((*uuid).into()));
                map.insert("type".to_string(), Any::String((*entry_type).into()));
                map.insert("version".to_string(), Any::Number(0.0));
                filemeta.insert(&mut txn, *path, Any::Map(map.into()));
                docs_map.insert(&mut txn, *path, Any::String((*uuid).into()));
            }
        }
        server.docs().insert(folder_doc_id.clone(), dwskv);
        server.doc_resolver().rebuild(server.docs());
        folder_doc_id
    }

    async fn insert_test_content_doc(server: &Arc<Server>, uuid: &str, content: &str) {
        let doc_id = format!("{}-{}", TEST_RELAY_ID, uuid);
        let dwskv = DocWithSyncKv::new(&doc_id, None, || (), None)
            .await
            .unwrap();
        {
            let awareness = dwskv.awareness();
            let guard = awareness.write().unwrap();
            let mut txn = guard.doc.transact_mut();
            let text = txn.get_or_insert_text("contents");
            text.insert(&mut txn, 0, content);
        }
        server.docs().insert(doc_id, dwskv);
    }

    fn insert_backlink(
        server: &Arc<Server>,
        folder_doc_id: &str,
        target_uuid: &str,
        backlinker_uuid: &str,
    ) {
        let doc_ref = server.docs().get(folder_doc_id).unwrap();
        let awareness = doc_ref.awareness();
        let guard = awareness.write().unwrap();
        let mut txn = guard.doc.transact_mut();
        let backlinks = txn.get_or_insert_map("backlinks_v0");
        backlinks.insert(
            &mut txn,
            target_uuid,
            vec![Any::String(backlinker_uuid.into())],
        );
    }

    fn filemeta_has(server: &Arc<Server>, folder_doc_id: &str, path: &str) -> bool {
        let doc_ref = server.docs().get(folder_doc_id).unwrap();
        let awareness = doc_ref.awareness();
        let guard = awareness.read().unwrap();
        let txn = guard.doc.transact();
        txn.get_map("filemeta_v0")
            .and_then(|m| m.get(&txn, path))
            .is_some()
    }

    fn legacy_docs_value(server: &Arc<Server>, folder_doc_id: &str, path: &str) -> Option<String> {
        let doc_ref = server.docs().get(folder_doc_id).unwrap();
        let awareness = doc_ref.awareness();
        let guard = awareness.read().unwrap();
        let txn = guard.doc.transact();
        txn.get_map("docs").and_then(|m| match m.get(&txn, path) {
            Some(yrs::Out::Any(Any::String(value))) => Some(value.to_string()),
            _ => None,
        })
    }

    fn content_text(server: &Arc<Server>, uuid: &str) -> String {
        let doc_id = format!("{}-{}", TEST_RELAY_ID, uuid);
        let doc_ref = server.docs().get(&doc_id).unwrap();
        let awareness = doc_ref.awareness();
        let guard = awareness.read().unwrap();
        let txn = guard.doc.transact();
        txn.get_text("contents")
            .map(|text| text.get_string(&txn))
            .unwrap_or_default()
    }

    async fn post_move(server: &Arc<Server>, body: JsonValue) -> (StatusCode, JsonValue) {
        let response = server
            .routes()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/move")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}));
        (status, body)
    }

    async fn post_request(
        server: &Arc<Server>,
        uri: &str,
        content_type: &str,
        body: Body,
    ) -> (StatusCode, String) {
        let response = server
            .routes()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(uri)
                    .header("content-type", content_type)
                    .body(body)
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8_lossy(&bytes).into_owned())
    }

    async fn post_check_video_ids(
        server: &Arc<Server>,
        body: JsonValue,
    ) -> (StatusCode, JsonValue) {
        let response = server
            .routes()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/doc/check-video-ids")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}));
        (status, body)
    }

    #[tokio::test]
    async fn move_path_file_moves_existing_file() {
        let server = Server::new_for_test();
        let folder_doc_id = insert_test_folder_doc(
            &server,
            "Relay Folder 1",
            &[(
                "/Old.md",
                "11111111-1111-4111-8111-111111111111",
                "markdown",
            )],
        )
        .await;
        insert_test_content_doc(&server, "11111111-1111-4111-8111-111111111111", "Old").await;

        let result = server
            .move_path("Relay Folder 1/Old.md", "/New.md", None)
            .await
            .unwrap();

        assert_eq!(result.old_path, "/Old.md");
        assert_eq!(result.new_path, "/New.md");
        assert!(!filemeta_has(&server, &folder_doc_id, "/Old.md"));
        assert!(filemeta_has(&server, &folder_doc_id, "/New.md"));
    }

    #[tokio::test]
    async fn move_path_rejects_double_quotes_without_mutation() {
        let server = Server::new_for_test();
        let folder_doc_id = insert_test_folder_doc(
            &server,
            "Relay Folder 1",
            &[(
                "/Old.md",
                "11111111-1111-4111-8111-111111111111",
                "markdown",
            )],
        )
        .await;
        insert_test_content_doc(&server, "11111111-1111-4111-8111-111111111111", "Old").await;

        let result = server
            .move_path("Relay Folder 1/Old.md", "/Bad \"Name\".md", None)
            .await;

        assert!(matches!(result, Err(MoveDocumentError::BadRequest(_))));
        assert!(filemeta_has(&server, &folder_doc_id, "/Old.md"));
        assert!(!filemeta_has(&server, &folder_doc_id, "/Bad \"Name\".md"));
    }

    #[tokio::test]
    async fn create_document_rejects_double_quotes_without_mutation() {
        let server = Server::new_for_test();
        let folder_doc_id = insert_test_folder_doc(&server, "Relay Folder 1", &[]).await;

        let result = server
            .create_document("Relay Folder 1", "/Bad \"Name\".md", "content", None)
            .await;

        assert!(matches!(result, Err(CreateDocumentError::BadRequest(_))));
        assert!(!filemeta_has(&server, &folder_doc_id, "/Bad \"Name\".md"));
    }

    #[tokio::test]
    async fn upsert_document_rejects_double_quotes_as_bad_request() {
        let server = Server::new_for_test();
        insert_test_folder_doc(&server, "Relay Folder 1", &[]).await;
        let request = json!({
            "folder": "Relay Folder 1",
            "path": "/Bad \"Name\".md",
            "content": "content"
        });

        let (status, body) = post_request(
            &server,
            "/doc/upsert",
            "application/json",
            Body::from(request.to_string()),
        )
        .await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body.contains("File names cannot contain double quotes"));
    }

    #[tokio::test]
    async fn upsert_blob_rejects_double_quotes_as_bad_request() {
        let server = Server::new_for_test();
        insert_test_folder_doc(&server, "Relay Folder 1", &[]).await;
        let request = json!({
            "folder": "Relay Folder 1",
            "path": "/Bad \"Name\".json",
            "content": "{}"
        });

        let (status, body) = post_request(
            &server,
            "/doc/upsert",
            "application/json",
            Body::from(request.to_string()),
        )
        .await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body.contains("File names cannot contain double quotes"));
    }

    #[tokio::test]
    async fn upsert_attachment_rejects_double_quotes_as_bad_request() {
        let server = Server::new_for_test();
        insert_test_folder_doc(&server, "Relay Folder 1", &[]).await;

        let (status, body) = post_request(
            &server,
            "/doc/attachment?folder=Relay%20Folder%201&path=%2FBad%20%22Name%22.png",
            "application/octet-stream",
            Body::from(vec![1, 2, 3]),
        )
        .await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body.contains("File names cannot contain double quotes"));
    }

    /// Add a filemeta + legacy-docs entry to an already-loaded folder doc WITHOUT
    /// refreshing the resolver. Simulates a freshly-created file that the client
    /// wrote to the folder Y.Doc but the link-indexer worker has not yet (or never,
    /// if stalled) registered in the in-memory resolver.
    fn add_filemeta_entry_without_resolver(
        server: &Arc<Server>,
        folder_doc_id: &str,
        path: &str,
        uuid: &str,
        entry_type: &str,
    ) {
        let doc_ref = server.docs().get(folder_doc_id).unwrap();
        let awareness = doc_ref.awareness();
        let guard = awareness.write().unwrap();
        let mut txn = guard.doc.transact_mut();
        let filemeta = txn.get_or_insert_map("filemeta_v0");
        let docs_map = txn.get_or_insert_map("docs");
        let mut map = std::collections::HashMap::new();
        map.insert("id".to_string(), Any::String(uuid.into()));
        map.insert("type".to_string(), Any::String(entry_type.into()));
        map.insert("version".to_string(), Any::Number(0.0));
        filemeta.insert(&mut txn, path, Any::Map(map.into()));
        if entry_type == "markdown" {
            docs_map.insert(&mut txn, path, Any::String(uuid.into()));
        }
    }

    // Prevents: "Move failed: 400" when renaming a freshly created markdown file
    // while the resolver is stale (link-indexer worker lagging or dead). The file
    // IS in filemeta_v0 (source of truth) but NOT in the resolver, so without the
    // filemeta fallback resolve_path() misses, move_path() falls through to the
    // folder-move branch, and the ".md" destination is rejected with BadRequest.
    #[tokio::test]
    async fn move_path_renames_file_missing_from_stale_resolver() {
        let server = Server::new_for_test();
        // Folder doc loaded; resolver rebuilt while the folder had only old files.
        let folder_doc_id = insert_test_folder_doc(
            &server,
            "Relay Folder 1",
            &[(
                "/Old.md",
                "00000000-0000-4000-8000-000000000001",
                "markdown",
            )],
        )
        .await;

        // Freshly-created file: written to filemeta, but resolver never learned it.
        let uuid = "11111111-1111-4111-8111-111111111111";
        add_filemeta_entry_without_resolver(&server, &folder_doc_id, "/New.md", uuid, "markdown");
        insert_test_content_doc(&server, uuid, "New").await;

        // Precondition: the resolver really is stale for this path.
        assert!(
            server
                .doc_resolver()
                .resolve_path("Relay Folder 1/New.md")
                .is_none(),
            "test setup: resolver should not know the new file"
        );

        // The user's exact action.
        let result = server
            .move_path("Relay Folder 1/New.md", "/Renamed.md", None)
            .await;

        assert!(
            result.is_ok(),
            "renaming a file that is in filemeta but missing from a stale resolver should succeed, got: {:?}",
            result.err()
        );
        assert!(!filemeta_has(&server, &folder_doc_id, "/New.md"));
        assert!(filemeta_has(&server, &folder_doc_id, "/Renamed.md"));
    }

    #[tokio::test]
    async fn check_video_ids_detects_full_youtube_urls() {
        let server = Server::new_for_test();
        insert_test_folder_doc(
            &server,
            "Lens Edu",
            &[
                (
                    "/video_transcripts/Short.md",
                    "11111111-1111-4111-8111-111111111111",
                    "markdown",
                ),
                (
                    "/video_transcripts/Normal.md",
                    "22222222-2222-4222-8222-222222222222",
                    "markdown",
                ),
            ],
        )
        .await;
        insert_test_content_doc(
            &server,
            "11111111-1111-4111-8111-111111111111",
            "---\nurl: \"https://www.youtube.com/shorts/GMTDrG3hYJ0\"\n---\n",
        )
        .await;
        insert_test_content_doc(
            &server,
            "22222222-2222-4222-8222-222222222222",
            "---\nurl: \"https://www.youtube.com/watch?v=Nl7-bRFSZBs\"\n---\n",
        )
        .await;

        let (status, body) = post_check_video_ids(
            &server,
            json!({
                "folder": "Lens Edu",
                "subfolder": "video_transcripts",
                "video_ids": ["GMTDrG3hYJ0", "Nl7-bRFSZBs"]
            }),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["found"]["GMTDrG3hYJ0"], "/video_transcripts/Short.md");
        assert_eq!(body["found"]["Nl7-bRFSZBs"], "/video_transcripts/Normal.md");
    }

    #[tokio::test]
    async fn check_video_ids_ignores_compact_youtube_paths() {
        let server = Server::new_for_test();
        insert_test_folder_doc(
            &server,
            "Lens Edu",
            &[(
                "/video_transcripts/Legacy.md",
                "11111111-1111-4111-8111-111111111111",
                "markdown",
            )],
        )
        .await;
        insert_test_content_doc(
            &server,
            "11111111-1111-4111-8111-111111111111",
            "---\nurl: \"/GMTDrG3hYJ0\"\n---\n",
        )
        .await;

        let (status, body) = post_check_video_ids(
            &server,
            json!({
                "folder": "Lens Edu",
                "subfolder": "video_transcripts",
                "video_ids": ["GMTDrG3hYJ0"]
            }),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert!(body["found"]["GMTDrG3hYJ0"].is_null());
    }

    async fn post_check_source_urls(
        server: &Arc<Server>,
        body: JsonValue,
    ) -> (StatusCode, JsonValue) {
        let response = server
            .routes()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/doc/check-source-urls")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}));
        (status, body)
    }

    #[tokio::test]
    async fn check_source_urls_matches_frontmatter_and_normalizes_trailing_slash() {
        let server = Server::new_for_test();
        insert_test_folder_doc(
            &server,
            "Lens Edu",
            &[
                (
                    "/articles/a.md",
                    "11111111-1111-4111-8111-111111111111",
                    "markdown",
                ),
                (
                    "/articles/b.md",
                    "22222222-2222-4222-8222-222222222222",
                    "markdown",
                ),
            ],
        )
        .await;
        insert_test_content_doc(
            &server,
            "11111111-1111-4111-8111-111111111111",
            "---\ntitle: \"A\"\nsource_url: \"https://ai-safety-atlas.com/chapters/v1/risks/introduction\"\n---\n\nBody.",
        )
        .await;
        insert_test_content_doc(
            &server,
            "22222222-2222-4222-8222-222222222222",
            "---\ntitle: \"B\"\nsource_url: \"https://example.com/post\"\n---\n\nBody.",
        )
        .await;

        let (status, body) = post_check_source_urls(
            &server,
            json!({
                "folder": "Lens Edu",
                "subfolder": "articles",
                "source_urls": [
                    // trailing slash on the query must still match the stored URL
                    "https://ai-safety-atlas.com/chapters/v1/risks/introduction/",
                    "https://example.com/post",
                    "https://unimported.example/x"
                ]
            }),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body["found"]["https://ai-safety-atlas.com/chapters/v1/risks/introduction/"],
            "/articles/a.md"
        );
        assert_eq!(body["found"]["https://example.com/post"], "/articles/b.md");
        assert!(body["found"]["https://unimported.example/x"].is_null());
    }

    // Frontmatter-precise: a URL that appears only in the body must NOT match
    // (unlike a naive substring scan).
    #[tokio::test]
    async fn check_source_urls_ignores_url_in_body_only() {
        let server = Server::new_for_test();
        insert_test_folder_doc(
            &server,
            "Lens Edu",
            &[(
                "/articles/a.md",
                "11111111-1111-4111-8111-111111111111",
                "markdown",
            )],
        )
        .await;
        insert_test_content_doc(
            &server,
            "11111111-1111-4111-8111-111111111111",
            "---\ntitle: \"A\"\nsource_url: \"https://example.com/real\"\n---\n\nSee https://example.com/body-only for more.",
        )
        .await;

        let (status, body) = post_check_source_urls(
            &server,
            json!({
                "folder": "Lens Edu",
                "subfolder": "articles",
                "source_urls": ["https://example.com/body-only"]
            }),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert!(body["found"]["https://example.com/body-only"].is_null());
    }

    #[tokio::test]
    async fn move_path_renames_non_markdown_file_metadata() {
        let server = Server::new_for_test();
        let folder_doc_id = insert_test_folder_doc(
            &server,
            "Relay Folder 1",
            &[(
                "/source.timestamps.json",
                "22222222-2222-4222-8222-222222222222",
                "file",
            )],
        )
        .await;

        let result = server
            .move_path(
                "Relay Folder 1/source.timestamps.json",
                "/renamed.timestamps.json",
                None,
            )
            .await
            .unwrap();

        assert_eq!(result.old_path, "/source.timestamps.json");
        assert_eq!(result.new_path, "/renamed.timestamps.json");
        assert!(!filemeta_has(
            &server,
            &folder_doc_id,
            "/source.timestamps.json"
        ));
        assert!(filemeta_has(
            &server,
            &folder_doc_id,
            "/renamed.timestamps.json"
        ));
        assert_eq!(
            legacy_docs_value(&server, &folder_doc_id, "/renamed.timestamps.json"),
            None
        );
    }

    #[tokio::test]
    async fn folder_rename_moves_metadata() {
        let server = Server::new_for_test();
        let folder_doc_id = insert_test_folder_doc(
            &server,
            "Relay Folder 1",
            &[
                ("/Old", "22222222-2222-4222-8222-222222222222", "folder"),
                (
                    "/Old/Child.md",
                    "33333333-3333-4333-8333-333333333333",
                    "markdown",
                ),
                (
                    "/Old/Page.html",
                    "44444444-4444-4444-8444-444444444444",
                    "file",
                ),
            ],
        )
        .await;
        insert_test_content_doc(&server, "33333333-3333-4333-8333-333333333333", "Child").await;

        server
            .move_path("Relay Folder 1/Old", "/New", None)
            .await
            .unwrap();

        assert!(!filemeta_has(&server, &folder_doc_id, "/Old"));
        assert!(!filemeta_has(&server, &folder_doc_id, "/Old/Child.md"));
        assert!(!filemeta_has(&server, &folder_doc_id, "/Old/Page.html"));
        assert!(filemeta_has(&server, &folder_doc_id, "/New"));
        assert!(filemeta_has(&server, &folder_doc_id, "/New/Child.md"));
        assert!(filemeta_has(&server, &folder_doc_id, "/New/Page.html"));
        assert_eq!(
            legacy_docs_value(&server, &folder_doc_id, "/New"),
            Some("22222222-2222-4222-8222-222222222222".to_string())
        );
        assert_eq!(
            legacy_docs_value(&server, &folder_doc_id, "/New/Child.md"),
            Some("33333333-3333-4333-8333-333333333333".to_string())
        );
        assert_eq!(
            legacy_docs_value(&server, &folder_doc_id, "/New/Page.html"),
            None
        );
        assert_eq!(legacy_docs_value(&server, &folder_doc_id, "/Old"), None);
        assert_eq!(
            legacy_docs_value(&server, &folder_doc_id, "/Old/Child.md"),
            None
        );
        assert_eq!(
            legacy_docs_value(&server, &folder_doc_id, "/Old/Page.html"),
            None
        );
    }

    #[tokio::test]
    async fn folder_rename_moves_synthetic_ancestor_folder() {
        let server = Server::new_for_test();
        let folder_doc_id = insert_test_folder_doc(
            &server,
            "Relay Folder 1",
            &[(
                "/articles/Article.md",
                "33333333-3333-4333-8333-333333333333",
                "markdown",
            )],
        )
        .await;
        insert_test_content_doc(&server, "33333333-3333-4333-8333-333333333333", "Article").await;

        let result = server
            .move_path("Relay Folder 1/articles", "/renamed", None)
            .await
            .unwrap();

        assert_eq!(result.old_path, "/articles");
        assert_eq!(result.new_path, "/renamed");
        assert!(!filemeta_has(
            &server,
            &folder_doc_id,
            "/articles/Article.md"
        ));
        assert!(filemeta_has(&server, &folder_doc_id, "/renamed/Article.md"));
        assert_eq!(
            legacy_docs_value(&server, &folder_doc_id, "/articles/Article.md"),
            None
        );
        assert_eq!(
            legacy_docs_value(&server, &folder_doc_id, "/renamed/Article.md"),
            Some("33333333-3333-4333-8333-333333333333".to_string())
        );
    }

    #[tokio::test]
    async fn folder_rename_rejects_synthetic_destination_collision_without_mutation() {
        let server = Server::new_for_test();
        let folder_doc_id = insert_test_folder_doc(
            &server,
            "Relay Folder 1",
            &[
                (
                    "/articles/Article.md",
                    "33333333-3333-4333-8333-333333333333",
                    "markdown",
                ),
                (
                    "/renamed/Article.md",
                    "44444444-4444-4444-8444-444444444444",
                    "markdown",
                ),
            ],
        )
        .await;
        insert_test_content_doc(&server, "33333333-3333-4333-8333-333333333333", "Article").await;
        insert_test_content_doc(&server, "44444444-4444-4444-8444-444444444444", "Existing").await;

        let result = server
            .move_path("Relay Folder 1/articles", "/renamed", None)
            .await;

        assert!(matches!(result, Err(MoveDocumentError::Conflict(_))));
        assert!(filemeta_has(
            &server,
            &folder_doc_id,
            "/articles/Article.md"
        ));
        assert!(filemeta_has(&server, &folder_doc_id, "/renamed/Article.md"));
    }

    #[tokio::test]
    async fn folder_rename_rewrites_synthetic_descendant_backlinks() {
        let server = Server::new_for_test();
        let folder_doc_id = insert_test_folder_doc(
            &server,
            "Relay Folder 1",
            &[
                (
                    "/articles/Article.md",
                    "33333333-3333-4333-8333-333333333333",
                    "markdown",
                ),
                (
                    "/Backlinker.md",
                    "44444444-4444-4444-8444-444444444444",
                    "markdown",
                ),
            ],
        )
        .await;
        insert_test_content_doc(&server, "33333333-3333-4333-8333-333333333333", "Article").await;
        insert_test_content_doc(
            &server,
            "44444444-4444-4444-8444-444444444444",
            "See [[articles/Article]]",
        )
        .await;
        insert_backlink(
            &server,
            &folder_doc_id,
            "33333333-3333-4333-8333-333333333333",
            "44444444-4444-4444-8444-444444444444",
        );

        let result = server
            .move_path("Relay Folder 1/articles", "/renamed", None)
            .await
            .unwrap();

        assert_eq!(result.links_rewritten, 1);
        assert_eq!(
            content_text(&server, "44444444-4444-4444-8444-444444444444"),
            "See [[renamed/Article]]"
        );
    }

    #[tokio::test]
    async fn folder_rename_rewrites_descendant_backlinks() {
        let server = Server::new_for_test();
        let folder_doc_id = insert_test_folder_doc(
            &server,
            "Relay Folder 1",
            &[
                ("/Old", "22222222-2222-4222-8222-222222222222", "folder"),
                (
                    "/Old/Child.md",
                    "33333333-3333-4333-8333-333333333333",
                    "markdown",
                ),
                (
                    "/Backlinker.md",
                    "44444444-4444-4444-8444-444444444444",
                    "markdown",
                ),
            ],
        )
        .await;
        insert_test_content_doc(&server, "33333333-3333-4333-8333-333333333333", "Child").await;
        insert_test_content_doc(
            &server,
            "44444444-4444-4444-8444-444444444444",
            "See [[Old/Child]]",
        )
        .await;
        insert_backlink(
            &server,
            &folder_doc_id,
            "33333333-3333-4333-8333-333333333333",
            "44444444-4444-4444-8444-444444444444",
        );

        let result = server
            .move_path("Relay Folder 1/Old", "/New", None)
            .await
            .unwrap();

        assert_eq!(result.links_rewritten, 1);
        assert_eq!(
            content_text(&server, "44444444-4444-4444-8444-444444444444"),
            "See [[New/Child]]"
        );
    }

    #[tokio::test]
    async fn folder_rename_without_backlinkers_reports_zero_rewrites() {
        let server = Server::new_for_test();
        insert_test_folder_doc(
            &server,
            "Relay Folder 1",
            &[
                ("/Old", "22222222-2222-4222-8222-222222222222", "folder"),
                (
                    "/Old/Child.md",
                    "33333333-3333-4333-8333-333333333333",
                    "markdown",
                ),
            ],
        )
        .await;
        insert_test_content_doc(&server, "33333333-3333-4333-8333-333333333333", "Child").await;

        let result = server
            .move_path("Relay Folder 1/Old", "/New", None)
            .await
            .unwrap();

        assert_eq!(result.links_rewritten, 0);
    }

    #[tokio::test]
    async fn move_path_rejects_folder_destination_collision_without_mutation() {
        let server = Server::new_for_test();
        let folder_doc_id = insert_test_folder_doc(
            &server,
            "Relay Folder 1",
            &[
                ("/Old", "22222222-2222-4222-8222-222222222222", "folder"),
                (
                    "/Existing",
                    "55555555-5555-4555-8555-555555555555",
                    "folder",
                ),
            ],
        )
        .await;

        let result = server
            .move_path("Relay Folder 1/Old", "/Existing", None)
            .await;

        assert!(matches!(result, Err(MoveDocumentError::Conflict(_))));
        assert!(filemeta_has(&server, &folder_doc_id, "/Old"));
        assert!(filemeta_has(&server, &folder_doc_id, "/Existing"));
    }

    #[tokio::test]
    async fn move_path_rejects_descendant_destination_collision_without_mutation() {
        let server = Server::new_for_test();
        let folder_doc_id = insert_test_folder_doc(
            &server,
            "Relay Folder 1",
            &[
                ("/Old", "22222222-2222-4222-8222-222222222222", "folder"),
                (
                    "/Old/Child.md",
                    "33333333-3333-4333-8333-333333333333",
                    "markdown",
                ),
                (
                    "/New/Child.md",
                    "44444444-4444-4444-8444-444444444444",
                    "markdown",
                ),
            ],
        )
        .await;
        insert_test_content_doc(&server, "33333333-3333-4333-8333-333333333333", "Child").await;
        insert_test_content_doc(&server, "44444444-4444-4444-8444-444444444444", "Existing").await;

        let result = server.move_path("Relay Folder 1/Old", "/New", None).await;

        assert!(matches!(result, Err(MoveDocumentError::Conflict(_))));
        assert!(filemeta_has(&server, &folder_doc_id, "/Old"));
        assert!(filemeta_has(&server, &folder_doc_id, "/Old/Child.md"));
        assert!(filemeta_has(&server, &folder_doc_id, "/New/Child.md"));
        assert!(!filemeta_has(&server, &folder_doc_id, "/New"));
    }

    #[tokio::test]
    async fn move_path_rejects_invalid_folder_destinations_without_mutation() {
        let invalid_destinations = ["/", "/New/", "/New//Child", "/.", "/..", "/New/../Child"];
        for new_path in invalid_destinations {
            let server = Server::new_for_test();
            let folder_doc_id = insert_test_folder_doc(
                &server,
                "Relay Folder 1",
                &[("/Old", "22222222-2222-4222-8222-222222222222", "folder")],
            )
            .await;

            let result = server.move_path("Relay Folder 1/Old", new_path, None).await;

            assert!(
                matches!(result, Err(MoveDocumentError::BadRequest(_))),
                "expected BadRequest for {new_path}"
            );
            assert!(filemeta_has(&server, &folder_doc_id, "/Old"));
            assert!(!filemeta_has(&server, &folder_doc_id, new_path));
        }
    }

    #[tokio::test]
    async fn move_path_rejects_folder_cross_folder_move() {
        let server = Server::new_for_test();
        let folder_doc_id = insert_test_folder_doc(
            &server,
            "Relay Folder 1",
            &[("/Old", "22222222-2222-4222-8222-222222222222", "folder")],
        )
        .await;

        let result = server
            .move_path("Relay Folder 1/Old", "/New", Some("Relay Folder 2"))
            .await;

        assert!(matches!(result, Err(MoveDocumentError::BadRequest(_))));
        assert!(filemeta_has(&server, &folder_doc_id, "/Old"));
    }

    #[tokio::test]
    async fn move_path_rejects_folder_to_markdown_destination() {
        let server = Server::new_for_test();
        let folder_doc_id = insert_test_folder_doc(
            &server,
            "Relay Folder 1",
            &[("/Old", "22222222-2222-4222-8222-222222222222", "folder")],
        )
        .await;

        let result = server
            .move_path("Relay Folder 1/Old", "/Old.md", None)
            .await;

        assert!(matches!(result, Err(MoveDocumentError::BadRequest(_))));
        assert!(filemeta_has(&server, &folder_doc_id, "/Old"));
        assert!(!filemeta_has(&server, &folder_doc_id, "/Old.md"));
    }

    #[tokio::test]
    async fn move_path_rejects_folder_descendant_destination() {
        let server = Server::new_for_test();
        let folder_doc_id = insert_test_folder_doc(
            &server,
            "Relay Folder 1",
            &[("/Old", "22222222-2222-4222-8222-222222222222", "folder")],
        )
        .await;

        let result = server
            .move_path("Relay Folder 1/Old", "/Old/Sub", None)
            .await;

        assert!(matches!(result, Err(MoveDocumentError::BadRequest(_))));
        assert!(filemeta_has(&server, &folder_doc_id, "/Old"));
        assert!(!filemeta_has(&server, &folder_doc_id, "/Old/Sub"));
    }

    #[tokio::test]
    async fn handle_move_path_route_moves_file() {
        let server = Server::new_for_test();
        let folder_doc_id = insert_test_folder_doc(
            &server,
            "Relay Folder 1",
            &[(
                "/Old.md",
                "11111111-1111-4111-8111-111111111111",
                "markdown",
            )],
        )
        .await;
        insert_test_content_doc(&server, "11111111-1111-4111-8111-111111111111", "Old").await;

        let (status, body) = post_move(
            &server,
            json!({ "path": "Relay Folder 1/Old.md", "new_path": "/New.md" }),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["old_path"], "/Old.md");
        assert_eq!(body["new_path"], "/New.md");
        assert_eq!(body["old_folder"], "Relay Folder 1");
        assert_eq!(body["new_folder"], "Relay Folder 1");
        assert!(filemeta_has(&server, &folder_doc_id, "/New.md"));
    }

    #[tokio::test]
    async fn handle_move_path_route_renames_folder() {
        let server = Server::new_for_test();
        let folder_doc_id = insert_test_folder_doc(
            &server,
            "Relay Folder 1",
            &[("/Old", "22222222-2222-4222-8222-222222222222", "folder")],
        )
        .await;

        let (status, body) = post_move(
            &server,
            json!({ "path": "Relay Folder 1/Old", "new_path": "/New" }),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["old_path"], "/Old");
        assert_eq!(body["new_path"], "/New");
        assert!(filemeta_has(&server, &folder_doc_id, "/New"));
    }

    #[tokio::test]
    async fn handle_move_path_route_returns_conflict_for_collision() {
        let server = Server::new_for_test();
        insert_test_folder_doc(
            &server,
            "Relay Folder 1",
            &[
                ("/Old", "22222222-2222-4222-8222-222222222222", "folder"),
                (
                    "/Existing",
                    "55555555-5555-4555-8555-555555555555",
                    "folder",
                ),
            ],
        )
        .await;

        let (status, _) = post_move(
            &server,
            json!({ "path": "Relay Folder 1/Old", "new_path": "/Existing" }),
        )
        .await;

        assert_eq!(status, StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn handle_move_path_route_returns_bad_request_for_folder_cross_folder_move() {
        let server = Server::new_for_test();
        insert_test_folder_doc(
            &server,
            "Relay Folder 1",
            &[("/Old", "22222222-2222-4222-8222-222222222222", "folder")],
        )
        .await;

        let (status, _) = post_move(
            &server,
            json!({
                "path": "Relay Folder 1/Old",
                "new_path": "/New",
                "target_folder": "Relay Folder 2"
            }),
        )
        .await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn test_auth_doc() {
        let server_state = Server::new_without_workers(
            None,
            Duration::from_secs(60),
            None,
            None,
            vec![],
            CancellationToken::new(),
            true,
            None,
        )
        .await
        .unwrap();

        let doc_id = server_state.create_doc().await.unwrap();

        let token = auth_doc(
            None,
            TypedHeader(headers::Host::from(http::uri::Authority::from_static(
                "localhost",
            ))),
            State(Arc::new(server_state)),
            Path(doc_id.clone()),
            Some(Json(AuthDocRequest {
                authorization: Authorization::Full,
                user_id: None,
                valid_for_seconds: None,
            })),
        )
        .await
        .unwrap();

        let expected_url = format!("ws://localhost/d/{doc_id}/ws");
        assert_eq!(token.url, expected_url);
        assert_eq!(token.doc_id, doc_id);
        assert!(token.token.is_none());
    }

    #[tokio::test]
    async fn test_auth_doc_with_prefix() {
        let prefix: Url = "https://foo.bar".parse().unwrap();
        let server_state = Server::new_without_workers(
            None,
            Duration::from_secs(60),
            None,
            Some(prefix),
            vec![],
            CancellationToken::new(),
            true,
            None,
        )
        .await
        .unwrap();

        let doc_id = server_state.create_doc().await.unwrap();

        let token = auth_doc(
            None,
            TypedHeader(headers::Host::from(http::uri::Authority::from_static(
                "localhost",
            ))),
            State(Arc::new(server_state)),
            Path(doc_id.clone()),
            None,
        )
        .await
        .unwrap();

        let expected_url = format!("wss://foo.bar/d/{doc_id}/ws");
        assert_eq!(token.url, expected_url);
        assert_eq!(token.doc_id, doc_id);
        assert!(token.token.is_none());
    }

    #[tokio::test]
    async fn test_websocket_auth_rejects_missing_token_when_auth_configured() {
        let authenticator = y_sweet_core::auth::Authenticator::gen_key().unwrap();
        let server_state = Arc::new(
            Server::new_without_workers(
                None,
                Duration::from_secs(60),
                Some(authenticator),
                None,
                vec![],
                CancellationToken::new(),
                true,
                None,
            )
            .await
            .unwrap(),
        );

        let err = verify_socket_token(&server_state, "test-doc", None).unwrap_err();

        assert_eq!(err.status, StatusCode::UNAUTHORIZED);
        assert_eq!(err.auth_error_type, Some("missing_token"));
    }

    #[tokio::test]
    async fn test_websocket_auth_allows_missing_token_without_authenticator() {
        let server_state = Arc::new(
            Server::new_without_workers(
                None,
                Duration::from_secs(60),
                None,
                None,
                vec![],
                CancellationToken::new(),
                true,
                None,
            )
            .await
            .unwrap(),
        );

        let (authorization, channel, user) =
            verify_socket_token(&server_state, "test-doc", None).unwrap();

        assert_eq!(authorization, Authorization::Full);
        assert_eq!(channel, None);
        assert_eq!(user, None);
    }

    #[tokio::test]
    async fn test_read_only_socket_access_allows_persisted_unloaded_doc() {
        use async_trait::async_trait;
        use std::collections::HashSet;
        use y_sweet_core::store::Result as StoreResult;

        struct ExistingDocStore {
            existing_keys: HashSet<String>,
        }

        #[async_trait]
        impl Store for ExistingDocStore {
            async fn init(&self) -> StoreResult<()> {
                Ok(())
            }

            async fn get(&self, _key: &str) -> StoreResult<Option<Vec<u8>>> {
                Ok(None)
            }

            async fn set(&self, _key: &str, _value: Vec<u8>) -> StoreResult<()> {
                Ok(())
            }

            async fn remove(&self, _key: &str) -> StoreResult<()> {
                Ok(())
            }

            async fn exists(&self, key: &str) -> StoreResult<bool> {
                Ok(self.existing_keys.contains(key))
            }
        }

        let doc_id = "persisted-doc";
        let store = ExistingDocStore {
            existing_keys: HashSet::from([format!("{}/data.ysweet", doc_id)]),
        };
        let server = Server::new_without_workers(
            Some(Box::new(store)),
            Duration::from_secs(60),
            None,
            None,
            vec![],
            CancellationToken::new(),
            true,
            None,
        )
        .await
        .unwrap();

        assert!(!server.docs.contains_key(doc_id));
        server
            .ensure_socket_doc_access(doc_id, Authorization::ReadOnly)
            .await
            .unwrap();

        let err = server
            .ensure_socket_doc_access("missing-doc", Authorization::ReadOnly)
            .await
            .unwrap_err();
        assert_eq!(err.status, StatusCode::NOT_FOUND);

        server
            .ensure_socket_doc_access("new-doc", Authorization::Full)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn test_file_head_endpoint() {
        use async_trait::async_trait;
        use std::collections::HashMap;
        use std::sync::Arc;
        use y_sweet_core::store::Result as StoreResult;

        // Create a mock store for testing
        #[derive(Clone)]
        struct MockStore {
            files: Arc<HashMap<String, Vec<u8>>>,
        }

        #[async_trait]
        impl Store for MockStore {
            async fn init(&self) -> StoreResult<()> {
                Ok(())
            }

            async fn get(&self, key: &str) -> StoreResult<Option<Vec<u8>>> {
                Ok(self.files.get(key).cloned())
            }

            async fn set(&self, _key: &str, _value: Vec<u8>) -> StoreResult<()> {
                Ok(())
            }

            async fn remove(&self, _key: &str) -> StoreResult<()> {
                Ok(())
            }

            async fn exists(&self, key: &str) -> StoreResult<bool> {
                Ok(self.files.contains_key(key))
            }

            async fn generate_upload_url(
                &self,
                _key: &str,
                _content_type: Option<&str>,
                _content_length: Option<u64>,
            ) -> StoreResult<Option<String>> {
                Ok(Some("http://mock-upload-url".to_string()))
            }

            async fn generate_download_url(&self, _key: &str) -> StoreResult<Option<String>> {
                Ok(Some("http://mock-download-url".to_string()))
            }
        }

        // Create a mock authenticator
        let mut authenticator = y_sweet_core::auth::Authenticator::gen_key().unwrap();
        authenticator.set_expected_audience(Some("https://api.example.com".to_string()));
        let doc_id = "test-doc-123";
        let file_hash = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

        // Generate a file token
        let token = authenticator
            .gen_file_token_cwt(
                file_hash,
                doc_id,
                Authorization::Full,
                ExpirationTimeEpochMillis(u64::MAX), // Never expires for test
                None,
                None,
                None,
                None, // channel
            )
            .unwrap();

        // Set up the mock store with the test file
        let mut mock_files = HashMap::new();
        mock_files.insert(format!("files/{}/{}", doc_id, file_hash), vec![1, 2, 3, 4]);

        let mock_store = MockStore {
            files: Arc::new(mock_files),
        };

        // Create the server with our mock components
        let server_state = Arc::new(
            Server::new_without_workers(
                Some(Box::new(mock_store)),
                Duration::from_secs(60),
                Some(authenticator.clone()),
                None,
                vec![],
                CancellationToken::new(),
                true,
                None,
            )
            .await
            .unwrap(),
        );

        // Create auth header with token
        let headers = TypedHeader(headers::Authorization::bearer(&token).unwrap());

        // Test the HEAD endpoint - should return 200 OK for existing file
        let result = handle_file_head(
            State(server_state.clone()),
            Path(doc_id.to_string()),
            Some(headers.clone()),
        )
        .await;

        assert!(
            result.is_ok(),
            "HEAD request should succeed for existing file"
        );
        assert_eq!(result.unwrap(), StatusCode::OK);

        // Test a file that doesn't exist
        let nonexistent_file_hash =
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
        let nonexistent_token = authenticator
            .gen_file_token_cwt(
                nonexistent_file_hash,
                doc_id,
                Authorization::Full,
                ExpirationTimeEpochMillis(u64::MAX),
                None,
                None,
                None,
                None, // channel
            )
            .unwrap();

        let nonexistent_headers =
            TypedHeader(headers::Authorization::bearer(&nonexistent_token).unwrap());

        let result = handle_file_head(
            State(server_state),
            Path(doc_id.to_string()),
            Some(nonexistent_headers),
        )
        .await;

        assert!(
            result.is_err(),
            "HEAD request should fail for non-existent file"
        );
        match result {
            Err(ref e) => assert_eq!(e.status, StatusCode::NOT_FOUND),
            _ => panic!("Expected NOT_FOUND status for non-existent file"),
        };
    }

    #[tokio::test]
    async fn test_generate_context_aware_urls_with_prefix() {
        let url: Url = "https://api.example.com".parse().unwrap();
        let allowed_hosts = vec![];
        let doc_id = "test-doc";

        let (ws_url, base_url) =
            generate_context_aware_urls(&Some(url), &allowed_hosts, "unused-host", doc_id).unwrap();

        assert_eq!(ws_url, "wss://api.example.com/d/test-doc/ws");
        assert_eq!(base_url, "https://api.example.com/d/test-doc");
    }

    #[tokio::test]
    async fn test_generate_context_aware_urls_with_allowed_hosts() {
        let allowed_hosts = vec![
            AllowedHost {
                host: "api.example.com".to_string(),
                scheme: "https".to_string(),
            },
            AllowedHost {
                host: "app.flycast".to_string(),
                scheme: "http".to_string(),
            },
        ];
        let doc_id = "test-doc";

        // Test HTTPS host
        let (ws_url, base_url) =
            generate_context_aware_urls(&None, &allowed_hosts, "api.example.com", doc_id).unwrap();

        assert_eq!(ws_url, "wss://api.example.com/d/test-doc/ws");
        assert_eq!(base_url, "https://api.example.com/d/test-doc");

        // Test flycast host
        let (ws_url, base_url) =
            generate_context_aware_urls(&None, &allowed_hosts, "app.flycast", doc_id).unwrap();

        assert_eq!(ws_url, "ws://app.flycast/d/test-doc/ws");
        assert_eq!(base_url, "http://app.flycast/d/test-doc");
    }

    #[tokio::test]
    async fn test_generate_context_aware_urls_rejects_unknown_host() {
        let allowed_hosts = vec![AllowedHost {
            host: "api.example.com".to_string(),
            scheme: "https".to_string(),
        }];
        let doc_id = "test-doc";

        let result = generate_context_aware_urls(&None, &allowed_hosts, "malicious.host", doc_id);

        assert!(result.is_err());
        match result {
            Err(ref e) if e.status == StatusCode::BAD_REQUEST => {} // Expected
            _ => panic!("Expected BAD_REQUEST for unknown host"),
        }
    }

    #[tokio::test]
    async fn test_auth_doc_with_context_aware_urls() {
        let allowed_hosts = vec![
            AllowedHost {
                host: "api.example.com".to_string(),
                scheme: "https".to_string(),
            },
            AllowedHost {
                host: "app.flycast".to_string(),
                scheme: "http".to_string(),
            },
        ];

        let server_state = Arc::new(
            Server::new_without_workers(
                None,
                Duration::from_secs(60),
                None,
                None, // No URL prefix - use context-aware generation
                allowed_hosts.clone(),
                CancellationToken::new(),
                true,
                None,
            )
            .await
            .unwrap(),
        );

        let doc_id = server_state.create_doc().await.unwrap();

        // Test with HTTPS host
        let token = auth_doc(
            None,
            TypedHeader(headers::Host::from(http::uri::Authority::from_static(
                "api.example.com",
            ))),
            State(server_state.clone()),
            Path(doc_id.clone()),
            Some(Json(AuthDocRequest {
                authorization: Authorization::Full,
                user_id: None,
                valid_for_seconds: None,
            })),
        )
        .await
        .unwrap();

        assert_eq!(token.url, format!("wss://api.example.com/d/{}/ws", doc_id));
        assert_eq!(
            token.base_url,
            Some(format!("https://api.example.com/d/{}", doc_id))
        );

        // Test with flycast host - create another server instance with same allowed hosts
        let server_state2 = Arc::new(
            Server::new_without_workers(
                None,
                Duration::from_secs(60),
                None,
                None,
                allowed_hosts,
                CancellationToken::new(),
                true,
                None,
            )
            .await
            .unwrap(),
        );

        server_state2.load_doc(&doc_id, None).await.unwrap();

        let token = auth_doc(
            None,
            TypedHeader(headers::Host::from(http::uri::Authority::from_static(
                "app.flycast",
            ))),
            State(server_state2),
            Path(doc_id.clone()),
            Some(Json(AuthDocRequest {
                authorization: Authorization::Full,
                user_id: None,
                valid_for_seconds: None,
            })),
        )
        .await
        .unwrap();

        assert_eq!(token.url, format!("ws://app.flycast/d/{}/ws", doc_id));
        assert_eq!(
            token.base_url,
            Some(format!("http://app.flycast/d/{}", doc_id))
        );
    }

    #[tokio::test]
    async fn test_file_upload_url_with_filesystem_store() {
        use crate::stores::filesystem::FileSystemStore;
        use tempfile::TempDir;
        use y_sweet_core::api_types::Authorization;
        use y_sweet_core::auth::{Authenticator, ExpirationTimeEpochMillis};

        // Create a test authenticator
        let mut authenticator = Authenticator::gen_key().unwrap();
        authenticator.set_expected_audience(Some("https://api.example.com".to_string()));

        let allowed_hosts = vec![AllowedHost {
            host: "api.example.com".to_string(),
            scheme: "https".to_string(),
        }];

        // Create filesystem store
        let temp_dir = TempDir::new().unwrap();
        let store = FileSystemStore::new(temp_dir.path().to_path_buf()).unwrap();

        let server_state = Arc::new(
            Server::new_without_workers(
                Some(Box::new(store)),
                Duration::from_secs(60),
                Some(authenticator.clone()),
                None,
                allowed_hosts,
                CancellationToken::new(),
                true,
                None,
            )
            .await
            .unwrap(),
        );

        let doc_id = "test-doc";
        let file_hash = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

        // Generate a file token
        let token = authenticator
            .gen_file_token_cwt(
                file_hash,
                doc_id,
                Authorization::Full,
                ExpirationTimeEpochMillis(u64::MAX),
                Some("image/png"),
                Some(1024),
                None,
                None,
            )
            .unwrap();

        // Test upload URL generation
        let host_header = TypedHeader(headers::Host::from(http::uri::Authority::from_static(
            "api.example.com",
        )));
        let auth_header = Some(TypedHeader(headers::Authorization::bearer(&token).unwrap()));

        let result = handle_file_upload_url(
            State(server_state),
            Path(doc_id.to_string()),
            host_header,
            Query(FileUploadQueryParams {
                hash: None,
                content_type: None,
                content_length: None,
            }),
            auth_header,
        )
        .await
        .unwrap();

        let Json(response) = result;
        // Should get full HTTPS URL with token
        assert!(response
            .upload_url
            .starts_with("https://api.example.com/f/"));
        assert!(response
            .upload_url
            .contains(&format!("/f/{}/upload", doc_id)));
        assert!(response.upload_url.contains(&format!("token={}", token)));
    }

    #[tokio::test]
    async fn test_file_upload_url_with_server_token() {
        use crate::stores::filesystem::FileSystemStore;
        use tempfile::TempDir;
        use y_sweet_core::auth::Authenticator;

        let mut authenticator = Authenticator::gen_key().unwrap();
        authenticator.set_expected_audience(Some("https://api.example.com".to_string()));

        let allowed_hosts = vec![AllowedHost {
            host: "api.example.com".to_string(),
            scheme: "https".to_string(),
        }];

        let temp_dir = TempDir::new().unwrap();
        let store = FileSystemStore::new(temp_dir.path().to_path_buf()).unwrap();

        let server_state = Arc::new(
            Server::new_without_workers(
                Some(Box::new(store)),
                Duration::from_secs(60),
                Some(authenticator.clone()),
                None,
                allowed_hosts,
                CancellationToken::new(),
                true,
                None,
            )
            .await
            .unwrap(),
        );

        let doc_id = "test-doc-server";
        let file_hash = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

        // Generate a server token (not a file token)
        let server_token = authenticator.server_token().unwrap();

        let host_header = TypedHeader(headers::Host::from(http::uri::Authority::from_static(
            "api.example.com",
        )));
        let auth_header = Some(TypedHeader(
            headers::Authorization::bearer(&server_token).unwrap(),
        ));

        let result = handle_file_upload_url(
            State(server_state),
            Path(doc_id.to_string()),
            host_header,
            Query(FileUploadQueryParams {
                hash: Some(file_hash.to_string()),
                content_type: Some("image/png".to_string()),
                content_length: Some(2048),
            }),
            auth_header,
        )
        .await
        .unwrap();

        let Json(response) = result;
        // Should get full HTTPS URL with a freshly minted file token (not the server token)
        assert!(response
            .upload_url
            .starts_with("https://api.example.com/f/"));
        assert!(response
            .upload_url
            .contains(&format!("/f/{}/upload", doc_id)));
        assert!(!response
            .upload_url
            .contains(&format!("token={}", server_token)));
        assert!(response.upload_url.contains("token="));
    }

    #[tokio::test]
    async fn test_file_download_url_with_filesystem_store() {
        use crate::stores::filesystem::FileSystemStore;
        use tempfile::TempDir;
        use y_sweet_core::api_types::Authorization;
        use y_sweet_core::auth::{Authenticator, ExpirationTimeEpochMillis};

        // Create a test authenticator
        let mut authenticator = Authenticator::gen_key().unwrap();
        authenticator.set_expected_audience(Some("http://localhost".to_string()));

        let allowed_hosts = vec![AllowedHost {
            host: "localhost".to_string(),
            scheme: "http".to_string(),
        }];

        // Create filesystem store
        let temp_dir = TempDir::new().unwrap();
        let store = FileSystemStore::new(temp_dir.path().to_path_buf()).unwrap();

        let server_state = Arc::new(
            Server::new_without_workers(
                Some(Box::new(store)),
                Duration::from_secs(60),
                Some(authenticator.clone()),
                None,
                allowed_hosts,
                CancellationToken::new(),
                true,
                None,
            )
            .await
            .unwrap(),
        );

        let doc_id = "test-doc";
        let file_hash = "def456789012345678901234567890def456789012345678901234567890def4";

        // Generate a file token
        let token = authenticator
            .gen_file_token_cwt(
                file_hash,
                doc_id,
                Authorization::ReadOnly,
                ExpirationTimeEpochMillis(u64::MAX),
                Some("image/jpeg"),
                Some(2048),
                None,
                None,
            )
            .unwrap();

        // Test download URL generation
        let host_header = TypedHeader(headers::Host::from(http::uri::Authority::from_static(
            "localhost",
        )));
        let auth_header = Some(TypedHeader(headers::Authorization::bearer(&token).unwrap()));

        let result = handle_file_download_url(
            State(server_state),
            Path(doc_id.to_string()),
            host_header,
            Query(FileDownloadQueryParams { hash: None }),
            auth_header,
        )
        .await
        .unwrap();

        let Json(response) = result;
        // Should get full HTTP URL with hash and token
        assert!(response.download_url.starts_with("http://localhost/f/"));
        assert!(response
            .download_url
            .contains(&format!("/f/{}/download", doc_id)));
        assert!(response
            .download_url
            .contains(&format!("hash={}", file_hash)));
        assert!(response.download_url.contains(&format!("token={}", token)));
    }

    #[tokio::test]
    async fn test_resolve_doc_id_exact_match() {
        let server_state = Server::new_without_workers(
            None,
            Duration::from_secs(60),
            None,
            None,
            vec![],
            CancellationToken::new(),
            true,
            None,
        )
        .await
        .unwrap();

        let doc_id = server_state.create_doc().await.unwrap();
        let server = Arc::new(server_state);
        let resolved = server.resolve_doc_id(&doc_id).await;
        assert_eq!(resolved, Some(doc_id.clone()));
    }

    #[tokio::test]
    async fn test_resolve_doc_id_prefix_match() {
        let server_state = Server::new_without_workers(
            None,
            Duration::from_secs(60),
            None,
            None,
            vec![],
            CancellationToken::new(),
            true,
            None,
        )
        .await
        .unwrap();

        let doc_id = server_state.create_doc().await.unwrap();
        let prefix = &doc_id[..8];
        let server = Arc::new(server_state);
        let resolved = server.resolve_doc_id(prefix).await;
        assert_eq!(resolved, Some(doc_id));
    }

    #[tokio::test]
    async fn test_resolve_doc_id_compound_prefix_match() {
        let server_state = Server::new_without_workers(
            None,
            Duration::from_secs(60),
            None,
            None,
            vec![],
            CancellationToken::new(),
            true,
            None,
        )
        .await
        .unwrap();

        let full_compound =
            "a0000000-0000-4000-8000-000000000000-c0000001-0000-4000-8000-000000000001";
        server_state.load_doc(full_compound, None).await.unwrap();
        let short_compound = "a0000000-0000-4000-8000-000000000000-c0000001";
        let server = Arc::new(server_state);
        let resolved = server.resolve_doc_id(short_compound).await;
        assert_eq!(resolved, Some(full_compound.to_string()));
    }

    #[tokio::test]
    async fn test_resolve_doc_id_no_match() {
        let server_state = Server::new_without_workers(
            None,
            Duration::from_secs(60),
            None,
            None,
            vec![],
            CancellationToken::new(),
            true,
            None,
        )
        .await
        .unwrap();

        let server = Arc::new(server_state);
        let resolved = server.resolve_doc_id("nonexistent").await;
        assert_eq!(resolved, None);
    }

    #[tokio::test]
    async fn test_resolve_doc_handler() {
        let server_state = Server::new_without_workers(
            None,
            Duration::from_secs(60),
            None,
            None,
            vec![],
            CancellationToken::new(),
            true,
            None,
        )
        .await
        .unwrap();

        let doc_id = server_state.create_doc().await.unwrap();
        let prefix = doc_id[..8].to_string();

        let result = resolve_doc(None, State(Arc::new(server_state)), Path(prefix))
            .await
            .unwrap();

        let resolved_id = result.0["docId"].as_str().unwrap();
        assert_eq!(resolved_id, doc_id);
    }

    #[tokio::test]
    async fn test_resolve_doc_handler_not_found() {
        let server_state = Server::new_without_workers(
            None,
            Duration::from_secs(60),
            None,
            None,
            vec![],
            CancellationToken::new(),
            true,
            None,
        )
        .await
        .unwrap();

        let result = resolve_doc(
            None,
            State(Arc::new(server_state)),
            Path("nonexistent".to_string()),
        )
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_resolve_doc_id_ambiguous_prefix() {
        let server_state = Server::new_without_workers(
            None,
            Duration::from_secs(60),
            None,
            None,
            vec![],
            CancellationToken::new(),
            true,
            None,
        )
        .await
        .unwrap();

        // Create two docs with the same prefix
        let doc1 = "a0000000-0000-4000-8000-000000000000-c0000001-aaaa-4000-8000-000000000001";
        let doc2 = "a0000000-0000-4000-8000-000000000000-c0000001-aaaa-4000-8000-000000000002";
        server_state.load_doc(doc1, None).await.unwrap();
        server_state.load_doc(doc2, None).await.unwrap();

        let ambiguous_prefix = "a0000000-0000-4000-8000-000000000000-c0000001-aaaa";
        let server = Arc::new(server_state);
        let resolved = server.resolve_doc_id(ambiguous_prefix).await;
        assert_eq!(resolved, None); // Should return None for ambiguous match
    }

    /// Test that persistence workers terminate when docs are garbage collected.
    /// This is a regression test for the memory leak fixed in PR #401.
    #[tokio::test]
    async fn test_persistence_worker_terminates_on_gc() {
        // Use a very short checkpoint frequency to speed up the test
        let checkpoint_freq = Duration::from_millis(50);

        let (server_inner, _receivers) = Server::new(
            None,
            checkpoint_freq,
            None,
            None,
            vec![],
            CancellationToken::new(),
            true, // doc_gc enabled
            None,
        )
        .await
        .unwrap();
        let server = Arc::new(server_inner);

        // Create a doc - this spawns persistence and GC workers
        let doc_id = server.create_doc().await.unwrap();

        // Verify the doc exists
        assert!(server.docs.contains_key(&doc_id));

        // The doc has no external references (we're not holding an awareness Arc),
        // so it should be eligible for GC after 2 checkpoint intervals.
        // Wait for GC to happen (2 intervals + some buffer)
        tokio::time::sleep(checkpoint_freq * 5).await;

        // Doc should be removed by GC
        assert!(
            !server.docs.contains_key(&doc_id),
            "Doc should have been garbage collected"
        );

        // Close the tracker and wait for all workers to finish.
        // If persistence workers don't terminate (the bug), this will hang.
        server.doc_worker_tracker.close();

        let wait_result =
            tokio::time::timeout(Duration::from_secs(2), server.doc_worker_tracker.wait()).await;

        assert!(
            wait_result.is_ok(),
            "Persistence workers should terminate after GC, but they hung"
        );
    }

    // === graceful_exit_after_delay pre-exit wait ===
    //
    // Bug C escalation: when the supervisor decides to exit, we want a
    // 30s pre-exit window so Prometheus scrapers see `worker_alive=0`
    // and operators get a heads-up before the container restart cycle.
    // A SIGTERM (docker stop) must collapse the window — the
    // cancellation_token cancels and we exit immediately. These tests
    // pin down both branches without invoking `process::exit`.

    #[tokio::test(flavor = "multi_thread")]
    async fn wait_for_worker_exit_signal_returns_delay_elapsed_when_no_cancel() {
        let token = tokio_util::sync::CancellationToken::new();
        let reason = wait_for_worker_exit_signal(token, std::time::Duration::from_millis(20)).await;
        assert_eq!(reason, WorkerExitReason::DelayElapsed);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn wait_for_worker_exit_signal_returns_cancellation_when_token_fires() {
        let token = tokio_util::sync::CancellationToken::new();
        let token_for_cancel = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            token_for_cancel.cancel();
        });
        // Use a long delay so cancellation must be what unblocks us.
        let reason = wait_for_worker_exit_signal(token, std::time::Duration::from_secs(30)).await;
        assert_eq!(reason, WorkerExitReason::CancellationRequested);
    }

    /// Sanity: an already-cancelled token returns immediately, no wait.
    #[tokio::test(flavor = "multi_thread")]
    async fn wait_for_worker_exit_signal_returns_immediately_when_already_cancelled() {
        let token = tokio_util::sync::CancellationToken::new();
        token.cancel();
        let start = std::time::Instant::now();
        let reason = wait_for_worker_exit_signal(token, std::time::Duration::from_secs(30)).await;
        let elapsed = start.elapsed();
        assert_eq!(reason, WorkerExitReason::CancellationRequested);
        assert!(
            elapsed < std::time::Duration::from_millis(500),
            "already-cancelled token must not wait out the delay; took {:?}",
            elapsed
        );
    }

    // === /ready worker readiness ===
    //
    // Per the resilience design, /ready must report per-worker liveness
    // and recent panic counts so operators have a single endpoint that
    // surfaces supervisor state. The endpoint's existing "{ok: true}"
    // shape is preserved for backward compatibility, plus a new
    // "workers" array.

    #[tokio::test]
    async fn ready_reports_registered_workers_with_panic_counts() {
        let server = Server::new_for_test();
        server.worker_status.register("link_indexer");
        server.worker_status.record_panic("link_indexer", "boom");

        let Json(resp) = ready(State(server)).await;
        let json = serde_json::to_value(&resp).unwrap();

        assert_eq!(json["ok"], true, "all workers alive -> ok:true");
        let workers = json["workers"].as_array().expect("workers array");
        let li = workers
            .iter()
            .find(|w| w["name"] == "link_indexer")
            .expect("link_indexer entry");
        assert_eq!(li["alive"], true);
        assert_eq!(li["panics_in_window"], 1);
    }

    #[tokio::test]
    async fn ready_returns_ok_false_when_any_worker_dead() {
        let server = Server::new_for_test();
        server.worker_status.register("link_indexer");
        server.worker_status.register("search_index");
        server.worker_status.mark_dead("link_indexer");

        let Json(resp) = ready(State(server)).await;
        let json = serde_json::to_value(&resp).unwrap();

        assert_eq!(json["ok"], false, "dead worker -> ok:false");
    }

    #[tokio::test]
    async fn ready_with_no_workers_is_ok() {
        // No workers registered (e.g., link_indexer disabled). Vacuously OK.
        let server = Server::new_for_test();
        let Json(resp) = ready(State(server)).await;
        let json = serde_json::to_value(&resp).unwrap();

        assert_eq!(json["ok"], true);
        assert_eq!(json["workers"].as_array().unwrap().len(), 0);
    }

    async fn get_suggestions(server: &Arc<Server>, folder_id: &str) -> (StatusCode, JsonValue) {
        let response = server
            .routes()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri(format!("/suggestions?folder_id={}", folder_id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}));
        (status, body)
    }

    const SUGG_UUID: &str = "22222222-2222-4222-8222-222222222222";

    #[tokio::test]
    async fn suggestions_endpoint_reads_from_index_not_doc_scan() {
        // Prevents: regression to per-request full-folder doc scans, which
        // load every doc from storage (caused the 2026-07-02 prod hang)
        let server = Server::new_for_test();
        let folder_doc_id = insert_test_folder_doc(
            &server,
            "Relay Folder 1",
            &[("/Doc.md", SUGG_UUID, "markdown")],
        )
        .await;
        insert_test_content_doc(&server, SUGG_UUID, "Hello {++world++} end").await;

        // Index deliberately NOT populated: the endpoint must answer from the
        // index, not by scanning doc content at request time.
        let (status, body) = get_suggestions(&server, &folder_doc_id).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["files"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn suggestions_endpoint_returns_indexed_suggestions() {
        // Prevents: review page showing nothing for docs whose suggestions
        // are in the index
        let server = Server::new_for_test();
        let folder_doc_id = insert_test_folder_doc(
            &server,
            "Relay Folder 1",
            &[("/Doc.md", SUGG_UUID, "markdown")],
        )
        .await;
        server
            .suggestions_index
            .update(SUGG_UUID, scan_suggestions("Hello {++world++} end"));

        let (status, body) = get_suggestions(&server, &folder_doc_id).await;
        assert_eq!(status, StatusCode::OK);
        let files = body["files"].as_array().unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0]["path"], "/Doc.md");
        assert_eq!(
            files[0]["doc_id"],
            format!("{}-{}", TEST_RELAY_ID, SUGG_UUID)
        );
        assert_eq!(files[0]["suggestions"][0]["content"], "world");
    }

    #[tokio::test]
    async fn suggestions_endpoint_filters_uuids_not_in_folder() {
        // Prevents: stale index entries for deleted docs reappearing on the
        // review page
        let server = Server::new_for_test();
        let folder_doc_id = insert_test_folder_doc(
            &server,
            "Relay Folder 1",
            &[("/Doc.md", SUGG_UUID, "markdown")],
        )
        .await;
        server.suggestions_index.update(
            "33333333-3333-4333-8333-333333333333",
            scan_suggestions("Ghost {++entry++}"),
        );

        let (status, body) = get_suggestions(&server, &folder_doc_id).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["files"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn suggestions_endpoint_503_before_index_ready() {
        // Prevents: cold-boot requests silently returning empty results while
        // the startup scan is still running
        let server = Server::new_for_test();
        let folder_doc_id = insert_test_folder_doc(
            &server,
            "Relay Folder 1",
            &[("/Doc.md", SUGG_UUID, "markdown")],
        )
        .await;
        server
            .suggestions_ready
            .store(false, std::sync::atomic::Ordering::Release);

        let (status, _body) = get_suggestions(&server, &folder_doc_id).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn content_update_refreshes_suggestions_index() {
        // Prevents: edits (new/accepted suggestions) never reaching the index
        // because the worker path doesn't rescan
        let search_index = Arc::new(SearchIndex::new_in_memory().expect("in-memory search index"));
        let server = Server::new_for_test_with_search(search_index.clone());
        insert_test_folder_doc(
            &server,
            "Relay Folder 1",
            &[("/Doc.md", SUGG_UUID, "markdown")],
        )
        .await;
        insert_test_content_doc(&server, SUGG_UUID, "Hello {++world++} end").await;
        let doc_id = format!("{}-{}", TEST_RELAY_ID, SUGG_UUID);

        search_handle_content_update(
            &doc_id,
            &server.docs,
            &search_index,
            &server.suggestions_index,
        );
        assert!(server.suggestions_index.get(SUGG_UUID).is_some());

        // Resolve the suggestion (remove markup) and rescan: entry must go away
        {
            let doc_ref = server.docs.get(&doc_id).unwrap();
            let awareness = doc_ref.awareness();
            let guard = awareness.write().unwrap();
            let mut txn = guard.doc.transact_mut();
            let text = txn.get_or_insert_text("contents");
            let len = text.get_string(&txn).len() as u32;
            text.remove_range(&mut txn, 0, len);
            text.insert(&mut txn, 0, "Hello world end");
        }
        search_handle_content_update(
            &doc_id,
            &server.docs,
            &search_index,
            &server.suggestions_index,
        );
        assert!(server.suggestions_index.get(SUGG_UUID).is_none());
    }

    #[tokio::test]
    async fn rebuild_suggestions_index_scans_loaded_docs() {
        // Prevents: startup leaving the index empty, making the review page
        // blank after every server restart
        let server = Server::new_for_test();
        insert_test_folder_doc(
            &server,
            "Relay Folder 1",
            &[("/Doc.md", SUGG_UUID, "markdown")],
        )
        .await;
        insert_test_content_doc(&server, SUGG_UUID, "Hello {++world++} end").await;
        server
            .suggestions_ready
            .store(false, std::sync::atomic::Ordering::Release);

        server.rebuild_suggestions_index();

        assert!(server.suggestions_index.get(SUGG_UUID).is_some());
        assert!(server
            .suggestions_ready
            .load(std::sync::atomic::Ordering::Acquire));
    }
}

async fn handle_file_upload(
    State(server_state): State<Arc<Server>>,
    Path(doc_id): Path<String>,
    Query(params): Query<FileUploadParams>,
    mut multipart: Multipart,
) -> Result<StatusCode, AppError> {
    tracing::info!(doc_id = %doc_id, "Handling file upload");

    let token_str = params.token.as_deref().ok_or_else(|| {
        AppError::auth(
            StatusCode::UNAUTHORIZED,
            anyhow!("No token provided"),
            "missing_token",
        )
    })?;
    let permission = validate_file_token(&server_state, token_str, &doc_id)?;

    if let Permission::File(file_permission) = permission {
        // Only allow Full permission to upload
        if !matches!(file_permission.authorization, Authorization::Full) {
            return Err(AppError::auth(
                StatusCode::FORBIDDEN,
                anyhow!("Insufficient permissions to upload files"),
                "insufficient_permissions",
            ));
        }

        // Get file field from multipart stream
        let field = multipart
            .next_field()
            .await
            .map_err(|e| AppError::new(StatusCode::BAD_REQUEST, e.into()))?
            .ok_or_else(|| AppError::new(StatusCode::BAD_REQUEST, anyhow!("No file provided")))?;

        // Validate content-type if specified in token
        if let Some(expected_type) = &file_permission.content_type {
            if field.content_type() != Some(expected_type) {
                return Err(AppError::new(
                    StatusCode::BAD_REQUEST,
                    anyhow!("Content-Type mismatch: expected {}", expected_type),
                ));
            }
        }

        // Check if we have a store configured
        let store = server_state.store.as_ref().ok_or_else(|| {
            AppError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                anyhow!("No store configured for file uploads"),
            )
        })?;

        // Prepare for streaming validation
        let key = format!("files/{}/{}", doc_id, file_permission.file_hash);

        // Create a temporary file for atomic writes
        let temp_file = NamedTempFile::new()
            .map_err(|e| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, e.into()))?;

        let mut hasher = Sha256::new();
        let mut total_size = 0u64;
        let mut file_writer = temp_file.as_file();

        // Stream chunks while validating
        let mut stream = field.into_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| AppError::new(StatusCode::BAD_REQUEST, e.into()))?;

            // Update hash and size
            hasher.update(&chunk);
            total_size += chunk.len() as u64;

            // Early size validation
            if let Some(expected_length) = file_permission.content_length {
                if total_size > expected_length {
                    return Err(AppError::new(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        anyhow!("File exceeds expected size"),
                    ));
                }
            }

            // Write to temp file
            file_writer
                .write_all(&chunk)
                .map_err(|e| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, e.into()))?;
        }

        // Final validations
        if let Some(expected_length) = file_permission.content_length {
            if total_size != expected_length {
                return Err(AppError::new(
                    StatusCode::BAD_REQUEST,
                    anyhow!(
                        "Content-Length mismatch: expected {}, got {}",
                        expected_length,
                        total_size
                    ),
                ));
            }
        }

        let actual_hash = format!("{:x}", hasher.finalize());
        if actual_hash != file_permission.file_hash {
            return Err(AppError::new(
                StatusCode::BAD_REQUEST,
                anyhow!(
                    "File hash mismatch: expected {}, got {}",
                    file_permission.file_hash,
                    actual_hash
                ),
            ));
        }

        // Read the temp file contents and store using the store interface
        let file_contents = std::fs::read(temp_file.path())
            .map_err(|e| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, e.into()))?;

        store
            .set(&key, file_contents)
            .await
            .map_err(|e| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, e.into()))?;

        Ok(StatusCode::OK)
    } else {
        Err(AppError::new(
            StatusCode::BAD_REQUEST,
            anyhow!("Invalid permission type"),
        ))
    }
}

async fn handle_file_upload_raw(
    State(server_state): State<Arc<Server>>,
    Path(doc_id): Path<String>,
    Query(params): Query<FileUploadParams>,
    body: axum::body::Bytes,
) -> Result<StatusCode, AppError> {
    tracing::info!(doc_id = %doc_id, "Handling raw file upload");

    // Local dev fast path: no authenticator → validate by hash only (no token required).
    if server_state.authenticator.is_none() {
        let hash = params.hash.as_deref().ok_or_else(|| {
            AppError::new(
                StatusCode::BAD_REQUEST,
                anyhow!("hash query parameter required"),
            )
        })?;
        if !validate_file_hash(hash) {
            return Err(AppError::new(
                StatusCode::BAD_REQUEST,
                anyhow!("Invalid file hash format"),
            ));
        }
        let store = server_state.store.as_ref().ok_or_else(|| {
            AppError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                anyhow!("No store configured for file uploads"),
            )
        })?;
        let mut hasher = Sha256::new();
        hasher.update(&body);
        let actual_hash = format!("{:x}", hasher.finalize());
        if actual_hash != hash {
            return Err(AppError::new(
                StatusCode::BAD_REQUEST,
                anyhow!("File hash mismatch: expected {}, got {}", hash, actual_hash),
            ));
        }
        let key = format!("files/{}/{}", doc_id, hash);
        store
            .set(&key, body.to_vec())
            .await
            .map_err(|e| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, e.into()))?;
        return Ok(StatusCode::OK);
    }

    let token_str = params.token.as_deref().ok_or_else(|| {
        AppError::auth(
            StatusCode::UNAUTHORIZED,
            anyhow!("No token provided"),
            "missing_token",
        )
    })?;
    let permission = validate_file_token(&server_state, token_str, &doc_id)?;

    if let Permission::File(file_permission) = permission {
        // Only allow Full permission to upload
        if !matches!(file_permission.authorization, Authorization::Full) {
            return Err(AppError::auth(
                StatusCode::FORBIDDEN,
                anyhow!("Insufficient permissions to upload files"),
                "insufficient_permissions",
            ));
        }

        // Check if we have a store configured
        let store = server_state.store.as_ref().ok_or_else(|| {
            AppError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                anyhow!("No store configured for file uploads"),
            )
        })?;

        let key = format!("files/{}/{}", doc_id, file_permission.file_hash);

        // Validate content length if specified in token
        if let Some(expected_length) = file_permission.content_length {
            if body.len() as u64 != expected_length {
                return Err(AppError::new(
                    StatusCode::BAD_REQUEST,
                    anyhow!(
                        "Content-Length mismatch: expected {}, got {}",
                        expected_length,
                        body.len()
                    ),
                ));
            }
        }

        // Validate file hash
        let mut hasher = Sha256::new();
        hasher.update(&body);
        let actual_hash = format!("{:x}", hasher.finalize());

        if actual_hash != file_permission.file_hash {
            return Err(AppError::new(
                StatusCode::BAD_REQUEST,
                anyhow!(
                    "File hash mismatch: expected {}, got {}",
                    file_permission.file_hash,
                    actual_hash
                ),
            ));
        }

        // Store the file
        store
            .set(&key, body.to_vec())
            .await
            .map_err(|e| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, e.into()))?;

        Ok(StatusCode::OK)
    } else {
        Err(AppError::new(
            StatusCode::BAD_REQUEST,
            anyhow!("Invalid permission type"),
        ))
    }
}

async fn handle_file_download(
    State(server_state): State<Arc<Server>>,
    Path(doc_id): Path<String>,
    Query(params): Query<FileDownloadParams>,
) -> Result<Response, AppError> {
    tracing::info!(doc_id = %doc_id, hash = %params.hash, "Handling file download");

    let permission = validate_file_token(&server_state, &params.token, &doc_id)?;

    if let Permission::File(file_permission) = permission {
        // Both ReadOnly and Full can download files
        if !matches!(
            file_permission.authorization,
            Authorization::ReadOnly | Authorization::Full
        ) {
            return Err(AppError::auth(
                StatusCode::FORBIDDEN,
                anyhow!("Insufficient permissions to download file"),
                "insufficient_permissions",
            ));
        }

        // Verify the hash parameter matches the token
        if file_permission.file_hash != params.hash {
            return Err(AppError::new(
                StatusCode::BAD_REQUEST,
                anyhow!("Hash parameter does not match token"),
            ));
        }

        // Check if we have a store configured
        let store = server_state.store.as_ref().ok_or_else(|| {
            AppError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                anyhow!("No store configured for file downloads"),
            )
        })?;

        // Retrieve file
        let key = format!("files/{}/{}", doc_id, file_permission.file_hash);
        let file_data = store
            .get(&key)
            .await
            .map_err(|e| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, e.into()))?
            .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, anyhow!("File not found")))?;

        // Stream response
        let content_type = file_permission
            .content_type
            .unwrap_or_else(|| "application/octet-stream".to_string());

        Ok(Response::builder()
            .status(StatusCode::OK)
            .header("content-type", content_type)
            .header("content-length", file_data.len())
            .body(axum::body::Body::from(file_data))
            .map_err(|e| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, e.into()))?)
    } else {
        Err(AppError::new(
            StatusCode::BAD_REQUEST,
            anyhow!("Invalid permission type"),
        ))
    }
}

/// Unauthenticated blob read — only registered when no auth key is configured (local dev).
/// Reads file content directly from the store by doc_id and hash.
async fn handle_blob_read(
    State(server_state): State<Arc<Server>>,
    Path((doc_id, hash)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let store = server_state.store().as_ref().ok_or_else(|| {
        AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            anyhow!("No store configured"),
        )
    })?;

    let key = format!("files/{}/{}", doc_id, hash);
    let data = store
        .get(&key)
        .await
        .map_err(|e| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, e.into()))?
        .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, anyhow!("Blob not found")))?;

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/octet-stream")
        .header("content-length", data.len())
        .body(axum::body::Body::from(data))
        .map_err(|e| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, e.into()))?)
}
