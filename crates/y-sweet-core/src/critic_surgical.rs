//! Surgical CriticMarkup accept/reject: compute the delete-ranges that remove
//! markers, metadata, and discarded content while leaving the kept payload
//! characters untouched in the Y.Text.
//!
//! Why: every Y.Text character permanently carries its author's clientID
//! (provenance — docs/plans/2026-07-18-provenance-design.md). The old
//! "delete whole span, insert replacement" approach re-minted the kept text
//! under whoever clicked accept, silently re-authoring AI text as human (and
//! vice versa for rejected deletions). Deleting only the markup characters
//! preserves the payload items and therefore their authorship.
//!
//! Returns `None` when the markup string doesn't match the expected structure —
//! callers fall back to the legacy full-rewrite (via [`accept_text`] /
//! [`reject_text`]), which is always correct content-wise (it just loses
//! attribution).
//!
//! Port of `lens-editor/src/lib/criticmarkup-surgical.ts` (and the
//! `getAcceptText`/`getRejectText` helpers from `suggestion-actions.ts`).
//!
//! ## Offset convention
//!
//! All offsets (`start`, `DeletionRange::from`/`to`) are **UTF-8 byte offsets**,
//! matching the convention `edit.rs` uses when it passes
//! `critic_markup::merge_edit`'s `raw_offset`/`raw_len` (byte offsets computed
//! with `match_indices` and byte slicing) directly to `Text::remove_range`.
//! This works because the yrs `Doc`s in this codebase are built with the
//! default `OffsetKind::Bytes` (see the note in
//! `y-sweet-core/src/link_indexer.rs`), so Y.Text positions ARE byte offsets.
//! The TS original uses JS string indices (UTF-16 code units) against the
//! y-crdt UTF-16 addressing of the same text — each side addresses its own
//! string representation, so the deletions select the same characters.
//! All slicing below is char-boundary-safe: mismatched boundaries return
//! `None` (structure mismatch) instead of panicking.

/// A half-open `[from, to)` range of UTF-8 byte offsets to delete.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeletionRange {
    pub from: usize,
    pub to: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkupType {
    Addition,
    Deletion,
    Substitution,
    Highlight,
    Comment,
}

impl From<crate::critic_scanner::SuggestionType> for MarkupType {
    fn from(t: crate::critic_scanner::SuggestionType) -> Self {
        use crate::critic_scanner::SuggestionType;
        match t {
            SuggestionType::Addition => MarkupType::Addition,
            SuggestionType::Deletion => MarkupType::Deletion,
            SuggestionType::Substitution => MarkupType::Substitution,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SuggestionAction {
    Accept,
    Reject,
}

impl MarkupType {
    fn opener(self) -> &'static str {
        match self {
            MarkupType::Addition => "{++",
            MarkupType::Deletion => "{--",
            MarkupType::Substitution => "{~~",
            MarkupType::Highlight => "{==",
            MarkupType::Comment => "{>>",
        }
    }

    fn closer(self) -> &'static str {
        match self {
            MarkupType::Addition => "++}",
            MarkupType::Deletion => "--}",
            MarkupType::Substitution => "~~}",
            MarkupType::Highlight => "==}",
            MarkupType::Comment => "<<}",
        }
    }
}

pub struct SurgicalOpts<'a> {
    pub markup: &'a str,
    /// Absolute byte offset of the markup in the document.
    pub start: usize,
    pub markup_type: MarkupType,
    pub action: SuggestionAction,
    /// Payload for non-substitution types.
    pub content: &'a str,
    pub old_content: Option<&'a str>,
    pub new_content: Option<&'a str>,
}

