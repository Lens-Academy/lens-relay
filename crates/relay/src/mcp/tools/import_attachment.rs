//! MCP `import_attachment`: host an image under `<folder>/attachments/`.
//!
//! The relay validates the arguments and the folder scope, then proxies to
//! lens-editor's `POST /api/attachments/import` with the caller's own share
//! token (same trust model as `import_source`: the editor enforces role and
//! folder, the relay adds no new trust). The editor fetches or decodes the
//! bytes, sniffs the type, applies the allowlist and size caps, dedups by
//! sha256 and uploads through the relay's server-token attachment API. This
//! side adds the public URL (per-folder config, `ATTACHMENT_PUBLIC_URLS`),
//! writes a tracing record and a Recent-changes event, and shapes the reply.

use super::import_source::{editor_url_from_env, request_token};
use crate::server::Server;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use y_sweet_core::activity::ActivityEvent;
use y_sweet_core::share_token::McpAccess;

/// Hard per-file cap; the editor route enforces the same number on the
/// decoded bytes. Base64 inflates by 4/3, so the JSON-RPC body limit on
/// `/mcp` is 30 MiB (see `server.rs`).
pub const MAX_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;
/// Above this the tool still uploads but warns in `note`.
pub const SOFT_ATTACHMENT_BYTES: usize = 5 * 1024 * 1024;
/// Extensions accepted in `file_path` (must match the sniffed type).
pub const ALLOWED_EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];
const MAX_STEM_LEN: usize = 80;
/// Fetch (≤30 s) + upload (≤60 s) on the editor side, with headroom.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(150);
/// Environment variable holding `Folder=https://base;Other=https://base2`.
pub const PUBLIC_URLS_ENV: &str = "ATTACHMENT_PUBLIC_URLS";
/// Mapping used when the variable is unset: the importer has always written
/// staging raw URLs for `Lens Edu`, and this keeps that behaviour.
const DEFAULT_PUBLIC_URLS: &str =
    "Lens Edu=https://raw.githubusercontent.com/Lens-Academy/lens-edu-staging/staging";

/// Validated arguments, ready to forward to the editor.
#[derive(Debug, Clone, PartialEq)]
pub struct AttachmentRequest {
    /// Top-level relay folder name, e.g. `Lens Edu`.
    pub folder: String,
    pub url: Option<String>,
    pub content_base64: Option<String>,
    /// In-folder destination (`/attachments/<name>.<ext>`), when given.
    pub file_path: Option<String>,
    pub stem: Option<String>,
    pub mimetype: Option<String>,
    pub overwrite: bool,
}

/// Parse and validate the tool arguments. `default_folder` is the session's
/// scoped folder, used when `file_path` is absent so that a URL-only call
/// still lands in (and is checked against) the caller's folder.
pub fn parse_args(
    arguments: &Value,
    default_folder: Option<&str>,
) -> Result<AttachmentRequest, String> {
    let str_arg = |key: &str| -> Result<Option<String>, String> {
        match arguments.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) if s.trim().is_empty() => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.clone())),
            Some(_) => Err(format!("{} must be a string", key)),
        }
    };
    let url = str_arg("url")?.map(|u| u.trim().to_string());
    let content_base64 = str_arg("content_base64")?;
    let file_path = str_arg("file_path")?;
    let stem = str_arg("stem")?;
    let mimetype = str_arg("mimetype")?;
    let overwrite = match arguments.get("overwrite") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err("overwrite must be a boolean".to_string()),
    };

    match (&url, &content_base64) {
        (None, None) => {
            return Err("Provide exactly one of url or content_base64".to_string());
        }
        (Some(_), Some(_)) => {
            return Err("Provide only one of url or content_base64, not both".to_string());
        }
        _ => {}
    }
    if let Some(u) = &url {
        let parsed = url::Url::parse(u).map_err(|e| format!("url is not valid: {}", e))?;
        if parsed.scheme() != "http" && parsed.scheme() != "https" {
            return Err("url must use http or https".to_string());
        }
    }
    if let Some(b64) = &content_base64 {
        // 4 base64 chars per 3 bytes, plus padding/newlines slack.
        let max_chars = MAX_ATTACHMENT_BYTES / 3 * 4 + 4 + MAX_ATTACHMENT_BYTES / 64;
        if b64.len() > max_chars {
            return Err(format!(
                "content_base64 is larger than the {} MiB hard limit; downscale the image",
                MAX_ATTACHMENT_BYTES / (1024 * 1024)
            ));
        }
    }
    if file_path.is_some() && stem.is_some() {
        return Err("Provide either file_path or stem, not both".to_string());
    }

    let (folder, in_folder_path) = match &file_path {
        Some(fp) => {
            let (folder, rest) = split_attachment_path(fp)?;
            (folder, Some(rest))
        }
        None => (
            default_folder.map(str::to_string).ok_or_else(|| {
                "file_path is required when the credential is not scoped to a single folder"
                    .to_string()
            })?,
            None,
        ),
    };
    if let Some(stem) = &stem {
        validate_stem(stem)?;
    }
    if content_base64.is_some() && in_folder_path.is_none() && stem.is_none() {
        return Err("stem or file_path is required with content_base64".to_string());
    }

    Ok(AttachmentRequest {
        folder,
        url,
        content_base64,
        file_path: in_folder_path,
        stem,
        mimetype,
        overwrite,
    })
}

