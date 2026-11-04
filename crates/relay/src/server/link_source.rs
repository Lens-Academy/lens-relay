//! `POST /doc/link-source`: replace a page's links to a source with a wikilink
//! to the library's copy (docs/plans/2026-11-02-import-and-link-sources.md,
//! "Swapping a link"). The editor server calls it when an import finishes, or
//! at once for a source already in the library.
//!
//! Links are found in the live text under the awareness write lock, by what
//! they say rather than where they were: the page may have changed, or moved,
//! since the import started. A direct swap edits only the markup around a
//! label, so the label keeps its author. With `protect_human`, each link goes
//! through the rule `edit` applies (see `edit_policy`): one whose replaced
//! text is all `ai:` changes directly, and any other becomes a pending
//! suggestion. That is decided per link, so one link a person wrote doesn't
//! send the rest to review.

use super::{current_time_epoch_millis, AppError, Server};
use crate::mcp::provenance::{
    apply_attributed_edit, client_actor_map, sticky_anchor, visible_runs,
};
use crate::mcp::session::SessionManager;
use crate::mcp::tools::critic_markup::{self, Span};
use crate::mcp::tools::edit::{event_context, refresh_recent_excerpts};
use crate::mcp::tools::edit_policy::{self, RawHunk};
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use axum_extra::typed_header::TypedHeader;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::{Arc, RwLock};
use y_sweet_core::activity::{self, ActivityEvent};
use y_sweet_core::external_links::{page_offers_source_links, swap_links, LinkSwap};
use y_sweet_core::link_indexer::{compute_relative_wikilink, parse_doc_id};
use y_sweet_core::sync::awareness::Awareness;
use yrs::{GetString, ReadTxn, Text, TextRef, Transact, TransactionMut};

#[derive(Deserialize)]
pub(super) struct LinkSourceRequest {
    doc_id: String,
    /// Every spelling to replace.
    urls: Vec<String>,
    /// Full path of the library copy.
    target: String,
    title: Option<String>,
    /// Provenance key of whoever asked for the swap.
    actor: String,
    /// Name shown on a pending suggestion.
    author: String,
    protect_human: bool,
}

#[derive(Serialize, Default)]
struct LinkSourceResponse {
    linked: usize,
    suggested: usize,
    unswappable: usize,
}

/// A refusal the caller acts on. JSON, because `redact_errors` strips any
/// other 4xx body in production.
fn refusal(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({ "error": code }))).into_response()
}

