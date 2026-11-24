//! HTTP `GET /search` with `folder_uuid` (set by the editor proxy from a
//! folder-scoped share token) returns only that folder's documents, with the
//! limit and the count applied after the folder filter; without it, every
//! folder, as before.

use super::search_scope_tests::{seed_outranking_docs, OUTRANK_TOKEN};
use super::test_helpers::*;
use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use tower::ServiceExt;

// === AC9: HTTP GET /search with folder_uuid ===

async fn http_search(fx: &ThreeFolders, query: &str) -> (StatusCode, String) {
    let response = fx
        .server
        .routes()
        .oneshot(
            Request::builder()
                .uri(format!("/search?{query}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, String::from_utf8(body.to_vec()).unwrap())
}

fn folders_of(body: &str) -> Vec<String> {
    let v: Value = serde_json::from_str(body).unwrap();
    v["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["folder"].as_str().unwrap().to_string())
        .collect()
}

// Prevents: a folder-scoped share token reading other folders' titles and
// snippets through the editor's /search route.
#[tokio::test]
async fn http_search_with_folder_uuid_sees_only_that_folder() {
    let fx = three_folder_fixture_with_search().await;
    let (status, body) = http_search(
        &fx,
        "q=needle&folder_uuid=bbbb0000-0000-0000-0000-000000000000",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_no_other_folder(&body, "http folder_uuid");
    assert_eq!(folders_of(&body), vec!["Lens Edu", "Lens Edu"], "{body}");
    let v: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["total_hits"], json!(2), "{body}");
}

// Prevents: the HTTP limit being applied before the folder filter.
#[tokio::test]
async fn http_search_with_folder_uuid_finds_outranked_hits() {
    let fx = three_folder_fixture_with_search().await;
    seed_outranking_docs(&fx);
    let (_, all) = http_search(&fx, "q=zebrafish&limit=5").await;
    assert_eq!(folders_of(&all).len(), 5, "{all}");
    assert!(!folders_of(&all).contains(&"Lens Edu".to_string()), "{all}");

    let (status, body) = http_search(
        &fx,
        "q=zebrafish&limit=5&folder_uuid=bbbb0000-0000-0000-0000-000000000000",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(folders_of(&body), vec!["Lens Edu", "Lens Edu"], "{body}");
    assert!(!body.contains(OUTRANK_TOKEN), "{body}");
    let v: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["total_hits"], json!(2), "{body}");

    let (_, one) = http_search(
        &fx,
        "q=zebrafish&limit=1&folder_uuid=bbbb0000-0000-0000-0000-000000000000",
    )
    .await;
    assert_eq!(folders_of(&one), vec!["Lens Edu"], "{one}");
}

// Prevents: an unknown folder uuid falling back to every folder.
#[tokio::test]
async fn http_search_with_unknown_folder_uuid_is_not_found() {
    let fx = three_folder_fixture_with_search().await;
    let (status, body) = http_search(
        &fx,
        "q=needle&folder_uuid=dddd0000-0000-0000-0000-00000000dead",
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert!(!body.contains("needle"), "{body}");
    assert_no_other_folder(&body, "unknown folder");
}

// AC5/AC9: no folder_uuid (the server token / all-folders path) sees all.
#[tokio::test]
async fn http_search_without_folder_uuid_sees_all_folders() {
    let fx = three_folder_fixture_with_search().await;
    let (status, body) = http_search(&fx, "q=needle").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let mut folders = folders_of(&body);
    folders.sort();
    assert_eq!(
        folders,
        vec![
            "Lens",
            "Lens",
            "Lens Edu",
            "Lens Edu",
            "Lens Edu Private",
            "Lens Edu Private"
        ],
        "{body}"
    );
    assert!(body.contains("TOKEN_PRIVATE_9c1e"), "{body}");
}
