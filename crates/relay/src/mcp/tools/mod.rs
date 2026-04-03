pub mod blob;
pub mod create_doc;
pub mod critic_diff;
pub mod critic_markup;
pub mod edit;
pub mod get_links;
pub mod glob;
pub mod grep;
pub mod move_doc;
pub mod read;
pub mod search;
#[cfg(test)]
pub(crate) mod test_helpers;

use crate::server::Server;
use serde_json::{json, Value};
use std::sync::Arc;

/// Return tool definitions for MCP tools/list response.
pub fn tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "create_session",
            "description": "Create a session for this conversation. Call this once before using other tools. Returns a session_id that must be passed to all subsequent tool calls.",
            "inputSchema": {
                "type": "object",
                "required": [],
                "additionalProperties": false,
                "properties": {}
            }
        }),
        json!({
            "name": "read",
            "description": "Reads a document from the knowledge base. Returns content with line numbers (cat -n format). Supports partial reads via offset and limit.",
            "inputSchema": {
                "type": "object",
                "required": ["file_path", "session_id"],
                "additionalProperties": false,
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Path to the document (e.g. 'Lens/Photosynthesis.md')"
                    },
                    "offset": {
                        "type": "number",
                        "description": "The line number to start reading from. Only provide if the document is too large to read at once"
                    },
                    "limit": {
                        "type": "number",
                        "description": "The number of lines to read. Only provide if the document is too large to read at once."
                    },
                    "session_id": {
                        "type": "string",
                        "description": "Session ID from create_session. Required for all tool calls."
                    }
                }
            }
        }),
        json!({
            "name": "glob",
            "description": "Fast document pattern matching. Returns matching document paths sorted alphabetically. Use to discover documents in the knowledge base.",
            "inputSchema": {
                "type": "object",
                "required": ["pattern", "session_id"],
                "additionalProperties": false,
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "The glob pattern to match documents against (e.g. '**/*.md', 'Lens/*.md', 'Lens Edu/**')"
                    },
                    "path": {
                        "type": "string",
                        "description": "Folder to scope the search to (e.g. 'Lens', 'Lens Edu'). If not specified, searches all folders."
                    },
                    "session_id": {
                        "type": "string",
                        "description": "Session ID from create_session. Required for all tool calls."
                    }
                }
            }
        }),
        json!({
            "name": "get_links",
            "description": "Get backlinks and forward links for a document. Returns document paths that link TO this document (backlinks) and paths this document links TO (forward links).",
            "inputSchema": {
                "type": "object",
                "required": ["file_path", "session_id"],
                "additionalProperties": false,
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Path to the document (e.g. 'Lens/Photosynthesis.md')"
                    },
                    "session_id": {
                        "type": "string",
                        "description": "Session ID from create_session. Required for all tool calls."
                    }
                }
            }
        }),
        json!({
            "name": "grep",
            "description": "Search document contents using regex patterns. Returns matching lines with context. Mirrors ripgrep output format.",
            "inputSchema": {
                "type": "object",
                "required": ["pattern", "session_id"],
                "additionalProperties": false,
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "The regular expression pattern to search for in document contents"
                    },
                    "path": {
                        "type": "string",
                        "description": "Folder to scope the search to (e.g. 'Lens', 'Lens Edu'). If not specified, searches all folders."
                    },
                    "output_mode": {
                        "type": "string",
                        "enum": ["content", "files_with_matches", "count"],
                        "description": "Output mode: 'content' shows matching lines, 'files_with_matches' shows file paths (default), 'count' shows match counts."
                    },
                    "-i": {
                        "type": "boolean",
                        "description": "Case insensitive search"
                    },
                    "-C": {
                        "type": "number",
                        "description": "Number of lines to show before and after each match"
                    },
                    "-A": {
                        "type": "number",
                        "description": "Number of lines to show after each match"
                    },
                    "-B": {
                        "type": "number",
                        "description": "Number of lines to show before each match"
                    },
                    "head_limit": {
                        "type": "number",
                        "description": "Limit output to first N entries. In files_with_matches/count mode limits files, in content mode limits output lines."
                    },
                    "session_id": {
                        "type": "string",
                        "description": "Session ID from create_session. Required for all tool calls."
                    }
                }
            }
        }),
        json!({
            "name": "edit",
            "description": "Edit a document by replacing old_string with new_string. For markdown: wrapped in CriticMarkup for human review. For JSON: direct text replacement. You must read the document first.",
            "inputSchema": {
                "type": "object",
                "required": ["file_path", "old_string", "new_string", "session_id"],
                "additionalProperties": false,
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Path to the document (e.g. 'Lens/Photosynthesis.md')"
                    },
                    "old_string": {
                        "type": "string",
                        "description": "The exact text to find and replace. Must match exactly and be unique in the document."
                    },
                    "new_string": {
                        "type": "string",
                        "description": "The replacement text. Empty string for deletion."
                    },
                    "session_id": {
                        "type": "string",
                        "description": "Session ID from create_session. Required for all tool calls."
                    }
                }
            }
        }),
        json!({
            "name": "create",
            "description": "Create a new document or file at the specified path. Supports .md (markdown) and .json files.",
            "inputSchema": {
                "type": "object",
                "required": ["file_path", "session_id"],
                "additionalProperties": false,
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Path for the new file (e.g. 'Lens/NewDoc.md', 'Lens Edu/data.json')"
                    },
                    "content": {
                        "type": "string",
                        "description": "Initial content. For markdown: wrapped in CriticMarkup. For JSON: raw content stored as-is."
                    },
                    "session_id": {
                        "type": "string",
                        "description": "Session ID from create_session. Required for all tool calls."
                    }
                }
            }
        }),
        json!({
            "name": "move",
            "description": "Move or rename a document. Automatically rewrites wikilinks in other documents that reference the moved file. Use for both renames (same folder, new filename) and cross-folder moves.",
            "inputSchema": {
                "type": "object",
                "required": ["file_path", "new_path", "session_id"],
                "additionalProperties": false,
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Current path of the document (e.g. 'Lens/Biology/Photosynthesis.md')"
                    },
                    "new_path": {
                        "type": "string",
                        "description": "New path within the target folder, starting with '/' (e.g. '/Science/Photosynthesis.md')"
                    },
                    "target_folder": {
                        "type": "string",
                        "description": "Target folder for cross-folder moves (e.g. 'Lens Edu'). Omit to stay in the same folder."
                    },
                    "session_id": {
                        "type": "string",
                        "description": "Session ID from create_session. Required for all tool calls."
                    }
                }
            }
        }),
        json!({
            "name": "search",
            "description": "Full-text search across the knowledge base using ranked relevance (BM25). Returns results sorted by relevance with snippets. Supports phrase search with quotes. Use this for natural-language queries; use grep for exact regex pattern matching.",
            "inputSchema": {
                "type": "object",
                "required": ["query", "session_id"],
                "additionalProperties": false,
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query. Supports multiple terms (AND semantics) and phrase search with quotes."
                    },
                    "limit": {
                        "type": "number",
                        "description": "Maximum number of results to return (default 20, max 100)."
                    },
                    "session_id": {
                        "type": "string",
                        "description": "Session ID from create_session. Required for all tool calls."
                    }
                }
            }
        }),
    ]
}