pub(super) async fn handle_link_source(
    auth_header: Option<TypedHeader<headers::Authorization<headers::authorization::Bearer>>>,
    State(server): State<Arc<Server>>,
    Json(body): Json<LinkSourceRequest>,
) -> Result<Response, AppError> {
    server.check_auth(auth_header)?;

    // By id, not by the path the job started with: the page may have moved.
    let uuid = parse_doc_id(&body.doc_id).map_or(body.doc_id.as_str(), |(_, uuid)| uuid);
    let page = server
        .doc_resolver()
        .path_for_uuid(uuid)
        .and_then(|path| Some((server.doc_resolver().resolve_path(&path)?, path)));
    let Some((doc_info, path)) = page else {
        return Ok(refusal(StatusCode::NOT_FOUND, "doc_not_found"));
    };
    if server.doc_resolver().resolve_path(&body.target).is_none() {
        return Ok(refusal(StatusCode::UNPROCESSABLE_ENTITY, "target_missing"));
    }

    server
        .ensure_doc_loaded(&doc_info.doc_id)
        .await
        .map_err(|e| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    // Clone the Arc out and drop the shard ref before taking the lock (see
    // AGENTS.md "Known Issues"), and again below before the persist.
    let Some(awareness) = server
        .docs()
        .get(&doc_info.doc_id)
        .map(|doc_ref| doc_ref.awareness())
    else {
        return Ok(refusal(StatusCode::NOT_FOUND, "doc_not_found"));
    };

    let swap = PageSwap {
        path: &path,
        rel: compute_relative_wikilink(&format!("/{}", path), &format!("/{}", body.target)),
        request: &body,
        author: suggestion_author(&body.author),
        now_ms: current_time_epoch_millis(),
    };
    let doc_uuid = parse_doc_id(&doc_info.doc_id).map(|(_, uuid)| uuid);
    let Some(swapped) = swap.run(&server, &awareness, doc_uuid)? else {
        return Ok(refusal(
            StatusCode::UNPROCESSABLE_ENTITY,
            "page_not_eligible",
        ));
    };

    if swapped.logged_activity {
        if let Some(uuid) = doc_uuid {
            refresh_recent_excerpts(&server, &awareness, uuid);
        }
    }
    if swapped.changed {
        let sync_kv = server
            .docs()
            .get(&doc_info.doc_id)
            .map(|doc_ref| doc_ref.sync_kv());
        if let Some(sync_kv) = sync_kv {
            if let Err(e) = sync_kv.persist().await {
                tracing::error!(
                    "Failed to persist link swap for {}: {:?}",
                    doc_info.doc_id,
                    e
                );
            }
        }
    }
    Ok(Json(swapped.counts).into_response())
}

/// The name on a pending suggestion.
fn suggestion_author(author: &str) -> String {
    match critic_markup::clean_author(author).as_str() {
        "" => "AI".to_string(),
        name => name.to_string(),
    }
}

/// Whether a page still reads right with a link wrapped as a suggestion: the
/// swap if accepted, the page as it was if rejected. Text that only looks like
/// markup (a quoted `{++`, a stray fence) can pair with the new markup instead,
/// which no check of offsets would show.
fn suggestion_reads_back(
    raw: &str,
    accepted: &str,
    placed: &Placed,
    before: &str,
    after: &str,
) -> bool {
    let Placed { swap, pos } = placed;
    let old = &raw[swap.start..swap.end];
    let wrapped = format!(
        "{}{before}{old}{after}{}",
        &raw[..swap.start],
        &raw[swap.end..]
    );
    let spans = critic_markup::parse(&wrapped);
    let swapped = format!(
        "{}{}{}",
        &accepted[..*pos],
        swap.replacement,
        &accepted[pos + old.len()..]
    );
    critic_markup::accepted_view(&spans) == swapped
        && critic_markup::base_view(&spans) == critic_markup::base_view(&critic_markup::parse(raw))
}

/// The accepted-view offset of `[from, to)` when that range lies in one plain
/// span, so nothing there is pending. A link can fall outside one only when
/// inline code hid a suggestion's opener from the scanner.
fn accepted_offset(
    spans: &[Span],
    raw_positions: &[usize],
    from: usize,
    to: usize,
) -> Option<usize> {
    let mut accepted = 0;
    for (span, &raw_start) in spans.iter().zip(raw_positions) {
        match span {
            Span::Plain(text) => {
                if raw_start <= from && to <= raw_start + text.len() {
                    return Some(accepted + from - raw_start);
                }
                accepted += text.len();
            }
            Span::Suggestion { inserted, .. } => accepted += inserted.len(),
        }
    }
    None
}

/// The hunks of a swap, with the guards `check_provenance` wants: what goes,
/// so not a label that stays.
fn hunks_of(raw: &str, swap: &LinkSwap) -> Vec<RawHunk> {
    swap.edits
        .iter()
        .map(|edit| {
            edit_policy::raw_replacement(raw, edit.offset, edit.remove_len, &edit.insert_text)
        })
        .collect()
}

/// A swap a page can take, with its accepted-view offset.
struct Placed {
    swap: LinkSwap,
    pos: usize,
}

#[derive(Default)]
struct Swapped {
    counts: LinkSourceResponse,
    changed: bool,
    logged_activity: bool,
}

struct PageSwap<'a> {
    path: &'a str,
    rel: String,
    request: &'a LinkSourceRequest,
    author: String,
    now_ms: u64,
}

