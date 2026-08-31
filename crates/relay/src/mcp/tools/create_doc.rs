use crate::server::Server;
use serde_json::Value;
use std::sync::Arc;

use super::blob;

pub const ARTICLE_CREATE_BLOCK_MESSAGE: &str = "New files in Lens Edu/articles cannot be created with the generic MCP create or move tools. Use the Lens Editor Add Article feature or MCP import_article, then poll import_status. That workflow performs source-aware extraction, normalization, deterministic validation, mandatory LLM source-fidelity review, evidence retention, and review provenance; bypassing it tends to create substantial downstream cleanup work for Lens staff, including Elias and Luc. If an exceptional manual article is truly necessary, first explain this intended workflow and its consequences to the user and obtain explicit permission. The user must then create the file in the articles folder themselves; MCP may edit that existing file afterward.";

pub fn is_lens_edu_articles_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    let mut components: Vec<&str> = Vec::new();
    for component in normalized.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                components.pop();
            }
            value => components.push(value),
        }
    }
    components.first() == Some(&"Lens Edu") && components.get(1) == Some(&"articles")
}

/// Execute the `create` tool: create a new document or file at the specified path.
pub async fn execute(
    server: &Arc<Server>,
    session_id: &str,
    arguments: &Value,
) -> Result<String, String> {
    let file_path = arguments
        .get("file_path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter: file_path".to_string())?;

    let content = arguments
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if is_lens_edu_articles_path(file_path) {
        return Err(ARTICLE_CREATE_BLOCK_MESSAGE.to_string());
    }

    // Session identity for provenance attribution + comment author labels.
    let (author, attribution) = {
        let session = server
            .mcp_sessions
            .get_session(session_id)
            .ok_or_else(|| "Error: Session not found".to_string())?;
        (
            session.author_name.clone(),
            crate::mcp::provenance::AiAttribution {
                client_id: session.ai_client_id,
                actor: session.ai_actor.clone(),
                suggestion_author: session.author_name.clone(),
            },
        )
    };

    // Blob files (.json) — different storage path
    if blob::is_blob_file(file_path) {
        return create_blob_file(server, file_path, content).await;
    }

    if file_path.ends_with(".html") {
        return create_html_file(server, file_path, content, &attribution).await;
    }

    // --- Markdown path: created directly (a new file is pure addition, so
    // the auto edit policy would apply it directly anyway); the server
    // records a direct-edit activity event so it shows up on /recent. ---
    super::critic_markup::reject_if_contains_markup(content, "content")?;

    if !file_path.ends_with(".md") {
        return Err("file_path must end with one of: .md, .html, .json".to_string());
    }
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let content = super::critic_markup::stamp_new_comments("", content, &author, timestamp);
    let content = content.as_str();

    let md_content = if content.is_empty() { "_" } else { content };

    // Split at first '/' into folder name + in-folder path
    let slash_pos = file_path
        .find('/')
        .ok_or_else(|| "file_path must include a folder name (e.g. 'Lens/Doc.md')".to_string())?;

    let folder_name = &file_path[..slash_pos];
    let in_folder_path = format!("/{}", &file_path[slash_pos + 1..]);

    let _result = server
        .create_document(folder_name, &in_folder_path, md_content, Some(&attribution))
        .await
        .map_err(|e| e.to_string())?;

    Ok(format!("Created {}", file_path))
}

async fn create_html_file(
    server: &Arc<Server>,
    file_path: &str,
    content: &str,
    attribution: &crate::mcp::provenance::AiAttribution,
) -> Result<String, String> {
    let slash_pos = file_path
        .find('/')
        .ok_or_else(|| "file_path must include a folder name".to_string())?;
    let folder_name = &file_path[..slash_pos];
    let in_folder_path = format!("/{}", &file_path[slash_pos + 1..]);

    server
        .create_document_direct(folder_name, &in_folder_path, content, Some(attribution))
        .await
        .map_err(|e| e.to_string())?;

    Ok(format!("Created {}", file_path))
}

