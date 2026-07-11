//! Session-intro lookup for `create_session`.
//!
//! Curators can place a document at `<Folder>/AI Guide/_intro.md` in any
//! shared folder. When an MCP session is created, the human-approved content
//! of that document (for every folder the token can access) is appended to
//! the `create_session` response, after the session id. This gives agents a
//! curator-maintained orientation ("if you're doing X, read Y first")
//! without hardcoding any text in the server.
//!
//! Only the *base* view of the document is returned (`critic_markup::
//! base_view` — pending suggestions excluded; do NOT swap in
//! `accepted_view`, which applies pending suggestions and would leak
//! unreviewed text into every session). Obsidian `%% ... %%` comments are
//! stripped so curators can annotate the file for each other — note this is
//! naive and also fires on `%%` inside code fences.
//!
//! Trust model: anyone with direct edit access to a folder (Obsidian/editor)
//! controls what agents are told for that folder. MCP agents cannot
//! self-inject — their writes stay pending until a human accepts them.

use super::critic_markup;
use crate::server::Server;
use std::sync::Arc;
use y_sweet_core::share_token::McpAccess;
use yrs::{GetString, ReadTxn, Transact};

/// Path of the intro document, relative to a folder root.
pub const INTRO_PATH: &str = "AI Guide/_intro.md";

/// Hard cap per folder so a runaway intro can't blow up every session.
const MAX_INTRO_CHARS: usize = 4000;

/// Collect intro texts for every folder the token can access.
/// Returns `None` when no accessible folder has a non-empty intro.
pub async fn session_intro(server: &Arc<Server>, access: &McpAccess) -> Option<String> {
    let folders: Vec<String> = match (&access.folder_name, &access.folder_uuid) {
        (Some(name), _) => vec![name.clone()],
        (None, Some(uuid)) => server.folder_name_for_uuid(uuid).into_iter().collect(),
        (None, None) => server.all_folder_names(),
    };

    let mut parts = Vec::new();
    for folder in folders {
        if let Some(text) = read_intro(server, &folder).await {
            parts.push((folder, text));
        }
    }

    match parts.len() {
        0 => None,
        1 => Some(parts.remove(0).1),
        // Multi-folder tokens: label each intro so the agent knows which
        // folder it applies to.
        _ => Some(
            parts
                .iter()
                .map(|(folder, text)| format!("## {}\n{}", folder, text))
                .collect::<Vec<_>>()
                .join("\n\n"),
        ),
    }
}

/// Read the base (human-approved) view of `<folder>/AI Guide/_intro.md`,
/// cleaned for inclusion in a tool response. Returns `None` if the document
/// doesn't exist or has no approved content yet.
async fn read_intro(server: &Arc<Server>, folder: &str) -> Option<String> {
    let path = format!("{}/{}", folder, INTRO_PATH);
    let doc_info = server.doc_resolver().resolve_path(&path)?;

    // Reload from storage if GC evicted the doc.
    if let Err(e) = server.ensure_doc_loaded(&doc_info.doc_id).await {
        tracing::warn!("session intro: failed to load {}: {}", path, e);
        return None;
    }

    let content = {
        let doc_ref = server.docs().get(&doc_info.doc_id)?;
        let awareness = doc_ref.awareness();
        let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
        let txn = guard.doc.transact();
        match txn.get_text("contents") {
            Some(text) => text.get_string(&txn),
            None => return None,
        }
    };

    // Pending suggestions are excluded: a brand-new or freshly edited intro
    // only reaches sessions once a human accepts it in the editor.
    let spans = critic_markup::parse(&content);
    let base = critic_markup::base_view(&spans);
    let cleaned = strip_obsidian_comments(&base);
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(truncate_chars(trimmed, MAX_INTRO_CHARS))
}

