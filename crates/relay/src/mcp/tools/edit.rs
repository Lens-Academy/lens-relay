use crate::server::Server;
use serde_json::Value;
use std::sync::Arc;
use yrs::{GetString, ReadTxn, Text, Transact};

use super::blob;
use super::critic_markup;
use super::edit_policy::{self, SuggestReason};
use y_sweet_core::activity::{self, ActivityEvent};

/// Requested edit mode. `Auto` lets the server decide (direct when safe,
/// suggestion otherwise); `Suggest` always produces a pending suggestion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EditMode {
    Auto,
    Suggest,
}

enum EditOutcome {
    /// Applied directly; `deleted`/`inserted` are the char counts over the
    /// minimal hunks (the event's old/new span the coalesced range, which
    /// can include unchanged text between two insertions).
    Direct {
        event: Box<ActivityEvent>,
        deleted: usize,
        inserted: usize,
    },
    Suggested(SuggestReason),
}

/// Normalize typographic/smart quotes to ASCII equivalents.
/// Handles: curly double quotes (\u{201C}, \u{201D}) → "
///          curly single quotes (\u{201A}, \u{2019}) → '
fn normalize_quotes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '\u{201C}' | '\u{201D}' => out.push('"'),
            '\u{2018}' | '\u{2019}' => out.push('\''),
            _ => out.push(ch),
        }
    }
    out
}

/// Map a byte offset in a quote-normalized string back to the byte offset in
/// the original (un-normalized) string. Both strings have the same char count
/// but different byte lengths when smart quotes are present.
fn map_norm_offset_to_original(original: &str, norm_offset: usize) -> usize {
    let mut orig_bytes = 0usize;
    let mut norm_bytes = 0usize;
    for ch in original.chars() {
        if norm_bytes >= norm_offset {
            break;
        }
        orig_bytes += ch.len_utf8();
        let norm_ch = match ch {
            '\u{201C}' | '\u{201D}' => '"',
            '\u{2018}' | '\u{2019}' => '\'',
            _ => ch,
        };
        norm_bytes += norm_ch.len_utf8();
    }
    orig_bytes
}

