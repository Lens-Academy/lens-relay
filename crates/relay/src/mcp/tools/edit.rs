use crate::server::Server;
use serde_json::Value;
use std::sync::Arc;
use yrs::{GetString, ReadTxn, Text, Transact, WriteTxn};

/// Execute the `edit` tool: replace old_string with CriticMarkup-wrapped suggestion.
///
/// The edit is wrapped in CriticMarkup format `{--old--}{++new++}` so human
/// collaborators can review and accept/reject the AI's proposed change.
pub async fn execute(
    server: &Arc<Server>,
    session_id: &str,
    arguments: &Value,
) -> Result<String, String> {
    // 1. Parse parameters
    let file_path = arguments
        .get("file_path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter: file_path".to_string())?;

    let old_string = arguments
        .get("old_string")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter: old_string".to_string())?;

    let new_string = arguments
        .get("new_string")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter: new_string".to_string())?;

    // 2. Resolve document path to doc_id
    let doc_info = server
        .doc_resolver()
        .resolve_path(file_path)
        .ok_or_else(|| format!("Error: Document not found: {}", file_path))?;

    // 3. Check read-before-edit: session must have read this document first
    {
        let session = server
            .mcp_sessions
            .get_session(session_id)
            .ok_or_else(|| "Error: Session not found".to_string())?;
        if !session.read_docs.contains(&doc_info.doc_id) {
            return Err(format!(
                "You must read this document before editing it. Call the read tool with file_path: \"{}\" first.",
                file_path
            ));
        }
        // Drop session guard before accessing Y.Doc
    }

    // 4. Reload from storage if GC evicted the doc
    server
        .ensure_doc_loaded(&doc_info.doc_id)
        .await
        .map_err(|e| format!("Error: Failed to load document {}: {}", file_path, e))?;

    // 5. Read content and find old_string
    let content = {
        let doc_ref = server
            .docs()
            .get(&doc_info.doc_id)
            .ok_or_else(|| format!("Error: Document data not loaded: {}", file_path))?;
        let awareness = doc_ref.awareness();
        let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
        let txn = guard.doc.transact();
        match txn.get_text("contents") {
            Some(text) => text.get_string(&txn),
            None => return Err("Document has no content".to_string()),
        }
    };

    // 5. Find old_string and check uniqueness
    let matches: Vec<usize> = content
        .match_indices(old_string)
        .map(|(idx, _)| idx)
        .collect();

    if matches.is_empty() {
        return Err(format!(
            "Error: old_string not found in {}. Make sure it matches exactly.",
            file_path
        ));
    }

    if matches.len() > 1 {
        return Err(format!(
            "Error: old_string is not unique in {} ({} occurrences found). Include more surrounding context to make it unique.",
            file_path,
            matches.len()
        ));
    }

    // 6. Build CriticMarkup replacement with metadata
    let byte_offset = matches[0] as u32;
    let old_len = old_string.len() as u32;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let meta_prefix = format!(r#"{{"author":"AI","timestamp":{}}}@@"#, timestamp);
    let replacement =
        super::critic_diff::smart_critic_markup(old_string, new_string, Some(&meta_prefix));

    // 7. Apply edit in write transaction with TOCTOU re-verify
    {
        let doc_ref = server
            .docs()
            .get(&doc_info.doc_id)
            .ok_or_else(|| format!("Error: Document data not loaded: {}", file_path))?;
        let awareness = doc_ref.awareness();
        let mut guard = awareness.write().unwrap_or_else(|e| e.into_inner());
        let mut txn = guard.doc.transact_mut();
        let text = txn.get_or_insert_text("contents");

        // Re-verify: check old_string still at expected offset
        let current_content = text.get_string(&txn);
        let actual_slice =
            current_content.get(byte_offset as usize..(byte_offset + old_len) as usize);
        if actual_slice != Some(old_string) {
            return Err(
                "Document changed since last read. Please re-read and try again.".to_string(),
            );
        }

        text.remove_range(&mut txn, byte_offset, old_len);
        text.insert(&mut txn, byte_offset, &replacement);
    }

    // 8. Return success
    Ok(format!(
        "Edited {}: replaced {} characters with CriticMarkup suggestion for human review.",
        file_path,
        old_string.len()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::test_helpers::*;
    use serde_json::json;

    // === Edit Tests ===

    #[tokio::test]
    async fn edit_basic_replacement() {
        let server = build_test_server(&[("/Hello.md", "uuid-hello", "say hello to all")]).await;
        let doc_id = format!("{}-{}", RELAY_ID, "uuid-hello");
        let sid = setup_session_with_read(&server, &doc_id);

        let result = execute(
            &server,
            &sid,
            &json!({"file_path": "Lens/Hello.md", "old_string": "hello", "new_string": "world"}),
        )
        .await;

        assert!(result.is_ok(), "edit should succeed, got: {:?}", result);

        // Verify the Y.Doc content was actually modified with CriticMarkup + metadata
        let content = read_doc_content(&server, &doc_id);
        // Metadata is dynamic (timestamp), so check structure not exact string
        assert!(
            content.contains("{--") && content.contains("--}"),
            "Should contain deletion markup: {}",
            content
        );
        assert!(
            content.contains("{++") && content.contains("++}"),
            "Should contain insertion markup: {}",
            content
        );
        assert!(
            content.contains(r#""author":"AI""#),
            "Should contain author metadata: {}",
            content
        );
        assert!(
            content.contains("@@hello--}"),
            "Deletion should contain old text after @@: {}",
            content
        );
        assert!(
            content.contains("@@world++}"),
            "Insertion should contain new text after @@: {}",
            content
        );
        assert!(
            content.starts_with("say ") && content.ends_with(" to all"),
            "Surrounding text should be preserved: {}",
            content
        );
    }

    #[tokio::test]
    async fn edit_read_before_edit_enforced() {
        let server = build_test_server(&[("/Doc.md", "uuid-doc", "some content")]).await;
        // Session WITHOUT the doc in read_docs
        let sid = setup_session_no_reads(&server);

        let result = execute(
            &server,
            &sid,
            &json!({"file_path": "Lens/Doc.md", "old_string": "some", "new_string": "any"}),
        )
        .await;

        assert!(result.is_err(), "should reject edit on unread doc");
        let err = result.unwrap_err();
        assert!(
            err.to_lowercase().contains("must read") || err.to_lowercase().contains("read"),
            "Error should mention reading first: {}",
            err
        );
    }

    #[tokio::test]
    async fn edit_old_string_not_found() {
        let server = build_test_server(&[("/Doc.md", "uuid-doc", "actual content here")]).await;
        let doc_id = format!("{}-{}", RELAY_ID, "uuid-doc");
        let sid = setup_session_with_read(&server, &doc_id);

        let result = execute(
            &server,
            &sid,
            &json!({"file_path": "Lens/Doc.md", "old_string": "nonexistent", "new_string": "replacement"}),
        )
        .await;

        assert!(result.is_err(), "should reject when old_string not found");
        let err = result.unwrap_err();
        assert!(
            err.to_lowercase().contains("not found"),
            "Error should mention 'not found': {}",
            err
        );
    }

    #[tokio::test]
    async fn edit_old_string_not_unique() {
        let server = build_test_server(&[("/Cats.md", "uuid-cats", "the cat sat on the cat")]).await;
        let doc_id = format!("{}-{}", RELAY_ID, "uuid-cats");
        let sid = setup_session_with_read(&server, &doc_id);

        let result = execute(
            &server,
            &sid,
            &json!({"file_path": "Lens/Cats.md", "old_string": "the cat", "new_string": "a dog"}),
        )
        .await;

        assert!(
            result.is_err(),
            "should reject when old_string is not unique"
        );
        let err = result.unwrap_err();
        assert!(
            err.to_lowercase().contains("not unique") || err.contains("2"),
            "Error should mention not unique or count 2: {}",
            err
        );
    }

    #[tokio::test]
    async fn edit_document_not_found() {
        let server = build_test_server(&[]).await;
        let sid = setup_session_no_reads(&server);

        let result = execute(
            &server,
            &sid,
            &json!({"file_path": "Nonexistent/Doc.md", "old_string": "hello", "new_string": "world"}),
        )
        .await;

        assert!(result.is_err(), "should reject when document not found");
        let err = result.unwrap_err();
        assert!(
            err.contains("not found") || err.contains("Not found"),
            "Error should mention document not found: {}",
            err
        );
    }

    #[tokio::test]
    async fn edit_missing_parameters() {
        let server = build_test_server(&[("/Doc.md", "uuid-doc", "content")]).await;
        let doc_id = format!("{}-{}", RELAY_ID, "uuid-doc");
        let sid = setup_session_with_read(&server, &doc_id);

        // Missing old_string
        let result = execute(
            &server,
            &sid,
            &json!({"file_path": "Lens/Doc.md", "new_string": "world"}),
        )
        .await;
        assert!(result.is_err(), "missing old_string should error");
        assert!(
            result.unwrap_err().contains("old_string"),
            "Error should mention old_string"
        );

        // Missing new_string
        let result = execute(
            &server,
            &sid,
            &json!({"file_path": "Lens/Doc.md", "old_string": "content"}),
        )
        .await;
        assert!(result.is_err(), "missing new_string should error");
        assert!(
            result.unwrap_err().contains("new_string"),
            "Error should mention new_string"
        );

        // Missing file_path
        let result = execute(
            &server,
            &sid,
            &json!({"old_string": "content", "new_string": "replacement"}),
        )
        .await;
        assert!(result.is_err(), "missing file_path should error");
        assert!(
            result.unwrap_err().contains("file_path"),
            "Error should mention file_path"
        );
    }

    #[tokio::test]
    async fn edit_preserves_surrounding_content() {
        let server = build_test_server(&[("/Lines.md", "uuid-lines", "line 1\nline 2\nline 3")]).await;
        let doc_id = format!("{}-{}", RELAY_ID, "uuid-lines");
        let sid = setup_session_with_read(&server, &doc_id);

        let result = execute(
            &server,
            &sid,
            &json!({"file_path": "Lens/Lines.md", "old_string": "line 2", "new_string": "modified line 2"}),
        )
        .await;

        assert!(result.is_ok(), "edit should succeed, got: {:?}", result);

        let content = read_doc_content(&server, &doc_id);
        assert!(
            content.starts_with("line 1\n{++"),
            "Should start with line 1 then insertion markup: {}",
            content
        );
        assert!(
            content.contains("@@modified "),
            "Insertion should contain 'modified ' after @@: {}",
            content
        );
        assert!(
            content.ends_with("line 2\nline 3"),
            "Should preserve surrounding content: {}",
            content
        );
    }

    #[tokio::test]
    async fn edit_multiline_old_string() {
        let server =
            build_test_server(&[("/Multi.md", "uuid-multi", "line 1\nline 2\nline 3\nline 4")]).await;
        let doc_id = format!("{}-{}", RELAY_ID, "uuid-multi");
        let sid = setup_session_with_read(&server, &doc_id);

        let result = execute(
            &server,
            &sid,
            &json!({"file_path": "Lens/Multi.md", "old_string": "line 2\nline 3", "new_string": "replaced lines"}),
        )
        .await;

        assert!(
            result.is_ok(),
            "multiline edit should succeed, got: {:?}",
            result
        );

        let content = read_doc_content(&server, &doc_id);
        assert!(
            content.starts_with("line 1\n{--"),
            "Should start with line 1 then deletion markup: {}",
            content
        );
        assert!(
            content.contains("@@line 2\nline 3--}"),
            "Deletion should wrap multiline old text: {}",
            content
        );
        assert!(
            content.contains("@@replaced lines++}"),
            "Insertion should contain new text: {}",
            content
        );
        assert!(
            content.ends_with("\nline 4"),
            "Should preserve trailing content: {}",
            content
        );
    }

    #[tokio::test]
    async fn edit_empty_new_string() {
        let server = build_test_server(&[("/Del.md", "uuid-del", "keep delete me keep")]).await;
        let doc_id = format!("{}-{}", RELAY_ID, "uuid-del");
        let sid = setup_session_with_read(&server, &doc_id);

        let result = execute(
            &server,
            &sid,
            &json!({"file_path": "Lens/Del.md", "old_string": "delete me", "new_string": ""}),
        )
        .await;

        assert!(
            result.is_ok(),
            "deletion edit should succeed, got: {:?}",
            result
        );

        let content = read_doc_content(&server, &doc_id);
        assert!(
            content.starts_with("keep {--") && content.ends_with("--} keep"),
            "Should wrap deletion with surrounding text preserved: {}",
            content
        );
        assert!(
            content.contains("@@delete me--}"),
            "Deletion should contain old text after @@: {}",
            content
        );
        assert!(
            !content.contains("{++"),
            "Pure deletion should not have insertion markup: {}",
            content
        );
    }

    #[tokio::test]
    async fn edit_success_message() {
        let server = build_test_server(&[("/Msg.md", "uuid-msg", "hello world")]).await;
        let doc_id = format!("{}-{}", RELAY_ID, "uuid-msg");
        let sid = setup_session_with_read(&server, &doc_id);

        let result = execute(
            &server,
            &sid,
            &json!({"file_path": "Lens/Msg.md", "old_string": "hello", "new_string": "goodbye"}),
        )
        .await;

        assert!(result.is_ok(), "edit should succeed");
        let msg = result.unwrap();
        assert!(
            msg.contains("Lens/Msg.md"),
            "Success message should mention file_path: {}",
            msg
        );
        assert!(
            msg.to_lowercase().contains("criticmarkup") || msg.to_lowercase().contains("critic"),
            "Success message should mention CriticMarkup: {}",
            msg
        );
    }
}
