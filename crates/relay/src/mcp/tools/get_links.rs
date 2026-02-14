use crate::server::Server;
use serde_json::Value;
use std::sync::Arc;
use y_sweet_core::link_indexer;
use y_sweet_core::link_parser;
use yrs::{GetString, ReadTxn, Transact};
use y_sweet_core::doc_resolver::derive_folder_name;

/// Execute the `get_links` tool: return backlinks and forward links for a document.
pub fn execute(server: &Arc<Server>, arguments: &Value) -> Result<String, String> {
    let file_path = arguments
        .get("file_path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter: file_path".to_string())?;

    let doc_info = server
        .doc_resolver()
        .resolve_path(file_path)
        .ok_or_else(|| format!("Error: Document not found: {}", file_path))?;

    // --- Backlinks ---
    let backlink_paths = read_backlinks(server, &doc_info.folder_doc_id, &doc_info.uuid);

    // --- Forward links ---
    let forward_link_paths = read_forward_links(server, &doc_info.doc_id);

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
fn read_backlinks(server: &Arc<Server>, folder_doc_id: &str, uuid: &str) -> Vec<String> {
    // Read backlink UUIDs into owned Vec, then drop all guards
    let backlink_uuids: Vec<String> = {
        let Some(doc_ref) = server.docs().get(folder_doc_id) else {
            return Vec::new();
        };
        let awareness = doc_ref.awareness();
        let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
        let txn = guard.doc.transact();
        let Some(backlinks_map) = txn.get_map("backlinks_v0") else {
            return Vec::new();
        };
        link_indexer::read_backlinks_array(&backlinks_map, &txn, uuid)
        // guard, awareness, doc_ref all dropped here
    };

    // Resolve UUIDs to paths
    let resolver = server.doc_resolver();
    let mut paths: Vec<String> = backlink_uuids
        .iter()
        .filter_map(|uuid| resolver.path_for_uuid(uuid))
        .collect();
    paths.sort();
    paths
}

/// Read forward links by extracting wikilinks from content and resolving them
/// using the same algorithm as the backend link indexer (relative > absolute,
/// markdown-only, no basename matching).
fn read_forward_links(server: &Arc<Server>, doc_id: &str) -> Vec<String> {
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
        // guard, awareness, doc_ref all dropped here
    };

    let link_names = link_parser::extract_wikilinks(&content);
    if link_names.is_empty() {
        return Vec::new();
    }

    // Parse the doc_id to get the doc UUID
    let Some((_relay_id, doc_uuid)) = link_indexer::parse_doc_id(doc_id) else {
        return Vec::new();
    };

    // Find all folder docs
    let folder_doc_ids = link_indexer::find_all_folder_docs(server.docs());

    // Discover source document's path and folder index
    let mut source_folder_idx: Option<usize> = None;
    let mut source_path: Option<String> = None;

    for (fi, folder_doc_id) in folder_doc_ids.iter().enumerate() {
        let Some(doc_ref) = server.docs().get(folder_doc_id) else {
            continue;
        };
        let awareness = doc_ref.awareness();
        let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
        let txn = guard.doc.transact();
        if let Some(filemeta) = txn.get_map("filemeta_v0") {
            if let Some(path) = link_indexer::find_path_for_uuid(&filemeta, &txn, doc_uuid) {
                source_folder_idx = Some(fi);
                source_path = Some(path);
                break;
            }
        }
    }

    // Resolve each link using the same algorithm as the indexer
    let resolver = server.doc_resolver();
    let mut forward_links: Vec<String> = Vec::new();

    for link_name in &link_names {
        let mut found = false;
        for (fi, folder_doc_id) in folder_doc_ids.iter().enumerate() {
            let Some(doc_ref) = server.docs().get(folder_doc_id) else {
                continue;
            };
            let awareness = doc_ref.awareness();
            let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
            let txn = guard.doc.transact();
            if let Some(filemeta) = txn.get_map("filemeta_v0") {
                // Only pass source_path for the source's own folder
                let sp = if Some(fi) == source_folder_idx {
                    source_path.as_deref()
                } else {
                    None
                };
                if let Some(uuid) = link_indexer::resolve_link_to_uuid(link_name, &filemeta, &txn, sp) {
                    // Convert UUID back to user-facing path
                    if let Some(path) = resolver.path_for_uuid(&uuid) {
                        forward_links.push(path);
                    } else {
                        // Fallback: construct path from filemeta path + folder name
                        if let Some(fpath) = link_indexer::find_path_for_uuid(&filemeta, &txn, &uuid) {
                            let folder_name = derive_folder_name(fi);
                            let stripped = fpath.strip_prefix('/').unwrap_or(&fpath);
                            forward_links.push(format!("{}/{}", folder_name, stripped));
                        }
                    }
                    found = true;
                    break;
                }
            }
        }
        // If not found in any folder, silently skip (unresolvable link)
        let _ = found;
    }

    // Deduplicate
    forward_links.sort();
    forward_links.dedup();
    forward_links
}
