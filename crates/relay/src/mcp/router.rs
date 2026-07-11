use serde_json::{json, Value};
use std::sync::Arc;
use tracing::debug;
use y_sweet_core::share_token::McpAccess;

use super::jsonrpc::{
    error_response, success_response, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse,
    METHOD_NOT_FOUND,
};
use super::tools;
use crate::server::Server;

/// Dispatch a JSON-RPC request to the appropriate handler.
///
/// The transport is stateless: there is no transport-layer session. App-level
/// sessions are managed by the `create_session` MCP tool — see `tools::dispatch_tool`.
pub async fn dispatch_request(
    server: &Arc<Server>,
    request: &JsonRpcRequest,
    access: &McpAccess,
) -> JsonRpcResponse {
    match request.method.as_str() {
        "initialize" => handle_initialize(request.id.clone(), request.params.as_ref(), access),
        "ping" => handle_ping(request.id.clone()),
        // `writable` comes from the per-request `McpAccess` set by the auth
        // middleware (Bearer token or path key). With a stateless transport
        // there's no app session to read it from, but tokens are immutable so
        // every request from a given client carries the same access anyway.
        "tools/list" => handle_tools_list(request.id.clone(), access.writable),
        "tools/call" => {
            handle_tools_call(server, request.id.clone(), request.params.as_ref(), access).await
        }
        _ => error_response(
            request.id.clone(),
            METHOD_NOT_FOUND,
            format!("Method not found: {}", request.method),
        ),
    }
}

/// Handle a JSON-RPC notification (no response expected).
pub fn handle_notification(notification: &JsonRpcNotification) {
    match notification.method.as_str() {
        "notifications/initialized" => {
            debug!("notifications/initialized received (transport is stateless, no-op)");
        }
        "notifications/cancelled" => {
            debug!(
                method = "notifications/cancelled",
                "Cancellation notification received (no-op)"
            );
        }
        other => {
            debug!(method = other, "Unknown notification received");
        }
    }
}

fn handle_initialize(id: Value, params: Option<&Value>, access: &McpAccess) -> JsonRpcResponse {
    let protocol_version = params
        .and_then(|p| p.get("protocolVersion"))
        .and_then(|v| v.as_str())
        .unwrap_or("2025-03-26")
        .to_string();

    let negotiated_version = "2025-03-26".to_string();

    debug!(
        client_version = %protocol_version,
        negotiated_version = %negotiated_version,
        "MCP initialize request"
    );

    let description = match (&access.folder_name, access.writable) {
        (Some(name), true) => format!("Lens Relay MCP — full read/write access to {}", name),
        (Some(name), false) => format!(
            "Lens Relay MCP — read-only access to {}. You can search, read, and browse documents but cannot edit, create, or move them.",
            name
        ),
        (None, true) => "Lens Relay MCP — full read/write access to all folders".to_string(),
        (None, false) => "Lens Relay MCP — read-only access to all folders. You can search, read, and browse documents but cannot edit, create, or move them.".to_string(),
    };

    success_response(
        id,
        json!({
            "protocolVersion": negotiated_version,
            "capabilities": {
                "tools": {}
            },
            "serverInfo": {
                "name": "lens-relay",
                "version": env!("CARGO_PKG_VERSION"),
                "description": description
            }
        }),
    )
}

fn handle_ping(id: Value) -> JsonRpcResponse {
    success_response(id, json!({}))
}

fn handle_tools_list(id: Value, writable: bool) -> JsonRpcResponse {
    let definitions = tools::tool_definitions(writable);
    success_response(id, json!({ "tools": definitions }))
}

