//! Folder-scoped keys through `dispatch_tool`: a key limited to `Lens Edu`
//! sees nothing from the sibling folders `Lens` and `Lens Edu Private`, and
//! an all-folders key sees everything, as before.

use super::test_helpers::*;
use serde_json::json;

// === AC8: a scoped key whose folder name did not resolve is refused ===

// Prevents: a key whose folder uuid no longer resolves to a folder name
// skipping every folder check and acting as an all-folders key.
#[tokio::test]
async fn unresolved_folder_key_is_refused_every_tool() {
    let fx = three_folder_fixture().await;
    let access = scoped_access("dddd0000-0000-0000-0000-00000000dead", None);
    let calls = [
        (
            "grep",
            json!({"pattern": "needle", "output_mode": "content"}),
        ),
        ("glob", json!({"pattern": "**/*"})),
        ("search", json!({"query": "needle"})),
        ("read", json!({"file_path": "Lens/Outside.md"})),
        ("read", json!({"file_path": "Lens Edu/Inside.md"})),
        ("get_links", json!({"file_path": "Lens Edu/Inside.md"})),
    ];
    for (name, args) in calls {
        let res = call_as(&fx.server, &access, name, args.clone()).await;
        assert!(is_tool_error(&res), "{name} {args}: {res}");
        let text = result_text(&res);
        assert!(text.starts_with("Access denied"), "{name}: {text}");
        assert!(!text.contains("needle"), "{name} returned content: {text}");
        assert_no_other_folder(&text, name);
        assert_eq!(res["content"].as_array().unwrap().len(), 1, "{name}: {res}");
    }
    // create_session is refused too (no session id, no curator notes).
    let res = super::dispatch_tool(&fx.server, "create_session", &json!({}), &access).await;
    assert!(is_tool_error(&res), "create_session: {res}");
}

// === AC1: grep with no path stays inside the key's folder ===

#[tokio::test]
async fn grep_scoped_key_without_path_sees_only_its_folder() {
    let fx = three_folder_fixture().await;
    for mode in ["content", "files_with_matches", "count"] {
        let res = call_as(
            &fx.server,
            &fx.scoped,
            "grep",
            json!({"pattern": "needle|TOKEN|ТОКЕН", "output_mode": mode, "-C": 3}),
        )
        .await;
        assert!(!is_tool_error(&res), "{mode}: {res}");
        let text = result_text(&res);
        assert_no_other_folder(&text, mode);
        // The folder's own matches are still there.
        assert!(text.contains("Lens Edu/Inside.md"), "{mode}: {text}");
        assert!(text.contains("Lens Edu/学习笔记.md"), "{mode}: {text}");
    }
    // A search that matches only other folders finds nothing.
    let res = call_as(
        &fx.server,
        &fx.scoped,
        "grep",
        json!({"pattern": "TOKEN_", "output_mode": "content"}),
    )
    .await;
    assert_eq!(result_text(&res), "No matches found.");
}

// === AC2: glob with no path stays inside the key's folder ===

#[tokio::test]
async fn glob_scoped_key_without_path_sees_only_its_folder() {
    let fx = three_folder_fixture().await;
    for pattern in [
        "**/*",
        "**",
        "*/*",
        "Lens*/**",
        "Lens/*",
        "Lens Edu Private/*",
    ] {
        let res = call_as(
            &fx.server,
            &fx.scoped,
            "glob",
            json!({ "pattern": pattern }),
        )
        .await;
        assert!(!is_tool_error(&res), "{pattern}: {res}");
        assert_no_other_folder(&result_text(&res), pattern);
    }
    let res = call_as(&fx.server, &fx.scoped, "glob", json!({"pattern": "**/*"})).await;
    assert_eq!(
        result_text(&res),
        "Lens Edu/Inside.md\nLens Edu/学习笔记.md"
    );
}

// === AC4: get_links leaves out links to and from other folders ===

#[tokio::test]
async fn get_links_scoped_key_sees_only_links_inside_its_folder() {
    let fx = three_folder_fixture().await;
    let res = call_as(
        &fx.server,
        &fx.scoped,
        "get_links",
        json!({"file_path": "Lens Edu/Inside.md"}),
    )
    .await;
    assert!(!is_tool_error(&res), "{res}");
    assert_eq!(
        result_text(&res),
        "Backlinks (documents linking to this):\n- Lens Edu/学习笔记.md\n\n\
         Forward links (documents this links to):\n- Lens Edu/学习笔记.md\n"
    );
}

// === AC5: an all-folders key sees all three folders, as before ===

#[tokio::test]
async fn grep_unscoped_key_sees_all_three_folders() {
    let fx = three_folder_fixture().await;
    let res = call_as(
        &fx.server,
        &fx.unscoped,
        "grep",
        json!({"pattern": "needle", "output_mode": "files_with_matches"}),
    )
    .await;
    assert_eq!(
        result_text(&res),
        "Lens Edu Private/O'Brien-Núñez notes.md\nLens Edu Private/Secret.md\n\
         Lens Edu/Inside.md\nLens Edu/学习笔记.md\nLens/Outside.md\nLens/Заметки.md"
    );
}

#[tokio::test]
async fn glob_unscoped_key_sees_all_three_folders() {
    let fx = three_folder_fixture().await;
    let res = call_as(&fx.server, &fx.unscoped, "glob", json!({"pattern": "**/*"})).await;
    assert_eq!(
        result_text(&res),
        "Lens Edu Private/O'Brien-Núñez notes.md\nLens Edu Private/Secret.md\n\
         Lens Edu/Inside.md\nLens Edu/学习笔记.md\nLens/Outside.md\nLens/Заметки.md"
    );
}

#[tokio::test]
async fn get_links_unscoped_key_sees_links_across_folders() {
    let fx = three_folder_fixture().await;
    let res = call_as(
        &fx.server,
        &fx.unscoped,
        "get_links",
        json!({"file_path": "Lens Edu/Inside.md"}),
    )
    .await;
    assert_eq!(
        result_text(&res),
        "Backlinks (documents linking to this):\n- Lens Edu Private/Secret.md\n\
         - Lens Edu/学习笔记.md\n- Lens/Outside.md\n\n\
         Forward links (documents this links to):\n- Lens Edu Private/Secret.md\n\
         - Lens Edu/学习笔记.md\n- Lens/Outside.md\n"
    );
}