/// Find `old_string` in `accepted` with exact match, falling back to
/// quote-normalized matching if no exact match exists.
///
/// Returns `(match_byte_offset_in_accepted, effective_old_string)` where
/// `effective_old_string` is the actual text from `accepted` (preserving
/// smart quotes) that the AI's `old_string` matched against.
fn find_old_string_in_accepted<'a>(
    accepted: &'a str,
    old_string: &str,
    file_path: &str,
) -> Result<(usize, String), String> {
    // Try exact match first
    let exact: Vec<usize> = accepted.match_indices(old_string).map(|(i, _)| i).collect();

    match exact.len() {
        1 => return Ok((exact[0], old_string.to_string())),
        n if n > 1 => {
            return Err(format!(
                "Error: old_string is not unique in {} ({} occurrences found). \
                 Include more surrounding context to make it unique.",
                file_path, n
            ));
        }
        _ => {} // 0 matches — fall through to normalized matching
    }

    // Fallback: normalize smart quotes → straight quotes in both strings
    let norm_accepted = normalize_quotes(accepted);
    let norm_old = normalize_quotes(old_string);

    // If normalization didn't change anything, no point re-matching
    if norm_accepted == *accepted {
        return Err(format!(
            "Error: old_string not found in {}. Make sure it matches exactly.",
            file_path
        ));
    }

    let norm_matches: Vec<usize> = norm_accepted
        .match_indices(&norm_old)
        .map(|(i, _)| i)
        .collect();

    match norm_matches.len() {
        0 => Err(format!(
            "Error: old_string not found in {}. Make sure it matches exactly.",
            file_path
        )),
        1 => {
            // Map normalized byte offsets back to original accepted string
            let orig_start = map_norm_offset_to_original(accepted, norm_matches[0]);
            let orig_end = map_norm_offset_to_original(accepted, norm_matches[0] + norm_old.len());
            let actual_text = accepted[orig_start..orig_end].to_string();
            Ok((orig_start, actual_text))
        }
        n => Err(format!(
            "Error: old_string is not unique in {} ({} occurrences found). \
             Include more surrounding context to make it unique.",
            file_path, n
        )),
    }
}

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

    let mode = match arguments.get("mode").and_then(|v| v.as_str()) {
        None | Some("auto") => EditMode::Auto,
        Some("suggest") => EditMode::Suggest,
        Some(other) => {
            return Err(format!(
                "Error: Invalid mode '{}': expected 'auto' or 'suggest'",
                other
            ))
        }
    };

    // 2. Resolve document path to doc_id
    let doc_info = server
        .doc_resolver()
        .resolve_path(file_path)
        .ok_or_else(|| format!("Error: Document not found: {}", file_path))?;

    let raw_ytext_file = blob::is_raw_ytext_file(file_path);

    if !raw_ytext_file {
        // Reject if AI included CriticMarkup suggestion syntax in markdown input.
        // Comment delimiters {>> <<} are allowed — AI can read and write comments.
        super::critic_markup::reject_if_contains_markup(old_string, "old_string")?;
        super::critic_markup::reject_if_contains_markup(new_string, "new_string")?;

        // Validate comment preservation: non-AI comments must be kept intact.
        super::critic_markup::validate_comment_preservation(old_string, new_string)?;
    }

    // 3. Check read-before-edit: session must have read this document first
    let (author, ai_client_id, ai_actor) = {
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
        (
            session.author_name.clone(),
            session.ai_client_id,
            session.ai_actor.clone(),
        )
        // Drop session guard before accessing Y.Doc
    };

    // Blob edit path (e.g. .json) — direct text replacement, no CriticMarkup
    if blob::is_blob_file(file_path) {
        return edit_blob_file(server, &doc_info, file_path, old_string, new_string).await;
    }

    if raw_ytext_file {
        return edit_raw_ytext_file(
            server,
            &doc_info,
            file_path,
            old_string,
            new_string,
            ai_client_id,
            &ai_actor,
        )
        .await;
    }

    // 4. Reload from storage if GC evicted the doc
    server
        .ensure_doc_loaded(&doc_info.doc_id)
        .await
        .map_err(|e| format!("Error: Failed to load document {}: {}", file_path, e))?;

    // 6. Read content and find old_string (with smart-quote normalization fallback)
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

    let raw_content = content;
    let spans = critic_markup::parse(&raw_content);
    let accepted = critic_markup::accepted_view(&spans);

    // Find old_string with quote-normalization fallback. effective_old is the
    // actual text from the document (may contain smart quotes even though the
    // AI sent straight quotes).
    let (match_start, effective_old) =
        find_old_string_in_accepted(&accepted, old_string, file_path)?;

    // 7. Build merged result (targeted replacement)
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    // Attribute any comment the AI adds or edits to the session's author label.
    // Comments preserved unchanged from old_string are left byte-identical.
    let new_string = critic_markup::stamp_new_comments(old_string, new_string, &author, timestamp);

    // Minimal diff: what actually changes. Unchanged context never counts.
    let hunks = edit_policy::minimal_hunks(&effective_old, &new_string);
    if hunks.is_empty() {
        return Ok(format!("No changes needed for {}", file_path));
    }

    // Validate the suggestion path up front so a malformed edit fails before
    // the lock is taken (the merge is recomputed under the lock).
    critic_markup::merge_edit(
        &raw_content,
        &effective_old,
        &new_string,
        &author,
        timestamp,
    )
    .map_err(|e| format!("Error: {}", e))?;

    // 8. Decide direct vs. suggestion and apply under the write lock with
    // TOCTOU re-verify. The policy check and the mutation run in the same
    // scratch transaction (apply_attributed_edit), so inserted items are
    // minted under the session's AI clientID and, for direct edits, the
    // activity event persists together with the text change.
    let doc_uuid = y_sweet_core::link_indexer::parse_doc_id(&doc_info.doc_id)
        .map(|(_, uuid)| uuid.to_string());
    // Clone the Awareness Arc out and drop the DashMap shard ref before
    // taking the awareness lock (never hold a `docs.get()` ref across a
    // blocking lock — see AGENTS.md "Known Issues").
    let awareness = server
        .docs()
        .get(&doc_info.doc_id)
        .map(|doc_ref| doc_ref.awareness())
        .ok_or_else(|| format!("Error: Document data not loaded: {}", file_path))?;
    let outcome = {
        let guard = awareness.write().unwrap_or_else(|e| e.into_inner());

        // Re-verify: re-parse under lock, check accepted view still matches
        let (current_raw, current_spans, current_accepted) = {
            let txn = guard.doc.transact();
            let text = match txn.get_text("contents") {
                Some(t) => t,
                None => return Err("Document has no content".to_string()),
            };
            let current_raw = text.get_string(&txn);
            let current_spans = critic_markup::parse(&current_raw);
            let current_accepted = critic_markup::accepted_view(&current_spans);
            let actual = current_accepted.get(match_start..match_start + effective_old.len());
            if actual != Some(&effective_old) {
                return Err(
                    "Document changed since last read. Please re-read and try again.".to_string(),
                );
            }
            (current_raw, current_spans, current_accepted)
        };

        // Recompute merge against current raw (in case of concurrent changes)
        let final_merge = critic_markup::merge_edit(
            &current_raw,
            &effective_old,
            &new_string,
            &author,
            timestamp,
        )
        .map_err(|e| format!("Error: {}", e))?;

        let structural = match mode {
            EditMode::Suggest => Err(SuggestReason::Requested),
            EditMode::Auto => edit_policy::map_hunks(&edit_policy::PolicyInput {
                raw: &current_raw,
                spans: &current_spans,
                accepted: &current_accepted,
                match_start,
                new_string: &new_string,
                hunks: &hunks,
            }),
        };

        let outcome = crate::mcp::provenance::apply_attributed_edit(
            &guard.doc,
            ai_client_id,
            &ai_actor,
            timestamp,
            |txn, text| {
                let decision = structural.and_then(|raw_hunks| {
                    let runs = crate::mcp::provenance::visible_runs(txn, text);
                    let actors = crate::mcp::provenance::client_actor_map(txn);
                    edit_policy::check_provenance(&raw_hunks, runs.as_deref(), &actors)
                        .map(|_| raw_hunks)
                });
                match decision {
                    Ok(raw_hunks) => {
                        let clock_from = txn.state_vector().get(&ai_client_id);
                        // Back to front so earlier raw offsets stay valid.
                        for h in raw_hunks.iter().rev() {
                            if h.raw_len > 0 {
                                text.remove_range(txn, h.raw_from as u32, h.raw_len as u32);
                            }
                            if !h.new_text.is_empty() {
                                text.insert(txn, h.raw_from as u32, &h.new_text);
                            }
                        }
                        let clock_to = txn.state_vector().get(&ai_client_id);
                        let anchor_at = raw_hunks.first().map(|h| h.raw_from).unwrap_or(0);
                        let anchor = crate::mcp::provenance::sticky_anchor(txn, text, anchor_at);

                        let summary = edit_policy::coalesce(&hunks)
                            .ok_or_else(|| "internal: empty hunks".to_string())?;
                        let old_text = &effective_old[summary.old_from..summary.old_to];
                        let new_text = &new_string[summary.new_from..summary.new_to];
                        let pos = match_start + summary.old_from;
                        let (ctx_before, ctx_after) =
                            event_context(&current_accepted, pos, match_start + summary.old_to);
                        let (old, old_truncated) = activity::cap_text(old_text);
                        let (new, new_truncated) = activity::cap_text(new_text);
                        let event = ActivityEvent {
                            id: ActivityEvent::event_id(timestamp, ai_client_id, clock_from),
                            ts: timestamp,
                            actor: ai_actor.clone(),
                            author: author.clone(),
                            mode: "direct".to_string(),
                            kind: ActivityEvent::kind_for(old_text, new_text).to_string(),
                            old,
                            new,
                            old_truncated,
                            new_truncated,
                            ctx_before,
                            ctx_after,
                            pos,
                            client: ai_client_id,
                            clock_from,
                            clock_to,
                            anchor,
                        };
                        let mut event = event;
                        event.id = activity::append_event(txn, &event, timestamp);
                        let deleted = hunks
                            .iter()
                            .map(|h| effective_old[h.old_from..h.old_to].chars().count())
                            .sum();
                        let inserted = hunks
                            .iter()
                            .map(|h| new_string[h.new_from..h.new_to].chars().count())
                            .sum();
                        Ok(EditOutcome::Direct {
                            event: Box::new(event),
                            deleted,
                            inserted,
                        })
                    }
                    Err(reason) => {
                        // Apply the merged replacement as minimal exact hunks
                        // rather than replacing the whole matched span:
                        // unchanged characters (human context, earlier AI
                        // text) keep their original items and therefore their
                        // provenance. Re-minting them under the AI client
                        // would later let the AI edit human text directly.
                        let span_end = final_merge.raw_offset + final_merge.raw_len;
                        let old_span = &current_raw[final_merge.raw_offset..span_end];
                        let hunks = edit_policy::minimal_hunks_exact_masked(
                            old_span,
                            &final_merge.replacement,
                            &final_merge.unmatchable,
                        );
                        for h in hunks.iter().rev() {
                            let at = (final_merge.raw_offset + h.old_from) as u32;
                            if h.old_to > h.old_from {
                                text.remove_range(txn, at, (h.old_to - h.old_from) as u32);
                            }
                            let ins = &final_merge.replacement[h.new_from..h.new_to];
                            if !ins.is_empty() {
                                text.insert(txn, at, ins);
                            }
                        }
                        Ok(EditOutcome::Suggested(reason))
                    }
                }
            },
        )
        .map_err(|e| format!("Error: {}", e))?;

        // Write-through under the same write lock as the edit, so the index
        // can never be overwritten by a worker scan of an older body.
        if let (EditOutcome::Direct { event, .. }, Some(uuid)) = (&outcome, &doc_uuid) {
            server
                .recent_changes_index()
                .push(uuid, (**event).clone(), None);
        }
        outcome
    };

    // Excerpts for the recent-changes page, from the post-edit state. Built
    // under a *read* guard so WebSocket traffic for the doc isn't blocked by
    // the (O(doc)) provenance walk; the index write happens while the guard
    // is still held, the same rule the search worker follows, so two
    // back-to-back edits can't land their excerpts out of order.
    if let (EditOutcome::Direct { .. }, Some(uuid)) = (&outcome, &doc_uuid) {
        let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
        let excerpts = {
            let txn = guard.doc.transact();
            let raw = txn
                .get_text("contents")
                .map(|t| t.get_string(&txn))
                .unwrap_or_default();
            let events = activity::read_events(&txn);
            let runs = crate::mcp::provenance::visible_runs_copy(&txn);
            crate::recent_excerpts::build_excerpts(&txn, &raw, runs.as_deref(), &events)
        };
        server.recent_changes_index().set_excerpts(uuid, excerpts);
    }

    // 9. Explicit persist for immediate durability
    {
        let doc_ref = server
            .docs()
            .get(&doc_info.doc_id)
            .ok_or_else(|| format!("Error: Document data not loaded: {}", file_path))?;
        if let Err(e) = doc_ref.sync_kv().persist().await {
            tracing::error!("Failed to persist edit for {}: {:?}", doc_info.doc_id, e);
        }
    }

    // 10. Return success
    Ok(match outcome {
        EditOutcome::Direct {
            deleted, inserted, ..
        } => format!(
            "Made the changes to {} ({}).",
            file_path,
            match (deleted, inserted) {
                (0, n) => format!("inserted {} characters", n),
                (n, 0) => format!("removed {} characters", n),
                (d, i) => format!("replaced {} characters with {}", d, i),
            }
        ),
        EditOutcome::Suggested(SuggestReason::Requested) => format!(
            "Made pending changes to {} as requested (replaced {} characters).",
            file_path,
            effective_old.chars().count()
        ),
        EditOutcome::Suggested(reason) => format!(
            "Made pending changes to {} because {} (replaced {} characters). The user can accept them in the editor.",
            file_path,
            reason.describe(),
            effective_old.chars().count()
        ),
    })
}

/// Up to `CONTEXT_CHARS` chars of accepted-view text on either side of
/// `[from, to)`.
fn event_context(accepted: &str, from: usize, to: usize) -> (String, String) {
    const CONTEXT_CHARS: usize = 40;
    let before: String = accepted[..from]
        .chars()
        .rev()
        .take(CONTEXT_CHARS)
        .collect::<Vec<char>>()
        .into_iter()
        .rev()
        .collect();
    let after: String = accepted[to..].chars().take(CONTEXT_CHARS).collect();
    (before, after)
}

