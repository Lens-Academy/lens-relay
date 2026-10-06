//! MCP `validate_content`: check live relay content with the platform's
//! content validator (lens-platform `POST /api/content/check`).
//!
//! The platform validates a Git commit of the Lens Edu folder (relay-git-sync
//! pushes the folder to lens-edu-staging). The relay is ahead of that commit
//! by at least one sync, so a check tells the platform which files differ:
//!
//! 1. The relay sends `blobs`, path → Git blob id of the raw text for every
//!    file of the folder, and the raw text of the file being checked. Texts
//!    keep their CriticMarkup: the platform computes the approved view
//!    (pending suggestions rejected, what learners get) and the drafts view
//!    (pending suggestions accepted) itself.
//! 2. The platform answers `need_files` with the paths whose blob is not in
//!    its commit. The relay sends the request again with those texts added.
//!    The platform keeps nothing between rounds and its commit can move
//!    meanwhile, so every round carries every text sent so far, and the relay
//!    stops after [`MAX_ROUNDS`].
//! 3. The answer is `done`: the target's issues with the relay's files laid
//!    over the commit, the issues those files cause or fix in other files,
//!    and the pages they change.
//!
//! Without `file_path` the tool checks the whole folder (no target). A
//! platform with no `/api/content/check` yet (404) gets the older whole-folder
//! `validate-adhoc` call instead, until every platform has the new endpoint.
//!
//! After a Markdown edit in the folder, the `edit` tool adds a brief check of
//! the edited file to its reply ([`edit_check`]); it never fails the edit.
//!
//! Config: `LENS_PLATFORM_URL` (default `https://staging.lensacademy.org`)
//! and `ADHOC_VALIDATION_SECRET` (shared with lens-platform).

use super::{blob, critic_markup};
use crate::server::Server;
use futures::StreamExt;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use y_sweet_core::share_token::McpAccess;

const DEFAULT_PLATFORM_URL: &str = "https://staging.lensacademy.org";
/// The only folder the platform builds. Other folders are not course content,
/// and checking them against lens-edu-staging would report nonsense.
pub const CONTENT_FOLDER: &str = "Lens Edu";
const CHECK_PATH: &str = "/api/content/check";
const ADHOC_PATH: &str = "/api/content/validate-adhoc";
const MAX_ROUNDS: usize = 3;
/// Docs read at once (as `load_all_docs` does): a doc that is not in memory
/// costs a storage round trip of about 200 ms.
const READ_CONCURRENCY: usize = 32;
// A whole-folder validate-adhoc run took 91.6 s and 89.9 s end to end
// against production, with the platform's per-file processor cache warm; a
// lens-platform deploy that touches content_processor empties that cache.
// 120 s left no room for that; 300 s does. The fallback and validate_all keep
// it; the brief check of an edit reply has its own budget.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
// Hard ceiling so one tool call can never wedge on storage loads (reading
// the folder may pull GC-evicted docs from R2, like grep does).
const MAP_BUILD_TIMEOUT: Duration = Duration::from_secs(60);
// The fallback sends the whole folder: about 46 MB on the staging content
// (2,498 Markdown files at 27.6 MB plus 128 JSON files at 18.1 MB, nearly all
// video-transcript timestamps, which validateTimestamps checks entry by
// entry). Enforced on the serialized JSON, which is what the platform
// bounds; JSON escaping makes it larger than the raw text.
const MAX_PAYLOAD_BYTES: usize = 128 * 1024 * 1024;
/// How long the `edit` reply waits for its check before it says "skipped".
pub const EDIT_CHECK_BUDGET: Duration = Duration::from_secs(10);
/// How long edit checks leave a busy platform alone when it gave no
/// `Retry-After`, and the longest `Retry-After` they honour.
const BUSY_BACKOFF: Duration = Duration::from_secs(30);
const MAX_BACKOFF: Duration = Duration::from_secs(300);
/// Lines a check adds to an `edit` reply, summary line included.
const EDIT_CHECK_MAX_LINES: usize = 6;
/// The platform caps each list at this length when `brief` is set.
const BRIEF_LIST_CAP: usize = 10;

pub fn platform_url_from_env() -> String {
    std::env::var("LENS_PLATFORM_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_PLATFORM_URL.to_string())
}

/// Where the platform is, and the key its validator endpoints check
/// (`X-Validation-Key`).
#[derive(Clone, Debug)]
pub struct Platform {
    pub url: String,
    pub secret: String,
}

impl Platform {
    pub fn from_env() -> Result<Self, String> {
        let secret = std::env::var("ADHOC_VALIDATION_SECRET")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| {
                "Error: validate_content is not configured on this relay (ADHOC_VALIDATION_SECRET unset)."
                    .to_string()
            })?;
        Ok(Self {
            url: platform_url_from_env(),
            secret,
        })
    }

    fn endpoint(&self, path: &str) -> String {
        format!("{}{}", self.url.trim_end_matches('/'), path)
    }

    /// The host name, to say in replies which platform answered.
    fn host(&self) -> &str {
        let rest = self.url.split("://").nth(1).unwrap_or(&self.url);
        rest.split(['/', ':']).next().unwrap_or(rest)
    }
}

/// Which text of the files the platform validates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum View {
    /// Pending suggestions rejected: what learners get once the file syncs.
    Approved,
    /// Pending suggestions accepted.
    Drafts,
}

impl View {
    fn as_str(self) -> &'static str {
        match self {
            View::Approved => "approved",
            View::Drafts => "drafts",
        }
    }

    fn describe(self) -> &'static str {
        match self {
            View::Approved => "approved view (pending suggestions left out)",
            View::Drafts => "drafts view (pending suggestions accepted)",
        }
    }
}

/// The fixed inputs of one check. `target` is folder-relative
/// (`Lenses/X.md`); `None` checks the whole folder.
struct Check<'a> {
    target: Option<&'a str>,
    view: View,
    brief: bool,
    course: Option<&'a str>,
    category: Option<&'a str>,
}

enum CheckError {
    /// The platform has no `/api/content/check` (a deploy from before it).
    Unsupported,
    /// No answer (a timeout or a connection error), or the platform said it
    /// is overloaded or not ready: the reason, and `Retry-After` in seconds.
    Busy(String, Option<u64>),
    /// Anything else, as a reason a person can read.
    Failed(String),
}

impl CheckError {
    fn reason(&self) -> String {
        match self {
            CheckError::Unsupported => "the platform has no quick check yet".to_string(),
            CheckError::Busy(reason, Some(seconds)) => {
                format!("{}; retry in {} s", reason, seconds)
            }
            CheckError::Busy(reason, None) | CheckError::Failed(reason) => reason.clone(),
        }
    }
}

/// A `done` answer, and the folder-relative paths the relay could not read:
/// the platform checked those files as committed.
type Checked = (Value, Vec<String>);

/// Execute the `validate_content` tool.
pub async fn execute(
    server: &Arc<Server>,
    access: &McpAccess,
    arguments: &Value,
) -> Result<String, String> {
    let platform = Platform::from_env()?;
    execute_with_platform(server, access, arguments, &platform).await
}

pub async fn execute_with_platform(
    server: &Arc<Server>,
    access: &McpAccess,
    arguments: &Value,
    platform: &Platform,
) -> Result<String, String> {
    let view = if arguments
        .get("accept_drafts")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        View::Drafts
    } else {
        View::Approved
    };
    let course = arguments.get("course").and_then(|v| v.as_str());
    let category = arguments.get("category").and_then(|v| v.as_str());
    if let Some(cat) = category {
        if cat != "production" && cat != "wip" {
            return Err("category must be 'production' or 'wip'".to_string());
        }
    }

    // The folder comes from the token, never from an argument: a `folder`
    // argument would bypass token isolation. All-folder tokens check the
    // course folder. `file_path` is held to the token's folder by the
    // dispatch scope check, and to the course folder here.
    let token_folder = access.folder_name.as_deref().unwrap_or(CONTENT_FOLDER);
    if token_folder != CONTENT_FOLDER {
        return Err(format!(
            "Error: validate_content checks course content, which lives in the '{}' folder; this key is for '{}'.",
            CONTENT_FOLDER, token_folder
        ));
    }
    let target = match arguments.get("file_path").and_then(|v| v.as_str()) {
        None => None,
        Some(path) => Some(content_path(path).ok_or_else(|| {
            format!(
                "Error: validate_content checks files in the '{}' folder only; '{}' is not one.",
                CONTENT_FOLDER, path
            )
        })?),
    };

    let check = Check {
        target,
        view,
        brief: false,
        course,
        category,
    };
    match run_check(server, platform, &check).await {
        Ok((answer, unread)) => Ok(format_report(&answer, &unread, &check, platform)),
        Err(CheckError::Unsupported) => {
            validate_adhoc(server, platform, view, course, category).await
        }
        Err(error) => Err(format!("Error: {}", error.reason())),
    }
}

