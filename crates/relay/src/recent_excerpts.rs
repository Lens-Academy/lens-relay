//! Excerpts for the recent-changes page: windows of the current
//! accepted-view text around clusters of nearby direct AI edits, with the
//! surviving inserted text and the removed text marked in place.
//!
//! Built server-side whenever a doc's activity is (re)indexed — the page must
//! never open content docs itself. Positions come from the same sources the
//! editor overlay uses: surviving inserts via `(client, clock)` provenance
//! runs, removals via the event's relative-position anchor (context search as
//! fallback; unplaceable removals are left out of excerpts but stay in the
//! event list).

use crate::mcp::provenance::{anchor_id, resolve_anchor, Run};
use crate::mcp::tools::critic_markup::{accepted_view, compute_raw_positions, parse, Span};
use std::collections::HashMap;
use y_sweet_core::activity::{ActivityEvent, Excerpt, ExcerptSegment, SEGMENT_TEXT_CAP};
use yrs::block::ID;
use yrs::{Assoc, ReadTxn};

/// Changes closer than this (accepted-view bytes) share an excerpt.
const CLUSTER_GAP: usize = 240;
/// Unchanged context shown on either side of a cluster.
const CONTEXT: usize = 80;

#[derive(Debug, Clone)]
struct Change {
    from: usize,
    to: usize,
    kind: &'static str,
    event_id: String,
    /// Removed text for `delete`; empty for `insert`.
    old: String,
}

/// Map a raw byte offset to the accepted view. Offsets inside suggestion
/// markup map to the start of that suggestion's accepted contribution.
fn raw_to_accepted(raw: &str, spans: &[Span], raw_positions: &[usize], off: usize) -> usize {
    let mut acc = 0usize;
    for (i, span) in spans.iter().enumerate() {
        let raw_start = raw_positions[i];
        let raw_end = raw_positions.get(i + 1).copied().unwrap_or(raw.len());
        let contribution = match span {
            Span::Plain(t) => t.len(),
            Span::Suggestion { inserted, .. } => inserted.len(),
        };
        if off < raw_end {
            return match span {
                Span::Plain(_) => acc + (off - raw_start),
                Span::Suggestion { .. } => acc,
            };
        }
        acc += contribution;
    }
    acc
}

