//! `POST /mcp/upload/:ticket`: the receiving end of the `upload_link` tool.
//!
//! The ticket in the URL is the credential: it names the MCP session that
//! asked for it and the one file it may write, and expires after
//! `UPLOAD_TICKET_TTL`. The body is the file's full text. A new file goes
//! through the `create` tool, an existing one through `edit` with the span
//! that changed as `old_string`, so every rule those tools apply (folder
//! scope, read-only tokens, the articles block, the Markdown edit policy,
//! HTML page checks, provenance and activity) applies to uploads too.
//!
//! Errors are JSON (`{"error": ...}`): production's `redact_errors` strips
//! every other 4xx/5xx body, and the caller needs the reason to retry.

use axum::{
    body::Body,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};
use std::sync::Arc;
use yrs::{GetString, ReadTxn, Transact};

use super::tools::{self, blob, critic_markup};
use crate::server::{Server, MCP_BODY_LIMIT_BYTES};

pub async fn handle_upload(
    State(server): State<Arc<Server>>,
    Path(ticket): Path<String>,
    body: Body,
) -> Response {
    let (status, text) = perform_upload(&server, &ticket, body).await;
    if status.is_success() {
        (status, text).into_response()
    } else {
        (status, Json(json!({ "error": text }))).into_response()
    }
}

/// Run one upload. Returns the HTTP status and the text for the caller.
/// The ticket is spent only on success; after an error it can be reused.
pub async fn perform_upload(
    server: &Arc<Server>,
    ticket_id: &str,
    body: Body,
) -> (StatusCode, String) {
    let Some(ticket) = server.mcp_sessions.take_upload(ticket_id) else {
        return (
            StatusCode::NOT_FOUND,
            "Upload link unknown, expired or already used. Call upload_link for a new one.".into(),
        );
    };
    let result = upload_with_ticket(server, &ticket, body).await;
    match result {
        Ok(text) => (StatusCode::OK, text + "\n"),
        Err((status, text)) => {
            if status != StatusCode::GONE {
                server.mcp_sessions.restore_upload(ticket_id, ticket);
            }
            (status, text)
        }
    }
}

async fn upload_with_ticket(
    server: &Arc<Server>,
    ticket: &crate::mcp::session::UploadTicket,
    body: Body,
) -> Result<String, (StatusCode, String)> {
    // Read the body only once the ticket is known to be valid.
    let bytes = axum::body::to_bytes(body, MCP_BODY_LIMIT_BYTES)
        .await
        .map_err(|_| {
            (
                StatusCode::PAYLOAD_TOO_LARGE,
                format!(
                    "The body could not be read or is over {} MiB.",
                    MCP_BODY_LIMIT_BYTES / (1024 * 1024)
                ),
            )
        })?;
    let content = String::from_utf8(Vec::from(bytes)).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            "The body is not UTF-8 text. Upload the file's raw text (images go through import_attachment).".to_string(),
        )
    })?;
    let access = server
        .mcp_sessions
        .get_session(&ticket.session_id)
        .map(|s| s.access.clone())
        .ok_or_else(|| {
            (
                StatusCode::GONE,
                "The MCP session behind this link has ended. Create a session and call upload_link again.".to_string(),
            )
        })?;
    let file_path = ticket.file_path.as_str();
    let mut marked_read: Option<String> = None;

    let (tool, arguments) = match server.doc_resolver().resolve_path(file_path) {
        None => (
            "create",
            json!({"session_id": ticket.session_id, "file_path": file_path, "content": content}),
        ),
        Some(_) if !ticket.replace => {
            return Err((
                StatusCode::CONFLICT,
                format!(
                    "{} was created after this link was issued. Call upload_link with replace: true to overwrite it.",
                    file_path
                ),
            ))
        }
        Some(doc_info) => {
            let current = current_text(server, &doc_info.doc_id, file_path).await?;
            if current.is_empty() {
                return Err((
                    StatusCode::CONFLICT,
                    format!(
                        "{} is empty, and an edit needs existing text to replace. Delete it, then call upload_link for the same path to upload it as a new file.",
                        file_path
                    ),
                ));
            }
            let Some((old_string, new_string)) = changed_span(&current, &content) else {
                return Ok(format!("No changes needed for {}", file_path));
            };
            // The uploader replaces the whole file on purpose, so it need not
            // have read it first (that would pull it through the model).
            // The mark is undone below if the edit fails.
            marked_read = server
                .mcp_sessions
                .get_session_mut(&ticket.session_id)
                .map(|mut session| session.read_docs.insert(doc_info.doc_id.clone()))
                .unwrap_or(false)
                .then_some(doc_info.doc_id.clone());
            (
                "edit",
                json!({"session_id": ticket.session_id, "file_path": file_path, "old_string": old_string, "new_string": new_string}),
            )
        }
    };

    let result = tools::dispatch_tool(server, tool, &arguments, &access).await;
    let text = result_text(&result);
    if result["isError"] == json!(true) {
        if let Some(doc_id) = marked_read {
            if let Some(mut session) = server.mcp_sessions.get_session_mut(&ticket.session_id) {
                session.read_docs.remove(&doc_id);
            }
        }
        Err((StatusCode::UNPROCESSABLE_ENTITY, text))
    } else {
        Ok(text)
    }
}

