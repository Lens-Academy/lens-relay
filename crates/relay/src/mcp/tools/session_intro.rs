//! Session-intro lookup for `create_session`.
//!
//! Curators can place a document at `<Folder>/AI Guide/_intro.md` in any
//! shared folder, or one folder down (`<Folder>/<sub>/AI Guide/_intro.md`, see
//! [`ai_guide_doc`]). When an MCP session is created, the human-approved content
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
//! For tokens that reach the `Lens Edu` folder, a fixed paragraph about
//! concept relationships ([`CONCEPT_ROWS_NOTE`], see `concept_rows`) follows the
//! curator intro: it explains a block that `read` adds, so it is server text.
//!
//! Trust model: anyone with direct edit access to a folder (Obsidian/editor)
//! controls what agents are told for that folder. MCP agents cannot
//! self-inject — their writes stay pending until a human accepts them.

use super::critic_markup;
use crate::server::Server;
use std::sync::Arc;
use y_sweet_core::doc_resolver::DocumentResolver;
use y_sweet_core::link_indexer::TRASH_DIR;
use y_sweet_core::share_token::McpAccess;
use yrs::{GetString, ReadTxn, Transact};

/// The folder of guides written for AI agents.
pub const AI_GUIDE_DIR: &str = "AI Guide";

/// The intro document's name inside the AI Guide folder.
pub const INTRO_FILE: &str = "_intro.md";

/// Path of `file` in `folder`'s AI Guide folder: `<folder>/AI Guide/<file>`, or
/// one folder down (`<folder>/<sub>/AI Guide/<file>`, such as
/// `Lens/11-AI/AI Guide/_intro.md`), so a team can file the guide under one of
/// its numbered folders. The top level wins; among subfolders, the first by
/// name. Nothing in the trash counts.
pub fn ai_guide_doc(resolver: &DocumentResolver, folder: &str, file: &str) -> Option<String> {
    let top = format!("{folder}/{AI_GUIDE_DIR}/{file}");
    if resolver.resolve_path(&top).is_some() {
        return Some(top);
    }
    let prefix = format!("{folder}/");
    let suffix = format!("/{AI_GUIDE_DIR}/{file}");
    resolver
        .entries_under(&prefix)
        .into_iter()
        .filter_map(|(path, _)| {
            let sub = path.strip_prefix(&prefix)?.strip_suffix(&suffix)?;
            (!sub.is_empty() && !sub.contains('/') && sub != TRASH_DIR).then_some(path)
        })
        .min()
}

/// Hard cap per folder so a runaway intro can't blow up every session.
const MAX_INTRO_CHARS: usize = 4000;

/// How `read` shows concept rows, for sessions that can reach Lens Edu.
pub const CONCEPT_ROWS_NOTE: &str = "Concept relationships: concept files (Lens Edu/Concepts/<name>.md) record what we know about which articles, videos and lenses relate to a concept. Each entry is a row: a \"### [[relative/link/to/file]]\" heading under the concept file's \"## Relationships\" heading, followed by free text. An entry means \"we have information about this pair\", which may be a negative judgment (\"considered, but not a match\"), not that they match. When you read an article, video transcript or lens, its rows (for a lens, also those about its articles and videos; for an article or video, also those about each lens that uses it, labelled per lens) come first in a block marked as context, not part of the file; its line numbers are the concept files'. To change a row, read and edit the concept file at that line; to add one, add a row like the above to the concept file. A new concept file starts with frontmatter holding `id:` (a new uuid) and, where relevant, `parent-concepts:`. Never copy rows into the article, video or lens. Concept graph: a concept file lists its broader concepts in its `parent-concepts:` frontmatter (a list of wikilinks to other concept files; the first is the primary one; no cycles), and reading a concept file starts with a context block listing its parent concepts (each with its path up to the top) and its child concepts. Write a relationship row at the most specific concept that is true; the hierarchy supplies the broader ones.";

/// Collect intro texts for every folder the token can access.
/// Returns `None` when no accessible folder has a non-empty intro and the
/// token cannot reach a folder with concept rows (which adds
/// [`CONCEPT_ROWS_NOTE`]).
pub async fn session_intro(server: &Arc<Server>, access: &McpAccess) -> Option<String> {
    let folders: Vec<String> = match (&access.folder_name, &access.folder_uuid) {
        (Some(name), _) => vec![name.clone()],
        (None, Some(uuid)) => server.folder_name_for_uuid(uuid).into_iter().collect(),
        (None, None) => server.all_folder_names(),
    };

    let concept_note = folders
        .iter()
        .any(|f| super::concept_rows::rows_shared_folders().contains(&f.as_str()));
    let mut parts = Vec::new();
    for folder in folders {
        if let Some(text) = read_intro(server, &folder).await {
            parts.push((folder, text));
        }
    }

    let intro = match parts.len() {
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
    };
    match (intro, concept_note) {
        (Some(intro), true) => Some(format!("{intro}\n\n{CONCEPT_ROWS_NOTE}")),
        (None, true) => Some(CONCEPT_ROWS_NOTE.to_string()),
        (intro, false) => intro,
    }
}