fn floor_char(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_char(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// Widen `[from, to)` to word boundaries (whitespace), by at most
/// `SNAP_LIMIT` bytes on each side (a very long unbroken token is cut).
const SNAP_LIMIT: usize = 24;

fn snap_to_words(s: &str, from: usize, to: usize) -> (usize, usize) {
    let mut f = floor_char(s, from);
    let mut walked = 0;
    while f > 0 && walked < SNAP_LIMIT {
        let prev = s[..f].chars().next_back().unwrap();
        if prev.is_whitespace() {
            break;
        }
        f -= prev.len_utf8();
        walked += prev.len_utf8();
    }
    if walked >= SNAP_LIMIT {
        f = floor_char(s, from);
    }
    let mut t = ceil_char(s, to);
    walked = 0;
    while t < s.len() && walked < SNAP_LIMIT {
        let next = s[t..].chars().next().unwrap();
        if next.is_whitespace() {
            break;
        }
        t += next.len_utf8();
        walked += next.len_utf8();
    }
    if walked >= SNAP_LIMIT {
        t = ceil_char(s, to);
    }
    (f, t)
}

/// Provenance runs grouped by client and sorted by clock, with each run's
/// UTF-16 length precomputed, so clock-range and anchor lookups are
/// O(log R) instead of a scan over every run per event.
struct RunIndex<'a> {
    by_client: HashMap<u64, Vec<(&'a Run, u32)>>,
}

impl<'a> RunIndex<'a> {
    fn new(raw: &str, runs: &'a [Run]) -> Self {
        let mut by_client: HashMap<u64, Vec<(&'a Run, u32)>> = HashMap::new();
        for run in runs {
            let units = raw[run.from..run.to].encode_utf16().count() as u32;
            by_client.entry(run.client).or_default().push((run, units));
        }
        for v in by_client.values_mut() {
            v.sort_by_key(|(r, _)| r.clock);
        }
        Self { by_client }
    }

    /// Runs of `client` overlapping the clock range `[from, to)`.
    fn overlapping(&self, client: u64, from: u32, to: u32) -> &[(&'a Run, u32)] {
        let Some(runs) = self.by_client.get(&client) else {
            return &[];
        };
        let start = runs.partition_point(|(r, units)| r.clock + units <= from);
        let end = start + runs[start..].partition_point(|(r, _)| r.clock < to);
        &runs[start..end]
    }

    /// Byte offset of the character with the given item ID, when it is
    /// still visible.
    fn locate(&self, raw: &str, id: &ID) -> Option<usize> {
        let (run, units) = self.overlapping(id.client, id.clock, id.clock + 1).first()?;
        if id.clock < run.clock || id.clock >= run.clock + units {
            return None;
        }
        Some(run.from + utf16_to_byte(&raw[run.from..run.to], id.clock - run.clock))
    }
}

/// Byte offset of UTF-16 unit `units` within `text` (clamped to its end).
fn utf16_to_byte(text: &str, units: u32) -> usize {
    let mut seen = 0u32;
    for (i, c) in text.char_indices() {
        if seen >= units {
            return i;
        }
        seen += c.len_utf16() as u32;
    }
    text.len()
}

/// Cut segment text at [`SEGMENT_TEXT_CAP`] chars.
fn cap_segment(text: &str) -> (String, bool) {
    match text.char_indices().nth(SEGMENT_TEXT_CAP) {
        Some((i, _)) => (format!("{}…", &text[..i]), true),
        None => (text.to_string(), false),
    }
}

/// Build excerpts for a doc from its current raw text, provenance runs and
/// events. `txn` is only used to resolve removal anchors whose item is no
/// longer among the visible runs.
///
/// Cost: O(R + E·log R) for the change collection plus O(n) over the
/// accepted text; the caller's `visible_runs_copy` (full state encode +
/// apply) dominates for big docs.
pub fn build_excerpts<T: ReadTxn>(
    txn: &T,
    raw: &str,
    runs: Option<&[Run]>,
    events: &[ActivityEvent],
) -> Vec<Excerpt> {
    if events.is_empty() {
        return Vec::new();
    }
    let spans = parse(raw);
    let raw_positions = compute_raw_positions(raw, &spans);
    let accepted = accepted_view(&spans);
    let to_acc = |off: usize| raw_to_accepted(raw, &spans, &raw_positions, off);
    let index = runs.map(|r| RunIndex::new(raw, r));

    let mut changes: Vec<Change> = Vec::new();

    // Surviving inserted text: runs whose items fall inside an event's
    // minted clock range.
    if let Some(index) = &index {
        for ev in events {
            if ev.clock_to <= ev.clock_from {
                continue;
            }
            for (run, units) in index.overlapping(ev.client, ev.clock_from, ev.clock_to) {
                let text = &raw[run.from..run.to];
                let skip = ev.clock_from.saturating_sub(run.clock);
                let take_to = ev.clock_to.min(run.clock + units) - run.clock;
                let byte_from = run.from + utf16_to_byte(text, skip);
                let byte_to = run.from + utf16_to_byte(text, take_to);
                let (from, to) = (to_acc(byte_from), to_acc(byte_to));
                if to > from {
                    changes.push(Change {
                        from,
                        to,
                        kind: "insert",
                        event_id: ev.id.clone(),
                        old: String::new(),
                    });
                }
            }
        }
    }

    // Removed text: anchor (via runs, else item walk) → context → skip.
    for ev in events {
        if ev.old.is_empty() {
            continue;
        }
        let raw_pos = ev.anchor.as_deref().and_then(|a| {
            let by_runs = index.as_ref().and_then(|index| {
                let (id, assoc) = anchor_id(a)?;
                let byte = index.locate(raw, &id)?;
                Some(match assoc {
                    Assoc::After => byte,
                    Assoc::Before => byte + raw[byte..].chars().next().map_or(0, char::len_utf8),
                })
            });
            by_runs
                .or_else(|| resolve_anchor(txn, a))
                .map(|p| p.min(raw.len()))
        });
        let pos = match raw_pos {
            Some(p) => Some(to_acc(floor_char(raw, p))),
            None => unique_context_position(&accepted, ev),
        };
        if let Some(pos) = pos {
            changes.push(Change {
                from: pos,
                to: pos,
                kind: "delete",
                event_id: ev.id.clone(),
                old: ev.old.clone(),
            });
        }
    }

    if changes.is_empty() {
        return Vec::new();
    }
    changes.sort_by(|a, b| a.from.cmp(&b.from).then(a.to.cmp(&b.to)));

    // Cluster nearby changes.
    let mut clusters: Vec<Vec<Change>> = Vec::new();
    let mut cluster_end = 0usize;
    for c in changes {
        if !clusters.is_empty() && c.from <= cluster_end + CLUSTER_GAP {
            cluster_end = cluster_end.max(c.to);
            clusters.last_mut().unwrap().push(c);
        } else {
            cluster_end = c.to;
            clusters.push(vec![c]);
        }
    }

    // Line starts (byte offsets) for O(log n) line numbers.
    let line_starts: Vec<usize> = std::iter::once(0)
        .chain(accepted.match_indices('\n').map(|(i, _)| i + 1))
        .collect();

    let mut excerpts = Vec::with_capacity(clusters.len());
    let mut prev_end = 0usize;
    for cluster in clusters {
        let cfrom = cluster.iter().map(|c| c.from).min().unwrap();
        let cto = cluster.iter().map(|c| c.to).max().unwrap();
        let (start, end) = snap_to_words(
            &accepted,
            cfrom.saturating_sub(CONTEXT).max(prev_end),
            (cto + CONTEXT).min(accepted.len()),
        );
        let start = start.max(prev_end);
        let segments = segments_for(&accepted, start, end, &cluster);
        excerpts.push(Excerpt {
            pos: start,
            line: line_starts.partition_point(|&ls| ls <= start),
            skipped_before: accepted[prev_end..start].chars().count(),
            skipped_after: 0,
            segments,
        });
        prev_end = end;
    }
    if let Some(last) = excerpts.last_mut() {
        last.skipped_after = accepted[prev_end..].chars().count();
    }
    excerpts
}

fn unique_context_position(accepted: &str, ev: &ActivityEvent) -> Option<usize> {
    let unique = |needle: &str| -> Option<usize> {
        if needle.is_empty() {
            return None;
        }
        let first = accepted.find(needle)?;
        if accepted[first + needle.len()..].contains(needle) {
            None
        } else {
            Some(first)
        }
    };
    if let Some(p) = unique(&ev.ctx_before) {
        return Some(p + ev.ctx_before.len());
    }
    unique(&ev.ctx_after)
}

/// Split `accepted[start..end)` into segments at change boundaries.
fn segments_for(
    accepted: &str,
    start: usize,
    end: usize,
    cluster: &[Change],
) -> Vec<ExcerptSegment> {
    let mut out: Vec<ExcerptSegment> = Vec::new();
    let mut cursor = start;
    let push_text = |out: &mut Vec<ExcerptSegment>, from: usize, to: usize| {
        if to > from {
            out.push(ExcerptSegment {
                kind: "text".into(),
                text: accepted[from..to].to_string(),
                event_id: None,
                truncated: false,
            });
        }
    };
    for c in cluster {
        let from = c.from.clamp(start, end);
        let to = c.to.clamp(start, end);
        if from < cursor {
            // Overlapping inserts from different events: keep the first.
            continue;
        }
        let (kind, source) = if c.kind == "delete" {
            ("delete", c.old.as_str())
        } else {
            ("insert", &accepted[from..to])
        };
        // A minimal char diff can leave one edit as several inserts around
        // kept characters ("e" in added→rewritten). Like the editor overlay,
        // bridge gaps of ≤2 chars so the edit reads as one change.
        if kind == "insert" && accepted[cursor..from].chars().count() <= 2 {
            if let Some(last) = out.last_mut() {
                if last.kind == "insert"
                    && last.event_id.as_deref() == Some(c.event_id.as_str())
                    && !last.truncated
                {
                    let (text, truncated) =
                        cap_segment(&format!("{}{}{}", last.text, &accepted[cursor..from], source));
                    last.text = text;
                    last.truncated = truncated;
                    cursor = to;
                    continue;
                }
            }
        }
        push_text(&mut out, cursor, from);
        let (text, truncated) = cap_segment(source);
        out.push(ExcerptSegment {
            kind: kind.into(),
            text,
            event_id: Some(c.event_id.clone()),
            truncated,
        });
        cursor = if c.kind == "delete" { from } else { to };
    }
    push_text(&mut out, cursor, end);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Seeded LCG so the property test is reproducible without a dev-dep.
    fn lcg(seed: &mut u64) -> u64 {
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        *seed >> 33
    }

    #[test]
    fn adjacent_inserts_of_one_event_merge_into_one_segment() {
        let accepted = "ab cd";
        let cluster = vec![
            Change { from: 0, to: 1, kind: "insert", event_id: "e".into(), old: String::new() },
            Change { from: 1, to: 2, kind: "insert", event_id: "e".into(), old: String::new() },
            Change { from: 3, to: 4, kind: "insert", event_id: "e".into(), old: String::new() },
        ];
        let segs = segments_for(accepted, 0, accepted.len(), &cluster);
        let flat: Vec<(&str, &str)> = segs.iter().map(|s| (s.kind.as_str(), s.text.as_str())).collect();
        // The one-char gap " " is bridged, like the editor overlay does.
        assert_eq!(flat, vec![("insert", "ab c"), ("text", "d")]);
    }

    #[test]
    fn delete_followed_by_adjacent_inserts_merges_the_inserts() {
        let accepted = "x, rewritten.";
        let ch = |from, to, kind: &'static str| Change { from, to, kind, event_id: "b".into(), old: "old".into() };
        let cluster = vec![ch(1, 1, "delete"), ch(1, 2, "insert"), ch(2, 5, "insert"), ch(5, 6, "insert")];
        let segs = segments_for(accepted, 0, accepted.len(), &cluster);
        let flat: Vec<(&str, &str)> = segs.iter().map(|s| (s.kind.as_str(), s.text.as_str())).collect();
        assert_eq!(flat, vec![("text", "x"), ("delete", "old"), ("insert", ", rew"), ("text", "ritten.")]);
    }

    #[test]
    fn run_index_matches_brute_force_overlap_and_locate() {
        let mut seed = 42u64;
        for _round in 0..50 {
            // Random ASCII/multibyte text split into runs over a few clients.
            let mut raw = String::new();
            let mut runs: Vec<Run> = Vec::new();
            let mut clocks: HashMap<u64, u32> = HashMap::new();
            for _ in 0..(1 + lcg(&mut seed) % 40) {
                let client = 1 + lcg(&mut seed) % 3;
                let len = 1 + lcg(&mut seed) % 6;
                let from = raw.len();
                for _ in 0..len {
                    raw.push(if lcg(&mut seed) % 4 == 0 { 'é' } else { 'a' });
                }
                let clock = clocks.entry(client).or_insert(0);
                // Occasional gap in the clock (deleted text).
                *clock += (lcg(&mut seed) % 3) as u32;
                runs.push(Run { from, to: raw.len(), client, clock: *clock });
                *clock += raw[from..].encode_utf16().count() as u32;
            }
            let index = RunIndex::new(&raw, &runs);
            for _ in 0..20 {
                let client = 1 + lcg(&mut seed) % 3;
                let a = (lcg(&mut seed) % 40) as u32;
                let b = a + (lcg(&mut seed) % 10) as u32;
                let expected: Vec<usize> = runs
                    .iter()
                    .enumerate()
                    .filter(|(_, r)| {
                        let units = raw[r.from..r.to].encode_utf16().count() as u32;
                        r.client == client && r.clock < b && r.clock + units > a
                    })
                    .map(|(i, _)| i)
                    .collect();
                let got: Vec<usize> = index
                    .overlapping(client, a, b)
                    .iter()
                    .map(|(r, _)| runs.iter().position(|x| std::ptr::eq(x, *r)).unwrap())
                    .collect();
                assert_eq!(got, expected, "overlap {client} [{a},{b}) in {runs:?}");

                // locate: every visible char is found at its own byte offset.
                let id = ID::new(client, a);
                let expected = runs.iter().find_map(|r| {
                    let units = raw[r.from..r.to].encode_utf16().count() as u32;
                    (r.client == client && r.clock <= a && a < r.clock + units)
                        .then(|| r.from + utf16_to_byte(&raw[r.from..r.to], a - r.clock))
                });
                assert_eq!(index.locate(&raw, &id), expected);
            }
        }
    }
    use crate::mcp::provenance::{apply_attributed_edit, sticky_anchor, visible_runs};
    use yrs::{Doc, GetString, Text, Transact, WriteTxn};

    const AI: u64 = 0xa1;

    #[allow(clippy::too_many_arguments)]
    fn event(
        id: &str,
        ts: u64,
        old: &str,
        new: &str,
        client: u64,
        cf: u32,
        ct: u32,
        anchor: Option<Vec<u8>>,
    ) -> ActivityEvent {
        ActivityEvent {
            id: id.into(),
            ts,
            actor: "ai:fable-5:luc".into(),
            author: "Luc's AI".into(),
            mode: "direct".into(),
            kind: ActivityEvent::kind_for(old, new).into(),
            old: old.into(),
            new: new.into(),
            old_truncated: false,
            new_truncated: false,
            ctx_before: String::new(),
            ctx_after: String::new(),
            pos: 0,
            client,
            clock_from: cf,
            clock_to: ct,
            anchor,
        }
    }

    #[test]
    fn insert_and_delete_become_one_excerpt_with_context() {
        let doc = Doc::new();
        {
            let mut txn = doc.transact_mut();
            let t = txn.get_or_insert_text("contents");
            t.insert(
                &mut txn,
                0,
                "Intro line.\n\nThe quick brown fox jumps over the lazy dog.\n",
            );
        }
        // AI: replace "quick" with "swift" (direct), recorded like edit.rs does.
        let (cf, ct, anchor) = apply_attributed_edit(&doc, AI, "ai:fable-5:luc", 1, |txn, text| {
            let cf = txn.state_vector().get(&AI);
            let at = "Intro line.\n\nThe ".len() as u32;
            text.remove_range(txn, at, 5);
            text.insert(txn, at, "swift");
            let ct = txn.state_vector().get(&AI);
            Ok((cf, ct, sticky_anchor(txn, text, at as usize)))
        })
        .unwrap();
        let ev = event("e1", 1, "quick", "swift", AI, cf, ct, anchor);

        let (raw, runs) = {
            let mut txn = doc.transact_mut();
            let t = txn.get_or_insert_text("contents");
            (t.get_string(&txn), visible_runs(&mut txn, &t).unwrap())
        };
        let txn = doc.transact();
        let ex = build_excerpts(&txn, &raw, Some(&runs), &[ev]);
        assert_eq!(ex.len(), 1);
        let kinds: Vec<(&str, &str)> = ex[0]
            .segments
            .iter()
            .map(|s| (s.kind.as_str(), s.text.as_str()))
            .collect();
        assert_eq!(
            kinds,
            vec![
                ("text", "Intro line.\n\nThe "),
                ("delete", "quick"),
                ("insert", "swift"),
                ("text", " brown fox jumps over the lazy dog.\n"),
            ]
        );
        assert_eq!(ex[0].pos, 0);
        assert_eq!(ex[0].line, 1);
        assert_eq!(ex[0].skipped_before, 0);
        assert_eq!(ex[0].skipped_after, 0);
    }

    #[test]
    fn far_apart_changes_get_separate_excerpts_and_skip_counts() {
        let filler = "x".repeat(1000);
        let doc = Doc::new();
        {
            let mut txn = doc.transact_mut();
            let t = txn.get_or_insert_text("contents");
            t.insert(&mut txn, 0, &format!("start {} end", filler));
        }
        let (cf1, ct1) = apply_attributed_edit(&doc, AI, "ai:x", 1, |txn, text| {
            let cf = txn.state_vector().get(&AI);
            text.insert(txn, 5, " A");
            Ok((cf, txn.state_vector().get(&AI)))
        })
        .unwrap();
        let (cf2, ct2) = apply_attributed_edit(&doc, AI, "ai:x", 2, |txn, text| {
            let cf = txn.state_vector().get(&AI);
            let len = text.get_string(txn).len() as u32;
            text.insert(txn, len, " B");
            Ok((cf, txn.state_vector().get(&AI)))
        })
        .unwrap();
        let events = vec![
            event("a", 1, "", " A", AI, cf1, ct1, None),
            event("b", 2, "", " B", AI, cf2, ct2, None),
        ];
        let (raw, runs) = {
            let mut txn = doc.transact_mut();
            let t = txn.get_or_insert_text("contents");
            (t.get_string(&txn), visible_runs(&mut txn, &t).unwrap())
        };
        let txn = doc.transact();
        let ex = build_excerpts(&txn, &raw, Some(&runs), &events);
        assert_eq!(ex.len(), 2);
        assert!(ex[0]
            .segments
            .iter()
            .any(|s| s.kind == "insert" && s.text == " A"));
        assert!(ex[1]
            .segments
            .iter()
            .any(|s| s.kind == "insert" && s.text == " B"));
        assert!(
            ex[1].skipped_before > 700,
            "skipped {}",
            ex[1].skipped_before
        );
        assert_eq!(ex[1].skipped_after, 0);
    }

    #[test]
    fn removal_without_anchor_uses_unique_context_else_is_left_out() {
        let doc = Doc::new();
        {
            let mut txn = doc.transact_mut();
            let t = txn.get_or_insert_text("contents");
            t.insert(&mut txn, 0, "alpha beta gamma");
        }
        let mut ev = event("d", 1, "GONE", "", AI, 0, 0, None);
        ev.ctx_before = "alpha ".into();
        let txn = doc.transact();
        let ex = build_excerpts(&txn, "alpha beta gamma", Some(&[]), &[ev.clone()]);
        assert_eq!(ex.len(), 1);
        assert_eq!(ex[0].segments[1].kind, "delete");
        assert_eq!(ex[0].segments[0].text, "alpha ");

        ev.ctx_before = "nowhere ".into();
        assert!(build_excerpts(&txn, "alpha beta gamma", Some(&[]), &[ev]).is_empty());
    }

    #[test]
    fn raw_offsets_map_through_pending_markup() {
        let raw = "ab {--X--}{++Y++} cd";
        let spans = parse(raw);
        let pos = compute_raw_positions(raw, &spans);
        // accepted: "ab Y cd"
        assert_eq!(raw_to_accepted(raw, &spans, &pos, 0), 0);
        assert_eq!(raw_to_accepted(raw, &spans, &pos, 3), 3); // start of markup → "Y"
        let after = raw.find(" cd").unwrap();
        assert_eq!(raw_to_accepted(raw, &spans, &pos, after), 4);
        assert_eq!(raw_to_accepted(raw, &spans, &pos, raw.len()), 7);
    }
}
