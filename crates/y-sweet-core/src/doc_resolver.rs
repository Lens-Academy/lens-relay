use crate::doc_sync::DocWithSyncKv;
use crate::link_indexer::{extract_id_from_filemeta_entry, find_all_folder_docs, parse_doc_id};
use dashmap::DashMap;
use yrs::{Doc, ReadTxn, Transact};

/// Information about a resolved document.
#[derive(Clone, Debug)]
pub struct DocInfo {
    pub uuid: String,
    pub relay_id: String,
    pub folder_doc_id: String,
    pub folder_name: String,
    /// Full internal doc_id: "{relay_id}-{uuid}"
    pub doc_id: String,
}

/// Derive the human-readable folder name from the folder's position in the sorted folder doc list.
///
/// This centralizes the naming convention so it is not duplicated across modules.
/// - Index 0 -> "Lens"
/// - Index 1 -> "Lens Edu"
pub fn derive_folder_name(folder_idx: usize) -> &'static str {
    match folder_idx {
        0 => "Lens",
        _ => "Lens Edu",
    }
}

/// Bidirectional cache mapping user-facing document paths (`Lens/Photosynthesis.md`)
/// to internal relay identifiers (relay_id, UUID, doc_id) and back.
///
/// All three MCP tools depend on this resolver for O(1) path lookups instead of
/// scanning all folder docs on every request.
pub struct DocumentResolver {
    /// Forward map: "Lens/Photosynthesis.md" -> DocInfo
    path_to_doc: DashMap<String, DocInfo>,
    /// Reverse map: uuid -> "Lens/Photosynthesis.md"
    uuid_to_path: DashMap<String, String>,
}

impl DocumentResolver {
    pub fn new() -> Self {
        Self {
            path_to_doc: DashMap::new(),
            uuid_to_path: DashMap::new(),
        }
    }

    /// Rebuild both maps from all folder docs in the DashMap.
    ///
    /// Clears existing entries, then scans every folder doc's filemeta_v0 to build
    /// the bidirectional mapping. Called at startup after docs are loaded.
    pub fn rebuild(&self, _docs: &DashMap<String, DocWithSyncKv>) {
        // STUB: will be implemented in GREEN phase
    }

    /// Core rebuild logic operating on a bare Y.Doc. Testable without DocWithSyncKv.
    fn rebuild_from_folder_doc(&self, _folder_doc_id: &str, _folder_idx: usize, _doc: &Doc) {
        // STUB: will be implemented in GREEN phase
    }

    /// Resolve a user-facing path to a DocInfo.
    pub fn resolve_path(&self, _path: &str) -> Option<DocInfo> {
        // STUB
        None
    }

    /// Get the user-facing path for a UUID.
    pub fn path_for_uuid(&self, _uuid: &str) -> Option<String> {
        // STUB
        None
    }

    /// Get all registered document paths (for glob matching).
    pub fn all_paths(&self) -> Vec<String> {
        // STUB
        Vec::new()
    }

    /// Update maps for a single folder doc. Removes all entries associated with
    /// the given folder_doc_id, then re-adds from current filemeta_v0.
    pub fn update_folder(
        &self,
        _folder_doc_id: &str,
        _folder_idx: usize,
        _docs: &DashMap<String, DocWithSyncKv>,
    ) {
        // STUB
    }