/// Dispatch a tool call to the correct handler and wrap result in MCP CallToolResult format.
pub async fn dispatch_tool(
    server: &Arc<Server>,
    transport_session_id: &str,
    name: &str,
    arguments: &Value,
) -> Value {
    // create_session returns the transport session_id — no argument validation needed
    if name == "create_session" {
        return tool_success(transport_session_id);
    }

    // All other tools require session_id argument and validation
    let session_id = match arguments.get("session_id").and_then(|v| v.as_str()) {
        Some(sid) => sid,
        None => return tool_error("Missing required parameter: session_id. Call create_session first and pass the returned session_id."),
    };

    if server.mcp_sessions.get_session(session_id).is_none() {
        return tool_error("Invalid session_id. Call create_session to get a valid session.");
    }

    // Lazy rebuild: if the resolver has no entries but docs exist, trigger a rebuild.
    // This handles the case where docs were created after server startup (e.g. local dev).
    if server.doc_resolver().all_paths().is_empty() {
        server.doc_resolver().rebuild(server.docs());
    }

    match name {
        "read" => match read::execute(server, session_id, arguments).await {
            Ok(text) => tool_success(&text),
            Err(msg) => tool_error(&msg),
        },
        "glob" => match glob::execute(server, arguments) {
            Ok(text) => tool_success(&text),
            Err(msg) => tool_error(&msg),
        },
        "get_links" => match get_links::execute(server, arguments).await {
            Ok(text) => tool_success(&text),
            Err(msg) => tool_error(&msg),
        },
        "grep" => match grep::execute(server, arguments).await {
            Ok(text) => tool_success(&text),
            Err(msg) => tool_error(&msg),
        },
        "edit" => match edit::execute(server, session_id, arguments).await {
            Ok(text) => tool_success(&text),
            Err(msg) => tool_error(&msg),
        },
        "create" => match create_doc::execute(server, arguments).await {
            Ok(text) => tool_success(&text),
            Err(msg) => tool_error(&msg),
        },
        "move" => match move_doc::execute(server, arguments).await {
            Ok(text) => tool_success(&text),
            Err(msg) => tool_error(&msg),
        },
        "search" => match search::execute(server, arguments).await {
            Ok(text) => tool_success(&text),
            Err(msg) => tool_error(&msg),
        },
        _ => tool_error(&format!("Unknown tool: {}", name)),
    }
}

