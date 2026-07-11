//! MCP proxy for the lens-editor article importer.
//!
//! `import_article` forwards URLs to lens-editor's `POST /api/add-article`;
//! `import_status` proxies `GET /api/add-article/status`. Auth: the session's
//! own share token (carried on `McpAccess::raw_token`) is forwarded as the
//! Bearer, so role/folder enforcement stays in lens-editor — the relay adds
//! no new trust. Legacy API-key sessions have no share token and get a clear
//! error instead.
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

pub fn editor_url_from_env() -> String {
    std::env::var("LENS_EDITOR_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_EDITOR_URL.to_string())
}

fn is_youtube_url(url: &str) -> bool {
    let lower = url.to_lowercase();
    let host = lower
        .split("//")
        .nth(1)
        .unwrap_or(&lower)
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .rsplit('@') // drop userinfo
        .next()
        .unwrap_or("")
        .split(':') // drop port
        .next()
        .unwrap_or("");
    host == "youtu.be" || host == "youtube.com" || host.ends_with(".youtube.com")
}

/// Get the request's forwardable share token, or a user-facing error.
/// Uses the credential this call was made with (not one stored on the
/// session) so a leaked session id never upgrades a weaker token.
fn request_token(access: &McpAccess) -> Result<String, String> {
    access.raw_token.clone().ok_or_else(|| {
        "Error: Article import is not available for this credential type (requires a share-token MCP URL, not the legacy API key)."
            .to_string()
    })
}

/// Execute the `import_article` tool.
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
    if let Some(yt) = urls.iter().find(|u| is_youtube_url(u)) {
        return Err(format!(
            "Error: {} is a YouTube URL. Videos can't be imported from a bare URL — the transcript must be captured from the YouTube page via the video-import bookmarklet in the web editor. Import it there, or ask a human curator.",
            yt
        ));
    }

    let token = request_token(access)?;
    let create_lens = arguments.get("create_lens").and_then(|v| v.as_bool());

    let mut body = json!({ "urls": urls });
    if let Some(cl) = create_lens {
        body["createLens"] = json!(cl);
    }

    proxy(
        reqwest::Method::POST,
        &format!("{}/api/add-article", editor_url.trim_end_matches('/')),
        &token,
        Some(body),
    )
    .await
}

/// Execute the `import_status` tool.
pub async fn status(access: &McpAccess) -> Result<String, String> {
    status_with_editor_url(access, &editor_url_from_env()).await
}

pub async fn status_with_editor_url(
    access: &McpAccess,
    editor_url: &str,
) -> Result<String, String> {
    let token = request_token(access)?;
    proxy(
        reqwest::Method::GET,
        &format!(
            "{}/api/add-article/status",
            editor_url.trim_end_matches('/')
        ),
        &token,
        None,
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
        }
    }

    fn access_without_token() -> McpAccess {
        McpAccess {
            writable: true,
            folder_uuid: None,
            folder_name: None,
            raw_token: None,
        }
    }

    /// Spin up a mock lens-editor recording the auth header + body.
    async fn mock_editor() -> (
        String,
        tokio::sync::mpsc::UnboundedReceiver<(String, String)>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let tx2 = tx.clone();
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
                        tx.send((auth, String::new())).unwrap();
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

    // Prevents: importer requests going out without the caller's own share
    // token, or with a mangled payload
    #[tokio::test]
    async fn forwards_token_and_payload_to_editor() {
        let (editor_url, mut rx) = mock_editor().await;

        let out = execute_with_editor_url(
            &access_with_token("tok-123"),
            &json!({"urls": ["https://example.com/a"], "create_lens": false}),
            &editor_url,
        )
        .await
        .expect("import should succeed");

        assert!(out.contains("queued"));
        let (auth, body) = rx.recv().await.unwrap();
        assert_eq!(auth, "Bearer tok-123");
        let body: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(body["urls"][0], "https://example.com/a");
        assert_eq!(body["createLens"], false);
    }

    // Prevents: YouTube URLs silently producing garbage article imports
    #[tokio::test]
    async fn rejects_youtube_urls_with_bookmarklet_pointer() {
        let err = execute_with_editor_url(
            &access_with_token("tok"),
            &json!({"urls": ["https://www.youtube.com/watch?v=abc123"]}),
            "http://127.0.0.1:1", // must not be contacted
        )
        .await
        .expect_err("youtube must be rejected");
        assert!(err.contains("bookmarklet"), "got: {err}");
    }

    // Prevents: legacy API-key sessions failing with an opaque editor 401
    // instead of a clear explanation
    #[tokio::test]
    async fn legacy_key_session_gets_clear_error() {
        let err = execute_with_editor_url(
            &access_without_token(),
            &json!({"urls": ["https://example.com/a"]}),
            "http://127.0.0.1:1",
        )
        .await
        .expect_err("no raw token → error");
        assert!(err.contains("credential type"), "got: {err}");
    }

    // Prevents: status tool dropping the forwarded token
    #[tokio::test]
    async fn status_forwards_token() {
        let (editor_url, mut rx) = mock_editor().await;

        let out = status_with_editor_url(&access_with_token("tok-9"), &editor_url)
            .await
            .expect("status should succeed");
        assert!(out.contains("jobs"));
        let (auth, _) = rx.recv().await.unwrap();
        assert_eq!(auth, "Bearer tok-9");
    }

    // Prevents: youtu.be short links and subdomains slipping past the guard
    #[test]
    fn youtube_detection_covers_variants() {
        assert!(is_youtube_url("https://youtu.be/abc"));
        assert!(is_youtube_url("https://m.youtube.com/watch?v=x"));
        assert!(is_youtube_url("http://www.youtube.com/shorts/x"));
        assert!(is_youtube_url("https://youtube.com:443/watch?v=x"));
        assert!(is_youtube_url("https://user@youtube.com/watch?v=x"));
        assert!(!is_youtube_url("https://example.com/youtube.com-article"));
        assert!(!is_youtube_url("https://notyoutube.com/watch"));
    }
}