/// Remove Obsidian `%% ... %%` comments (inline or multi-line). An unclosed
/// `%%` comments out the rest of the document, matching Obsidian behavior.
fn strip_obsidian_comments(s: &str) -> String {
    // Compiled per call: this runs once per created session, not in a hot path.
    regex::Regex::new(r"(?s)%%.*?(?:%%|$)")
        .expect("static pattern")
        .replace_all(s, "")
        .into_owned()
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let truncated: String = s.chars().take(max).collect();
    format!("{}\n[intro truncated]", truncated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tools::test_helpers::*;
    use serde_json::json;

    fn lens_scoped_access() -> y_sweet_core::share_token::McpAccess {
        y_sweet_core::share_token::McpAccess {
            writable: true,
            folder_uuid: Some(FOLDER0_UUID.to_string()),
            folder_name: Some("Lens".to_string()),
        }
    }

    fn response_text(resp: &serde_json::Value) -> String {
        resp["content"][0]["text"].as_str().unwrap().to_string()
    }

    // Prevents: create_session response format silently changing when no
    // intro doc exists (clients take the first line as the session id)
    #[tokio::test]
    async fn create_session_without_intro_returns_bare_sid() {
        let server = build_test_server(&[]).await;
        let resp = crate::mcp::tools::dispatch_tool(
            &server,
            "create_session",
            &json!({"name": "Chris"}),
            &lens_scoped_access(),
        )
        .await;
        let text = response_text(&resp);
        assert!(!text.is_empty());
        assert!(!text.contains('\n'), "expected bare sid, got: {text}");
    }

    // Prevents: the approved intro not reaching new sessions, or curator
    // %% notes leaking into it
    #[tokio::test]
    async fn create_session_appends_approved_intro() {
        let server = build_test_server(&[(
            "/AI Guide/_intro.md",
            "bbbb0000-0000-0000-0000-000000000001",
            "If you are editing course content, read the guide first. %% curator-only note %%",
        )])
        .await;
        let resp = crate::mcp::tools::dispatch_tool(
            &server,
            "create_session",
            &json!({"name": "Chris"}),
            &lens_scoped_access(),
        )
        .await;
        let text = response_text(&resp);
        let (sid, rest) = text.split_once("\n\n").expect("sid + intro");
        assert!(!sid.is_empty() && !sid.contains('\n'));
        assert!(rest.contains("read the guide first."));
        assert!(!rest.contains("curator-only note"));
        // The sid must still be valid for subsequent calls.
        assert!(server.mcp_sessions.get_session(sid).is_some());
    }

    // Prevents: unreviewed (pending-suggestion) intro text leaking into
    // every session before a human accepts it
    #[tokio::test]
    async fn pending_suggestion_only_intro_is_excluded() {
        let server = build_test_server(&[(
            "/AI Guide/_intro.md",
            "bbbb0000-0000-0000-0000-000000000002",
            "{++This whole intro is an unaccepted suggestion.++}",
        )])
        .await;
        let resp = crate::mcp::tools::dispatch_tool(
            &server,
            "create_session",
            &json!({}),
            &lens_scoped_access(),
        )
        .await;
        let text = response_text(&resp);
        assert!(!text.contains('\n'), "expected bare sid, got: {text}");
    }

    // Prevents: curator notes in %% ... %% leaking into every session's intro
    #[test]
    fn strips_inline_and_multiline_obsidian_comments() {
        assert_eq!(
            strip_obsidian_comments("keep %% drop %% this\n%% multi\nline %%end"),
            "keep  this\nend"
        );
    }

    // Prevents: an unclosed %% dumping the raw marker into the intro
    #[test]
    fn unclosed_comment_drops_remainder() {
        assert_eq!(strip_obsidian_comments("keep %% rest is gone"), "keep ");
    }

    // Prevents: a panic on multi-byte characters at the truncation boundary
    #[test]
    fn truncation_is_char_safe_and_marked() {
        let long = "é".repeat(MAX_INTRO_CHARS + 10);
        let out = truncate_chars(&long, MAX_INTRO_CHARS);
        assert!(out.ends_with("[intro truncated]"));
        assert_eq!(out.chars().count(), MAX_INTRO_CHARS + 18);
    }
}
