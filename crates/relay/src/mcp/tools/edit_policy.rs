//! Direct-vs-suggestion policy for Markdown `edit` calls.
//!
//! The server, not the AI, decides whether an edit is applied directly or
//! becomes a CriticMarkup suggestion (docs/plans/2026-08-27-direct-mcp-edits-plan.md
//! §3.1). Pure functions here; `edit.rs` wires them to the doc under the
//! awareness write lock.
//!
//! Rules, in order:
//! 1. The change is the **minimal char-level diff** between the matched text
//!    and the replacement — surrounding context the AI included for
//!    uniqueness is never "changed". Curly/straight quotes compare equal so
//!    a quote-normalised match doesn't count as a deleted human character.
//! 2. Any hunk that touches a comment/highlight/substitution markup range
//!    (`{>>…<<}`, `{==…==}`, `{~~…~~}`, which the span parser leaves inline
//!    as plain text) → suggestion.
//! 3. Any hunk whose deleted range does not map onto exactly one plain
//!    (non-suggestion) region of the raw document, or whose insertion point
//!    is not inside a plain region → suggestion. Edits inside pending
//!    suggestions keep the existing supersede/merge behaviour.
//! 4. Every character actually deleted must be attributed to an `ai:` actor
//!    via the doc's `users` map. Human, unmapped, or unresolvable → suggestion.
//! 5. An insertion that splits a word (word characters on both sides of the
//!    insertion point) counts as editing that word: both neighbouring
//!    characters must be AI-attributed too ("humxan" is a rewrite of a human
//!    word, not an addition).
//! 6. Deleted *whitespace* is never protected: removing a separator the
//!    human typed between paragraphs is not removing their content, and the
//!    AI deleting its own paragraph almost always takes a newline with it.
//!
//! Pure insertions (no deleted characters) that pass 2–3 and 5 are direct.

use super::critic_markup::{compute_raw_positions, spans_covering_accepted_range, Span};
use crate::mcp::provenance::{clients_in_range, Run};
use similar::{capture_diff_slices, capture_diff_slices_deadline, Algorithm, DiffOp};
use std::collections::HashMap;

/// One minimal-diff hunk. Offsets are UTF-8 bytes into the matched old
/// text (`old_*`) and into the replacement (`new_*`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hunk {
    pub old_from: usize,
    pub old_to: usize,
    pub new_from: usize,
    pub new_to: usize,
}

impl Hunk {
    pub fn deletes(&self) -> bool {
        self.old_to > self.old_from
    }
}

fn normalize_quote(c: char) -> char {
    match c {
        '\u{201C}' | '\u{201D}' => '"',
        '\u{2018}' | '\u{2019}' => '\'',
        _ => c,
    }
}

/// Byte offset of each char index (plus one past the end).
fn byte_prefix(chars: &[char]) -> Vec<usize> {
    let mut out = Vec::with_capacity(chars.len() + 1);
    let mut pos = 0;
    for c in chars {
        out.push(pos);
        pos += c.len_utf8();
    }
    out.push(pos);
    out
}

/// Minimal char-level diff from `old` to `new` as byte-offset hunks, with
/// touching hunks merged. Empty when the strings are (quote-)equal.
pub fn minimal_hunks(old: &str, new: &str) -> Vec<Hunk> {
    minimal_hunks_with(old, new, true, &[], true)
}

/// Like [`minimal_hunks`] but with exact char equality (no quote
/// normalisation). Used to apply a suggestion-path replacement so that
/// applying the hunks yields exactly `new`.
pub fn minimal_hunks_exact(old: &str, new: &str) -> Vec<Hunk> {
    minimal_hunks_with(old, new, false, &[], false)
}

/// [`minimal_hunks_exact`] where chars of `new` inside `unmatchable` byte
/// ranges can never be aligned with chars of `old` — used when applying a
/// CriticMarkup suggestion so the human's old text is only ever matched
/// against verbatim copies of old text, never against freshly generated
/// delimiters, metadata or AI-written payload.
pub fn minimal_hunks_exact_masked(
    old: &str,
    new: &str,
    unmatchable: &[(usize, usize)],
) -> Vec<Hunk> {
    minimal_hunks_with(old, new, false, unmatchable, false)
}

