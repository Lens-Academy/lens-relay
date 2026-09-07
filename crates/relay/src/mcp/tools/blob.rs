use crate::server::Server;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

/// Compute the SHA-256 hex digest of `data`.
pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

/// In-memory cache of blob bodies, keyed by their store key.
///
/// Store keys embed the SHA-256 of the content (`files/{doc_id}/{hash}`), so a
/// key identifies one immutable byte string: a hit returns exactly what the
/// store would. Writing new content produces a new hash and therefore a new
/// key, so an entry can never go stale — it can only become unreferenced.
///
/// This exists because whole-folder readers re-fetch every blob on every call:
/// `validate_content` pulls ~18MB of video-transcript JSON from R2 per
/// invocation, measured at ~10s of its runtime.
///
/// Eviction is deliberately blunt. The working set is small and bounded by the
/// content that exists, so the cap is a guard against pathological growth, not
/// a tuning knob; on breach the whole map is dropped rather than maintaining
/// LRU bookkeeping for a cache that is not expected to reach the cap.
const BLOB_CACHE_MAX_BYTES: usize = 64 * 1024 * 1024;

static BLOB_CACHE: OnceLock<Mutex<BlobCache>> = OnceLock::new();

#[derive(Default)]
struct BlobCache {
    entries: HashMap<String, Arc<Vec<u8>>>,
    bytes: usize,
}

fn blob_cache() -> &'static Mutex<BlobCache> {
    BLOB_CACHE.get_or_init(|| Mutex::new(BlobCache::default()))
}

fn cache_get(key: &str) -> Option<Arc<Vec<u8>>> {
    let guard = blob_cache().lock().unwrap_or_else(|e| e.into_inner());
    guard.entries.get(key).cloned()
}

fn cache_put(key: &str, data: Arc<Vec<u8>>) {
    // A single blob larger than the whole budget is never cached: admitting it
    // would immediately trigger the clear below and evict everything useful.
    if data.len() > BLOB_CACHE_MAX_BYTES {
        return;
    }
    let mut guard = blob_cache().lock().unwrap_or_else(|e| e.into_inner());
    if guard.bytes + data.len() > BLOB_CACHE_MAX_BYTES {
        guard.entries.clear();
        guard.bytes = 0;
    }
    if let Some(previous) = guard.entries.insert(key.to_string(), Arc::clone(&data)) {
        guard.bytes -= previous.len();
    }
    guard.bytes += data.len();
}

/// Drop every cached blob body. Only for tests — production entries are
/// immutable, so nothing else ever needs to invalidate them.
#[cfg(test)]
fn cache_clear() {
    let mut guard = blob_cache().lock().unwrap_or_else(|e| e.into_inner());
    guard.entries.clear();
    guard.bytes = 0;
}

/// Read a blob from the store at key `files/{doc_id}/{file_hash}`.
///
/// Served from the content-addressed cache above when present.
pub async fn read_blob(
    server: &Arc<Server>,
    doc_id: &str,
    file_hash: &str,
) -> Result<Vec<u8>, String> {
    let key = format!("files/{}/{}", doc_id, file_hash);
    if let Some(hit) = cache_get(&key) {
        return Ok(hit.as_ref().clone());
    }

    let store = server
        .store()
        .as_ref()
        .ok_or_else(|| "No store configured".to_string())?;

    let data = store
        .get(&key)
        .await
        .map_err(|e| format!("Store read error: {}", e))?
        .ok_or_else(|| format!("Blob not found: {}", key))?;

    cache_put(&key, Arc::new(data.clone()));
    Ok(data)
}

/// Write a blob to the store at key `files/{doc_id}/{hash}`, returning the SHA-256 hex hash.
pub async fn write_blob(server: &Arc<Server>, doc_id: &str, data: &[u8]) -> Result<String, String> {
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

    // The bytes just written are what a read of this key must return, and the
    // key is derived from their hash, so seeding the cache here cannot be wrong.
    cache_put(&key, Arc::new(data.to_vec()));

    Ok(hash)
}

/// Returns true if `path` has a `.json` extension (case-insensitive).
pub fn is_blob_file(path: &str) -> bool {
    path.to_ascii_lowercase().ends_with(".json")
}

/// Image extensions the MCP surface recognises: `read` returns these as an
/// image content block, `create`/`edit` refuse them (bytes only enter through
/// `import_attachment`). SVG is readable but not uploadable in v1.
const IMAGE_EXTENSIONS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "svg"];

/// Lower-cased extension of `path` (text after the last `.` of the last
/// segment), if any.
fn extension(path: &str) -> Option<String> {
    let name = path.rsplit('/').next()?;
    let (stem, ext) = name.rsplit_once('.')?;
    if stem.is_empty() || ext.is_empty() {
        return None;
    }
    Some(ext.to_ascii_lowercase())
}