async fn handle_tools_call(
    server: &Arc<Server>,
    id: Value,
    params: Option<&Value>,
    access: &McpAccess,
) -> JsonRpcResponse {
    let (name, arguments) = match params {
        Some(p) => {
            let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let arguments = p.get("arguments").cloned().unwrap_or(json!({}));
            (name.to_string(), arguments)
        }
        None => {
            return success_response(
                id,
                tools::dispatch_tool(server, "", &json!({}), access).await,
            );
        }
    };

    let result = tools::dispatch_tool(server, &name, &arguments, access).await;
    success_response(id, result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn default_access() -> McpAccess {
        McpAccess {
            writable: true,
            folder_uuid: None,
            folder_name: None,
        }
    }

    fn make_request(id: Value, method: &str, params: Option<Value>) -> JsonRpcRequest {
        JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id,
            method: method.into(),
            params,
        }
    }

    fn make_notification(method: &str, params: Option<Value>) -> JsonRpcNotification {
        JsonRpcNotification {
            jsonrpc: "2.0".into(),
            method: method.into(),
            params,
        }
    }

    /// Create a minimal Server for testing (no store, no auth, no docs).
    fn test_server() -> Arc<Server> {
        Server::new_for_test()
    }

    #[tokio::test]
    async fn initialize_returns_capabilities_without_session() {
        let server = test_server();
        let req = make_request(
            json!(1),
            "initialize",
            Some(json!({
                "protocolVersion": "2025-03-26",
                "clientInfo": {"name": "test-client", "version": "1.0"}
            })),
        );

        let resp = dispatch_request(&server, &req, &default_access()).await;

        assert_eq!(resp.jsonrpc, "2.0");
        assert_eq!(resp.id, json!(1));
        assert!(resp.error.is_none());

        let result = resp.result.expect("should have result");
        assert_eq!(result["protocolVersion"], "2025-03-26");
        assert!(result["capabilities"]["tools"].is_object());
        assert_eq!(result["serverInfo"]["name"], "lens-relay");
        assert!(result["serverInfo"]["version"].is_string());

        // Initialize should NOT create any app session.
        // (App sessions are now allocated only by the create_session tool.)
    }

    #[tokio::test]
    async fn ping_returns_empty_result() {
        let server = test_server();
        let req = make_request(json!(2), "ping", None);

        let resp = dispatch_request(&server, &req, &default_access()).await;

        assert_eq!(resp.id, json!(2));
        assert!(resp.error.is_none());
        assert_eq!(resp.result.unwrap(), json!({}));
    }

    #[tokio::test]
    async fn tools_list_returns_all_tools() {
        let server = test_server();
        let req = make_request(json!(3), "tools/list", None);

        let resp = dispatch_request(&server, &req, &default_access()).await;

        assert_eq!(resp.id, json!(3));
        assert!(resp.error.is_none());

        let result = resp.result.unwrap();
        assert!(result["tools"].is_array());
        let tools_arr = result["tools"].as_array().unwrap();
        assert_eq!(tools_arr.len(), 11);

        let names: Vec<&str> = tools_arr
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"create_session"));
        assert!(names.contains(&"read"));
        assert!(names.contains(&"glob"));
        assert!(names.contains(&"get_links"));
        assert!(names.contains(&"grep"));
        assert!(names.contains(&"edit"));
        assert!(names.contains(&"create"));
        assert!(names.contains(&"move"));
        assert!(names.contains(&"search"));
        assert!(names.contains(&"get_url"));
        assert!(names.contains(&"validate_content"));
    }

    #[tokio::test]
    async fn tools_call_without_session_id_arg_returns_tool_error() {
        let server = test_server();
        let req = make_request(
            json!(4),
            "tools/call",
            Some(json!({"name": "read", "arguments": {"file_path": "test"}})),
        );

        let resp = dispatch_request(&server, &req, &default_access()).await;

        // Now this is a successful JSON-RPC response with isError=true
        assert!(resp.error.is_none());
        let result = resp.result.expect("should have result");
        assert_eq!(result["isError"], true);
        let text = result["content"][0]["text"].as_str().unwrap();
        assert!(
            text.to_lowercase().contains("session"),
            "error message should mention session: {}",
            text
        );
    }

    #[tokio::test]
    async fn tools_call_with_invalid_session_id_returns_tool_error() {
        let server = test_server();
        let req = make_request(
            json!(8),
            "tools/call",
            Some(json!({
                "name": "read",
                "arguments": {"file_path": "test", "session_id": "definitely-not-a-real-session"}
            })),
        );

        let resp = dispatch_request(&server, &req, &default_access()).await;

        assert!(resp.error.is_none());
        let result = resp.result.expect("should have result");
        assert_eq!(result["isError"], true);
        let text = result["content"][0]["text"].as_str().unwrap();
        assert!(
            text.to_lowercase().contains("invalid session"),
            "error should hint at invalid session: {}",
            text
        );
    }

    #[tokio::test]
    async fn tools_call_unknown_tool_returns_tool_error() {
        let server = test_server();
        let sid = server.mcp_sessions.create_session(default_access(), None);

        let req = make_request(
            json!(5),
            "tools/call",
            Some(json!({"name": "nonexistent_tool", "arguments": {"session_id": &sid}})),
        );

        let resp = dispatch_request(&server, &req, &default_access()).await;

        assert!(resp.error.is_none());
        let result = resp.result.expect("should have result");
        assert_eq!(result["isError"], true);
        let text = result["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("Unknown tool"));
    }

    #[tokio::test]
    async fn unknown_method_returns_method_not_found() {
        let server = test_server();
        let req = make_request(json!(6), "foo/bar", None);

        let resp = dispatch_request(&server, &req, &default_access()).await;

        assert!(resp.result.is_none());
        let err = resp.error.expect("should have error");
        assert_eq!(err.code, METHOD_NOT_FOUND);
        assert!(err.message.contains("foo/bar"));
    }

    #[test]
    fn notifications_initialized_is_noop() {
        let notif = make_notification("notifications/initialized", None);
        // Should not panic; transport is stateless so there's nothing to mark.
        handle_notification(&notif);
    }

    #[test]
    fn notifications_cancelled_is_noop() {
        let notif = make_notification("notifications/cancelled", Some(json!({"requestId": 1})));
        handle_notification(&notif);
    }

    #[tokio::test]
    async fn read_records_doc_in_session() {
        use std::collections::HashMap;
        use yrs::{Any, Doc, Map, Text, Transact, WriteTxn};

        let server = test_server();

        let relay_id = "cb696037-0f72-4e93-8717-4e433129d789";
        let folder_uuid = "aaaa0000-0000-0000-0000-000000000000";
        let content_uuid = "uuid-test-read";
        let folder_doc_id = format!("{}-{}", relay_id, folder_uuid);
        let content_doc_id = format!("{}-{}", relay_id, content_uuid);

        let folder_doc = Doc::new();
        {
            let mut txn = folder_doc.transact_mut();
            let filemeta = txn.get_or_insert_map("filemeta_v0");
            let mut map = HashMap::new();
            map.insert("id".to_string(), Any::String(content_uuid.into()));
            map.insert("type".to_string(), Any::String("markdown".into()));
            map.insert("version".to_string(), Any::Number(0.0));
            filemeta.insert(&mut txn, "/TestDoc.md", Any::Map(map.into()));
            let config = txn.get_or_insert_map("folder_config");
            config.insert(&mut txn, "name", Any::String("Lens".into()));
        }

        server
            .doc_resolver()
            .update_folder_from_doc(&folder_doc_id, &folder_doc);

        let dwskv = y_sweet_core::doc_sync::DocWithSyncKv::new(&content_doc_id, None, || (), None)
            .await
            .unwrap();
        {
            let awareness = dwskv.awareness();
            let mut guard = awareness.write().unwrap();
            let mut txn = guard.doc.transact_mut();
            let text = txn.get_or_insert_text("contents");
            text.insert(&mut txn, 0, "test content");
        }
        server.docs().insert(content_doc_id.clone(), dwskv);

        // Allocate an app session via SessionManager directly.
        let sid = server.mcp_sessions.create_session(default_access(), None);

        // Verify read_docs is empty before read
        {
            let session = server.mcp_sessions.get_session(&sid).unwrap();
            assert!(session.read_docs.is_empty(), "read_docs should start empty");
        }

        // Call read tool via dispatch, passing session_id as argument.
        let req = make_request(
            json!(10),
            "tools/call",
            Some(
                json!({"name": "read", "arguments": {"file_path": "Lens/TestDoc.md", "session_id": &sid}}),
            ),
        );
        let resp = dispatch_request(&server, &req, &default_access()).await;
        assert!(resp.error.is_none(), "read should succeed");

        {
            let session = server.mcp_sessions.get_session(&sid).unwrap();
            assert!(
                session.read_docs.contains(&content_doc_id),
                "read_docs should contain {} after read, got: {:?}",
                content_doc_id,
                session.read_docs
            );
        }
    }

    #[tokio::test]
    async fn create_session_then_read_then_edit() {
        use std::collections::HashMap;
        use yrs::{Any, Doc, Map, Text, Transact, WriteTxn};

        let server = test_server();

        let relay_id = "cb696037-0f72-4e93-8717-4e433129d789";
        let folder_uuid = "aaaa0000-0000-0000-0000-000000000000";
        let content_uuid = "uuid-rte";
        let folder_doc_id = format!("{}-{}", relay_id, folder_uuid);
        let content_doc_id = format!("{}-{}", relay_id, content_uuid);

        let folder_doc = Doc::new();
        {
            let mut txn = folder_doc.transact_mut();
            let filemeta = txn.get_or_insert_map("filemeta_v0");
            let mut map = HashMap::new();
            map.insert("id".to_string(), Any::String(content_uuid.into()));
            map.insert("type".to_string(), Any::String("markdown".into()));
            map.insert("version".to_string(), Any::Number(0.0));
            filemeta.insert(&mut txn, "/EditTest.md", Any::Map(map.into()));
            let config = txn.get_or_insert_map("folder_config");
            config.insert(&mut txn, "name", Any::String("Lens".into()));
        }

        server
            .doc_resolver()
            .update_folder_from_doc(&folder_doc_id, &folder_doc);

        let dwskv = y_sweet_core::doc_sync::DocWithSyncKv::new(&content_doc_id, None, || (), None)
            .await
            .unwrap();
        {
            let awareness = dwskv.awareness();
            let mut guard = awareness.write().unwrap();
            let mut txn = guard.doc.transact_mut();
            let text = txn.get_or_insert_text("contents");
            text.insert(&mut txn, 0, "hello world");
        }
        server.docs().insert(content_doc_id.clone(), dwskv);

        // Step 1: create_session tool allocates a fresh app session.
        let create_req = make_request(
            json!(19),
            "tools/call",
            Some(json!({"name": "create_session", "arguments": {}})),
        );
        let create_resp = dispatch_request(&server, &create_req, &default_access()).await;
        assert!(create_resp.error.is_none(), "create_session should succeed");
        let create_result = create_resp.result.unwrap();
        let session_id = create_result["content"][0]["text"]
            .as_str()
            .expect("create_session should return a string id")
            .to_string();
        assert_eq!(session_id.len(), 8);
        assert!(
            server.mcp_sessions.get_session(&session_id).is_some(),
            "create_session should register the new session"
        );

        // Step 2: read with the new session_id.
        let read_req = make_request(
            json!(20),
            "tools/call",
            Some(
                json!({"name": "read", "arguments": {"file_path": "Lens/EditTest.md", "session_id": &session_id}}),
            ),
        );
        let read_resp = dispatch_request(&server, &read_req, &default_access()).await;
        assert!(read_resp.error.is_none(), "read should succeed");

        // Step 3: edit with the same session_id, succeeds because read_docs has the doc.
        let edit_req = make_request(
            json!(21),
            "tools/call",
            Some(json!({
                "name": "edit",
                "arguments": {
                    "file_path": "Lens/EditTest.md",
                    "old_string": "hello",
                    "new_string": "goodbye",
                    "session_id": &session_id
                }
            })),
        );

        let edit_resp = dispatch_request(&server, &edit_req, &default_access()).await;
        assert!(
            edit_resp.error.is_none(),
            "edit should succeed at protocol level"
        );

        let edit_result = edit_resp.result.unwrap();
        assert_eq!(
            edit_result["isError"], false,
            "edit tool should succeed: {}",
            edit_result["content"][0]["text"]
        );
    }

    #[tokio::test]
    async fn tools_list_readonly_hides_write_tools() {
        use y_sweet_core::share_token::McpAccess;

        let server = test_server();
        let readonly_access = McpAccess {
            writable: false,
            folder_uuid: None,
            folder_name: None,
        };

        let req = make_request(json!(50), "tools/list", None);
        let resp = dispatch_request(&server, &req, &readonly_access).await;

        let result = resp.result.unwrap();
        let tools_arr = result["tools"].as_array().unwrap();
        let names: Vec<&str> = tools_arr
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();

        assert!(names.contains(&"read"));
        assert!(names.contains(&"glob"));
        assert!(names.contains(&"grep"));
        assert!(names.contains(&"get_links"));
        assert!(names.contains(&"search"));
        assert!(names.contains(&"create_session"));

        assert!(
            !names.contains(&"edit"),
            "read-only should not see edit, got: {:?}",
            names
        );
        assert!(
            !names.contains(&"create"),
            "read-only should not see create, got: {:?}",
            names
        );
        assert!(
            !names.contains(&"move"),
            "read-only should not see move, got: {:?}",
            names
        );
    }

    #[tokio::test]
    async fn folder_scoped_tool_rejects_wrong_folder() {
        use std::collections::HashMap;
        use y_sweet_core::share_token::McpAccess;
        use yrs::{Any, Doc, Map, Transact, WriteTxn};

        let server = test_server();

        let relay_id = "cb696037-0f72-4e93-8717-4e433129d789";
        let folder_uuid = "aaaa0000-0000-0000-0000-000000000000";
        let folder_doc_id = format!("{}-{}", relay_id, folder_uuid);

        let folder_doc = Doc::new();
        {
            let mut txn = folder_doc.transact_mut();
            let filemeta = txn.get_or_insert_map("filemeta_v0");
            let mut map = HashMap::new();
            map.insert("id".to_string(), Any::String("uuid-scope-test".into()));
            map.insert("type".to_string(), Any::String("markdown".into()));
            map.insert("version".to_string(), Any::Number(0.0));
            filemeta.insert(&mut txn, "/Test.md", Any::Map(map.into()));
            let config = txn.get_or_insert_map("folder_config");
            config.insert(&mut txn, "name", Any::String("Lens".into()));
        }
        server
            .doc_resolver()
            .update_folder_from_doc(&folder_doc_id, &folder_doc);

        let scoped_access = McpAccess {
            writable: true,
            folder_uuid: Some("bbbb0000-0000-0000-0000-000000000000".to_string()),
            folder_name: Some("Lens Edu".to_string()),
        };
        let sid = server
            .mcp_sessions
            .create_session(scoped_access.clone(), None);

        let req = make_request(
            json!(51),
            "tools/call",
            Some(
                json!({"name": "read", "arguments": {"file_path": "Lens/Test.md", "session_id": &sid}}),
            ),
        );
        let resp = dispatch_request(&server, &req, &scoped_access).await;
        let result = resp.result.unwrap();
        assert_eq!(result["isError"], true, "should deny access: {:?}", result);
        let text = result["content"][0]["text"].as_str().unwrap();
        assert!(
            text.contains("Access denied"),
            "should deny access: {}",
            text
        );
    }

    #[tokio::test]
    async fn create_session_returns_fresh_id() {
        let server = test_server();

        let req = make_request(
            json!(30),
            "tools/call",
            Some(json!({"name": "create_session", "arguments": {}})),
        );

        let resp = dispatch_request(&server, &req, &default_access()).await;
        assert!(resp.error.is_none(), "create_session should succeed");

        let result = resp.result.unwrap();
        assert_eq!(result["isError"], false);

        let returned_id = result["content"][0]["text"].as_str().unwrap();
        assert_eq!(returned_id.len(), 8);

        assert!(
            server.mcp_sessions.get_session(returned_id).is_some(),
            "returned session_id should exist in SessionManager"
        );
    }

    #[tokio::test]
    async fn create_session_after_cleanup_returns_new_id() {
        let server = test_server();

        // Allocate one, then evict everything via cleanup.
        let stale_sid = server.mcp_sessions.create_session(default_access(), None);
        server
            .mcp_sessions
            .cleanup_stale(std::time::Duration::from_secs(0));
        assert!(server.mcp_sessions.get_session(&stale_sid).is_none());

        // Calling the tool yields a brand new id.
        let req = make_request(
            json!(31),
            "tools/call",
            Some(json!({"name": "create_session", "arguments": {}})),
        );
        let resp = dispatch_request(&server, &req, &default_access()).await;
        let returned_id = resp.result.unwrap()["content"][0]["text"]
            .as_str()
            .unwrap()
            .to_string();
        assert_ne!(returned_id, stale_sid);
        assert!(server.mcp_sessions.get_session(&returned_id).is_some());
    }
}