/// Policy diffs (deciding direct vs. suggestion) may be coarse: a
/// non-minimal diff only makes more text look changed, which errs towards a
/// suggestion. Beyond this many chars the Myers search is skipped entirely
/// and the whole span becomes one hunk.
const POLICY_DIFF_MAX_CHARS: usize = 200_000;
const POLICY_DIFF_DEADLINE: std::time::Duration = std::time::Duration::from_millis(150);

fn minimal_hunks_with(
    old: &str,
    new: &str,
    normalize_quotes: bool,
    unmatchable: &[(usize, usize)],
    bounded: bool,
) -> Vec<Hunk> {
    let old_chars: Vec<char> = old.chars().collect();
    let new_chars: Vec<char> = new.chars().collect();
    let old_bytes = byte_prefix(&old_chars);
    let new_bytes = byte_prefix(&new_chars);
    let norm = |c: char| -> u32 {
        if normalize_quotes {
            normalize_quote(c) as u32
        } else {
            c as u32
        }
    };
    let old_keys: Vec<u32> = old_chars.iter().map(|&c| norm(c)).collect();
    // Unmatchable chars get a key no char can equal (above the Unicode
    // range, unique per position so they don't even match each other).
    let new_keys: Vec<u32> = new_chars
        .iter()
        .enumerate()
        .map(|(i, &c)| {
            let b = new_bytes[i];
            if unmatchable.iter().any(|&(f, t)| b >= f && b < t) {
                0x2000_0000 | i as u32
            } else {
                norm(c)
            }
        })
        .collect();

    let ops = if bounded && old_keys.len() + new_keys.len() > POLICY_DIFF_MAX_CHARS {
        vec![DiffOp::Replace {
            old_index: 0,
            old_len: old_keys.len(),
            new_index: 0,
            new_len: new_keys.len(),
        }]
    } else if bounded {
        capture_diff_slices_deadline(
            Algorithm::Myers,
            &old_keys,
            &new_keys,
            Some(std::time::Instant::now() + POLICY_DIFF_DEADLINE),
        )
    } else {
        capture_diff_slices(Algorithm::Myers, &old_keys, &new_keys)
    };
    let mut hunks: Vec<Hunk> = Vec::new();
    // Positions come from walking the op sequence, never from the indices
    // the ops carry. `similar` 2.7's Myers output can report an `Insert`
    // whose `old_index` lies inside the preceding `Delete` (e.g. `4on").` →
    // `4.2]].` yields Delete(1..5) then Insert at old 2 instead of 6); the op
    // *order* is still a valid script, and applying the reported offsets
    // interleaves the insertion with the deletion and garbles the text.
    let (mut oi, mut ni) = (0usize, 0usize);
    for op in ops {
        let (ol, nl) = match op {
            DiffOp::Equal { len, .. } => {
                oi += len;
                ni += len;
                continue;
            }
            DiffOp::Delete { old_len, .. } => (old_len, 0),
            DiffOp::Insert { new_len, .. } => (0, new_len),
            DiffOp::Replace {
                old_len, new_len, ..
            } => (old_len, new_len),
        };
        let hunk = Hunk {
            old_from: old_bytes[oi],
            old_to: old_bytes[oi + ol],
            new_from: new_bytes[ni],
            new_to: new_bytes[ni + nl],
        };
        oi += ol;
        ni += nl;
        match hunks.last_mut() {
            Some(last) if last.old_to == hunk.old_from && last.new_to == hunk.new_from => {
                last.old_to = hunk.old_to;
                last.new_to = hunk.new_to;
            }
            _ => hunks.push(hunk),
        }
    }
    hunks
}

