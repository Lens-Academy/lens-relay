//! MCP proxy for the lens-editor source importer.
//!
//! `import_source` (alias `import_article`, kept for agents configured before
//! the rename) forwards URLs to lens-editor's `POST /api/add-article`;
//! `import_status` proxies `GET /api/add-article/status` and `import_cancel`
//! proxies `POST /api/add-article/cancel`. Auth: the session's
//! own share token (carried on `McpAccess::raw_token`) is forwarded as the
//! Bearer, so role/folder enforcement stays in lens-editor — the relay adds
//! no new trust.
//!
//! The lens-editor base URL comes from `LENS_EDITOR_URL` (default
//! `http://lens-editor:3000`, the docker-compose service address).

use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;
use y_sweet_core::share_token::McpAccess;

const DEFAULT_EDITOR_URL: &str = "http://lens-editor:3000";
const MAX_URLS: usize = 20;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
pub(super) const ARTICLE_IMPORT_MODES: [&str; 3] = ["stub", "article", "article-and-lens"];

pub(super) fn editor_url_from_env() -> String {
    std::env::var("LENS_EDITOR_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_EDITOR_URL.to_string())
}

/// Get the request's forwardable share token, or a user-facing error.
/// Uses the credential this call was made with (not one stored on the
/// session) so a leaked session id never upgrades a weaker token.
pub(super) fn request_token(access: &McpAccess) -> Result<String, String> {
    access.raw_token.clone().ok_or_else(|| {
        "Error: Importing needs a share-token MCP URL, and this request carried no share token."
            .to_string()
    })
}

/// Execute the `import_source` tool (and its `import_article` alias).
pub async fn execute(access: &McpAccess, arguments: &Value) -> Result<String, String> {
    execute_with_editor_url(access, arguments, &editor_url_from_env()).await
}

pub async fn execute_with_editor_url(
    access: &McpAccess,
    arguments: &Value,
    editor_url: &str,
) -> Result<String, String> {
    let urls: Vec<String> = arguments
        .get("urls")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Missing required parameter: urls (array of strings)".to_string())?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_string)
                .ok_or_else(|| "Every entry in urls must be a string".to_string())
        })
        .collect::<Result<_, _>>()?;

    if urls.is_empty() {
        return Err("urls must not be empty".to_string());
    }
    if urls.len() > MAX_URLS {
        return Err(format!("At most {} URLs per call", MAX_URLS));
    }
    let import_mode = arguments
        .get("import_mode")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            "Missing required parameter: import_mode (stub, article, or article-and-lens)"
                .to_string()
        })?;
    if !ARTICLE_IMPORT_MODES.contains(&import_mode) {
        return Err(format!(
            "Invalid import_mode '{}'; expected one of: {}",
            import_mode,
            ARTICLE_IMPORT_MODES.join(", ")
        ));
    }

    let replace_existing = match arguments.get("replace_existing") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err("replace_existing must be a boolean".to_string()),
    };

    let token = request_token(access)?;
    let mut body = json!({ "urls": urls, "importMode": import_mode });
    // Only sent when asked for, so a plain import's payload stays unchanged.
    if replace_existing {
        body["replaceExisting"] = json!(true);
    }

    proxy(
        reqwest::Method::POST,
        &format!("{}/api/add-article", editor_url.trim_end_matches('/')),
        &token,
        Some(body),
    )
    .await
}

/// Execute the `import_status` tool. Optional `job_ids` / `urls` narrow the
/// answer to those jobs (any match); without them every job is listed.
pub async fn status(access: &McpAccess, arguments: &Value) -> Result<String, String> {
    status_with_editor_url(access, arguments, &editor_url_from_env()).await
}