/// The lines the `edit` reply carries after a Markdown edit in the course
/// folder: a brief check of the edited file `path` (`Lens Edu/...`), in the
/// approved view after a direct edit and the drafts view after a suggestion.
/// `None` for files the check does not cover. Any failure becomes "Check
/// skipped: <reason>", because the edit has already been applied.
pub async fn edit_check(
    server: &Arc<Server>,
    path: &str,
    view: View,
    platform: Option<&Platform>,
    budget: Duration,
) -> Option<String> {
    let rel = content_path(path)?;
    if !rel.ends_with(".md") {
        return None;
    }
    let Some(platform) = platform else {
        return Some("Not checked: this relay has no ADHOC_VALIDATION_SECRET.".to_string());
    };
    if let Some(until) = busy_until(platform) {
        return Some(format!(
            "Check skipped: the platform is busy (retrying after {}). The edit stands; run validate_content later.",
            until
        ));
    }
    let check = Check {
        target: Some(rel),
        view,
        brief: true,
        course: None,
        category: None,
    };
    let outcome = tokio::time::timeout(budget, run_check(server, platform, &check))
        .await
        .unwrap_or_else(|_| {
            let reason = format!("no answer within {} s", budget.as_secs_f32().ceil() as u64);
            Err(CheckError::Busy(reason, None))
        });
    note_outcome(platform, &outcome);
    Some(match outcome {
        Ok((answer, unread)) => format_brief(&answer, &unread, view),
        // No advice to run validate_content: on this platform it falls back
        // to the slow whole-folder run.
        Err(CheckError::Unsupported) => {
            "Not checked: the quick check is not available on this platform yet.".to_string()
        }
        Err(error) => format!(
            "Check skipped: {}. The edit stands; run validate_content later.",
            error.reason()
        ),
    })
}

/// What edit checks have learnt about a platform in this process. After a
/// timeout, a connection error, 429 or 503 they leave it alone until
/// `busy_until`: while a platform hangs, every edit would otherwise wait its
/// whole budget, for every agent and for the length of the incident.
/// `failure` is the last check's failure, so that the log says when checks
/// start failing and when they work again, not once per edit. Kept per
/// platform URL, so that tests with their own mock platforms do not share it.
#[derive(Default)]
struct Health {
    busy_until: Option<Instant>,
    failure: Option<String>,
}

fn with_health<R>(platform: &Platform, f: impl FnOnce(&mut Health) -> R) -> R {
    static HEALTH: OnceLock<Mutex<HashMap<String, Health>>> = OnceLock::new();
    let mut all = HEALTH
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    f(all.entry(platform.url.clone()).or_default())
}

/// The time of day (UTC) until which edit checks leave `platform` alone, or
/// `None` when they may ask it.
fn busy_until(platform: &Platform) -> Option<String> {
    let left = with_health(platform, |h| h.busy_until)?
        .checked_duration_since(Instant::now())
        .filter(|left| !left.is_zero())?;
    let secs = (SystemTime::now() + left)
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_secs();
    let (h, m, s) = (secs / 3600 % 24, secs / 60 % 60, secs % 60);
    Some(format!("{:02}:{:02}:{:02} UTC", h, m, s))
}

/// Record how an edit check ended: back off from a busy platform, and log
/// only a change of failure (or the end of one).
fn note_outcome(platform: &Platform, outcome: &Result<Checked, CheckError>) {
    let failure = outcome.as_ref().err().map(CheckError::reason);
    with_health(platform, |health| {
        if let Err(CheckError::Busy(_, retry_after)) = outcome {
            let wait =
                retry_after.map_or(BUSY_BACKOFF, |s| Duration::from_secs(s).min(MAX_BACKOFF));
            health.busy_until = Some(Instant::now() + wait);
        }
        if health.failure != failure {
            match &failure {
                Some(reason) => tracing::warn!(
                    "validate_content: edit checks against {} fail: {}",
                    platform.host(),
                    reason
                ),
                None => tracing::info!(
                    "validate_content: edit checks against {} work again",
                    platform.host()
                ),
            }
            health.failure = failure;
        }
    });
}

/// `Lens Edu/Lenses/X.md` → `Lenses/X.md`; `None` outside the course folder.
fn content_path(path: &str) -> Option<&str> {
    path.strip_prefix(CONTENT_FOLDER)?
        .strip_prefix('/')
        .filter(|rel| !rel.is_empty())
}

/// Files the platform may read: Markdown, JSON (video timestamps) and HTML
/// widgets. The platform applies its own, narrower filter to what it gets.
fn is_content_candidate(rel: &str) -> bool {
    rel.ends_with(".md") || rel.ends_with(".json") || is_html_widget(rel)
}

/// A widget kept as an HTML page, `widgets/<name>.html`. The content processor
/// reads `.html` files only under the root widgets folder (lens-platform
/// `isWidgetFile`, and `WIDGET_EXTENSIONS` in core/content/git_fetcher.py).
fn is_html_widget(rel: &str) -> bool {
    rel.ends_with(".html") && rel.starts_with("widgets/")
}

/// The run of rounds for one check, up to the platform's `done` answer.
async fn run_check(
    server: &Arc<Server>,
    platform: &Platform,
    check: &Check<'_>,
) -> Result<Checked, CheckError> {
    let request_timeout = if check.brief {
        EDIT_CHECK_BUDGET
    } else {
        REQUEST_TIMEOUT
    };
    let FolderSnapshot {
        mut blobs,
        docs,
        complete,
        mut files,
        unread,
    } = tokio::time::timeout(MAP_BUILD_TIMEOUT, snapshot_folder(server, check.target))
        .await
        .map_err(|_| {
            CheckError::Failed(format!(
                "timed out reading the '{}' folder after {} s (docs may still be loading from storage); try again",
                CONTENT_FOLDER,
                MAP_BUILD_TIMEOUT.as_secs()
            ))
        })??;

    for _ in 0..MAX_ROUNDS {
        let body = json!({
            "view": check.view.as_str(),
            "target": check.target,
            "blobs": &blobs,
            "complete": complete,
            "files": &files,
            "course": check.course,
            "category": check.category,
            "brief": check.brief,
        });
        let answer = post_check(platform, body, request_timeout).await?;
        match answer.get("status").and_then(|v| v.as_str()) {
            Some("done") => return Ok((answer, unread)),
            Some("need_files") => {}
            other => {
                return Err(CheckError::Failed(format!(
                    "the platform answered with an unknown status {:?}",
                    other
                )))
            }
        }
        let need: Vec<&str> = answer
            .get("need")
            .and_then(|v| v.as_array())
            .map(|need| need.iter().filter_map(|p| p.as_str()).collect())
            .unwrap_or_default();
        let wanted: Vec<(String, String, String)> = need
            .iter()
            .filter(|rel| !files.contains_key(**rel))
            .filter_map(|rel| {
                let (path, doc_id) = docs.get(*rel)?;
                Some((rel.to_string(), path.clone(), doc_id.clone()))
            })
            .collect();
        if wanted.is_empty() {
            return Err(CheckError::Failed(format!(
                "the platform asked for files the relay cannot send: {}",
                need.join(", ")
            )));
        }
        for (rel, path, text) in read_texts(server, wanted).await {
            let text =
                text.ok_or_else(|| CheckError::Failed(format!("could not read {}", path)))?;
            // The text may be newer than the blob id sent so far; the two
            // must describe the same version.
            blobs.insert(rel.clone(), blob::git_blob_id(text.as_bytes()));
            files.insert(rel, text);
        }
    }
    Err(CheckError::Failed(format!(
        "the platform still needed files after {} rounds (content changed while checking); try again",
        MAX_ROUNDS
    )))
}