/// Returns true if `path` has an image extension (case-insensitive).
pub fn is_image_file(path: &str) -> bool {
    extension(path)
        .map(|ext| IMAGE_EXTENSIONS.contains(&ext.as_str()))
        .unwrap_or(false)
}

/// MIME type implied by an image path's extension.
pub fn image_mime_for_path(path: &str) -> Option<&'static str> {
    match extension(path)?.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    }
}

/// Returns true if `path` should be edited as raw collaborative Y.Text,
/// without markdown/CriticMarkup processing.
pub fn is_raw_ytext_file(path: &str) -> bool {
    path.to_ascii_lowercase().ends_with(".html")
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
        server_with_shared_store(Arc::new(DashMap::new())).await
    }

    /// Server whose store the caller keeps a handle to, so a test can delete
    /// keys behind the server's back.
    async fn server_with_shared_store(data: Arc<DashMap<String, Vec<u8>>>) -> Arc<Server> {
        let store = MemoryStore { data };
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
        let _serialised = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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
        let _serialised = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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

    #[test]
    fn is_image_file_detects_image_extensions_only() {
        assert!(is_image_file("Lens Edu/attachments/fig.png"));
        assert!(is_image_file("Lens Edu/attachments/Photo.JPG"));
        assert!(is_image_file("a/b.jpeg"));
        assert!(is_image_file("a/b.gif"));
        assert!(is_image_file("a/b.webp"));
        assert!(is_image_file("a/b.svg"));
        assert!(!is_image_file("a/b.png.md"));
        assert!(!is_image_file("a/png"));
        assert!(!is_image_file("a/data.json"));
        assert!(!is_image_file("a/.png"));
    }

    #[test]
    fn image_mime_for_path_maps_known_extensions() {
        assert_eq!(image_mime_for_path("x.png"), Some("image/png"));
        assert_eq!(image_mime_for_path("x.JPG"), Some("image/jpeg"));
        assert_eq!(image_mime_for_path("x.jpeg"), Some("image/jpeg"));
        assert_eq!(image_mime_for_path("x.svg"), Some("image/svg+xml"));
        assert_eq!(image_mime_for_path("x.md"), None);
    }

    #[test]
    fn is_raw_ytext_file_detects_html() {
        assert!(is_raw_ytext_file("page.html"));
        assert!(is_raw_ytext_file("Lens/Page.HTML"));
        assert!(!is_raw_ytext_file("notes.md"));
        assert!(!is_raw_ytext_file("data.json"));
        assert!(!is_raw_ytext_file("html"));
    }

    /// The cache is process-global and `cargo test` runs these in parallel
    /// threads of one binary, so a test that seeds it and a test that clears it
    /// will otherwise interleave. Every test that touches the cache holds this.
    static CACHE_TEST_LOCK: Mutex<()> = Mutex::new(());

    // Prevents: the cache silently not being consulted, which would put the
    // ~18MB of video-transcript JSON back on the R2 round-trip for every
    // whole-folder read.
    #[tokio::test]
    async fn read_blob_is_served_from_cache_after_the_store_loses_the_key() {
        let _serialised = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        cache_clear();
        let data = Arc::new(DashMap::new());
        let server = server_with_shared_store(Arc::clone(&data)).await;

        let hash = write_blob(&server, "doc-cache-hit", b"cached bytes")
            .await
            .expect("write should succeed");
        data.clear();

        let read = read_blob(&server, "doc-cache-hit", &hash)
            .await
            .expect("cached blob should still be readable");
        assert_eq!(read, b"cached bytes");
    }

    // Prevents: the test above passing for the wrong reason (e.g. the store not
    // actually being cleared). With the cache empty the same read must fail.
    #[tokio::test]
    async fn read_blob_fails_when_neither_cache_nor_store_has_it() {
        let _serialised = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let data = Arc::new(DashMap::new());
        let server = server_with_shared_store(Arc::clone(&data)).await;

        let hash = write_blob(&server, "doc-cache-miss", b"cached bytes")
            .await
            .expect("write should succeed");
        data.clear();
        cache_clear();

        let err = read_blob(&server, "doc-cache-miss", &hash)
            .await
            .expect_err("uncached blob must not be readable once the store lost it");
        assert!(err.contains("Blob not found"), "got: {err}");
    }

    // Prevents: re-inserting a key double-counting its bytes, which would walk
    // the accounting up to the cap and throw the cache away for no reason.
    #[test]
    fn cache_put_replacing_an_entry_does_not_double_count_bytes() {
        let _serialised = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        cache_clear();
        cache_put("files/doc/hash-a", Arc::new(vec![0u8; 100]));
        cache_put("files/doc/hash-a", Arc::new(vec![1u8; 100]));

        let guard = blob_cache().lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(guard.entries.len(), 1);
        assert_eq!(guard.bytes, 100, "replacement must not accumulate");
    }
}
