use axum::{
    extract::{Path, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::Value;
use std::sync::Arc;
use tracing::debug;
use y_sweet_core::share_token::{decode_mcp_key, McpAccess};

use super::jsonrpc::{self, parse_message, JsonRpcMessage, JsonRpcResponse, PARSE_ERROR};
use super::router;
use crate::server::Server;

/// Middleware that validates Bearer token auth for MCP endpoints.
/// Decodes the token via `decode_mcp_key()` and inserts `McpAccess` into request extensions.
pub async fn mcp_auth_middleware(
    State(server): State<Arc<Server>>,
    mut req: axum::extract::Request,
    next: Next,
) -> Response {
    let auth_header = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok());

    match auth_header {
        Some(value) if value.starts_with("Bearer ") => {
            let token = &value["Bearer ".len()..];
            match decode_mcp_key(
                token,
                server.share_token_secret.as_deref(),
                server.mcp_api_key.as_deref(),
            ) {
                Some(access) => {
                    req.extensions_mut().insert(access);
                    next.run(req).await
                }
                None => StatusCode::UNAUTHORIZED.into_response(),
            }
        }
        _ => StatusCode::UNAUTHORIZED.into_response(),
    }
}

/// Handle POST /mcp — JSON-RPC messages (requests and notifications).
///
/// The transport is stateless: no `mcp-session-id` header is issued or checked.
/// Tool-level sessions are managed by the `create_session` MCP tool, which
/// returns a session id the LLM passes to subsequent tool calls. See the
/// module-level docs in `mcp/session.rs` for the design rationale (short
/// version: Claude.ai connects through the Anthropic Proxy which is
/// request-scoped, so session identity has to live in the JSON-RPC payload
/// rather than the transport).
pub async fn handle_mcp_post(
    State(server): State<Arc<Server>>,
    axum::Extension(access): axum::Extension<McpAccess>,
    body: String,
) -> Response {
    handle_mcp_post_inner(server, access, body).await
}

async fn handle_mcp_post_inner(server: Arc<Server>, access: McpAccess, body: String) -> Response {
    // Parse JSON body
    let value: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => {
            let resp = JsonRpcResponse {
                jsonrpc: "2.0".into(),
                id: Value::Null,
                result: None,
                error: Some(jsonrpc::JsonRpcError {
                    code: PARSE_ERROR,
                    message: "Parse error".into(),
                    data: None,
                }),
            };
            return (StatusCode::OK, Json(resp)).into_response();
        }
    };

    // Parse the JSON-RPC message (request vs notification)
    let message = match parse_message(&value) {
        Ok(msg) => msg,
        Err(err) => {
            let resp = JsonRpcResponse {
                jsonrpc: "2.0".into(),
                id: value.get("id").cloned().unwrap_or(Value::Null),
                result: None,
                error: Some(err),
            };
            return (StatusCode::OK, Json(resp)).into_response();
        }
    };

    // Resolve folder_name from UUID if not already set
    let access = if access.folder_name.is_none() {
        if let Some(ref uuid) = access.folder_uuid {
            McpAccess {
                folder_name: server.folder_name_for_uuid(uuid),
                ..access
            }
        } else {
            access
        }
    } else {
        access
    };

    match message {
        JsonRpcMessage::Notification(notif) => {
            debug!(method = %notif.method, "MCP notification received");
            router::handle_notification(&notif);
            StatusCode::ACCEPTED.into_response()
        }
        JsonRpcMessage::Request(req) => {
            debug!(method = %req.method, id = %req.id, "MCP request received");
            let resp = router::dispatch_request(&server, &req, &access).await;
            (StatusCode::OK, Json(resp)).into_response()
        }
    }
}

/// Handle GET /mcp — SSE transport (not yet implemented).
pub async fn handle_mcp_get() -> impl IntoResponse {
    (StatusCode::METHOD_NOT_ALLOWED, "SSE not supported yet")
}

/// Handle DELETE /mcp — no-op acknowledgement.
///
/// The streamable-HTTP MCP spec lets clients DELETE to end a session. With a
/// stateless transport there is nothing to clean up, but some clients send a
/// DELETE on shutdown anyway, so we return 200 to keep them happy.
pub async fn handle_mcp_delete() -> Response {
    StatusCode::OK.into_response()
}

// --- Path-key variants: /mcp/:key validates key from URL path ---

/// Decode the API key from the URL path into McpAccess. Returns Err(401) on failure.
fn decode_path_key(server: &Server, key: &str) -> Result<McpAccess, Response> {
    decode_mcp_key(
        key,
        server.share_token_secret.as_deref(),
        server.mcp_api_key.as_deref(),
    )
    .ok_or_else(|| StatusCode::UNAUTHORIZED.into_response())
}

/// Handle POST /mcp/:key — same as handle_mcp_post but auth via URL path.
pub async fn handle_mcp_post_with_key(
    State(server): State<Arc<Server>>,
    Path(key): Path<String>,
    body: String,
) -> Response {
    let access = match decode_path_key(&server, &key) {
        Ok(a) => a,
        Err(err) => return err,
    };
    handle_mcp_post_inner(server, access, body).await
}

/// Handle GET /mcp/:key
pub async fn handle_mcp_get_with_key(
    State(server): State<Arc<Server>>,
    Path(key): Path<String>,
) -> Response {
    if let Err(err) = decode_path_key(&server, &key) {
        return err;
    }
    handle_mcp_get().await.into_response()
}

/// Handle DELETE /mcp/:key
pub async fn handle_mcp_delete_with_key(
    State(server): State<Arc<Server>>,
    Path(key): Path<String>,
) -> Response {
    if let Err(err) = decode_path_key(&server, &key) {
        return err;
    }
    handle_mcp_delete().await
}