async fn create_blob_file(
    server: &Arc<Server>,
    file_path: &str,
    content: &str,
) -> Result<String, String> {
    let slash_pos = file_path
        .find('/')
        .ok_or_else(|| "file_path must include a folder name".to_string())?;
    let folder_name = &file_path[..slash_pos];
    let in_folder_path = format!("/{}", &file_path[slash_pos + 1..]);

    server
        .create_blob_file(
            folder_name,
            &in_folder_path,
            content.as_bytes(),
            "application/json",
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(format!("Created {}", file_path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tools::blob;
    use crate::mcp::tools::test_helpers::*;
    use serde_json::json;

    #[tokio::test]
    async fn create_json_stores_blob() {
        let server = build_blob_test_server_with_folder().await;
        let sid = setup_session_no_reads(&server);
        let result = execute(
            &server,
            &sid,
            &json!({
                "file_path": "Lens/data.json",
                "content": r#"{"hello": "world"}"#,
            }),
        )
        .await;
        assert!(result.is_ok(), "Create should succeed: {:?}", result.err());
        assert!(result.unwrap().contains("Created Lens/data.json"));
        // Verify hash exists in resolver
        let hash = server.doc_resolver().get_file_hash("Lens/data.json");
        assert!(hash.is_some(), "Should have hash in resolver");
    }

    // create_blob_file now takes a mimetype (image/* → "image" type) so the
    // add-article importer can host extracted PDF figures as attachments.
    #[tokio::test]
    async fn create_blob_file_accepts_image_mimetype() {
        let server = build_blob_test_server_with_folder().await;
        server
            .create_blob_file("Lens", "/attachments/fig.png", &[1u8, 2, 3, 4], "image/png")
            .await
            .expect("image blob should be created");
        assert!(
            server
                .doc_resolver()
                .get_file_hash("Lens/attachments/fig.png")
                .is_some(),
            "image attachment should be registered with a hash"
        );
    }

    #[tokio::test]
    async fn create_json_no_criticmarkup() {
        let server = build_blob_test_server_with_folder().await;
        let sid = setup_session_no_reads(&server);
        execute(
            &server,
            &sid,
            &json!({
                "file_path": "Lens/test.json",
                "content": r#"{"key": "value"}"#,
            }),
        )
        .await
        .unwrap();
        let hash = server
            .doc_resolver()
            .get_file_hash("Lens/test.json")
            .unwrap();
        let doc_info = server
            .doc_resolver()
            .resolve_path("Lens/test.json")
            .unwrap();
        let data = blob::read_blob(&server, &doc_info.doc_id, &hash)
            .await
            .unwrap();
        let content = String::from_utf8(data).unwrap();
        assert_eq!(content, r#"{"key": "value"}"#);
        assert!(!content.contains("{++"), "Should not contain CriticMarkup");
    }

    #[tokio::test]
    async fn create_md_still_works() {
        let server = build_blob_test_server_with_folder().await;
        let sid = setup_session_no_reads(&server);
        let result = execute(
            &server,
            &sid,
            &json!({
                "file_path": "Lens/Doc.md",
                "content": "Hello world",
            }),
        )
        .await;
        assert!(
            result.is_ok(),
            "MD create should succeed: {:?}",
            result.err()
        );
    }

    #[tokio::test]
    async fn create_rejects_new_lens_edu_articles_with_workflow_guidance() {
        let server = build_blob_test_server_with_folder().await;
        let sid = setup_session_no_reads(&server);
        for path in [
            "Lens Edu/articles/manual.md",
            "Lens Edu//articles/manual.md",
            "Lens Edu/drafts/../articles/manual.md",
            "Lens Edu\\articles\\manual.md",
        ] {
            let error = execute(
                &server,
                &sid,
                &json!({ "file_path": path, "content": "Manual article" }),
            )
            .await
            .expect_err("generic article creation must be blocked");
            assert!(error.contains("import_article"));
            assert!(error.contains("explicit permission"));
            assert!(error.contains("Elias and Luc"));
        }
    }

    #[tokio::test]
    async fn create_md_uses_named_session_for_review_and_provenance() {
        use yrs::{Map, Out, ReadTxn, Transact};

        let server = build_blob_test_server_with_folder().await;
        let sid =
            server
                .mcp_sessions
                .create_session(default_access(), Some("Luc"), Some("fable-5"));
        let (ai_client_id, ai_actor) = {
            let session = server.mcp_sessions.get_session(&sid).unwrap();
            (session.ai_client_id, session.ai_actor.clone())
        };

        execute(
            &server,
            &sid,
            &json!({
                "file_path": "Lens/Named.md",
                "content": "Hello world",
            }),
        )
        .await
        .expect("named-session create should succeed");

        let doc_info = server
            .doc_resolver()
            .resolve_path("Lens/Named.md")
            .expect("created path should resolve");
        let raw = read_doc_content(&server, &doc_info.doc_id);
        assert_eq!(
            raw, "Hello world",
            "creation is a direct edit: content stored plain, not wrapped as a pending suggestion"
        );

        let content_doc = server
            .docs()
            .get(&doc_info.doc_id)
            .expect("content doc should be loaded");
        let awareness = content_doc.awareness();
        let guard = awareness.read().unwrap();
        let txn = guard.doc.transact();
        assert!(
            txn.state_vector().get(&ai_client_id) > 0,
            "created text should be minted under the session AI client ID"
        );
        let users = txn.get_map("users").expect("users map should exist");
        assert!(
            matches!(users.get(&txn, &ai_actor), Some(Out::YMap(_))),
            "session actor should be registered in provenance"
        );

        // The creation is logged as a direct-edit activity event so it shows
        // up on the /recent review page.
        let events = y_sweet_core::activity::read_events(&txn);
        assert_eq!(events.len(), 1, "creation should record one activity event");
        let event = &events[0];
        assert_eq!(event.author, "Luc's AI");
        assert_eq!(event.actor, ai_actor);
        assert_eq!(event.mode, "direct");
        assert_eq!(event.kind, "insert");
        assert_eq!(event.new, "Hello world");
        assert_eq!(event.pos, 0);
        assert_eq!(event.client, ai_client_id);
    }

    #[tokio::test]
    async fn create_html_uses_direct_path() {
        use y_sweet_core::link_indexer::extract_type_from_filemeta_entry;
        use yrs::{GetString, Map, ReadTxn, Transact};

        let server = build_blob_test_server_with_folder().await;
        let sid = setup_session_no_reads(&server);
        let result = execute(
            &server,
            &sid,
            &json!({
                "file_path": "Lens/page.html",
                "content": "<h1>Hello</h1>",
            }),
        )
        .await;

        assert!(
            result.is_ok(),
            "HTML create should succeed: {:?}",
            result.err()
        );
        assert!(result.unwrap().contains("Created Lens/page.html"));

        let doc_info = server
            .doc_resolver()
            .resolve_path("Lens/page.html")
            .expect("path should resolve");
        assert_eq!(doc_info.hash, None, "HTML should not be stored as a blob");

        let content_doc = server
            .docs()
            .get(&doc_info.doc_id)
            .expect("content doc should be loaded");
        let awareness = content_doc.awareness();
        let guard = awareness.read().unwrap();
        let txn = guard.doc.transact();
        let text = txn
            .get_text("contents")
            .expect("contents text should exist");
        assert_eq!(text.get_string(&txn), "<h1>Hello</h1>");

        let folder_doc = server
            .docs()
            .get(&doc_info.folder_doc_id)
            .expect("folder doc should be loaded");
        let awareness = folder_doc.awareness();
        let guard = awareness.read().unwrap();
        let txn = guard.doc.transact();
        let filemeta = txn
            .get_map("filemeta_v0")
            .expect("filemeta_v0 should exist");
        let entry = filemeta
            .get(&txn, "/page.html")
            .expect("HTML filemeta entry should exist");
        let entry_type = extract_type_from_filemeta_entry(&entry, &txn);
        assert_eq!(entry_type.as_deref(), Some("file"));
    }

    #[tokio::test]
    async fn create_unsupported_extension_rejected() {
        let server = build_blob_test_server_with_folder().await;
        let sid = setup_session_no_reads(&server);
        let result = execute(
            &server,
            &sid,
            &json!({
                "file_path": "Lens/page.xyz",
                "content": "Hello world",
            }),
        )
        .await;

        let error = result.expect_err("unsupported extension should be rejected");
        assert!(
            error.contains(".html"),
            "error should mention .html: {error}"
        );
        assert!(error.contains(".md"), "error should mention .md: {error}");
    }
}
