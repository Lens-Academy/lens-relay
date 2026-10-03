use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};

type HmacSha256 = Hmac<Sha256>;

const PAYLOAD_LEN: usize = 22; // 1 purpose + 1 role + 16 uuid + 4 expiry
const SIG_LEN: usize = 8;
const DEV_SECRET: &str = "lens-editor-dev-secret-do-not-use-in-production";
const ALL_FOLDERS_SENTINEL: &str = "00000000-0000-0000-0000-000000000000";

/// What a token is for. Wire bytes mirror lens-editor's
/// `server/share-token.ts` — frozen once tokens exist in the wild.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SharePurpose {
    Share,
    AddVideo,
}

impl SharePurpose {
    fn to_byte(self) -> u8 {
        match self {
            SharePurpose::Share => 0,
            SharePurpose::AddVideo => 1,
        }
    }

    fn from_byte(b: u8) -> Option<Self> {
        match b {
            0 => Some(SharePurpose::Share),
            1 => Some(SharePurpose::AddVideo),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ShareRole {
    Admin,
    Edit,
    Suggest,
    View,
}

impl ShareRole {
    fn to_byte(self) -> u8 {
        match self {
            ShareRole::Admin => 0,
            ShareRole::Edit => 1,
            ShareRole::Suggest => 2,
            ShareRole::View => 3,
        }
    }

    fn from_byte(b: u8) -> Option<Self> {
        match b {
            0 => Some(ShareRole::Admin),
            1 => Some(ShareRole::Edit),
            2 => Some(ShareRole::Suggest),
            3 => Some(ShareRole::View),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ShareTokenPayload {
    pub purpose: SharePurpose,
    pub role: ShareRole,
    pub folder: String, // UUID "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
    pub expiry: u32,    // unix seconds
}

#[derive(Debug, Clone, PartialEq)]
pub struct McpAccess {
    pub writable: bool,
    pub folder_uuid: Option<String>, // None = all folders
    pub folder_name: Option<String>, // Resolved later, not in token
    /// The share token this access was decoded from, set by
    /// [`decode_mcp_key`] — used to forward the caller's own token to sibling
    /// services (e.g. lens-editor importers). `None` only for accesses built
    /// in code rather than decoded from a request.
    pub raw_token: Option<String>,
    /// Role carried by the share token. Only the `delete` tool looks at this
    /// today; every other tool keeps gating on `writable`.
    pub role: ShareRole,
}

impl McpAccess {
    /// Whether this credential may move files to the trash (`delete` tool):
    /// Admin and Edit share tokens. Suggest tokens are writable (edits become
    /// suggestions) but may not delete.
    pub fn can_delete(&self) -> bool {
        self.writable && matches!(self.role, ShareRole::Admin | ShareRole::Edit)
    }
}

impl ShareTokenPayload {
    pub fn to_mcp_access(&self) -> McpAccess {
        // Allowlist so unknown future roles fail closed (mirrors Node's
        // roleAtLeast comment in lens-editor/server/share-token.ts).
        let writable = matches!(
            self.role,
            ShareRole::Admin | ShareRole::Edit | ShareRole::Suggest
        );
        let folder_uuid = if self.folder == ALL_FOLDERS_SENTINEL {
            None
        } else {
            Some(self.folder.clone())
        };
        McpAccess {
            writable,
            folder_uuid,
            folder_name: None,
            raw_token: None,
            role: self.role,
        }
    }
}

/// Pack a UUID string into 16 raw bytes.
fn uuid_to_bytes(uuid: &str) -> Option<[u8; 16]> {
    let hex: String = uuid.chars().filter(|c| *c != '-').collect();
    if hex.len() != 32 {
        return None;
    }
    let mut bytes = [0u8; 16];
    for i in 0..16 {
        bytes[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(bytes)
}

/// Unpack 16 raw bytes into a UUID string.
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

fn pack_payload(payload: &ShareTokenPayload) -> Option<[u8; PAYLOAD_LEN]> {
    let uuid_bytes = uuid_to_bytes(&payload.folder)?;
    let mut buf = [0u8; PAYLOAD_LEN];
    buf[0] = payload.purpose.to_byte();
    buf[1] = payload.role.to_byte();
    buf[2..18].copy_from_slice(&uuid_bytes);
    buf[18..22].copy_from_slice(&payload.expiry.to_be_bytes());
    Some(buf)
}

fn unpack_payload(buf: &[u8]) -> Option<ShareTokenPayload> {
    if buf.len() != PAYLOAD_LEN {
        return None;
    }
    let purpose = SharePurpose::from_byte(buf[0])?;
    let role = ShareRole::from_byte(buf[1])?;
    let folder = bytes_to_uuid(&buf[2..18]);
    let expiry = u32::from_be_bytes([buf[18], buf[19], buf[20], buf[21]]);
    Some(ShareTokenPayload {
        purpose,
        role,
        folder,
        expiry,
    })
}

fn compute_hmac(payload: &[u8], secret: &str) -> [u8; SIG_LEN] {
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(payload);
    let result = mac.finalize().into_bytes();
    let mut sig = [0u8; SIG_LEN];
    sig.copy_from_slice(&result[..SIG_LEN]);
    sig
}

/// Sign a share token payload into a compact base64url string (~40 chars).
pub fn sign_share_token(payload: &ShareTokenPayload, secret: &str) -> String {
    let packed = pack_payload(payload).expect("Invalid payload");
    let sig = compute_hmac(&packed, secret);
    let mut token_bytes = Vec::with_capacity(PAYLOAD_LEN + SIG_LEN);
    token_bytes.extend_from_slice(&packed);
    token_bytes.extend_from_slice(&sig);
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

    // Constant-time compare, matching Node's timingSafeEqual.
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(packed);
    mac.verify_truncated_left(sig).ok()?;

    let payload = unpack_payload(packed)?;

    // Check expiration
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as u32;
    if payload.expiry < now {
        return None;
    }

    Some(payload)
}

/// Decode an MCP access key. Only a signed share token authenticates; with no
/// `share_secret` configured nothing does. (The plain-text `MCP_API_KEY`
/// fallback was removed in October 2026.)
///
/// Only `purpose == Share` tokens grant MCP access: an `add-video` token is
/// scoped to the video-import bookmarklet endpoint and must not double as a
/// general MCP credential.
pub fn decode_mcp_key(token: &str, share_secret: Option<&str>) -> Option<McpAccess> {
    let payload = verify_share_token(token, share_secret?)?;
    if payload.purpose != SharePurpose::Share {
        return None;
    }
    let mut access = payload.to_mcp_access();
    access.raw_token = Some(token.to_string());
    Some(access)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_FOLDER: &str = "fbd5eb54-73cc-41b0-ac28-2b93d3b4244e";
    const FAR_FUTURE_EXPIRY: u32 = 2_000_000_000; // year ~2033

    fn make_test_payload(role: ShareRole) -> ShareTokenPayload {
        ShareTokenPayload {
            purpose: SharePurpose::Share,
            role,
            folder: TEST_FOLDER.to_string(),
            expiry: FAR_FUTURE_EXPIRY,
        }
    }

    #[test]
    fn can_delete_is_admin_or_edit_only() {
        for (role, expected) in [
            (ShareRole::Admin, true),
            (ShareRole::Edit, true),
            (ShareRole::Suggest, false),
            (ShareRole::View, false),
        ] {
            let access = make_test_payload(role).to_mcp_access();
            assert_eq!(access.role, role);
            assert_eq!(access.can_delete(), expected, "{role:?}");
        }
        // A signed Suggest token decoded through the same path.
        let token = sign_share_token(&make_test_payload(ShareRole::Suggest), "secret");
        let access = decode_mcp_key(&token, Some("secret")).unwrap();
        assert!(access.writable);
        assert!(!access.can_delete());
    }

    #[test]
    fn sign_and_verify_roundtrip() {
        let payload = make_test_payload(ShareRole::Edit);
        let token = sign_share_token(&payload, DEV_SECRET);
        let decoded = verify_share_token(&token, DEV_SECRET).expect("should verify");
        assert_eq!(decoded, payload);
    }

    #[test]
    fn verify_rejects_tampered_token() {
        let payload = make_test_payload(ShareRole::Edit);
        let mut token = sign_share_token(&payload, DEV_SECRET);
        // Flip a character
        let bytes = unsafe { token.as_bytes_mut() };
        bytes[5] = if bytes[5] == b'A' { b'B' } else { b'A' };
        assert!(verify_share_token(&token, DEV_SECRET).is_none());
    }

    #[test]
    fn verify_rejects_expired_token() {
        let payload = ShareTokenPayload {
            expiry: 1, // long expired
            ..make_test_payload(ShareRole::Edit)
        };
        let token = sign_share_token(&payload, DEV_SECRET);
        assert!(verify_share_token(&token, DEV_SECRET).is_none());
    }

    #[test]
    fn verify_rejects_wrong_secret() {
        let payload = make_test_payload(ShareRole::Edit);
        let token = sign_share_token(&payload, DEV_SECRET);
        assert!(verify_share_token(&token, "wrong-secret").is_none());
    }

    #[test]
    fn verify_rejects_garbage() {
        assert!(verify_share_token("", DEV_SECRET).is_none());
        assert!(verify_share_token("not-a-token", DEV_SECRET).is_none());
        assert!(verify_share_token("AAAA", DEV_SECRET).is_none());
    }

    #[test]
    fn verify_rejects_legacy_29_byte_token() {
        // Pre-purpose wire format: 1 role + 16 uuid + 4 expiry + 8 sig.
        // Never minted outside tests, but must not decode as the new layout.
        let mut packed = Vec::new();
        packed.push(1u8); // role edit in the old layout
        packed.extend_from_slice(&uuid_to_bytes(TEST_FOLDER).unwrap());
        packed.extend_from_slice(&FAR_FUTURE_EXPIRY.to_be_bytes());
        let sig = compute_hmac(&packed, DEV_SECRET);
        packed.extend_from_slice(&sig);
        let token = URL_SAFE_NO_PAD.encode(&packed);
        assert!(verify_share_token(&token, DEV_SECRET).is_none());
    }

    #[test]
    fn all_roles_roundtrip() {
        for role in [
            ShareRole::Admin,
            ShareRole::Edit,
            ShareRole::Suggest,
            ShareRole::View,
        ] {
            let payload = make_test_payload(role);
            let token = sign_share_token(&payload, DEV_SECRET);
            let decoded = verify_share_token(&token, DEV_SECRET).expect("should verify");
            assert_eq!(decoded.role, role);
        }
    }

    #[test]
    fn all_purposes_roundtrip() {
        for purpose in [SharePurpose::Share, SharePurpose::AddVideo] {
            let payload = ShareTokenPayload {
                purpose,
                ..make_test_payload(ShareRole::Edit)
            };
            let token = sign_share_token(&payload, DEV_SECRET);
            let decoded = verify_share_token(&token, DEV_SECRET).expect("should verify");
            assert_eq!(decoded.purpose, purpose);
        }
    }

    #[test]
    fn to_mcp_access_edit_is_writable() {
        let payload = make_test_payload(ShareRole::Edit);
        let access = payload.to_mcp_access();
        assert!(access.writable);
        assert_eq!(access.folder_uuid, Some(TEST_FOLDER.to_string()));
    }

    #[test]
    fn to_mcp_access_admin_is_writable() {
        let payload = make_test_payload(ShareRole::Admin);
        let access = payload.to_mcp_access();
        assert!(access.writable);
    }

    #[test]
    fn to_mcp_access_view_is_readonly() {
        let payload = make_test_payload(ShareRole::View);
        let access = payload.to_mcp_access();
        assert!(!access.writable);
    }

    #[test]
    fn to_mcp_access_all_folders_sentinel() {
        let payload = ShareTokenPayload {
            folder: ALL_FOLDERS_SENTINEL.to_string(),
            ..make_test_payload(ShareRole::Edit)
        };
        let access = payload.to_mcp_access();
        assert!(access.writable);
        assert!(access.folder_uuid.is_none());
    }

    #[test]
    fn decode_mcp_key_uses_signed_token_role_and_folder() {
        let payload = make_test_payload(ShareRole::View);
        let token = sign_share_token(&payload, DEV_SECRET);
        let access = decode_mcp_key(&token, Some(DEV_SECRET)).expect("should decode");
        // Signed token says View = read-only
        assert!(!access.writable);
        assert_eq!(access.folder_uuid, Some(TEST_FOLDER.to_string()));
    }

    #[test]
    fn decode_mcp_key_sets_raw_token() {
        let payload = make_test_payload(ShareRole::Edit);
        let token = sign_share_token(&payload, DEV_SECRET);
        let access = decode_mcp_key(&token, Some(DEV_SECRET)).expect("should decode");
        assert_eq!(access.raw_token, Some(token));
    }

    #[test]
    fn decode_mcp_key_rejects_add_video_purpose() {
        let payload = ShareTokenPayload {
            purpose: SharePurpose::AddVideo,
            ..make_test_payload(ShareRole::Edit)
        };
        let token = sign_share_token(&payload, DEV_SECRET);
        // Verifies fine as a token, but must not grant MCP access.
        assert!(verify_share_token(&token, DEV_SECRET).is_some());
        assert!(decode_mcp_key(&token, Some(DEV_SECRET)).is_none());
    }

    // Prevents: a plain-text key (the removed MCP_API_KEY fallback, which
    // granted admin on every folder) authenticating again.
    #[test]
    fn decode_mcp_key_refuses_plain_text_keys() {
        for key in ["my-legacy-api-key", "test-key-123", "unknown", ""] {
            assert!(decode_mcp_key(key, Some(DEV_SECRET)).is_none(), "{key:?}");
            assert!(decode_mcp_key(key, None).is_none(), "{key:?}");
        }
    }

    #[test]
    fn decode_mcp_key_refuses_everything_without_a_secret() {
        let token = sign_share_token(&make_test_payload(ShareRole::Admin), DEV_SECRET);
        assert!(decode_mcp_key(&token, None).is_none());
    }

    /// Cross-verification: tokens generated by lens-editor's Node.js
    /// signShareToken (server/share-token.ts) with the dev secret,
    /// folder fbd5eb54-73cc-41b0-ac28-2b93d3b4244e, expiry 2000000000.
    #[test]
    fn interop_with_nodejs_tokens() {
        let cases = [
            (
                "AAH71etUc8xBsKwoK5PTtCROdzWUALIi5yMnVSz0",
                SharePurpose::Share,
                ShareRole::Edit,
            ),
            (
                "AAD71etUc8xBsKwoK5PTtCROdzWUAHO6Jb5q0MSW",
                SharePurpose::Share,
                ShareRole::Admin,
            ),
            (
                "AAP71etUc8xBsKwoK5PTtCROdzWUALxldgalS8Lq",
                SharePurpose::Share,
                ShareRole::View,
            ),
            (
                "AQH71etUc8xBsKwoK5PTtCROdzWUAJvyMGbPnk9F",
                SharePurpose::AddVideo,
                ShareRole::Edit,
            ),
        ];
        for (token, purpose, role) in cases {
            let payload =
                verify_share_token(token, DEV_SECRET).expect("should verify Node.js token");
            assert_eq!(payload.purpose, purpose);
            assert_eq!(payload.role, role);
            assert_eq!(payload.folder, TEST_FOLDER);
            assert_eq!(payload.expiry, 2_000_000_000);
        }
    }
}