    /// Update maps for a single folder using a bare Y.Doc (testable without DocWithSyncKv).
    pub fn update_folder_from_doc(
        &self,
        _folder_doc_id: &str,
        _folder_idx: usize,
        _doc: &Doc,
    ) {
        // STUB
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use yrs::{Any, Doc, Map, Transact, WriteTxn};

    // === Test Helpers ===

    /// Create a folder Y.Doc with filemeta_v0 populated.
    /// entries: &[("/path.md", "uuid")]
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
        }
        doc
    }

    const RELAY_ID: &str = "cb696037-0f72-4e93-8717-4e433129d789";
    const FOLDER0_UUID: &str = "aaaa0000-0000-0000-0000-000000000000";
    const FOLDER1_UUID: &str = "bbbb0000-0000-0000-0000-000000000000";

    fn folder0_id() -> String {
        format!("{}-{}", RELAY_ID, FOLDER0_UUID)
    }

    fn folder1_id() -> String {
        format!("{}-{}", RELAY_ID, FOLDER1_UUID)
    }

    /// Build a DocumentResolver from bare Y.Docs (no DocWithSyncKv needed).
    fn build_resolver(folder_specs: &[(&str, usize, &Doc)]) -> DocumentResolver {
        let resolver = DocumentResolver::new();
        for (doc_id, folder_idx, doc) in folder_specs {
            resolver.rebuild_from_folder_doc(doc_id, *folder_idx, doc);
        }
        resolver
    }

    // === derive_folder_name tests ===

    #[test]
    fn derive_folder_name_first_is_lens() {
        assert_eq!(derive_folder_name(0), "Lens");
    }

    #[test]
    fn derive_folder_name_second_is_lens_edu() {
        assert_eq!(derive_folder_name(1), "Lens Edu");
    }

    // === rebuild tests ===

    #[test]
    fn rebuild_creates_correct_entry_count() {
        let folder0 = create_folder_doc(&[
            ("/Photosynthesis.md", "uuid-photo"),
            ("/Notes/Ideas.md", "uuid-ideas"),
        ]);
        let folder1 = create_folder_doc(&[("/Welcome.md", "uuid-welcome")]);

        let resolver = build_resolver(&[
            (&folder0_id(), 0, &folder0),
            (&folder1_id(), 1, &folder1),
        ]);

        let paths = resolver.all_paths();
        assert_eq!(paths.len(), 3, "expected 3 paths, got {:?}", paths);
    }

    #[test]
    fn rebuild_constructs_correct_paths() {
        let folder0 = create_folder_doc(&[
            ("/Photosynthesis.md", "uuid-photo"),
            ("/Notes/Ideas.md", "uuid-ideas"),
        ]);
        let folder1 = create_folder_doc(&[("/Welcome.md", "uuid-welcome")]);

        let resolver = build_resolver(&[
            (&folder0_id(), 0, &folder0),
            (&folder1_id(), 1, &folder1),
        ]);

        let mut paths = resolver.all_paths();
        paths.sort();
        assert!(
            paths.contains(&"Lens/Photosynthesis.md".to_string()),
            "missing Lens/Photosynthesis.md in {:?}",
            paths
        );
        assert!(
            paths.contains(&"Lens/Notes/Ideas.md".to_string()),
            "missing Lens/Notes/Ideas.md in {:?}",
            paths
        );
        assert!(
            paths.contains(&"Lens Edu/Welcome.md".to_string()),
            "missing Lens Edu/Welcome.md in {:?}",
            paths
        );
    }

    // === resolve_path tests ===

    #[test]
    fn resolve_path_returns_correct_doc_info() {
        let folder0 = create_folder_doc(&[("/Photosynthesis.md", "uuid-photo")]);
        let f0id = folder0_id();

        let resolver = build_resolver(&[(&f0id, 0, &folder0)]);

        let info = resolver
            .resolve_path("Lens/Photosynthesis.md")
            .expect("should resolve");
        assert_eq!(info.uuid, "uuid-photo");
        assert_eq!(info.relay_id, RELAY_ID);
        assert_eq!(info.folder_doc_id, f0id);
        assert_eq!(info.folder_name, "Lens");
        assert_eq!(info.doc_id, format!("{}-uuid-photo", RELAY_ID));
    }

    #[test]
    fn resolve_path_returns_none_for_unknown() {
        let resolver = DocumentResolver::new();
        assert!(resolver.resolve_path("Lens/NonExistent.md").is_none());
    }

    // === path_for_uuid tests ===

    #[test]
    fn path_for_uuid_returns_correct_path() {
        let folder0 = create_folder_doc(&[("/Photosynthesis.md", "uuid-photo")]);

        let resolver = build_resolver(&[(&folder0_id(), 0, &folder0)]);

        let path = resolver
            .path_for_uuid("uuid-photo")
            .expect("should find path");
        assert_eq!(path, "Lens/Photosynthesis.md");
    }

    #[test]
    fn path_for_uuid_returns_none_for_unknown() {
        let resolver = DocumentResolver::new();
        assert!(resolver.path_for_uuid("nonexistent-uuid").is_none());
    }

    // === update_folder tests ===

    #[test]
    fn update_folder_adds_new_file() {
        let folder0 = create_folder_doc(&[("/Photosynthesis.md", "uuid-photo")]);
        let f0id = folder0_id();

        let resolver = build_resolver(&[(&f0id, 0, &folder0)]);
        assert_eq!(resolver.all_paths().len(), 1);

        // Add a new file to the folder doc
        {
            let mut txn = folder0.transact_mut();
            let filemeta = txn.get_or_insert_map("filemeta_v0");
            let mut map = HashMap::new();
            map.insert("id".to_string(), Any::String("uuid-newdoc".into()));
            map.insert("type".to_string(), Any::String("markdown".into()));
            map.insert("version".to_string(), Any::Number(0.0));
            filemeta.insert(&mut txn, "/NewDoc.md", Any::Map(map.into()));
        }

        resolver.update_folder_from_doc(&f0id, 0, &folder0);

        assert_eq!(resolver.all_paths().len(), 2);
        assert!(resolver.resolve_path("Lens/NewDoc.md").is_some());
        assert!(resolver.resolve_path("Lens/Photosynthesis.md").is_some());
    }

    #[test]
    fn update_folder_removes_deleted_file() {
        let folder0 = create_folder_doc(&[
            ("/Photosynthesis.md", "uuid-photo"),
            ("/ToDelete.md", "uuid-delete"),
        ]);
        let f0id = folder0_id();

        let resolver = build_resolver(&[(&f0id, 0, &folder0)]);
        assert_eq!(resolver.all_paths().len(), 2);

        // Remove a file from the folder doc
        {
            let mut txn = folder0.transact_mut();
            let filemeta = txn.get_or_insert_map("filemeta_v0");
            filemeta.remove(&mut txn, "/ToDelete.md");
        }

        resolver.update_folder_from_doc(&f0id, 0, &folder0);

        assert_eq!(resolver.all_paths().len(), 1);
        assert!(resolver.resolve_path("Lens/Photosynthesis.md").is_some());
        assert!(resolver.resolve_path("Lens/ToDelete.md").is_none());
        assert!(resolver.path_for_uuid("uuid-delete").is_none());
    }

    // === rebuild clears old entries ===

    #[test]
    fn rebuild_clears_stale_entries() {
        let folder0 = create_folder_doc(&[
            ("/Photosynthesis.md", "uuid-photo"),
            ("/OldDoc.md", "uuid-old"),
        ]);
        let f0id = folder0_id();

        let resolver = build_resolver(&[(&f0id, 0, &folder0)]);
        assert_eq!(resolver.all_paths().len(), 2);

        // Modify the folder doc to have only 1 entry
        {
            let mut txn = folder0.transact_mut();
            let filemeta = txn.get_or_insert_map("filemeta_v0");
            filemeta.remove(&mut txn, "/OldDoc.md");
        }

        // Full rebuild (clear + re-add)
        resolver.path_to_doc.clear();
        resolver.uuid_to_path.clear();
        resolver.rebuild_from_folder_doc(&f0id, 0, &folder0);

        assert_eq!(resolver.all_paths().len(), 1);
        assert!(resolver.resolve_path("Lens/OldDoc.md").is_none());
        assert!(resolver.path_for_uuid("uuid-old").is_none());
    }
}
