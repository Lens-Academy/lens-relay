//! Canonical article digest used by retroactive LLM-review provenance.

use super::{blob, critic_markup, grep};
use crate::server::Server;
use serde_json::{json, Value};
use std::sync::Arc;

const REVIEW_FIELDS: &[&str] = &[
    "llm_reviewed",
    "llm_review_version",
    "llm_review_model",
    "llm_review_digest",
    "llm_review_source_digest",
    "llm_review_source_fetched",
    "llm_review_source_kind",
];
const REVIEW_BLOCK: &str = "llm-review";

pub fn canonicalize(markdown: &str) -> String {
    let normalized = markdown.replace("\r\n", "\n").replace('\r', "\n");
    let mut output = Vec::new();
    let mut in_frontmatter = false;
    let mut frontmatter_done = false;
    let mut in_comment = false;
    let mut in_review_block = false;
    for line in normalized.lines() {
        if !frontmatter_done && line.trim() == "---" {
            in_frontmatter = !in_frontmatter;
            if !in_frontmatter {
                frontmatter_done = true;
            }
            output.push(line.trim_end().to_string());
            continue;
        }
        if in_frontmatter && in_review_block {
            if line.is_empty() || line.starts_with([' ', '\t']) {
                continue;
            }
            in_review_block = false;
        }
        if in_frontmatter
            && line
                .strip_prefix(REVIEW_BLOCK)
                .is_some_and(|rest| rest.trim_start().starts_with(':'))
        {
            in_review_block = true;
            continue;
        }
        if in_frontmatter
            && REVIEW_FIELDS.iter().any(|field| {
                line.strip_prefix(field)
                    .is_some_and(|rest| rest.trim_start().starts_with(':'))
            })
        {
            continue;
        }
        if !in_frontmatter && line.trim() == "%%" {
            in_comment = !in_comment;
            continue;
        }
        if !in_comment {
            output.push(line.trim_end().to_string());
        }
    }
    while output.last().is_some_and(|line| line.is_empty()) {
        output.pop();
    }
    let mut compact = Vec::new();
    for line in output {
        if line.is_empty() && compact.last().is_some_and(|last: &String| last.is_empty()) {
            continue;
        }
        compact.push(line);
    }
    format!("{}\n", compact.join("\n"))
}

pub async fn execute(server: &Arc<Server>, arguments: &Value) -> Result<String, String> {
    let file_path = arguments
        .get("file_path")
        .and_then(Value::as_str)
        .ok_or_else(|| "Missing required parameter: file_path".to_string())?;
    if !file_path.ends_with(".md") {
        return Err("article_review_digest only supports Markdown documents".to_string());
    }
    let accepted = arguments
        .get("accept_drafts")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let info = server
        .doc_resolver()
        .resolve_path(file_path)
        .ok_or_else(|| format!("Error: Document not found: {}", file_path))?;
    let raw = grep::read_doc_content(server, &info.doc_id, file_path)
        .await
        .ok_or_else(|| format!("Error: Could not read document: {}", file_path))?;
    let spans = critic_markup::parse(&raw);
    let view = if accepted {
        critic_markup::accepted_view(&spans)
    } else {
        critic_markup::base_view(&spans)
    };
    let canonical = canonicalize(&view);
    Ok(json!({
        "path": file_path,
        "view": if accepted { "accepted-draft" } else { "base" },
        "digest": format!("sha256:{}", blob::sha256_hex(canonical.as_bytes())),
        "bytes": canonical.len(),
    })
    .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_digest_ignores_provenance_comments_and_line_endings() {
        let a = "---\r\ntitle: A\r\nllm_reviewed: 2026-08-19\r\n---\r\n\r\n%%\r\nnote\r\n%%\r\n\r\nBody  \r\n";
        let b = "---\ntitle: A\n---\n\nBody\n";
        assert_eq!(canonicalize(a), canonicalize(b));
        assert_eq!(
            blob::sha256_hex(canonicalize(b).as_bytes()),
            "f4bcd7583fd58f1942b6579720542e38979e0e7b8855c3c9d1de338fe3260420"
        );
    }

    #[test]
    fn canonical_digest_ignores_nested_provenance_and_keeps_following_metadata() {
        let stamped = "---\ntitle: A\nllm-review:\n  content-sha: sha256:article\n  date: 2026-08-24\n  model: sonnet\n  version: article-qc-v1\n  source:\n    content-sha: sha256:source\n    fetched: 2026-08-24\n    kind: live\ndescription: Kept\n---\n\nBody\n";
        let unstamped = "---\ntitle: A\ndescription: Kept\n---\n\nBody\n";
        assert_eq!(canonicalize(stamped), canonicalize(unstamped));
    }
}