/// Compute the deletion ranges that apply `action` to the suggestion while
/// keeping the surviving payload characters (and their authorship) in place.
///
/// Returns `None` when `markup` doesn't have the expected structure; the
/// caller should fall back to a whole-span replace using [`accept_text`] /
/// [`reject_text`].
pub fn surgical_deletions(opts: &SurgicalOpts) -> Option<Vec<DeletionRange>> {
    let SurgicalOpts {
        markup,
        start,
        markup_type,
        action,
        ..
    } = *opts;
    let open = markup_type.opener();
    let close = markup_type.closer();
    if !markup.starts_with(open) || !markup.ends_with(close) {
        return None;
    }
    let end = start + markup.len();
    // Mirrors JS `markup.slice(open.length, -close.length)`: empty when the
    // marker pair overlaps (e.g. "{++}"). Delimiters are ASCII, so these
    // indices are always char boundaries.
    let inner_end = markup.len().saturating_sub(close.len());
    let inner = if inner_end >= open.len() {
        &markup[open.len()..inner_end]
    } else {
        ""
    };

    let whole_span = vec![DeletionRange {
        from: start,
        to: end,
    }];

    // Cases where nothing survives: the whole span goes.
    if markup_type == MarkupType::Comment {
        return Some(whole_span);
    }
    if markup_type == MarkupType::Addition && action == SuggestionAction::Reject {
        return Some(whole_span);
    }
    if markup_type == MarkupType::Deletion && action == SuggestionAction::Accept {
        return Some(whole_span);
    }

    if markup_type == MarkupType::Substitution {
        let old_content = opts.old_content.unwrap_or("");
        let new_content = opts.new_content.unwrap_or("");
        // inner = <meta?> old ~> new  — locate from the end, metadata is a prefix.
        let sep_idx = inner.len().checked_sub(new_content.len() + 2)?;
        let old_start = sep_idx.checked_sub(old_content.len())?;
        if inner.get(sep_idx..sep_idx + 2) != Some("~>") {
            return None;
        }
        if inner.get(old_start..sep_idx) != Some(old_content) {
            return None;
        }
        if inner.get(sep_idx + 2..) != Some(new_content) {
            return None;
        }

        let abs_old_start = start + open.len() + old_start;
        let abs_new_start = start + open.len() + sep_idx + 2;
        if action == SuggestionAction::Accept {
            // Remove open+meta+old+sep, keep new, remove close.
            return Some(vec![
                DeletionRange {
                    from: start,
                    to: abs_new_start,
                },
                DeletionRange {
                    from: abs_new_start + new_content.len(),
                    to: end,
                },
            ]);
        }
        // Reject: remove open+meta, keep old, remove sep+new+close.
        return Some(vec![
            DeletionRange {
                from: start,
                to: abs_old_start,
            },
            DeletionRange {
                from: abs_old_start + old_content.len(),
                to: end,
            },
        ]);
    }

    // addition-accept, deletion-reject, highlight-either: keep `content`,
    // which is the suffix of `inner` (metadata, when present, is the prefix).
    let content = opts.content;
    let content_start = inner.len().checked_sub(content.len())?;
    if inner.get(content_start..) != Some(content) {
        return None;
    }

    let abs_content_start = start + open.len() + content_start;
    Some(vec![
        DeletionRange {
            from: start,
            to: abs_content_start,
        },
        DeletionRange {
            from: abs_content_start + content.len(),
            to: end,
        },
    ])
}

/// Replacement text when accepting a suggestion via the fallback whole-span
/// replace (port of `getAcceptText` in `suggestion-actions.ts`, which only
/// handles addition/deletion/substitution; highlight/comment follow the
/// surgical semantics — highlight keeps its payload, comment keeps nothing).
pub fn accept_text(markup_type: MarkupType, content: &str, new_content: Option<&str>) -> String {
    match markup_type {
        MarkupType::Addition => content.to_string(),
        MarkupType::Deletion => String::new(),
        MarkupType::Substitution => new_content.unwrap_or("").to_string(),
        MarkupType::Highlight => content.to_string(),
        MarkupType::Comment => String::new(),
    }
}

/// Replacement text when rejecting a suggestion via the fallback whole-span
/// replace (port of `getRejectText` in `suggestion-actions.ts`; see
/// [`accept_text`] for the highlight/comment extension).
pub fn reject_text(markup_type: MarkupType, content: &str, old_content: Option<&str>) -> String {
    match markup_type {
        MarkupType::Addition => String::new(),
        MarkupType::Deletion => content.to_string(),
        MarkupType::Substitution => old_content.unwrap_or("").to_string(),
        MarkupType::Highlight => content.to_string(),
        MarkupType::Comment => String::new(),
    }
}