/// Read the base (human-approved) view of `folder`'s `AI Guide/_intro.md`
/// (see [`ai_guide_doc`]), cleaned for inclusion in a tool response. Returns
/// `None` if the document doesn't exist or has no approved content yet.
async fn read_intro(server: &Arc<Server>, folder: &str) -> Option<String> {
    let path = ai_guide_doc(server.doc_resolver(), folder, INTRO_FILE)?;
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
            raw_token: None,
            role: y_sweet_core::share_token::ShareRole::Admin,
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

    async fn intro_text(entries: &[(&str, &str, &str)]) -> String {
        let server = build_test_server(entries).await;
        let resp = crate::mcp::tools::dispatch_tool(
            &server,
            "create_session",
            &json!({}),
            &lens_scoped_access(),
        )
        .await;
        response_text(&resp)
    }

    // Prevents: the intro going silent when a team files its AI Guide folder
    // under one of its numbered folders (Lens/11-AI/AI Guide)
    #[tokio::test]
    async fn intro_one_folder_down_reaches_new_sessions() {
        let text = intro_text(&[(
            "/11-AI/AI Guide/_intro.md",
            "bbbb0000-0000-0000-0000-000000000003",
            "Read the nested guide first.",
        )])
        .await;
        let (_, rest) = text.split_once("\n\n").expect("sid + intro");
        assert_eq!(rest, "Read the nested guide first.");
    }

    // Prevents: a stray copy in a subfolder replacing the folder's own intro
    #[tokio::test]
    async fn top_level_intro_wins_over_a_nested_one() {
        let text = intro_text(&[
            (
                "/AI Guide/_intro.md",
                "bbbb0000-0000-0000-0000-000000000004",
                "Top-level intro.",
            ),
            (
                "/11-AI/AI Guide/_intro.md",
                "bbbb0000-0000-0000-0000-000000000005",
                "Nested intro.",
            ),
        ])
        .await;
        assert!(text.contains("Top-level intro."));
        assert!(!text.contains("Nested intro."));
    }

    // Prevents: a trashed AI Guide folder, or one nested too deep, still
    // briefing every session
    #[tokio::test]
    async fn trashed_or_deeper_intros_are_ignored() {
        let text = intro_text(&[
            (
                "/_trash/AI Guide/_intro.md",
                "bbbb0000-0000-0000-0000-000000000006",
                "Trashed intro.",
            ),
            (
                "/10-People/Mark/AI Guide/_intro.md",
                "bbbb0000-0000-0000-0000-000000000007",
                "Too deep.",
            ),
        ])
        .await;
        assert!(!text.contains('\n'), "expected bare sid, got: {text}");
    }

    // Prevents: two nested AI Guide folders giving a different intro from one
    // run to the next
    #[tokio::test]
    async fn first_nested_folder_by_name_wins() {
        let server = build_test_server(&[
            (
                "/12-Other/AI Guide/HTML Pages.md",
                "bbbb0000-0000-0000-0000-000000000008",
                "b",
            ),
            (
                "/11-AI/AI Guide/HTML Pages.md",
                "bbbb0000-0000-0000-0000-000000000009",
                "a",
            ),
        ])
        .await;
        assert_eq!(
            ai_guide_doc(server.doc_resolver(), "Lens", "HTML Pages.md").as_deref(),
            Some("Lens/11-AI/AI Guide/HTML Pages.md")
        );
        assert_eq!(ai_guide_doc(server.doc_resolver(), "Lens", INTRO_FILE), None);
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

    // Prevents: agents in Lens Edu not knowing what the concept-relationships block
    // in `read` is, or editing rows into the article instead of the concept
    #[tokio::test]
    async fn lens_edu_sessions_get_the_concept_rows_note() {
        let server = build_test_server_in("Lens Edu", &[]).await;
        let access = y_sweet_core::share_token::McpAccess {
            folder_name: Some("Lens Edu".to_string()),
            ..lens_scoped_access()
        };
        let resp =
            crate::mcp::tools::dispatch_tool(&server, "create_session", &json!({}), &access).await;
        let text = response_text(&resp);
        let (sid, rest) = text.split_once("\n\n").expect("sid + note");
        assert!(server.mcp_sessions.get_session(sid).is_some());
        assert_eq!(rest, CONCEPT_ROWS_NOTE);
    }
}
