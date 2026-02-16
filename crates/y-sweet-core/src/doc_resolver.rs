use crate::doc_sync::DocWithSyncKv;
use crate::link_indexer::{extract_id_from_filemeta_entry, find_all_folder_docs, parse_doc_id};
use dashmap::DashMap;
use yrs::{Any, Doc, Map, Out, ReadTxn, Transact};

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

/// Read the folder display name from a folder doc's `folder_config` Y.Map.
///
/// Every folder doc must have `folder_config.name` set. If missing, returns a
/// placeholder derived from the folder doc ID so the issue is visible rather than
/// silently producing wrong results.
pub fn read_folder_name(doc: &Doc, folder_doc_id: &str) -> String {
    let txn = doc.transact();
    if let Some(config) = txn.get_map("folder_config") {
        if let Some(Out::Any(Any::String(name))) = config.get(&txn, "name") {
            if !name.is_empty() {
                return name.to_string();
            }
        }
    }
    // folder_config.name not set — produce a visible placeholder
    let folder_uuid = parse_doc_id(folder_doc_id)
        .map(|(_, uuid)| uuid)
        .unwrap_or(folder_doc_id);
    if folder_uuid.len() >= 8 {
        format!("Folder-{}", &folder_uuid[..8])
    } else {
        "Unknown Folder".to_string()
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
    pub fn rebuild(&self, docs: &DashMap<String, DocWithSyncKv>) {
        self.path_to_doc.clear();
        self.uuid_to_path.clear();

        let folder_doc_ids = find_all_folder_docs(docs);

        for folder_doc_id in &folder_doc_ids {
            if let Some(doc_ref) = docs.get(folder_doc_id) {
                let awareness = doc_ref.awareness();
                let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
                self.rebuild_from_folder_doc(folder_doc_id, &guard.doc);
            }
        }
    }

    /// Core rebuild logic operating on a bare Y.Doc. Testable without DocWithSyncKv.
    fn rebuild_from_folder_doc(&self, folder_doc_id: &str, doc: &Doc) {
        let folder_name = read_folder_name(doc, folder_doc_id);
        let relay_id = parse_doc_id(folder_doc_id)
            .map(|(r, _)| r.to_string())
            .unwrap_or_default();

        let txn = doc.transact();
        let Some(filemeta) = txn.get_map("filemeta_v0") else {
            return;
        };

        for (path, value) in filemeta.iter(&txn) {
            if let Some(uuid) = extract_id_from_filemeta_entry(&value, &txn) {
                // Strip leading "/" from filemeta path, prepend folder name
                let path_str: &str = &path;
                let stripped = path_str.strip_prefix('/').unwrap_or(path_str);
                let full_path = format!("{}/{}", folder_name, stripped);
                let doc_id = format!("{}-{}", relay_id, uuid);

                let info = DocInfo {
                    uuid: uuid.clone(),
                    relay_id: relay_id.clone(),
                    folder_doc_id: folder_doc_id.to_string(),
                    folder_name: folder_name.to_string(),
                    doc_id,
                };

                self.uuid_to_path.insert(uuid, full_path.clone());
                self.path_to_doc.insert(full_path, info);
            }
        }
    }

    /// Resolve a user-facing path to a DocInfo.
    pub fn resolve_path(&self, path: &str) -> Option<DocInfo> {
        if let Some(info) = self.path_to_doc.get(path) {
            return Some(info.value().clone());
        }
        // Try appending .md if path doesn't already have an extension
        if !path.ends_with(".md") {
            if let Some(info) = self.path_to_doc.get(&format!("{}.md", path)) {
                return Some(info.value().clone());
            }
        }
        None
    }

    /// Get the user-facing path for a UUID.
    pub fn path_for_uuid(&self, uuid: &str) -> Option<String> {
        self.uuid_to_path.get(uuid).map(|r| r.value().clone())
    }

    /// Get all registered document paths (for glob matching).
    pub fn all_paths(&self) -> Vec<String> {
        self.path_to_doc.iter().map(|r| r.key().clone()).collect()
    }

    /// Remove all entries associated with a given folder_doc_id from both maps.
    fn remove_folder_entries(&self, folder_doc_id: &str) {
        let paths_to_remove: Vec<String> = self
            .path_to_doc
            .iter()
            .filter(|r| r.value().folder_doc_id == folder_doc_id)
            .map(|r| r.key().clone())
            .collect();

        for path in &paths_to_remove {
            if let Some((_, info)) = self.path_to_doc.remove(path) {
                self.uuid_to_path.remove(&info.uuid);
            }
        }
    }

    /// Update maps for a single folder doc. Removes all entries associated with
    /// the given folder_doc_id, then re-adds from current filemeta_v0.
    pub fn update_folder(
        &self,
        folder_doc_id: &str,
        docs: &DashMap<String, DocWithSyncKv>,
    ) {
        self.remove_folder_entries(folder_doc_id);

        if let Some(doc_ref) = docs.get(folder_doc_id) {
            let awareness = doc_ref.awareness();
            let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
            self.rebuild_from_folder_doc(folder_doc_id, &guard.doc);
        }
    }

    /// Update maps for a single folder using a bare Y.Doc (testable without DocWithSyncKv).
    pub fn update_folder_from_doc(
        &self,
        folder_doc_id: &str,
        doc: &Doc,
    ) {
        self.remove_folder_entries(folder_doc_id);
        self.rebuild_from_folder_doc(folder_doc_id, doc);
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
    fn build_resolver(folder_specs: &[(&str, &Doc)]) -> DocumentResolver {
        let resolver = DocumentResolver::new();
        for (doc_id, doc) in folder_specs {
            resolver.rebuild_from_folder_doc(doc_id, doc);
        }
        resolver
    }

    fn set_folder_name(doc: &Doc, name: &str) {
        let mut txn = doc.transact_mut();
        let config = txn.get_or_insert_map("folder_config");
        config.insert(&mut txn, "name", Any::String(name.into()));
    }

    // === read_folder_name tests ===

    #[test]
    fn read_folder_name_from_doc() {
        let doc = Doc::new();
        {
            let mut txn = doc.transact_mut();
            let config = txn.get_or_insert_map("folder_config");
            config.insert(&mut txn, "name", Any::String("My Custom Folder".into()));
        }
        assert_eq!(read_folder_name(&doc, "anything"), "My Custom Folder");
    }

    #[test]
    fn read_folder_name_placeholder_when_missing() {
        let doc = Doc::new(); // No folder_config
        assert_eq!(read_folder_name(&doc, &folder0_id()), "Folder-aaaa0000");
    }

    #[test]
    fn read_folder_name_fallback_when_empty() {
        let doc = Doc::new();
        {
            let mut txn = doc.transact_mut();
            let config = txn.get_or_insert_map("folder_config");
            config.insert(&mut txn, "name", Any::String("".into()));
        }
        assert_eq!(read_folder_name(&doc, &folder0_id()), "Folder-aaaa0000");
    }

    #[test]
    fn read_folder_name_fallback_empty_doc_id() {
        let doc = Doc::new();
        assert_eq!(read_folder_name(&doc, ""), "Unknown Folder");
    }

    // === rebuild tests ===

    #[test]
    fn rebuild_creates_correct_entry_count() {
        let folder0 = create_folder_doc(&[
            ("/Photosynthesis.md", "uuid-photo"),
            ("/Notes/Ideas.md", "uuid-ideas"),
        ]);
        set_folder_name(&folder0, "Lens");
        let folder1 = create_folder_doc(&[("/Welcome.md", "uuid-welcome")]);
        set_folder_name(&folder1, "Lens Edu");

        let resolver = build_resolver(&[
            (&folder0_id(), &folder0),
            (&folder1_id(), &folder1),
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
        set_folder_name(&folder0, "Lens");
        let folder1 = create_folder_doc(&[("/Welcome.md", "uuid-welcome")]);
        set_folder_name(&folder1, "Lens Edu");

        let resolver = build_resolver(&[
            (&folder0_id(), &folder0),
            (&folder1_id(), &folder1),
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
        set_folder_name(&folder0, "Lens");
        let f0id = folder0_id();

        let resolver = build_resolver(&[(&f0id, &folder0)]);

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
        set_folder_name(&folder0, "Lens");

        let resolver = build_resolver(&[(&folder0_id(), &folder0)]);

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
        set_folder_name(&folder0, "Lens");
        let f0id = folder0_id();

        let resolver = build_resolver(&[(&f0id, &folder0)]);
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

        resolver.update_folder_from_doc(&f0id, &folder0);

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
        set_folder_name(&folder0, "Lens");
        let f0id = folder0_id();

        let resolver = build_resolver(&[(&f0id, &folder0)]);
        assert_eq!(resolver.all_paths().len(), 2);

        // Remove a file from the folder doc
        {
            let mut txn = folder0.transact_mut();
            let filemeta = txn.get_or_insert_map("filemeta_v0");
            filemeta.remove(&mut txn, "/ToDelete.md");
        }

        resolver.update_folder_from_doc(&f0id, &folder0);

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
        set_folder_name(&folder0, "Lens");
        let f0id = folder0_id();

        let resolver = build_resolver(&[(&f0id, &folder0)]);
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
        resolver.rebuild_from_folder_doc(&f0id, &folder0);

        assert_eq!(resolver.all_paths().len(), 1);
        assert!(resolver.resolve_path("Lens/OldDoc.md").is_none());
        assert!(resolver.path_for_uuid("uuid-old").is_none());
    }
}
