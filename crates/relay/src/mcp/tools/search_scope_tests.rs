//! MCP `search` for folder-scoped keys, through `dispatch_tool`: a key
//! limited to `Lens Edu` gets only that folder's documents, with the limit
//! and the count applied after the folder filter. An all-folders key sees
//! every folder, as before.

use super::test_helpers::*;
use serde_json::{json, Value};

/// Text in every outranking document from the other two folders.
pub(super) const OUTRANK_TOKEN: &str = "OUTRANKZZQ";

/// Seeds 150 short documents that repeat "zebrafish" (75 in `Lens`, 75 in
/// `Lens Edu Private`, more than the 100-hit fetch cap) and two long
/// `Lens Edu` documents that mention it once, so every other-folder hit
/// outranks both in-folder hits.
pub(super) fn seed_outranking_docs(fx: &ThreeFolders) {
    let index = fx.server.search_index().clone().expect("search index");
    for i in 0..150 {
        let folder = if i % 2 == 0 {
            "Lens"
        } else {
            "Lens Edu Private"
        };
        index
            .add_document(
                &format!("e2000000-0000-4000-8000-{i:012}"),
                &format!("Zebra crowd {i}"),
                &format!("zebrafish zebrafish zebrafish {OUTRANK_TOKEN}"),
                folder,
            )
            .unwrap();
    }
    let filler = "plain words about ponds and rivers and lakes ".repeat(40);
    for (i, title) in ["Edu zebra note", "Edu zebra appendix"].iter().enumerate() {
        index
            .add_document(
                &format!("f2000000-0000-4000-8000-{i:012}"),
                title,
                &format!("{filler} zebrafish {filler}"),
                "Lens Edu",
            )
            .unwrap();
    }
}

async fn search_as(fx: &ThreeFolders, scoped: bool, args: Value) -> String {
    let access = if scoped { &fx.scoped } else { &fx.unscoped };
    let res = call_as(&fx.server, access, "search", args.clone()).await;
    assert!(!is_tool_error(&res), "search {args}: {res}");
    result_text(&res)
}

// === AC3: MCP search, scoped key ===

// Prevents: a `Lens Edu` key reading titles and snippets of `Lens` and
// `Lens Edu Private` documents through search.
#[tokio::test]
async fn search_scoped_key_sees_only_its_folder() {
    let fx = three_folder_fixture_with_search().await;
    for query in ["needle", "TOKEN_LENS_7f3a", "TOKEN_PRIVATE_9c1e", "ТОКЕН_ЛЕНС_ru"] {
        let text = search_as(&fx, true, json!({"query": query})).await;
        assert_no_other_folder(&text, query);
        for other in [
            "(Lens)",
            "(Lens Edu Private)",
            "## Outside",
            "## Заметки",
            "## Secret",
            "O'Brien-Núñez",
        ] {
            assert!(!text.contains(other), "{query}: {other:?} in:\n{text}");
        }
    }
    let text = search_as(&fx, true, json!({"query": "needle"})).await;
    assert!(text.starts_with("2 results:"), "{text}");
    assert!(text.contains("## Inside (Lens Edu)"), "{text}");
    assert!(text.contains("## 学习笔记 (Lens Edu)"), "{text}");
}

// Prevents: the limit being applied before the folder filter, so a scoped
// key whose matches are outranked by other folders gets nothing.
#[tokio::test]
async fn search_scoped_key_finds_outranked_in_folder_hits() {
    let fx = three_folder_fixture_with_search().await;
    seed_outranking_docs(&fx);

    // The other folders really do outrank: an all-folders key's top 5 holds
    // no Lens Edu document.
    let all = search_as(&fx, false, json!({"query": "zebrafish", "limit": 5})).await;
    assert!(all.starts_with("5 results:"), "{all}");
    assert!(!all.contains("(Lens Edu)"), "{all}");
    assert!(all.contains(OUTRANK_TOKEN), "{all}");

    for limit in [5, 100] {
        let text = search_as(&fx, true, json!({"query": "zebrafish", "limit": limit})).await;
        assert!(text.starts_with("2 results:"), "limit {limit}: {text}");
        assert!(text.contains("## Edu zebra note (Lens Edu)"), "{text}");
        assert!(text.contains("## Edu zebra appendix (Lens Edu)"), "{text}");
        assert!(!text.contains(OUTRANK_TOKEN), "limit {limit}: {text}");
        assert!(!text.contains("Zebra crowd"), "limit {limit}: {text}");
    }

    // The limit applies after the filter.
    let one = search_as(&fx, true, json!({"query": "zebrafish", "limit": 1})).await;
    assert!(one.starts_with("1 result:"), "{one}");
    assert_eq!(one.matches("## ").count(), 1, "{one}");
    assert!(!one.contains(OUTRANK_TOKEN), "{one}");
}

// === AC5: MCP search, all-folders key ===

#[tokio::test]
async fn search_unscoped_key_sees_all_folders() {
    let fx = three_folder_fixture_with_search().await;
    let text = search_as(&fx, false, json!({"query": "needle"})).await;
    assert!(text.starts_with("6 results:"), "{text}");
    for want in [
        "## Outside (Lens)",
        "## Заметки (Lens)",
        "## Inside (Lens Edu)",
        "## 学习笔记 (Lens Edu)",
        "## Secret (Lens Edu Private)",
        "## O'Brien-Núñez notes (Lens Edu Private)",
        "TOKEN_LENS_7f3a",
        "TOKEN_PRIVATE_9c1e",
    ] {
        assert!(text.contains(want), "{want:?} missing:\n{text}");
    }
}
