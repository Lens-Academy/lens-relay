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
//! Config: `LENS_PLATFORM_URL` (default `https://staging.lensacademy.org`)
//! and `ADHOC_VALIDATION_SECRET` (shared with lens-platform).

use super::critic_markup;
use crate::server::Server;
use serde_json::{json, Value};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use y_sweet_core::share_token::McpAccess;
use yrs::{GetString, ReadTxn, Transact};

const DEFAULT_PLATFORM_URL: &str = "https://staging.lensacademy.org";
const DEFAULT_FOLDER: &str = "Lens Edu";
// Validation runs take seconds; the platform runs a TS subprocess per call.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

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

    // Folder-scoped tokens validate their folder; all-folder tokens default
    // to the course-content folder.
    let folder = access
        .folder_name
        .clone()
        .unwrap_or_else(|| DEFAULT_FOLDER.to_string());

    let files = build_file_map(server, &folder, accept_drafts).await;
    if files.is_empty() {
        return Err(format!(
            "Error: no readable documents found in folder '{}'",
            folder
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
    let resp = client()
        .post(&url)
        .header("X-Validation-Key", secret)
        .json(&body)
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

        let content = if super::blob::is_blob_file(&path) {
            let Some(hash) = doc_info.hash.as_ref() else {
                continue;
            };
            match super::blob::read_blob(server, &doc_info.doc_id, hash).await {
                Ok(data) => match String::from_utf8(data) {
                    Ok(s) => s,
                    Err(_) => continue,
                },
                Err(e) => {
                    tracing::warn!("validate_content: skipping blob {}: {}", path, e);
                    continue;
                }
            }
        } else {
            if server.ensure_doc_loaded(&doc_info.doc_id).await.is_err() {
                tracing::warn!("validate_content: failed to load {}", path);
                continue;
            }
            let raw = {
                let Some(doc_ref) = server.docs().get(&doc_info.doc_id) else {
                    continue;
                };
                let awareness = doc_ref.awareness();
                let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
                let txn = guard.doc.transact();
                match txn.get_text("contents") {
                    Some(text) => text.get_string(&txn),
                    None => continue,
                }
            };
            let spans = critic_markup::parse(&raw);
            if accept_drafts {
                critic_markup::accepted_view(&spans)
            } else {
                critic_markup::base_view(&spans)
            }
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
        }
    }

    /// Mock platform recording header + body, answering a fixed result.
    async fn mock_platform() -> (
        String,
        tokio::sync::mpsc::UnboundedReceiver<(String, String)>,
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
                    let body = axum::body::to_bytes(req.into_body(), 64 << 20)
                        .await
                        .unwrap();
                    tx.send((key, String::from_utf8_lossy(&body).to_string()))
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
        let (key, body) = rx.recv().await.unwrap();
        assert_eq!(key, "sek");
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
        let (_, body) = rx.recv().await.unwrap();
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
        let (_, body) = rx.recv().await.unwrap();
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