/// Byte ranges (delimiters included) of markup the span parser leaves
/// inline: comments, highlights and substitutions.
pub fn protected_markup_ranges(text: &str) -> Vec<(usize, usize)> {
    const PAIRS: [(&str, &str); 3] = [("{>>", "<<}"), ("{==", "==}"), ("{~~", "~~}")];
    let mut ranges = Vec::new();
    for (open, close) in PAIRS {
        let mut search = 0;
        while let Some(rel) = text[search..].find(open) {
            let start = search + rel;
            match text[start + open.len()..].find(close) {
                Some(rel_end) => {
                    let end = start + open.len() + rel_end + close.len();
                    ranges.push((start, end));
                    search = end;
                }
                None => break,
            }
        }
    }
    ranges.sort_unstable();
    ranges
}

/// True when a change over accepted-view bytes `[from, to)` intersects a
/// protected range, or a pure insertion (`from == to`) lands strictly inside
/// one.
pub fn touches_protected(ranges: &[(usize, usize)], from: usize, to: usize) -> bool {
    ranges.iter().any(|&(a, b)| {
        if from == to {
            a < from && from < b
        } else {
            from < b && to > a
        }
    })
}

/// A hunk mapped onto the raw document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawHunk {
    pub raw_from: usize,
    pub raw_len: usize,
    pub new_text: String,
    /// Raw byte ranges whose authorship must be AI for the hunk to apply
    /// directly: the deleted non-whitespace characters (rules 4 and 6) plus,
    /// for an insertion that splits a word, the characters on either side of
    /// the insertion point (rule 5). Empty for a plain insertion.
    pub guard: Vec<(usize, usize)>,
}

/// Maximal non-whitespace sub-ranges of `text[from..to]`, as absolute ranges.
fn non_whitespace_ranges(text: &str, from: usize, to: usize) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    for (i, c) in text[from..to].char_indices() {
        let abs = from + i;
        if c.is_whitespace() {
            if let Some(s) = start.take() {
                out.push((s, abs));
            }
        } else if start.is_none() {
            start = Some(abs);
        }
    }
    if let Some(s) = start {
        out.push((s, to));
    }
    out
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric()
        || matches!(c, '_' | '\'' | '\u{2019}' | '-')
        || is_combining_mark(c)
}

/// Combining diacritics (the common blocks); a base letter plus mark is one
/// word character for our purposes.
fn is_combining_mark(c: char) -> bool {
    matches!(
        c as u32,
        0x0300..=0x036F | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF | 0xFE20..=0xFE2F
    )
}

/// Chars around a whitespace-only deletion `[from, to)` when removing it
/// would join two words, or (when the deletion holds a newline) two
/// non-blank lines.
fn joining_neighbours(text: &str, from: usize, to: usize, deleted: &str) -> Option<(char, char)> {
    let before = text[..from].chars().next_back()?;
    let after = text[to..].chars().next()?;
    let joins_words = is_word_char(before) && is_word_char(after);
    let joins_lines =
        deleted.contains('\n') && !before.is_whitespace() && !after.is_whitespace();
    (joins_words || joins_lines).then_some((before, after))
}

/// Chars immediately before and after `at` in `text` when both are word
/// characters (i.e. inserting at `at` would split a word).
fn word_split_neighbours(text: &str, at: usize) -> Option<(char, char)> {
    let before = text[..at].chars().next_back()?;
    let after = text[at..].chars().next()?;
    if is_word_char(before) && is_word_char(after) {
        Some((before, after))
    } else {
        None
    }
}