/// One read of the course folder for a check.
struct FolderSnapshot {
    /// Folder-relative path → Git blob id of the raw text.
    blobs: BTreeMap<String, String>,
    /// Folder-relative path → (relay path, doc id), to read a file again.
    docs: HashMap<String, (String, String)>,
    /// True when the relay knows every file: its startup index is built and
    /// every file was read. Only then may the platform count a committed path
    /// that `blobs` lacks as deleted.
    complete: bool,
    /// Raw texts to send, by folder-relative path: the target's.
    files: BTreeMap<String, String>,
    /// Files that could not be read. They are not in `blobs`, so the
    /// platform keeps their committed version.
    unread: Vec<String>,
}

async fn snapshot_folder(
    server: &Arc<Server>,
    target: Option<&str>,
) -> Result<FolderSnapshot, CheckError> {
    let prefix = format!("{}/", CONTENT_FOLDER);
    let resolver = server.doc_resolver();
    let docs: HashMap<String, (String, String)> = resolver
        .all_paths()
        .into_iter()
        .filter_map(|path| {
            let rel = path.strip_prefix(&prefix)?.to_string();
            if !is_content_candidate(&rel) {
                return None;
            }
            let doc_id = resolver.resolve_path(&path)?.doc_id;
            Some((rel, (path, doc_id)))
        })
        .collect();

    let mut files = BTreeMap::new();
    if let Some(target) = target {
        let Some((path, doc_id)) = docs.get(target) else {
            return Err(CheckError::Failed(format!(
                "no file {}/{} in the relay (validate_content checks .md, .json and widgets/*.html files)",
                CONTENT_FOLDER, target
            )));
        };
        let text = super::grep::read_doc_content(server, doc_id, path)
            .await
            .ok_or_else(|| CheckError::Failed(format!("could not read {}", path)))?;
        files.insert(target.to_string(), text);
    }

    // Owned first: a stream of futures that borrow locals is not `Send`.
    let others: Vec<(String, String, String)> = docs
        .iter()
        .filter(|(rel, _)| !files.contains_key(*rel))
        .map(|(rel, (path, doc_id))| (rel.clone(), path.clone(), doc_id.clone()))
        .collect();
    let lookups = others.into_iter().map(|(rel, path, doc_id)| {
        let server = Arc::clone(server);
        async move {
            let id = blob_id(&server, &path, &doc_id).await;
            (rel, path, id)
        }
    });
    let ids: Vec<_> = futures::stream::iter(lookups)
        .buffer_unordered(READ_CONCURRENCY)
        .collect()
        .await;
    let mut blobs = BTreeMap::new();
    let mut unread = Vec::new();
    for (rel, path, id) in ids {
        match id {
            Some(id) => {
                blobs.insert(rel, id);
            }
            None => {
                // Left out of `blobs`, so the platform keeps its committed
                // version; `complete` stops it reading that as a deletion.
                tracing::warn!("validate_content: skipping unreadable {}", path);
                unread.push(rel);
            }
        }
    }
    unread.sort();
    for (rel, text) in &files {
        blobs.insert(rel.clone(), blob::git_blob_id(text.as_bytes()));
    }
    Ok(FolderSnapshot {
        blobs,
        docs,
        complete: server.search_is_ready() && unread.is_empty(),
        files,
        unread,
    })
}

/// Git blob id of a file's raw text, from a cache when possible, so a check
/// of the whole folder loads only docs edited since their id was taken.
/// `None` for a file that cannot be read.
async fn blob_id(server: &Arc<Server>, path: &str, doc_id: &str) -> Option<String> {
    use yrs::{GetString, ReadTxn, Transact};
    if blob::is_blob_file(path) {
        let hash = server.doc_resolver().get_file_hash(path)?;
        return blob::stored_git_blob_id(server, doc_id, &hash).await.ok();
    }
    if let Some(id) = server.text_blob_ids().get(doc_id) {
        return Some(id.clone());
    }
    server.ensure_doc_loaded(doc_id).await.ok()?;
    // Arc out of the docs map first: never hold a `docs` shard across an
    // awareness lock (AGENTS.md, "Known Issues").
    let awareness = server.docs().get(doc_id).map(|doc| doc.awareness())?;
    let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
    let text = {
        let txn = guard.doc.transact();
        txn.get_text("contents")
            .map(|text| text.get_string(&txn))
            .unwrap_or_default()
    };
    let id = blob::git_blob_id(text.as_bytes());
    // Stored before the read guard is released, so no update can come
    // between the text and its id; every later update removes the entry.
    server
        .text_blob_ids()
        .insert(doc_id.to_string(), id.clone());
    drop(guard);
    Some(id)
}

/// Read `(rel, relay path, doc id)` files [`READ_CONCURRENCY`] at a time;
/// `None` for a file that cannot be read.
async fn read_texts(
    server: &Arc<Server>,
    files: Vec<(String, String, String)>,
) -> Vec<(String, String, Option<String>)> {
    let reads = files.into_iter().map(|(rel, path, doc_id)| {
        let server = Arc::clone(server);
        async move {
            let text = super::grep::read_doc_content(&server, &doc_id, &path).await;
            (rel, path, text)
        }
    });
    futures::stream::iter(reads)
        .buffer_unordered(READ_CONCURRENCY)
        .collect()
        .await
}

async fn post_check(
    platform: &Platform,
    body: Value,
    timeout: Duration,
) -> Result<Value, CheckError> {
    let (status, retry_after, text) = post_json(platform, CHECK_PATH, body, timeout).await?;
    // The platform's own words: FastAPI answers an error as `{"detail": ...}`.
    // A proxy in front of it may answer with an HTML page instead.
    let detail = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v["detail"].as_str().map(str::to_string));
    match status {
        200 => serde_json::from_str(&text)
            .map_err(|e| CheckError::Failed(format!("the platform's answer is not JSON ({})", e))),
        404 => Err(CheckError::Unsupported),
        401 => Err(CheckError::Failed(
            "the platform refused the relay's validation key (401)".to_string(),
        )),
        429 => Err(CheckError::Busy(
            "the platform's check queue is full (429)".to_string(),
            retry_after,
        )),
        503 => Err(CheckError::Busy(
            match detail {
                Some(detail) => format!("the platform is not ready (503: {})", detail),
                None => "the platform is not ready (503)".to_string(),
            },
            retry_after,
        )),
        504 => Err(CheckError::Busy(
            "no answer from the platform (504)".to_string(),
            retry_after,
        )),
        _ => Err(CheckError::Failed(format!(
            "the platform answered {}: {}",
            status,
            detail.unwrap_or_else(|| text.chars().take(300).collect())
        ))),
    }
}