/// `<folder>/attachments/<name>.<ext>` → (`folder`, `/attachments/<name>.<ext>`).
fn split_attachment_path(file_path: &str) -> Result<(String, String), String> {
    let (folder, rest) = file_path.split_once('/').ok_or_else(|| {
        "file_path must look like '<folder>/attachments/<name>.<ext>'".to_string()
    })?;
    if folder.trim().is_empty() {
        return Err("file_path must start with a folder name".to_string());
    }
    let name = rest.strip_prefix("attachments/").ok_or_else(|| {
        format!(
            "file_path must be under '{}/attachments/' (got '{}')",
            folder, file_path
        )
    })?;
    if name.is_empty() || name.contains('/') || name.contains('"') || name.starts_with('.') {
        return Err(
            "file_path must name one file directly under attachments/ (no subfolders, quotes, or leading dots)"
                .to_string(),
        );
    }
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .filter(|e| !e.is_empty())
        .ok_or_else(|| "file_path needs an image extension".to_string())?;
    if !ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(
            "file_path extension '.{}' is not allowed; use one of: {}",
            ext,
            ALLOWED_EXTENSIONS.join(", ")
        ));
    }
    Ok((folder.to_string(), format!("/{}", rest)))
}

fn validate_stem(stem: &str) -> Result<(), String> {
    let ok = !stem.is_empty()
        && stem.len() <= MAX_STEM_LEN
        && !stem.starts_with('-')
        && !stem.ends_with('-')
        && !stem.contains("--")
        && stem
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if ok {
        Ok(())
    } else {
        Err(format!(
            "stem must be kebab-case ([a-z0-9] and single dashes, at most {} chars), got '{}'",
            MAX_STEM_LEN, stem
        ))
    }
}

/// Parse `Folder=https://base;Other=https://base2` into pairs.
pub fn parse_public_url_map(raw: &str) -> Vec<(String, String)> {
    raw.split(';')
        .filter_map(|entry| {
            let (folder, base) = entry.split_once('=')?;
            let folder = folder.trim();
            let base = base.trim().trim_end_matches('/');
            if folder.is_empty() || base.is_empty() {
                return None;
            }
            Some((folder.to_string(), base.to_string()))
        })
        .collect()
}

/// Public raw base URL for `folder` from [`PUBLIC_URLS_ENV`] (falling back
/// to the built-in `Lens Edu` mapping), or `None` when the folder is not
/// published anywhere.
pub fn public_base_url_for_folder(folder: &str) -> Option<String> {
    let raw = std::env::var(PUBLIC_URLS_ENV)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_PUBLIC_URLS.to_string());
    public_base_url_from(&raw, folder)
}