/// One planned accept/reject operation, ready to apply to a Y.Text.
pub struct PlannedOp {
    /// Index into the request's suggestion list.
    pub index: usize,
    /// Byte offset of the markup span in the body snapshot.
    pub span_start: usize,
    /// Byte length of the markup span.
    pub span_len: usize,
    /// Delete-ranges, sorted descending by `from`.
    pub deletions: Vec<DeletionRange>,
    /// Whole-span replacement text for the fallback path (structure
    /// mismatch); `None` on the surgical path.
    pub fallback_insert: Option<String>,
}

pub struct PlanFailure {
    pub index: usize,
    pub reason: String,
}

/// Plan a batch of accept/reject operations against one body snapshot.
///
/// Suggestions are located via a single [`crate::critic_scanner`] pass —
/// duplicate markups claim distinct occurrences in scan order, and a
/// `raw_markup` that is not a complete markup in the body cannot match a
/// substring of a larger one. Returned ops are sorted descending by span
/// start so appliers never shift a later op's offsets.
pub fn plan_batch(
    body: &str,
    items: &[crate::critic_scanner::Suggestion],
    action: SuggestionAction,
) -> (Vec<PlannedOp>, Vec<PlanFailure>) {
    use std::collections::{HashMap, VecDeque};

    let scanned = crate::critic_scanner::scan_suggestions(body);
    let mut occurrences: HashMap<&str, VecDeque<usize>> = HashMap::new();
    for sug in &scanned {
        occurrences
            .entry(sug.raw_markup.as_str())
            .or_default()
            .push_back(sug.from);
    }

    let mut ops = Vec::new();
    let mut failures = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let Some(span_start) = occurrences
            .get_mut(item.raw_markup.as_str())
            .and_then(|q| q.pop_front())
        else {
            failures.push(PlanFailure {
                index,
                reason: "suggestion no longer found in document".to_string(),
            });
            continue;
        };
        let markup_type = MarkupType::from(item.suggestion_type);

        let planned = surgical_deletions(&SurgicalOpts {
            markup: &item.raw_markup,
            start: span_start,
            markup_type,
            action,
            content: &item.content,
            old_content: item.old_content.as_deref(),
            new_content: item.new_content.as_deref(),
        });
        let (mut deletions, fallback_insert) = match planned {
            Some(d) => (d, None),
            None => {
                // Structure mismatch — whole-span replace (correct content,
                // loses attribution for inserted text).
                let replacement = match action {
                    SuggestionAction::Accept => {
                        accept_text(markup_type, &item.content, item.new_content.as_deref())
                    }
                    SuggestionAction::Reject => {
                        reject_text(markup_type, &item.content, item.old_content.as_deref())
                    }
                };
                (
                    vec![DeletionRange {
                        from: span_start,
                        to: span_start + item.raw_markup.len(),
                    }],
                    Some(replacement),
                )
            }
        };
        deletions.sort_by(|a, b| b.from.cmp(&a.from));
        ops.push(PlannedOp {
            index,
            span_start,
            span_len: item.raw_markup.len(),
            deletions,
            fallback_insert,
        });
    }
    ops.sort_by(|a, b| b.span_start.cmp(&a.span_start));

    // The scanner's regexes run independently, so nested markup (an addition
    // inside a substitution, say) yields two suggestions whose spans overlap.
    // Applying both would let the inner op's deletions shift the outer op's
    // precomputed ranges — corrupting the splice or panicking mid-
    // transaction. Keep the first op claiming a region (descending order:
    // the right-most span wins); fail the rest.
    let mut min_kept_start = usize::MAX;
    ops.retain(|op| {
        if op.span_start + op.span_len > min_kept_start {
            failures.push(PlanFailure {
                index: op.index,
                reason: "suggestion overlaps another suggestion in this batch".to_string(),
            });
            return false;
        }
        min_kept_start = op.span_start;
        true
    });
    (ops, failures)
}

#[cfg(test)]
mod tests {
    use super::*;

    const META: &str = r#"{"author":"Luc's AI","timestamp":1784380170036}@@"#;

    fn apply_deletions(doc: &str, ranges: &[DeletionRange]) -> String {
        let mut out = doc.to_string();
        let mut sorted = ranges.to_vec();
        sorted.sort_by(|a, b| b.from.cmp(&a.from));
        for r in sorted {
            out.replace_range(r.from..r.to, "");
        }
        out
    }