pub async fn status_with_editor_url(
    access: &McpAccess,
    arguments: &Value,
    editor_url: &str,
) -> Result<String, String> {
    let mut query: Vec<(&str, String)> = Vec::new();
    for (arg, param) in [("job_ids", "id"), ("urls", "url")] {
        let Some(value) = arguments.get(arg).filter(|v| !v.is_null()) else {
            continue;
        };
        let values = value
            .as_array()
            .ok_or_else(|| format!("{} must be an array of strings", arg))?;
        // An empty list would reach the editor as no filter at all and list
        // every job, which is what the filter exists to avoid.
        if values.is_empty() {
            return Err(format!(
                "{} must not be empty; omit it to list every job",
                arg
            ));
        }
        for v in values {
            let v = v
                .as_str()
                .ok_or_else(|| format!("Every entry in {} must be a string", arg))?;
            query.push((param, v.to_string()));
        }
    }
    let token = request_token(access)?;
    let mut url = reqwest::Url::parse(&format!(
        "{}/api/add-article/status",
        editor_url.trim_end_matches('/')
    ))
    .map_err(|e| format!("Error: Invalid lens-editor URL: {}", e))?;
    if !query.is_empty() {
        url.query_pairs_mut()
            .extend_pairs(query.iter().map(|(k, v)| (*k, v.as_str())));
    }
    proxy(reqwest::Method::GET, url.as_str(), &token, None).await
}

/// Execute the `import_cancel` tool: remove queued jobs from the import queue
/// (or stop running ones). Per-id results come back from the editor.
pub async fn cancel(access: &McpAccess, arguments: &Value) -> Result<String, String> {
    cancel_with_editor_url(access, arguments, &editor_url_from_env()).await
}

pub async fn cancel_with_editor_url(
    access: &McpAccess,
    arguments: &Value,
    editor_url: &str,
) -> Result<String, String> {
    let ids: Vec<String> = arguments
        .get("job_ids")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Missing required parameter: job_ids (array of strings)".to_string())?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_string)
                .ok_or_else(|| "Every entry in job_ids must be a string".to_string())
        })
        .collect::<Result<_, _>>()?;
    if ids.is_empty() {
        return Err("job_ids must not be empty".to_string());
    }
    let token = request_token(access)?;
    proxy(
        reqwest::Method::POST,
        &format!(
            "{}/api/add-article/cancel",
            editor_url.trim_end_matches('/')
        ),
        &token,
        Some(json!({ "ids": ids })),
    )
    .await
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