/// Edit a raw Y.Text file (e.g. .html) by direct text replacement — no CriticMarkup wrapping.
#[allow(clippy::too_many_arguments)]
async fn edit_raw_ytext_file(
    server: &Arc<Server>,
    doc_info: &y_sweet_core::doc_resolver::DocInfo,
    file_path: &str,
    old_string: &str,
    new_string: &str,
    ai_client_id: u64,
    ai_actor: &str,
) -> Result<String, String> {
    server
        .ensure_doc_loaded(&doc_info.doc_id)
        .await
        .map_err(|e| format!("Error: Failed to load document {}: {}", file_path, e))?;

    {
        let awareness = server
            .docs()
            .get(&doc_info.doc_id)
            .map(|doc_ref| doc_ref.awareness())
            .ok_or_else(|| format!("Error: Document data not loaded: {}", file_path))?;
        let guard = awareness.write().unwrap_or_else(|e| e.into_inner());
        let (start, len) = {
            let txn = guard.doc.transact();
            let content = match txn.get_text("contents") {
                Some(text) => text.get_string(&txn),
                None => String::new(),
            };

            let matches: Vec<usize> = content.match_indices(old_string).map(|(i, _)| i).collect();
            let match_start = match matches.len() {
                0 => {
                    return Err(format!(
                        "Error: old_string not found in {}. Make sure it matches exactly.",
                        file_path
                    ))
                }
                1 => matches[0],
                n => {
                    return Err(format!(
                    "Error: old_string is not unique in {} ({} occurrences). Include more context.",
                    file_path, n
                ))
                }
            };

            (
                content[..match_start].chars().count() as u32,
                old_string.chars().count() as u32,
            )
        };

        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        crate::mcp::provenance::apply_attributed_edit(
            &guard.doc,
            ai_client_id,
            ai_actor,
            timestamp,
            |txn, text| {
                text.remove_range(txn, start, len);
                text.insert(txn, start, new_string);
                Ok(())
            },
        )
        .map_err(|e| format!("Error: {}", e))?;
    }

    {
        let doc_ref = server
            .docs()
            .get(&doc_info.doc_id)
            .ok_or_else(|| format!("Error: Document data not loaded: {}", file_path))?;
        if let Err(e) = doc_ref.sync_kv().persist().await {
            tracing::error!("Failed to persist edit for {}: {:?}", doc_info.doc_id, e);
        }
    }

    Ok(format!(
        "Edited {}: replaced {} characters.",
        file_path,
        old_string.len()
    ))
}

/// Edit a blob file (e.g. .json) by direct text replacement — no CriticMarkup wrapping.
async fn edit_blob_file(
    server: &Arc<Server>,
    doc_info: &y_sweet_core::doc_resolver::DocInfo,
    file_path: &str,
    old_string: &str,
    new_string: &str,
) -> Result<String, String> {
    // 1. Read current blob content
    let hash = doc_info
        .hash
        .as_ref()
        .ok_or_else(|| format!("Error: No file hash for blob: {}", file_path))?;
    let data = blob::read_blob(server, &doc_info.doc_id, hash).await?;
    let content =
        String::from_utf8(data).map_err(|_| format!("Error: {} is not valid UTF-8", file_path))?;

    // 2. Find old_string (must be unique)
    let matches: Vec<usize> = content.match_indices(old_string).map(|(i, _)| i).collect();
    match matches.len() {
        0 => {
            return Err(format!(
                "Error: old_string not found in {}. Make sure it matches exactly.",
                file_path
            ))
        }
        1 => {}
        n => {
            return Err(format!(
                "Error: old_string is not unique in {} ({} occurrences). Include more context.",
                file_path, n
            ))
        }
    }

    // 3. Apply replacement
    let new_content = content.replacen(old_string, new_string, 1);

    // 4. Write new blob to store
    let new_hash = blob::write_blob(server, &doc_info.doc_id, new_content.as_bytes()).await?;

    // 5. Update hash in filemeta_v0 Y.Doc
    server
        .update_blob_hash(&doc_info.folder_doc_id, file_path, &new_hash)
        .await
        .map_err(|e| format!("Error updating filemeta: {}", e))?;

    // 6. Update hash in doc_resolver cache
    server.doc_resolver().update_hash(file_path, &new_hash);

    Ok(format!(
        "Edited {}: replaced {} characters.",
        file_path,
        old_string.len()
    ))
}

#[cfg(test)]
mod tests {
    use super::super::test_helpers::*;
    use super::*;
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
    async fn edit_html_replaces_raw_ytext_without_criticmarkup() {
        let server = build_test_server(&[("/Page.html", "uuid-html", "<h1>Hello</h1>")]).await;
        let doc_id = format!("{}-{}", RELAY_ID, "uuid-html");
        let sid = setup_session_with_read(&server, &doc_id);

        let result = execute(
            &server,
            &sid,
            &json!({
                "file_path": "Lens/Page.html",
                "old_string": "Hello",
                "new_string": "Hi",
            }),
        )
        .await;

        assert!(result.is_ok(), "edit should succeed, got: {:?}", result);
        let content = read_doc_content(&server, &doc_id);
        assert_eq!(content, "<h1>Hi</h1>");
        assert!(!content.contains("{++"));
        assert!(!content.contains("{--"));
    }

    #[tokio::test]
    async fn edit_html_allows_literal_criticmarkup_like_text() {
        let server = build_test_server(&[("/Page.html", "uuid-html", "<p>placeholder</p>")]).await;
        let doc_id = format!("{}-{}", RELAY_ID, "uuid-html");
        let sid = setup_session_with_read(&server, &doc_id);

        let result = execute(
            &server,
            &sid,
            &json!({
                "file_path": "Lens/Page.html",
                "old_string": "placeholder",
                "new_string": "{++literal++}",
            }),
        )
        .await;

        assert!(
            result.is_ok(),
            "edit should allow raw HTML text: {:?}",
            result
        );
        assert_eq!(read_doc_content(&server, &doc_id), "<p>{++literal++}</p>");
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
        let server =
            build_test_server(&[("/Cats.md", "uuid-cats", "the cat sat on the cat")]).await;
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
        // Pure insertion ("modified " added, nothing deleted) → direct.
        let server =
            build_test_server(&[("/Lines.md", "uuid-lines", "line 1\nline 2\nline 3")]).await;
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
        assert_eq!(content, "line 1\nmodified line 2\nline 3");
    }

    #[tokio::test]
    async fn edit_multiline_old_string() {
        let server =
            build_test_server(&[("/Multi.md", "uuid-multi", "line 1\nline 2\nline 3\nline 4")])
                .await;
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
        // Replacing unattributed text → pending suggestion, and the message
        // says so (the AI relays this to the user).
        assert!(
            msg.contains("Made pending changes"),
            "Success message should say pending changes: {}",
            msg
        );
    }

    // === Direct-edit policy tests ===

    fn read_events(server: &Arc<Server>, doc_id: &str) -> Vec<ActivityEvent> {
        let doc_ref = server.docs().get(doc_id).expect("doc should exist");
        let awareness = doc_ref.awareness();
        let guard = awareness.read().unwrap();
        let txn = guard.doc.transact();
        activity::read_events(&txn)
    }

    /// Register the doc's own (test-writer) client under `actor` in `users`.
    fn register_doc_client(server: &Arc<Server>, doc_id: &str, actor: &str) {
        use yrs::{Any, Array, ArrayPrelim, Map, MapPrelim, Out, WriteTxn};
        let doc_ref = server.docs().get(doc_id).expect("doc should exist");
        let awareness = doc_ref.awareness();
        let guard = awareness.write().unwrap();
        let client = guard.doc.client_id();
        let mut txn = guard.doc.transact_mut();
        let users = txn.get_or_insert_map("users");
        let entry = match users.get(&txn, actor) {
            Some(Out::YMap(m)) => m,
            _ => users.insert(&mut txn, actor, MapPrelim::default()),
        };
        let ids = match entry.get(&txn, "ids") {
            Some(Out::YArray(a)) => a,
            _ => entry.insert(&mut txn, "ids", ArrayPrelim::default()),
        };
        ids.push_back(&mut txn, Any::Number(client as f64));
    }

