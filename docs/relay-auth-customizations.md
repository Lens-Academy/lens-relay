# Relay Server Customizations

This document describes the modifications made to the Relay server and Relay GitSync codebases compared to the upstream/stock versions.

## Why We Needed These Changes

Relay.md provides authentication keys for their official clients (Obsidian plugin, mobile apps), but **does not currently provide API keys for service accounts** like relay-git-sync.

This creates a problem for self-hosted deployments:

| Scenario | Auth Disabled | Auth Enabled (Relay.md keys only) |
|----------|---------------|-----------------------------------|
| Obsidian sync | Works | Works |
| Image sync between users | **Broken** (file endpoints require auth) | Works |
| relay-git-sync | Works | **Broken** (no valid token) |

**The mutual exclusivity:** You can either have image sync between users OR git-sync, but not both - unless you have an API key for service accounts.

### Our Solution

Since Relay doesn't provide service account API keys, we:

1. **Generated our own HMAC key** for relay-git-sync authentication
2. **Fixed the relay server** to properly handle HMAC keys for token generation

This allows both Relay.md clients (using their public keys) and our service account (using our HMAC key) to coexist on the same server.

---

## Overview

We made two fixes to the Relay server to enable proper authentication for service accounts (like relay-git-sync) when using self-generated HMAC keys with filesystem storage.

**No changes were made to relay-git-sync itself** - the binary file support was already built in. We only needed to fix the relay server's token generation.

---

## Relay Server Changes

### Problem Context

The relay server supports multiple key types:
- **Legacy keys** (30 bytes) - used by Relay.md's official clients
- **HMAC keys** (32 bytes) - for CWT (CBOR Web Token) format
- **Asymmetric keys** (ECDSA, Ed25519) - for public/private key pairs

When using HMAC keys for service accounts, two issues prevented proper operation:

1. **Document token generation failed** - The `auth_doc` endpoint only supported Legacy keys
2. **File downloads failed with filesystem storage** - Server/prefix tokens were incorrectly appended to download URLs instead of generating proper file tokens

### Fix 1: HMAC Support for Document Token Generation

**File:** `crates/y-sweet-core/src/auth.rs`

**Change:** Added `gen_doc_token_auto()` method that auto-detects key type:

```rust
pub fn gen_doc_token_auto(
    &self,
    doc_id: &str,
    authorization: Authorization,
    expiration_time: ExpirationTimeEpochMillis,
    user: Option<&str>,
) -> Result<String, AuthError> {
    let signing_key = self.get_signing_key()?;

    match &signing_key.key_material {
        AuthKeyMaterial::Legacy(_) => {
            self.gen_doc_token(doc_id, authorization, expiration_time, user)
        }
        AuthKeyMaterial::Hmac256(_)
        | AuthKeyMaterial::EcdsaP256Private(_)
        | AuthKeyMaterial::Ed25519Private(_) => {
            self.gen_doc_token_cwt(doc_id, authorization, expiration_time, user, None)
        }
        AuthKeyMaterial::EcdsaP256Public(_) | AuthKeyMaterial::Ed25519Public(_) => {
            Err(AuthError::CannotSignWithPublicKey)
        }
    }
}
```

**File:** `crates/relay/src/server.rs`

**Change:** Updated `auth_doc` endpoint to use the new method:

```rust
// Before:
.gen_doc_token(&doc_id, authorization, expiration_time, None)

// After:
.gen_doc_token_auto(&doc_id, authorization, expiration_time, None)
```

### Fix 2: File Token Generation for Filesystem Storage

**File:** `crates/y-sweet-core/src/auth.rs`

**Change:** Added `gen_file_token_auto()` method (same pattern as document tokens):

```rust
pub fn gen_file_token_auto(
    &self,
    file_hash: &str,
    doc_id: &str,
    authorization: Authorization,
    expiration_time: ExpirationTimeEpochMillis,
    content_type: Option<&str>,
    content_length: Option<u64>,
    user: Option<&str>,
) -> Result<String, AuthError> {
    let signing_key = self.get_signing_key()?;

    match &signing_key.key_material {
        AuthKeyMaterial::Legacy(_) => self.gen_file_token(...),
        AuthKeyMaterial::Hmac256(_) | ... => self.gen_file_token_cwt(...),
        AuthKeyMaterial::EcdsaP256Public(_) | ... => Err(AuthError::CannotSignWithPublicKey),
    }
}
```

**File:** `crates/relay/src/server.rs`

**Change:** Updated `handle_file_download_url` to generate proper file tokens when receiving server or prefix tokens:

```rust
// Before (broken for filesystem storage):
download_url = format!("{}{}token={}", download_url, separator, token);

// After:
let file_token = authenticator.gen_file_token_auto(
    &hash, &doc_id, Authorization::Full, expiration_time, None, None, None
)?;
download_url = format!("{}{}token={}", download_url, separator, file_token);
```

This fix applies to both `Permission::Server` and `Permission::Prefix` cases.

### Why These Fixes Were Needed

| Scenario | Before Fix | After Fix |
|----------|------------|-----------|
| `auth_doc` with HMAC key | "Failed to generate token" | Works - generates CWT token |
| File download with S3 storage | Works (presigned URLs) | Works (unchanged) |
| File download with filesystem storage | 400 Bad Request | Works - proper file token |

---

## Relay GitSync

### No Code Changes Required

The relay-git-sync codebase already includes full support for binary files:

- `relay_client.py`: `fetch_s3_file_content()` - downloads binary files via presigned URLs
- `sync_engine.py`: Handles `S3RemoteFile` resources and writes binary content
- `persistence.py`: `write_binary_file_content()` - writes binary files to git repo

### Configuration Required

To enable relay-git-sync with authentication, configure these environment variables:

```bash
RELAY_SERVER_URL=http://relay-server:8080  # Internal Docker network URL
RELAY_SERVER_API_KEY=<server-token>         # Generated with y-sign
WEBHOOK_SECRET=<webhook-secret>             # Must match relay.toml webhook config
```

Generate a server token using:

```bash
echo '{"type": "server"}' | cargo run -p y-sign -- sign \
  --auth "<your-hmac-key>" \
  --audience "https://your-relay-server.com"
```

---

## Summary of Changes

| Component | Files Changed | Lines Added/Modified |
|-----------|---------------|---------------------|
| y-sweet-core/auth.rs | 2 methods added | ~70 lines |
| relay/server.rs | 3 locations modified | ~50 lines |
| relay-git-sync | None | 0 |

### JJ Commits

```
nyrroywz  fix: generate file tokens for server/prefix tokens in download-url
kmqvyxuw  fix: support HMAC keys in auth_doc token generation
```

---

## Impact

These fixes enable:

1. **Service accounts with HMAC keys** - relay-git-sync can authenticate using self-generated tokens
2. **Binary file sync with filesystem storage** - Images and attachments sync to GitHub
3. **Coexistence of Relay.md clients and service accounts** - Both can use the same server

### Storage Type Compatibility

| Storage | Document Sync | Binary Sync | Notes |
|---------|---------------|-------------|-------|
| S3/R2/Cloudflare | Works | Works | Presigned URLs bypass token issue |
| Filesystem | Works (after fix 1) | Works (after fix 2) | Requires both fixes |

---

## Upstream Contribution

These fixes are general improvements that would benefit any self-hosted Relay deployment using:
- HMAC keys for service accounts
- Filesystem storage with binary files

Consider submitting as a PR to the upstream Relay server repository.
