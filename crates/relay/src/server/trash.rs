//! Trash (`<shared folder>/_trash/`) and the purge sweep.
//!
//! Deleting a file or folder moves its `filemeta_v0` (and legacy `docs`)
//! entries under `/_trash/`, preserving the original relative path, and stamps
//! each moved entry with `trashed_at` (unix ms). Nothing else changes: the
//! content Y.Doc keeps its id, blobs keep their keys, and wikilinks in other
//! documents are left alone (a delete is refused while such links exist unless
//! `force` is set). Restoring is a plain `move` out of `/_trash/`, which clears
//! `trashed_at` (see `link_indexer::clear_trashed_at_if_restored`).
//!
//! The hourly purge sweep removes every trashed entry older than
//! `[server] trash_retention_days` for good: file-tree entry, content doc and
//! blobs in the store, and the search / link / suggestions / recent-changes
//! index entries. Entries under `/_trash/` without a stamp (a manual `move`
//! into the trash) are stamped on first sight so they expire too.

use super::{current_time_epoch_millis, search_handle_content_update, AppError, Server};
use axum::{http::StatusCode, response::IntoResponse, response::Response, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use y_sweet_core::activity::ActivityEvent;
use y_sweet_core::link_indexer::{
    self, is_trash_path, trashed_at_from_fields, TRASHED_AT_FIELD, TRASH_ROOT,
};
use yrs::{Any, Map, ReadTxn, Transact, WriteTxn};

/// How often the purge sweep runs.
pub const TRASH_SWEEP_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// Delay before the first sweep after boot (startup reindex and doc loading
/// come first).
pub const TRASH_SWEEP_INITIAL_DELAY: Duration = Duration::from_secs(5 * 60);
/// Local-testing override (seconds) for both the initial delay and the
/// interval of the purge sweep. Never set this in production.
pub const TRASH_SWEEP_INTERVAL_ENV: &str = "RELAY_TRASH_SWEEP_INTERVAL_SECS";

const MS_PER_DAY: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

/// A document outside the trashed subtree that links into it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InboundRef {
    /// User-facing path, e.g. `Lens Edu/articles/Other.md`.
    pub path: String,
    /// Number of trashed documents this document links to.
    pub count: usize,
}

/// Error type for [`Server::trash_path`], carrying HTTP status semantics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrashError {
    /// 400: root, `_trash` itself, or something already in the trash.
    BadRequest(String),
    /// 404: no such path in any loaded folder.
    NotFound(String),
    /// 409: the trash already holds an entry at the destination path.
    Conflict(String),
    /// 409: documents outside the subtree link into it (and `force` is off).
    InboundLinks {
        path: String,
        referencing: Vec<InboundRef>,
    },
    /// 403: credential may not delete.
    Forbidden(String),
    /// 500.
    Internal(String),
}

impl std::fmt::Display for TrashError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message())
    }
}

impl std::error::Error for TrashError {}

/// One entry moved by [`Server::trash_path`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrashedEntry {
    pub uuid: String,
    pub entry_type: String,
    /// User-facing path before the move, e.g. `Lens/Notes/A.md`.
    pub old_path: String,
    /// User-facing path after the move, e.g. `Lens/_trash/Notes/A.md`.
    pub new_path: String,
}

/// Result of a successful [`Server::trash_path`].
#[derive(Debug, Clone)]
pub struct TrashResult {
    pub folder_name: String,
    pub trashed_at: u64,
    pub entries: Vec<TrashedEntry>,
}

impl TrashResult {
    /// New user-facing paths, in path order.
    pub fn trashed_paths(&self) -> Vec<String> {
        self.entries.iter().map(|e| e.new_path.clone()).collect()
    }

    /// The trash path of the entry the caller asked to delete (first entry:
    /// entries are sorted so the subtree root comes first).
    pub fn root_trash_path(&self) -> &str {
        self.entries
            .first()
            .map(|e| e.new_path.as_str())
            .unwrap_or("")
    }
}

impl TrashError {
    /// Stable machine-readable code for the JSON error body.
    pub fn code(&self) -> &'static str {
        match self {
            TrashError::BadRequest(_) => "bad_request",
            TrashError::NotFound(_) => "not_found",
            TrashError::Conflict(_) => "conflict",
            TrashError::InboundLinks { .. } => "inbound_links",
            TrashError::Forbidden(_) => "forbidden",
            TrashError::Internal(_) => "internal",
        }
    }

    pub fn status(&self) -> StatusCode {
        match self {
            TrashError::BadRequest(_) => StatusCode::BAD_REQUEST,
            TrashError::NotFound(_) => StatusCode::NOT_FOUND,
            TrashError::Conflict(_) | TrashError::InboundLinks { .. } => StatusCode::CONFLICT,
            TrashError::Forbidden(_) => StatusCode::FORBIDDEN,
            TrashError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    /// Full human/agent-facing message. For inbound links this lists the
    /// referencing documents and what to do, without suggesting how to
    /// reword anything.
    pub fn message(&self) -> String {
        match self {
            TrashError::BadRequest(m)
            | TrashError::NotFound(m)
            | TrashError::Conflict(m)
            | TrashError::Forbidden(m)
            | TrashError::Internal(m) => m.clone(),
            TrashError::InboundLinks { path, referencing } => {
                let mut lines = vec![format!(
                    "Cannot delete {}: {} document{} outside it still link{} to it:",
                    path,
                    referencing.len(),
                    if referencing.len() == 1 { "" } else { "s" },
                    if referencing.len() == 1 { "s" } else { "" },
                )];
                for r in referencing {
                    lines.push(format!(
                        "  - {} ({} link{})",
                        r.path,
                        r.count,
                        if r.count == 1 { "" } else { "s" }
                    ));
                }
                lines.push(
                    "Fix or remove those references first, then delete again. \
                     To move it to the trash anyway and leave the links as they are \
                     (validate_content will keep reporting them), pass force: true."
                        .to_string(),
                );
                lines.join("\n")
            }
        }
    }

    /// JSON error body for the HTTP endpoint (kept by `redact_error_middleware`
    /// because it is `application/json`).
    pub fn into_response(self) -> Response {
        let mut body = json!({
            "error": self.message(),
            "code": self.code(),
        });
        if let TrashError::InboundLinks { referencing, .. } = &self {
            body["referencing"] = json!(referencing);
        }
        (self.status(), Json(body)).into_response()
    }
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested below)
// ---------------------------------------------------------------------------

/// Map an in-folder path (leading slash) to its trash destination, refusing
/// the folder root, the trash root, and anything already in the trash.
pub fn trash_destination(in_folder_path: &str) -> Result<String, TrashError> {
    if in_folder_path == "/" || in_folder_path.is_empty() {
        return Err(TrashError::BadRequest(
            "Cannot delete a shared folder root. Delete files or folders inside it.".to_string(),
        ));
    }
    if in_folder_path == TRASH_ROOT {
        return Err(TrashError::BadRequest(
            "Cannot delete the _trash folder itself. Entries in it are purged automatically \
             after the retention period; restore one with the move tool."
                .to_string(),
        ));
    }
    if is_trash_path(in_folder_path) {
        return Err(TrashError::BadRequest(format!(
            "{} is already in the trash. It will be purged automatically after the retention \
             period; to keep it, move it out of _trash with the move tool.",
            in_folder_path
        )));
    }
    Ok(format!("{}{}", TRASH_ROOT, in_folder_path))
}

/// Split a user-facing path (`Lens Edu/articles/x.md`) into
/// `(folder_name, in_folder_path)` given the known folder names. The longest
/// matching folder name wins. A bare folder name maps to `/`.
pub fn split_user_path<'a>(path: &str, folder_names: &'a [String]) -> Option<(&'a str, String)> {
    let path = path.replace('\\', "/");
    let mut best: Option<(&str, String)> = None;
    for name in folder_names {
        let in_path = if path == *name {
            "/".to_string()
        } else if let Some(rest) = path.strip_prefix(&format!("{}/", name)) {
            format!("/{}", rest.trim_matches('/'))
        } else {
            continue;
        };
        if best
            .as_ref()
            .map(|(n, _)| n.len() < name.len())
            .unwrap_or(true)
        {
            best = Some((name.as_str(), in_path));
        }
    }
    best
}