    // --- surgicalDeletions (criticmarkup-surgical.test.ts) ---

    #[test]
    fn accept_addition_deletes_only_markers_and_metadata_keeping_payload() {
        let markup = format!("{{++{META}hello world++}}");
        let doc = format!("before {markup} after");
        let ranges = surgical_deletions(&SurgicalOpts {
            markup: &markup,
            start: 7,
            markup_type: MarkupType::Addition,
            action: SuggestionAction::Accept,
            content: "hello world",
            old_content: None,
            new_content: None,
        })
        .expect("ranges should not be None");
        assert_eq!(apply_deletions(&doc, &ranges), "before hello world after");
        // Payload chars must not be inside any deleted range.
        let payload_start = 7 + markup.find("hello world").unwrap();
        for r in &ranges {
            assert!(r.to <= payload_start || r.from >= payload_start + "hello world".len());
        }
    }

    #[test]
    fn reject_addition_deletes_the_whole_span() {
        let markup = format!("{{++{META}zap++}}");
        let doc = format!("a {markup} b");
        let ranges = surgical_deletions(&SurgicalOpts {
            markup: &markup,
            start: 2,
            markup_type: MarkupType::Addition,
            action: SuggestionAction::Reject,
            content: "zap",
            old_content: None,
            new_content: None,
        })
        .unwrap();
        assert_eq!(apply_deletions(&doc, &ranges), "a  b");
    }

    #[test]
    fn accept_deletion_removes_everything_reject_keeps_original_content() {
        let markup = format!("{{--{META}old text--}}");
        let doc = format!("x {markup} y");
        let acc = surgical_deletions(&SurgicalOpts {
            markup: &markup,
            start: 2,
            markup_type: MarkupType::Deletion,
            action: SuggestionAction::Accept,
            content: "old text",
            old_content: None,
            new_content: None,
        })
        .unwrap();
        assert_eq!(apply_deletions(&doc, &acc), "x  y");
        let rej = surgical_deletions(&SurgicalOpts {
            markup: &markup,
            start: 2,
            markup_type: MarkupType::Deletion,
            action: SuggestionAction::Reject,
            content: "old text",
            old_content: None,
            new_content: None,
        })
        .unwrap();
        assert_eq!(apply_deletions(&doc, &rej), "x old text y");
    }

    #[test]
    fn substitution_keeps_the_right_side_per_action() {
        let markup = format!("{{~~{META}old stuff~>new stuff~~}}");
        let doc = format!("A {markup} B");
        let acc = surgical_deletions(&SurgicalOpts {
            markup: &markup,
            start: 2,
            markup_type: MarkupType::Substitution,
            action: SuggestionAction::Accept,
            content: "",
            old_content: Some("old stuff"),
            new_content: Some("new stuff"),
        })
        .unwrap();
        assert_eq!(apply_deletions(&doc, &acc), "A new stuff B");
        let rej = surgical_deletions(&SurgicalOpts {
            markup: &markup,
            start: 2,
            markup_type: MarkupType::Substitution,
            action: SuggestionAction::Reject,
            content: "",
            old_content: Some("old stuff"),
            new_content: Some("new stuff"),
        })
        .unwrap();
        assert_eq!(apply_deletions(&doc, &rej), "A old stuff B");
    }

    #[test]
    fn works_without_metadata_prefix() {
        let markup = "{++plain++}";
        let ranges = surgical_deletions(&SurgicalOpts {
            markup,
            start: 0,
            markup_type: MarkupType::Addition,
            action: SuggestionAction::Accept,
            content: "plain",
            old_content: None,
            new_content: None,
        })
        .unwrap();
        assert_eq!(apply_deletions(markup, &ranges), "plain");
    }

    #[test]
    fn returns_none_when_the_markup_does_not_match_the_expected_structure() {
        assert_eq!(
            surgical_deletions(&SurgicalOpts {
                markup: "{++broken",
                start: 0,
                markup_type: MarkupType::Addition,
                action: SuggestionAction::Accept,
                content: "nope",
                old_content: None,
                new_content: None,
            }),
            None
        );
        let markup = format!("{{~~{META}old~>new~~}}");
        assert_eq!(
            surgical_deletions(&SurgicalOpts {
                markup: &markup,
                start: 0,
                markup_type: MarkupType::Substitution,
                action: SuggestionAction::Accept,
                content: "",
                old_content: Some("MISMATCH"),
                new_content: Some("new"),
            }),
            None
        );
    }

