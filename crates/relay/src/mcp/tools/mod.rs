pub mod blob;
pub mod create_doc;
pub mod critic_diff;
pub mod critic_markup;
pub mod edit;
pub mod get_links;
pub mod get_url;
pub mod glob;
pub mod grep;
pub mod import_article;
pub mod move_doc;
pub mod read;
pub mod search;
pub mod session_intro;
#[cfg(test)]
pub(crate) mod test_helpers;
pub mod validate_content;

use crate::server::Server;
use serde_json::{json, Value};
use std::sync::Arc;
use y_sweet_core::share_token::McpAccess;

/// Return tool definitions for MCP tools/list response.
/// When `writable` is false, write tools (edit, create, move) are excluded.
pub fn tool_definitions(writable: bool) -> Vec<Value> {
    let mut tools = vec![
        json!({
            "name": "create_session",
            "description": "Create a session for this conversation. Call this once before using other tools. The first line of the response is the session_id that must be passed to all subsequent tool calls; any text after it is orientation notes from the knowledge base — follow their reading pointers when they match your task. Pass `name` to attribute suggestions to the user (shown as \"{name}'s AI\" in the review UI).",
            "inputSchema": {
                "type": "object",
                "required": [],
                "additionalProperties": false,
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "User's first name; suggestions show as \"{name}'s AI\". Ask the user if you don't reliably know it. Omit if truly unavailable."
                    }
                }
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
                        "description": "Session ID returned by create_session. Required."
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
                        "description": "Session ID returned by create_session. Required."
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
                        "description": "Session ID returned by create_session. Required."
                    }
                }
            }
        }),
        json!({
            "name": "get_url",
            "description": "Get the Lens Editor URL for a document. Returns the canonical link to open the document in the editor. Use this instead of constructing editor URLs by hand — the URL contains a per-document id that is not guessable.",
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
                        "description": "Session ID returned by create_session. Required."
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
                        "description": "Session ID returned by create_session. Required."
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
                        "description": "Session ID returned by create_session. Required."
                    }
                }
            }
        }),
        json!({
            "name": "validate_content",
            "description": "Validate the folder's course content with the platform content validator (same engine as staging.lensacademy.org/validate) and return errors/warnings. accept_drafts=false validates only human-approved content; accept_drafts=true validates as if all pending suggestions were accepted — use it to check your own drafts before handing them to a reviewer. Filter by course slug ('__orphaned__' for files no course reaches) and category ('production' blocks releases, 'wip' is draft-only). Run this after making suggestions and fix production-category errors in files you touched.",
            "inputSchema": {
                "type": "object",
                "required": ["session_id"],
                "additionalProperties": false,
                "properties": {
                    "accept_drafts": {
                        "type": "boolean",
                        "description": "Validate with all pending suggestions applied (default false)"
                    },
                    "course": {
                        "type": "string",
                        "description": "Only issues in files reachable from this course slug; '__orphaned__' for files no course reaches"
                    },
                    "category": {
                        "type": "string",
                        "enum": ["production", "wip"],
                        "description": "Only issues of this category"
                    },
                    "session_id": {
                        "type": "string",
                        "description": "Session ID returned by create_session. Required."
                    }
                }
            }
        }),
    ];

    if writable {
        tools.push(json!({
            "name": "import_article",
            "description": "Import external articles/webpages into the knowledge base via the article importer. Give it URLs; the server fetches and extracts the full text, writes 'Lens Edu/articles/<author>-<title>.md' with correct frontmatter, and (by default) creates a stub lens. Jobs run in the background — poll import_status until each is done/failed. YouTube URLs are rejected (video imports need the browser bookmarklet). Prefer this over hand-writing article files.",
            "inputSchema": {
                "type": "object",
                "required": ["urls", "session_id"],
                "additionalProperties": false,
                "properties": {
                    "urls": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Article URLs to import (max 20, http/https)"
                    },
                    "create_lens": {
                        "type": "boolean",
                        "description": "Also create a stub lens per article (default true)"
                    },
                    "session_id": {
                        "type": "string",
                        "description": "Session ID returned by create_session. Required."
                    }
                }
            }
        }));
        tools.push(json!({
            "name": "import_status",
            "description": "Check the status of article import jobs started with import_article (queued / processing / done / failed, with document paths and errors).",
            "inputSchema": {
                "type": "object",
                "required": ["session_id"],
                "additionalProperties": false,
                "properties": {
                    "session_id": {
                        "type": "string",
                        "description": "Session ID returned by create_session. Required."
                    }
                }
            }
        }));
        tools.push(json!({
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
                        "description": "The replacement text. Empty string for deletion. To leave a comment for human reviewers, wrap a note in comment delimiters, e.g. '{>>your note<<}'; it is automatically attributed to your session (do not add author metadata yourself)."
                    },
                    "session_id": {
                        "type": "string",
                        "description": "Session ID returned by create_session. Required."
                    }
                }
            }
        }));
        tools.push(json!({
            "name": "create",
            "description": "Create a new document or file at the specified path. Supports .md (markdown — wrapped in CriticMarkup), .html (raw HTML stored as-is, rendered by the HtmlEditor), and .json (raw content stored as-is).",
            "inputSchema": {
                "type": "object",
                "required": ["file_path", "session_id"],
                "additionalProperties": false,
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Path for the new file (e.g. 'Lens/NewDoc.md', 'Lens/Page.html', 'Lens Edu/data.json')"
                    },
                    "content": {
                        "type": "string",
                        "description": "Initial content. For markdown: wrapped in CriticMarkup. For HTML and JSON: raw content stored as-is."
                    },
                    "session_id": {
                        "type": "string",
                        "description": "Session ID returned by create_session. Required."
                    }
                }
            }
        }));
        tools.push(json!({
            "name": "move",
            "description": "Move or rename a file or folder. Automatically rewrites wikilinks in other documents that reference moved files. Use for file renames, file moves, and folder renames.",
            "inputSchema": {
                "type": "object",
                "required": ["new_path", "session_id"],
                "additionalProperties": false,
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Current path of the file or folder (e.g. 'Lens/Biology/Photosynthesis.md' or 'Lens/Biology'). Required unless file_path is provided."
                    },
                    "file_path": {
                        "type": "string",
                        "description": "Deprecated alias for path."
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
                        "description": "Session ID returned by create_session. Required."
                    }
                }
            }
        }));
    }

    tools
}