/// POST `body` as gzipped JSON; returns (status, Retry-After seconds, body).
/// A request the relay cannot build fails; one the platform does not answer
/// is `Busy`. Serializing and compressing run on the blocking pool: the
/// fallback body is tens of megabytes, and prod is a 2-vCPU box where
/// blocking an async worker starves the relay's runtime (see AGENTS.md).
async fn post_json(
    platform: &Platform,
    path: &str,
    body: Value,
    timeout: Duration,
) -> Result<(u16, Option<u64>, String), CheckError> {
    let gzipped = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let raw = serde_json::to_vec(&body)
            .map_err(|e| format!("could not serialize the validation request: {}", e))?;
        if raw.len() > MAX_PAYLOAD_BYTES {
            return Err(format!(
                "the content is too large to validate ({} MB of JSON, max {} MB)",
                raw.len() / (1024 * 1024),
                MAX_PAYLOAD_BYTES / (1024 * 1024)
            ));
        }
        tracing::debug!("validate_content: payload {} bytes", raw.len());
        Ok(gzip(&raw))
    })
    .await
    .map_err(|e| format!("encoding the validation request failed: {}", e))
    .and_then(|encoded| encoded)
    .map_err(CheckError::Failed)?;

    let url = platform.endpoint(path);
    let resp = client()
        .post(&url)
        .timeout(timeout)
        .header("X-Validation-Key", &platform.secret)
        .header("Content-Type", "application/json")
        .header("Content-Encoding", "gzip")
        .body(gzipped)
        .send()
        .await
        .map_err(|e| {
            let reason = format!("could not reach the validation service at {}: {}", url, e);
            CheckError::Busy(reason, None)
        })?;
    let status = resp.status().as_u16();
    let retry_after = resp
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse().ok());
    let text = resp.text().await.map_err(|e| {
        let reason = format!("failed to read the validation service's answer: {}", e);
        CheckError::Busy(reason, None)
    })?;
    Ok((status, retry_after, text))
}

fn gzip(raw: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut encoder = flate2::write::GzEncoder::new(
        Vec::with_capacity(raw.len() / 4),
        flate2::Compression::fast(),
    );
    encoder
        .write_all(raw)
        .expect("writing into a Vec cannot fail");
    encoder.finish().expect("writing into a Vec cannot fail")
}

/// The older whole-folder validation (`validate-adhoc`), for a platform that
/// has no `/api/content/check` yet. Remove it once every platform has one.
async fn validate_adhoc(
    server: &Arc<Server>,
    platform: &Platform,
    view: View,
    course: Option<&str>,
    category: Option<&str>,
) -> Result<String, String> {
    let files = tokio::time::timeout(MAP_BUILD_TIMEOUT, build_file_map(server, view))
        .await
        .map_err(|_| {
            format!(
                "Error: timed out collecting documents from '{}' after {}s — try again (docs may still be loading from storage)",
                CONTENT_FOLDER,
                MAP_BUILD_TIMEOUT.as_secs()
            )
        })?;
    if files.is_empty() {
        return Err(format!(
            "Error: no readable documents found in folder '{}'",
            CONTENT_FOLDER
        ));
    }
    // Cheap pre-check on unescaped bytes, so nothing absurd is serialized;
    // the real gate is on the serialized JSON in post_json.
    let payload_bytes: usize = files
        .iter()
        .map(|(k, v)| k.len() + v.as_str().map(str::len).unwrap_or(0))
        .sum();
    if payload_bytes > MAX_PAYLOAD_BYTES {
        return Err(format!(
            "Error: folder content too large to validate ({} MB, max {} MB)",
            payload_bytes / (1024 * 1024),
            MAX_PAYLOAD_BYTES / (1024 * 1024)
        ));
    }

    let body = json!({ "files": files, "course": course, "category": category });
    let (status, _, text) = post_json(platform, ADHOC_PATH, body, REQUEST_TIMEOUT)
        .await
        .map_err(|e| format!("Error: {}", e.reason()))?;
    if (200..300).contains(&status) {
        Ok(format!(
            "The platform has no single-file check yet, so this is its older whole-folder validation of the {} (any file_path is ignored):\n{}",
            view.describe(),
            text
        ))
    } else {
        Err(format!(
            "Error: validation service returned {}: {}",
            status, text
        ))
    }
}

/// `{folder-relative path: content}` for every readable text document in the
/// folder, for the validate-adhoc fallback. Markdown gets the chosen
/// CriticMarkup view; `.json` blobs and `.html` widgets go through raw.
async fn build_file_map(server: &Arc<Server>, view: View) -> serde_json::Map<String, Value> {
    let prefix = format!("{}/", CONTENT_FOLDER);
    let mut files = serde_json::Map::new();

    for path in server.doc_resolver().all_paths() {
        let Some(rel) = path.strip_prefix(&prefix) else {
            continue;
        };
        if !is_content_candidate(rel) {
            continue;
        }
        let Some(doc_info) = server.doc_resolver().resolve_path(&path) else {
            continue;
        };
        let Some(raw) = super::grep::read_doc_content(server, &doc_info.doc_id, &path).await else {
            tracing::warn!("validate_content: skipping unreadable {}", path);
            continue;
        };
        let content = if rel.ends_with(".md") {
            let spans = critic_markup::parse(&raw);
            match view {
                View::Drafts => critic_markup::accepted_view(&spans),
                View::Approved => critic_markup::base_view(&spans),
            }
        } else {
            raw
        };
        files.insert(rel.to_string(), Value::String(content));
    }

    files
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .expect("static reqwest client")
    })
}

// ---------------------------------------------------------------------------
// Replies. The platform's ContentError is
// `{file, line?, severity, category, code?, message, suggestion?}`.

fn list(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn is_error(issue: &Value) -> bool {
    issue.get("severity").and_then(|v| v.as_str()) == Some("error")
}

/// One issue on one line: `error (wip) Lenses/X.md:14: message [code] Fix: …`.
fn issue_line(issue: &Value) -> String {
    let field = |name: &str| issue.get(name).and_then(|v| v.as_str());
    let one_line = |text: &str| text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut line = format!("- {}", field("severity").unwrap_or("issue"));
    if field("category") == Some("wip") {
        line.push_str(" (wip)");
    }
    line.push(' ');
    line.push_str(field("file").unwrap_or("?"));
    if let Some(n) = issue.get("line").and_then(|v| v.as_u64()) {
        line.push_str(&format!(":{}", n));
    }
    line.push_str(&format!(": {}", one_line(field("message").unwrap_or(""))));
    if let Some(code) = field("code") {
        line.push_str(&format!(" [{}]", code));
    }
    if let Some(fix) = field("suggestion") {
        line.push_str(&format!(" Fix: {}", one_line(fix)));
    }
    line
}

fn plural(n: usize, word: &str) -> String {
    format!("{} {}{}", n, word, if n == 1 { "" } else { "s" })
}

/// (errors, other issues) in a list.
fn counted(issues: &[Value]) -> (usize, usize) {
    let errors = issues.iter().filter(|i| is_error(i)).count();
    (errors, issues.len() - errors)
}

/// (errors, warnings) of all the issues a list was cut from: the platform's
/// `summary` (`{category: {errors, warnings}}`) counts them past the list's
/// cap too. Never fewer than the list holds.
fn totals(answer: &Value, listed: &[Value]) -> (usize, usize) {
    let (mut errors, mut warnings) = (0, 0);
    for counts in answer["summary"]
        .as_object()
        .into_iter()
        .flat_map(|s| s.values())
    {
        errors += counts["errors"].as_u64().unwrap_or(0) as usize;
        warnings += counts["warnings"].as_u64().unwrap_or(0) as usize;
    }
    let (listed_errors, listed_others) = counted(listed);
    (errors.max(listed_errors), warnings.max(listed_others))
}

/// "no issues", "1 error", "2 errors, 1 warning".
fn count_words((errors, warnings): (usize, usize)) -> String {
    match (errors, warnings) {
        (0, 0) => "no issues".to_string(),
        (e, 0) => plural(e, "error"),
        (0, w) => plural(w, "warning"),
        (e, w) => format!("{}, {}", plural(e, "error"), plural(w, "warning")),
    }
}

/// Up to `max` names, then "and N more".
fn name_list<'a>(names: impl Iterator<Item = &'a str>, max: usize) -> String {
    let names: Vec<&str> = names.collect();
    let mut shown = names[..names.len().min(max)].join(", ");
    if names.len() > max {
        shown.push_str(&format!(" and {} more", names.len() - max));
    }
    shown
}

fn short_commit(answer: &Value) -> String {
    answer
        .get("commit")
        .and_then(|v| v.as_str())
        .map(|sha| sha.chars().take(7).collect())
        .unwrap_or_else(|| "?".to_string())
}