/// The smallest `(old_string, new_string)` pair that turns `old` into `new`
/// through `edit`: the lines that differ, widened on both sides (1, 2, 4, ...
/// lines, so repetitive text stays O(n log n)) until the old span occurs
/// exactly once in `old`, overlapping occurrences included. Replacing only
/// that span keeps the text outside it (and its authorship) in place, where
/// a whole-file `old_string` would rewrite all of it. Falls back to the whole
/// file if the span would not reproduce `new`. None when the texts are equal.
fn changed_span(old: &str, new: &str) -> Option<(String, String)> {
    if old == new {
        return None;
    }
    let prefix = old
        .char_indices()
        .zip(new.chars())
        .find(|((_, a), b)| a != b)
        .map(|((i, _), _)| i)
        .unwrap_or_else(|| old.len().min(new.len()));
    let max_suffix = old.len().min(new.len()) - prefix;
    let suffix = old[prefix..]
        .chars()
        .rev()
        .zip(new[prefix..].chars().rev())
        .take_while(|(a, b)| a == b)
        .map(|(a, _)| a.len_utf8())
        .scan(0, |n, len| {
            *n += len;
            Some(*n)
        })
        .take_while(|n| *n <= max_suffix)
        .last()
        .unwrap_or(0);

    let line_start = |at: usize| old[..at].rfind('\n').map_or(0, |i| i + 1);
    let line_end = |at: usize| old[at..].find('\n').map_or(old.len(), |i| at + i + 1);
    let unique = |start: usize, end: usize| {
        let span = &old[start..end];
        !span.is_empty() && old.find(span) == Some(start) && old.rfind(span) == Some(start)
    };
    let mut start = line_start(prefix);
    let mut end = line_end(old.len() - suffix);
    let mut lines = 1;
    while (start > 0 || end < old.len()) && !unique(start, end) {
        for _ in 0..lines {
            start = if start > 0 { line_start(start - 1) } else { 0 };
            end = line_end(end);
        }
        lines *= 2;
    }
    let new_end = new.len() - (old.len() - end);
    let (o, n) = (&old[start..end], &new[start..new_end]);
    if old.replacen(o, n, 1) != new {
        return Some((old.to_string(), new.to_string()));
    }
    Some((o.to_string(), n.to_string()))
}

/// The text `edit` matches `old_string` against: raw for HTML, the accepted
/// view (pending suggestions resolved as if accepted) for Markdown.
async fn current_text(
    server: &Arc<Server>,
    doc_id: &str,
    file_path: &str,
) -> Result<String, (StatusCode, String)> {
    let fail = |e: String| (StatusCode::INTERNAL_SERVER_ERROR, e);
    server
        .ensure_doc_loaded(doc_id)
        .await
        .map_err(|e| fail(format!("Failed to load {}: {}", file_path, e)))?;
    let awareness = server
        .docs()
        .get(doc_id)
        .map(|d| d.awareness())
        .ok_or_else(|| fail(format!("Document data not loaded: {}", file_path)))?;
    let raw = {
        let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
        let txn = guard.doc.transact();
        txn.get_text("contents")
            .map(|t| t.get_string(&txn))
            .unwrap_or_default()
    };
    Ok(if blob::is_raw_ytext_file(file_path) {
        raw
    } else {
        critic_markup::accepted_view(&critic_markup::parse(&raw))
    })
}