fn public_base_url_from(raw: &str, folder: &str) -> Option<String> {
    parse_public_url_map(raw)
        .into_iter()
        .find(|(f, _)| f == folder)
        .map(|(_, base)| base)
}

/// Public URL for an in-folder path (`/attachments/x.png`), percent-encoding
/// the path segments the way a browser would.
pub fn public_url(base: &str, in_folder_path: &str) -> String {
    let encoded: Vec<String> = in_folder_path
        .trim_start_matches('/')
        .split('/')
        .map(|seg| {
            url::form_urlencoded::byte_serialize(seg.as_bytes())
                .collect::<String>()
                .replace('+', "%20")
        })
        .collect();
    format!("{}/{}", base.trim_end_matches('/'), encoded.join("/"))
}

/// Execute the `import_attachment` tool.
pub async fn execute(
    server: &Arc<Server>,
    session_id: &str,
    access: &McpAccess,
    arguments: &Value,
) -> Result<String, String> {
    execute_with_editor_url(
        server,
        session_id,
        access,
        arguments,
        &editor_url_from_env(),
    )
    .await
}

pub async fn execute_with_editor_url(
    server: &Arc<Server>,
    session_id: &str,
    access: &McpAccess,
    arguments: &Value,
    editor_url: &str,
) -> Result<String, String> {
    let req = parse_args(arguments, access.folder_name.as_deref())?;
    // `dispatch_tool` already checks `file_path`; this also covers the
    // defaulted folder and keeps the rule local to the tool.
    if let Some(allowed) = access.folder_name.as_deref() {
        if req.folder != allowed {
            return Err(format!(
                "Access denied: this key only has access to '{}'. Requested folder: '{}'",
                allowed, req.folder
            ));
        }
    }
    let token = request_token(access)?;

    let (actor, author, client_id) = {
        let session = server
            .mcp_sessions
            .get_session(session_id)
            .ok_or_else(|| "Error: Session not found".to_string())?;
        (
            session.ai_actor.clone(),
            session.author_name.clone(),
            session.ai_client_id,
        )
    };

    let body = json!({
        "folder": req.folder,
        "url": req.url,
        "content_base64": req.content_base64,
        "file_path": req.file_path,
        "stem": req.stem,
        "mimetype": req.mimetype,
        "overwrite": req.overwrite,
    });
    let endpoint = format!(
        "{}/api/attachments/import",
        editor_url.trim_end_matches('/')
    );
    let resp = client()
        .post(&endpoint)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            format!(
                "Error: Could not reach the lens-editor attachment importer at {}: {}",
                endpoint, e
            )
        })?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("Error: Failed to read importer response: {}", e))?;
    if !status.is_success() {
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
            .unwrap_or(text);
        tracing::warn!(
            actor = %actor,
            folder = %req.folder,
            status = %status,
            "import_attachment rejected: {}",
            detail
        );
        return Err(format!(
            "Error: Attachment import failed ({}): {}",
            status, detail
        ));
    }
    let result: Value = serde_json::from_str(&text)
        .map_err(|e| format!("Error: Importer returned malformed JSON: {}", e))?;

    let in_folder_path = result
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Error: Importer response has no path".to_string())?
        .to_string();
    let full_path = format!("{}{}", req.folder, in_folder_path);
    let created = result["created"].as_bool().unwrap_or(false);
    let overwritten = result["overwritten"].as_bool().unwrap_or(false);
    let deduplicated_from = result
        .get("deduplicated_from")
        .and_then(|v| v.as_str())
        .map(|p| format!("{}{}", req.folder, p));
    let sha256 = result["sha256"].as_str().unwrap_or("").to_string();
    let bytes = result["bytes"].as_u64().unwrap_or(0);
    let mimetype = result["mimetype"].as_str().unwrap_or("").to_string();
    let uuid = result["uuid"].as_str().map(str::to_string);
    let warnings: Vec<String> = result["warnings"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|w| w.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    let public_url =
        public_base_url_for_folder(&req.folder).map(|base| public_url(&base, &in_folder_path));

    let mut note_parts: Vec<String> = Vec::new();
    if let Some(from) = &deduplicated_from {
        note_parts.push(format!(
            "Identical bytes are already hosted at '{}'; nothing was uploaded — embed that path.",
            from
        ));
    } else if overwritten {
        note_parts.push(
            "Replaced the bytes at an existing path; the public URL may keep serving the old image for up to 5 minutes (CDN cache)."
                .to_string(),
        );
    } else if created {
        note_parts.push(
            "public_url resolves once git-sync has committed the file (typically 10-30 s); do not poll it before embedding."
                .to_string(),
        );
    }
    if public_url.is_none() {
        note_parts.push(format!(
            "No public URL is configured for folder '{}' ({}); the file is stored but only the editor can render it.",
            req.folder, PUBLIC_URLS_ENV
        ));
    }
    // The editor owns the size checks (shared/attachment-limits.json) and
    // reports the soft-limit warning in `warnings`; it is forwarded, not
    // repeated here.
    note_parts.extend(warnings);

    tracing::info!(
        actor = %actor,
        folder = %req.folder,
        path = %full_path,
        sha256 = %sha256,
        bytes,
        created,
        overwritten,
        deduplicated_from = ?deduplicated_from,
        "import_attachment"
    );

    if created || overwritten {
        if let Some(uuid) = uuid.as_deref() {
            record_activity(
                server,
                uuid,
                &actor,
                &author,
                client_id,
                &full_path,
                public_url.as_deref(),
                overwritten,
            );
        }
    }

    let out = json!({
        "path": full_path,
        "public_url": public_url,
        "sha256": sha256,
        "bytes": bytes,
        "mimetype": mimetype,
        "created": created,
        "overwritten": overwritten,
        "deduplicated_from": deduplicated_from,
        "note": note_parts.join(" "),
    });
    serde_json::to_string_pretty(&out).map_err(|e| format!("Error: {}", e))
}

