# MCP Server Access Control — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add role-based (full/read-only) and folder-scoped access control to the MCP server using HMAC-signed share tokens as API keys.

**Architecture:** Add a Rust share token decoder that verifies the HMAC signature and extracts role + folder scope. Store the decoded access level on the MCP session. Filter `tools/list` to hide write tools for read-only tokens. Check folder scope at tool dispatch time. Fall back to plain `MCP_API_KEY` matching for backward compatibility.

**Tech Stack:** Rust (axum, hmac, sha2 crates), existing share token binary format

**Spec:** `docs/superpowers/specs/2026-04-03-mcp-access-control-design.md`

---

### Task 1: Add share token decoder to y-sweet-core

Create a Rust module that decodes and verifies the compact binary share token format: `base64url(role:1 + folder_uuid:16 + expiry:4 + hmac_sha256:8)`.

**Files:**
- Create: `crates/y-sweet-core/src/share_token.rs`
- Modify: `crates/y-sweet-core/src/lib.rs` (add `pub mod share_token;`)

- [ ] **Step 1: Write failing tests**

Create `crates/y-sweet-core/src/share_token.rs` with tests at the bottom:

```rust
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};

type HmacSha256 = Hmac<Sha256>;

const PAYLOAD_LEN: usize = 21; // 1 role + 16 uuid + 4 expiry
const SIG_LEN: usize = 8;      // truncated HMAC-SHA256
const DEV_SECRET: &str = "lens-editor-dev-secret-do-not-use-in-production";

/// Decoded share token payload.
#[derive(Debug, Clone, PartialEq)]
pub struct ShareTokenPayload {
    pub role: ShareRole,
    pub folder: String, // UUID string "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
    pub expiry: u32,    // unix seconds
}

/// Role encoded in the share token.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ShareRole {
    Edit,    // byte 1
    Suggest, // byte 2
    View,    // byte 3
}

/// MCP access level derived from a share token.
#[derive(Debug, Clone, PartialEq)]
pub struct McpAccess {
    pub writable: bool,
    /// None = all folders, Some(uuid) = single folder
    pub folder_uuid: Option<String>,
    /// Display name for the folder (resolved later, not part of token)
    pub folder_name: Option<String>,
}

const ALL_FOLDERS_SENTINEL: &str = "00000000-0000-0000-0000-000000000000";

impl ShareTokenPayload {
    /// Convert to MCP access level.
    pub fn to_mcp_access(&self) -> McpAccess {
        McpAccess {
            writable: matches!(self.role, ShareRole::Edit | ShareRole::Suggest),
            folder_uuid: if self.folder == ALL_FOLDERS_SENTINEL {
                None
            } else {
                Some(self.folder.clone())
            },
            folder_name: None,
        }
    }
}

fn bytes_to_uuid(bytes: &[u8]) -> String {
    let hex: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn uuid_to_bytes(uuid: &str) -> Vec<u8> {
    let hex: String = uuid.chars().filter(|c| *c != '-').collect();
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect()
}

/// Sign a share token (for testing — matches the Node.js implementation).
pub fn sign_share_token(payload: &ShareTokenPayload, secret: &str) -> String {
    let mut buf = vec![0u8; PAYLOAD_LEN];
    buf[0] = match payload.role {
        ShareRole::Edit => 1,
        ShareRole::Suggest => 2,
        ShareRole::View => 3,
    };
    let uuid_bytes = uuid_to_bytes(&payload.folder);
    buf[1..17].copy_from_slice(&uuid_bytes);
    buf[17..21].copy_from_slice(&payload.expiry.to_be_bytes());

    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(&buf);
    let sig = mac.finalize().into_bytes();

    let mut token_bytes = buf;
    token_bytes.extend_from_slice(&sig[..SIG_LEN]);
    URL_SAFE_NO_PAD.encode(&token_bytes)
}

/// Verify and decode a share token. Returns None if invalid, expired, or tampered.
pub fn verify_share_token(token: &str, secret: &str) -> Option<ShareTokenPayload> {
    let raw = URL_SAFE_NO_PAD.decode(token).ok()?;
    if raw.len() != PAYLOAD_LEN + SIG_LEN {
        return None;
    }

    let packed = &raw[..PAYLOAD_LEN];
    let sig = &raw[PAYLOAD_LEN..];

    // Verify HMAC
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(packed);
    let expected_sig = mac.finalize().into_bytes();
    if sig != &expected_sig[..SIG_LEN] {
        return None;
    }

    // Decode payload
    let role = match packed[0] {
        1 => ShareRole::Edit,
        2 => ShareRole::Suggest,
        3 => ShareRole::View,
        _ => return None,
    };
    let folder = bytes_to_uuid(&packed[1..17]);
    let expiry = u32::from_be_bytes([packed[17], packed[18], packed[19], packed[20]]);

    // Check expiration
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as u32;
    if expiry < now {
        return None;
    }

    Some(ShareTokenPayload {
        role,
        folder,
        expiry,
    })
}

/// Try to decode a token: first as signed share token, then as plain MCP_API_KEY.
/// Returns McpAccess for the token, or None if invalid.
pub fn decode_mcp_key(token: &str, share_secret: Option<&str>, legacy_api_key: Option<&str>) -> Option<McpAccess> {
    // Try signed share token first
    if let Some(secret) = share_secret {
        if let Some(payload) = verify_share_token(token, secret) {
            return Some(payload.to_mcp_access());
        }
    }

    // Fall back to legacy plain API key
    if let Some(key) = legacy_api_key {
        if token == key {
            return Some(McpAccess {
                writable: true,
                folder_uuid: None,
                folder_name: None,
            });
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_SECRET: &str = DEV_SECRET;
    const FOLDER_A: &str = "fbd5eb54-73cc-41b0-ac28-2b93d3b4244e";

    fn future_expiry() -> u32 {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as u32;
        now + 3600
    }

    fn past_expiry() -> u32 {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as u32;
        now - 1
    }

    #[test]
    fn sign_and_verify_roundtrip() {
        let payload = ShareTokenPayload {
            role: ShareRole::Edit,
            folder: FOLDER_A.to_string(),
            expiry: future_expiry(),
        };
        let token = sign_share_token(&payload, TEST_SECRET);
        let decoded = verify_share_token(&token, TEST_SECRET).expect("should verify");
        assert_eq!(decoded.role, ShareRole::Edit);
        assert_eq!(decoded.folder, FOLDER_A);
    }

    #[test]
    fn verify_rejects_tampered_token() {
        let payload = ShareTokenPayload {
            role: ShareRole::Edit,
            folder: FOLDER_A.to_string(),
            expiry: future_expiry(),
        };
        let mut token = sign_share_token(&payload, TEST_SECRET);
        // Flip a character
        let mid = token.len() / 2;
        let c = if &token[mid..mid + 1] == "A" { "B" } else { "A" };
        token.replace_range(mid..mid + 1, c);
        assert!(verify_share_token(&token, TEST_SECRET).is_none());
    }

    #[test]
    fn verify_rejects_expired_token() {
        let payload = ShareTokenPayload {
            role: ShareRole::Edit,
            folder: FOLDER_A.to_string(),
            expiry: past_expiry(),
        };
        let token = sign_share_token(&payload, TEST_SECRET);
        assert!(verify_share_token(&token, TEST_SECRET).is_none());
    }

    #[test]
    fn verify_rejects_wrong_secret() {
        let payload = ShareTokenPayload {
            role: ShareRole::Edit,
            folder: FOLDER_A.to_string(),
            expiry: future_expiry(),
        };
        let token = sign_share_token(&payload, TEST_SECRET);
        assert!(verify_share_token(&token, "wrong-secret").is_none());
    }

    #[test]
    fn verify_rejects_garbage() {
        assert!(verify_share_token("not-a-token", TEST_SECRET).is_none());
        assert!(verify_share_token("", TEST_SECRET).is_none());
    }

    #[test]
    fn all_roles_roundtrip() {
        for (role, expected_byte) in [
            (ShareRole::Edit, 1u8),
            (ShareRole::Suggest, 2),
            (ShareRole::View, 3),
        ] {
            let payload = ShareTokenPayload {
                role,
                folder: FOLDER_A.to_string(),
                expiry: future_expiry(),
            };
            let token = sign_share_token(&payload, TEST_SECRET);
            let decoded = verify_share_token(&token, TEST_SECRET).unwrap();
            assert_eq!(decoded.role, role);
            let _ = expected_byte; // used for documentation
        }
    }

    #[test]
    fn to_mcp_access_edit_is_writable() {
        let payload = ShareTokenPayload {
            role: ShareRole::Edit,
            folder: FOLDER_A.to_string(),
            expiry: future_expiry(),
        };
        let access = payload.to_mcp_access();
        assert!(access.writable);
        assert_eq!(access.folder_uuid, Some(FOLDER_A.to_string()));
    }

    #[test]
    fn to_mcp_access_view_is_readonly() {
        let payload = ShareTokenPayload {
            role: ShareRole::View,
            folder: FOLDER_A.to_string(),
            expiry: future_expiry(),
        };
        let access = payload.to_mcp_access();
        assert!(!access.writable);
    }

    #[test]
    fn to_mcp_access_all_folders_sentinel() {
        let payload = ShareTokenPayload {
            role: ShareRole::Edit,
            folder: ALL_FOLDERS_SENTINEL.to_string(),
            expiry: future_expiry(),
        };
        let access = payload.to_mcp_access();
        assert!(access.folder_uuid.is_none());
    }

    #[test]
    fn decode_mcp_key_prefers_signed_token() {
        let payload = ShareTokenPayload {
            role: ShareRole::View,
            folder: FOLDER_A.to_string(),
            expiry: future_expiry(),
        };
        let token = sign_share_token(&payload, TEST_SECRET);
        let access = decode_mcp_key(&token, Some(TEST_SECRET), Some("some-legacy-key")).unwrap();
        assert!(!access.writable); // View → read-only
    }

    #[test]
    fn decode_mcp_key_falls_back_to_legacy() {
        let access = decode_mcp_key("my-plain-key", Some(TEST_SECRET), Some("my-plain-key")).unwrap();
        assert!(access.writable); // Legacy = full access
        assert!(access.folder_uuid.is_none()); // Legacy = all folders
    }

    #[test]
    fn decode_mcp_key_rejects_unknown() {
        assert!(decode_mcp_key("unknown", Some(TEST_SECRET), Some("my-plain-key")).is_none());
    }

    #[test]
    fn interop_with_nodejs_token() {
        // This token was generated by the Node.js signShareToken() with DEV_SECRET.
        // To generate: npx tsx -e "import {signShareToken} from './server/share-token.ts'; console.log(signShareToken({role:'edit',folder:'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e',expiry:2000000000}))"
        // If this test fails, the Rust and Node.js implementations have diverged.
        let payload = ShareTokenPayload {
            role: ShareRole::Edit,
            folder: "fbd5eb54-73cc-41b0-ac28-2b93d3b4244e".to_string(),
            expiry: 2000000000,
        };
        let rust_token = sign_share_token(&payload, DEV_SECRET);
        // Verify the Rust-signed token decodes correctly
        let decoded = verify_share_token(&rust_token, DEV_SECRET).unwrap();
        assert_eq!(decoded.role, ShareRole::Edit);
        assert_eq!(decoded.folder, "fbd5eb54-73cc-41b0-ac28-2b93d3b4244e");
        assert_eq!(decoded.expiry, 2000000000);
    }
}
```