impl PageSwap<'_> {
    /// Find the links and change them, all under one write lock. `None` when
    /// the page is not one that takes swaps: it may have moved since the job
    /// began, and a wikilink to an article in a lens is a broken link.
    fn run(
        &self,
        server: &Arc<Server>,
        awareness: &Arc<RwLock<Awareness>>,
        doc_uuid: Option<&str>,
    ) -> Result<Option<Swapped>, AppError> {
        let guard = awareness.write().unwrap_or_else(|e| e.into_inner());
        let raw = {
            let txn = guard.doc.transact();
            txn.get_text("contents")
                .map(|text| text.get_string(&txn))
                .unwrap_or_default()
        };
        if !page_offers_source_links(self.path, &raw) {
            return Ok(None);
        }

        let found = swap_links(
            &raw,
            &self.request.urls,
            &self.rel,
            self.request.title.as_deref(),
        );
        let mut swapped = Swapped::default();
        swapped.counts.unswappable = found.unswappable;

        let spans = critic_markup::parse(&raw);
        let raw_positions = critic_markup::compute_raw_positions(&raw, &spans);
        let protected = edit_policy::protected_markup_ranges(&raw);
        let mut placed = Vec::with_capacity(found.swaps.len());
        for swap in found.swaps {
            let pos = accepted_offset(&spans, &raw_positions, swap.start, swap.end)
                .filter(|_| !edit_policy::touches_protected(&protected, swap.start, swap.end));
            match pos {
                Some(pos) => placed.push(Placed { swap, pos }),
                None => swapped.counts.unswappable += 1,
            }
        }
        // Nothing to do leaves the doc alone, the actor's registration included.
        if placed.is_empty() {
            return Ok(Some(swapped));
        }

        let accepted = critic_markup::accepted_view(&spans);
        let client = SessionManager::fresh_ai_client_id();
        let (applied, events) = apply_attributed_edit(
            &guard.doc,
            client,
            &self.request.actor,
            self.now_ms,
            |txn, text| Ok(self.apply(txn, text, client, &raw, &accepted, &placed)),
        )
        .map_err(|e| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, anyhow::anyhow!(e)))?;

        // Write-through under the same write lock as the edit, so the index
        // can never be overwritten by a worker scan of an older body.
        if let Some(uuid) = doc_uuid {
            for event in &events {
                server
                    .recent_changes_index()
                    .push(uuid, event.clone(), None);
            }
        }
        swapped.counts.linked = applied.linked;
        swapped.counts.suggested = applied.suggested;
        swapped.counts.unswappable += applied.unswappable;
        swapped.changed = applied.linked + applied.suggested > 0;
        swapped.logged_activity = !events.is_empty();
        Ok(Some(swapped))
    }

    /// Change the links, back to front so earlier offsets stay valid.
    fn apply(
        &self,
        txn: &mut TransactionMut,
        text: &TextRef,
        client: u64,
        raw: &str,
        accepted: &str,
        placed: &[Placed],
    ) -> (LinkSourceResponse, Vec<ActivityEvent>) {
        let protect_human = self.request.protect_human;
        // A person in Suggesting mode wants every swap as a suggestion, an
        // agent's text included; an agent gets the edit policy.
        let suggest_all = protect_human && self.request.actor.starts_with("human:");
        let runs = protect_human.then(|| visible_runs(txn, text)).flatten();
        let actors = client_actor_map(txn);
        let log_activity = self.request.actor.starts_with("ai:");

        let mut counts = LinkSourceResponse::default();
        let mut events = Vec::new();
        for one in placed.iter().rev() {
            let Placed { swap, pos } = one;
            let hunks = hunks_of(raw, swap);
            // What a swap inserts is markup only, unless the title brought some.
            if hunks.iter().any(|hunk| {
                critic_markup::reject_if_contains_markup(&hunk.new_text, "link").is_err()
            }) {
                counts.unswappable += 1;
                continue;
            }
            let direct = !protect_human
                || (!suggest_all
                    && edit_policy::check_provenance(&hunks, runs.as_deref(), &actors).is_ok());
            if direct {
                let clock_from = txn.state_vector().get(&client);
                for hunk in hunks.iter().rev() {
                    text.remove_range(txn, hunk.raw_from as u32, hunk.raw_len as u32);
                    text.insert(txn, hunk.raw_from as u32, &hunk.new_text);
                }
                let clock_to = txn.state_vector().get(&client);
                counts.linked += 1;
                if log_activity {
                    let old_text = &raw[swap.start..swap.end];
                    let (ctx_before, ctx_after) =
                        event_context(accepted, *pos, pos + old_text.len());
                    let (old, old_truncated) = activity::cap_text(old_text);
                    let (new, new_truncated) = activity::cap_text(&swap.replacement);
                    let mut event = ActivityEvent {
                        id: ActivityEvent::event_id(self.now_ms, client, clock_from),
                        ts: self.now_ms,
                        actor: self.request.actor.clone(),
                        author: self.author.clone(),
                        mode: "direct".to_string(),
                        kind: ActivityEvent::kind_for(old_text, &swap.replacement).to_string(),
                        old,
                        new,
                        old_truncated,
                        new_truncated,
                        ctx_before,
                        ctx_after,
                        pos: *pos,
                        client,
                        clock_from,
                        clock_to,
                        anchor: sticky_anchor(txn, text, swap.start),
                    };
                    event.id = activity::append_event(txn, &event, self.now_ms);
                    events.push(event);
                }
                continue;
            }

            // A closer in either text would end the markup early, so such a
            // link can't be wrapped, however unlikely it is.
            let old_text = &raw[swap.start..swap.end];
            if critic_markup::reject_if_contains_markup(old_text, "link").is_err()
                || critic_markup::reject_if_contains_markup(&swap.replacement, "link").is_err()
            {
                counts.unswappable += 1;
                continue;
            }
            let (before, after) =
                critic_markup::replacement_markup(&swap.replacement, &self.author, self.now_ms);
            if !suggestion_reads_back(raw, accepted, one, &before, &after) {
                counts.unswappable += 1;
                continue;
            }
            text.insert(txn, swap.end as u32, &after);
            text.insert(txn, swap.start as u32, &before);
            counts.suggested += 1;
        }
        (counts, events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::provenance::clients_in_range;
    use crate::mcp::tools::critic_markup::{accepted_view, base_view, parse};
    use crate::mcp::tools::test_helpers::*;
    use axum::body::{to_bytes, Body};
    use axum::http::{Method, Request};
    use axum::middleware;
    use serde_json::Value;
    use std::time::Duration;
    use tokio_util::sync::CancellationToken;
    use tower::util::ServiceExt;
    use y_sweet_core::auth::Authenticator;
    use yrs::WriteTxn;

    const PAGE: &str = "11111111-1111-4111-8111-111111111111";
    const ARTICLE: &str = "22222222-2222-4222-8222-222222222222";
    const AI: &str = "ai:opus-5:Luc";
    const HUMAN: &str = "human:Ana";
    const URL: &str = "https://example.com/a";
    const AI_CLIENT: u64 = 7001;
    const HUMAN_CLIENT: u64 = 7002;

    fn page_id() -> String {
        format!("{}-{}", RELAY_ID, PAGE)
    }

    async fn test_server() -> Arc<Server> {
        build_test_server(&[
            ("/Notes/Page.md", PAGE, ""),
            ("/articles/x.md", ARTICLE, "# X"),
        ])
        .await
    }

    /// Append `text` to the page under a client registered to `actor`.
    fn write_as(server: &Arc<Server>, actor: &str, client: u64, text: &str) {
        let awareness = server.docs().get(&page_id()).unwrap().awareness();
        let guard = awareness.write().unwrap();
        apply_attributed_edit(&guard.doc, client, actor, 1000, |txn, contents| {
            let end = contents.get_string(txn).len() as u32;
            contents.insert(txn, end, text);
            Ok(())
        })
        .unwrap();
    }

    fn write_ai(server: &Arc<Server>, text: &str) {
        write_as(server, AI, AI_CLIENT, text);
    }

    fn write_human(server: &Arc<Server>, text: &str) {
        write_as(server, HUMAN, HUMAN_CLIENT, text);
    }

    fn agent_request() -> Value {
        json!({
            "doc_id": page_id(),
            "urls": [URL],
            "target": "Lens/articles/x.md",
            "title": "Title",
            "actor": AI,
            "author": "Luc's AI",
            "protect_human": true
        })
    }

    fn person_request() -> Value {
        json!({
            "doc_id": page_id(),
            "urls": [URL],
            "target": "Lens/articles/x.md",
            "title": "Title",
            "actor": "human:Luc",
            "author": "Luc",
            "protect_human": false
        })
    }

    /// Through the production middleware, which strips any 4xx body that is
    /// not JSON.
    async fn post_as(
        server: &Arc<Server>,
        body: &Value,
        token: Option<&str>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(Method::POST)
            .uri("/doc/link-source")
            .header("content-type", "application/json");
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let response = server
            .routes()
            .layer(middleware::from_fn(Server::redact_error_middleware))
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn post(server: &Arc<Server>, body: &Value) -> (StatusCode, Value) {
        post_as(server, body, None).await
    }

    async fn assert_counts(
        server: &Arc<Server>,
        body: &Value,
        linked: u32,
        suggested: u32,
        unswappable: u32,
    ) {
        let (status, reply) = post(server, body).await;
        assert_eq!(status, StatusCode::OK, "{reply}");
        assert_eq!(
            reply,
            json!({"linked": linked, "suggested": suggested, "unswappable": unswappable})
        );
    }

    fn content(server: &Arc<Server>) -> String {
        read_doc_content(server, &page_id())
    }

    fn accepted(server: &Arc<Server>) -> String {
        accepted_view(&parse(&content(server)))
    }

    fn events(server: &Arc<Server>) -> Vec<ActivityEvent> {
        let awareness = server.docs().get(&page_id()).unwrap().awareness();
        let guard = awareness.read().unwrap();
        let txn = guard.doc.transact();
        let mut events = activity::read_events(&txn);
        events.sort_by_key(|event| event.pos);
        events
    }

    /// The actors who wrote each character of `needle` in the page's raw text.
    fn authors_of(server: &Arc<Server>, needle: &str) -> Vec<String> {
        let raw = content(server);
        let from = raw
            .find(needle)
            .unwrap_or_else(|| panic!("{needle} in {raw}"));
        let awareness = server.docs().get(&page_id()).unwrap().awareness();
        let guard = awareness.write().unwrap();
        let mut txn = guard.doc.transact_mut();
        let text = txn.get_or_insert_text("contents");
        let runs = visible_runs(&mut txn, &text).expect("runs");
        let actors = client_actor_map(&txn);
        clients_in_range(&runs, from, from + needle.len())
            .into_iter()
            .map(|client| actors.get(&client).cloned().unwrap_or_default())
            .collect()
    }

    // Prevents: an agent's own link waiting for a review nobody needs, or a
    // direct change that leaves no trace on /recent
    #[tokio::test]
    async fn ai_written_link_changes_directly_and_is_logged() {
        let server = test_server().await;
        write_ai(&server, "See [The paper](https://example.com/a) now.");

        assert_counts(&server, &agent_request(), 1, 0, 0).await;

        assert_eq!(content(&server), "See [[../articles/x|The paper]] now.");
        let logged = events(&server);
        assert_eq!(logged.len(), 1);
        let event = &logged[0];
        assert_eq!(event.old, "[The paper](https://example.com/a)");
        assert_eq!(event.new, "[[../articles/x|The paper]]");
        assert_eq!(event.kind, "replace");
        assert_eq!(event.mode, "direct");
        assert_eq!(
            (event.actor.as_str(), event.author.as_str()),
            (AI, "Luc's AI")
        );
        assert_eq!(event.pos, 4);
        assert_eq!(
            (event.ctx_before.as_str(), event.ctx_after.as_str()),
            ("See ", " now.")
        );
        assert!(event.clock_to > event.clock_from);
        assert!(event.anchor.is_some());

        let indexed = server.recent_changes_index().get(PAGE).expect("indexed");
        assert_eq!(indexed.len(), 1);
        assert_eq!(indexed[0].id, event.id);
        assert!(!server
            .recent_changes_index()
            .excerpts(PAGE)
            .unwrap()
            .is_empty());
    }

    // Prevents: an agent overwriting a link a person wrote without review
    #[tokio::test]
    async fn human_written_link_becomes_a_pending_suggestion() {
        let server = test_server().await;
        write_human(&server, "See [The paper](https://example.com/a) now.");

        assert_counts(&server, &agent_request(), 0, 1, 0).await;

        let raw = content(&server);
        assert_eq!(
            accepted_view(&parse(&raw)),
            "See [[../articles/x|The paper]] now."
        );
        assert_eq!(
            base_view(&parse(&raw)),
            "See [The paper](https://example.com/a) now."
        );
        assert!(
            raw.contains(r#"{"author":"Luc's AI","timestamp":"#),
            "{raw}"
        );
        // The text up for deletion stays the person's until someone accepts.
        assert_eq!(
            authors_of(&server, "[The paper](https://example.com/a)"),
            [HUMAN]
        );
        assert!(events(&server).is_empty());
        assert!(server.recent_changes_index().get(PAGE).is_none());
    }

    // Prevents: unattributed text (Obsidian, an import) counting as fair game
    #[tokio::test]
    async fn unattributed_link_is_protected_like_a_human_one() {
        let server = build_test_server(&[
            ("/Notes/Page.md", PAGE, "[a](https://example.com/a)"),
            ("/articles/x.md", ARTICLE, "# X"),
        ])
        .await;
        assert_counts(&server, &agent_request(), 0, 1, 0).await;
    }

    // Prevents: one human link sending the agent's own links to review, and
    // offsets drifting when direct and suggested links share a page
    #[tokio::test]
    async fn mixed_page_decides_each_link_on_its_own() {
        let server = test_server().await;
        write_ai(&server, "é [mine](https://example.com/a) then ");
        write_human(&server, "🚀 [theirs](https://example.com/a) and ");
        write_ai(&server, "https://example.com/a.");

        assert_counts(&server, &agent_request(), 2, 1, 0).await;

        assert_eq!(
            accepted(&server),
            "é [[../articles/x|mine]] then 🚀 [[../articles/x|theirs]] and [[../articles/x|Title]]."
        );
        let raw = content(&server);
        assert_eq!(raw.matches("{--").count(), 1, "{raw}");
        assert!(
            raw.starts_with("é [[../articles/x|mine]] then 🚀 {--"),
            "{raw}"
        );
        assert!(raw.ends_with("and [[../articles/x|Title]]."), "{raw}");

        let logged = events(&server);
        assert_eq!(logged.len(), 2);
        assert_eq!(logged[0].new, "[[../articles/x|mine]]");
        assert_eq!(logged[1].new, "[[../articles/x|Title]]");
        assert_ne!(logged[0].id, logged[1].id);
        assert_eq!(server.recent_changes_index().get(PAGE).unwrap().len(), 2);
    }

    // Prevents: a person's swap taking a label from whoever wrote it, which
    // would let a later agent rewrite that label as its own text
    #[tokio::test]
    async fn human_actor_changes_directly_and_the_label_keeps_its_author() {
        let server = test_server().await;
        write_human(&server, "See [The paper](https://example.com/a) now.");

        assert_counts(&server, &person_request(), 1, 0, 0).await;

        assert_eq!(content(&server), "See [[../articles/x|The paper]] now.");
        assert_eq!(authors_of(&server, "The paper"), [HUMAN]);
        assert_eq!(authors_of(&server, "[[../articles/x|"), ["human:Luc"]);
        assert_eq!(authors_of(&server, "]]"), ["human:Luc"]);
        assert!(events(&server).is_empty());
    }

    // Prevents: an AI swap that bypasses the policy going unlogged
    #[tokio::test]
    async fn ai_actor_without_protection_is_still_logged() {
        let server = test_server().await;
        write_human(&server, "[a](https://example.com/a)");
        let mut request = agent_request();
        request["protect_human"] = json!(false);

        assert_counts(&server, &request, 1, 0, 0).await;

        assert_eq!(content(&server), "[[../articles/x|a]]");
        assert_eq!(events(&server).len(), 1);
    }

    // Prevents: a link computed from the path the import started with, which
    // points nowhere once the page has moved
    #[tokio::test]
    async fn moved_page_gets_a_link_from_where_it_is_now() {
        let server = test_server().await;
        write_ai(&server, "[a](https://example.com/a)");
        let info = server
            .doc_resolver()
            .resolve_path("Lens/Notes/Page.md")
            .unwrap();
        server
            .doc_resolver()
            .upsert_doc(PAGE, "Lens/Deep/Down/Page.md", info);

        assert_counts(&server, &agent_request(), 1, 0, 0).await;

        assert_eq!(content(&server), "[[../../articles/x|a]]");
    }

    // Prevents: a bare `|` in a wikilink splitting the table cell
    #[tokio::test]
    async fn table_cell_escapes_the_separator() {
        let server = test_server().await;
        write_ai(
            &server,
            "| a | b |\n|---|---|\n| [x](https://example.com/a) | https://example.com/a |\n",
        );

        assert_counts(&server, &agent_request(), 2, 0, 0).await;

        assert_eq!(
            content(&server),
            "| a | b |\n|---|---|\n| [[../articles/x\\|x]] | [[../articles/x\\|Title]] |\n"
        );
    }

    // Prevents: the suggestion path building its own text and missing the escape
    #[tokio::test]
    async fn table_cell_escapes_the_separator_in_a_suggestion_too() {
        let server = test_server().await;
        write_human(&server, "| [x](https://example.com/a) |\n");

        assert_counts(&server, &agent_request(), 0, 1, 0).await;

        assert_eq!(accepted(&server), "| [[../articles/x\\|x]] |\n");
    }

    // Prevents: a swap after the page went away, or a redacted body the
    // editor server can't tell apart from any other failure
    #[tokio::test]
    async fn doc_gone_is_a_404_the_caller_can_read() {
        let server = test_server().await;
        let mut request = agent_request();
        request["doc_id"] = json!(format!("{}-33333333-3333-4333-8333-333333333333", RELAY_ID));

        let (status, reply) = post(&server, &request).await;

        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(reply, json!({"error": "doc_not_found"}));
    }

    // Prevents: a wikilink to a page that does not exist replacing a working
    // external link
    #[tokio::test]
    async fn target_missing_leaves_the_page_alone() {
        let server = test_server().await;
        let original = "[a](https://example.com/a)";
        write_ai(&server, original);
        let mut request = agent_request();
        request["target"] = json!("Lens/articles/gone.md");

        let (status, reply) = post(&server, &request).await;

        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(reply, json!({"error": "target_missing"}));
        assert_eq!(content(&server), original);
    }

    // Prevents: a swap in a lens when the page moved into Lens Edu during the
    // import, or into a file its source overwrites anyway
    #[tokio::test]
    async fn page_that_stopped_being_eligible_is_refused() {
        let server = test_server().await;
        let original = "[a](https://example.com/a)";
        write_ai(&server, original);
        let info = server
            .doc_resolver()
            .resolve_path("Lens/Notes/Page.md")
            .unwrap();
        server
            .doc_resolver()
            .upsert_doc(PAGE, "Lens Edu/Lenses/Page.md", info);

        let (status, reply) = post(&server, &agent_request()).await;

        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(reply, json!({"error": "page_not_eligible"}));
        assert_eq!(content(&server), original);
    }

    // Prevents: only the importer's normalized spelling being replaced while
    // the page's own spelling stays behind
    #[tokio::test]
    async fn every_spelling_changes() {
        let server = test_server().await;
        write_ai(
            &server,
            "[a](https://example.com/a?utm_source=x) and https://example.com/a/ and https://example.com/other",
        );
        let mut request = agent_request();
        request["urls"] = json!([
            "https://example.com/a?utm_source=x",
            "https://example.com/a"
        ]);

        assert_counts(&server, &request, 2, 0, 0).await;

        assert_eq!(
            content(&server),
            "[[../articles/x|a]] and [[../articles/x|Title]] and https://example.com/other"
        );
    }

    // Prevents: `[[x|]]` when a job has no title
    #[tokio::test]
    async fn a_missing_title_takes_the_targets_file_stem() {
        let server = test_server().await;
        write_ai(&server, "<https://example.com/a>");
        let mut request = agent_request();
        request.as_object_mut().unwrap().remove("title");

        assert_counts(&server, &request, 1, 0, 0).await;

        assert_eq!(content(&server), "[[../articles/x|x]]");
    }

    // Prevents: a link that can't become a wikilink being rewritten anyway, or
    // reading as "the link has gone" to the job
    #[tokio::test]
    async fn unswappable_links_are_left_and_counted() {
        let server = test_server().await;
        let original = "[a|b](https://example.com/a) [Smith [2020]](https://example.com/a)";
        write_ai(&server, original);

        assert_counts(&server, &agent_request(), 0, 0, 2).await;

        assert_eq!(content(&server), original);
    }

    // Prevents: a registration and an empty persist each time a link has
    // already gone from the page
    #[tokio::test]
    async fn no_links_leaves_the_doc_alone() {
        let server = test_server().await;
        write_ai(&server, "Nothing here.");

        assert_counts(&server, &agent_request(), 0, 0, 0).await;

        let awareness = server.docs().get(&page_id()).unwrap().awareness();
        let guard = awareness.read().unwrap();
        let txn = guard.doc.transact();
        assert_eq!(
            client_actor_map(&txn).len(),
            1,
            "only the writer is registered"
        );
    }

    // Prevents: rewriting a link inside text someone has proposed but nobody
    // has accepted
    #[tokio::test]
    async fn a_link_inside_a_pending_suggestion_is_not_touched() {
        let server = test_server().await;
        let original = "{++[a](https://example.com/a)++}";
        write_ai(&server, original);

        assert_counts(&server, &agent_request(), 0, 0, 0).await;

        assert_eq!(content(&server), original);
    }

    // Prevents: a swap landing inside a suggestion the scanner did not see,
    // because inline code hid its opener (markup inside markup corrupts both)
    #[tokio::test]
    async fn a_link_only_the_scanner_thinks_is_plain_is_left_alone() {
        let server = test_server().await;
        let original = "`{++` [a](https://example.com/a) ++}";
        write_ai(&server, original);

        assert_counts(&server, &agent_request(), 0, 0, 1).await;

        assert_eq!(content(&server), original);
    }

    // Prevents: a stray closer in a title ending the suggestion early and
    // spilling metadata into the page
    #[tokio::test]
    async fn a_title_with_a_closer_is_cleaned_before_it_is_suggested() {
        let server = test_server().await;
        let original = "https://example.com/a";
        write_human(&server, original);
        let mut request = agent_request();
        request["title"] = json!("C++} and more");

        assert_counts(&server, &request, 0, 1, 0).await;

        let raw = content(&server);
        assert_eq!(accepted_view(&parse(&raw)), "[[../articles/x|C++ and more]]");
        assert_eq!(base_view(&parse(&raw)), original);
    }

    // Prevents: a name ending CriticMarkup's metadata or markup early
    #[test]
    fn suggestion_author_is_safe_in_metadata() {
        assert_eq!(suggestion_author("Luc's AI"), "Luc's AI");
        assert_eq!(suggestion_author("a\"b\\c\nd"), "abcd");
        assert_eq!(suggestion_author("Bob--} evil"), "Bob-- evil");
        assert_eq!(suggestion_author("a@@b"), "ab");
        assert_eq!(suggestion_author("  "), "AI");
    }

    // Prevents: the new closer pairing with a quoted opener earlier on the
    // page, so that accepting or rejecting takes a person's sentence with it
    #[tokio::test]
    async fn a_quoted_opener_stops_a_suggestion() {
        let server = test_server().await;
        let original = "Use `{++` to start one.\n\nHuman [a](https://example.com/a) here.\n";
        write_human(&server, original);

        assert_counts(&server, &agent_request(), 0, 0, 1).await;
        assert_eq!(content(&server), original);
    }

    // Prevents: `parse` reading the rest of the page as code, where `read`
    // and later edits would see the markup's metadata as page text
    #[tokio::test]
    async fn a_fence_only_parse_sees_stops_a_suggestion() {
        let server = test_server().await;
        let original = "```inline``` start\n\nHuman [a](https://example.com/a) here.\n";
        write_human(&server, original);

        assert_counts(&server, &agent_request(), 0, 0, 1).await;
        assert_eq!(content(&server), original);
    }

    // Prevents: a person in Suggesting mode getting a direct change because
    // the link happened to be an agent's text
    #[tokio::test]
    async fn suggesting_mode_suggests_even_an_agents_link() {
        let server = test_server().await;
        write_ai(&server, "See [The paper](https://example.com/a) now.");
        let mut body = person_request();
        body["protect_human"] = json!(true);

        assert_counts(&server, &body, 0, 1, 0).await;
        let raw = content(&server);
        assert_eq!(accepted_view(&parse(&raw)), "See [[../articles/x|The paper]] now.");
        assert_eq!(base_view(&parse(&raw)), "See [The paper](https://example.com/a) now.");
    }

    // Prevents: a source's title opening CriticMarkup or a comment in the
    // page, so that rejecting suggestions later takes a person's text with it
    #[tokio::test]
    async fn a_title_cannot_bring_markup_into_the_page() {
        let server = test_server().await;
        write_ai(&server, "https://example.com/a\n\nHuman paragraph.\n");
        let mut body = person_request();
        body["title"] = json!("Why {++ matters %% here");

        assert_counts(&server, &body, 1, 0, 0).await;
        assert_eq!(
            content(&server),
            "[[../articles/x|Why ++ matters % here]]\n\nHuman paragraph.\n"
        );
    }

    // Prevents: one awkward link costing the others on the page their swap
    #[tokio::test]
    async fn a_link_that_cannot_be_wrapped_leaves_the_others() {
        let server = test_server().await;
        write_human(
            &server,
            "[a](https://example.com/a)\n\nNow `{++` is quoted.\n\n[b](https://example.com/a)\n",
        );

        assert_counts(&server, &agent_request(), 0, 1, 1).await;
        assert!(accepted_view(&parse(&content(&server))).contains("[[../articles/x|a]]"));
    }

    // Prevents: the swap reaching only the in-memory doc (an evicted page
    // must load, and the change must outlive the next eviction)
    #[tokio::test]
    async fn loads_an_evicted_page_and_persists_the_swap() {
        let server = build_indexed_store_test_server_in(
            "Lens",
            &[
                ("/Notes/Page.md", PAGE, "[a](https://example.com/a)"),
                ("/articles/x.md", ARTICLE, "# X"),
            ],
        )
        .await;
        server.docs().remove(&page_id());

        assert_counts(&server, &person_request(), 1, 0, 0).await;

        server.docs().remove(&page_id());
        server.ensure_doc_loaded(&page_id()).await.unwrap();
        assert_eq!(content(&server), "[[../articles/x|a]]");
    }

    // Prevents: an unauthenticated rewrite of any page, or any read of a
    // whole folder's frontmatter
    #[tokio::test]
    async fn both_routes_take_only_a_server_token() {
        let mut authenticator = Authenticator::gen_key().unwrap();
        authenticator.set_expected_audience(Some("https://api.example.com".to_string()));
        let token = authenticator.server_token().unwrap();
        let server = Arc::new(
            Server::new_without_workers(
                None,
                Duration::from_secs(60),
                Some(authenticator),
                None,
                Vec::new(),
                CancellationToken::new(),
                false,
                None,
            )
            .await
            .unwrap(),
        );
        for (auth, expected) in [
            (None, StatusCode::UNAUTHORIZED),
            (Some("not-a-token"), StatusCode::UNAUTHORIZED),
            (Some(token.as_str()), StatusCode::NOT_FOUND),
        ] {
            let (status, _) = post_as(&server, &agent_request(), auth).await;
            assert_eq!(status, expected, "link-source with {auth:?}");
        }

        let frontmatters = |auth: Option<&str>| {
            let mut request = Request::builder()
                .method(Method::POST)
                .uri("/doc/frontmatters")
                .header("content-type", "application/json");
            if let Some(auth) = auth {
                request = request.header("authorization", format!("Bearer {auth}"));
            }
            server
                .routes()
                .oneshot(request.body(Body::from(r#"{"folder":"Lens"}"#)).unwrap())
        };
        assert_eq!(
            frontmatters(None).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            frontmatters(Some(&token)).await.unwrap().status(),
            StatusCode::OK
        );
    }
}
