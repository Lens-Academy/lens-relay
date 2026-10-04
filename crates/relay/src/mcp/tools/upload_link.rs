//! `upload_link`: hand the caller a one-off URL it can POST a whole file to,
//! so large content (a 500 KB HTML page) reaches the relay without the model
//! writing it out as tool-call arguments. The upload itself is handled by
//! `mcp/upload.rs`, which runs the ordinary `create` / `edit` tools.

use crate::server::Server;
use serde_json::Value;
use std::sync::Arc;

use super::create_doc;
use crate::mcp::session::UPLOAD_TICKET_TTL;

/// Public base URL of this relay, used to build upload links.
fn public_base_url() -> String {
    std::env::var("RELAY_PUBLIC_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "https://relay.lensacademy.org".to_string())
        .trim_end_matches('/')
        .to_string()
}

pub fn upload_url(base: &str, ticket: &str) -> String {
    format!("{}/mcp/upload/{}", base.trim_end_matches('/'), ticket)
}

pub async fn execute(
    server: &Arc<Server>,
    session_id: &str,
    arguments: &Value,
) -> Result<String, String> {
    let file_path = arguments
        .get("file_path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter: file_path".to_string())?;
    let replace = arguments
        .get("replace")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if !(file_path.ends_with(".md") || file_path.ends_with(".html")) {
        return Err(
            "upload_link takes .md and .html files only (images go through import_attachment)."
                .to_string(),
        );
    }
    if !file_path.contains('/') {
        return Err("file_path must include a folder name (e.g. 'Lens/Page.html')".to_string());
    }
    let exists = server.doc_resolver().resolve_path(file_path).is_some();
    if !exists && create_doc::is_lens_edu_articles_path(file_path) {
        return Err(create_doc::ARTICLE_CREATE_BLOCK_MESSAGE.to_string());
    }
    if exists && !replace {
        return Err(format!(
            "{} already exists. To overwrite all of it with the uploaded file, call upload_link again with replace: true.",
            file_path
        ));
    }

    let ticket = server
        .mcp_sessions
        .issue_upload(session_id, file_path, replace)?;
    let url = upload_url(&public_base_url(), &ticket);
    let action = if exists {
        "replaces its content: the lines that differ go through the edit tool, with its rules (in Markdown, human-written text that changes becomes a pending suggestion)"
    } else {
        "creates it (same rules as the create tool)"
    };
    Ok(format!(
        "Upload link for {file_path} (valid {mins} minutes, works once):\n{url}\n\n\
         POST the raw file as the request body (UTF-8 text, not JSON, no base64), e.g.:\n\
         curl -sS --fail-with-body -X POST --data-binary @<local-file> '{url}'\n\n\
         Uploading {action}. The response is the same text the create/edit tool would return. \
         If it reports an error, nothing was written and the link stays valid: fix the file and POST again. \
         This needs a shell that can reach this host and has the file on disk: Claude Code, or claude.ai code execution \
         only if its network settings allow this host and the file is in the sandbox. Writing the file out in a tool call \
         first gains nothing over create/edit.",
        mins = UPLOAD_TICKET_TTL.as_secs() / 60,
    ))
}
