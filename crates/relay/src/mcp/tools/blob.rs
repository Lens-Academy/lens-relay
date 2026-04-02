use crate::server::Server;
use sha2::{Digest, Sha256};
use std::sync::Arc;

/// Compute the SHA-256 hex digest of `data`.
pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

/// Read a blob from the store at key `files/{doc_id}/{file_hash}`.
pub async fn read_blob(
    server: &Arc<Server>,
    doc_id: &str,
    file_hash: &str,
) -> Result<Vec<u8>, String> {
    let store = server
        .store()
        .as_ref()
        .ok_or_else(|| "No store configured".to_string())?;

    let key = format!("files/{}/{}", doc_id, file_hash);
    store
        .get(&key)
        .await
        .map_err(|e| format!("Store read error: {}", e))?
        .ok_or_else(|| format!("Blob not found: {}", key))
}

/// Write a blob to the store at key `files/{doc_id}/{hash}`, returning the SHA-256 hex hash.
pub async fn write_blob(
    server: &Arc<Server>,
    doc_id: &str,
    data: &[u8],
) -> Result<String, String> {
    let store = server
        .store()
        .as_ref()
        .ok_or_else(|| "No store configured".to_string())?;

    let hash = sha256_hex(data);
    let key = format!("files/{}/{}", doc_id, hash);
    store
        .set(&key, data.to_vec())
        .await
        .map_err(|e| format!("Store write error: {}", e))?;

    Ok(hash)
}

/// Returns true if `path` has a `.json` extension (case-insensitive).
pub fn is_blob_file(path: &str) -> bool {
    path.to_ascii_lowercase().ends_with(".json")
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use dashmap::DashMap;
    use std::time::Duration;
    use tokio_util::sync::CancellationToken;
    use y_sweet_core::store::Result as StoreResult;
    use y_sweet_core::store::Store;

    struct MemoryStore {
        data: Arc<DashMap<String, Vec<u8>>>,
    }

    #[async_trait]
    impl Store for MemoryStore {
        async fn init(&self) -> StoreResult<()> {
            Ok(())
        }
        async fn get(&self, key: &str) -> StoreResult<Option<Vec<u8>>> {
            Ok(self.data.get(key).map(|v| v.clone()))
        }
        async fn set(&self, key: &str, value: Vec<u8>) -> StoreResult<()> {
            self.data.insert(key.to_owned(), value);
            Ok(())
        }
        async fn remove(&self, key: &str) -> StoreResult<()> {
            self.data.remove(key);
            Ok(())
        }
        async fn exists(&self, key: &str) -> StoreResult<bool> {
            Ok(self.data.contains_key(key))
        }
    }

    async fn server_with_store() -> Arc<Server> {
        let store = MemoryStore {
            data: Arc::new(DashMap::new()),
        };
        Arc::new(
            Server::new_without_workers(
                Some(Box::new(store)),
                Duration::from_secs(60),
                None,
                None,
                Vec::new(),
                CancellationToken::new(),
                false,
                None,
            )
            .await
            .expect("server creation should succeed"),
        )
    }

    #[tokio::test]
    async fn blob_write_then_read_roundtrip() {
        let server = server_with_store().await;
        let data = b"hello blob world";
        let doc_id = "test-doc-123";

        let hash = write_blob(&server, doc_id, data).await.unwrap();
        assert!(!hash.is_empty());

        let read_back = read_blob(&server, doc_id, &hash).await.unwrap();
        assert_eq!(read_back, data);
    }

    #[tokio::test]
    async fn blob_read_nonexistent_returns_error() {
        let server = server_with_store().await;
        let result = read_blob(&server, "doc-123", "nonexistenthash").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Blob not found"));
    }

    #[tokio::test]
    async fn blob_write_no_store_returns_error() {
        let server = Server::new_for_test(); // store: None
        let result = write_blob(&server, "doc-123", b"data").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("No store configured"));
    }

    #[test]
    fn sha256_hex_computes_correct_hash() {
        // Known SHA-256 of empty string
        let hash = sha256_hex(b"");
        assert_eq!(
            hash,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );

        // Known SHA-256 of "hello"
        let hash = sha256_hex(b"hello");
        assert_eq!(
            hash,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn is_blob_file_detects_json() {
        assert!(is_blob_file("data.json"));
        assert!(is_blob_file("Lens/Canvas.json"));
        assert!(is_blob_file("path/to/file.JSON"));
        assert!(!is_blob_file("notes.md"));
        assert!(!is_blob_file("config.toml"));
        assert!(!is_blob_file("json")); // no dot
        assert!(!is_blob_file("file.jsonl"));
    }
}
