//! Folder-scoped keys through `dispatch_tool`, for the tools outside
//! grep/glob/search/get_links: `delete`'s refusal text and `read`'s concept
//! blocks name nothing from the sibling folders `Lens` and
//! `Lens Edu Private` for a key limited to `Lens Edu`.

use super::test_helpers::*;
use crate::server::Server;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use y_sweet_core::doc_sync::DocWithSyncKv;
use yrs::{Any, Doc, Map, Text, Transact, WriteTxn};

// === AC10: delete's referencing-document list stays inside the key's folder ===

// Prevents: a Lens Edu key that deletes a file linked from other folders
// reading those folders' document paths in the refusal.
#[tokio::test]
async fn delete_scoped_key_refusal_names_only_its_folder() {
    let fx = three_folder_fixture().await;
    // Inside.md is linked from Lens/Outside.md, Lens Edu Private/Secret.md
    // and Lens Edu/学习笔记.md.
    let res = call_as(
        &fx.server,
        &fx.scoped,
        "delete",
        json!({"path": "Lens Edu/Inside.md"}),
    )
    .await;
    assert!(is_tool_error(&res), "delete should refuse: {res}");
    let text = result_text(&res);
    assert_no_other_folder(&text, "scoped delete refusal");
    assert!(
        text.contains("Lens Edu/学习笔记.md"),
        "in-folder referencing doc should still be named:\n{text}"
    );
    assert!(
        text.contains("  - and 2 documents in other folders"),
        "out-of-folder referencing docs should be counted:\n{text}"
    );
    assert!(
        text.contains("Cannot delete Lens Edu/Inside.md: 3 documents outside it still link to it:"),
        "{text}"
    );
}

// Prevents: the folder filter changing what an all-folders key is told.
#[tokio::test]
async fn delete_unscoped_key_refusal_names_every_folder() {
    let fx = three_folder_fixture().await;
    let res = call_as(
        &fx.server,
        &fx.unscoped,
        "delete",
        json!({"path": "Lens Edu/Inside.md"}),
    )
    .await;
    assert!(is_tool_error(&res), "delete should refuse: {res}");
    let text = result_text(&res);
    for p in [
        "Lens/Outside.md",
        "Lens Edu Private/Secret.md",
        "Lens Edu/学习笔记.md",
    ] {
        assert!(
            text.contains(p),
            "unscoped refusal should name {p}:\n{text}"
        );
    }
    assert!(!text.contains("other folders"), "{text}");
}

// === AC6: read's concept blocks stay inside the key's folder ===

/// Adds `(folder uuid, path in folder, doc uuid, content)` documents to the
/// fixture and re-runs the link indexer over every document, as
/// `three_folder_fixture` does.
async fn add_docs(server: &Arc<Server>, docs: &[(&str, &str, &str, String)]) {
    for (folder_uuid, path, uuid, content) in docs {
        let folder_doc_id = format!("{}-{}", RELAY_ID, folder_uuid);
        {
            let awareness = server.docs().get(&folder_doc_id).unwrap().awareness();
            let guard = awareness.write().unwrap();
            let mut txn = guard.doc.transact_mut();
            let filemeta = txn.get_or_insert_map("filemeta_v0");
            let mut map = HashMap::new();
            map.insert("id".to_string(), Any::String((*uuid).into()));
            map.insert("type".to_string(), Any::String("markdown".into()));
            map.insert("version".to_string(), Any::Number(0.0));
            filemeta.insert(&mut txn, *path, Any::Map(map.into()));
        }
        server
            .doc_resolver()
            .update_folder(&folder_doc_id, server.docs());
        let doc_id = format!("{}-{}", RELAY_ID, uuid);
        let dwskv = DocWithSyncKv::new(&doc_id, None, || (), None)
            .await
            .unwrap();
        {
            let awareness = dwskv.awareness();
            let guard = awareness.write().unwrap();
            let mut txn = guard.doc.transact_mut();
            let text = txn.get_or_insert_text("contents");
            text.insert(&mut txn, 0, content);
        }
        server.docs().insert(doc_id, dwskv);
    }
    let folder_ids: Vec<String> = [LENS_FOLDER_UUID, EDU_FOLDER_UUID, EDU_PRIVATE_FOLDER_UUID]
        .iter()
        .map(|u| format!("{}-{}", RELAY_ID, u))
        .collect();
    let folder_awareness: Vec<_> = folder_ids
        .iter()
        .map(|id| server.docs().get(id).unwrap().awareness())
        .collect();
    let content_uuids: Vec<String> = server
        .doc_resolver()
        .entries_under("")
        .into_iter()
        .map(|(_, info)| info.uuid)
        .collect();
    for uuid in content_uuids {
        let doc_id = format!("{}-{}", RELAY_ID, uuid);
        let Some(content_awareness) = server.docs().get(&doc_id).map(|d| d.awareness()) else {
            continue;
        };
        let content = content_awareness.read().unwrap();
        let guards: Vec<_> = folder_awareness.iter().map(|a| a.read().unwrap()).collect();
        let folder_docs: Vec<&Doc> = guards.iter().map(|g| &g.doc).collect();
        y_sweet_core::link_indexer::index_content_into_folders(&uuid, &content.doc, &folder_docs)
            .expect("indexing should succeed");
    }
}