- [ ] **Step 2: Add module to lib.rs**

In `crates/y-sweet-core/src/lib.rs`, add:

```rust
pub mod share_token;
```

- [ ] **Step 3: Add dependencies to Cargo.toml**

In `crates/y-sweet-core/Cargo.toml`, add to `[dependencies]`:

```toml
hmac = "0.12"
sha2 = "0.10"
base64 = "0.22"
```

Check if any of these are already present and skip duplicates.

- [ ] **Step 4: Run tests**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml -p y-sweet-core -- share_token`

Expected: ALL PASS

- [ ] **Step 5: Cross-verify with Node.js**

Generate a token with Node.js and verify the Rust decoder accepts it:

```bash
cd lens-editor && npx tsx -e "
import {signShareToken} from './server/share-token.ts';
console.log(signShareToken({role:'edit', folder:'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e', expiry:2000000000}));
"
```

Take the output token and add it as a constant in the `interop_with_nodejs_token` test. Verify the Rust `verify_share_token` accepts it.

- [ ] **Step 6: Commit**

```bash
jj describe -m "feat: add share token decoder to y-sweet-core (Rust HMAC verification)"
jj new
```

---

### Task 2: Store McpAccess on sessions and pass through dispatch

Store the decoded access level when a session is created, and make it available during tool dispatch.

**Files:**
- Modify: `crates/relay/src/mcp/session.rs`
- Modify: `crates/relay/src/mcp/router.rs`
- Modify: `crates/relay/src/mcp/transport.rs`
- Modify: `crates/relay/src/server.rs` (add `share_token_secret` field)

- [ ] **Step 1: Add McpAccess to McpSession**

In `session.rs`, add the access field to `McpSession`:

```rust
use y_sweet_core::share_token::McpAccess;
```

Add field to struct:

```rust
pub struct McpSession {
    pub session_id: String,
    pub protocol_version: String,
    pub client_info: Option<Value>,
    pub initialized: bool,
    pub created_at: Instant,
    pub last_activity: Instant,
    pub read_docs: HashSet<String>,
    pub access: McpAccess,
}
```

Update `create_session` to accept and store `McpAccess`:

```rust
pub fn create_session(&self, protocol_version: String, client_info: Option<Value>, access: McpAccess) -> String {
```

And set `access` in the `McpSession` construction.

- [ ] **Step 2: Add `share_token_secret` to Server**

In `server.rs`, add a new field to the `Server` struct:

```rust
pub(crate) share_token_secret: Option<String>,
```

Initialize it from env var in `Server::new()`:

```rust
let share_token_secret = std::env::var("SHARE_TOKEN_SECRET").ok();
```

Also add it to `new_without_workers` and `new_for_test` constructors with `None`.

- [ ] **Step 3: Update auth middleware to decode token and store access**

In `transport.rs`, update `mcp_auth_middleware` to decode the token using `decode_mcp_key()`:

```rust
use y_sweet_core::share_token::{decode_mcp_key, McpAccess};
```

Instead of comparing `token == expected_key`, call:

```rust
let access = decode_mcp_key(
    token,
    server.share_token_secret.as_deref(),
    server.mcp_api_key.as_deref(),
);
match access {
    Some(a) => {
        // Store access in request extensions for later use
        req.extensions_mut().insert(a);
        next.run(req).await
    }
    None => StatusCode::UNAUTHORIZED.into_response(),
}
```

This requires changing the middleware state from `State<String>` to `State<Arc<Server>>`. Update the route registration in `server.rs` accordingly (pass `self.clone()` instead of `key.clone()`).

Do the same for `validate_path_key` — decode the path key and store access.

- [ ] **Step 4: Pass McpAccess through to router**

In `transport.rs`, extract `McpAccess` from request extensions in `handle_mcp_post` and pass it to `dispatch_request`:

```rust
let access = headers.extensions().get::<McpAccess>().cloned()
    .unwrap_or(McpAccess { writable: true, folder_uuid: None, folder_name: None });
```

Update `router::dispatch_request` signature to accept `access: &McpAccess`.

In `handle_initialize`, pass access to `sessions.create_session(...)`.

- [ ] **Step 5: Update all callers**

Update all call sites of `create_session`, `dispatch_request`, and related functions to pass through the access level. Fix compilation errors.

- [ ] **Step 6: Fix existing tests**

Update test calls to `create_session` to pass a default `McpAccess`:

```rust
let default_access = McpAccess { writable: true, folder_uuid: None, folder_name: None };
sessions.create_session("2025-03-26".into(), None, default_access);
```

- [ ] **Step 7: Build and test**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml`

Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
jj describe -m "feat: store McpAccess on sessions, decode share tokens in MCP auth"
jj new
```

---

### Task 3: Filter tools/list by access level

Read-only tokens should only see read tools.

**Files:**
- Modify: `crates/relay/src/mcp/tools/mod.rs`
- Modify: `crates/relay/src/mcp/router.rs`

- [ ] **Step 1: Write failing test**

Add to router.rs tests:

```rust
#[tokio::test]
async fn tools_list_readonly_hides_write_tools() {
    let server = test_server();
    let readonly_access = McpAccess { writable: false, folder_uuid: None, folder_name: None };
    let sid = server.mcp_sessions.create_session("2025-03-26".into(), None, readonly_access);
    server.mcp_sessions.mark_initialized(&sid);

    let req = make_request(json!(3), "tools/list", None);
    let (resp, _) = dispatch_request(&server, Some(&sid), &req).await;

    let result = resp.result.unwrap();
    let tools_arr = result["tools"].as_array().unwrap();
    let names: Vec<&str> = tools_arr.iter().map(|t| t["name"].as_str().unwrap()).collect();

    // Should have read tools
    assert!(names.contains(&"read"));
    assert!(names.contains(&"glob"));
    assert!(names.contains(&"grep"));
    assert!(names.contains(&"get_links"));
    assert!(names.contains(&"search"));
    assert!(names.contains(&"create_session"));

    // Should NOT have write tools
    assert!(!names.contains(&"edit"), "read-only should not see edit");
    assert!(!names.contains(&"create"), "read-only should not see create");
    assert!(!names.contains(&"move"), "read-only should not see move");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml -p relay -- router::tests::tools_list_readonly_hides_write_tools`

Expected: FAIL — `tool_definitions()` returns all tools regardless of access.

- [ ] **Step 3: Update tool_definitions to accept writable flag**

In `tools/mod.rs`, change the signature:

```rust
pub fn tool_definitions(writable: bool) -> Vec<Value> {
    let mut tools = vec![
        // create_session — always included
        json!({ ... }),
        // read — always included
        json!({ ... }),
        // glob — always included
        json!({ ... }),
        // get_links — always included
        json!({ ... }),
        // grep — always included
        json!({ ... }),
        // search — always included
        json!({ ... }),
    ];

    if writable {
        tools.push(json!({ /* edit */ ... }));
        tools.push(json!({ /* create */ ... }));
        tools.push(json!({ /* move */ ... }));
    }

    tools
}
```

- [ ] **Step 4: Update handle_tools_list in router.rs**

Pass the session's `access.writable` to `tool_definitions()`. This requires `handle_tools_list` to have access to the session. Update the dispatch to pass session access:

```rust
"tools/list" => {
    let writable = session_id
        .and_then(|sid| sessions.get_session(sid))
        .map(|s| s.access.writable)
        .unwrap_or(true);
    (handle_tools_list(request.id.clone(), writable), None)
}
```

Update `handle_tools_list`:

```rust
fn handle_tools_list(id: Value, writable: bool) -> JsonRpcResponse {
    let definitions = tools::tool_definitions(writable);
    success_response(id, json!({ "tools": definitions }))
}
```

- [ ] **Step 5: Also reject write tools at dispatch time (defense in depth)**

In `dispatch_tool` in `tools/mod.rs`, add access check. Update the signature to accept `&McpAccess`:

```rust
pub async fn dispatch_tool(
    server: &Arc<Server>,
    transport_session_id: &str,
    name: &str,
    arguments: &Value,
    access: &McpAccess,
) -> Value {
```

After the session validation and before the tool match, add:

```rust
// Block write tools for read-only access
if !access.writable && matches!(name, "edit" | "create" | "move") {
    return tool_error("Access denied: read-only access. Cannot use write tools.");
}
```

Update all callers of `dispatch_tool` to pass access.

- [ ] **Step 6: Run tests**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml`

Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
jj describe -m "feat: filter MCP tools by access level (hide write tools for read-only)"
jj new
```

---

### Task 4: Add folder scoping to tool dispatch

Check file_path arguments against the token's folder scope.

**Files:**
- Modify: `crates/relay/src/mcp/tools/mod.rs`

- [ ] **Step 1: Write failing test**

Add to router.rs tests:

```rust
#[tokio::test]
async fn folder_scoped_tool_rejects_wrong_folder() {
    use std::collections::HashMap;
    use yrs::{Any, Doc, Map, Text, Transact, WriteTxn};

    let server = test_server();

    // Set up folder doc with a doc in "Lens"
    let relay_id = "cb696037-0f72-4e93-8717-4e433129d789";
    let folder_uuid = "aaaa0000-0000-0000-0000-000000000000";
    let folder_doc_id = format!("{}-{}", relay_id, folder_uuid);

    let folder_doc = Doc::new();
    {
        let mut txn = folder_doc.transact_mut();
        let filemeta = txn.get_or_insert_map("filemeta_v0");
        let mut map = HashMap::new();
        map.insert("id".to_string(), Any::String("uuid-test".into()));
        map.insert("type".to_string(), Any::String("markdown".into()));
        map.insert("version".to_string(), Any::Number(0.0));
        filemeta.insert(&mut txn, "/Test.md", Any::Map(map.into()));
        let config = txn.get_or_insert_map("folder_config");
        config.insert(&mut txn, "name", Any::String("Lens".into()));
    }
    server.doc_resolver().update_folder_from_doc(&folder_doc_id, &folder_doc);

    // Create session scoped to a DIFFERENT folder
    let scoped_access = McpAccess {
        writable: true,
        folder_uuid: Some("bbbb0000-0000-0000-0000-000000000000".to_string()),
        folder_name: Some("Lens Edu".to_string()),
    };
    let sid = server.mcp_sessions.create_session("2025-03-26".into(), None, scoped_access);
    server.mcp_sessions.mark_initialized(&sid);

    // Try to read a doc in "Lens" — should be rejected
    let req = make_request(
        json!(40),
        "tools/call",
        Some(json!({"name": "read", "arguments": {"file_path": "Lens/Test.md", "session_id": &sid}})),
    );
    let (resp, _) = dispatch_request(&server, Some(&sid), &req).await;
    let result = resp.result.unwrap();
    assert_eq!(result["isError"], true);
    let text = result["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("Access denied"), "should deny access: {}", text);
}
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — no folder check in dispatch.

- [ ] **Step 3: Add folder scope check to dispatch_tool**

In `dispatch_tool`, after the write-tool check, add folder scope validation:

```rust
// Folder scope check
if let Some(ref allowed_folder) = access.folder_name {
    // Check file_path argument if present
    if let Some(file_path) = arguments.get("file_path").and_then(|v| v.as_str()) {
        if !file_path.starts_with(&format!("{}/", allowed_folder)) && file_path != *allowed_folder {
            return tool_error(&format!(
                "Access denied: this key only has access to '{}'. Requested path: '{}'",
                allowed_folder, file_path
            ));
        }
    }
    // Check path argument (glob/grep scope)
    if let Some(path) = arguments.get("path").and_then(|v| v.as_str()) {
        if !path.starts_with(allowed_folder) && path != *allowed_folder {
            return tool_error(&format!(
                "Access denied: this key only has access to '{}'.",
                allowed_folder
            ));
        }
    }
    // Check new_path for move tool
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
```

- [ ] **Step 4: Run tests**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml`

Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
jj describe -m "feat: enforce folder scope in MCP tool dispatch"
jj new
```

---

### Task 5: Resolve folder name from UUID and set dynamic server description

When a session is created with a folder-scoped token, resolve the folder UUID to a display name. Set the server description dynamically in the `initialize` response.

**Files:**
- Modify: `crates/relay/src/mcp/router.rs`
- Modify: `crates/relay/src/mcp/transport.rs` (or wherever `handle_initialize` is called)

- [ ] **Step 1: Resolve folder name during session creation**

In the transport layer where `McpAccess` is decoded from the token, resolve `folder_uuid` to `folder_name` using the doc resolver. The resolver's `all_paths()` returns paths like `"Lens/Doc.md"` — extract folder names from there. Or use the `find_all_folder_docs` + `read_folder_name` pattern.

Add a helper method on `Server`:

```rust
/// Resolve a folder UUID to its display name by checking folder docs.
pub fn folder_name_for_uuid(&self, folder_uuid: &str) -> Option<String> {
    // folder_doc_id format: relay_id-folder_uuid
    // Find any path in the resolver and extract the folder name
    for entry in self.doc_resolver().all_paths().iter().take(100) {
        if let Some(info) = self.doc_resolver().resolve_path(entry) {
            if info.folder_doc_id.ends_with(&format!("-{}", folder_uuid)) {
                return Some(info.folder_name.clone());
            }
        }
    }
    None
}
```

After decoding `McpAccess`, resolve the name:

```rust
if let Some(ref uuid) = access.folder_uuid {
    access.folder_name = server.folder_name_for_uuid(uuid);
}
```

- [ ] **Step 2: Dynamic server description in handle_initialize**

In `router.rs`, update `handle_initialize` to accept `&McpAccess` and set the description:

```rust
fn handle_initialize(
    sessions: &SessionManager,
    id: Value,
    params: Option<&Value>,
    access: McpAccess,
) -> (JsonRpcResponse, String) {
    // ... existing version negotiation ...

    let description = match (&access.folder_name, access.writable) {
        (Some(name), true) => format!("Lens Relay MCP — full read/write access to {}", name),
        (Some(name), false) => format!(
            "Lens Relay MCP — read-only access to {}. You can search, read, and browse documents but cannot edit, create, or move them.",
            name
        ),
        (None, true) => "Lens Relay MCP — full read/write access to all folders".to_string(),
        (None, false) => "Lens Relay MCP — read-only access to all folders. You can search, read, and browse documents but cannot edit, create, or move them.".to_string(),
    };

    let session_id = sessions.create_session(negotiated_version.clone(), client_info, access);

    let response = success_response(
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
    );

    (response, session_id)
}
```

- [ ] **Step 3: Build and test**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml`

Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
jj describe -m "feat: resolve folder names and set dynamic MCP server description"
jj new
```

---

### Task 6: Manual testing

- [ ] **Step 1: Generate tokens**

```bash
cd lens-editor

# Full access (all folders)
npx tsx scripts/generate-share-link.ts --role edit --all-folders --expires 7d

# Read-only (all folders)
npx tsx scripts/generate-share-link.ts --role view --all-folders --expires 7d

# Full access (Lens Edu only — use production folder UUID)
npx tsx scripts/generate-share-link.ts --role edit --folder ea4015da-24af-4d9d-ac49-8c902cb17121 --expires 7d

# Read-only (Lens Edu only)
npx tsx scripts/generate-share-link.ts --role view --folder ea4015da-24af-4d9d-ac49-8c902cb17121 --expires 7d
```

- [ ] **Step 2: Test with Claude Code**

Configure `.mcp.json` with a read-only token and verify:
- `tools/list` only shows read tools (no edit/create/move)
- `read` works for docs in the allowed folder
- `read` fails for docs in other folders (if folder-scoped)
- Server description mentions access level

- [ ] **Step 3: Test backward compatibility**

Keep the plain `MCP_API_KEY` value and verify it still works as full access with all tools visible.
