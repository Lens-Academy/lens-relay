use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use relay::mcp::tools::dispatch_tool;
use relay::server::{AllowedHost, Server};
use serde_json::json;
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use y_sweet_core::doc_sync::DocWithSyncKv;
use y_sweet_core::share_token::McpAccess;
use yrs::{Any, Map, Transact, WriteTxn};

const FOLDER_DOC_ID: &str = "relay-test-aaaa0000-0000-0000-0000-000000000000";

async fn new_test_server() -> Arc<Server> {
    let (server, _receivers) = Server::new(
        None,
        Duration::from_secs(60),
        None,
        None,
        Vec::<AllowedHost>::new(),
        CancellationToken::new(),
        false,
        None,
    )
    .await
    .expect("server creation should succeed");

    Arc::new(server)
}

async fn load_lens_folder(server: &Arc<Server>) {
    let folder_doc = DocWithSyncKv::new(FOLDER_DOC_ID, None, || (), None)
        .await
        .expect("folder DocWithSyncKv should be created");

    {
        let awareness = folder_doc.awareness();
        let guard = awareness.write().unwrap();
        let mut txn = guard.doc.transact_mut();

        let config = txn.get_or_insert_map("folder_config");
        config.insert(&mut txn, "name", Any::String("Lens".into()));

        let filemeta = txn.get_or_insert_map("filemeta_v0");
        let mut existing_entry = HashMap::new();
        existing_entry.insert(
            "id".to_string(),
            Any::String("bbbb0000-0000-0000-0000-000000000000".into()),
        );
        existing_entry.insert("type".to_string(), Any::String("markdown".into()));
        existing_entry.insert("version".to_string(), Any::Number(0.0));
        filemeta.insert(&mut txn, "/existing.md", Any::Map(existing_entry.into()));
    }

    server.docs().insert(FOLDER_DOC_ID.to_string(), folder_doc);
}

fn raw_text_from_cat_n(output: &str) -> String {
    output
        .lines()
        .map(|line| {
            line.split_once('\t')
                .map(|(_, content)| content)
                .expect("read output should be cat -n formatted")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn mcp_text(result: &Value) -> &str {
    assert_eq!(
        result["isError"], false,
        "MCP tool call should succeed: {}",
        result
    );
    result["content"][0]["text"]
        .as_str()
        .expect("MCP tool result should contain text")
}

#[tokio::test]
async fn html_comment_markers_round_trip_through_relay() {
    let server = new_test_server().await;
    load_lens_folder(&server).await;

    let source = r#"<p>Hello</p>
<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"q"}-->
<!--lens-reply {"id":"r1","parent":"c1","author":"b","ts":"t","body":"r"}-->
<p>World</p>"#;

    let access = McpAccess {
        writable: true,
        folder_uuid: None,
        folder_name: None,
    };
    let session_result = dispatch_tool(&server, "create_session", &json!({}), &access).await;
    let session_id = mcp_text(&session_result);

    let create_result = dispatch_tool(
        &server,
        "create",
        &json!({
            "file_path": "Lens/sample.html",
            "content": source,
            "session_id": session_id,
        }),
        &access,
    )
    .await;
    assert!(
        mcp_text(&create_result).contains("Created Lens/sample.html"),
        "HTML document creation should succeed"
    );

    let read_result = dispatch_tool(
        &server,
        "read",
        &json!({
            "file_path": "Lens/sample.html",
            "session_id": session_id,
        }),
        &access,
    )
    .await;

    let cat_n = mcp_text(&read_result);
    let read_back = raw_text_from_cat_n(&cat_n);
    assert_eq!(read_back.as_bytes(), source.as_bytes());
}