    #[tokio::test]
    async fn direct_insertion_records_activity_and_index() {
        let server = build_test_server(&[(
            "/Doc.md",
            "0d1a0000-0000-4000-8000-000000000001",
            "Intro paragraph.\n\nEnd.",
        )])
        .await;
        let doc_id = format!("{}-{}", RELAY_ID, "0d1a0000-0000-4000-8000-000000000001");
        let sid = setup_session_with_read(&server, &doc_id);

        let result = execute(
            &server,
            &sid,
            &json!({"file_path": "Lens/Doc.md", "old_string": "Intro paragraph.\n\nEnd.",
                    "new_string": "Intro paragraph.\n\nNew AI paragraph.\n\nEnd."}),
        )
        .await
        .unwrap();
        assert!(
            result.starts_with("Made the changes to Lens/Doc.md"),
            "{}",
            result
        );
        assert!(result.contains("inserted"), "{}", result);

        assert_eq!(
            read_doc_content(&server, &doc_id),
            "Intro paragraph.\n\nNew AI paragraph.\n\nEnd."
        );

        let events = read_events(&server, &doc_id);
        assert_eq!(events.len(), 1);
        let ev = &events[0];
        assert_eq!(ev.kind, "insert");
        assert_eq!(ev.old, "");
        assert_eq!(ev.new, "New AI paragraph.\n\n");
        assert_eq!(ev.mode, "direct");
        assert_eq!(ev.pos, "Intro paragraph.\n\n".len());
        assert_eq!(ev.ctx_before, "Intro paragraph.\n\n");
        assert_eq!(ev.ctx_after, "End.");
        assert!(ev.anchor.is_some());
        let session = server.mcp_sessions.get_session(&sid).unwrap();
        assert_eq!(ev.client, session.ai_client_id);
        assert_eq!(ev.actor, session.ai_actor);
        // clock range covers exactly the inserted text (UTF-16 units)
        assert_eq!(
            (ev.clock_to - ev.clock_from) as usize,
            "New AI paragraph.\n\n".encode_utf16().count()
        );

        // write-through to the in-memory index
        let indexed = server
            .recent_changes_index()
            .get("0d1a0000-0000-4000-8000-000000000001")
            .unwrap();
        assert_eq!(indexed.len(), 1);
        assert_eq!(indexed[0].id, ev.id);
    }

    #[tokio::test]
    async fn replacing_unattributed_text_becomes_suggestion() {
        let server = build_test_server(&[(
            "/Doc.md",
            "0d1a0000-0000-4000-8000-000000000002",
            "old human words",
        )])
        .await;
        let doc_id = format!("{}-{}", RELAY_ID, "0d1a0000-0000-4000-8000-000000000002");
        let sid = setup_session_with_read(&server, &doc_id);

        let result = execute(
            &server,
            &sid,
            &json!({"file_path": "Lens/Doc.md", "old_string": "human", "new_string": "robot"}),
        )
        .await
        .unwrap();
        assert!(result.starts_with("Made pending changes"), "{}", result);
        assert!(
            result.contains("human-written or unattributed"),
            "{}",
            result
        );
        let content = read_doc_content(&server, &doc_id);
        assert!(
            content.contains("{--") && content.contains("{++"),
            "{}",
            content
        );
        assert!(read_events(&server, &doc_id).is_empty());
        assert!(server
            .recent_changes_index()
            .get("0d1a0000-0000-4000-8000-000000000002")
            .is_none());
    }

    #[tokio::test]
    async fn replacing_human_registered_text_becomes_suggestion() {
        let server = build_test_server(&[(
            "/Doc.md",
            "0d1a0000-0000-4000-8000-000000000003",
            "old human words",
        )])
        .await;
        let doc_id = format!("{}-{}", RELAY_ID, "0d1a0000-0000-4000-8000-000000000003");
        register_doc_client(&server, &doc_id, "human:Luc");
        let sid = setup_session_with_read(&server, &doc_id);

        let result = execute(
            &server,
            &sid,
            &json!({"file_path": "Lens/Doc.md", "old_string": "old human words", "new_string": "old robot words"}),
        )
        .await
        .unwrap();
        assert!(result.starts_with("Made pending changes"), "{}", result);
        assert!(read_doc_content(&server, &doc_id).contains("@@human--}"));
    }