fn page_names(answer: &Value) -> String {
    name_list(
        list(&answer["pages_changed"]).iter().filter_map(|page| {
            page.get("title")
                .or_else(|| page.get("id"))
                .and_then(|v| v.as_str())
        }),
        8,
    )
}

/// The tool's reply: what was checked against which commit, then the issues.
fn format_report(
    answer: &Value,
    unread: &[String],
    check: &Check<'_>,
    platform: &Platform,
) -> String {
    let subject = match check.target {
        Some(target) => format!("{}/{}", CONTENT_FOLDER, target),
        None => format!("the {} folder", CONTENT_FOLDER),
    };
    let commit_time = answer
        .get("commit_time")
        .and_then(|v| v.as_str())
        .map(|t| format!(" ({})", t))
        .unwrap_or_default();
    let mut out = vec![format!(
        "Checked {} against commit {}{} on {}, {}.",
        subject,
        short_commit(answer),
        commit_time,
        platform.host(),
        check.view.describe()
    )];

    let overlaid = list(&answer["overlaid"]);
    let deleted = list(&answer["deleted"]);
    if !overlaid.is_empty() || !deleted.is_empty() {
        let mut line = format!("Relay files newer than that commit: {}", overlaid.len());
        if !overlaid.is_empty() {
            line.push_str(&format!(
                " ({})",
                name_list(overlaid.iter().filter_map(|v| v.as_str()), 5)
            ));
        }
        if !deleted.is_empty() {
            line.push_str(&format!(
                "; deleted in the relay: {} ({})",
                deleted.len(),
                name_list(deleted.iter().filter_map(|v| v.as_str()), 5)
            ));
        }
        line.push('.');
        out.push(line);
    }
    if !unread.is_empty() {
        out.push(format!(
            "Unreadable in the relay, so checked as committed: {} ({}).",
            unread.len(),
            name_list(unread.iter().map(String::as_str), 5)
        ));
    }

    let (own_label, issues) = match check.target {
        Some(_) if answer["target"]["content"] == json!(false) => {
            out.push(format!(
                "{} is not course content: the platform does not build it.",
                subject
            ));
            ("", &[][..])
        }
        Some(_) => ("This file", list(&answer["target"]["issues"])),
        None => ("Issues", list(&answer["issues"])),
    };
    if !own_label.is_empty() {
        let listed = if answer["truncated"] == json!(true) {
            format!(" (first {} listed)", issues.len())
        } else {
            String::new()
        };
        out.push(format!(
            "{}: {}{}.",
            own_label,
            count_words(totals(answer, issues)),
            listed
        ));
        out.extend(issues.iter().map(issue_line));
    }

    let (new_label, gone_label) = if check.target.is_some() {
        ("Caused in other files", "Fixed in other files")
    } else {
        (
            "New compared with the commit",
            "Gone compared with the commit",
        )
    };
    for (label, key) in [(new_label, "new_elsewhere"), (gone_label, "gone_elsewhere")] {
        let issues = list(&answer[key]);
        if !issues.is_empty() {
            out.push(format!("{}: {}.", label, count_words(counted(issues))));
            out.extend(issues.iter().map(issue_line));
        }
    }
    let pages = list(&answer["pages_changed"]);
    if !pages.is_empty() {
        out.push(format!(
            "Pages changed: {} ({}).",
            pages.len(),
            page_names(answer)
        ));
    }
    out.join("\n")
}