/// A `filemeta_v0` entry under `/_trash/` as seen by the sweep.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrashEntry {
    /// In-folder path, e.g. `/_trash/Notes/A.md`.
    pub path: String,
    pub uuid: String,
    pub entry_type: String,
    pub trashed_at: Option<u64>,
}

/// Entries whose stamp is at least `retention_ms` old. Folder entries are
/// never selected (empty folders are removed separately); unstamped entries
/// are skipped (the sweep stamps them first).
pub fn select_expired<'a>(
    entries: &'a [TrashEntry],
    now_ms: u64,
    retention_ms: u64,
) -> Vec<&'a TrashEntry> {
    entries
        .iter()
        .filter(|e| e.entry_type != "folder")
        .filter(|e| match e.trashed_at {
            Some(ts) => now_ms.saturating_sub(ts) >= retention_ms,
            None => false,
        })
        .collect()
}

/// Folder entries under `/_trash/` (never `/_trash` itself) with no remaining
/// descendant among `all_paths`, deepest first so a chain of empty folders is
/// removed in one pass.
pub fn empty_trash_folders(all_paths: &[(String, String)]) -> Vec<String> {
    // all_paths: (path, entry_type)
    let mut remaining: Vec<String> = all_paths.iter().map(|(p, _)| p.clone()).collect();
    let mut folders: Vec<String> = all_paths
        .iter()
        .filter(|(p, t)| t == "folder" && is_trash_path(p) && p != TRASH_ROOT)
        .map(|(p, _)| p.clone())
        .collect();
    // Deepest first: longer paths (more segments) come first.
    folders.sort_by(|a, b| {
        b.matches('/')
            .count()
            .cmp(&a.matches('/').count())
            .then_with(|| a.cmp(b))
    });
    let mut removed = Vec::new();
    for folder in folders {
        let prefix = format!("{}/", folder);
        if remaining.iter().any(|p| p.starts_with(&prefix)) {
            continue;
        }
        remaining.retain(|p| p != &folder);
        removed.push(folder);
    }
    removed
}

/// Count inbound links per referencing document: for every trashed target
/// uuid, each backlink source outside the subtree counts once.
pub fn inbound_references(
    subtree_uuids: &HashSet<String>,
    backlinks: &HashMap<String, Vec<String>>,
) -> HashMap<String, usize> {
    let mut refs: HashMap<String, usize> = HashMap::new();
    for target in subtree_uuids {
        if let Some(sources) = backlinks.get(target) {
            for source in sources {
                if !subtree_uuids.contains(source) {
                    *refs.entry(source.clone()).or_insert(0) += 1;
                }
            }
        }
    }
    refs
}

/// Retention window in whole milliseconds; `None` disables the sweep.
pub fn retention_from_days(days: f64) -> Option<Duration> {
    if !days.is_finite() || days <= 0.0 {
        return None;
    }
    Some(Duration::from_millis((days * MS_PER_DAY).round() as u64))
}

// ---------------------------------------------------------------------------
// Server methods
// ---------------------------------------------------------------------------

/// Snapshot of one entry about to be moved into the trash.
struct PendingMove {
    src: String,
    dest: String,
    uuid: String,
    entry_type: String,
    fields: HashMap<String, Any>,
    in_docs_map: bool,
}

/// One purged entry, for logs and tests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PurgedEntry {
    pub folder_name: String,
    /// In-folder trash path, e.g. `/_trash/Notes/A.md`.
    pub path: String,
    pub uuid: String,
    pub entry_type: String,
    pub trashed_at: u64,
}

#[derive(Debug, Default, Clone)]
pub struct PurgeReport {
    pub purged: Vec<PurgedEntry>,
    /// Entries under `/_trash/` that had no `trashed_at` and got stamped.
    pub stamped: usize,
    /// Expired entries whose purge failed (logged; retried next sweep).
    pub failed: usize,
    /// Expired entries skipped because a client still holds the doc open.
    pub skipped_in_use: usize,
    pub folders_removed: usize,
}

impl Server {
    /// Configure the purge window. `days <= 0` disables the sweep.
    pub fn set_trash_retention_days(&mut self, days: f64) {
        self.trash_retention = retention_from_days(days);
    }

    pub fn trash_retention(&self) -> Option<Duration> {
        self.trash_retention
    }

    fn folder_names_by_doc_id(&self) -> Vec<(String, String)> {
        link_indexer::find_all_folder_docs(&self.docs)
            .into_iter()
            .filter_map(|id| {
                // Arc out, shard ref dropped, before the awareness lock.
                let awareness = self.docs.get(&id)?.awareness();
                let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
                let name = y_sweet_core::doc_resolver::read_folder_name(&guard.doc, &id);
                Some((id, name))
            })
            .collect()
    }

    /// Resolve a content uuid to its user-facing path across loaded folders.
    fn user_path_for_uuid(&self, uuid: &str) -> Option<String> {
        if let Some(p) = self.doc_resolver.path_for_uuid(uuid) {
            return Some(p);
        }
        for (folder_doc_id, folder_name) in self.folder_names_by_doc_id() {
            let awareness = self.docs.get(&folder_doc_id)?.awareness();
            let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
            let txn = guard.doc.transact();
            let Some(filemeta) = txn.get_map("filemeta_v0") else {
                continue;
            };
            if let Some(path) = link_indexer::find_path_for_uuid(&filemeta, &txn, uuid) {
                return Some(format!("{}{}", folder_name, path));
            }
        }
        None
    }