    #[tokio::test]
    async fn replacing_ai_registered_text_is_direct() {
        let server = build_test_server(&[(
            "/Doc.md",
            "0d1a0000-0000-4000-8000-000000000004",
            "old robot words",
        )])
        .await;
        let doc_id = format!("{}-{}", RELAY_ID, "0d1a0000-0000-4000-8000-000000000004");
        register_doc_client(&server, &doc_id, "ai:opus-5:luc");
        let sid = setup_session_with_read(&server, &doc_id);

        let result = execute(
            &server,
            &sid,
            &json!({"file_path": "Lens/Doc.md", "old_string": "old robot words", "new_string": "old machine words"}),
        )
        .await
        .unwrap();
        assert!(result.starts_with("Made the changes"), "{}", result);
        assert!(result.contains("replaced 5 characters"), "{}", result);
        assert_eq!(read_doc_content(&server, &doc_id), "old machine words");
        let events = read_events(&server, &doc_id);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "replace");
        assert_eq!(events[0].old, "robot");
        assert_eq!(events[0].new, "machine");
        assert_eq!(events[0].pos, 4);
    }

    #[tokio::test]
    async fn ai_can_rewrite_its_own_direct_text_but_not_surrounding_human_text() {
        let server = build_test_server(&[(
            "/Doc.md",
            "0d1a0000-0000-4000-8000-000000000005",
            "Human start. Human end.",
        )])
        .await;
        let doc_id = format!("{}-{}", RELAY_ID, "0d1a0000-0000-4000-8000-000000000005");
        register_doc_client(&server, &doc_id, "human:Luc");
        let sid = setup_session_with_read(&server, &doc_id);

        // 1. insert AI text (direct)
        let r = execute(
            &server,
            &sid,
            &json!({"file_path": "Lens/Doc.md", "old_string": "Human start. ", "new_string": "Human start. AI middle. "}),
        )
        .await
        .unwrap();
        assert!(r.starts_with("Made the changes"), "{}", r);
        assert_eq!(
            read_doc_content(&server, &doc_id),
            "Human start. AI middle. Human end."
        );

        // 2. rewrite only the AI text, using human context for uniqueness (direct)
        let r = execute(
            &server,
            &sid,
            &json!({"file_path": "Lens/Doc.md", "old_string": "start. AI middle. Human", "new_string": "start. AI centre. Human"}),
        )
        .await
        .unwrap();
        assert!(r.starts_with("Made the changes"), "{}", r);
        assert_eq!(
            read_doc_content(&server, &doc_id),
            "Human start. AI centre. Human end."
        );

        // 3. deleting one human word alongside AI text → suggestion
        let r = execute(
            &server,
            &sid,
            &json!({"file_path": "Lens/Doc.md", "old_string": "start. AI centre. Human end.", "new_string": "start. AI centre. end."}),
        )
        .await
        .unwrap();
        assert!(r.starts_with("Made pending changes"), "{}", r);
        assert!(read_doc_content(&server, &doc_id).contains("{--"));

        // two direct events logged, in order
        let events = read_events(&server, &doc_id);
        let kinds: Vec<&str> = events.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(kinds, vec!["insert", "replace"]);
        assert_eq!(
            server
                .recent_changes_index()
                .get("0d1a0000-0000-4000-8000-000000000005")
                .unwrap()
                .len(),
            2
        );
    }

    #[tokio::test]
    async fn suggestion_path_keeps_provenance_of_unchanged_context() {
        // Prevents: the suggestion path re-minting the unchanged part of
        // old_string under the AI client, which would let a later edit
        // replace that human text directly.
        let server = build_test_server(&[(
            "/Doc.md",
            "0d1a0000-0000-4000-8000-00000000000a",
            "Human wrote this sentence.",
        )])
        .await;
        let doc_id = format!("{}-{}", RELAY_ID, "0d1a0000-0000-4000-8000-00000000000a");
        register_doc_client(&server, &doc_id, "human:Luc");
        let human_client = {
            let doc_ref = server.docs().get(&doc_id).unwrap();
            let awareness = doc_ref.awareness();
            let guard = awareness.read().unwrap();
            guard.doc.client_id()
        };
        let sid = setup_session_with_read(&server, &doc_id);

        // Replace one human word using the whole sentence as context → suggestion.
        let r = execute(
            &server,
            &sid,
            &json!({"file_path": "Lens/Doc.md", "old_string": "Human wrote this sentence.", "new_string": "Human wrote that sentence."}),
        )
        .await
        .unwrap();
        assert!(r.starts_with("Made pending changes"), "{}", r);

        // The untouched human words must still be attributed to the human client.
        let (raw, runs) = {
            use yrs::WriteTxn;
            let doc_ref = server.docs().get(&doc_id).unwrap();
            let awareness = doc_ref.awareness();
            let guard = awareness.write().unwrap();
            let mut txn = guard.doc.transact_mut();
            let text = txn.get_or_insert_text("contents");
            let raw = text.get_string(&txn);
            let runs = crate::mcp::provenance::visible_runs(&mut txn, &text).unwrap();
            (raw, runs)
        };
        let human_start = raw.find("Human wrote ").unwrap();
        let clients = crate::mcp::provenance::clients_in_range(
            &runs,
            human_start,
            human_start + "Human wrote ".len(),
        );
        assert_eq!(clients, vec![human_client], "raw: {}", raw);
        let tail = raw.rfind(" sentence.").unwrap();
        assert_eq!(
            crate::mcp::provenance::clients_in_range(&runs, tail, tail + " sentence.".len()),
            vec![human_client]
        );

        // And a follow-up edit replacing that human context is still protected.
        let r = execute(
            &server,
            &sid,
            &json!({"file_path": "Lens/Doc.md", "old_string": "Human wrote", "new_string": "Robot wrote"}),
        )
        .await
        .unwrap();
        assert!(r.starts_with("Made pending changes"), "{}", r);
    }

    /// Raw text + provenance runs + the doc's own client id.
    fn raw_and_runs(server: &Arc<Server>, doc_id: &str) -> (String, Vec<crate::mcp::provenance::Run>, u64) {
        use yrs::WriteTxn;
        let doc_ref = server.docs().get(doc_id).unwrap();
        let awareness = doc_ref.awareness();
        let guard = awareness.write().unwrap();
        let client = guard.doc.client_id();
        let mut txn = guard.doc.transact_mut();
        let text = txn.get_or_insert_text("contents");
        let raw = text.get_string(&txn);
        let runs = crate::mcp::provenance::visible_runs(&mut txn, &text).unwrap();
        (raw, runs, client)
    }

    /// Clients owning each byte of `raw[from..to)`, as a set.
    fn owners(runs: &[crate::mcp::provenance::Run], from: usize, to: usize) -> Vec<u64> {
        crate::mcp::provenance::clients_in_range(runs, from, to)
    }

    #[tokio::test]
    async fn suggestion_never_aligns_human_chars_into_markup() {
        // Prevents: the free char diff matching the human's "m","a" of "mat"
        // with letters inside {"author":"AI","timestamp"...}, which left the
        // {--mat--} payload AI-minted; after a surgical reject the word was
        // AI-owned and a follow-up edit went direct.
        for (i, (old_word, new_word)) in [("mat", "rug"), ("is", "was"), ("a", "b"), ("this", "that")]
            .into_iter()
            .enumerate()
        {
            let uuid = format!("0d1a0000-0000-4000-8000-0000000000{:02x}", 0x30 + i);
            let body = format!("Luc put {} down.", old_word);
            let server = build_test_server(&[("/Doc.md", &uuid, &body)]).await;
            let doc_id = format!("{}-{}", RELAY_ID, uuid);
            register_doc_client(&server, &doc_id, "human:Luc");
            let sid = setup_session_with_read(&server, &doc_id);

            let r = execute(
                &server,
                &sid,
                &json!({"file_path": "Lens/Doc.md", "old_string": old_word, "new_string": new_word}),
            )
            .await
            .unwrap();
            assert!(r.starts_with("Made pending changes"), "{}", r);

            let (raw, runs, human) = raw_and_runs(&server, &doc_id);
            // Every char of the old word is human-owned and sits inside the
            // {--…--} payload.
            let del_open = raw.find("{--").unwrap();
            let del_close = raw.find("--}").unwrap();
            let payload_start = raw[del_open..del_close].rfind("@@").unwrap() + del_open + 2;
            assert_eq!(&raw[payload_start..del_close], old_word, "raw: {}", raw);
            assert_eq!(owners(&runs, payload_start, del_close), vec![human], "raw: {}", raw);
            // Nothing human-owned inside the metadata or the {++…++} block.
            assert!(
                !owners(&runs, del_open, payload_start).contains(&human),
                "human char inside deletion metadata: {}",
                raw
            );
            let ins_open = raw.find("{++").unwrap();
            let ins_close = raw.find("++}").unwrap() + 3;
            assert!(
                !owners(&runs, ins_open, ins_close).contains(&human),
                "human char inside insertion block: {}",
                raw
            );

            // Simulate the editor's surgical reject: strip the markup, keep
            // the payload items in place. The word must still be protected.
            {
                use yrs::{Text, WriteTxn};
                let doc_ref = server.docs().get(&doc_id).unwrap();
                let awareness = doc_ref.awareness();
                let guard = awareness.write().unwrap();
                let mut txn = guard.doc.transact_mut();
                let text = txn.get_or_insert_text("contents");
                text.remove_range(&mut txn, del_close as u32, (ins_close - del_close) as u32);
                text.remove_range(&mut txn, del_open as u32, (payload_start - del_open) as u32);
            }
            assert_eq!(read_doc_content(&server, &doc_id), body);
            let r = execute(
                &server,
                &sid,
                &json!({"file_path": "Lens/Doc.md", "old_string": old_word, "new_string": "zzz"}),
            )
            .await
            .unwrap();
            assert!(r.starts_with("Made pending changes"), "after reject: {}", r);
        }
    }

    #[tokio::test]
    async fn superseding_a_human_suggestion_keeps_its_surviving_text_human_owned() {
        // The {++…++} payload of the new suggestion re-emits the untouched
        // part of the human's pending insertion; it must stay human-owned
        // rather than be re-minted under the AI.
        let uuid = "0d1a0000-0000-4000-8000-000000000040";
        let server = build_test_server(&[(
            "/Doc.md",
            uuid,
            "Intro {++hello world++} outro.",
        )])
        .await;
        let doc_id = format!("{}-{}", RELAY_ID, uuid);
        register_doc_client(&server, &doc_id, "human:Luc");
        let sid = setup_session_with_read(&server, &doc_id);

        let r = execute(
            &server,
            &sid,
            &json!({"file_path": "Lens/Doc.md", "old_string": "world", "new_string": "there"}),
        )
        .await
        .unwrap();
        assert!(r.starts_with("Made pending changes"), "{}", r);
        let (raw, runs, human) = raw_and_runs(&server, &doc_id);
        let hello = raw.find("hello ").expect(&raw);
        assert_eq!(owners(&runs, hello, hello + "hello ".len()), vec![human], "raw: {}", raw);
        let there = raw.find("there").unwrap();
        assert!(!owners(&runs, there, there + 5).contains(&human), "raw: {}", raw);
    }

    #[tokio::test]
    async fn removing_human_separators_becomes_suggestion() {
        // Rule 6 exemption must not let the AI join human words or lines.
        let cases = [
            ("human wrote", "humanXwrote"),
            ("human wrote", "humanwrote"),
            ("text\n# Heading\n- item", "text# Heading\n-item"),
        ];
        for (i, (old, new)) in cases.into_iter().enumerate() {
            let uuid = format!("0d1a0000-0000-4000-8000-0000000000{:02x}", 0x50 + i);
            let server = build_test_server(&[("/Doc.md", &uuid, old)]).await;
            let doc_id = format!("{}-{}", RELAY_ID, uuid);
            register_doc_client(&server, &doc_id, "human:Luc");
            let sid = setup_session_with_read(&server, &doc_id);
            let r = execute(
                &server,
                &sid,
                &json!({"file_path": "Lens/Doc.md", "old_string": old, "new_string": new}),
            )
            .await
            .unwrap();
            assert!(r.starts_with("Made pending changes"), "{:?} -> {:?}: {}", old, new, r);
        }
    }

    #[tokio::test]
    async fn insertion_after_combining_mark_or_apostrophe_is_a_word_split() {
        let cases = [("caf\u{65}\u{301} au lait", "caf\u{65}x\u{301} au lait"), ("don't stop", "don'xt stop")];
        for (i, (old, new)) in cases.into_iter().enumerate() {
            let uuid = format!("0d1a0000-0000-4000-8000-0000000000{:02x}", 0x60 + i);
            let server = build_test_server(&[("/Doc.md", &uuid, old)]).await;
            let doc_id = format!("{}-{}", RELAY_ID, uuid);
            register_doc_client(&server, &doc_id, "human:Luc");
            let sid = setup_session_with_read(&server, &doc_id);
            let r = execute(
                &server,
                &sid,
                &json!({"file_path": "Lens/Doc.md", "old_string": old, "new_string": new}),
            )
            .await
            .unwrap();
            assert!(r.starts_with("Made pending changes"), "{:?}: {}", old, r);
        }
    }

    #[tokio::test]
    async fn client_registered_as_both_human_and_ai_is_protected() {
        let uuid = "0d1a0000-0000-4000-8000-000000000070";
        let server = build_test_server(&[("/Doc.md", uuid, "Shared words here.")]).await;
        let doc_id = format!("{}-{}", RELAY_ID, uuid);
        register_doc_client(&server, &doc_id, "ai:fable-5:luc");
        register_doc_client(&server, &doc_id, "human:Luc");
        let sid = setup_session_with_read(&server, &doc_id);
        for _ in 0..5 {
            let r = execute(
                &server,
                &sid,
                &json!({"file_path": "Lens/Doc.md", "old_string": "words", "new_string": "wordz"}),
            )
            .await
            .unwrap();
            assert!(r.starts_with("Made pending changes"), "{}", r);
            // Reset for the next round.
            {
                use yrs::{Text, WriteTxn};
                let doc_ref = server.docs().get(&doc_id).unwrap();
                let awareness = doc_ref.awareness();
                let guard = awareness.write().unwrap();
                let mut txn = guard.doc.transact_mut();
                let text = txn.get_or_insert_text("contents");
                let len = text.get_string(&txn).len() as u32;
                text.remove_range(&mut txn, 0, len);
                text.insert(&mut txn, 0, "Shared words here.");
            }
        }
    }

    #[tokio::test]
    async fn insertion_inside_a_human_word_becomes_suggestion() {
        let server = build_test_server(&[(
            "/Doc.md",
            "0d1a0000-0000-4000-8000-00000000000b",
            "Luc typed this human sentence.",
        )])
        .await;
        let doc_id = format!("{}-{}", RELAY_ID, "0d1a0000-0000-4000-8000-00000000000b");
        register_doc_client(&server, &doc_id, "human:Luc");
        let sid = setup_session_with_read(&server, &doc_id);

        // Appending a letter still counts as rewriting the word only when it
        // splits it; "human" → "humane" adds at the word end... which is a
        // boundary with the following space, so it is a plain insertion.
        // Inserting *inside* the word is the protected case.
        let r = execute(
            &server,
            &sid,
            &json!({"file_path": "Lens/Doc.md", "old_string": "human", "new_string": "humxan"}),
        )
        .await
        .unwrap();
        assert!(r.starts_with("Made pending changes"), "{}", r);
        assert!(r.contains("human-written"), "{}", r);

        // Insertion at a word boundary inside the human sentence stays direct.
        let r = execute(
            &server,
            &sid,
            &json!({"file_path": "Lens/Doc.md", "old_string": "Luc typed", "new_string": "Luc quickly typed"}),
        )
        .await
        .unwrap();
        assert!(r.starts_with("Made the changes"), "{}", r);
    }

    #[tokio::test]
    async fn deleting_ai_paragraph_with_human_separator_is_direct() {
        let server = build_test_server(&[(
            "/Doc.md",
            "0d1a0000-0000-4000-8000-00000000000c",
            "Intro.\n\nHuman end.",
        )])
        .await;
        let doc_id = format!("{}-{}", RELAY_ID, "0d1a0000-0000-4000-8000-00000000000c");
        register_doc_client(&server, &doc_id, "human:Luc");
        let sid = setup_session_with_read(&server, &doc_id);

        let r = execute(
            &server,
            &sid,
            &json!({"file_path": "Lens/Doc.md", "old_string": "Intro.\n", "new_string": "Intro.\n\nAI paragraph.\n"}),
        )
        .await
        .unwrap();
        assert!(r.starts_with("Made the changes"), "{}", r);
        assert_eq!(
            read_doc_content(&server, &doc_id),
            "Intro.\n\nAI paragraph.\n\nHuman end."
        );

        // Remove the AI paragraph together with one of the human's newlines.
        let r = execute(
            &server,
            &sid,
            &json!({"file_path": "Lens/Doc.md", "old_string": "\nAI paragraph.\n\nHuman", "new_string": "\nHuman"}),
        )
        .await
        .unwrap();
        assert!(r.starts_with("Made the changes"), "{}", r);
        assert_eq!(read_doc_content(&server, &doc_id), "Intro.\n\nHuman end.");

        // But taking a human word with it is still protected.
        let r = execute(
            &server,
            &sid,
            &json!({"file_path": "Lens/Doc.md", "old_string": "Intro.\n\nHuman end.", "new_string": "Intro. end."}),
        )
        .await
        .unwrap();
        assert!(r.starts_with("Made pending changes"), "{}", r);
    }

    #[tokio::test]
    async fn suggest_mode_forces_pending_change_even_for_insertion() {
        let server =
            build_test_server(&[("/Doc.md", "0d1a0000-0000-4000-8000-000000000006", "a b")]).await;
        let doc_id = format!("{}-{}", RELAY_ID, "0d1a0000-0000-4000-8000-000000000006");
        let sid = setup_session_with_read(&server, &doc_id);

        let r = execute(
            &server,
            &sid,
            &json!({"file_path": "Lens/Doc.md", "old_string": "a b", "new_string": "a x b", "mode": "suggest"}),
        )
        .await
        .unwrap();
        assert!(r.starts_with("Made pending changes"), "{}", r);
        assert!(r.contains("as requested"), "{}", r);
        assert!(read_doc_content(&server, &doc_id).contains("{++"));
        assert!(read_events(&server, &doc_id).is_empty());

        let err = execute(
            &server,
            &sid,
            &json!({"file_path": "Lens/Doc.md", "old_string": "a", "new_string": "b", "mode": "direct"}),
        )
        .await
        .unwrap_err();
        assert!(err.contains("Invalid mode"), "{}", err);
    }

    #[tokio::test]
    async fn insertion_touching_pending_or_comment_markup_becomes_suggestion() {
        // Insert inside an existing pending addition's payload → merge path
        let server = build_test_server(&[
            (
                "/Pend.md",
                "0d1a0000-0000-4000-8000-000000000007",
                "before {++NEW++} after",
            ),
            (
                "/Cmt.md",
                "0d1a0000-0000-4000-8000-000000000008",
                "text {>>a note<<} more",
            ),
        ])
        .await;
        let pend_id = format!("{}-{}", RELAY_ID, "0d1a0000-0000-4000-8000-000000000007");
        let cmt_id = format!("{}-{}", RELAY_ID, "0d1a0000-0000-4000-8000-000000000008");
        let sid = setup_session_with_read(&server, &pend_id);
        if let Some(mut s) = server.mcp_sessions.get_session_mut(&sid) {
            s.read_docs.insert(cmt_id.clone());
        }

        let r = execute(
            &server,
            &sid,
            &json!({"file_path": "Lens/Pend.md", "old_string": "NEW", "new_string": "NEWER"}),
        )
        .await
        .unwrap();
        assert!(r.starts_with("Made pending changes"), "{}", r);
        assert!(r.contains("overlaps pending changes"), "{}", r);
        assert!(read_events(&server, &pend_id).is_empty());

        // Insertion strictly inside a comment → suggestion; before it → direct
        let r = execute(
            &server,
            &sid,
            &json!({"file_path": "Lens/Cmt.md", "old_string": "a note", "new_string": "a longer note"}),
        )
        .await
        .unwrap();
        assert!(r.starts_with("Made pending changes"), "{}", r);
        let r = execute(
            &server,
            &sid,
            &json!({"file_path": "Lens/Cmt.md", "old_string": "text ", "new_string": "text added "}),
        )
        .await
        .unwrap();
        assert!(r.starts_with("Made the changes"), "{}", r);
    }

    #[tokio::test]
    async fn direct_edit_with_smart_quotes_does_not_count_quotes_as_changes() {
        let server = build_test_server(&[(
            "/Q.md",
            "0d1a0000-0000-4000-8000-000000000009",
            "say \u{201C}hi\u{201D} now",
        )])
        .await;
        let doc_id = format!("{}-{}", RELAY_ID, "0d1a0000-0000-4000-8000-000000000009");
        register_doc_client(&server, &doc_id, "ai:opus-5:luc");
        let sid = setup_session_with_read(&server, &doc_id);
        let r = execute(
            &server,
            &sid,
            &json!({"file_path": "Lens/Q.md", "old_string": "say \"hi\" now", "new_string": "say \"hi\" later"}),
        )
        .await
        .unwrap();
        assert!(r.starts_with("Made the changes"), "{}", r);
        assert_eq!(
            read_doc_content(&server, &doc_id),
            "say \u{201C}hi\u{201D} later"
        );
        let ev = &read_events(&server, &doc_id)[0];
        assert_eq!((ev.old.as_str(), ev.new.as_str()), ("now", "later"));
    }

    #[tokio::test]
    async fn edit_supersedes_existing_suggestion() {
        let server = build_test_server(&[(
            "/Doc.md",
            "uuid-doc",
            "The {--quick--}{++fast++} brown fox.",
        )])
        .await;
        let doc_id = format!("{}-uuid-doc", RELAY_ID);
        let sid = setup_session_with_read(&server, &doc_id);

        let result = execute(
            &server,
            &sid,
            &json!({
                "file_path": "Lens/Doc.md",
                "old_string": "fast",
                "new_string": "speedy",
                "session_id": sid,
            }),
        )
        .await;

        assert!(result.is_ok(), "edit should succeed, got: {:?}", result);
        let raw = read_doc_content(&server, &doc_id);
        let spans = critic_markup::parse(&raw);
        assert_eq!(
            critic_markup::accepted_view(&spans),
            "The speedy brown fox."
        );
        assert_eq!(critic_markup::base_view(&spans), "The quick brown fox.");
    }

    #[tokio::test]
    async fn e01_two_edits_different_regions_coexist() {
        use super::super::test_helpers::*;
        let server = build_test_server(&[(
            "/Doc.md",
            "uuid-doc",
            "The quick brown fox jumps over the lazy dog.",
        )])
        .await;
        let doc_id = format!("{}-uuid-doc", RELAY_ID);
        let sid = setup_session_with_read(&server, &doc_id);

        // Edit 1
        execute(&server, &sid, &json!({
            "file_path": "Lens/Doc.md", "old_string": "quick", "new_string": "fast", "session_id": sid,
        })).await.unwrap();

        // Re-read between edits (required for read-before-edit enforcement)
        super::super::read::execute(
            &server,
            &sid,
            &json!({
                "file_path": "Lens/Doc.md", "session_id": sid,
            }),
        )
        .await
        .unwrap();

        // Edit 2 — different region
        execute(&server, &sid, &json!({
            "file_path": "Lens/Doc.md", "old_string": "lazy", "new_string": "happy", "session_id": sid,
        })).await.unwrap();

        let raw = read_doc_content(&server, &doc_id);
        let spans = super::super::critic_markup::parse(&raw);
        assert_eq!(
            super::super::critic_markup::accepted_view(&spans),
            "The fast brown fox jumps over the happy dog."
        );
        assert_eq!(
            super::super::critic_markup::base_view(&spans),
            "The quick brown fox jumps over the lazy dog."
        );
    }

    #[tokio::test]
    async fn e02_triple_supersede_preserves_original_base() {
        use super::super::test_helpers::*;
        let server = build_test_server(&[("/Doc.md", "uuid-doc", "Say hello today.")]).await;
        let doc_id = format!("{}-uuid-doc", RELAY_ID);
        let sid = setup_session_with_read(&server, &doc_id);

        for (old, new) in [("hello", "world"), ("world", "earth"), ("earth", "mars")] {
            execute(&server, &sid, &json!({
                "file_path": "Lens/Doc.md", "old_string": old, "new_string": new, "session_id": sid,
            })).await.unwrap();
            // Re-read between edits
            super::super::read::execute(
                &server,
                &sid,
                &json!({
                    "file_path": "Lens/Doc.md", "session_id": sid,
                }),
            )
            .await
            .unwrap();
        }

        let raw = read_doc_content(&server, &doc_id);
        let spans = super::super::critic_markup::parse(&raw);
        assert_eq!(
            super::super::critic_markup::accepted_view(&spans),
            "Say mars today."
        );
        assert_eq!(
            super::super::critic_markup::base_view(&spans),
            "Say hello today."
        );
    }

    #[tokio::test]
    async fn e03_expanding_edit_supersedes_prior() {
        use super::super::test_helpers::*;
        let server =
            build_test_server(&[("/Doc.md", "uuid-doc", "The quick brown fox jumps over.")]).await;
        let doc_id = format!("{}-uuid-doc", RELAY_ID);
        let sid = setup_session_with_read(&server, &doc_id);

        // Small edit
        execute(&server, &sid, &json!({
            "file_path": "Lens/Doc.md", "old_string": "brown", "new_string": "red", "session_id": sid,
        })).await.unwrap();

        super::super::read::execute(
            &server,
            &sid,
            &json!({
                "file_path": "Lens/Doc.md", "session_id": sid,
            }),
        )
        .await
        .unwrap();

        // Expanding edit that encompasses the first
        execute(&server, &sid, &json!({
            "file_path": "Lens/Doc.md", "old_string": "quick red fox", "new_string": "slow blue cat", "session_id": sid,
        })).await.unwrap();

        let raw = read_doc_content(&server, &doc_id);
        let spans = super::super::critic_markup::parse(&raw);
        assert_eq!(
            super::super::critic_markup::accepted_view(&spans),
            "The slow blue cat jumps over."
        );
        assert_eq!(
            super::super::critic_markup::base_view(&spans),
            "The quick brown fox jumps over."
        );
    }

    // === Smart quote normalization tests ===

    #[tokio::test]
    async fn edit_smart_double_quotes_matched_by_straight_quotes() {
        // Document contains smart/curly double quotes (U+201C, U+201D)
        let server = build_test_server(&[(
            "/Quotes.md",
            "uuid-quotes",
            "He said \u{201c}hello\u{201d} to everyone",
        )])
        .await;
        let doc_id = format!("{}-{}", RELAY_ID, "uuid-quotes");
        let sid = setup_session_with_read(&server, &doc_id);

        // AI sends straight quotes in old_string (common LLM behavior)
        let result = execute(
            &server,
            &sid,
            &json!({
                "file_path": "Lens/Quotes.md",
                "old_string": "said \"hello\" to",
                "new_string": "said \"goodbye\" to"
            }),
        )
        .await;

        assert!(
            result.is_ok(),
            "edit should match smart quotes when AI sends straight quotes, got: {:?}",
            result
        );

        let raw = read_doc_content(&server, &doc_id);
        let spans = critic_markup::parse(&raw);
        let accepted = critic_markup::accepted_view(&spans);
        assert!(
            accepted.contains("goodbye"),
            "accepted view should contain the replacement: {}",
            accepted
        );
    }

    #[tokio::test]
    async fn edit_smart_single_quotes_matched_by_straight_quotes() {
        // Document contains smart/curly single quotes (U+2018, U+2019)
        let server = build_test_server(&[(
            "/Quotes.md",
            "uuid-quotes",
            "It\u{2019}s a nice day, isn\u{2019}t it",
        )])
        .await;
        let doc_id = format!("{}-{}", RELAY_ID, "uuid-quotes");
        let sid = setup_session_with_read(&server, &doc_id);

        // AI sends straight apostrophe
        let result = execute(
            &server,
            &sid,
            &json!({
                "file_path": "Lens/Quotes.md",
                "old_string": "It's a nice day",
                "new_string": "It's a beautiful day"
            }),
        )
        .await;

        assert!(
            result.is_ok(),
            "edit should match smart single quotes when AI sends straight quotes, got: {:?}",
            result
        );
    }

    // === Comment-aware edit tests ===

    #[tokio::test]
    async fn edit_around_comment_preserves_it() {
        let server =
            build_test_server(&[("/Doc.md", "uuid-doc", "Hello {>>nice point<<} world")]).await;
        let doc_id = format!("{}-uuid-doc", RELAY_ID);
        let sid = setup_session_with_read(&server, &doc_id);

        let result = execute(
            &server,
            &sid,
            &json!({
                "file_path": "Lens/Doc.md",
                "old_string": "Hello {>>nice point<<} world",
                "new_string": "Goodbye {>>nice point<<} world"
            }),
        )
        .await;

        assert!(
            result.is_ok(),
            "edit around comment should succeed, got: {:?}",
            result
        );
        let raw = read_doc_content(&server, &doc_id);
        assert!(
            raw.contains("{>>nice point<<}"),
            "Comment should be preserved: {}",
            raw
        );
        let spans = critic_markup::parse(&raw);
        assert_eq!(
            critic_markup::accepted_view(&spans),
            "Goodbye {>>nice point<<} world"
        );
    }

    #[tokio::test]
    async fn edit_rejects_removing_non_ai_comment() {
        let server =
            build_test_server(&[("/Doc.md", "uuid-doc", "Hello {>>human note<<} world")]).await;
        let doc_id = format!("{}-uuid-doc", RELAY_ID);
        let sid = setup_session_with_read(&server, &doc_id);

        let result = execute(
            &server,
            &sid,
            &json!({
                "file_path": "Lens/Doc.md",
                "old_string": "Hello {>>human note<<} world",
                "new_string": "Hello world"
            }),
        )
        .await;

        assert!(result.is_err(), "should reject removing non-AI comment");
        let err = result.unwrap_err();
        assert!(
            err.contains("comment"),
            "Error should mention comment: {}",
            err
        );
    }

    #[tokio::test]
    async fn edit_allows_removing_ai_comment() {
        let server = build_test_server(&[(
            "/Doc.md",
            "uuid-doc",
            r#"Hello {>>{"author":"AI"}@@note<<} world"#,
        )])
        .await;
        let doc_id = format!("{}-uuid-doc", RELAY_ID);
        let sid = setup_session_with_read(&server, &doc_id);

        let result = execute(
            &server,
            &sid,
            &json!({
                "file_path": "Lens/Doc.md",
                "old_string": r#"Hello {>>{"author":"AI"}@@note<<} world"#,
                "new_string": "Hello world"
            }),
        )
        .await;

        assert!(
            result.is_ok(),
            "removing AI comment should succeed, got: {:?}",
            result
        );
    }

    #[tokio::test]
    async fn edit_allows_adding_comment() {
        let server = build_test_server(&[("/Doc.md", "uuid-doc", "Hello world")]).await;
        let doc_id = format!("{}-uuid-doc", RELAY_ID);
        let sid = setup_session_with_read(&server, &doc_id);

        let result = execute(
            &server,
            &sid,
            &json!({
                "file_path": "Lens/Doc.md",
                "old_string": "Hello world",
                "new_string": r#"Hello{>>{"author":"AI"}@@observation<<} world"#
            }),
        )
        .await;

        assert!(
            result.is_ok(),
            "adding comment should succeed, got: {:?}",
            result
        );
        let raw = read_doc_content(&server, &doc_id);
        assert!(
            raw.contains("observation"),
            "Comment should be in doc: {}",
            raw
        );
    }

    #[tokio::test]
    async fn edit_attributes_plain_comment_to_named_session() {
        let server = build_test_server(&[("/Doc.md", "uuid-doc", "Hello world")]).await;
        let doc_id = format!("{}-uuid-doc", RELAY_ID);

        // Named session: comments should be attributed to "Chris's AI".
        let sid = server
            .mcp_sessions
            .create_session(default_access(), Some("Chris"), None);
        server
            .mcp_sessions
            .get_session_mut(&sid)
            .unwrap()
            .read_docs
            .insert(doc_id.clone());

        // Model writes a bare comment with no author metadata.
        let result = execute(
            &server,
            &sid,
            &json!({
                "file_path": "Lens/Doc.md",
                "old_string": "Hello world",
                "new_string": "Hello {>>nice point<<} world"
            }),
        )
        .await;

        assert!(
            result.is_ok(),
            "adding comment should succeed: {:?}",
            result
        );
        let raw = read_doc_content(&server, &doc_id);
        assert!(
            raw.contains(r#"{>>{"author":"Chris's AI""#),
            "Comment should be attributed to the named session: {}",
            raw
        );
        assert!(
            raw.contains("nice point"),
            "Comment text preserved: {}",
            raw
        );
    }

    #[tokio::test]
    async fn edit_rejects_model_spoofing_human_comment_author() {
        // A new comment the model attributes to a human is re-stamped as the
        // session author, so it cannot masquerade as a human reviewer.
        let server = build_test_server(&[("/Doc.md", "uuid-doc", "Hello world")]).await;
        let doc_id = format!("{}-uuid-doc", RELAY_ID);
        let sid = setup_session_with_read(&server, &doc_id);

        let result = execute(
            &server,
            &sid,
            &json!({
                "file_path": "Lens/Doc.md",
                "old_string": "Hello world",
                "new_string": r#"Hello {>>{"author":"Luc"}@@note<<} world"#
            }),
        )
        .await;

        assert!(
            result.is_ok(),
            "adding comment should succeed: {:?}",
            result
        );
        let raw = read_doc_content(&server, &doc_id);
        assert!(
            raw.contains(r#"{>>{"author":"AI""#),
            "Spoofed author should be replaced with the session label: {}",
            raw
        );
        assert!(
            !raw.contains(r#""author":"Luc""#),
            "Model-supplied human author must not survive: {}",
            raw
        );
    }
}

#[cfg(test)]
mod blob_edit_tests {
    use super::*;
    use crate::mcp::tools::blob;
    use crate::mcp::tools::test_helpers::*;
    use serde_json::json;

    #[tokio::test]
    async fn edit_json_replaces_text() {
        let server =
            build_blob_test_server_with_file("/data.json", "uuid-json", r#"{"key": "old_value"}"#)
                .await;
        let sid = setup_session_with_read(&server, &format!("{}-uuid-json", RELAY_ID));
        let result = execute(
            &server,
            &sid,
            &json!({
                "file_path": "Lens/data.json",
                "old_string": "old_value",
                "new_string": "new_value",
                "session_id": sid,
            }),
        )
        .await;
        assert!(result.is_ok(), "Edit should succeed: {:?}", result.err());

        // Read back and verify
        let new_hash = server
            .doc_resolver()
            .get_file_hash("Lens/data.json")
            .unwrap();
        let doc_info = server
            .doc_resolver()
            .resolve_path("Lens/data.json")
            .unwrap();
        let data = blob::read_blob(&server, &doc_info.doc_id, &new_hash)
            .await
            .unwrap();
        let content = String::from_utf8(data).unwrap();
        assert_eq!(content, r#"{"key": "new_value"}"#);
    }

    #[tokio::test]
    async fn edit_json_requires_read_first() {
        let server =
            build_blob_test_server_with_file("/data.json", "uuid-json", r#"{"key": "value"}"#)
                .await;
        let sid = setup_session_no_reads(&server);
        let result = execute(
            &server,
            &sid,
            &json!({
                "file_path": "Lens/data.json",
                "old_string": "value",
                "new_string": "changed",
                "session_id": sid,
            }),
        )
        .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("must read"));
    }

    #[tokio::test]
    async fn edit_json_no_criticmarkup() {
        let server =
            build_blob_test_server_with_file("/data.json", "uuid-json", r#"{"key": "value"}"#)
                .await;
        let sid = setup_session_with_read(&server, &format!("{}-uuid-json", RELAY_ID));
        execute(
            &server,
            &sid,
            &json!({
                "file_path": "Lens/data.json",
                "old_string": "value",
                "new_string": "changed",
                "session_id": sid,
            }),
        )
        .await
        .unwrap();

        let new_hash = server
            .doc_resolver()
            .get_file_hash("Lens/data.json")
            .unwrap();
        let doc_info = server
            .doc_resolver()
            .resolve_path("Lens/data.json")
            .unwrap();
        let data = blob::read_blob(&server, &doc_info.doc_id, &new_hash)
            .await
            .unwrap();
        let content = String::from_utf8(data).unwrap();
        assert!(!content.contains("{++"));
        assert!(!content.contains("{--"));
    }

    #[tokio::test]
    async fn edit_json_old_string_not_found() {
        let server =
            build_blob_test_server_with_file("/data.json", "uuid-json", r#"{"key": "value"}"#)
                .await;
        let sid = setup_session_with_read(&server, &format!("{}-uuid-json", RELAY_ID));
        let result = execute(
            &server,
            &sid,
            &json!({
                "file_path": "Lens/data.json",
                "old_string": "nonexistent",
                "new_string": "changed",
                "session_id": sid,
            }),
        )
        .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }
}
