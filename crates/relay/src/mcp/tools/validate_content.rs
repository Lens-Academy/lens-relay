//! MCP `validate_content`: validate live relay content with the platform's
//! content processor.
//!
//! Builds a `{path: content}` map of the session's folder (paths relative to
//! the folder root, matching the GitHub content-repo layout), optionally with
//! pending CriticMarkup suggestions applied (`accept_drafts`), and POSTs it
//! to lens-platform's `/api/content/validate-adhoc`. That endpoint runs the
//! exact same in-repo processor the /validate dashboard uses, so results
//! cannot drift from what humans see there — this tool only chooses which
//! *view* of the content gets validated:
//!
//! - `accept_drafts: false` (default) — human-approved content only, i.e.
//!   what the dashboard validates (modulo the relay→GitHub sync lag; this
//!   tool is strictly fresher).
//! - `accept_drafts: true` — as if every pending suggestion were accepted:
//!   the only way to validate AI drafts *before* a human accepts them.
//!
//! The request body is gzipped: the map is tens of megabytes of markdown and
//! JSON. The platform accepts both encodings, so it must be deployed before a
//! relay carrying this code.
//!
//! Config: `LENS_PLATFORM_URL` (default `https://staging.lensacademy.org`)
//! and `ADHOC_VALIDATION_SECRET` (shared with lens-platform).

use super::critic_markup;
use crate::server::Server;
use serde_json::{json, Value};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use y_sweet_core::share_token::McpAccess;

const DEFAULT_PLATFORM_URL: &str = "https://staging.lensacademy.org";
const DEFAULT_FOLDER: &str = "Lens Edu";
// Validation runs take tens of seconds; the platform runs a TS subprocess per
// call. Measured end-to-end against production: 91.6s and 89.9s on consecutive
// calls, and those had the platform's per-file processor cache warm. That cache
// keys on a hash of the processor's own source, so any lens-platform deploy
// touching content_processor invalidates every entry and the next call reparses
// ~2,600 files cold. 120s left no room for that; 300s does.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
// Hard ceilings so one tool call can never wedge on storage loads (the doc
// map may pull GC-evicted docs from R2, like grep does) or ship an
// unbounded payload to the platform.
const MAP_BUILD_TIMEOUT: Duration = Duration::from_secs(60);
// Measured on the staging content: ~46MB uncompressed (2,498 markdown files at
// 27.6MB plus 128 JSON files at 18.1MB, nearly all video-transcript
// timestamps), which sat at 92% of the previous 50MB limit. The timestamp
// bodies cannot be dropped to save room — validateTimestamps checks every entry
// — so the ceiling has to accommodate them. This bounds what is buffered and
// compressed, not what crosses the wire; the body is gzipped before sending.
//
// Enforced on the serialized JSON, which is what the platform's
// _MAX_DECOMPRESSED_BYTES bounds — the two must measure the same quantity or
// the relay will happily send a body the platform refuses. (JSON escaping
// inflates content noticeably: every newline and every quote in the 18MB of
// transcript JSON gains a byte.) The cheap pre-check below on unescaped
// content bytes only avoids serializing something absurd; the real gate is
// after serialization.
const MAX_PAYLOAD_BYTES: usize = 128 * 1024 * 1024;

pub fn platform_url_from_env() -> String {
    std::env::var("LENS_PLATFORM_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_PLATFORM_URL.to_string())
}

fn secret_from_env() -> Result<String, String> {
    std::env::var("ADHOC_VALIDATION_SECRET")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| {
            "Error: validate_content is not configured on this relay (ADHOC_VALIDATION_SECRET unset)."
                .to_string()
        })
}

/// Execute the `validate_content` tool.
pub async fn execute(
    server: &Arc<Server>,
    access: &McpAccess,
    arguments: &Value,
) -> Result<String, String> {
    let secret = secret_from_env()?;
    execute_with_platform(server, access, arguments, &platform_url_from_env(), &secret).await
}