    #[test]
    fn multibyte_content_never_panics_on_structure_mismatch() {
        // Not in the TS suite (JS indexing can't land mid-char): a mismatched
        // old/new whose lengths put a probe inside a multi-byte char must
        // return None, not panic.
        let markup = "{~~héllo~>wörld~~}";
        assert_eq!(
            surgical_deletions(&SurgicalOpts {
                markup,
                start: 0,
                markup_type: MarkupType::Substitution,
                action: SuggestionAction::Accept,
                content: "",
                old_content: Some("x"),
                new_content: Some("wrong-length"),
            }),
            None
        );
        // And a well-formed multibyte substitution still works, byte-addressed.
        let acc = surgical_deletions(&SurgicalOpts {
            markup,
            start: 0,
            markup_type: MarkupType::Substitution,
            action: SuggestionAction::Accept,
            content: "",
            old_content: Some("héllo"),
            new_content: Some("wörld"),
        })
        .unwrap();
        assert_eq!(apply_deletions(markup, &acc), "wörld");
    }

    // --- accept_text / reject_text (suggestion-actions.ts) ---

    #[test]
    fn accept_and_reject_text_mirror_suggestion_actions() {
        assert_eq!(accept_text(MarkupType::Addition, "add", None), "add");
        assert_eq!(accept_text(MarkupType::Deletion, "del", None), "");
        assert_eq!(
            accept_text(MarkupType::Substitution, "", Some("new")),
            "new"
        );
        assert_eq!(accept_text(MarkupType::Substitution, "", None), "");
        assert_eq!(reject_text(MarkupType::Addition, "add", None), "");
        assert_eq!(reject_text(MarkupType::Deletion, "del", None), "del");
        assert_eq!(
            reject_text(MarkupType::Substitution, "", Some("old")),
            "old"
        );
        assert_eq!(reject_text(MarkupType::Substitution, "", None), "");
    }

    // --- authorship preservation (the whole point) ---
    //
    // Port of the "applySuggestionAction preserves authorship" describe block.
    // The TS tests drive applySuggestionAction and inspect authorship runs via
    // getAuthorshipRuns; here we drive surgical_deletions + remove_range on a
    // real yrs doc and assert the CRDT-level equivalent: the deletions mint no
    // new items (state-vector clocks unchanged for both clients), so every
    // surviving character keeps its original author's clientID.

    mod authorship {
        use super::*;
        use yrs::updates::decoder::Decode;
        use yrs::{Doc, GetString, ReadTxn, Text, Transact, Update, WriteTxn};

        const AI_CLIENT_ID: u64 = 424242;

        fn sync(from: &Doc, to: &Doc) {
            let update = from
                .transact()
                .encode_state_as_update_v1(&to.transact().state_vector());
            to.transact_mut()
                .apply_update(Update::decode_v1(&update).unwrap());
        }

        fn contents(doc: &Doc) -> String {
            let txn = doc.transact();
            txn.get_text("contents").unwrap().get_string(&txn)
        }

        fn clocks(doc: &Doc, human_id: u64) -> (u32, u32) {
            let txn = doc.transact();
            let sv = txn.state_vector();
            (sv.get(&human_id), sv.get(&AI_CLIENT_ID))
        }

        /// Find the markup and apply the surgical deletions to the human's
        /// doc, mirroring applySuggestionAction's surgical path (descending
        /// order so earlier deletes don't shift later offsets).
        fn apply_surgical(doc: &Doc, opts: &SurgicalOpts) {
            let mut ranges = surgical_deletions(opts).expect("surgical path should apply");
            ranges.sort_by(|a, b| b.from.cmp(&a.from));
            let mut txn = doc.transact_mut();
            let text = txn.get_or_insert_text("contents");
            for r in ranges {
                text.remove_range(&mut txn, r.from as u32, (r.to - r.from) as u32);
            }
        }