    /// Move a file or folder (by user-facing path) into its shared folder's
    /// `/_trash/`, preserving the relative path and stamping `trashed_at`.
    ///
    /// Refuses with [`TrashError::InboundLinks`] when any document outside
    /// the subtree links into it, unless `force` is set. `force` never
    /// touches other documents: no wikilink rewriting.
    pub async fn trash_path(&self, path: &str, force: bool) -> Result<TrashResult, TrashError> {
        let folders = self.folder_names_by_doc_id();
        let folder_names: Vec<String> = folders.iter().map(|(_, n)| n.clone()).collect();
        let (folder_name, in_path) = split_user_path(path, &folder_names)
            .ok_or_else(|| TrashError::NotFound(format!("Path not found: {}", path)))?;
        let folder_name = folder_name.to_string();
        let folder_doc_id = folders
            .iter()
            .find(|(_, n)| *n == folder_name)
            .map(|(id, _)| id.clone())
            .ok_or_else(|| TrashError::Internal("Folder doc vanished".to_string()))?;
        // Validates root / `_trash` / already-trashed before any locking.
        trash_destination(&in_path)?;

        // Snapshot the subtree under a read lock.
        let (sync_kv, awareness) = {
            let doc_ref = self
                .docs
                .get(&folder_doc_id)
                .ok_or_else(|| TrashError::Internal("Folder doc not loaded".to_string()))?;
            (doc_ref.sync_kv(), doc_ref.awareness())
        };
        let mut pending: Vec<PendingMove> = {
            let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
            let txn = guard.doc.transact();
            let filemeta = txn
                .get_map("filemeta_v0")
                .ok_or_else(|| TrashError::NotFound(format!("Path not found: {}", path)))?;
            let docs_map = txn.get_map("docs");
            let root_type = filemeta
                .get(&txn, &in_path)
                .and_then(|v| link_indexer::extract_type_from_filemeta_entry(&v, &txn));
            let prefix = format!("{}/", in_path);
            let has_children = filemeta.keys(&txn).any(|k| k.starts_with(&prefix));
            if root_type.is_none() && !has_children {
                return Err(TrashError::NotFound(format!("Path not found: {}", path)));
            }
            let is_folder = root_type.as_deref() == Some("folder") || root_type.is_none();
            let mut keys: Vec<String> = filemeta
                .keys(&txn)
                .filter(|k| *k == in_path || (is_folder && k.starts_with(&prefix)))
                .map(|k| k.to_string())
                .collect();
            keys.sort();
            let key_set: HashSet<&str> = keys.iter().map(|k| k.as_str()).collect();
            let mut pending = Vec::with_capacity(keys.len());
            for src in &keys {
                let dest = format!("{}{}", TRASH_ROOT, src);
                if filemeta.get(&txn, &dest).is_some() && !key_set.contains(dest.as_str()) {
                    return Err(TrashError::Conflict(format!(
                        "{}{} already exists in the trash. Restore or rename that entry with \
                         the move tool first, or wait for it to be purged.",
                        folder_name, dest
                    )));
                }
                let Some(value) = filemeta.get(&txn, src) else {
                    continue;
                };
                let fields = link_indexer::extract_filemeta_fields(&value, &txn);
                let uuid =
                    link_indexer::extract_id_from_filemeta_entry(&value, &txn).unwrap_or_default();
                let entry_type = link_indexer::extract_type_from_filemeta_entry(&value, &txn)
                    .unwrap_or_else(|| "unknown".to_string());
                let in_docs_map = docs_map
                    .as_ref()
                    .map(|m| m.get(&txn, src).is_some())
                    .unwrap_or(false);
                pending.push(PendingMove {
                    src: src.clone(),
                    dest,
                    uuid,
                    entry_type,
                    fields,
                    in_docs_map,
                });
            }
            pending
        };
        if pending.is_empty() {
            return Err(TrashError::NotFound(format!("Path not found: {}", path)));
        }

        // Inbound links from outside the subtree (backlinks_v0 is keyed by
        // target uuid across every folder doc).
        let subtree_uuids: HashSet<String> = pending
            .iter()
            .filter(|p| !p.uuid.is_empty())
            .map(|p| p.uuid.clone())
            .collect();
        let refs = {
            let mut backlinks: HashMap<String, Vec<String>> = HashMap::new();
            for (id, _) in &folders {
                let Some(doc_ref) = self.docs.get(id) else {
                    continue;
                };
                let awareness = doc_ref.awareness();
                drop(doc_ref);
                let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
                let txn = guard.doc.transact();
                let Some(map) = txn.get_map("backlinks_v0") else {
                    continue;
                };
                for target in &subtree_uuids {
                    let sources = link_indexer::read_backlinks_array(&map, &txn, target);
                    if !sources.is_empty() {
                        backlinks.entry(target.clone()).or_default().extend(sources);
                    }
                }
            }
            inbound_references(&subtree_uuids, &backlinks)
        };
        if !refs.is_empty() && !force {
            let mut referencing: Vec<InboundRef> = refs
                .into_iter()
                .map(|(uuid, count)| InboundRef {
                    path: self
                        .user_path_for_uuid(&uuid)
                        .unwrap_or_else(|| format!("(unresolved document {})", uuid)),
                    count,
                })
                .collect();
            referencing.sort_by(|a, b| a.path.cmp(&b.path));
            return Err(TrashError::InboundLinks {
                path: path.to_string(),
                referencing,
            });
        }

        // Apply: one folder-doc transaction; parents before children so the
        // original folder entries (and their uuids) land before
        // `ensure_ancestor_folders` would mint replacements.
        let trashed_at = current_time_epoch_millis();
        pending.sort_by(|a, b| a.src.cmp(&b.src));
        {
            let guard = awareness.write().unwrap_or_else(|e| e.into_inner());
            let mut txn = guard
                .doc
                .transact_mut_with(link_indexer::LINK_INDEXER_ORIGIN);
            let filemeta = txn.get_or_insert_map("filemeta_v0");
            let docs_map = txn.get_or_insert_map("docs");
            // Re-check under the write lock: the tree may have changed.
            for p in &pending {
                if filemeta.get(&txn, &p.src).is_none() {
                    return Err(TrashError::Conflict(format!(
                        "{}{} changed while deleting; try again",
                        folder_name, p.src
                    )));
                }
            }
            for p in &pending {
                filemeta.remove(&mut txn, &p.src);
                docs_map.remove(&mut txn, &p.src);
            }
            for p in &mut pending {
                link_indexer::ensure_ancestor_folders(&filemeta, &docs_map, &mut txn, &p.dest);
                p.fields
                    .insert(TRASHED_AT_FIELD.to_string(), Any::Number(trashed_at as f64));
                filemeta.insert(&mut txn, p.dest.as_str(), Any::Map(p.fields.clone().into()));
                if (p.in_docs_map || p.entry_type == "markdown" || p.entry_type == "folder")
                    && !p.uuid.is_empty()
                {
                    docs_map.insert(
                        &mut txn,
                        p.dest.as_str(),
                        Any::String(p.uuid.as_str().into()),
                    );
                }
            }
        }
        if let Err(e) = sync_kv.persist().await {
            tracing::error!(?e, "Failed to persist folder doc after trash");
        }
        self.doc_resolver.rebuild(&self.docs);
        self.queue_derived_index_with_lease(&folder_doc_id);

        let relay_id = link_indexer::parse_doc_id(&folder_doc_id)
            .map(|(r, _)| r.to_string())
            .unwrap_or_default();
        let entries: Vec<TrashedEntry> = pending
            .iter()
            .map(|p| TrashedEntry {
                uuid: p.uuid.clone(),
                entry_type: p.entry_type.clone(),
                old_path: format!("{}{}", folder_name, p.src),
                new_path: format!("{}{}", folder_name, p.dest),
            })
            .collect();
        for entry in &entries {
            if entry.entry_type == "folder" || entry.uuid.is_empty() {
                continue;
            }
            let content_id = format!("{}-{}", relay_id, entry.uuid);
            if entry.entry_type == "markdown" {
                if let Some(ref search_index) = self.search_index {
                    search_handle_content_update(
                        &content_id,
                        &self.docs,
                        search_index,
                        &self.suggestions_index,
                        &self.recent_changes_index,
                    );
                }
            }
            // Best effort, in-memory only: a later content re-index replaces
            // the doc's events from its activity_v0 map.
            self.recent_changes_index.push(
                &entry.uuid,
                trash_activity_event(trashed_at, &entry.old_path, &entry.new_path),
                None,
            );
            tracing::info!(
                path = %entry.old_path,
                trash_path = %entry.new_path,
                doc_id = %content_id,
                trashed_at,
                forced = force,
                "Moved to trash"
            );
        }

        Ok(TrashResult {
            folder_name,
            trashed_at,
            entries,
        })
    }

