use crate::server::Server;
use serde_json::Value;
use std::sync::Arc;
use y_sweet_core::link_indexer;
use y_sweet_core::link_parser;
use yrs::{GetString, ReadTxn, Transact};

/// Execute the `get_links` tool: return backlinks and forward links for a document.
pub async fn execute(server: &Arc<Server>, arguments: &Value) -> Result<String, String> {
    let file_path = arguments
        .get("file_path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter: file_path".to_string())?;

    let doc_info = server
        .doc_resolver()
        .resolve_path(file_path)
        .ok_or_else(|| format!("Error: Document not found: {}", file_path))?;

    // --- Backlinks ---
    let backlink_paths = read_backlinks(server, &doc_info.folder_doc_id, &doc_info.uuid).await;

    // --- Forward links ---
    let forward_link_paths = read_forward_links(server, &doc_info.doc_id).await;

    // Format output
    let mut output = String::new();
    output.push_str("Backlinks (documents linking to this):\n");
    if backlink_paths.is_empty() {
        output.push_str("- (none)\n");
    } else {
        for path in &backlink_paths {
            output.push_str(&format!("- {}\n", path));
        }
    }

    output.push_str("\nForward links (documents this links to):\n");
    if forward_link_paths.is_empty() {
        output.push_str("- (none)\n");
    } else {
        for path in &forward_link_paths {
            output.push_str(&format!("- {}\n", path));
        }
    }

    Ok(output)
}

/// Read backlinks for a document UUID from the folder doc's backlinks_v0 map.
async fn read_backlinks(server: &Arc<Server>, folder_doc_id: &str, uuid: &str) -> Vec<String> {
    let backlink_uuids = read_backlink_uuids(server, folder_doc_id, uuid).await;
    // Resolve UUIDs to paths
    let resolver = server.doc_resolver();
    let mut paths: Vec<String> = backlink_uuids
        .iter()
        .filter_map(|uuid| resolver.path_for_uuid(uuid))
        .collect();
    paths.sort();
    paths
}

/// The uuids of the documents linking to `uuid`, from the backlinks_v0 map
/// of the folder doc that holds it (reloaded if GC evicted it).
pub(crate) async fn read_backlink_uuids(
    server: &Arc<Server>,
    folder_doc_id: &str,
    uuid: &str,
) -> Vec<String> {
    // Reload from storage if GC evicted the doc
    if server.ensure_doc_loaded(folder_doc_id).await.is_err() {
        return Vec::new();
    }
    // Clone the awareness Arc out, so no DashMap guard is held across its lock
    let Some(awareness) = server.docs().get(folder_doc_id).map(|d| d.awareness()) else {
        return Vec::new();
    };
    let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
    let txn = guard.doc.transact();
    let Some(backlinks_map) = txn.get_map("backlinks_v0") else {
        return Vec::new();
    };
    link_indexer::read_backlinks_array(&backlinks_map, &txn, uuid)
}

/// Read forward links by extracting wikilinks from content and resolving them
/// using the virtual tree model (same algorithm as the backend link indexer).
async fn read_forward_links(server: &Arc<Server>, doc_id: &str) -> Vec<String> {
    // Reload from storage if GC evicted the doc
    if server.ensure_doc_loaded(doc_id).await.is_err() {
        return Vec::new();
    }
    // Read content into owned String, then drop all guards
    let content: String = {
        let Some(doc_ref) = server.docs().get(doc_id) else {
            return Vec::new();
        };
        let awareness = doc_ref.awareness();
        let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
        let txn = guard.doc.transact();
        match txn.get_text("contents") {
            Some(text) => text.get_string(&txn),
            None => return Vec::new(),
        }
    };

    let link_names = link_parser::extract_wikilinks(&content);
    if link_names.is_empty() {
        return Vec::new();
    }

    // Parse doc_id to get source UUID
    let Some((_relay_id, doc_uuid)) = link_indexer::parse_doc_id(doc_id) else {
        return Vec::new();
    };

    let virtual_entries = all_virtual_entries(server);

    // Find source virtual path
    let source_virtual_path: Option<String> = virtual_entries
        .iter()
        .find(|e| e.id == doc_uuid)
        .map(|e| e.virtual_path.clone());

    // Resolve each link
    let resolver = server.doc_resolver();
    let mut forward_links: Vec<String> = Vec::new();

    for link_name in &link_names {
        if let Some(entry) = link_indexer::resolve_in_virtual_tree(
            link_name,
            source_virtual_path.as_deref(),
            &virtual_entries,
        ) {
            if let Some(path) = resolver.path_for_uuid(&entry.id) {
                forward_links.push(path);
            } else {
                // Fallback: construct from virtual path (strip leading /)
                let stripped = entry
                    .virtual_path
                    .strip_prefix('/')
                    .unwrap_or(&entry.virtual_path);
                forward_links.push(stripped.to_string());
            }
        }
    }

    forward_links.sort();
    forward_links.dedup();
    forward_links
}

/// Every file of every loaded folder doc as a [`link_indexer::VirtualEntry`]
/// ("/{folder name}{path}"), the tree wikilinks resolve in, as the link
/// indexer builds it.
pub(crate) fn all_virtual_entries(server: &Arc<Server>) -> Vec<link_indexer::VirtualEntry> {
    let folder_doc_ids = link_indexer::find_all_folder_docs(server.docs());
    let mut virtual_entries = Vec::new();
    for (fi, folder_doc_id) in folder_doc_ids.iter().enumerate() {
        // Clone the awareness Arc out, so no DashMap guard is held across its lock
        let Some(awareness) = server.docs().get(folder_doc_id).map(|d| d.awareness()) else {
            continue;
        };
        let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
        let (_, entries) = link_indexer::snapshot_folder_entries(&guard.doc, folder_doc_id, fi);
        virtual_entries.extend(entries);
    }
    virtual_entries
}