async fn proxy(
    method: reqwest::Method,
    url: &str,
    token: &str,
    body: Option<Value>,
) -> Result<String, String> {
    let mut req = client().request(method, url).bearer_auth(token);
    if let Some(b) = body {
        req = req.json(&b);
    }

    let resp = req.send().await.map_err(|e| {
        format!(
            "Error: Could not reach the lens-editor importer at {}: {}",
            url, e
        )
    })?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("Error: Failed to read importer response: {}", e))?;

    if status.is_success() {
        Ok(text)
    } else {
        Err(format!("Error: Importer returned {}: {}", status, text))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::Request;
    use axum::routing::{get, post};
    use axum::Router;
    use serde_json::json;

    fn access_with_token(token: &str) -> McpAccess {
        McpAccess {
            writable: true,
            folder_uuid: None,
            folder_name: Some("Lens Edu".to_string()),
            raw_token: Some(token.to_string()),
            role: y_sweet_core::share_token::ShareRole::Admin,
        }
    }

    fn access_without_token() -> McpAccess {
        McpAccess {
            writable: true,
            folder_uuid: None,
            folder_name: None,
            raw_token: None,
            role: y_sweet_core::share_token::ShareRole::Admin,
        }
    }

    /// Spin up a mock lens-editor recording the auth header + body.
    async fn mock_editor() -> (
        String,
        tokio::sync::mpsc::UnboundedReceiver<(String, String)>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let tx2 = tx.clone();
        let tx3 = tx.clone();
        let app = Router::new()
            .route(
                "/api/add-article",
                post(move |req: Request| {
                    let tx = tx.clone();
                    async move {
                        let auth = req
                            .headers()
                            .get("authorization")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("")
                            .to_string();
                        let body = axum::body::to_bytes(req.into_body(), 1 << 20)
                            .await
                            .unwrap();
                        tx.send((auth, String::from_utf8_lossy(&body).to_string()))
                            .unwrap();
                        axum::Json(json!({"results": [{"url": "https://example.com/a", "status": "queued", "id": "job-1"}]}))
                    }
                }),
            )
            .route(
                "/api/add-article/cancel",
                post(move |req: Request| {
                    let tx = tx3.clone();
                    async move {
                        let auth = req
                            .headers()
                            .get("authorization")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("")
                            .to_string();
                        let body = axum::body::to_bytes(req.into_body(), 1 << 20)
                            .await
                            .unwrap();
                        tx.send((auth, String::from_utf8_lossy(&body).to_string()))
                            .unwrap();
                        axum::Json(json!({"results": [{"id": "job-1", "cancelled": true}]}))
                    }
                }),
            )
            .route(
                "/api/add-article/status",
                get(move |req: Request| {
                    let tx = tx2.clone();
                    async move {
                        let auth = req
                            .headers()
                            .get("authorization")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("")
                            .to_string();
                        let query = req.uri().query().unwrap_or("").to_string();
                        tx.send((auth, query)).unwrap();
                        axum::Json(json!({"jobs": []}))
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

    // Prevents: import_cancel dropping the caller's token or the ids, or
    // sending an empty batch (which the editor would reject anyway)
    #[tokio::test]
    async fn cancel_forwards_job_ids_with_the_callers_token() {
        let (editor_url, mut rx) = mock_editor().await;
        let out = cancel_with_editor_url(
            &access_with_token("tok-9"),
            &json!({"job_ids": ["job-1", "job-2"]}),
            &editor_url,
        )
        .await
        .expect("cancel should succeed");
        assert!(out.contains("cancelled"));
        let (auth, body) = rx.recv().await.unwrap();
        assert_eq!(auth, "Bearer tok-9");
        let body: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(body["ids"], json!(["job-1", "job-2"]));

        for bad in [json!({}), json!({"job_ids": []}), json!({"job_ids": [1]})] {
            let err = cancel_with_editor_url(&access_with_token("tok"), &bad, "http://127.0.0.1:1")
                .await
                .expect_err("bad job_ids must be rejected before any request");
            assert!(err.contains("job_ids"), "got: {err}");
        }
        let err = cancel_with_editor_url(
            &access_without_token(),
            &json!({"job_ids": ["job-1"]}),
            "http://127.0.0.1:1",
        )
        .await
        .expect_err("no share token");
        assert!(err.contains("share token"), "got: {err}");
    }

    // Prevents: importer requests going out without the caller's own share
    // token, or with a mangled payload
    #[tokio::test]
    async fn forwards_every_import_mode_to_editor() {
        for mode in ARTICLE_IMPORT_MODES {
            let (editor_url, mut rx) = mock_editor().await;

            let out = execute_with_editor_url(
                &access_with_token("tok-123"),
                &json!({"urls": ["https://example.com/a"], "import_mode": mode}),
                &editor_url,
            )
            .await
            .expect("import should succeed");

            assert!(out.contains("queued"));
            let (auth, body) = rx.recv().await.unwrap();
            assert_eq!(auth, "Bearer tok-123");
            let body: serde_json::Value = serde_json::from_str(&body).unwrap();
            assert_eq!(body["urls"][0], "https://example.com/a");
            assert_eq!(body["importMode"], mode);
            assert!(body.get("createLens").is_none());
        }
    }

    // Prevents: replace_existing being dropped on the way to the editor, or
    // sent on plain imports (which must keep their old payload)
    #[tokio::test]
    async fn forwards_replace_existing_only_when_set() {
        for (flag, expected) in [(Some(true), Some(true)), (Some(false), None), (None, None)] {
            let (editor_url, mut rx) = mock_editor().await;
            let mut arguments = json!({
                "urls": ["https://www.youtube.com/watch?v=abc123def45"],
                "import_mode": "article"
            });
            if let Some(flag) = flag {
                arguments["replace_existing"] = json!(flag);
            }
            execute_with_editor_url(&access_with_token("tok"), &arguments, &editor_url)
                .await
                .expect("import should succeed");
            let (_, body) = rx.recv().await.unwrap();
            let body: serde_json::Value = serde_json::from_str(&body).unwrap();
            assert_eq!(
                body.get("replaceExisting").and_then(|v| v.as_bool()),
                expected
            );
        }

        let err = execute_with_editor_url(
            &access_with_token("tok"),
            &json!({"urls": ["https://example.com/a"], "import_mode": "article", "replace_existing": "yes"}),
            "http://127.0.0.1:1",
        )
        .await
        .expect_err("a non-boolean flag must be rejected");
        assert!(err.contains("replace_existing"), "got: {err}");
    }

    #[tokio::test]
    async fn rejects_missing_or_invalid_import_mode() {
        for arguments in [
            json!({"urls": ["https://example.com/a"]}),
            json!({"urls": ["https://example.com/a"], "import_mode": "surprise"}),
        ] {
            let err = execute_with_editor_url(
                &access_with_token("tok"),
                &arguments,
                "http://127.0.0.1:1",
            )
            .await
            .expect_err("mode must be rejected before contacting the editor");
            assert!(err.contains("import_mode"), "got: {err}");
        }
    }

    // Prevents: regressing YouTube support back to a client-side rejection --
    // the editor imports video transcripts from bare URLs since 2026-08
    #[tokio::test]
    async fn forwards_youtube_urls_to_editor() {
        let (editor_url, mut rx) = mock_editor().await;

        execute_with_editor_url(
            &access_with_token("tok-yt"),
            &json!({
                "urls": ["https://www.youtube.com/watch?v=abc123def45"],
                "import_mode": "article"
            }),
            &editor_url,
        )
        .await
        .expect("youtube urls must be forwarded, not rejected");
        let (_, body) = rx.recv().await.unwrap();
        assert!(body.contains("youtube.com"), "got: {body}");
    }

    // Prevents: an access without a share token to forward failing with an
    // opaque editor 401 instead of a clear explanation
    #[tokio::test]
    async fn access_without_token_gets_clear_error() {
        let err = execute_with_editor_url(
            &access_without_token(),
            &json!({
                "urls": ["https://example.com/a"],
                "import_mode": "article"
            }),
            "http://127.0.0.1:1",
        )
        .await
        .expect_err("no raw token → error");
        assert!(err.contains("no share token"), "got: {err}");
    }

    // Prevents: status tool dropping the forwarded token
    #[tokio::test]
    async fn status_forwards_token() {
        let (editor_url, mut rx) = mock_editor().await;

        let out = status_with_editor_url(&access_with_token("tok-9"), &json!({}), &editor_url)
            .await
            .expect("status should succeed");
        assert!(out.contains("jobs"));
        let (auth, query) = rx.recv().await.unwrap();
        assert_eq!(auth, "Bearer tok-9");
        assert_eq!(query, "");
    }

    // Prevents: job_ids / urls being dropped, so a caller polling one import
    // gets every job on the server
    #[tokio::test]
    async fn status_forwards_job_and_url_filters() {
        let (editor_url, mut rx) = mock_editor().await;

        status_with_editor_url(
            &access_with_token("tok"),
            &json!({
                "job_ids": ["job-1", "job-2"],
                "urls": ["https://example.com/a?b=c&d"]
            }),
            &editor_url,
        )
        .await
        .expect("status should succeed");
        let (_, query) = rx.recv().await.unwrap();
        assert_eq!(
            query,
            "id=job-1&id=job-2&url=https%3A%2F%2Fexample.com%2Fa%3Fb%3Dc%26d"
        );
    }

    #[tokio::test]
    async fn status_rejects_malformed_filters() {
        for arguments in [
            json!({"job_ids": "job-1"}),
            json!({"urls": [42]}),
            json!({"job_ids": []}),
        ] {
            let err =
                status_with_editor_url(&access_with_token("tok"), &arguments, "http://127.0.0.1:1")
                    .await
                    .expect_err("malformed filter must be rejected before contacting the editor");
            assert!(
                err.contains("job_ids") || err.contains("urls"),
                "got: {err}"
            );
        }
    }

    #[test]
    fn rust_modes_match_the_editor_contract() {
        let contract: Value = serde_json::from_str(include_str!(
            "../../../../../lens-editor/shared/article-import-modes.json"
        ))
        .expect("article import contract must be valid JSON");
        let mut contract_modes: Vec<_> = contract
            .as_object()
            .expect("article import contract must be an object")
            .keys()
            .map(String::as_str)
            .collect();
        contract_modes.sort_unstable();

        let mut rust_modes = ARTICLE_IMPORT_MODES.to_vec();
        rust_modes.sort_unstable();
        assert_eq!(rust_modes, contract_modes);
    }
}