/// Wrap successful tool output in MCP CallToolResult format.
fn tool_success(text: &str) -> Value {
    json!({
        "content": [
            {
                "type": "text",
                "text": text
            }
        ],
        "isError": false
    })
}

/// Wrap tool error in MCP CallToolResult format (tool-level error, not protocol error).
fn tool_error(msg: &str) -> Value {
    json!({
        "content": [
            {
                "type": "text",
                "text": msg
            }
        ],
        "isError": true
    })
}

#[cfg(test)]
mod integration_tests {
    use super::{create_doc, edit, glob, grep, read};
    use super::test_helpers::*;
    use serde_json::json;

    #[tokio::test]
    async fn json_file_create_read_edit_roundtrip() {
        let server = build_blob_test_server_with_folder().await;
        let sid = setup_session_no_reads(&server);

        // 1. Create JSON file
        let create_result = create_doc::execute(
            &server,
            &json!({
                "file_path": "Lens/config.json",
                "content": r#"{"version": 1, "name": "test"}"#,
            }),
        )
        .await
        .unwrap();
        assert!(
            create_result.contains("Created"),
            "Create result: {}",
            create_result
        );

        // 2. Glob finds it
        let glob_result = glob::execute(
            &server,
            &json!({
                "pattern": "**/*.json",
                "session_id": sid,
            }),
        )
        .unwrap();
        assert!(
            glob_result.contains("config.json"),
            "Glob should find JSON: {}",
            glob_result
        );

        // 3. Read it (also marks as read for edit)
        let read_result = read::execute(
            &server,
            &sid,
            &json!({
                "file_path": "Lens/config.json",
                "session_id": sid,
            }),
        )
        .await
        .unwrap();
        assert!(
            read_result.contains(r#""version": 1"#),
            "Read should contain version: {}",
            read_result
        );

        // 4. Edit it
        let edit_result = edit::execute(
            &server,
            &sid,
            &json!({
                "file_path": "Lens/config.json",
                "old_string": r#""version": 1"#,
                "new_string": r#""version": 2"#,
                "session_id": sid,
            }),
        )
        .await
        .unwrap();
        assert!(
            edit_result.contains("Edited"),
            "Edit result: {}",
            edit_result
        );

        // 5. Read again to verify edit persisted
        let read_result2 = read::execute(
            &server,
            &sid,
            &json!({
                "file_path": "Lens/config.json",
                "session_id": sid,
            }),
        )
        .await
        .unwrap();
        assert!(
            read_result2.contains(r#""version": 2"#),
            "Should have v2: {}",
            read_result2
        );
        assert!(
            !read_result2.contains(r#""version": 1"#),
            "Should not have v1: {}",
            read_result2
        );

        // 6. Grep finds content
        let grep_result = grep::execute(
            &server,
            &json!({
                "pattern": "test",
                "session_id": sid,
            }),
        )
        .await
        .unwrap();
        assert!(
            grep_result.contains("config.json"),
            "Grep should find: {}",
            grep_result
        );
    }
}