/// Map an accepted-view range onto the raw document. Deletions must be
/// covered by exactly one plain span; insertion points must lie inside a
/// plain span, or at its edge only when no pending suggestion is adjacent
/// (an insertion right next to a suggestion belongs to it and goes through
/// the merge path, so accepting/rejecting keeps the intended text). `None`
/// means the hunk touches pending suggestion markup.
pub fn accepted_range_to_raw(
    spans: &[Span],
    raw_positions: &[usize],
    from: usize,
    to: usize,
) -> Option<(usize, usize)> {
    if from == to {
        let mut cursor = 0usize;
        for (i, span) in spans.iter().enumerate() {
            match span {
                Span::Plain(text) => {
                    let end = cursor + text.len();
                    if cursor <= from && from <= end {
                        let at_start_after_markup = from == cursor && i > 0;
                        let at_end_before_markup = from == end && i + 1 < spans.len();
                        if at_start_after_markup || at_end_before_markup {
                            return None;
                        }
                        return Some((raw_positions[i] + (from - cursor), 0));
                    }
                    cursor = end;
                }
                Span::Suggestion { inserted, .. } => cursor += inserted.len(),
            }
        }
        // Empty document (no spans) — insertion at 0.
        if spans.is_empty() && from == 0 {
            return Some((0, 0));
        }
        return None;
    }
    let covered = spans_covering_accepted_range(spans, from, to - from);
    if covered.len() != 1 {
        return None;
    }
    let c = &covered[0];
    match &spans[c.span_index] {
        Span::Plain(_) => Some((raw_positions[c.span_index] + c.start_within, c.len_within)),
        Span::Suggestion { .. } => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Direct(Vec<RawHunk>),
    Suggest(SuggestReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SuggestReason {
    Requested,
    /// Touches pending suggestions, comments, or highlights.
    OverlapsMarkup,
    /// Deleted text is human-written or unattributed.
    ProtectedText,
    /// Provenance could not be resolved.
    Unresolvable,
}

impl SuggestReason {
    pub fn describe(self) -> &'static str {
        match self {
            SuggestReason::Requested => "suggestion mode was requested",
            SuggestReason::OverlapsMarkup => {
                "the edit overlaps pending changes, comments, or highlights"
            }
            SuggestReason::ProtectedText => {
                "the edit would replace human-written or unattributed text"
            }
            SuggestReason::Unresolvable => "authorship of the replaced text could not be verified",
        }
    }
}

/// Everything the policy needs about the current document state.
pub struct PolicyInput<'a> {
    pub raw: &'a str,
    pub spans: &'a [Span],
    pub accepted: &'a str,
    /// Accepted-view byte offset where the matched old text starts.
    pub match_start: usize,
    pub new_string: &'a str,
    pub hunks: &'a [Hunk],
}

/// Structural checks only (rules 2–3): map hunks to raw or explain why not.
pub fn map_hunks(input: &PolicyInput) -> Result<Vec<RawHunk>, SuggestReason> {
    let raw_positions = compute_raw_positions(input.raw, input.spans);
    let protected = protected_markup_ranges(input.accepted);
    let mut out = Vec::with_capacity(input.hunks.len());
    for h in input.hunks {
        let from = input.match_start + h.old_from;
        let to = input.match_start + h.old_to;
        if touches_protected(&protected, from, to) {
            return Err(SuggestReason::OverlapsMarkup);
        }
        let (raw_from, raw_len) = accepted_range_to_raw(input.spans, &raw_positions, from, to)
            .ok_or(SuggestReason::OverlapsMarkup)?;
        let mut guard = non_whitespace_ranges(input.raw, raw_from, raw_from + raw_len);
        if from == to {
            if let Some((before, after)) = word_split_neighbours(input.accepted, from) {
                // Neighbours are plain chars adjacent to a plain insertion
                // point, so they map onto the raw doc contiguously.
                guard.push((raw_from - before.len_utf8(), raw_from));
                guard.push((raw_from, raw_from + after.len_utf8()));
            }
        } else if guard.is_empty() {
            // Rule 6: deleted whitespace is never protected by itself — but
            // removing the only separator between two words ("human wrote"
            // → "humanwrote"/"humanXwrote"), or a newline between two
            // non-blank lines (breaking a heading or list), rewrites human
            // structure. Guard both neighbours in those cases; they must be
            // plain text too (a neighbour inside a suggestion → merge path).
            let deleted = &input.accepted[from..to];
            if let Some((before, after)) = joining_neighbours(input.accepted, from, to, deleted) {
                let (b_from, b_len) =
                    accepted_range_to_raw(input.spans, &raw_positions, from - before.len_utf8(), from)
                        .ok_or(SuggestReason::OverlapsMarkup)?;
                let (a_from, a_len) =
                    accepted_range_to_raw(input.spans, &raw_positions, to, to + after.len_utf8())
                        .ok_or(SuggestReason::OverlapsMarkup)?;
                guard.push((b_from, b_from + b_len));
                guard.push((a_from, a_from + a_len));
            }
        }
        out.push(RawHunk {
            raw_from,
            raw_len,
            new_text: input.new_string[h.new_from..h.new_to].to_string(),
            guard,
        });
    }
    Ok(out)
}

/// Rules 4–6: every guard range (deleted non-whitespace text, word-split
/// neighbours) must be attributed to an `ai:` actor.
pub fn check_provenance(
    raw_hunks: &[RawHunk],
    runs: Option<&[Run]>,
    actors: &HashMap<u64, String>,
) -> Result<(), SuggestReason> {
    let ranges: Vec<(usize, usize)> = raw_hunks
        .iter()
        .flat_map(|h| h.guard.iter().copied())
        .collect();
    if ranges.is_empty() {
        return Ok(());
    }
    let runs = runs.ok_or(SuggestReason::Unresolvable)?;
    for (from, to) in ranges {
        let clients = clients_in_range(runs, from, to);
        if clients.is_empty() {
            return Err(SuggestReason::Unresolvable);
        }
        for client in clients {
            match actors.get(&client) {
                Some(actor) if actor.starts_with("ai:") => {}
                _ => return Err(SuggestReason::ProtectedText),
            }
        }
    }
    Ok(())
}

/// The coalesced change for the activity event: `[old_from, old_to)` bytes
/// of the matched text and `[new_from, new_to)` bytes of the replacement.
pub fn coalesce(hunks: &[Hunk]) -> Option<Hunk> {
    let first = hunks.first()?;
    let last = hunks.last()?;
    Some(Hunk {
        old_from: first.old_from,
        old_to: last.old_to,
        new_from: first.new_from,
        new_to: last.new_to,
    })
}

#[cfg(test)]
mod tests {
    use super::super::critic_markup::parse;
    use super::*;

    fn h(of: usize, ot: usize, nf: usize, nt: usize) -> Hunk {
        Hunk {
            old_from: of,
            old_to: ot,
            new_from: nf,
            new_to: nt,
        }
    }

    #[test]
    fn pure_insertion_is_one_zero_length_hunk() {
        assert_eq!(
            minimal_hunks("hello world", "hello brave world"),
            vec![h(6, 6, 6, 12)]
        );
    }

    #[test]
    fn replacement_hunk_covers_only_changed_chars() {
        let hunks = minimal_hunks("the cat sat", "the dog sat");
        assert_eq!(hunks, vec![h(4, 7, 4, 7)]);
        assert!(hunks[0].deletes());
    }

    #[test]
    fn deletion_hunk_has_empty_new_range() {
        assert_eq!(minimal_hunks("keep this", "keep"), vec![h(4, 9, 4, 4)]);
    }

    #[test]
    fn identical_and_quote_equivalent_strings_yield_no_hunks() {
        assert!(minimal_hunks("same", "same").is_empty());
        assert!(minimal_hunks("say \u{201C}hi\u{201D}", "say \"hi\"").is_empty());
    }

    #[test]
    fn quote_normalisation_keeps_original_offsets() {
        // curly quote is 3 bytes; the change after it must use real offsets
        let old = "\u{201C}quoted\u{201D} old";
        let new = "\"quoted\" new";
        let hunks = minimal_hunks(old, new);
        assert_eq!(hunks, vec![h(13, 16, 9, 12)]);
        assert_eq!(&old[13..16], "old");
        assert_eq!(&new[9..12], "new");
    }

    #[test]
    fn exact_hunks_apply_to_reproduce_new_string() {
        let old = "say \u{201C}hi\u{201D} now";
        let new = "say \"hi\"{++ there++} now";
        let hunks = minimal_hunks_exact(old, new);
        let mut out = old.to_string();
        for h in hunks.iter().rev() {
            out.replace_range(h.old_from..h.old_to, &new[h.new_from..h.new_to]);
        }
        assert_eq!(out, new);
        // The quote-normalised variant would treat the quotes as unchanged.
        assert!(minimal_hunks(old, "say \"hi\" now").is_empty());
    }

    #[test]
    fn touching_hunks_merge() {
        // "ab" -> "xy": Myers may emit delete+insert pairs; must coalesce
        let hunks = minimal_hunks("ab", "xy");
        assert_eq!(hunks, vec![h(0, 2, 0, 2)]);
    }

    #[test]
    fn multibyte_offsets_are_bytes() {
        let hunks = minimal_hunks("héllo wörld", "héllo wörld!");
        let old_len = "héllo wörld".len();
        assert_eq!(hunks, vec![h(old_len, old_len, old_len, old_len + 1)]);
    }

    #[test]
    fn protected_ranges_cover_comments_highlights_substitutions() {
        let text = "a {>>note<<} b {==hi==} c {~~x~>y~~} d";
        let ranges = protected_markup_ranges(text);
        assert_eq!(ranges.len(), 3);
        assert_eq!(&text[ranges[0].0..ranges[0].1], "{>>note<<}");
        assert_eq!(&text[ranges[1].0..ranges[1].1], "{==hi==}");
        assert_eq!(&text[ranges[2].0..ranges[2].1], "{~~x~>y~~}");
        assert!(touches_protected(&ranges, 0, 3)); // deletes into the "{"
        assert!(!touches_protected(&ranges, 0, 2)); // "a " only
        assert!(touches_protected(&ranges, 5, 5)); // insert inside comment
        assert!(!touches_protected(&ranges, 2, 2)); // insert right before it
        assert!(!touches_protected(&ranges, 12, 12)); // insert right after it
    }

    #[test]
    fn unterminated_markup_is_not_protected() {
        assert!(protected_markup_ranges("open {>> no close").is_empty());
    }

    #[test]
    fn raw_mapping_plain_document() {
        let raw = "plain text here";
        let spans = parse(raw);
        let pos = compute_raw_positions(raw, &spans);
        assert_eq!(accepted_range_to_raw(&spans, &pos, 6, 10), Some((6, 4)));
        assert_eq!(accepted_range_to_raw(&spans, &pos, 6, 6), Some((6, 0)));
        assert_eq!(accepted_range_to_raw(&spans, &pos, 15, 15), Some((15, 0)));
    }

    #[test]
    fn raw_mapping_skips_pending_suggestion_markup() {
        // accepted: "before NEW after"
        let raw = "before {--OLD--}{++NEW++} after";
        let spans = parse(raw);
        let pos = compute_raw_positions(raw, &spans);
        let accepted = super::super::critic_markup::accepted_view(&spans);
        assert_eq!(accepted, "before NEW after");
        // deleting "bef" is plain
        assert_eq!(accepted_range_to_raw(&spans, &pos, 0, 3), Some((0, 3)));
        // deleting "NEW" lives inside a suggestion → merge path
        assert_eq!(accepted_range_to_raw(&spans, &pos, 7, 10), None);
        // straddling plain+suggestion → merge path
        assert_eq!(accepted_range_to_raw(&spans, &pos, 5, 9), None);
        // deleting " after" maps past the markup
        let after_raw = raw.find(" after").unwrap();
        assert_eq!(
            accepted_range_to_raw(&spans, &pos, 10, 16),
            Some((after_raw, 6))
        );
        // insertion adjacent to the suggestion (either side) → merge path
        assert_eq!(accepted_range_to_raw(&spans, &pos, 7, 7), None);
        assert_eq!(accepted_range_to_raw(&spans, &pos, 10, 10), None);
        // insertion inside the suggestion payload → merge path
        assert_eq!(accepted_range_to_raw(&spans, &pos, 8, 8), None);
        // insertion inside plain text → direct
        assert_eq!(accepted_range_to_raw(&spans, &pos, 3, 3), Some((3, 0)));
    }

    #[test]
    fn raw_mapping_rejects_range_straddling_standalone_deletion() {
        // accepted: "ab cd" with a pending deletion of "X" between
        let raw = "ab {--X--} cd";
        let spans = parse(raw);
        let pos = compute_raw_positions(raw, &spans);
        assert_eq!(accepted_range_to_raw(&spans, &pos, 1, 4), None);
        assert_eq!(accepted_range_to_raw(&spans, &pos, 0, 2), Some((0, 2)));
    }

    #[test]
    fn provenance_check_requires_ai_actor_for_every_deleted_char() {
        let runs = vec![
            Run {
                from: 0,
                to: 5,
                client: 1,
                clock: 0,
            },
            Run {
                from: 5,
                to: 10,
                client: 2,
                clock: 0,
            },
        ];
        let mut actors = HashMap::new();
        actors.insert(1u64, "ai:fable-5:luc".to_string());
        actors.insert(2u64, "human:Luc".to_string());
        let del = |from, len| RawHunk {
            raw_from: from,
            raw_len: len,
            new_text: String::new(),
            guard: vec![(from, from + len)],
        };

        assert_eq!(check_provenance(&[del(0, 5)], Some(&runs), &actors), Ok(()));
        assert_eq!(
            check_provenance(&[del(3, 4)], Some(&runs), &actors),
            Err(SuggestReason::ProtectedText)
        );
        assert_eq!(
            check_provenance(&[del(6, 1)], Some(&runs), &actors),
            Err(SuggestReason::ProtectedText)
        );
        // unmapped client
        let unmapped = vec![Run {
            from: 0,
            to: 5,
            client: 9,
            clock: 0,
        }];
        assert_eq!(
            check_provenance(&[del(0, 5)], Some(&unmapped), &actors),
            Err(SuggestReason::ProtectedText)
        );
        // no runs at all
        assert_eq!(
            check_provenance(&[del(0, 5)], None, &actors),
            Err(SuggestReason::Unresolvable)
        );
        // pure insertion never consults provenance
        let ins = RawHunk {
            raw_from: 7,
            raw_len: 0,
            new_text: "x".into(),
            guard: vec![],
        };
        assert_eq!(check_provenance(&[ins], None, &actors), Ok(()));
        // ...unless it splits a word: then the neighbours are checked
        let split = RawHunk {
            raw_from: 7,
            raw_len: 0,
            new_text: "x".into(),
            guard: vec![(6, 7), (7, 8)],
        };
        assert_eq!(
            check_provenance(std::slice::from_ref(&split), Some(&runs), &actors),
            Err(SuggestReason::ProtectedText)
        );
        let split_ai = RawHunk {
            raw_from: 2,
            raw_len: 0,
            new_text: "x".into(),
            guard: vec![(1, 2), (2, 3)],
        };
        assert_eq!(check_provenance(&[split_ai], Some(&runs), &actors), Ok(()));
        assert_eq!(
            check_provenance(&[split], None, &actors),
            Err(SuggestReason::Unresolvable)
        );
    }

    #[test]
    fn map_hunks_end_to_end() {
        let raw = "Intro {>>c<<} body text.";
        let spans = parse(raw);
        let accepted = super::super::critic_markup::accepted_view(&spans);
        let hunks = minimal_hunks("body text", "body words");
        let input = PolicyInput {
            raw,
            spans: &spans,
            accepted: &accepted,
            match_start: accepted.find("body").unwrap(),
            new_string: "body words",
            hunks: &hunks,
        };
        let mapped = map_hunks(&input).unwrap();
        assert_eq!(mapped.len(), 1);
        assert_eq!(
            &raw[mapped[0].raw_from..mapped[0].raw_from + mapped[0].raw_len],
            "text"
        );
        assert_eq!(mapped[0].new_text, "words");

        // touching the comment → suggest
        let hunks = minimal_hunks("Intro {>>c<<}", "Intro");
        let input = PolicyInput {
            match_start: 0,
            new_string: "Intro",
            hunks: &hunks,
            ..input
        };
        assert_eq!(map_hunks(&input), Err(SuggestReason::OverlapsMarkup));
    }

    #[test]
    fn insertion_splitting_a_word_carries_neighbour_guards() {
        let raw = "the human wrote";
        let spans = parse(raw);
        let accepted = super::super::critic_markup::accepted_view(&spans);
        let mk = |old: &str, new: &str| {
            let hunks = minimal_hunks(old, new);
            let input = PolicyInput {
                raw,
                spans: &spans,
                accepted: &accepted,
                match_start: accepted.find(old).unwrap(),
                new_string: new,
                hunks: &hunks,
            };
            map_hunks(&input).unwrap()
        };
        // "human" -> "humane": inserts "e" between "n" and " " → word boundary, no guard
        assert!(mk("human wrote", "humane wrote")[0].guard.is_empty());
        // "human" -> "humxan": splits the word → both neighbours guarded
        let split = mk("human", "humxan");
        assert_eq!(split[0].guard, vec![(6, 7), (7, 8)]);
        assert_eq!(&raw[6..8], "ma");
        // insertion between words → no guard
        assert!(mk("human wrote", "human never wrote")[0].guard.is_empty());
    }

    #[test]
    fn deleted_whitespace_is_not_guarded() {
        let raw = "AI para.\n\nHuman para.";
        let spans = parse(raw);
        let accepted = super::super::critic_markup::accepted_view(&spans);
        let hunks = minimal_hunks("AI para.\n\nHuman", "Human");
        let input = PolicyInput {
            raw,
            spans: &spans,
            accepted: &accepted,
            match_start: 0,
            new_string: "Human",
            hunks: &hunks,
        };
        let mapped = map_hunks(&input).unwrap();
        assert_eq!(mapped.len(), 1);
        assert_eq!(mapped[0].raw_len, "AI para.\n\n".len());
        // Only "AI" and "para." need AI authorship; the newlines do not.
        assert_eq!(mapped[0].guard, vec![(0, 2), (3, 8)]);
        // Deleting whitespace alone needs no provenance at all.
        let hunks = minimal_hunks("para.\n\nHuman", "para.\nHuman");
        let input = PolicyInput {
            match_start: 3,
            new_string: "para.\nHuman",
            hunks: &hunks,
            ..input
        };
        let mapped = map_hunks(&input).unwrap();
        assert!(mapped[0].guard.is_empty());
        assert_eq!(check_provenance(&mapped, None, &HashMap::new()), Ok(()));
    }

    #[test]
    fn coalesce_spans_first_to_last() {
        let hunks = vec![h(2, 4, 2, 5), h(8, 9, 9, 9)];
        assert_eq!(coalesce(&hunks), Some(h(2, 9, 2, 9)));
        assert_eq!(coalesce(&[]), None);
    }

    /// Apply hunks to `old` the way the edit tool does (back to front) and
    /// return the result.
    fn apply_hunks(old: &str, new: &str, hunks: &[Hunk]) -> String {
        let mut out = old.to_string();
        for h in hunks.iter().rev() {
            out.replace_range(h.old_from..h.old_to, &new[h.new_from..h.new_to]);
        }
        out
    }

    /// Regression for the 2026-09-04 corruption: `similar`'s Myers output
    /// carried an `Insert` whose `old_index` fell inside the preceding
    /// `Delete`, so the hunks interleaved and `4on").` became `4.n").`.
    #[test]
    fn hunks_from_op_sequence_apply_cleanly_when_reported_indices_lie() {
        let cases = [
            ("in Section\u{a0}[[#^evaluation-design|4on\").", "in Section\u{a0}[[#^evaluation-design|4.2]]."),
            ("in Section [[#^evaluation-design|4on\").", "in Section [[#^evaluation-design|4.2]]."),
            ("If you're running an AI lab, you need a concrete plan.", "If you're running an AI lab, you need a  concrete plan."),
            ("abc.def", "ab.xyz.def"),
            ("4on\").", "4.2]]."),
        ];
        for (old, new) in cases {
            let hunks = minimal_hunks(old, new);
            for w in hunks.windows(2) {
                assert!(w[0].old_to <= w[1].old_from, "hunks must not overlap: {:?}", hunks);
                assert!(w[0].new_to <= w[1].new_from, "hunks must not overlap: {:?}", hunks);
            }
            assert_eq!(apply_hunks(old, new, &hunks), new, "old={old:?} hunks={hunks:?}");
            let exact = minimal_hunks_exact(old, new);
            assert_eq!(apply_hunks(old, new, &exact), new, "exact old={old:?} hunks={exact:?}");
        }
    }
}