// Prevents: `read` of a Lens Edu concept file, article or lens printing the
// paths or rows of concept-shaped files in other folders (the blocks resolve
// wikilinks over every folder's tree).
#[tokio::test]
async fn read_concept_blocks_scoped_key_stay_inside_its_folder() {
    let fx = three_folder_fixture().await;
    add_docs(
        &fx.server,
        &[
            (
                EDU_FOLDER_UUID,
                "/Concepts/Alpha.md",
                "b2000000-0000-4000-8000-000000000001",
                "---\nparent-concepts:\n  - \"[[Lens/Outside]]\"\n---\nalpha\n## Relationships\n### [[Lens Edu/articles/Art]]\nalpha row about art\n### [[Lens/Outside]]\nalpha row about outside\n".to_string(),
            ),
            (
                EDU_FOLDER_UUID,
                "/articles/Art.md",
                "b2000000-0000-4000-8000-000000000002",
                "art text\n".to_string(),
            ),
            (
                EDU_FOLDER_UUID,
                "/Lenses/L.md",
                "b2000000-0000-4000-8000-000000000003",
                "source:: [[Lens/Outside]]\nsource:: [[Lens Edu/articles/Art]]\n".to_string(),
            ),
            (
                LENS_FOLDER_UUID,
                "/Concepts/Gamma.md",
                "a2000000-0000-4000-8000-000000000001",
                format!("---\nparent-concepts:\n  - \"[[Lens Edu/Concepts/Alpha]]\"\n---\n## Relationships\n### [[Lens Edu/articles/Art]]\n{LENS_TOKEN} row\n"),
            ),
            (
                EDU_PRIVATE_FOLDER_UUID,
                "/Concepts/Delta.md",
                "c2000000-0000-4000-8000-000000000001",
                format!("---\nparent-concepts:\n  - \"[[Lens Edu/Concepts/Alpha]]\"\n---\n## Relationships\n### [[Lens Edu/articles/Art]]\n{PRIVATE_TOKEN} row\n### [[Lens Edu/Lenses/L]]\n{PRIVATE_ACCENT_TOKEN} row\n"),
            ),
        ],
    )
    .await;

    for path in [
        "Lens Edu/Concepts/Alpha.md",
        "Lens Edu/articles/Art.md",
        "Lens Edu/Lenses/L.md",
    ] {
        let res = call_as(&fx.server, &fx.scoped, "read", json!({"file_path": path})).await;
        assert!(!is_tool_error(&res), "{path}: {res}");
        let text = result_text(&res);
        assert_no_other_folder(&text, path);
        assert!(!text.contains("Lens/Concepts/Gamma"), "{path}:\n{text}");
        assert!(
            !text.contains("Lens Edu Private/Concepts/Delta"),
            "{path}:\n{text}"
        );
    }
    // The blocks are really built: the article's read carries Alpha's row,
    // and the concept file's read carries its graph block.
    let art = result_text(
        &call_as(
            &fx.server,
            &fx.scoped,
            "read",
            json!({"file_path": "Lens Edu/articles/Art.md"}),
        )
        .await,
    );
    assert!(art.contains("alpha row about art"), "{art}");
    let alpha = result_text(
        &call_as(
            &fx.server,
            &fx.scoped,
            "read",
            json!({"file_path": "Lens Edu/Concepts/Alpha.md"}),
        )
        .await,
    );
    assert!(alpha.contains("Parent concepts"), "{alpha}");
}

// === AC6: move cannot land a file outside the key's folder ===

// Prevents: a Lens-scoped key moving its own file into `Lens Edu/` by naming
// the other folder in new_path or target_folder (move_doc.rs builds a
// "Lens Edu/..." destination for its article check only).
#[tokio::test]
async fn move_scoped_key_cannot_land_outside_its_folder() {
    let fx = three_folder_fixture().await;
    let lens_key = scoped_access(LENS_FOLDER_UUID, Some("Lens"));
    let attempts = [
        json!({"path": "Lens/Outside.md", "new_path": "Lens Edu/Moved.md"}),
        json!({"path": "Lens/Outside.md", "new_path": "Lens Edu\\Moved.md"}),
        json!({"path": "Lens/Outside.md", "new_path": "/Moved.md", "target_folder": "Lens Edu"}),
    ];
    for args in attempts {
        let res = call_as(&fx.server, &lens_key, "move", args.clone()).await;
        assert!(is_tool_error(&res), "{args}: {res}");
        let text = result_text(&res);
        assert!(
            text.contains("new_path must start with '/'") || text.contains("Access denied"),
            "{args}: {text}"
        );
    }
    assert!(fx
        .server
        .doc_resolver()
        .resolve_path("Lens Edu/Moved.md")
        .is_none());
    assert!(fx
        .server
        .doc_resolver()
        .resolve_path("Lens/Outside.md")
        .is_some());
}