    /// Run one purge sweep over every loaded folder doc. Never returns an
    /// error: per-entry failures are logged and counted, and the next entry
    /// is still processed.
    pub async fn purge_trash(&self, now_ms: u64) -> PurgeReport {
        let mut report = PurgeReport::default();
        let Some(retention) = self.trash_retention else {
            return report;
        };
        let retention_ms = retention.as_millis() as u64;

        for (folder_doc_id, folder_name) in self.folder_names_by_doc_id() {
            let Some((sync_kv, awareness)) = self
                .docs
                .get(&folder_doc_id)
                .map(|d| (d.sync_kv(), d.awareness()))
            else {
                continue;
            };
            let mut touched = false;

            // Snapshot every trashed entry; stamp the unstamped ones.
            let entries: Vec<TrashEntry> = {
                let guard = awareness.write().unwrap_or_else(|e| e.into_inner());
                let mut txn = guard
                    .doc
                    .transact_mut_with(link_indexer::LINK_INDEXER_ORIGIN);
                let filemeta = txn.get_or_insert_map("filemeta_v0");
                let snapshot: Vec<(String, HashMap<String, Any>)> = filemeta
                    .iter(&txn)
                    .filter(|(p, _)| is_trash_path(p) && *p != TRASH_ROOT)
                    .map(|(p, v)| {
                        (
                            p.to_string(),
                            link_indexer::extract_filemeta_fields(&v, &txn),
                        )
                    })
                    .collect();
                let mut entries = Vec::with_capacity(snapshot.len());
                for (path, mut fields) in snapshot {
                    let uuid = match fields.get("id") {
                        Some(Any::String(s)) => s.to_string(),
                        _ => String::new(),
                    };
                    let entry_type = match fields.get("type") {
                        Some(Any::String(s)) => s.to_string(),
                        _ => "unknown".to_string(),
                    };
                    let mut trashed_at = trashed_at_from_fields(&fields);
                    if trashed_at.is_none() {
                        fields.insert(TRASHED_AT_FIELD.to_string(), Any::Number(now_ms as f64));
                        filemeta.insert(&mut txn, path.as_str(), Any::Map(fields.into()));
                        trashed_at = Some(now_ms);
                        report.stamped += 1;
                        touched = true;
                        tracing::info!(
                            folder = %folder_name,
                            path = %path,
                            uuid = %uuid,
                            "Stamped trashed_at on unstamped trash entry"
                        );
                    }
                    entries.push(TrashEntry {
                        path,
                        uuid,
                        entry_type,
                        trashed_at,
                    });
                }
                // Deterministic order for logs and tests (map order is not).
                entries.sort_by(|a, b| a.path.cmp(&b.path));
                entries
            };

            for entry in select_expired(&entries, now_ms, retention_ms) {
                match self
                    .purge_entry(&folder_doc_id, &folder_name, &awareness, entry)
                    .await
                {
                    Ok(Some(purged)) => {
                        touched = true;
                        report.purged.push(purged);
                    }
                    Ok(None) => report.skipped_in_use += 1,
                    Err(e) => {
                        report.failed += 1;
                        tracing::error!(
                            folder = %folder_name,
                            path = %entry.path,
                            uuid = %entry.uuid,
                            error = ?e,
                            "Failed to purge trashed entry; will retry next sweep"
                        );
                    }
                }
            }

            // Empty folders left behind under /_trash/.
            {
                let guard = awareness.write().unwrap_or_else(|e| e.into_inner());
                let mut txn = guard
                    .doc
                    .transact_mut_with(link_indexer::LINK_INDEXER_ORIGIN);
                let filemeta = txn.get_or_insert_map("filemeta_v0");
                let docs_map = txn.get_or_insert_map("docs");
                let all: Vec<(String, String)> = filemeta
                    .iter(&txn)
                    .map(|(p, v)| {
                        (
                            p.to_string(),
                            link_indexer::extract_type_from_filemeta_entry(&v, &txn)
                                .unwrap_or_default(),
                        )
                    })
                    .collect();
                for folder in empty_trash_folders(&all) {
                    filemeta.remove(&mut txn, folder.as_str());
                    docs_map.remove(&mut txn, folder.as_str());
                    report.folders_removed += 1;
                    touched = true;
                    tracing::info!(folder = %folder_name, path = %folder, "Removed empty trash folder");
                }
            }

            if touched {
                if let Err(e) = sync_kv.persist().await {
                    tracing::error!(?e, "Failed to persist folder doc after purge");
                }
                self.doc_resolver.rebuild(&self.docs);
                self.queue_derived_index_with_lease(&folder_doc_id);
            }
        }

        if !report.purged.is_empty()
            || report.stamped > 0
            || report.failed > 0
            || report.folders_removed > 0
        {
            tracing::info!(
                purged = report.purged.len(),
                stamped = report.stamped,
                failed = report.failed,
                skipped_in_use = report.skipped_in_use,
                folders_removed = report.folders_removed,
                "Trash purge sweep finished"
            );
        }
        report
    }

