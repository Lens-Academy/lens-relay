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