/// Dispatch a tool call to the correct handler and wrap result in MCP CallToolResult format.
pub async fn dispatch_tool(
    server: &Arc<Server>,
    name: &str,
    arguments: &Value,
    access: &McpAccess,
) -> Value {
    // create_session allocates a fresh app session and returns its id.
    //
    // The LLM is responsible for passing this id back as the `session_id`
    // argument on every subsequent tool call. We do *not* store the id in the
    // transport-layer `mcp-session-id` header — see the module-level rationale
    // in `mcp/session.rs` for why session identity lives in the JSON-RPC
    // payload rather than the HTTP transport.
    if name == "create_session" {
        let human_name = arguments.get("name").and_then(|v| v.as_str());
        let sid = server
            .mcp_sessions
            .create_session(access.clone(), human_name);
        // Append curator-maintained orientation notes, if any folder the
        // token can access has an "AI Guide/_intro.md" (see session_intro).
        return match session_intro::session_intro(server, access).await {
            Some(intro) => tool_success(&format!("{}\n\n{}", sid, intro)),
            None => tool_success(&sid),
        };
    }

    // All other tools require session_id argument and validation
    let session_id = match arguments.get("session_id").and_then(|v| v.as_str()) {
        Some(sid) => sid,
        None => return tool_error("Missing required parameter: session_id. Call create_session first and pass the returned session_id."),
    };

    if server.mcp_sessions.get_session(session_id).is_none() {
        return tool_error("Invalid session_id. Call create_session to get a valid session.");
    }

    // Refresh activity so cleanup_stale doesn't evict an actively-used session.
    server.mcp_sessions.touch(session_id);

    // Defense-in-depth: block write tools for read-only access
    if !access.writable
        && matches!(
            name,
            "edit" | "create" | "move" | "import_article" | "import_status"
        )
    {
        return tool_error("Access denied: read-only access. Cannot use write tools.");
    }

    // Folder scope check: restrict tools to the allowed folder
    if let Some(ref allowed_folder) = access.folder_name {
        // Check file_path argument
        if let Some(file_path) = arguments.get("file_path").and_then(|v| v.as_str()) {
            if !file_path.starts_with(&format!("{}/", allowed_folder))
                && file_path != *allowed_folder
            {
                return tool_error(&format!(
                    "Access denied: this key only has access to '{}'. Requested path: '{}'",
                    allowed_folder, file_path
                ));
            }
        }
        // Check path argument (glob/grep scope)
        if let Some(path) = arguments.get("path").and_then(|v| v.as_str()) {
            if !path.starts_with(&format!("{}/", allowed_folder)) && path != *allowed_folder {
                return tool_error(&format!(
                    "Access denied: this key only has access to '{}'.",
                    allowed_folder
                ));
            }
        }
        // Check target_folder for move tool
        if name == "move" {
            if let Some(target_folder) = arguments.get("target_folder").and_then(|v| v.as_str()) {
                if target_folder != *allowed_folder {
                    return tool_error(&format!(
                        "Access denied: cannot move to '{}'. This key only has access to '{}'.",
                        target_folder, allowed_folder
                    ));
                }
            }
        }
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
        "get_url" => match get_url::execute(server, arguments) {
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
        "create" => match create_doc::execute(server, session_id, arguments).await {
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
        "import_article" => match import_article::execute(access, arguments).await {
            Ok(text) => tool_success(&text),
            Err(msg) => tool_error(&msg),
        },
        "import_status" => match import_article::status(access).await {
            Ok(text) => tool_success(&text),
            Err(msg) => tool_error(&msg),
        },
        "validate_content" => match validate_content::execute(server, access, arguments).await {
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
    use super::test_helpers::*;
    use super::{create_doc, edit, glob, grep, read};
    use serde_json::json;

    #[test]
    fn move_schema_allows_file_path_alias_without_requiring_path() {
        let tools = super::tool_definitions(true);
        let move_tool = tools
            .iter()
            .find(|tool| tool["name"] == "move")
            .expect("move tool should be present");

        assert_eq!(
            move_tool["inputSchema"]["required"],
            json!(["new_path", "session_id"])
        );
        assert!(move_tool["inputSchema"]["properties"]["path"].is_object());
        assert!(move_tool["inputSchema"]["properties"]["file_path"].is_object());
    }

    #[tokio::test]
    async fn dispatch_get_url_end_to_end() {
        use y_sweet_core::share_token::McpAccess;

        let server = build_blob_test_server_with_folder().await;
        let access = McpAccess {
            writable: true,
            folder_uuid: None,
            folder_name: None,
            raw_token: None,
        };

        // get_url must be advertised even for read-only sessions.
        assert!(
            super::tool_definitions(false)
                .iter()
                .any(|t| t["name"] == "get_url"),
            "get_url should be advertised for read-only sessions"
        );

        // Drive the real MCP entrypoint: create_session -> create -> get_url.
        let sess = super::dispatch_tool(
            &server,
            "create_session",
            &json!({ "name": "Test" }),
            &access,
        )
        .await;
        let sid = sess["content"][0]["text"].as_str().unwrap().to_string();

        let created = super::dispatch_tool(
            &server,
            "create",
            &json!({ "file_path": "Lens/Doc.md", "content": "hello", "session_id": sid }),
            &access,
        )
        .await;
        assert_eq!(created["isError"], json!(false), "create failed: {created}");

        let res = super::dispatch_tool(
            &server,
            "get_url",
            &json!({ "file_path": "Lens/Doc.md", "session_id": sid }),
            &access,
        )
        .await;
        assert_eq!(res["isError"], json!(false), "get_url errored: {res}");

        // The URL must embed the doc's real, freshly generated prefix.
        let text = res["content"][0]["text"].as_str().unwrap();
        let uuid = server
            .doc_resolver()
            .resolve_path("Lens/Doc.md")
            .unwrap()
            .uuid;
        let prefix = &uuid[..8];
        assert!(
            text.contains(&format!("{}/Lens/Doc.md", prefix)),
            "URL should embed the real doc prefix {prefix}, got: {text}"
        );
    }

    #[tokio::test]
    async fn json_file_create_read_edit_roundtrip() {
        let server = build_blob_test_server_with_folder().await;
        let sid = setup_session_no_reads(&server);

        // 1. Create JSON file
        let create_result = create_doc::execute(
            &server,
            &sid,
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