    /// Delete one expired entry: file-tree keys, in-memory doc, store keys
    /// (content doc and blobs), and every index. `Ok(None)` when a client
    /// still holds the doc open (retried next sweep).
    async fn purge_entry(
        &self,
        folder_doc_id: &str,
        folder_name: &str,
        folder_awareness: &Arc<std::sync::RwLock<y_sweet_core::sync::awareness::Awareness>>,
        entry: &TrashEntry,
    ) -> anyhow::Result<Option<PurgedEntry>> {
        let relay_id = link_indexer::parse_doc_id(folder_doc_id)
            .map(|(r, _)| r.to_string())
            .unwrap_or_default();
        let content_id = if entry.uuid.is_empty() {
            String::new()
        } else {
            format!("{}-{}", relay_id, entry.uuid)
        };

        // 1. Skip while someone has the doc open.
        if !content_id.is_empty() {
            let in_use = self
                .docs
                .get(&content_id)
                .map(|d| d.has_external_refs())
                .unwrap_or(false);
            if in_use {
                tracing::info!(
                    path = %entry.path,
                    doc_id = %content_id,
                    "Purge deferred: trashed doc still has an open connection"
                );
                return Ok(None);
            }
        }

        if !content_id.is_empty() {
            // 2. Evict the in-memory doc (flush first so its persistence
            // worker has nothing left to write back, then stop that worker).
            // If the store delete below fails the doc simply reloads on
            // demand; the entry stays in filemeta_v0 for the next sweep.
            if let Some((_, doc)) = self.docs.remove(&content_id) {
                let sync_kv = doc.sync_kv();
                let _ = sync_kv.persist().await;
                sync_kv.shutdown();
            }

            // 3. Store: the content doc and every blob under files/{doc}/.
            if let Some(store) = &self.store {
                let data_key = format!("{}/data.ysweet", content_id);
                if store.exists(&data_key).await? {
                    store.remove(&data_key).await?;
                }
                let prefix = format!("files/{}/", content_id);
                for file in store.list(&prefix).await? {
                    store.remove(&format!("{}{}", prefix, file.key)).await?;
                }
            }

            // 4. Indexes.
            if let Some(ref search_index) = self.search_index {
                if let Err(e) = search_index.remove_document(&entry.uuid) {
                    tracing::warn!(uuid = %entry.uuid, ?e, "Search index removal failed");
                }
            }
            self.suggestions_index.update(&entry.uuid, Vec::new());
            self.recent_changes_index
                .update(&entry.uuid, Vec::new(), Vec::new());
            self.doc_resolver.remove_doc(&entry.uuid);
            for (id, _) in self.folder_names_by_doc_id() {
                let Some(doc_ref) = self.docs.get(&id) else {
                    continue;
                };
                let awareness = doc_ref.awareness();
                drop(doc_ref);
                let guard = awareness.write().unwrap_or_else(|e| e.into_inner());
                let _ = link_indexer::remove_doc_from_backlinks(&entry.uuid, &[&guard.doc]);
                let mut txn = guard
                    .doc
                    .transact_mut_with(link_indexer::LINK_INDEXER_ORIGIN);
                let backlinks = txn.get_or_insert_map("backlinks_v0");
                backlinks.remove(&mut txn, entry.uuid.as_str());
            }
        }

        // 5. Drop the file-tree entry (filemeta_v0 and legacy docs map) last,
        // so a failure above leaves it for the next sweep.
        {
            let guard = folder_awareness.write().unwrap_or_else(|e| e.into_inner());
            let mut txn = guard
                .doc
                .transact_mut_with(link_indexer::LINK_INDEXER_ORIGIN);
            let filemeta = txn.get_or_insert_map("filemeta_v0");
            let docs_map = txn.get_or_insert_map("docs");
            filemeta.remove(&mut txn, entry.path.as_str());
            docs_map.remove(&mut txn, entry.path.as_str());
        }

        let trashed_at = entry.trashed_at.unwrap_or_default();
        tracing::info!(
            folder = %folder_name,
            path = %entry.path,
            doc_id = %content_id,
            entry_type = %entry.entry_type,
            trashed_at,
            "Purged trashed entry"
        );
        Ok(Some(PurgedEntry {
            folder_name: folder_name.to_string(),
            path: entry.path.clone(),
            uuid: entry.uuid.clone(),
            entry_type: entry.entry_type.clone(),
            trashed_at,
        }))
    }

    /// Hourly purge loop. First run after [`TRASH_SWEEP_INITIAL_DELAY`]; both
    /// delays can be shortened with [`TRASH_SWEEP_INTERVAL_ENV`] for local
    /// testing. No-op when retention is disabled.
    pub(crate) fn spawn_trash_purge_worker(self: &Arc<Self>) {
        let Some(retention) = self.trash_retention else {
            tracing::info!("Trash purge disabled (trash_retention_days = 0)");
            return;
        };
        let (initial, interval) = match std::env::var(TRASH_SWEEP_INTERVAL_ENV)
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
        {
            Some(secs) => {
                tracing::warn!(
                    secs,
                    "{} set: trash purge sweep interval overridden (local testing only)",
                    TRASH_SWEEP_INTERVAL_ENV
                );
                (Duration::from_secs(secs), Duration::from_secs(secs))
            }
            None => (TRASH_SWEEP_INITIAL_DELAY, TRASH_SWEEP_INTERVAL),
        };
        tracing::info!(
            retention_secs = retention.as_secs(),
            interval_secs = interval.as_secs(),
            "Trash purge worker started"
        );
        let server = self.clone();
        let cancel = self.cancellation_token.clone();
        tokio::spawn(async move {
            let mut delay = initial;
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    _ = cancel.cancelled() => break,
                }
                let now_ms = current_time_epoch_millis();
                let report = server.purge_trash(now_ms).await;
                tracing::debug!(
                    purged = report.purged.len(),
                    stamped = report.stamped,
                    "Trash purge sweep done"
                );
                delay = interval;
            }
            tracing::info!("Trash purge worker exiting");
        });
    }
}

/// Recent-changes entry for a trashed entry (in-memory only, kind `trash`).
fn trash_activity_event(ts: u64, old_path: &str, new_path: &str) -> ActivityEvent {
    static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    ActivityEvent {
        id: format!("trash-{}-{}", ts, seq),
        ts,
        actor: "system:trash".to_string(),
        author: "Trash".to_string(),
        mode: "direct".to_string(),
        kind: "trash".to_string(),
        old: old_path.to_string(),
        new: new_path.to_string(),
        old_truncated: false,
        new_truncated: false,
        ctx_before: String::new(),
        ctx_after: String::new(),
        pos: 0,
        client: 0,
        clock_from: seq,
        clock_to: seq,
        anchor: None,
    }
}

// ---------------------------------------------------------------------------
// HTTP endpoint: POST /doc/trash
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct TrashRequest {
    pub path: String,
    #[serde(default)]
    pub force: bool,
}

#[derive(Serialize)]
pub(crate) struct TrashResponse {
    pub trashed: Vec<String>,
    pub trashed_at: u64,
    pub restore_hint: String,
}

pub fn restore_hint(root_trash_path: &str) -> String {
    format!(
        "move {} back with the move tool (moving out of _trash restores it)",
        root_trash_path
    )
}