pub async fn execute_with_platform(
    server: &Arc<Server>,
    access: &McpAccess,
    arguments: &Value,
    platform_url: &str,
    secret: &str,
) -> Result<String, String> {
    let accept_drafts = arguments
        .get("accept_drafts")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let course = arguments.get("course").and_then(|v| v.as_str());
    let category = arguments.get("category").and_then(|v| v.as_str());
    if let Some(cat) = category {
        if cat != "production" && cat != "wip" {
            return Err("category must be 'production' or 'wip'".to_string());
        }
    }

    // Folder-scoped tokens validate their folder. All-folder tokens default
    // to the course-content folder ("Lens Edu") rather than mixing folders:
    // each folder is an independent content root, and validating them
    // together would create cross-folder wikilink noise. (Note: the dispatch
    // folder-scope check doesn't apply here — this tool takes no path args
    // and derives its folder from the token itself. Keep it that way; a
    // user-supplied `folder` arg would bypass token isolation.)
    let folder = access
        .folder_name
        .clone()
        .unwrap_or_else(|| DEFAULT_FOLDER.to_string());

    let files = tokio::time::timeout(
        MAP_BUILD_TIMEOUT,
        build_file_map(server, &folder, accept_drafts),
    )
    .await
    .map_err(|_| {
        format!(
            "Error: timed out collecting documents from '{}' after {}s — try again (docs may still be loading from storage)",
            folder,
            MAP_BUILD_TIMEOUT.as_secs()
        )
    })?;
    if files.is_empty() {
        return Err(format!(
            "Error: no readable documents found in folder '{}'",
            folder
        ));
    }
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

    let mut body = json!({ "files": files });
    if let Some(c) = course {
        body["course"] = json!(c);
    }
    if let Some(c) = category {
        body["category"] = json!(c);
    }

    let url = format!(
        "{}/api/content/validate-adhoc",
        platform_url.trim_end_matches('/')
    );

    // The body is tens of megabytes of markdown and JSON, which gzips to a small
    // fraction of that. The platform decompresses when Content-Encoding says so
    // and still accepts an uncompressed body, so a relay running this code can
    // talk to a platform that predates it only if that platform has the decoding
    // half deployed — deploy the platform first.
    // Serializing and compressing tens of megabytes is seconds of CPU. Prod is a
    // 2-vCPU box where blocking an async worker starves the relay's runtime (see
    // AGENTS.md), so this runs on the blocking pool rather than inline.
    let (raw_len, compressed) =
        tokio::task::spawn_blocking(move || -> Result<(usize, Vec<u8>), String> {
            let raw = serde_json::to_vec(&body)
                .map_err(|e| format!("Error: could not serialize validation request: {}", e))?;
            if raw.len() > MAX_PAYLOAD_BYTES {
                return Err(format!(
                    "Error: folder content too large to validate ({} MB of JSON, max {} MB)",
                    raw.len() / (1024 * 1024),
                    MAX_PAYLOAD_BYTES / (1024 * 1024)
                ));
            }
            let compressed = gzip(&raw)?;
            Ok((raw.len(), compressed))
        })
        .await
        .map_err(|e| format!("Error: encoding the validation request failed: {}", e))??;
    tracing::debug!(
        "validate_content: payload {} bytes -> {} bytes gzipped",
        raw_len,
        compressed.len()
    );

    let resp = client()
        .post(&url)
        .header("X-Validation-Key", secret)
        .header("Content-Type", "application/json")
        .header("Content-Encoding", "gzip")
        .body(compressed)
        .send()
        .await
        .map_err(|e| {
            format!(
                "Error: could not reach the validation service at {}: {}",
                url, e
            )
        })?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("Error: failed to read validation response: {}", e))?;
    if status.is_success() {
        Ok(text)
    } else {
        Err(format!(
            "Error: validation service returned {}: {}",
            status, text
        ))
    }
}

/// Build `{folder-relative-path: content}` for every readable text document
/// in the folder. Markdown gets the chosen CriticMarkup view; `.json` blobs
/// (e.g. video timestamp files) are included raw; other binaries are skipped.
async fn build_file_map(
    server: &Arc<Server>,
    folder: &str,
    accept_drafts: bool,
) -> serde_json::Map<String, Value> {
    let prefix = format!("{}/", folder);
    let mut files = serde_json::Map::new();

    for path in server.doc_resolver().all_paths() {
        let Some(rel) = path.strip_prefix(&prefix) else {
            continue;
        };
        let is_md = rel.ends_with(".md");
        let is_json = rel.ends_with(".json");
        if !is_md && !is_json {
            continue;
        }
        let Some(doc_info) = server.doc_resolver().resolve_path(&path) else {
            continue;
        };

        let Some(raw) = super::grep::read_doc_content(server, &doc_info.doc_id, &path).await else {
            tracing::warn!("validate_content: skipping unreadable {}", path);
            continue;
        };
        // Markdown carries CriticMarkup — resolve it to the requested view.
        // .json blobs (timestamp files) have none and go through raw.
        let content = if is_md {
            let spans = critic_markup::parse(&raw);
            if accept_drafts {
                critic_markup::accepted_view(&spans)
            } else {
                critic_markup::base_view(&spans)
            }
        } else {
            raw
        };

        files.insert(rel.to_string(), Value::String(content));
    }

    files
}