        #[test]
        fn accepted_ai_text_keeps_the_ai_client_id() {
            // Human writes a sentence...
            let human_doc = Doc::new();
            let human_id = human_doc.client_id();
            {
                let mut txn = human_doc.transact_mut();
                let text = txn.get_or_insert_text("contents");
                text.insert(&mut txn, 0, "Human prose. ");
            }
            // ...then the "AI" (different clientID) inserts a suggestion after it.
            let markup = format!("{{++{META}AI payload text.++}}");
            let ai_doc = Doc::with_client_id(AI_CLIENT_ID);
            sync(&human_doc, &ai_doc);
            {
                let mut txn = ai_doc.transact_mut();
                let text = txn.get_or_insert_text("contents");
                text.insert(&mut txn, "Human prose. ".len() as u32, &markup);
            }
            sync(&ai_doc, &human_doc);

            let before = clocks(&human_doc, human_id);
            assert!(before.0 > 0 && before.1 > 0);

            apply_surgical(
                &human_doc,
                &SurgicalOpts {
                    markup: &markup,
                    start: contents(&human_doc).find(&markup).unwrap(),
                    markup_type: MarkupType::Addition,
                    action: SuggestionAction::Accept,
                    content: "AI payload text.",
                    old_content: None,
                    new_content: None,
                },
            );

            assert_eq!(contents(&human_doc), "Human prose. AI payload text.");
            // No items were minted by the accept: the kept payload (bytes
            // 13..29) still consists of the AI's original items, the prefix of
            // the human's — the runs [{0,13,human},{13,29,ai}] from the TS test.
            assert_eq!(clocks(&human_doc, human_id), before);
        }

        #[test]
        fn rejected_deletion_keeps_the_original_author() {
            let human_doc = Doc::new();
            let human_id = human_doc.client_id();
            {
                let mut txn = human_doc.transact_mut();
                let text = txn.get_or_insert_text("contents");
                text.insert(&mut txn, 0, "keep me");
            }
            // AI wraps the human text in a delete-suggestion: {--<meta>keep me--}
            let markup = format!("{{--{META}keep me--}}");
            let ai_doc = Doc::with_client_id(AI_CLIENT_ID);
            sync(&human_doc, &ai_doc);
            {
                // Simulate the server merge: markers+meta inserted around the human text.
                let open = format!("{{--{META}");
                let mut txn = ai_doc.transact_mut();
                let text = txn.get_or_insert_text("contents");
                text.insert(&mut txn, 0, &open);
                text.insert(&mut txn, (open.len() + "keep me".len()) as u32, "--}");
            }
            sync(&ai_doc, &human_doc);
            assert_eq!(contents(&human_doc), markup);

            let before = clocks(&human_doc, human_id);
            apply_surgical(
                &human_doc,
                &SurgicalOpts {
                    markup: &markup,
                    start: 0,
                    markup_type: MarkupType::Deletion,
                    action: SuggestionAction::Reject,
                    content: "keep me",
                    old_content: None,
                    new_content: None,
                },
            );

            assert_eq!(contents(&human_doc), "keep me");
            // The surviving text is the human's original items: the reject
            // minted nothing, and every AI-authored char (markers + metadata)
            // was deleted — the single run [{0,7,human}] from the TS test.
            assert_eq!(clocks(&human_doc, human_id), before);
        }
    }

    #[test]
    fn plan_batch_fails_overlapping_nested_markup() {
        use crate::critic_scanner::{scan_suggestions, Suggestion};
        // The scanner emits BOTH the outer substitution and the inner
        // addition for nested markup; applying both would corrupt the doc.
        let body = "start {~~a {++x++} b~>c~~} end";
        let items: Vec<Suggestion> = scan_suggestions(body);
        assert_eq!(items.len(), 2, "scanner should see nested spans");

        let (ops, failures) = plan_batch(body, &items, SuggestionAction::Accept);
        assert_eq!(ops.len(), 1, "only one of the overlapping ops may survive");
        assert_eq!(failures.len(), 1);
        assert!(failures[0].reason.contains("overlaps"));

        // The survivor must apply cleanly to the body.
        let op = &ops[0];
        let mut result = body.to_string();
        for d in &op.deletions {
            result.replace_range(d.from..d.to, "");
        }
        if let Some(insert) = &op.fallback_insert {
            result.insert_str(op.span_start, insert);
        }
        assert!(
            result.starts_with("start "),
            "splice stayed in bounds: {result}"
        );
    }
}