fn result_text(result: &Value) -> String {
    result["content"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tools::test_helpers::*;
    use crate::mcp::tools::upload_link;

    async fn issue(server: &Arc<Server>, sid: &str, args: Value) -> Result<String, String> {
        let mut args = args;
        args["session_id"] = json!(sid);
        let text = upload_link::execute(server, sid, &args).await?;
        let url = text
            .lines()
            .find(|l| l.starts_with("http"))
            .expect("link in result")
            .to_string();
        assert!(url.contains("/mcp/upload/"), "{url}");
        Ok(url.rsplit('/').next().unwrap().to_string())
    }

    fn content_of(server: &Arc<Server>, path: &str) -> String {
        let doc_id = server.doc_resolver().resolve_path(path).unwrap().doc_id;
        read_doc_content(server, &doc_id)
    }

    // Prevents: the link creating a file through a path other than `create`,
    // or a spent link working a second time.
    #[tokio::test]
    async fn upload_creates_a_new_html_page_once() {
        let server = build_blob_test_server_with_folder().await;
        let sid = setup_session_no_reads(&server);
        let ticket = issue(&server, &sid, json!({"file_path": "Lens/Map.html"}))
            .await
            .unwrap();
        let page = format!(
            "<!doctype html><body>{}</body>",
            "<p>node ✓</p>".repeat(40_000)
        );

        let (status, text) = perform_upload(&server, &ticket, Body::from(page.clone())).await;
        assert_eq!(status, StatusCode::OK, "{text}");
        assert!(text.contains("Created Lens/Map.html"), "{text}");
        assert_eq!(content_of(&server, "Lens/Map.html"), page);

        let (status, _) = perform_upload(&server, &ticket, Body::from("x")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    // Prevents: overwriting an existing file without an explicit replace,
    // and replace needing a prior read of the (large) file.
    #[tokio::test]
    async fn replace_overwrites_existing_html_without_a_read() {
        let server = build_test_server(&[("/Page.html", "uuid-html", "<h1>Hello</h1>")]).await;
        let sid = setup_session_no_reads(&server);
        let err = issue(&server, &sid, json!({"file_path": "Lens/Page.html"}))
            .await
            .unwrap_err();
        assert!(err.contains("replace: true"), "{err}");

        let ticket = issue(
            &server,
            &sid,
            json!({"file_path": "Lens/Page.html", "replace": true}),
        )
        .await
        .unwrap();
        let page = "<h1>Hi</h1>\n".repeat(50_000);
        let (status, text) = perform_upload(&server, &ticket, Body::from(page.clone())).await;
        assert_eq!(status, StatusCode::OK, "{text}");
        assert_eq!(content_of(&server, "Lens/Page.html"), page);
    }

    // Prevents: uploads bypassing the Markdown edit policy. Replacing
    // unattributed (human) text must land as a pending suggestion.
    #[tokio::test]
    async fn markdown_replace_follows_the_edit_policy() {
        let server = build_test_server(&[("/Doc.md", "uuid-md", "Human text.")]).await;
        let sid = setup_session_no_reads(&server);
        let ticket = issue(
            &server,
            &sid,
            json!({"file_path": "Lens/Doc.md", "replace": true}),
        )
        .await
        .unwrap();
        let (status, text) = perform_upload(&server, &ticket, Body::from("AI text.")).await;
        assert_eq!(status, StatusCode::OK, "{text}");
        let content = content_of(&server, "Lens/Doc.md");
        assert!(
            content.contains("{--") && content.contains("{++"),
            "{content}"
        );
    }

    // Prevents: a failed upload burning the link, so a fixed file can't follow.
    #[tokio::test]
    async fn failed_upload_keeps_the_link_usable() {
        let server = build_blob_test_server_with_folder().await;
        let sid = setup_session_no_reads(&server);
        let ticket = issue(&server, &sid, json!({"file_path": "Lens/Doc.md"}))
            .await
            .unwrap();
        let (status, _) = perform_upload(&server, &ticket, Body::from(vec![0xff, 0xfe])).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, text) = perform_upload(&server, &ticket, Body::from("x {++y++} z")).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{text}");
        let (status, text) = perform_upload(&server, &ticket, Body::from("# Hello")).await;
        assert_eq!(status, StatusCode::OK, "{text}");
        assert_eq!(content_of(&server, "Lens/Doc.md"), "# Hello");
    }

    // Prevents: a small change to a large page rewriting the whole text.
    #[test]
    fn changed_span_is_the_changed_lines_made_unique() {
        let old = "a\nb\nc\nb\nd\n";
        assert_eq!(changed_span(old, old), None);
        // Changing the second "b" line: "b\n" alone is not unique, so the
        // span widens to the lines around it.
        let (o, n) = changed_span(old, "a\nb\nc\nB\nd\n").unwrap();
        assert_eq!((o.as_str(), n.as_str()), ("c\nb\nd\n", "c\nB\nd\n"));
        let (o, n) = changed_span("x ✓ y\nz\n", "x ✕ y\nz\n").unwrap();
        assert_eq!((o.as_str(), n.as_str()), ("x ✓ y\n", "x ✕ y\n"));
        // Every pair: the span is unique in old and applying it gives new.
        let pairs = [
            ("one\ntwo", "one\ntwo\nthree"),
            ("aaa\naaa", "aaa"),
            ("aaa", "aaa\naaa"),
            ("x\n", ""),
            ("same\nsame\nsame\n", "same\nsame\nsame\nsame\n"),
            ("a\na\na\n", "a\na\nb\n"),
            (
                "<div>\n</div>\n</div>\n</div>\n",
                "<div>\n</div>\n</div>\n</section>\n",
            ),
            (
                "<p>✓</p>\n<p>✓</p>\n<p>end</p>",
                "<p>✓</p>\n<p>✕</p>\n<p>end</p>",
            ),
        ];
        for (old, new) in pairs {
            let (o, n) = changed_span(old, new).unwrap();
            assert_eq!(
                old.find(o.as_str()),
                old.rfind(o.as_str()),
                "{old:?} -> {o:?}"
            );
            assert_eq!(old.replacen(o.as_str(), &n, 1), new, "{old:?} -> {new:?}");
        }
    }

    // Prevents: an overlapping repeat passing as unique and the edit landing
    // on the wrong occurrence (review of #127).
    #[tokio::test]
    async fn replace_with_overlapping_repeats_stores_exactly_the_upload() {
        let old = "<div>\n</div>\n</div>\n</div>\n";
        let server = build_test_server(&[("/Page.html", "uuid-html", old)]).await;
        let sid = setup_session_no_reads(&server);
        let ticket = issue(
            &server,
            &sid,
            json!({"file_path": "Lens/Page.html", "replace": true}),
        )
        .await
        .unwrap();
        let new = "<div>\n</div>\n</div>\n</section>\n";
        let (status, text) = perform_upload(&server, &ticket, Body::from(new)).await;
        assert_eq!(status, StatusCode::OK, "{text}");
        assert_eq!(content_of(&server, "Lens/Page.html"), new);
    }

    // Prevents: widening going quadratic on repetitive pages.
    #[test]
    fn changed_span_is_fast_on_repetitive_text() {
        let old = "<li>same</li>\n".repeat(30_000);
        let new = format!("{}<li>last</li>\n", &old[..old.len() - 14]);
        let t = std::time::Instant::now();
        let (o, n) = changed_span(&old, &new).unwrap();
        assert_eq!(old.replacen(o.as_str(), &n, 1), new);
        assert!(
            t.elapsed() < std::time::Duration::from_secs(1),
            "{:?}",
            t.elapsed()
        );
    }

    // Prevents: a failed replace leaving the file marked as read, which
    // would let a later plain `edit` skip the read-before-edit rule.
    #[tokio::test]
    async fn failed_replace_does_not_mark_the_file_read() {
        let server = build_test_server(&[("/Doc.md", "uuid-md", "Human text.")]).await;
        let sid = setup_session_no_reads(&server);
        let ticket = issue(
            &server,
            &sid,
            json!({"file_path": "Lens/Doc.md", "replace": true}),
        )
        .await
        .unwrap();
        let (status, _) = perform_upload(&server, &ticket, Body::from("x {++y++} z")).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        let session = server.mcp_sessions.get_session(&sid).unwrap();
        assert!(session.read_docs.is_empty());
    }

    // Prevents: one session filling memory with links.
    #[tokio::test]
    async fn live_links_per_session_are_capped() {
        let server = build_blob_test_server_with_folder().await;
        let sid = setup_session_no_reads(&server);
        for _ in 0..crate::mcp::session::MAX_UPLOADS_PER_SESSION {
            issue(&server, &sid, json!({"file_path": "Lens/Doc.md"}))
                .await
                .unwrap();
        }
        let err = issue(&server, &sid, json!({"file_path": "Lens/Doc.md"}))
            .await
            .unwrap_err();
        assert!(err.contains("unused upload links"), "{err}");
    }

    // Prevents: an expired link still writing.
    #[tokio::test]
    async fn expired_link_is_refused() {
        let server = build_blob_test_server_with_folder().await;
        let sid = setup_session_no_reads(&server);
        server.mcp_sessions.restore_upload(
            "old",
            crate::mcp::session::UploadTicket {
                session_id: sid,
                file_path: "Lens/Doc.md".into(),
                replace: false,
                expires_at: std::time::Instant::now(),
            },
        );
        let (status, _) = perform_upload(&server, "old", Body::from("# Hello")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(server.doc_resolver().resolve_path("Lens/Doc.md").is_none());
    }

    // Prevents: a folder-scoped token getting a link for another folder.
    #[tokio::test]
    async fn folder_scope_applies_to_upload_link() {
        let server = build_blob_test_server_with_folder().await;
        let access = y_sweet_core::share_token::McpAccess {
            folder_name: Some("Lens Edu".into()),
            ..default_access()
        };
        let sid = server
            .mcp_sessions
            .create_session(access.clone(), None, None);
        let result = tools::dispatch_tool(
            &server,
            "upload_link",
            &json!({"session_id": sid, "file_path": "Lens/Doc.md"}),
            &access,
        )
        .await;
        assert_eq!(result["isError"], json!(true), "{result}");
    }
}
