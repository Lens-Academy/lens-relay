use crate::server::Server;
use glob_match::glob_match;
use serde_json::Value;
use std::sync::Arc;

/// Execute the `glob` tool: pattern-match against document paths.
pub fn execute(server: &Arc<Server>, arguments: &Value) -> Result<String, String> {
    let pattern = arguments
        .get("pattern")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter: pattern".to_string())?;

    let path_scope = arguments.get("path").and_then(|v| v.as_str());

    let all_paths = server.doc_resolver().all_paths();

    // Build the scope prefix once (e.g. "Lens/")
    let prefix = path_scope.map(|scope| {
        if scope.ends_with('/') {
            scope.to_string()
        } else {
            format!("{}/", scope)
        }
    });

    let mut matched: Vec<String> = all_paths
        .into_iter()
        .filter(|p| {
            if let Some(ref pfx) = prefix {
                // Only include paths under the scope folder
                if !p.starts_with(pfx.as_str()) && p != pfx.trim_end_matches('/') {
                    return false;
                }
                // Match pattern against relative path (strip the scope prefix)
                let relative = p.strip_prefix(pfx.as_str()).unwrap_or(p);
                glob_match(pattern, relative)
            } else {
                glob_match(pattern, p)
            }
        })
        .collect();

    matched.sort();

    if matched.is_empty() {
        Ok("No matches found.".to_string())
    } else {
        Ok(matched.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use y_sweet_core::doc_resolver::DocumentResolver;
    use yrs::{Any, Doc, Map, Transact, WriteTxn};
    use std::collections::HashMap;

    const RELAY_ID: &str = "cb696037-0f72-4e93-8717-4e433129d789";
    const FOLDER_UUID: &str = "aaaa0000-0000-0000-0000-000000000000";

    fn folder_doc_id() -> String {
        format!("{}-{}", RELAY_ID, FOLDER_UUID)
    }

    fn create_folder_doc(entries: &[(&str, &str)]) -> Doc {
        let doc = Doc::new();
        {
            let mut txn = doc.transact_mut();
            let filemeta = txn.get_or_insert_map("filemeta_v0");
            for (path, uuid) in entries {
                let mut map = HashMap::new();
                map.insert("id".to_string(), Any::String((*uuid).into()));
                map.insert("type".to_string(), Any::String("markdown".into()));
                map.insert("version".to_string(), Any::Number(0.0));
                filemeta.insert(&mut txn, *path, Any::Map(map.into()));
            }
            let config = txn.get_or_insert_map("folder_config");
            config.insert(&mut txn, "name", Any::String("Lens".into()));
        }
        doc
    }

    fn build_test_server(entries: &[(&str, &str)]) -> Arc<Server> {
        let server = Server::new_for_test();
        let folder_doc = create_folder_doc(entries);
        server
            .doc_resolver()
            .update_folder_from_doc(&folder_doc_id(), &folder_doc);
        server
    }

    #[test]
    fn glob_scoped_subfolder_pattern() {
        // Bug: "subfolder/*" with path="Lens" should match "Lens/subfolder/file.md"
        let server = build_test_server(&[
            ("/subfolder/file.md", "uuid-1"),
            ("/other.md", "uuid-2"),
        ]);

        let result = execute(&server, &json!({"pattern": "subfolder/*", "path": "Lens"})).unwrap();
        assert!(
            result.contains("Lens/subfolder/file.md"),
            "Expected match for subfolder/file.md, got: {}",
            result
        );
        assert!(
            !result.contains("other.md"),
            "Should not match other.md, got: {}",
            result
        );
    }

    #[test]
    fn glob_no_scope_requires_full_path() {
        // Without path scope, pattern must match the full path
        let server = build_test_server(&[("/subfolder/file.md", "uuid-1")]);

        let result = execute(&server, &json!({"pattern": "subfolder/*"})).unwrap();
        assert_eq!(result, "No matches found.", "Without scope, subfolder/* shouldn't match Lens/subfolder/file.md");

        let result = execute(&server, &json!({"pattern": "Lens/subfolder/*"})).unwrap();
        assert!(
            result.contains("Lens/subfolder/file.md"),
            "Full path pattern should match, got: {}",
            result
        );
    }

    #[test]
    fn glob_scoped_wildcard_still_works() {
        // Regression: **/*.md with scope should still work
        let server = build_test_server(&[
            ("/subfolder/file.md", "uuid-1"),
            ("/top.md", "uuid-2"),
        ]);

        let result = execute(&server, &json!({"pattern": "**/*.md", "path": "Lens"})).unwrap();
        assert!(result.contains("Lens/subfolder/file.md"), "got: {}", result);
        assert!(result.contains("Lens/top.md"), "got: {}", result);
    }

    #[test]
    fn glob_scoped_direct_children_only() {
        // "*.md" with scope should match direct children only
        let server = build_test_server(&[
            ("/subfolder/nested.md", "uuid-1"),
            ("/top.md", "uuid-2"),
        ]);

        let result = execute(&server, &json!({"pattern": "*.md", "path": "Lens"})).unwrap();
        assert!(result.contains("Lens/top.md"), "got: {}", result);
        assert!(!result.contains("nested.md"), "*.md should not match nested files, got: {}", result);
    }
}