/// POST /doc/trash  Body: `{ "path": "Lens/Notes/A.md", "force": false }`.
/// Server token (`Authorization::Full`) required; the editor proxy enforces
/// the Admin/Edit share-token role before forwarding. Errors are JSON
/// (`{error, code, referencing?}`) so they survive `redact_errors`.
pub(crate) async fn handle_trash_path(
    auth_header: Option<
        axum_extra::typed_header::TypedHeader<
            headers::Authorization<headers::authorization::Bearer>,
        >,
    >,
    axum::extract::State(server_state): axum::extract::State<Arc<Server>>,
    Json(body): Json<TrashRequest>,
) -> Result<Response, AppError> {
    server_state.check_auth(auth_header)?;
    match server_state.trash_path(&body.path, body.force).await {
        Ok(result) => Ok(Json(TrashResponse {
            restore_hint: restore_hint(result.root_trash_path()),
            trashed: result.trashed_paths(),
            trashed_at: result.trashed_at,
        })
        .into_response()),
        Err(e) => {
            tracing::warn!(path = %body.path, force = body.force, error = %e.message(), "trash request refused");
            Ok(e.into_response())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, entry_type: &str, trashed_at: Option<u64>) -> TrashEntry {
        TrashEntry {
            path: path.to_string(),
            uuid: format!("uuid-{}", path),
            entry_type: entry_type.to_string(),
            trashed_at,
        }
    }

    #[test]
    fn trash_destination_preserves_relative_path() {
        assert_eq!(
            trash_destination("/articles/x.md").unwrap(),
            "/_trash/articles/x.md"
        );
        assert_eq!(trash_destination("/Notes").unwrap(), "/_trash/Notes");
    }

    #[test]
    fn trash_destination_refuses_root_trash_and_already_trashed() {
        assert!(matches!(
            trash_destination("/"),
            Err(TrashError::BadRequest(m)) if m.contains("shared folder root")
        ));
        assert!(matches!(
            trash_destination("/_trash"),
            Err(TrashError::BadRequest(m)) if m.contains("_trash folder itself")
        ));
        assert!(matches!(
            trash_destination("/_trash/articles/x.md"),
            Err(TrashError::BadRequest(m)) if m.contains("already in the trash")
        ));
        // A folder merely named like the trash elsewhere is fine.
        assert_eq!(
            trash_destination("/notes/_trash/x.md").unwrap(),
            "/_trash/notes/_trash/x.md"
        );
    }

    #[test]
    fn split_user_path_prefers_longest_folder_name() {
        let names = vec!["Lens".to_string(), "Lens Edu".to_string()];
        assert_eq!(
            split_user_path("Lens Edu/articles/x.md", &names),
            Some(("Lens Edu", "/articles/x.md".to_string()))
        );
        assert_eq!(
            split_user_path("Lens/x.md", &names),
            Some(("Lens", "/x.md".to_string()))
        );
        assert_eq!(
            split_user_path("Lens Edu", &names),
            Some(("Lens Edu", "/".to_string()))
        );
        assert_eq!(
            split_user_path("Lens Edu\\a\\b.md", &names),
            Some(("Lens Edu", "/a/b.md".to_string()))
        );
        assert_eq!(split_user_path("Other/x.md", &names), None);
    }

    #[test]
    fn select_expired_skips_folders_unstamped_and_fresh_entries() {
        let day = 24 * 60 * 60 * 1000u64;
        let now = 100 * day;
        let entries = vec![
            entry("/_trash/old.md", "markdown", Some(now - 11 * day)),
            entry("/_trash/fresh.md", "markdown", Some(now - 2 * day)),
            entry("/_trash/exact.md", "markdown", Some(now - 10 * day)),
            entry("/_trash/unstamped.md", "markdown", None),
            entry("/_trash/dir", "folder", Some(now - 30 * day)),
            entry("/_trash/pic.png", "image", Some(now - 12 * day)),
        ];
        let expired: Vec<&str> = select_expired(&entries, now, 10 * day)
            .into_iter()
            .map(|e| e.path.as_str())
            .collect();
        assert_eq!(
            expired,
            vec!["/_trash/old.md", "/_trash/exact.md", "/_trash/pic.png"]
        );
    }

    #[test]
    fn empty_trash_folders_removes_chains_deepest_first_but_never_root() {
        let all = vec![
            ("/_trash".to_string(), "folder".to_string()),
            ("/_trash/a".to_string(), "folder".to_string()),
            ("/_trash/a/b".to_string(), "folder".to_string()),
            ("/_trash/c".to_string(), "folder".to_string()),
            ("/_trash/c/keep.md".to_string(), "markdown".to_string()),
            ("/live".to_string(), "folder".to_string()),
        ];
        assert_eq!(
            empty_trash_folders(&all),
            vec!["/_trash/a/b".to_string(), "/_trash/a".to_string()]
        );
    }

    #[test]
    fn inbound_references_ignores_links_from_inside_the_subtree() {
        let subtree: HashSet<String> = ["a", "b"].iter().map(|s| s.to_string()).collect();
        let mut backlinks = HashMap::new();
        backlinks.insert(
            "a".to_string(),
            vec!["b".to_string(), "x".to_string(), "y".to_string()],
        );
        backlinks.insert("b".to_string(), vec!["x".to_string(), "a".to_string()]);
        let refs = inbound_references(&subtree, &backlinks);
        assert_eq!(refs.get("x"), Some(&2));
        assert_eq!(refs.get("y"), Some(&1));
        assert_eq!(refs.get("a"), None);
        assert_eq!(refs.get("b"), None);
    }

    #[test]
    fn retention_from_days_handles_zero_and_fractions() {
        assert_eq!(retention_from_days(0.0), None);
        assert_eq!(retention_from_days(-1.0), None);
        assert_eq!(retention_from_days(f64::NAN), None);
        assert_eq!(
            retention_from_days(10.0),
            Some(Duration::from_secs(10 * 24 * 3600))
        );
        assert_eq!(
            retention_from_days(0.0000115740741),
            Some(Duration::from_millis(1000))
        );
    }

    #[test]
    fn inbound_links_message_lists_docs_and_force_hint() {
        let err = TrashError::InboundLinks {
            path: "Lens/A.md".to_string(),
            referencing: vec![
                InboundRef {
                    path: "Lens/B.md".to_string(),
                    count: 2,
                },
                InboundRef {
                    path: "Lens/C.md".to_string(),
                    count: 1,
                },
            ],
        };
        let msg = err.message();
        assert!(msg.contains("Cannot delete Lens/A.md: 2 documents outside it still link to it"));
        assert!(msg.contains("Lens/B.md (2 links)"));
        assert!(msg.contains("Lens/C.md (1 link)"));
        assert!(msg.contains("Fix or remove those references first"));
        assert!(msg.contains("force: true"));
        assert!(!msg.contains("reword"));
        assert_eq!(err.status(), StatusCode::CONFLICT);
        assert_eq!(err.code(), "inbound_links");
    }

    // ------------------------------------------------------------------
    // Purge against a real filesystem store
    // ------------------------------------------------------------------

    use crate::stores::filesystem::FileSystemStore;
    use tokio_util::sync::CancellationToken;
    use y_sweet_core::store::Store;
    use yrs::Text;

    const RELAY: &str = "cb696037-0f72-4e93-8717-4e433129d789";
    const FOLDER: &str = "b0000001-0000-4000-8000-000000000001";
    const OLD: &str = "aaaa1111-1111-4111-8111-111111111111";
    const FRESH: &str = "aaaa2222-2222-4222-8222-222222222222";
    const UNSTAMPED: &str = "aaaa3333-3333-4333-8333-333333333333";
    const PIC: &str = "aaaa4444-4444-4444-8444-444444444444";
    const LIVE: &str = "aaaa5555-5555-4555-8555-555555555555";
    const DIR: &str = "aaaa6666-6666-4666-8666-666666666666";
    const DAY_MS: u64 = 24 * 60 * 60 * 1000;

    fn cid(uuid: &str) -> String {
        format!("{}-{}", RELAY, uuid)
    }

    async fn server_with_store(store: Box<dyn Store>, days: f64) -> Arc<Server> {
        let mut server = Server::new_without_workers(
            Some(store),
            Duration::from_secs(60),
            None,
            None,
            Vec::new(),
            CancellationToken::new(),
            false,
            None,
        )
        .await
        .unwrap();
        server.set_trash_retention_days(days);
        Arc::new(server)
    }

    /// Folder "Lens" with a mix of trashed entries (stamped `now - age`),
    /// content docs persisted through the server's store, one blob per doc,
    /// backlinks Live -> Old and Old -> Live, everything in the search index.
    async fn seed(server: &Arc<Server>, now: u64) {
        let folder_id = cid(FOLDER);
        server.load_doc(&folder_id, None).await.unwrap();
        let entries: Vec<(&str, &str, &str, Option<u64>)> = vec![
            ("/_trash", DIR, "folder", None),
            (
                "/_trash/Old",
                "aaaa7777-7777-4777-8777-777777777777",
                "folder",
                Some(now - 11 * DAY_MS),
            ),
            ("/_trash/Old/A.md", OLD, "markdown", Some(now - 11 * DAY_MS)),
            (
                "/_trash/Fresh.md",
                FRESH,
                "markdown",
                Some(now - 2 * DAY_MS),
            ),
            ("/_trash/Un.md", UNSTAMPED, "markdown", None),
            ("/_trash/pic.png", PIC, "image", Some(now - 12 * DAY_MS)),
            ("/Live.md", LIVE, "markdown", None),
        ];
        {
            let awareness = server.docs().get(&folder_id).unwrap().awareness();
            let guard = awareness.write().unwrap();
            let mut txn = guard.doc.transact_mut();
            let config = txn.get_or_insert_map("folder_config");
            config.insert(&mut txn, "name", Any::String("Lens".into()));
            let filemeta = txn.get_or_insert_map("filemeta_v0");
            let docs_map = txn.get_or_insert_map("docs");
            for (path, uuid, entry_type, trashed_at) in &entries {
                let mut fields: HashMap<String, Any> = HashMap::new();
                fields.insert("id".into(), Any::String((*uuid).into()));
                fields.insert("type".into(), Any::String((*entry_type).into()));
                fields.insert("version".into(), Any::Number(0.0));
                if *entry_type == "image" {
                    fields.insert("hash".into(), Any::String("h1".into()));
                }
                if let Some(ts) = trashed_at {
                    fields.insert(TRASHED_AT_FIELD.into(), Any::Number(*ts as f64));
                }
                filemeta.insert(&mut txn, *path, Any::Map(fields.into()));
                docs_map.insert(&mut txn, *path, Any::String((*uuid).into()));
            }
            let backlinks = txn.get_or_insert_map("backlinks_v0");
            backlinks.insert(&mut txn, OLD, vec![Any::String(LIVE.into())]);
            backlinks.insert(
                &mut txn,
                LIVE,
                vec![Any::String(OLD.into()), Any::String(FRESH.into())],
            );
        }
        for (uuid, text) in [
            (OLD, "zebra-old content"),
            (FRESH, "zebra-fresh content"),
            (UNSTAMPED, "zebra-unstamped content"),
            (LIVE, "zebra-live content"),
        ] {
            let id = cid(uuid);
            server.load_doc(&id, None).await.unwrap();
            let sync_kv = {
                let doc = server.docs().get(&id).unwrap();
                let awareness = doc.awareness();
                let guard = awareness.write().unwrap();
                let mut txn = guard.doc.transact_mut();
                let t = txn.get_or_insert_text("contents");
                t.insert(&mut txn, 0, text);
                doc.sync_kv()
            };
            sync_kv.persist().await.unwrap();
            let store = server.store.as_ref().unwrap();
            store
                .set(&format!("files/{}/h1", id), b"blob".to_vec())
                .await
                .unwrap();
            if let Some(si) = &server.search_index {
                search_handle_content_update(
                    &id,
                    &server.docs,
                    si,
                    &server.suggestions_index,
                    &server.recent_changes_index,
                );
            }
        }
        server
            .store
            .as_ref()
            .unwrap()
            .set(&format!("files/{}/h1", cid(PIC)), b"png".to_vec())
            .await
            .unwrap();
        server.doc_resolver.rebuild(&server.docs);
        server.recent_changes_index.push(
            OLD,
            trash_activity_event(now - 11 * DAY_MS, "Lens/Old/A.md", "Lens/_trash/Old/A.md"),
            None,
        );
        // No workers run here, so the queued index work would keep its GC
        // leases (awareness Arcs) forever and every doc would look "in use".
        server.clear_pending_index_work_for_test();
    }

    fn folder_paths(server: &Arc<Server>) -> Vec<String> {
        let awareness = server.docs().get(&cid(FOLDER)).unwrap().awareness();
        let guard = awareness.read().unwrap();
        let txn = guard.doc.transact();
        let mut v: Vec<String> = txn
            .get_map("filemeta_v0")
            .unwrap()
            .keys(&txn)
            .map(|k| k.to_string())
            .collect();
        v.sort();
        v
    }

    fn docs_map_paths(server: &Arc<Server>) -> Vec<String> {
        let awareness = server.docs().get(&cid(FOLDER)).unwrap().awareness();
        let guard = awareness.read().unwrap();
        let txn = guard.doc.transact();
        let mut v: Vec<String> = txn
            .get_map("docs")
            .unwrap()
            .keys(&txn)
            .map(|k| k.to_string())
            .collect();
        v.sort();
        v
    }

    fn backlinks_of(server: &Arc<Server>, target: &str) -> Vec<String> {
        let awareness = server.docs().get(&cid(FOLDER)).unwrap().awareness();
        let guard = awareness.read().unwrap();
        let txn = guard.doc.transact();
        let map = txn.get_map("backlinks_v0").unwrap();
        link_indexer::read_backlinks_array(&map, &txn, target)
    }

    fn search_hits(server: &Arc<Server>, q: &str) -> Vec<String> {
        server
            .search_index
            .as_ref()
            .unwrap()
            .search(q, 10)
            .unwrap()
            .into_iter()
            .map(|r| r.doc_id)
            .collect()
    }

    #[tokio::test]
    async fn purge_removes_expired_entries_from_tree_store_and_indexes() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileSystemStore::new(dir.path().to_path_buf()).unwrap();
        let server = server_with_store(Box::new(store), 10.0).await;
        let now = 100 * DAY_MS;
        seed(&server, now).await;
        assert!(dir.path().join(cid(OLD)).join("data.ysweet").exists());
        assert_eq!(search_hits(&server, "zebra-old"), vec![OLD.to_string()]);

        let report = server.purge_trash(now).await;

        let purged: Vec<&str> = report.purged.iter().map(|p| p.path.as_str()).collect();
        assert_eq!(purged, vec!["/_trash/Old/A.md", "/_trash/pic.png"]);
        assert_eq!(report.purged[0].uuid, OLD);
        assert_eq!(report.purged[0].trashed_at, now - 11 * DAY_MS);
        assert_eq!(report.stamped, 1, "Un.md gets stamped");
        assert_eq!(report.failed, 0);
        assert_eq!(
            report.folders_removed, 1,
            "/_trash/Old is left empty and removed"
        );

        // File tree: both maps.
        assert_eq!(
            folder_paths(&server),
            vec!["/Live.md", "/_trash", "/_trash/Fresh.md", "/_trash/Un.md"]
        );
        assert_eq!(docs_map_paths(&server), folder_paths(&server));

        // Store: content doc and blobs gone, others intact.
        assert!(!dir.path().join(cid(OLD)).join("data.ysweet").exists());
        assert!(!dir.path().join("files").join(cid(OLD)).join("h1").exists());
        assert!(!dir.path().join("files").join(cid(PIC)).join("h1").exists());
        assert!(dir.path().join(cid(FRESH)).join("data.ysweet").exists());
        assert!(dir
            .path()
            .join("files")
            .join(cid(FRESH))
            .join("h1")
            .exists());
        assert!(dir.path().join(cid(LIVE)).join("data.ysweet").exists());

        // Memory and indexes.
        assert!(!server.docs().contains_key(&cid(OLD)));
        assert!(server.docs().contains_key(&cid(FRESH)));
        assert!(search_hits(&server, "zebra-old").is_empty());
        assert_eq!(search_hits(&server, "zebra-fresh"), vec![FRESH.to_string()]);
        assert_eq!(server.doc_resolver().path_for_uuid(OLD), None);
        assert_eq!(
            server.doc_resolver().path_for_uuid(FRESH).as_deref(),
            Some("Lens/_trash/Fresh.md")
        );
        assert!(
            backlinks_of(&server, OLD).is_empty(),
            "OLD no longer a target"
        );
        assert_eq!(
            backlinks_of(&server, LIVE),
            vec![FRESH.to_string()],
            "OLD no longer a source"
        );
        assert!(server.recent_changes_index().get(OLD).is_none());

        // Un.md got stamped with `now` (expires at now + 10d); Fresh.md was
        // stamped at now - 2d (expires at now + 8d). Nothing before that.
        let report = server.purge_trash(now + 7 * DAY_MS).await;
        assert!(report.purged.is_empty(), "{:?}", report.purged);
        assert_eq!(report.stamped, 0);
        let report = server.purge_trash(now + 10 * DAY_MS).await;
        let purged: Vec<&str> = report.purged.iter().map(|p| p.path.as_str()).collect();
        assert_eq!(purged, vec!["/_trash/Fresh.md", "/_trash/Un.md"]);
        assert!(!dir.path().join(cid(UNSTAMPED)).join("data.ysweet").exists());
        assert!(!dir.path().join(cid(FRESH)).join("data.ysweet").exists());
        assert_eq!(folder_paths(&server), vec!["/Live.md", "/_trash"]);
    }

    #[tokio::test]
    async fn purge_is_disabled_when_retention_is_zero() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileSystemStore::new(dir.path().to_path_buf()).unwrap();
        let server = server_with_store(Box::new(store), 0.0).await;
        assert_eq!(server.trash_retention(), None);
        let now = 100 * DAY_MS;
        seed(&server, now).await;
        let report = server.purge_trash(now).await;
        assert!(report.purged.is_empty());
        assert_eq!(report.stamped, 0);
        assert!(dir.path().join(cid(OLD)).join("data.ysweet").exists());
        assert!(folder_paths(&server).contains(&"/_trash/Old/A.md".to_string()));
    }

    #[tokio::test]
    async fn purge_skips_docs_with_open_connections() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileSystemStore::new(dir.path().to_path_buf()).unwrap();
        let server = server_with_store(Box::new(store), 10.0).await;
        let now = 100 * DAY_MS;
        seed(&server, now).await;
        // Hold the awareness Arc like a live websocket connection would.
        let held = server.docs().get(&cid(OLD)).unwrap().awareness();
        let report = server.purge_trash(now).await;
        assert_eq!(report.skipped_in_use, 1);
        let purged: Vec<&str> = report.purged.iter().map(|p| p.path.as_str()).collect();
        assert_eq!(purged, vec!["/_trash/pic.png"]);
        assert!(folder_paths(&server).contains(&"/_trash/Old/A.md".to_string()));
        assert!(dir.path().join(cid(OLD)).join("data.ysweet").exists());
        drop(held);
        let report = server.purge_trash(now).await;
        assert_eq!(report.purged.len(), 1);
        assert_eq!(report.purged[0].path, "/_trash/Old/A.md");
    }

    /// Store whose `remove` fails for keys containing `poison`.
    struct FlakyStore {
        inner: FileSystemStore,
        poison: String,
    }

    #[async_trait::async_trait]
    impl Store for FlakyStore {
        async fn init(&self) -> y_sweet_core::store::Result<()> {
            self.inner.init().await
        }
        async fn get(&self, key: &str) -> y_sweet_core::store::Result<Option<Vec<u8>>> {
            self.inner.get(key).await
        }
        async fn set(&self, key: &str, value: Vec<u8>) -> y_sweet_core::store::Result<()> {
            self.inner.set(key, value).await
        }
        async fn remove(&self, key: &str) -> y_sweet_core::store::Result<()> {
            if key.contains(&self.poison) {
                return Err(y_sweet_core::store::StoreError::ConnectionError(
                    "simulated store outage".to_string(),
                ));
            }
            self.inner.remove(key).await
        }
        async fn exists(&self, key: &str) -> y_sweet_core::store::Result<bool> {
            self.inner.exists(key).await
        }
        async fn list(
            &self,
            prefix: &str,
        ) -> y_sweet_core::store::Result<Vec<y_sweet_core::store::FileInfo>> {
            self.inner.list(prefix).await
        }
        async fn list_doc_ids(&self) -> y_sweet_core::store::Result<Vec<String>> {
            self.inner.list_doc_ids().await
        }
    }

    #[tokio::test]
    async fn purge_survives_a_failing_entry_and_retries_it_next_sweep() {
        let dir = tempfile::tempdir().unwrap();
        let store = FlakyStore {
            inner: FileSystemStore::new(dir.path().to_path_buf()).unwrap(),
            poison: OLD.to_string(),
        };
        let server = server_with_store(Box::new(store), 10.0).await;
        let now = 100 * DAY_MS;
        seed(&server, now).await;

        let report = server.purge_trash(now).await;
        assert_eq!(report.failed, 1);
        let purged: Vec<&str> = report.purged.iter().map(|p| p.path.as_str()).collect();
        assert_eq!(
            purged,
            vec!["/_trash/pic.png"],
            "the other expired entry is still purged"
        );
        assert_eq!(report.stamped, 1);
        // The failed entry stays in the tree (and its folder, not empty, stays).
        let paths = folder_paths(&server);
        assert!(paths.contains(&"/_trash/Old/A.md".to_string()));
        assert!(paths.contains(&"/_trash/Old".to_string()));
        assert!(!paths.contains(&"/_trash/pic.png".to_string()));
        // Evicted from memory but still on disk: reloadable on demand.
        assert!(!server.docs().contains_key(&cid(OLD)));
        assert!(dir.path().join(cid(OLD)).join("data.ysweet").exists());
        server.ensure_doc_loaded(&cid(OLD)).await.unwrap();
        assert!(server.docs().contains_key(&cid(OLD)));
    }
}