/// Gzip `data` at the default compression level.
fn gzip(data: &[u8]) -> Result<Vec<u8>, String> {
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;

    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(data)
        .map_err(|e| format!("Error: could not compress validation request: {}", e))?;
    encoder
        .finish()
        .map_err(|e| format!("Error: could not compress validation request: {}", e))
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

    fn lens_access() -> McpAccess {
        McpAccess {
            writable: true,
            folder_uuid: Some(FOLDER0_UUID.to_string()),
            folder_name: Some("Lens".to_string()),
            raw_token: None,
        }
    }

    /// Mock platform recording (validation key, content-encoding, decoded body).
    async fn mock_platform() -> (
        String,
        tokio::sync::mpsc::UnboundedReceiver<(String, String, String)>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let app = Router::new().route(
            "/api/content/validate-adhoc",
            post(move |req: Request| {
                let tx = tx.clone();
                async move {
                    let key = req
                        .headers()
                        .get("x-validation-key")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("")
                        .to_string();
                    let encoding = req
                        .headers()
                        .get("content-encoding")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("")
                        .to_string();
                    let body = axum::body::to_bytes(req.into_body(), 64 << 20)
                        .await
                        .unwrap();
                    let body = if encoding == "gzip" {
                        use std::io::Read;
                        let mut out = Vec::new();
                        flate2::read::GzDecoder::new(&body[..])
                            .read_to_end(&mut out)
                            .expect("body must be valid gzip");
                        out
                    } else {
                        body.to_vec()
                    };
                    tx.send((key, encoding, String::from_utf8_lossy(&body).to_string()))
                        .unwrap();
                    axum::Json(serde_json::json!({"summary": {}, "issues": [], "counts": {}}))
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

    // Prevents: pending AI suggestions leaking into the "published" view, or
    // being missing from the drafts view — the whole point of the toggle
    #[tokio::test]
    async fn accept_drafts_toggle_controls_criticmarkup_view() {
        let server = build_test_server(&[(
            "/Lenses/A.md",
            "cccc0000-0000-0000-0000-000000000001",
            "approved text {++pending suggestion++}",
        )])
        .await;
        let (url, mut rx) = mock_platform().await;

        // Base view: suggestion excluded
        execute_with_platform(&server, &lens_access(), &serde_json::json!({}), &url, "sek")
            .await
            .expect("validate should succeed");
        let (key, encoding, body) = rx.recv().await.unwrap();
        assert_eq!(key, "sek");
        assert_eq!(encoding, "gzip", "request body must be compressed");
        let body: Value = serde_json::from_str(&body).unwrap();
        let content = body["files"]["Lenses/A.md"].as_str().unwrap();
        assert!(content.contains("approved text"));
        assert!(!content.contains("pending suggestion"), "got: {content}");

        // Drafts view: suggestion applied, markup gone
        execute_with_platform(
            &server,
            &lens_access(),
            &serde_json::json!({"accept_drafts": true}),
            &url,
            "sek",
        )
        .await
        .expect("validate should succeed");
        let (_, _, body) = rx.recv().await.unwrap();
        let body: Value = serde_json::from_str(&body).unwrap();
        let content = body["files"]["Lenses/A.md"].as_str().unwrap();
        assert!(content.contains("pending suggestion"));
        assert!(
            !content.contains("{++"),
            "markup must be resolved: {content}"
        );
    }

    // Prevents: paths sent with the relay folder prefix — the processor
    // expects GitHub-repo-relative paths like "Lenses/A.md"
    #[tokio::test]
    async fn paths_are_folder_relative_and_filters_forwarded() {
        let server = build_test_server(&[(
            "/Lenses/A.md",
            "cccc0000-0000-0000-0000-000000000002",
            "hello",
        )])
        .await;
        let (url, mut rx) = mock_platform().await;

        execute_with_platform(
            &server,
            &lens_access(),
            &serde_json::json!({"course": "ai-risk", "category": "production"}),
            &url,
            "sek",
        )
        .await
        .expect("validate should succeed");
        let (_, _, body) = rx.recv().await.unwrap();
        let body: Value = serde_json::from_str(&body).unwrap();
        assert!(body["files"].get("Lenses/A.md").is_some());
        assert!(body["files"].get("Lens/Lenses/A.md").is_none());
        assert_eq!(body["course"], "ai-risk");
        assert_eq!(body["category"], "production");
    }

    // Prevents: a bogus category silently validating everything
    #[tokio::test]
    async fn rejects_invalid_category() {
        let server = build_test_server(&[]).await;
        let err = execute_with_platform(
            &server,
            &lens_access(),
            &serde_json::json!({"category": "bogus"}),
            "http://127.0.0.1:1",
            "sek",
        )
        .await
        .expect_err("must reject");
        assert!(err.contains("category"));
    }
}