static ACTIVITY_SEQ: AtomicU32 = AtomicU32::new(1);

/// Put the upload on the editor's Recent changes page as an event under the
/// attachment's own uuid (the folder's `/recent-changes` lists every
/// filemeta id, attachments included).
///
/// TODO(attachments-activity): this is the in-memory index only. Attachments
/// have no Y.Doc, so there is no `activity_v0` map to persist the event in
/// and it is lost on relay restart; a folder-level activity log needs a
/// schema change in `y_sweet_core::activity` plus editor support.
#[allow(clippy::too_many_arguments)]
fn record_activity(
    server: &Arc<Server>,
    uuid: &str,
    actor: &str,
    author: &str,
    client_id: u64,
    full_path: &str,
    public_url: Option<&str>,
    overwritten: bool,
) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    // Counter mixed with sub-millisecond time so ids stay unique across
    // restarts (the counter alone restarts at 1).
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let seq = ACTIVITY_SEQ.fetch_add(1, Ordering::Relaxed) ^ nanos;
    let new = match public_url {
        Some(u) => format!("{} ({})", full_path, u),
        None => full_path.to_string(),
    };
    let event = ActivityEvent {
        id: ActivityEvent::event_id(ts, client_id, seq),
        ts,
        actor: actor.to_string(),
        author: author.to_string(),
        mode: "direct".to_string(),
        kind: if overwritten { "replace" } else { "insert" }.to_string(),
        old: if overwritten {
            "previous image bytes".to_string()
        } else {
            String::new()
        },
        new,
        old_truncated: false,
        new_truncated: false,
        ctx_before: String::new(),
        ctx_after: String::new(),
        pos: 0,
        client: client_id,
        clock_from: seq,
        clock_to: seq,
        anchor: None,
    };
    server.recent_changes_index().push(uuid, event, None);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tools::test_helpers::*;
    use axum::extract::Request;
    use axum::routing::post;
    use axum::Router;
    use serde_json::json;

    fn access(folder: Option<&str>, token: Option<&str>, writable: bool) -> McpAccess {
        McpAccess {
            writable,
            folder_uuid: None,
            folder_name: folder.map(str::to_string),
            raw_token: token.map(str::to_string),
        }
    }

    // ---- argument validation ----

    #[test]
    fn requires_exactly_one_source() {
        let err = parse_args(&json!({}), Some("Lens Edu")).unwrap_err();
        assert!(err.contains("exactly one"), "{err}");
        let err = parse_args(
            &json!({"url": "https://x.y/a.png", "content_base64": "aGk="}),
            Some("Lens Edu"),
        )
        .unwrap_err();
        assert!(err.contains("only one"), "{err}");
        let err = parse_args(&json!({"url": "ftp://x.y/a.png"}), Some("Lens Edu")).unwrap_err();
        assert!(err.contains("http"), "{err}");
    }

    #[test]
    fn url_only_call_defaults_into_the_session_folder() {
        let req = parse_args(&json!({"url": "https://x.y/a.png"}), Some("Lens Edu")).unwrap();
        assert_eq!(req.folder, "Lens Edu");
        assert_eq!(req.file_path, None);
        assert_eq!(req.stem, None);
        assert!(!req.overwrite);

        let err = parse_args(&json!({"url": "https://x.y/a.png"}), None).unwrap_err();
        assert!(err.contains("file_path is required"), "{err}");
    }

    #[test]
    fn file_path_must_be_directly_under_attachments_with_an_allowed_extension() {
        let ok = parse_args(
            &json!({"url": "https://x.y/a", "file_path": "Lens Edu/attachments/fig one.PNG", "overwrite": true}),
            None,
        )
        .unwrap();
        assert_eq!(ok.folder, "Lens Edu");
        assert_eq!(ok.file_path.as_deref(), Some("/attachments/fig one.PNG"));
        assert!(ok.overwrite);

        for bad in [
            "Lens Edu/fig.png",
            "Lens Edu/attachments/sub/fig.png",
            "Lens Edu/attachments/fig.svg",
            "Lens Edu/attachments/fig",
            "Lens Edu/attachments/.png",
            "Lens Edu/attachments/fi\"g.png",
            "/attachments/fig.png",
            "fig.png",
        ] {
            let err =
                parse_args(&json!({"url": "https://x.y/a", "file_path": bad}), None).unwrap_err();
            assert!(!err.is_empty(), "{bad} should be rejected");
        }
    }

    #[test]
    fn stem_must_be_kebab_case_and_exclusive_with_file_path() {
        for good in ["fig1", "turner-power-fig-1", "a"] {
            parse_args(
                &json!({"url": "https://x.y/a", "stem": good}),
                Some("Lens Edu"),
            )
            .unwrap_or_else(|e| panic!("{good}: {e}"));
        }
        for bad in [
            "Fig",
            "fig 1",
            "-fig",
            "fig-",
            "fig--1",
            "fig_1",
            &"a".repeat(81),
        ] {
            let err = parse_args(
                &json!({"url": "https://x.y/a", "stem": bad}),
                Some("Lens Edu"),
            )
            .unwrap_err();
            assert!(err.contains("kebab"), "{bad}: {err}");
        }
        let err = parse_args(
            &json!({"url": "https://x.y/a", "stem": "fig", "file_path": "Lens Edu/attachments/f.png"}),
            None,
        )
        .unwrap_err();
        assert!(err.contains("not both"), "{err}");
    }

    #[test]
    fn base64_needs_a_name_and_respects_the_hard_cap() {
        let err = parse_args(&json!({"content_base64": "aGk="}), Some("Lens Edu")).unwrap_err();
        assert!(err.contains("stem or file_path"), "{err}");
        parse_args(
            &json!({"content_base64": "aGk=", "stem": "x"}),
            Some("Lens Edu"),
        )
        .unwrap();
        let huge = "A".repeat(MAX_ATTACHMENT_BYTES / 3 * 4 + 1024 * 1024);
        let err = parse_args(
            &json!({"content_base64": huge, "stem": "x"}),
            Some("Lens Edu"),
        )
        .unwrap_err();
        assert!(err.contains("hard limit"), "{err}");
    }

    #[test]
    fn overwrite_must_be_boolean() {
        let err = parse_args(
            &json!({"url": "https://x.y/a", "overwrite": "yes"}),
            Some("Lens Edu"),
        )
        .unwrap_err();
        assert!(err.contains("boolean"), "{err}");
    }

    // Prevents: the relay and the editor drifting on the limits they both
    // enforce and describe to agents.
    #[test]
    fn limits_match_the_editor_contract() {
        let contract: Value = serde_json::from_str(include_str!(
            "../../../../../lens-editor/shared/attachment-limits.json"
        ))
        .expect("attachment limits contract must be valid JSON");
        assert_eq!(contract["max_bytes"], MAX_ATTACHMENT_BYTES as u64);
        assert_eq!(contract["soft_bytes"], SOFT_ATTACHMENT_BYTES as u64);
        assert_eq!(contract["max_stem_len"], MAX_STEM_LEN as u64);
        let mut exts: Vec<&str> = contract["allowed_extensions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        exts.sort_unstable();
        let mut ours = ALLOWED_EXTENSIONS.to_vec();
        ours.sort_unstable();
        assert_eq!(exts, ours);
    }

    // ---- public URL config ----

    #[test]
    fn public_url_map_parses_pairs_and_falls_back_to_the_staging_default() {
        let raw = "Lens Edu=https://raw.example/edu/staging/; Lens = https://raw.example/lens/main ;junk;=x";
        assert_eq!(
            public_base_url_from(raw, "Lens Edu").as_deref(),
            Some("https://raw.example/edu/staging")
        );
        assert_eq!(
            public_base_url_from(raw, "Lens").as_deref(),
            Some("https://raw.example/lens/main")
        );
        assert_eq!(public_base_url_from(raw, "Other"), None);
        assert_eq!(
            public_base_url_from(DEFAULT_PUBLIC_URLS, "Lens Edu").as_deref(),
            Some("https://raw.githubusercontent.com/Lens-Academy/lens-edu-staging/staging")
        );
    }

    #[test]
    fn public_url_encodes_path_segments() {
        assert_eq!(
            public_url(
                "https://raw.example/edu/staging/",
                "/attachments/fig one.png"
            ),
            "https://raw.example/edu/staging/attachments/fig%20one.png"
        );
    }

    // ---- proxying ----

    /// Mock editor that records (auth, body) and replies with `reply`.
    async fn mock_editor(
        reply: (u16, Value),
    ) -> (
        String,
        tokio::sync::mpsc::UnboundedReceiver<(String, Value)>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let app = Router::new().route(
            "/api/attachments/import",
            post(move |req: Request| {
                let tx = tx.clone();
                let reply = reply.clone();
                async move {
                    let auth = req
                        .headers()
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("")
                        .to_string();
                    let body = axum::body::to_bytes(req.into_body(), 32 << 20)
                        .await
                        .unwrap();
                    let body: Value = serde_json::from_slice(&body).unwrap();
                    tx.send((auth, body)).unwrap();
                    (
                        axum::http::StatusCode::from_u16(reply.0).unwrap(),
                        axum::Json(reply.1),
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{}", addr), rx)
    }

    fn created_reply() -> Value {
        json!({
            "path": "/attachments/fig-1a2b3c4d.png",
            "uuid": "aaaa1111-0000-4000-8000-000000000001",
            "doc_id": "relay-aaaa1111-0000-4000-8000-000000000001",
            "sha256": "1a2b3c4d".repeat(8),
            "bytes": 1234,
            "mimetype": "image/png",
            "created": true,
            "overwritten": false,
            "deduplicated_from": null,
            "warnings": []
        })
    }

    // Prevents: the editor request going out without the caller's share
    // token, with a folder other than the session's, or losing arguments.
    #[tokio::test]
    async fn forwards_token_folder_and_arguments_and_adds_public_url() {
        let server = build_blob_test_server_with_folder().await;
        let sid = setup_session_no_reads(&server);
        let (editor_url, mut rx) = mock_editor((200, created_reply())).await;

        let out = execute_with_editor_url(
            &server,
            &sid,
            &access(Some("Lens Edu"), Some("tok-1"), true),
            &json!({"url": "https://cdn.example/fig.png", "stem": "fig", "mimetype": "image/png"}),
            &editor_url,
        )
        .await
        .expect("import should succeed");

        let (auth, body) = rx.recv().await.unwrap();
        assert_eq!(auth, "Bearer tok-1");
        assert_eq!(body["folder"], "Lens Edu");
        assert_eq!(body["url"], "https://cdn.example/fig.png");
        assert_eq!(body["stem"], "fig");
        assert_eq!(body["mimetype"], "image/png");
        assert_eq!(body["overwrite"], false);
        assert!(body["file_path"].is_null());

        let out: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(out["path"], "Lens Edu/attachments/fig-1a2b3c4d.png");
        assert_eq!(
            out["public_url"],
            "https://raw.githubusercontent.com/Lens-Academy/lens-edu-staging/staging/attachments/fig-1a2b3c4d.png"
        );
        assert_eq!(out["created"], true);
        assert_eq!(out["overwritten"], false);
        assert!(out["deduplicated_from"].is_null());
        assert_eq!(out["bytes"], 1234);
        assert_eq!(out["mimetype"], "image/png");
        assert!(out["note"].as_str().unwrap().contains("git-sync"));

        // Recent changes: the upload is an event under the attachment's uuid.
        let events = server
            .recent_changes_index()
            .get("aaaa1111-0000-4000-8000-000000000001")
            .expect("upload should be on the recent changes index");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "insert");
        assert!(events[0]
            .new
            .contains("Lens Edu/attachments/fig-1a2b3c4d.png"));
        assert!(events[0].actor.starts_with("ai:"), "{}", events[0].actor);
    }

    #[tokio::test]
    async fn dedup_reply_is_reported_and_not_logged_as_a_change() {
        let server = build_blob_test_server_with_folder().await;
        let sid = setup_session_no_reads(&server);
        let mut reply = created_reply();
        reply["created"] = json!(false);
        reply["deduplicated_from"] = json!("/attachments/earlier-1a2b3c4d.png");
        reply["path"] = json!("/attachments/earlier-1a2b3c4d.png");
        let (editor_url, _rx) = mock_editor((200, reply)).await;

        let out = execute_with_editor_url(
            &server,
            &sid,
            &access(Some("Lens Edu"), Some("tok"), true),
            &json!({"url": "https://cdn.example/fig.png"}),
            &editor_url,
        )
        .await
        .unwrap();
        let out: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(out["created"], false);
        assert_eq!(
            out["deduplicated_from"],
            "Lens Edu/attachments/earlier-1a2b3c4d.png"
        );
        assert!(out["note"].as_str().unwrap().contains("already hosted"));
        assert!(server
            .recent_changes_index()
            .get("aaaa1111-0000-4000-8000-000000000001")
            .is_none());
    }

    #[tokio::test]
    async fn overwrite_and_soft_limit_show_up_in_the_note() {
        let server = build_blob_test_server_with_folder().await;
        let sid = setup_session_no_reads(&server);
        let mut reply = created_reply();
        reply["created"] = json!(false);
        reply["overwritten"] = json!(true);
        reply["bytes"] = json!(SOFT_ATTACHMENT_BYTES + 1);
        reply["warnings"] = json!([
            "editor says hi",
            "Image is 5242881 bytes, above the 5 MiB soft limit; consider downscaling."
        ]);
        let (editor_url, mut rx) = mock_editor((200, reply)).await;

        let out = execute_with_editor_url(
            &server,
            &sid,
            &access(Some("Lens Edu"), Some("tok"), true),
            &json!({"content_base64": "aGk=", "file_path": "Lens Edu/attachments/fig-1a2b3c4d.png", "overwrite": true}),
            &editor_url,
        )
        .await
        .unwrap();
        let (_, body) = rx.recv().await.unwrap();
        assert_eq!(body["overwrite"], true);
        assert_eq!(body["file_path"], "/attachments/fig-1a2b3c4d.png");
        assert_eq!(body["content_base64"], "aGk=");
        let out: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(out["overwritten"], true);
        let note = out["note"].as_str().unwrap();
        assert!(note.contains("5 minutes"), "{note}");
        assert!(note.contains("soft limit"), "{note}");
        assert!(note.contains("editor says hi"), "{note}");
        let events = server
            .recent_changes_index()
            .get("aaaa1111-0000-4000-8000-000000000001")
            .unwrap();
        assert_eq!(events[0].kind, "replace");
    }

    // Prevents: a 409 from the editor (same path, different bytes) being
    // swallowed; the agent must see the existing hash to decide.
    #[tokio::test]
    async fn editor_errors_surface_with_their_message() {
        let server = build_blob_test_server_with_folder().await;
        let sid = setup_session_no_reads(&server);
        let (editor_url, _rx) = mock_editor((
            409,
            json!({"error": "Path /attachments/fig.png already holds different bytes (sha256 deadbeef)", "existing_hash": "deadbeef"}),
        ))
        .await;
        let err = execute_with_editor_url(
            &server,
            &sid,
            &access(Some("Lens Edu"), Some("tok"), true),
            &json!({"url": "https://cdn.example/fig.png", "file_path": "Lens Edu/attachments/fig.png"}),
            &editor_url,
        )
        .await
        .expect_err("409 must be an error");
        assert!(err.contains("409"), "{err}");
        assert!(err.contains("deadbeef"), "{err}");
    }

    #[tokio::test]
    async fn wrong_folder_and_missing_token_are_refused_before_contacting_the_editor() {
        let server = build_blob_test_server_with_folder().await;
        let sid = setup_session_no_reads(&server);
        let err = execute_with_editor_url(
            &server,
            &sid,
            &access(Some("Lens Edu"), Some("tok"), true),
            &json!({"url": "https://cdn.example/fig.png", "file_path": "Lens/attachments/fig.png"}),
            "http://127.0.0.1:1",
        )
        .await
        .unwrap_err();
        assert!(err.contains("Access denied"), "{err}");

        let err = execute_with_editor_url(
            &server,
            &sid,
            &access(Some("Lens Edu"), None, true),
            &json!({"url": "https://cdn.example/fig.png"}),
            "http://127.0.0.1:1",
        )
        .await
        .unwrap_err();
        assert!(err.contains("credential type"), "{err}");
    }

    // Prevents: the generic dispatch scope check letting a file_path in
    // another folder through, or a read-only key using the tool.
    #[tokio::test]
    async fn dispatch_enforces_scope_and_read_only() {
        let server = build_blob_test_server_with_folder().await;
        let scoped = access(Some("Lens Edu"), Some("tok"), true);
        let sid = server
            .mcp_sessions
            .create_session(scoped.clone(), None, None);
        let res = crate::mcp::tools::dispatch_tool(
            &server,
            "import_attachment",
            &json!({"session_id": sid, "url": "https://cdn.example/fig.png", "file_path": "Lens/attachments/fig.png"}),
            &scoped,
        )
        .await;
        assert_eq!(res["isError"], json!(true));
        assert!(res["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Access denied"));

        let readonly = access(Some("Lens Edu"), Some("tok"), false);
        let sid = server
            .mcp_sessions
            .create_session(readonly.clone(), None, None);
        let res = crate::mcp::tools::dispatch_tool(
            &server,
            "import_attachment",
            &json!({"session_id": sid, "url": "https://cdn.example/fig.png"}),
            &readonly,
        )
        .await;
        assert_eq!(res["isError"], json!(true));
        assert!(res["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("read-only"));
    }
}