/// The `edit` reply's check: one summary line, then the most important
/// issues (errors before warnings, this file before others), in at most
/// [`EDIT_CHECK_MAX_LINES`] lines.
fn format_brief(answer: &Value, unread: &[String], view: View) -> String {
    let target = &answer["target"];
    if target["content"] == json!(false) {
        return "Check: this file is not course content, so the platform does not check it."
            .to_string();
    }
    let own = list(&target["issues"]);
    let new = list(&answer["new_elsewhere"]);
    let gone = list(&answer["gone_elsewhere"]);
    let pages = list(&answer["pages_changed"]);
    let (own_errors, own_warnings) = totals(answer, own);
    // The platform gives no totals for the other lists, which `brief` caps.
    let capped = |issues: &[Value]| {
        let words = count_words(counted(issues));
        if issues.len() >= BRIEF_LIST_CAP {
            format!("{} or more", words)
        } else {
            words
        }
    };

    let mut parts = vec![format!(
        "this file has {}",
        count_words((own_errors, own_warnings))
    )];
    if !new.is_empty() {
        parts.push(format!("{} new in other files", capped(new)));
    }
    if !gone.is_empty() {
        parts.push(format!("fixes {} in other files", capped(gone)));
    }
    if !pages.is_empty() {
        parts.push(format!(
            "changes {}: {}",
            plural(pages.len(), "page"),
            page_names(answer)
        ));
    }
    if !unread.is_empty() {
        parts.push(format!(
            "{} unreadable, checked as committed",
            plural(unread.len(), "file")
        ));
    }
    let overlaid = list(&answer["overlaid"]).len();
    let mut lines = vec![format!(
        "Check ({} view, commit {} + {}): {}.",
        view.as_str(),
        short_commit(answer),
        plural(overlaid, "relay file"),
        parts.join("; ")
    )];

    let ordered: Vec<&Value> = own
        .iter()
        .filter(|i| is_error(i))
        .chain(new.iter().filter(|i| is_error(i)))
        .chain(own.iter().filter(|i| !is_error(i)))
        .chain(new.iter().filter(|i| !is_error(i)))
        .collect();
    let room = EDIT_CHECK_MAX_LINES - 1;
    if ordered.len() <= room {
        lines.extend(ordered.iter().map(|i| issue_line(i)));
    } else {
        lines.extend(ordered[..room - 1].iter().map(|i| issue_line(i)));
        let more = own_errors + own_warnings + new.len() - (room - 1);
        lines.push(format!(
            "- … {}{} more: run validate_content with this file_path for the full list.",
            if new.len() >= BRIEF_LIST_CAP {
                "at least "
            } else {
                ""
            },
            more
        ));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tools::test_helpers::*;

    const EDU: &str = "Lens Edu";

    fn edu_access() -> McpAccess {
        McpAccess {
            writable: true,
            folder_uuid: Some(FOLDER0_UUID.to_string()),
            folder_name: Some(EDU.to_string()),
            raw_token: None,
            role: y_sweet_core::share_token::ShareRole::Admin,
        }
    }

    fn done(extra: Value) -> Value {
        let mut answer = json!({
            "status": "done",
            "commit": "4d37677ba0000000000000000000000000000000",
            "commit_time": "2026-10-05T14:02:11Z",
            "view": "approved",
            "overlaid": [], "deleted": [], "ignored_count": 0,
            "target": null,
            "new_elsewhere": [], "gone_elsewhere": [], "pages_changed": [],
            "summary": {}, "issues": [], "truncated": false, "counts": {},
            "courses": {}, "stale_url_count": 0, "memoised": false
        });
        for (k, v) in extra.as_object().unwrap() {
            answer[k] = v.clone();
        }
        answer
    }

    fn issue(file: &str, line: u64, severity: &str, message: &str) -> Value {
        json!({"file": file, "line": line, "severity": severity,
               "category": "production", "message": message})
    }

    // Prevents: the exchange sending folder-prefixed paths, cooked text, or
    // forgetting texts between rounds (the platform keeps no state), and the
    // reply losing the commit or any of the four lists agents act on.
    #[tokio::test]
    async fn file_check_exchanges_blob_ids_then_texts_and_reports_the_answer() {
        let target_text = "approved text {++pending suggestion++}";
        let server = build_test_server_in(
            EDU,
            &[
                (
                    "/Lenses/A.md",
                    "cccc0000-0000-0000-0000-000000000001",
                    target_text,
                ),
                (
                    "/modules/M.md",
                    "cccc0000-0000-0000-0000-000000000002",
                    "# M\n![[../Lenses/A]]",
                ),
            ],
        )
        .await;
        let mock = mock_platform(vec![
            MockReply::ok(
                json!({"status": "need_files", "commit": "4d37677ba", "need": ["modules/M.md"]}),
            ),
            MockReply::ok(done(json!({
                "overlaid": ["Lenses/A.md", "modules/M.md"],
                "target": {"path": "Lenses/A.md", "content": true,
                           "issues": [issue("Lenses/A.md", 3, "error", "Missing segment\nheader")],
                           "pages": [{"id": "lens:a", "title": "A"}]},
                "new_elsewhere": [issue("modules/M.md", 2, "warning", "Lens A has no title")],
                "gone_elsewhere": [issue("modules/N.md", 9, "error", "Lens not found")],
                "pages_changed": [{"id": "module:m", "title": "Module M"}],
            }))),
        ])
        .await;

        let reply = execute_with_platform(
            &server,
            &edu_access(),
            &json!({"file_path": "Lens Edu/Lenses/A.md"}),
            &mock.platform(),
        )
        .await
        .expect("check should succeed");

        let requests = mock.requests();
        assert_eq!(requests.len(), 2);
        let first = &requests[0];
        assert_eq!(first.path, CHECK_PATH);
        assert_eq!(first.key, "sek");
        assert_eq!(first.encoding, "gzip");
        assert_eq!(first.body["view"], "approved");
        assert_eq!(first.body["target"], "Lenses/A.md");
        assert_eq!(first.body["brief"], false);
        assert_eq!(first.body["course"], Value::Null);
        assert_eq!(
            first.body["blobs"],
            json!({
                "Lenses/A.md": blob::git_blob_id(target_text.as_bytes()),
                "modules/M.md": blob::git_blob_id(b"# M\n![[../Lenses/A]]"),
            })
        );
        // Raw text, CriticMarkup kept: the platform computes both views.
        assert_eq!(first.body["files"], json!({"Lenses/A.md": target_text}));
        assert_eq!(first.body["complete"], json!(server.search_is_ready()));
        // Round two repeats everything and adds the text asked for.
        let second = &requests[1];
        assert_eq!(second.body["blobs"], first.body["blobs"]);
        assert_eq!(
            second.body["files"],
            json!({"Lenses/A.md": target_text, "modules/M.md": "# M\n![[../Lenses/A]]"})
        );

        assert!(reply.starts_with("Checked Lens Edu/Lenses/A.md against commit 4d37677 (2026-10-05T14:02:11Z) on 127.0.0.1, approved view"), "{reply}");
        assert!(
            reply.contains("Relay files newer than that commit: 2 (Lenses/A.md, modules/M.md)."),
            "{reply}"
        );
        assert!(
            reply.contains("This file: 1 error.\n- error Lenses/A.md:3: Missing segment header"),
            "{reply}"
        );
        assert!(
            reply.contains(
                "Caused in other files: 1 warning.\n- warning modules/M.md:2: Lens A has no title"
            ),
            "{reply}"
        );
        assert!(
            reply
                .contains("Fixed in other files: 1 error.\n- error modules/N.md:9: Lens not found"),
            "{reply}"
        );
        assert!(reply.contains("Pages changed: 1 (Module M)."), "{reply}");
    }

    // Prevents: accept_drafts no longer reaching the platform as the drafts
    // view, and validate_all (no file_path) sending a target or texts.
    #[tokio::test]
    async fn whole_folder_check_sends_no_target_and_maps_accept_drafts() {
        let server = build_test_server_in(
            EDU,
            &[
                ("/Lenses/A.md", "cccc0000-0000-0000-0000-000000000003", "a"),
                (
                    "/widgets/rings.html",
                    "cccc0000-0000-0000-0000-000000000004",
                    "<p>w</p>",
                ),
                (
                    "/Team page.html",
                    "cccc0000-0000-0000-0000-000000000005",
                    "<p>t</p>",
                ),
                (
                    "/attachments/x.png",
                    "cccc0000-0000-0000-0000-000000000006",
                    "",
                ),
            ],
        )
        .await;
        // The platform's totals, from the frozen content: its list stops at
        // 1,000 of 1,116 issues (two here).
        let mock = mock_platform(vec![MockReply::ok(done(json!({
            "view": "drafts",
            "issues": [issue("Lenses/A.md", 1, "error", "Bad"), issue("Lenses/B.md", 2, "warning", "Meh")],
            "truncated": true,
            "summary": {"production": {"errors": 140, "warnings": 900},
                        "wip": {"errors": 7, "warnings": 69}},
        })))])
        .await;

        let reply = execute_with_platform(
            &server,
            &edu_access(),
            &json!({"accept_drafts": true, "course": "ai-risk", "category": "production"}),
            &mock.platform(),
        )
        .await
        .expect("check should succeed");

        let requests = mock.requests();
        assert_eq!(requests.len(), 1);
        let body = &requests[0].body;
        assert_eq!(body["view"], "drafts");
        assert_eq!(body["target"], Value::Null);
        assert_eq!(body["files"], json!({}));
        assert_eq!(body["course"], "ai-risk");
        assert_eq!(body["category"], "production");
        let blobs = body["blobs"].as_object().unwrap();
        let mut paths: Vec<&str> = blobs.keys().map(String::as_str).collect();
        paths.sort();
        // Other HTML pages and images are not content candidates.
        assert_eq!(paths, ["Lenses/A.md", "widgets/rings.html"]);

        assert!(
            reply.starts_with("Checked the Lens Edu folder against commit 4d37677"),
            "{reply}"
        );
        assert!(
            reply.contains("drafts view (pending suggestions accepted)"),
            "{reply}"
        );
        assert!(reply.contains("Issues: 147 errors, 969 warnings (first 2 listed).\n- error Lenses/A.md:1: Bad\n- warning Lenses/B.md:2: Meh"), "{reply}");
    }

    // Prevents: a JSON timestamps file getting a blob id that is not Git's
    // id of its bytes (it would travel as an overlay on every check).
    #[tokio::test]
    async fn json_files_get_the_blob_id_of_their_bytes() {
        let content = r#"{"0:01": "word"}"#;
        let server = build_blob_test_server_with_file(
            "/video_transcripts/v.timestamps.json",
            "cccc0000-0000-0000-0000-000000000007",
            content,
        )
        .await;
        rename_folder0(&server, EDU);
        let mock = mock_platform(vec![MockReply::ok(done(json!({})))]).await;

        execute_with_platform(&server, &edu_access(), &json!({}), &mock.platform())
            .await
            .expect("check should succeed");

        let body = &mock.requests()[0].body;
        assert_eq!(
            body["blobs"],
            json!({"video_transcripts/v.timestamps.json": blob::git_blob_id(content.as_bytes())})
        );
    }

    // Prevents: the platform reading every committed file the relay did not
    // list as deleted while the relay's index is still loading, or when a
    // file could not be read.
    #[tokio::test]
    async fn complete_only_when_the_index_is_built_and_every_file_was_read() {
        let server = build_test_server_in(
            EDU,
            &[("/Lenses/A.md", "cccc0000-0000-0000-0000-00000000000d", "a")],
        )
        .await;
        let mock = mock_platform(vec![MockReply::ok(done(json!({})))]).await;
        let (access, args, platform) = (edu_access(), json!({}), mock.platform());
        let run = || execute_with_platform(&server, &access, &args, &platform);

        run().await.unwrap();
        server.startup_reindex(&[]).await.unwrap(); // no store: marks the index built
        run().await.unwrap();
        let requests = mock.requests();
        assert_eq!(requests[0].body["complete"], false);
        assert_eq!(requests[1].body["complete"], true);

        // A JSON file with no stored blob cannot be read.
        let server = build_test_server_in(
            EDU,
            &[
                ("/Lenses/A.md", "cccc0000-0000-0000-0000-00000000000e", "a"),
                (
                    "/broken.timestamps.json",
                    "cccc0000-0000-0000-0000-00000000000f",
                    "",
                ),
            ],
        )
        .await;
        server.startup_reindex(&[]).await.unwrap();
        let mock = mock_platform(vec![MockReply::ok(done(json!({})))]).await;
        let reply = execute_with_platform(&server, &edu_access(), &json!({}), &mock.platform())
            .await
            .unwrap();
        let body = &mock.requests()[0].body;
        assert_eq!(body["complete"], false);
        assert!(body["blobs"].get("broken.timestamps.json").is_none());
        assert!(body["blobs"].get("Lenses/A.md").is_some());
        // The reply says so: live changes to that file were not checked.
        assert!(
            reply.contains(
                "Unreadable in the relay, so checked as committed: 1 (broken.timestamps.json)."
            ),
            "{reply}"
        );
    }

    // Prevents: a stale blob id (the platform would never see the change), and
    // a whole-folder check loading every evicted doc again when nothing changed.
    #[tokio::test]
    async fn blob_ids_are_cached_until_the_doc_changes() {
        use yrs::{Text, Transact, WriteTxn};
        // A server whose docs carry the real update callback (load_doc).
        let server = Arc::new(
            Server::new_without_workers(
                None,
                Duration::from_secs(60),
                None,
                None,
                Vec::new(),
                tokio_util::sync::CancellationToken::new(),
                false,
                None,
            )
            .await
            .unwrap(),
        );
        let uuid = "cccc0000-0000-0000-0000-000000000010";
        let folder_doc = create_folder_doc(&[("/Lenses/A.md", uuid)]);
        set_folder_name(&folder_doc, EDU);
        server
            .doc_resolver()
            .update_folder_from_doc(&folder0_id(), &folder_doc);
        let doc_id = format!("{}-{}", RELAY_ID, uuid);
        server.load_doc(&doc_id, None).await.unwrap();
        let write = |text: &str| {
            let awareness = server.docs().get(&doc_id).unwrap().awareness();
            let guard = awareness.write().unwrap();
            let mut txn = guard.doc.transact_mut();
            let contents = txn.get_or_insert_text("contents");
            let len = contents.len(&txn);
            contents.remove_range(&mut txn, 0, len);
            contents.insert(&mut txn, 0, text);
        };
        let cached = || server.text_blob_ids().get(&doc_id).map(|id| id.clone());
        let mock = mock_platform(vec![MockReply::ok(done(json!({})))]).await;
        let (access, args, platform) = (edu_access(), json!({}), mock.platform());
        let check = || execute_with_platform(&server, &access, &args, &platform);
        let sent = |n: usize| mock.requests()[n].body["blobs"]["Lenses/A.md"].clone();

        write("one");
        check().await.unwrap();
        assert_eq!(cached(), Some(blob::git_blob_id(b"one")));
        assert_eq!(sent(0), json!(blob::git_blob_id(b"one")));

        // A cached id is used as it is: the doc is not read.
        server
            .text_blob_ids()
            .insert(doc_id.clone(), "f".repeat(40));
        check().await.unwrap();
        assert_eq!(sent(1), json!("f".repeat(40)));

        // Every update clears the entry, and the next check reads the text.
        write("two");
        assert_eq!(cached(), None);
        check().await.unwrap();
        assert_eq!(sent(2), json!(blob::git_blob_id(b"two")));
        assert_eq!(cached(), Some(blob::git_blob_id(b"two")));
    }

    // Prevents: the first whole-folder check after a restart reloading every
    // doc from storage, although startup read them all.
    #[tokio::test]
    async fn the_startup_scan_records_each_texts_blob_id() {
        let server = build_test_server_in(
            EDU,
            &[
                (
                    "/Lenses/A.md",
                    "cccc0000-0000-0000-0000-000000000011",
                    "alpha",
                ),
                (
                    "/modules/M.md",
                    "cccc0000-0000-0000-0000-000000000012",
                    "beta",
                ),
            ],
        )
        .await;
        server.rebuild_suggestions_index();
        for (uuid, text) in [
            ("cccc0000-0000-0000-0000-000000000011", "alpha"),
            ("cccc0000-0000-0000-0000-000000000012", "beta"),
        ] {
            let id = server
                .text_blob_ids()
                .get(&format!("{}-{}", RELAY_ID, uuid))
                .map(|id| id.clone());
            assert_eq!(id, Some(blob::git_blob_id(text.as_bytes())));
        }
    }

    // Prevents: an endless exchange when the platform keeps asking (its
    // commit moving every round), or when it asks for a file already sent.
    #[tokio::test]
    async fn stops_after_three_rounds_and_on_requests_it_cannot_serve() {
        let server = build_test_server_in(
            EDU,
            &[
                ("/Lenses/A.md", "cccc0000-0000-0000-0000-000000000008", "a"),
                ("/Lenses/B.md", "cccc0000-0000-0000-0000-000000000009", "b"),
                ("/Lenses/C.md", "cccc0000-0000-0000-0000-00000000000a", "c"),
            ],
        )
        .await;
        let mock = mock_platform(vec![
            MockReply::ok(json!({"status": "need_files", "commit": "1", "need": ["Lenses/A.md"]})),
            MockReply::ok(json!({"status": "need_files", "commit": "2", "need": ["Lenses/B.md"]})),
            MockReply::ok(json!({"status": "need_files", "commit": "3", "need": ["Lenses/C.md"]})),
        ])
        .await;
        let err = execute_with_platform(&server, &edu_access(), &json!({}), &mock.platform())
            .await
            .expect_err("must stop");
        assert_eq!(mock.requests().len(), MAX_ROUNDS);
        assert!(err.contains("after 3 rounds"), "{err}");

        let mock = mock_platform(vec![MockReply::ok(
            json!({"status": "need_files", "commit": "1", "need": ["Lenses/A.md", "Lenses/Nope.md"]}),
        )])
        .await;
        let err = execute_with_platform(
            &server,
            &edu_access(),
            &json!({"file_path": "Lens Edu/Lenses/A.md"}),
            &mock.platform(),
        )
        .await
        .expect_err("must stop");
        assert_eq!(mock.requests().len(), 1);
        assert!(err.contains("cannot send"), "{err}");
    }

    // Prevents: the tool breaking for agents while the platform still runs a
    // deploy without /check: a 404 falls back to the whole-folder call, with
    // the CriticMarkup view applied as before.
    #[tokio::test]
    async fn falls_back_to_validate_adhoc_when_check_is_missing() {
        let server = build_test_server_in(
            EDU,
            &[(
                "/Lenses/A.md",
                "cccc0000-0000-0000-0000-00000000000b",
                "approved {++pending++}",
            )],
        )
        .await;
        let mock = mock_platform(vec![MockReply::status(404)]).await;

        let reply = execute_with_platform(
            &server,
            &edu_access(),
            &json!({"file_path": "Lens Edu/Lenses/A.md", "accept_drafts": true}),
            &mock.platform(),
        )
        .await
        .expect("fallback should succeed");

        let requests = mock.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[1].path, ADHOC_PATH);
        assert_eq!(requests[1].encoding, "gzip");
        assert_eq!(requests[1].body["files"]["Lenses/A.md"], "approved pending");
        assert!(reply.contains("older whole-folder validation"), "{reply}");
        assert!(reply.contains("\"issues\""), "{reply}");
    }

    // Prevents: a Lens token (or a Lens path) being checked against the
    // course repository, and a bogus category silently validating everything.
    #[tokio::test]
    async fn refuses_other_folders_and_bad_categories() {
        let server = build_test_server_in(EDU, &[]).await;
        let platform = Platform {
            url: "http://127.0.0.1:1".to_string(),
            secret: "sek".to_string(),
        };
        let lens = McpAccess {
            folder_name: Some("Lens".to_string()),
            ..edu_access()
        };
        let err = execute_with_platform(&server, &lens, &json!({}), &platform)
            .await
            .expect_err("must refuse");
        assert!(
            err.contains("'Lens Edu'") && err.contains("'Lens'"),
            "{err}"
        );

        let all = McpAccess {
            folder_name: None,
            folder_uuid: None,
            ..edu_access()
        };
        let err =
            execute_with_platform(&server, &all, &json!({"file_path": "Lens/x.md"}), &platform)
                .await
                .expect_err("must refuse");
        assert!(err.contains("'Lens/x.md' is not one"), "{err}");

        let err = execute_with_platform(&server, &all, &json!({"category": "bogus"}), &platform)
            .await
            .expect_err("must refuse");
        assert!(err.contains("category"), "{err}");
    }

    // Prevents: a busy platform reading as a broken tool, and a missing file
    // reaching the platform at all.
    #[tokio::test]
    async fn reports_busy_platform_and_missing_files() {
        let server = build_test_server_in(
            EDU,
            &[("/Lenses/A.md", "cccc0000-0000-0000-0000-00000000000c", "a")],
        )
        .await;
        let mock = mock_platform(vec![MockReply::status(429).retry_after(30)]).await;
        let err = execute_with_platform(&server, &edu_access(), &json!({}), &mock.platform())
            .await
            .expect_err("busy");
        assert!(err.contains("queue is full (429); retry in 30 s"), "{err}");

        let err = execute_with_platform(
            &server,
            &edu_access(),
            &json!({"file_path": "Lens Edu/Lenses/Missing.md"}),
            &mock.platform(),
        )
        .await
        .expect_err("missing");
        assert!(err.contains("no file Lens Edu/Lenses/Missing.md"), "{err}");
        assert_eq!(
            mock.requests().len(),
            1,
            "the missing file never reaches the platform"
        );
    }

    // Prevents: an edit reply that grows without bound or hides errors
    // behind warnings.
    #[test]
    fn brief_reply_puts_errors_first_and_fits_six_lines() {
        let answer = done(json!({
            "overlaid": ["Lenses/A.md"],
            "target": {"path": "Lenses/A.md", "content": true, "issues": [
                issue("Lenses/A.md", 1, "warning", "w1"),
                issue("Lenses/A.md", 2, "error", "e1"),
                issue("Lenses/A.md", 3, "warning", "w2"),
            ]},
            "new_elsewhere": [
                issue("modules/M.md", 4, "error", "e2"),
                issue("modules/M.md", 5, "warning", "w3"),
                issue("modules/M.md", 6, "warning", "w4"),
            ],
            "pages_changed": [{"id": "module:m", "title": "Module M"}],
        }));
        let brief = format_brief(&answer, &[], View::Approved);
        let lines: Vec<&str> = brief.lines().collect();
        assert_eq!(lines.len(), EDIT_CHECK_MAX_LINES, "{brief}");
        assert_eq!(
            lines[0],
            "Check (approved view, commit 4d37677 + 1 relay file): this file has 1 error, 2 warnings; 1 error, 2 warnings new in other files; changes 1 page: Module M."
        );
        assert_eq!(lines[1], "- error Lenses/A.md:2: e1");
        assert_eq!(lines[2], "- error modules/M.md:4: e2");
        assert_eq!(lines[3], "- warning Lenses/A.md:1: w1");
        assert_eq!(lines[4], "- warning Lenses/A.md:3: w2");
        assert_eq!(
            lines[5],
            "- … 2 more: run validate_content with this file_path for the full list."
        );

        let clean = format_brief(
            &done(json!({"target": {"path": "Lenses/A.md", "content": true, "issues": []}})),
            &["v.timestamps.json".to_string()],
            View::Drafts,
        );
        assert_eq!(
            clean,
            "Check (drafts view, commit 4d37677 + 0 relay files): this file has no issues; 1 file unreadable, checked as committed."
        );
    }

    // Prevents: the brief reply counting only the ten issues `brief` lists
    // (articles/dean-ai-2040-verification-plan.md has 13 errors, 7 warnings).
    #[test]
    fn brief_reply_counts_the_platforms_totals() {
        let ten: Vec<Value> = (1..=10)
            .map(|n| issue("Lenses/A.md", n, "error", "e"))
            .collect();
        let answer = done(json!({
            "target": {"path": "Lenses/A.md", "content": true, "issues": ten},
            "summary": {"production": {"errors": 13, "warnings": 7}},
            "truncated": true,
        }));
        let brief = format_brief(&answer, &[], View::Approved);
        let lines: Vec<&str> = brief.lines().collect();
        assert!(
            lines[0].ends_with(": this file has 13 errors, 7 warnings."),
            "{brief}"
        );
        assert_eq!(
            lines[5],
            "- … 16 more: run validate_content with this file_path for the full list."
        );
    }

    // Prevents: an edit outside the course folder, or of a file the platform
    // does not read as Markdown, paying for a check.
    #[tokio::test]
    async fn edit_check_covers_only_course_markdown() {
        let server = build_test_server_in(EDU, &[]).await;
        let platform = Platform {
            url: "http://127.0.0.1:1".to_string(),
            secret: "sek".to_string(),
        };
        for path in [
            "Lens/Lenses/A.md",
            "Lens Edu/widgets/w.html",
            "Lens Edu/v.json",
            "Lens Edufoo/A.md",
        ] {
            let line = edit_check(
                &server,
                path,
                View::Approved,
                Some(&platform),
                EDIT_CHECK_BUDGET,
            )
            .await;
            assert_eq!(line, None, "{path}");
        }
        let line = edit_check(
            &server,
            "Lens Edu/Lenses/A.md",
            View::Approved,
            None,
            EDIT_CHECK_BUDGET,
        )
        .await;
        assert_eq!(
            line.as_deref(),
            Some("Not checked: this relay has no ADHOC_VALIDATION_SECRET.")
        );
    }

    // Prevents: a hung or overloaded platform adding its whole budget to
    // every edit for the length of an incident. After a timeout or a 429
    // (Retry-After honoured), edit checks leave the platform alone until a
    // stated time; a refused key is not "busy" and is asked again.
    #[tokio::test]
    async fn edit_checks_back_off_from_a_busy_platform() {
        let server = build_test_server_in(
            EDU,
            &[("/Lenses/A.md", "cccc0000-0000-0000-0000-000000000013", "a")],
        )
        .await;
        let slow = MockReply::ok(done(json!({}))).delay(Duration::from_secs(5));
        for (reply, first, backs_off) in [
            (slow, "Check skipped: no answer within 1 s.", true),
            (
                MockReply::status(429).retry_after(30),
                "Check skipped: the platform's check queue is full (429); retry in 30 s.",
                true,
            ),
            // In the platform's words, not a guess at the cause.
            (
                MockReply::status(503),
                "Check skipped: the platform is not ready (503: mock).",
                true,
            ),
            (
                MockReply::status(401),
                "Check skipped: the platform refused the relay's validation key (401).",
                false,
            ),
        ] {
            let mock = mock_platform(vec![reply]).await;
            let platform = mock.platform();
            let check = || {
                edit_check(
                    &server,
                    "Lens Edu/Lenses/A.md",
                    View::Approved,
                    Some(&platform),
                    Duration::from_millis(300),
                )
            };

            let line = check().await.unwrap();
            assert!(line.starts_with(first), "{line}");
            let line = check().await.unwrap();
            if !backs_off {
                assert!(line.starts_with(first), "{line}");
                assert_eq!(mock.requests().len(), 2);
                // Kept so that the log names it once, not on every edit.
                assert_eq!(
                    with_health(&platform, |h| h.failure.clone()).as_deref(),
                    Some("the platform refused the relay's validation key (401)")
                );
                continue;
            }
            let until = line
                .strip_prefix("Check skipped: the platform is busy (retrying after ")
                .unwrap_or_else(|| panic!("{line}"));
            // "14:02:41 UTC). The edit stands; ..."
            let (clock, rest) = until.split_at(8);
            let parts: Vec<&str> = clock.split(':').collect();
            assert!(
                parts.len() == 3
                    && parts
                        .iter()
                        .all(|p| p.len() == 2 && p.bytes().all(|b| b.is_ascii_digit()))
                    && rest.starts_with(" UTC). The edit stands"),
                "{line}"
            );
            assert_eq!(mock.requests().len(), 1, "the second edit does not ask");

            // Once that time has passed, the next edit asks again.
            with_health(&platform, |h| h.busy_until = Some(Instant::now()));
            check().await.unwrap();
            assert_eq!(mock.requests().len(), 2);
        }
    }
}
