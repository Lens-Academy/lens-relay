use crate::server::Server;
use serde_json::Value;
use std::sync::Arc;

/// Length of the short UUID prefix used in editor URLs. Mirrors
/// `SHORT_UUID_LENGTH` in `lens-editor/src/lib/url-utils.ts`.
const SHORT_UUID_LEN: usize = 8;

/// Execute the `get_url` tool: return the Lens Editor URL for a document.
///
/// The editor opens a document at `{EDITOR_BASE_URL}/{prefix}/{decorative path}`,
/// where `prefix` is the first [`SHORT_UUID_LEN`] chars of the document's UUID.
/// That prefix is a random id assigned at creation, so it can only be looked up,
/// never derived — hence this tool, instead of clients hand-building (and
/// breaking) URLs.
pub fn execute(server: &Arc<Server>, arguments: &Value) -> Result<String, String> {
    let file_path = arguments
        .get("file_path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter: file_path".to_string())?;

    let doc_info = server
        .doc_resolver()
        .resolve_path(file_path)
        .ok_or_else(|| format!("Error: Document not found: {}", file_path))?;

    let base = std::env::var("EDITOR_BASE_URL").ok();
    Ok(build_url(&doc_info.uuid, file_path, base.as_deref()))
}

/// Build the editor URL from a document UUID and its vault path.
///
/// The prefix is the first [`SHORT_UUID_LEN`] chars of the UUID; the path after it
/// is decorative (spaces become dashes), matching `urlForDoc` in
/// `lens-editor/src/lib/url-utils.ts` and the `handle_open_by_path` redirect in
/// `server.rs`. With `base` set the full URL is returned; otherwise the relative
/// locator path (the client prepends its editor base).
fn build_url(uuid: &str, file_path: &str, base: Option<&str>) -> String {
    let prefix = &uuid[..SHORT_UUID_LEN.min(uuid.len())];
    let slug = file_path.replace(' ', "-");
    match base {
        Some(b) if !b.trim().is_empty() => {
            format!("{}/{}/{}", b.trim_end_matches('/'), prefix, slug)
        }
        _ => format!("/{}/{}", prefix, slug),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tools::test_helpers::*;
    use serde_json::json;

    const DOC_UUID: &str = "abcd1234-0000-4000-8000-000000000001";

    #[test]
    fn full_url_with_base() {
        assert_eq!(
            build_url(
                DOC_UUID,
                "Lens/Doc.md",
                Some("https://editor.lensacademy.org")
            ),
            "https://editor.lensacademy.org/abcd1234/Lens/Doc.md"
        );
    }

    #[test]
    fn slugifies_spaces() {
        assert_eq!(
            build_url(
                DOC_UUID,
                "Lens/Meeting Transcripts/Foo Bar.md",
                Some("https://x")
            ),
            "https://x/abcd1234/Lens/Meeting-Transcripts/Foo-Bar.md"
        );
    }

    #[test]
    fn trims_trailing_slash_on_base() {
        assert_eq!(
            build_url(DOC_UUID, "Lens/Doc.md", Some("https://x/")),
            "https://x/abcd1234/Lens/Doc.md"
        );
    }

    #[test]
    fn relative_path_when_no_base() {
        assert_eq!(
            build_url(DOC_UUID, "Lens/Doc.md", None),
            "/abcd1234/Lens/Doc.md"
        );
    }

    #[test]
    fn short_uuid_shorter_than_prefix_len_does_not_panic() {
        assert_eq!(build_url("abcd", "Lens/Doc.md", None), "/abcd/Lens/Doc.md");
    }

    #[tokio::test]
    async fn execute_errors_when_doc_missing() {
        let server = build_test_server(&[("/Doc.md", "uuid-doc", "Hello")]).await;
        let result = execute(&server, &json!({ "file_path": "Lens/Missing.md" }));
        assert!(result.is_err(), "missing doc should error, got: {result:?}");
    }

    #[tokio::test]
    async fn execute_uses_real_resolved_prefix() {
        // The URL must embed the doc's real, resolved prefix.
        let server = build_test_server(&[("/Doc.md", DOC_UUID, "Hello")]).await;
        let out = execute(&server, &json!({ "file_path": "Lens/Doc.md" })).unwrap();
        assert!(
            out.contains("abcd1234/Lens/Doc.md"),
            "URL should contain the real prefix + slug, got: {out}"
        );
    }
}
