# CriticMarkup Smart Merge Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the MCP edit tool CriticMarkup-aware so AI edits merge cleanly with existing suggestions instead of nesting.

**Architecture:** New `critic_markup.rs` parser module handles parsing, accepted/base view generation, and position mapping. The `edit.rs` tool uses it to map AI edits (targeting the accepted view) back onto the raw document. The `read.rs` tool uses it to show the accepted view with a pending-suggestions footer.

**Tech Stack:** Rust, `similar` crate (word-level diffing), `serde_json` (metadata parsing), `yrs` (Y.Doc manipulation)

**Spec:** `docs/superpowers/specs/2026-03-16-criticmarkup-smart-merge-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `crates/relay/src/mcp/tools/critic_markup.rs` | Create | CriticMarkup parser, span types, accepted/base views, position mapping, smart merge, pending summary rendering |
| `crates/relay/src/mcp/tools/edit.rs` | Modify | Use accepted view for `old_string` matching, call smart merge, targeted Y.Doc mutation |
| `crates/relay/src/mcp/tools/read.rs` | Modify | Return accepted view + pending summary footer |
| `crates/relay/src/mcp/tools/mod.rs` | Modify | Add `pub mod critic_markup;` |
| `crates/relay/src/mcp/tools/test_helpers.rs` | Create | Shared test utilities (`build_test_server`, `setup_session_with_read`, etc.) extracted from `edit.rs` |
| `crates/relay/src/mcp/tools/critic_diff.rs` | No change | Existing word-level diffing stays for non-MCP uses |

---

## Chunk 1: CriticMarkup Parser Module

### Task 1: Span types and `parse()` function

**Files:**
- Create: `crates/relay/src/mcp/tools/critic_markup.rs`
- Modify: `crates/relay/src/mcp/tools/mod.rs` (add `pub mod critic_markup;`)

- [ ] **Step 1: Create module file with Span types and stub parse()**

Create `critic_markup.rs` with:

```rust
use serde_json::Value;

/// A span of document content — either plain text or a CriticMarkup suggestion.
#[derive(Debug, Clone, PartialEq)]
pub enum Span {
    Plain(String),
    Suggestion {
        deleted: String,
        inserted: String,
        author: String,
        timestamp: Option<u64>,
    },
}

/// Parse raw document text into a sequence of spans.
///
/// CriticMarkup delimiters inside fenced code blocks (``` ``` ```) are treated
/// as plain text. Malformed/unclosed delimiters are also treated as plain text.
pub fn parse(raw: &str) -> Vec<Span> {
    todo!()
}
```

Add `pub mod critic_markup;` to `mod.rs` after the existing module declarations.

- [ ] **Step 2: Write failing tests for parser**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    // --- Group A: parse() + accepted_view() + base_view() ---

    #[test]
    fn a01_plain_text_only() {
        let spans = parse("The quick brown fox.");
        assert_eq!(spans, vec![Span::Plain("The quick brown fox.".into())]);
        assert_eq!(accepted_view(&spans), "The quick brown fox.");
        assert_eq!(base_view(&spans), "The quick brown fox.");
    }

    #[test]
    fn a02_simple_substitution() {
        let spans = parse("The {--quick--}{++fast++} brown fox.");
        assert_eq!(spans, vec![
            Span::Plain("The ".into()),
            Span::Suggestion {
                deleted: "quick".into(), inserted: "fast".into(),
                author: "Unknown".into(), timestamp: None,
            },
            Span::Plain(" brown fox.".into()),
        ]);
        assert_eq!(accepted_view(&spans), "The fast brown fox.");
        assert_eq!(base_view(&spans), "The quick brown fox.");
    }

    #[test]
    fn a03_substitution_with_metadata() {
        let raw = r#"The {--{"author":"AI","timestamp":1700000000000}@@quick--}{++{"author":"AI","timestamp":1700000000000}@@fast++} brown fox."#;
        let spans = parse(raw);
        assert_eq!(spans, vec![
            Span::Plain("The ".into()),
            Span::Suggestion {
                deleted: "quick".into(), inserted: "fast".into(),
                author: "AI".into(), timestamp: Some(1700000000000),
            },
            Span::Plain(" brown fox.".into()),
        ]);
        assert_eq!(accepted_view(&spans), "The fast brown fox.");
        assert_eq!(base_view(&spans), "The quick brown fox.");
    }

    #[test]
    fn a04_standalone_deletion() {
        let spans = parse("Hello {--beautiful --}world.");
        assert_eq!(spans, vec![
            Span::Plain("Hello ".into()),
            Span::Suggestion {
                deleted: "beautiful ".into(), inserted: "".into(),
                author: "Unknown".into(), timestamp: None,
            },
            Span::Plain("world.".into()),
        ]);
        assert_eq!(accepted_view(&spans), "Hello world.");
        assert_eq!(base_view(&spans), "Hello beautiful world.");
    }

    #[test]
    fn a05_standalone_insertion() {
        let spans = parse("Hello {++beautiful ++}world.");
        assert_eq!(spans, vec![
            Span::Plain("Hello ".into()),
            Span::Suggestion {
                deleted: "".into(), inserted: "beautiful ".into(),
                author: "Unknown".into(), timestamp: None,
            },
            Span::Plain("world.".into()),
        ]);
        assert_eq!(accepted_view(&spans), "Hello beautiful world.");
        assert_eq!(base_view(&spans), "Hello world.");
    }

    #[test]
    fn a06_multiple_suggestions() {
        let raw = "The {--quick--}{++fast++} brown fox {--jumps--}{++leaps++} over.";
        let spans = parse(raw);
        assert_eq!(accepted_view(&spans), "The fast brown fox leaps over.");
        assert_eq!(base_view(&spans), "The quick brown fox jumps over.");
        assert_eq!(spans.len(), 5); // plain, sug, plain, sug, plain
    }

    #[test]
    fn a07_multiline_suggestion() {
        let raw = "Line one.\n{--Line two.\nLine three.--}{++Replaced lines.++}\nLine four.";
        let spans = parse(raw);
        assert_eq!(accepted_view(&spans), "Line one.\nReplaced lines.\nLine four.");
        assert_eq!(base_view(&spans), "Line one.\nLine two.\nLine three.\nLine four.");
    }

    #[test]
    fn a08_unclosed_deletion_treated_as_plain_text() {
        let raw = "Hello {--world and goodbye.";
        let spans = parse(raw);
        assert_eq!(spans, vec![Span::Plain(raw.into())]);
    }

    #[test]
    fn a09_unclosed_insertion_treated_as_plain_text() {
        let raw = "Hello {++world and goodbye.";
        let spans = parse(raw);
        assert_eq!(spans, vec![Span::Plain(raw.into())]);
    }

    #[test]
    fn a10_fenced_code_block_not_parsed() {
        let raw = "Before.\n```\n{--this is code--}{++not markup++}\n```\nAfter.";
        let spans = parse(raw);
        // Entire thing is one plain span — code block contents not parsed
        assert_eq!(spans, vec![Span::Plain(raw.into())]);
        assert_eq!(accepted_view(&spans), raw);
    }

    #[test]
    fn a11_adjacent_suggestions_different_authors() {
        let raw = r#"{--{"author":"Human","timestamp":1700000000000}@@old1--}{++{"author":"Human","timestamp":1700000000000}@@new1++}{--{"author":"AI","timestamp":1700000060000}@@old2--}{++{"author":"AI","timestamp":1700000060000}@@new2++}"#;
        let spans = parse(raw);
        assert_eq!(accepted_view(&spans), "new1new2");
        assert_eq!(base_view(&spans), "old1old2");
        assert_eq!(spans.len(), 2);
    }

    #[test]
    fn a12_deletion_with_metadata() {
        let raw = r#"Keep {--{"author":"AI","timestamp":1700000000000}@@remove this--} text."#;
        let spans = parse(raw);
        assert_eq!(accepted_view(&spans), "Keep  text.");
        assert_eq!(base_view(&spans), "Keep remove this text.");
    }

    #[test]
    fn a13_empty_document() {
        let spans = parse("");
        assert_eq!(spans, vec![]);
        assert_eq!(accepted_view(&spans), "");
        assert_eq!(base_view(&spans), "");
    }

    #[test]
    fn a14_inline_code_delimiters_still_parsed() {
        // Only fenced code blocks are protected, not inline code
        let raw = "Use `{--old--}` or {--real--}{++actual++} markup.";
        let spans = parse(raw);
        assert_eq!(accepted_view(&spans), "Use `` or actual markup.");
        assert_eq!(base_view(&spans), "Use `old` or real markup.");
    }

    #[test]
    fn a15_delimiter_text_inside_suggestion_content() {
        // Deleted text contains literal {++old syntax++}
        let raw = "Use {--{++old syntax++}--}{++the new syntax++} here.";
        let spans = parse(raw);
        assert_eq!(accepted_view(&spans), "Use the new syntax here.");
        assert_eq!(base_view(&spans), "Use {++old syntax++} here.");
    }

    #[test]
    fn a16_extra_json_fields_in_metadata_ignored() {
        let raw = r#"The {--{"author":"AI","timestamp":1700000000000,"model":"claude-3"}@@quick--}{++{"author":"AI","timestamp":1700000000000,"model":"claude-3"}@@fast++} fox."#;
        let spans = parse(raw);
        assert_eq!(accepted_view(&spans), "The fast fox.");
        // Extra "model" field silently ignored — only author+timestamp extracted
        match &spans[1] {
            Span::Suggestion { author, timestamp, .. } => {
                assert_eq!(author, "AI");
                assert_eq!(*timestamp, Some(1700000000000));
            }
            _ => panic!("Expected suggestion at index 1"),
        }
    }

    #[test]
    fn a17_code_blocks_with_markup_between() {
        let raw = "```\n{--code1--}\n```\n{--real--}{++actual++}\n```\n{++code2++}\n```";
        let spans = parse(raw);
        // Only the markup between the two code blocks is parsed
        assert_eq!(accepted_view(&spans), "```\n{--code1--}\n```\nactual\n```\n{++code2++}\n```");
        assert_eq!(base_view(&spans), "```\n{--code1--}\n```\nreal\n```\n{++code2++}\n```");
    }

    #[test]
    fn a18_entire_document_is_one_suggestion() {
        let raw = "{--old document content--}{++new document content++}";
        let spans = parse(raw);
        assert_eq!(spans.len(), 1);
        assert_eq!(accepted_view(&spans), "new document content");
        assert_eq!(base_view(&spans), "old document content");
    }

    #[test]
    fn a19_at_sign_in_content_not_metadata() {
        // @@ appears in content but is not preceded by valid JSON
        let raw = "The {--user@@example.com--}{++admin@@example.com++} address.";
        let spans = parse(raw);
        assert_eq!(accepted_view(&spans), "The admin@@example.com address.");
        assert_eq!(base_view(&spans), "The user@@example.com address.");
    }
}
```

- [ ] **Step 3: Run tests, verify they fail**

Run: `CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml -p relay critic_markup -- --nocapture`
Expected: All tests fail with `todo!()`

- [ ] **Step 4: Implement `parse()`, `accepted_view()`, `base_view()`**

Parser implementation as a state machine:
1. Scan for `{--` or `{++` delimiters
2. Track fenced code block state (toggle on lines starting with `` ``` ``)
3. Inside code blocks: skip delimiter detection, accumulate as plain text
4. Outside code blocks: on `{--`, scan for `--}`, extract deleted text; then check for adjacent `{++...++}` for inserted text
5. Extract metadata: look for `@@`, attempt JSON parse of text before `@@`. Only split on `@@` if prefix is valid JSON containing `"author"`. Otherwise treat `@@` as literal content (handles email addresses like A19).
6. Malformed (unclosed) delimiters: treat the opening delimiter as plain text

`accepted_view` and `base_view` are trivial — walk spans, emit `inserted` or `deleted` respectively.

- [ ] **Step 5: Run tests, verify they pass**

- [ ] **Step 6: Commit**

```
feat(mcp): add CriticMarkup parser with span types, accepted/base views
```

### Task 2: Position mapping — accepted offset to span indices

**Files:**
- Modify: `crates/relay/src/mcp/tools/critic_markup.rs`

- [ ] **Step 1: Write failing tests for position mapping**

```rust
    // --- Group D: spans_covering_accepted_range() ---

    #[test]
    fn d01_plain_text_identity() {
        let spans = parse("Hello world.");
        let covered = spans_covering_accepted_range(&spans, 6, 5);
        assert_eq!(covered.len(), 1);
        assert_eq!(covered[0].span_index, 0);
    }

    #[test]
    fn d02_offset_in_suggestion_inserted() {
        let spans = parse("Say {--hello--}{++goodbye++} today.");
        // Accepted: "Say goodbye today." — offset 4 len 7 = "goodbye"
        let covered = spans_covering_accepted_range(&spans, 4, 7);
        assert_eq!(covered.len(), 1);
        assert_eq!(covered[0].span_index, 1);
    }

    #[test]
    fn d03_offset_spanning_plain_and_suggestion() {
        let spans = parse("The {--quick--}{++fast++} brown.");
        // Accepted: "The fast brown." — offset 2 len 6 = "e fast"
        let covered = spans_covering_accepted_range(&spans, 2, 6);
        assert_eq!(covered.len(), 3);
        assert_eq!(covered[0].span_index, 0);
        assert_eq!(covered[1].span_index, 1);
        assert_eq!(covered[2].span_index, 2);
    }

    #[test]
    fn d04_offset_in_plain_between_suggestions() {
        let spans = parse("{--a--}{++x++} middle {--b--}{++y++}");
        // Accepted: "x middle y" — offset 2 len 6 = "middle"
        let covered = spans_covering_accepted_range(&spans, 2, 6);
        assert_eq!(covered.len(), 1);
        assert_eq!(covered[0].span_index, 1); // the plain " middle " span
    }

    #[test]
    fn d05_zero_length_range() {
        let spans = parse("Hello {--world--}{++earth++} today.");
        let covered = spans_covering_accepted_range(&spans, 11, 0);
        assert_eq!(covered.len(), 0);
    }

    #[test]
    fn d06_range_covering_entire_document() {
        let spans = parse("The {--quick--}{++fast++} brown {--fox--}{++cat++}.");
        // Accepted: "The fast brown cat." = 19 chars
        let covered = spans_covering_accepted_range(&spans, 0, 19);
        assert_eq!(covered.len(), 5);
    }

    #[test]
    fn d07_standalone_deletion_contributes_zero_chars() {
        let spans = parse("Hello {--beautiful --}world.");
        // Accepted: "Hello world." — offset 6 len 5 = "world"
        // Deletion span contributes 0 chars, is skipped
        let covered = spans_covering_accepted_range(&spans, 6, 5);
        assert_eq!(covered.len(), 1);
        assert_eq!(covered[0].span_index, 2); // the "world." plain span
    }

    #[test]
    fn d08_exact_span_boundary() {
        let spans = parse("ABC{--DEF--}{++GHI++}JKL");
        // Accepted: "ABCGHIJKL" — offset 3 len 3 = "GHI"
        let covered = spans_covering_accepted_range(&spans, 3, 3);
        assert_eq!(covered.len(), 1);
        assert_eq!(covered[0].span_index, 1);
    }
```

- [ ] **Step 2: Run tests, verify they fail**

- [ ] **Step 3: Implement `spans_covering_accepted_range()`**

```rust
#[derive(Debug, Clone, PartialEq)]
pub struct CoveredSpan {
    pub span_index: usize,
    pub start_within: usize,
    pub len_within: usize,
}

pub fn spans_covering_accepted_range(
    spans: &[Span],
    accepted_offset: usize,
    accepted_len: usize,
) -> Vec<CoveredSpan> {
    // Walk spans, accumulate accepted-view byte offset.
    // Plain(text) contributes text.len(), Suggestion contributes inserted.len().
    // Find spans where cumulative range overlaps [accepted_offset, accepted_offset+accepted_len).
    todo!()
}
```

- [ ] **Step 4: Run tests, verify they pass**

- [ ] **Step 5: Commit**

```
feat(mcp): add span-index position mapping for accepted-view ranges
```

---

## Chunk 2: Smart Merge Algorithm

### Task 3: Test helper — `strip_metadata()`

**Files:**
- Modify: `crates/relay/src/mcp/tools/critic_markup.rs` (test module only)

- [ ] **Step 1: Implement in test module**

```rust
#[cfg(test)]
fn strip_metadata(raw: &str) -> String {
    use regex::Regex;
    let re = Regex::new(r#"\{"author":"[^"]*","timestamp":\d+(?:,[^}]*)?\}@@"#).unwrap();
    re.replace_all(raw, "").to_string()
}

/// Apply a MergeResult to raw content (test helper).
#[cfg(test)]
fn apply_merge(raw: &str, edit: &MergeResult) -> String {
    let mut result = String::from(raw);
    result.replace_range(edit.raw_offset..edit.raw_offset + edit.raw_len, &edit.replacement);
    result
}
```

Committed with Task 4.

### Task 4: Smart merge core — `merge_edit()`

**Files:**
- Modify: `crates/relay/src/mcp/tools/critic_markup.rs`

Returns a **targeted replacement** — byte range in raw document + replacement string. This avoids replacing the entire Y.Doc content, preserving CRDT operation log efficiency and collaborative cursors.

- [ ] **Step 1: Write failing tests for smart merge**

```rust
    // --- Group B: merge_edit() ---

    // -- Acceptance tests (verify accepted/base views after merge) --

    #[test]
    fn b01_plain_text_no_suggestions() {
        let raw = "The quick brown fox jumps over the lazy dog.";
        let edit = merge_edit(raw, "quick brown", "slow red", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let spans = parse(&result);
        assert_eq!(accepted_view(&spans), "The slow red fox jumps over the lazy dog.");
    }

    #[test]
    fn b02_edit_not_touching_suggestions() {
        let raw = "The {--quick--}{++fast++} brown fox jumps over the lazy dog.";
        let edit = merge_edit(raw, "lazy dog", "happy cat", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let spans = parse(&result);
        assert_eq!(accepted_view(&spans), "The fast brown fox jumps over the happy cat.");
        assert_eq!(base_view(&spans), "The quick brown fox jumps over the lazy dog.");
    }

    #[test]
    fn b03_supersede_entire_suggestion() {
        let raw = "The {--quick--}{++fast++} brown fox.";
        let edit = merge_edit(raw, "fast", "speedy", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let spans = parse(&result);
        assert_eq!(accepted_view(&spans), "The speedy brown fox.");
        assert_eq!(base_view(&spans), "The quick brown fox.");
    }

    #[test]
    fn b04_supersede_and_extend_right() {
        let raw = "The {--quick--}{++fast++} brown fox.";
        let edit = merge_edit(raw, "fast brown", "speedy red", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let spans = parse(&result);
        assert_eq!(accepted_view(&spans), "The speedy red fox.");
        assert_eq!(base_view(&spans), "The quick brown fox.");
    }

    #[test]
    fn b05_supersede_and_extend_left() {
        let raw = "The {--quick--}{++fast++} brown fox.";
        let edit = merge_edit(raw, "The fast", "A speedy", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let spans = parse(&result);
        assert_eq!(accepted_view(&spans), "A speedy brown fox.");
        assert_eq!(base_view(&spans), "The quick brown fox.");
    }

    #[test]
    fn b06_supersede_and_extend_both() {
        let raw = "Hello {--world--}{++earth++} today.";
        let edit = merge_edit(raw, "Hello earth today", "Greetings mars now", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let spans = parse(&result);
        assert_eq!(accepted_view(&spans), "Greetings mars now.");
        assert_eq!(base_view(&spans), "Hello world today.");
    }

    #[test]
    fn b07_span_multiple_suggestions() {
        let raw = "The {--quick--}{++fast++} brown {--fox--}{++cat++} jumps.";
        let edit = merge_edit(raw, "fast brown cat", "speedy red dog", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let spans = parse(&result);
        assert_eq!(accepted_view(&spans), "The speedy red dog jumps.");
        assert_eq!(base_view(&spans), "The quick brown fox jumps.");
    }

    #[test]
    fn b08_two_suggestions_only_one_touched() {
        let raw = "The {--quick--}{++fast++} brown fox {--jumps--}{++leaps++} over.";
        let edit = merge_edit(raw, "fast", "speedy", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let spans = parse(&result);
        assert_eq!(accepted_view(&spans), "The speedy brown fox leaps over.");
        assert_eq!(base_view(&spans), "The quick brown fox jumps over.");
    }

    #[test]
    fn b09_sequential_supersede() {
        let raw = r#"Say {--{"author":"AI","timestamp":1700000000000}@@hello--}{++{"author":"AI","timestamp":1700000000000}@@world++} today."#;
        let edit = merge_edit(raw, "world", "earth", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let spans = parse(&result);
        assert_eq!(accepted_view(&spans), "Say earth today.");
        assert_eq!(base_view(&spans), "Say hello today.");
    }

    #[test]
    fn b10_ai_supersedes_human_suggestion() {
        let raw = r#"The {--{"author":"Human","timestamp":1700000000000}@@quick--}{++{"author":"Human","timestamp":1700000000000}@@fast++} brown fox."#;
        let edit = merge_edit(raw, "fast", "speedy", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let spans = parse(&result);
        assert_eq!(accepted_view(&spans), "The speedy brown fox.");
        assert_eq!(base_view(&spans), "The quick brown fox.");
    }

    #[test]
    fn b11_whole_doc_replace_few_changes() {
        let raw = "Alpha {--beta--}{++gamma++} delta epsilon {--zeta--}{++eta++} theta.";
        let edit = merge_edit(raw, "Alpha gamma delta epsilon eta theta.", "Alpha gamma CHANGED epsilon eta MODIFIED.", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let spans = parse(&result);
        assert_eq!(accepted_view(&spans), "Alpha gamma CHANGED epsilon eta MODIFIED.");
        // Existing suggestions in equal diff regions are preserved; new edits on plain text have that plain text as base
        assert_eq!(base_view(&spans), "Alpha beta delta epsilon zeta theta.");
    }

    #[test]
    fn b12_whole_doc_replace_everything() {
        let raw = "The {--quick--}{++fast++} brown fox.";
        let edit = merge_edit(raw, "The fast brown fox.", "Completely different content here.", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let spans = parse(&result);
        assert_eq!(accepted_view(&spans), "Completely different content here.");
        assert_eq!(base_view(&spans), "The quick brown fox.");
    }

    #[test]
    fn b13_standalone_deletion_not_overlapped() {
        let raw = "Hello {--beautiful --}world today.";
        let edit = merge_edit(raw, "world today", "earth now", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let spans = parse(&result);
        assert_eq!(accepted_view(&spans), "Hello earth now.");
        // Standalone deletion preserved
        assert!(result.contains("{--beautiful --}"));
    }

    #[test]
    fn b14_overlaps_standalone_insertion() {
        let raw = "Hello {++beautiful ++}world today.";
        let edit = merge_edit(raw, "beautiful world", "wonderful planet", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let spans = parse(&result);
        assert_eq!(accepted_view(&spans), "Hello wonderful planet today.");
        assert_eq!(base_view(&spans), "Hello world today.");
    }

    #[test]
    fn b15_edit_within_multiword_suggestion() {
        let raw = "Say {--hello world--}{++goodbye earth++} now.";
        let edit = merge_edit(raw, "goodbye", "farewell", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let spans = parse(&result);
        assert_eq!(accepted_view(&spans), "Say farewell earth now.");
        assert_eq!(base_view(&spans), "Say hello world now.");
    }

    #[test]
    fn b16_pure_deletion() {
        let raw = "Keep {--old--}{++current++} remove this end.";
        let edit = merge_edit(raw, "remove this", "", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let spans = parse(&result);
        assert_eq!(accepted_view(&spans), "Keep current  end.");
        assert_eq!(base_view(&spans), "Keep old  end.");
    }

    #[test]
    fn b17_pure_insertion() {
        let raw = "Hello world.";
        let edit = merge_edit(raw, "Hello world", "Hello beautiful world", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let spans = parse(&result);
        assert_eq!(accepted_view(&spans), "Hello beautiful world.");
    }

    #[test]
    fn b18_edit_at_document_start() {
        let raw = "{--Old--}{++New++} start of document.";
        let edit = merge_edit(raw, "New start", "Fresh beginning", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let spans = parse(&result);
        assert_eq!(accepted_view(&spans), "Fresh beginning of document.");
        assert_eq!(base_view(&spans), "Old start of document.");
    }

    #[test]
    fn b19_edit_at_document_end() {
        let raw = "Start of document {--ending--}{++conclusion++}.";
        let edit = merge_edit(raw, "conclusion.", "finale!", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let spans = parse(&result);
        assert_eq!(accepted_view(&spans), "Start of document finale!");
        assert_eq!(base_view(&spans), "Start of document ending.");
    }

    #[test]
    fn b20_three_adjacent_suggestions() {
        let raw = "{--a--}{++x++}{--b--}{++y++}{--c--}{++z++}";
        let edit = merge_edit(raw, "xyz", "123", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let spans = parse(&result);
        assert_eq!(accepted_view(&spans), "123");
        assert_eq!(base_view(&spans), "abc");
    }

    #[test]
    fn b21_insert_newline_paragraph_break() {
        let raw = "First sentence. Second sentence.";
        let edit = merge_edit(raw, "First sentence. Second sentence.", "First sentence.\n\nSecond sentence.", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let spans = parse(&result);
        assert_eq!(accepted_view(&spans), "First sentence.\n\nSecond sentence.");
    }

    #[test]
    fn b22_remove_newline_join_paragraphs() {
        let raw = "First paragraph.\n\nSecond paragraph.";
        let edit = merge_edit(raw, "First paragraph.\n\nSecond paragraph.", "First paragraph. Second paragraph.", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let spans = parse(&result);
        assert_eq!(accepted_view(&spans), "First paragraph. Second paragraph.");
    }

    #[test]
    fn b23_noop_edit_preserves_existing_suggestions() {
        let raw = "The {--quick--}{++fast++} brown fox.";
        let edit = merge_edit(raw, "fast brown fox.", "fast brown fox.", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        // No-op: document should be unchanged
        assert_eq!(result, raw);
    }

    #[test]
    fn b24_edit_adjacent_before_suggestion() {
        let raw = "Hello {--world--}{++earth++} today.";
        let edit = merge_edit(raw, "Hello", "Greetings", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let spans = parse(&result);
        assert_eq!(accepted_view(&spans), "Greetings earth today.");
        // Original suggestion preserved (not overlapped); "Hello" is plain text so base is "Hello"
        assert_eq!(base_view(&spans), "Hello world today.");
    }

    #[test]
    fn b25_edit_adjacent_after_suggestion() {
        let raw = "Hello {--world--}{++earth++} today.";
        let edit = merge_edit(raw, "today", "now", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let spans = parse(&result);
        assert_eq!(accepted_view(&spans), "Hello earth now.");
        assert_eq!(base_view(&spans), "Hello world today.");
    }

    #[test]
    fn b26_diff_regions_overlap_different_suggestions() {
        let raw = "Alpha {--beta--}{++gamma++} delta epsilon {--zeta--}{++eta++} theta.";
        let edit = merge_edit(raw, "Alpha gamma delta epsilon eta theta.", "Alpha GAMMA delta epsilon ETA theta.", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let spans = parse(&result);
        assert_eq!(accepted_view(&spans), "Alpha GAMMA delta epsilon ETA theta.");
        assert_eq!(base_view(&spans), "Alpha beta delta epsilon zeta theta.");
    }

    #[test]
    fn b27_ai_writes_criticmarkup_as_literal_content() {
        let raw = "CriticMarkup uses special syntax.";
        let edit = merge_edit(raw, "CriticMarkup uses special syntax.", "CriticMarkup uses {--deleted--} and {++inserted++} syntax.", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let spans = parse(&result);
        // The accepted view should contain the literal delimiters as content
        assert_eq!(accepted_view(&spans), "CriticMarkup uses {--deleted--} and {++inserted++} syntax.");
    }

    #[test]
    fn b28_document_entirely_suggestions() {
        let raw = "{--old beginning--}{++new beginning++}{--old middle--}{++new middle++}{--old end--}{++new end++}";
        let edit = merge_edit(raw, "new beginning", "fresh start", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let spans = parse(&result);
        assert_eq!(accepted_view(&spans), "fresh startnew middlenew end");
        assert_eq!(base_view(&spans), "old beginningold middleold end");
    }

    #[test]
    fn b29_three_separate_change_regions() {
        let raw = "The quick brown fox jumps over the lazy dog near the old barn.";
        let edit = merge_edit(raw, "The quick brown fox jumps over the lazy dog near the old barn.", "The slow brown fox jumps over the happy dog near the new barn.", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let spans = parse(&result);
        assert_eq!(accepted_view(&spans), "The slow brown fox jumps over the happy dog near the new barn.");
        // Three independent suggestions, not one giant one
        let suggestion_count = spans.iter().filter(|s| matches!(s, Span::Suggestion { .. })).count();
        assert!(suggestion_count >= 3, "Expected at least 3 suggestions, got {}", suggestion_count);
    }

    #[test]
    fn b30_old_string_spans_suggestion_and_plain_text_duplicate() {
        let raw = "Say {--goodbye--}{++hello++} and then say hello again.";
        let edit = merge_edit(raw, "hello and then say hello", "greetings and then say farewell", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let spans = parse(&result);
        assert_eq!(accepted_view(&spans), "Say greetings and then say farewell again.");
        assert_eq!(base_view(&spans), "Say goodbye and then say hello again.");
    }

    #[test]
    fn b31_edit_starts_at_exact_suggestion_boundary() {
        let raw = "Say {--hello--}{++goodbye++} friend.";
        let edit = merge_edit(raw, "goodbye friend", "farewell buddy", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let spans = parse(&result);
        assert_eq!(accepted_view(&spans), "Say farewell buddy.");
        assert_eq!(base_view(&spans), "Say hello friend.");
    }

    #[test]
    fn b32_edit_ends_at_exact_suggestion_boundary() {
        let raw = "Say {--hello--}{++goodbye++} friend.";
        let edit = merge_edit(raw, "Say goodbye", "Tell farewell", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let spans = parse(&result);
        assert_eq!(accepted_view(&spans), "Tell farewell friend.");
        assert_eq!(base_view(&spans), "Tell hello friend.");
    }

    // -- Exact markup tests (verify specific CriticMarkup structure) --

    #[test]
    fn b03_exact_markup() {
        let raw = "The {--quick--}{++fast++} brown fox.";
        let edit = merge_edit(raw, "fast", "speedy", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let clean = strip_metadata(&result);
        assert_eq!(clean, "The {--quick--}{++speedy++} brown fox.");
    }

    #[test]
    fn b04_exact_markup() {
        let raw = "The {--quick--}{++fast++} brown fox.";
        let edit = merge_edit(raw, "fast brown", "speedy red", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let clean = strip_metadata(&result);
        assert_eq!(clean, "The {--quick brown--}{++speedy red++} fox.");
    }

    #[test]
    fn b07_exact_markup() {
        let raw = "The {--quick--}{++fast++} brown {--fox--}{++cat++} jumps.";
        let edit = merge_edit(raw, "fast brown cat", "speedy red dog", "AI", 1700000000000).unwrap();
        let result = apply_merge(raw, &edit);
        let clean = strip_metadata(&result);
        assert_eq!(clean, "The {--quick brown fox--}{++speedy red dog++} jumps.");
    }
```

- [ ] **Step 2: Run tests, verify they fail**

- [ ] **Step 3: Implement `merge_edit()`**

```rust
use similar::{ChangeTag, TextDiff};

#[derive(Debug, Clone, PartialEq)]
pub struct MergeResult {
    /// Byte offset in the raw document where the replacement starts
    pub raw_offset: usize,
    /// Number of bytes in the raw document to remove
    pub raw_len: usize,
    /// Replacement string (contains CriticMarkup)
    pub replacement: String,
}

pub fn merge_edit(
    raw: &str,
    old_string: &str,
    new_string: &str,
    author: &str,
    timestamp: u64,
) -> Result<MergeResult, String> {
    let spans = parse(raw);
    let accepted = accepted_view(&spans);

    // Find old_string in accepted view
    let matches: Vec<usize> = accepted.match_indices(old_string).map(|(i, _)| i).collect();
    if matches.is_empty() {
        return Err("old_string not found in accepted view".into());
    }
    if matches.len() > 1 {
        return Err(format!("old_string not unique ({} occurrences)", matches.len()));
    }
    let match_offset = matches[0];

    // No-op
    if old_string == new_string {
        return Ok(MergeResult { raw_offset: 0, raw_len: 0, replacement: String::new() });
    }

    // Find covered spans and compute raw byte range
    let covered = spans_covering_accepted_range(&spans, match_offset, old_string.len());
    // ... compute raw_offset and raw_len from covered spans ...

    // Word-level diff
    let diff = TextDiff::from_words(old_string, new_string);
    let meta = format!(r#"{{"author":"{}","timestamp":{}}}@@"#, author, timestamp);

    // Walk diff, per change region:
    //   - Map to covered spans
    //   - Collect base text: Plain→itself, Suggestion→deleted side
    //   - Emit CriticMarkup
    // For equal regions: emit raw spans as-is
    // Return targeted (raw_offset, raw_len, replacement)

    todo!()
}
```

- [ ] **Step 4: Run tests, verify they pass**

- [ ] **Step 5: Commit**

```
feat(mcp): implement smart merge algorithm for CriticMarkup-aware edits
```

---

## Chunk 3: Read Tool Integration

### Task 5: Pending summary renderer

**Files:**
- Modify: `crates/relay/src/mcp/tools/critic_markup.rs`

- [ ] **Step 1: Write failing tests for pending summary**

```rust
    // --- Group C: render_pending_summary() ---

    #[test]
    fn c01_no_suggestions_no_footer() {
        let raw = "Line one.\nLine two.\nLine three.";
        let spans = parse(raw);
        let accepted = accepted_view(&spans);
        assert!(render_pending_summary(&spans, &accepted).is_none());
    }

    #[test]
    fn c02_single_suggestion_footer() {
        let raw = "The {--quick--}{++fast++} brown fox.\nLine two.\nLine three.";
        let spans = parse(raw);
        let accepted = accepted_view(&spans);
        let footer = render_pending_summary(&spans, &accepted).unwrap();
        assert!(footer.contains("[Pending suggestions]"));
        assert!(footer.contains("{--quick--}{++fast++}"));
    }

    #[test]
    fn c03_multiple_lines_affected() {
        let raw = "The {--quick--}{++fast++} brown fox.\nA normal line.\n{++New ++}content here.";
        let spans = parse(raw);
        let accepted = accepted_view(&spans);
        let footer = render_pending_summary(&spans, &accepted).unwrap();
        assert!(footer.contains("{--quick--}{++fast++}"));
        assert!(footer.contains("{++New ++}"));
        // Line 2 should NOT appear
        assert!(!footer.contains("normal line"));
    }

    #[test]
    fn c04_truncation_long_deletion() {
        let raw = "{--one two three four five six seven eight nine ten eleven twelve--}{++replacement++} end.";
        let spans = parse(raw);
        let accepted = accepted_view(&spans);
        let footer = render_pending_summary(&spans, &accepted).unwrap();
        assert!(footer.contains("one two three ... ten eleven twelve"));
    }

    #[test]
    fn c05_truncation_long_insertion() {
        let raw = "{--old--}{++one two three four five six seven eight nine ten eleven twelve++} end.";
        let spans = parse(raw);
        let accepted = accepted_view(&spans);
        let footer = render_pending_summary(&spans, &accepted).unwrap();
        assert!(footer.contains("one two three ... ten eleven twelve"));
    }

    #[test]
    fn c06_short_sides_not_truncated() {
        let raw = "{--one two three four five--}{++six seven eight nine ten++} end.";
        let spans = parse(raw);
        let accepted = accepted_view(&spans);
        let footer = render_pending_summary(&spans, &accepted).unwrap();
        assert!(footer.contains("{--one two three four five--}{++six seven eight nine ten++}"));
    }

    #[test]
    fn c07_metadata_stripped_in_footer() {
        let raw = r#"The {--{"author":"AI","timestamp":1700000000000}@@quick--}{++{"author":"AI","timestamp":1700000000000}@@fast++} fox."#;
        let spans = parse(raw);
        let accepted = accepted_view(&spans);
        let footer = render_pending_summary(&spans, &accepted).unwrap();
        assert!(footer.contains("{--quick--}{++fast++}"));
        assert!(footer.contains("AI"));
        assert!(!footer.contains("@@"));
        assert!(!footer.contains("\"timestamp\""));
    }

    #[test]
    fn c09_multiline_suggestion_attributed_to_start_line() {
        let raw = "Line one {--old text--}{++new line one\nnew line two++} end.\nLine three.";
        let spans = parse(raw);
        let accepted = accepted_view(&spans);
        let footer = render_pending_summary(&spans, &accepted).unwrap();
        assert!(footer.contains("[Pending suggestions]"));
        // Should be attributed to line 1 (where the suggestion starts)
        assert!(footer.contains("1"));
    }

    #[test]
    fn c11_multiple_suggestions_same_line() {
        let raw = "The {--quick--}{++fast++} brown {--fox--}{++cat++} jumps.";
        let spans = parse(raw);
        let accepted = accepted_view(&spans);
        let footer = render_pending_summary(&spans, &accepted).unwrap();
        assert!(footer.contains("{--quick--}{++fast++}"));
        assert!(footer.contains("{--fox--}{++cat++}"));
    }

    #[test]
    fn c12_unknown_author_no_timestamp() {
        let raw = "The {--quick--}{++fast++} fox.";
        let spans = parse(raw);
        let accepted = accepted_view(&spans);
        let footer = render_pending_summary(&spans, &accepted).unwrap();
        assert!(footer.contains("Unknown"));
        assert!(!footer.contains("ago"));
    }
```

- [ ] **Step 2: Run tests, verify they fail**

- [ ] **Step 3: Implement `render_pending_summary()`**

```rust
pub fn render_pending_summary(spans: &[Span], accepted_content: &str) -> Option<String> {
    // 1. Check if any Suggestion spans exist — if not, return None
    // 2. Walk spans tracking accepted-view line position
    // 3. For each suggestion, determine its starting line in the accepted view
    // 4. Render footer with truncated CriticMarkup, author, relative timestamp
    todo!()
}

fn truncate_side(text: &str) -> String {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.len() <= 10 { return text.to_string(); }
    format!("{} ... {}", words[..3].join(" "), words[words.len()-3..].join(" "))
}

fn format_relative_time(timestamp_ms: u64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap()
        .as_millis() as u64;
    let diff_secs = now.saturating_sub(timestamp_ms) / 1000;
    if diff_secs < 60 { format!("{}s ago", diff_secs) }
    else if diff_secs < 3600 { format!("{}m ago", diff_secs / 60) }
    else if diff_secs < 86400 { format!("{}h ago", diff_secs / 3600) }
    else if diff_secs < 604800 { format!("{}d ago", diff_secs / 86400) }
    else { format!("{}w ago", diff_secs / 604800) }
}
```

- [ ] **Step 4: Run tests, verify they pass**

- [ ] **Step 5: Commit**

```
feat(mcp): add pending suggestions summary renderer
```

### Task 6: Extract shared test helpers

**Files:**
- Create: `crates/relay/src/mcp/tools/test_helpers.rs`
- Modify: `crates/relay/src/mcp/tools/mod.rs`
- Modify: `crates/relay/src/mcp/tools/edit.rs` (test module)

- [ ] **Step 1: Create `test_helpers.rs` with helpers extracted from `edit.rs`**

Move: `RELAY_ID`, `FOLDER0_UUID`, `folder0_id()`, `set_folder_name()`, `create_folder_doc()`, `build_test_server()`, `setup_session_with_read()`, `setup_session_no_reads()`, `read_doc_content()`.

- [ ] **Step 2: Add `#[cfg(test)] pub(crate) mod test_helpers;` to `mod.rs`**

- [ ] **Step 3: Update `edit.rs` tests to use `use super::test_helpers::*;`**

- [ ] **Step 4: Run existing tests to verify no breakage**

- [ ] **Step 5: Commit**

```
refactor(mcp): extract shared test helpers for MCP tool tests
```

### Task 7: Integrate accepted view into `read.rs`

**Files:**
- Modify: `crates/relay/src/mcp/tools/read.rs`

- [ ] **Step 1: Write failing test**

```rust
#[cfg(test)]
mod accepted_view_tests {
    use super::*;
    use crate::mcp::tools::test_helpers::*;
    use serde_json::json;

    #[tokio::test]
    async fn read_returns_accepted_view_with_footer() {
        let server = build_test_server(&[(
            "/Doc.md", "uuid-doc",
            "The {--quick--}{++fast++} brown fox.",
        )]).await;
        let sid = setup_session_with_read(&server, &format!("{}-uuid-doc", RELAY_ID));
        let result = execute(&server, &sid, &json!({
            "file_path": "Lens/Doc.md", "session_id": sid,
        })).await.unwrap();

        // Accepted view shown
        assert!(result.contains("The fast brown fox."));
        assert!(!result.contains("{--quick--}"), "Raw CriticMarkup should not be in primary content");

        // Footer present
        assert!(result.contains("[Pending suggestions]"));
        assert!(result.contains("{--quick--}{++fast++}"));
    }
}
```

- [ ] **Step 2: Run test, verify it fails**

- [ ] **Step 3: Modify `read.rs`**

After reading raw content from Y.Doc, parse and return accepted view + footer:

```rust
let spans = super::critic_markup::parse(&content);
let accepted = super::critic_markup::accepted_view(&spans);
let footer = super::critic_markup::render_pending_summary(&spans, &accepted);

let mut output = format_cat_n(&accepted, offset, limit);
if let Some(footer_text) = footer {
    output.push_str("\n\n");
    output.push_str(&footer_text);
}
Ok(output)
```

- [ ] **Step 4: Run tests, verify they pass**

- [ ] **Step 5: Commit**

```
feat(mcp): read tool returns accepted view with pending suggestions footer
```

---

## Chunk 4: Edit Tool Integration

### Task 8: Integrate smart merge into `edit.rs`

**Files:**
- Modify: `crates/relay/src/mcp/tools/edit.rs`

- [ ] **Step 1: Write failing test**

```rust
#[tokio::test]
async fn edit_supersedes_existing_suggestion() {
    let server = build_test_server(&[(
        "/Doc.md", "uuid-doc",
        "The {--quick--}{++fast++} brown fox.",
    )]).await;
    let doc_id = format!("{}-uuid-doc", RELAY_ID);
    let sid = setup_session_with_read(&server, &doc_id);

    let result = execute(&server, &sid, &json!({
        "file_path": "Lens/Doc.md",
        "old_string": "fast",
        "new_string": "speedy",
        "session_id": sid,
    })).await;

    assert!(result.is_ok());
    let raw = read_doc_content(&server, &doc_id);
    let spans = super::critic_markup::parse(&raw);
    assert_eq!(super::critic_markup::accepted_view(&spans), "The speedy brown fox.");
    assert_eq!(super::critic_markup::base_view(&spans), "The quick brown fox.");
}
```

- [ ] **Step 2: Run test, verify it fails**

- [ ] **Step 3: Modify `edit.rs` to use smart merge with targeted Y.Doc mutation**

Replace the current flow:

1. Read raw content from Y.Doc
2. Parse → accepted view
3. Find `old_string` in accepted view (uniqueness check)
4. Call `critic_markup::merge_edit(raw, old_string, new_string, "AI", timestamp)`
5. Under write lock: TOCTOU re-verify against accepted view, recompute merge, apply with targeted `remove_range` + `insert`

```rust
// Targeted replacement — not full doc replacement
let final_merge = super::critic_markup::merge_edit(
    &current_raw, old_string, new_string, "AI", timestamp,
).map_err(|e| format!("Error: {}", e))?;

text.remove_range(&mut txn, final_merge.raw_offset as u32, final_merge.raw_len as u32);
text.insert(&mut txn, final_merge.raw_offset as u32, &final_merge.replacement);
```

- [ ] **Step 4: Run all tests — existing + new**

Existing edit tests on plain-text documents should still pass (merge algorithm falls through to normal CriticMarkup wrapping). Review tests that assert specific CriticMarkup structure (e.g., `edit_preserves_surrounding_content` at `edit.rs:434`) and update if the new merge changes the output format.

- [ ] **Step 5: Commit**

```
feat(mcp): edit tool uses smart merge for CriticMarkup-aware edits
```

---

## Chunk 5: Integration Tests

### Task 9: Multi-step interaction tests (Group E)

**Files:**
- Modify: `crates/relay/src/mcp/tools/edit.rs` (test module)

- [ ] **Step 1: Write Group E integration tests**

```rust
#[tokio::test]
async fn e01_two_edits_different_regions_coexist() {
    let server = build_test_server(&[(
        "/Doc.md", "uuid-doc",
        "The quick brown fox jumps over the lazy dog.",
    )]).await;
    let doc_id = format!("{}-uuid-doc", RELAY_ID);
    let sid = setup_session_with_read(&server, &doc_id);

    execute(&server, &sid, &json!({
        "file_path": "Lens/Doc.md", "old_string": "quick", "new_string": "fast", "session_id": sid,
    })).await.unwrap();

    // Re-read between edits
    super::read::execute(&server, &sid, &json!({
        "file_path": "Lens/Doc.md", "session_id": sid,
    })).await.unwrap();

    execute(&server, &sid, &json!({
        "file_path": "Lens/Doc.md", "old_string": "lazy", "new_string": "happy", "session_id": sid,
    })).await.unwrap();

    let raw = read_doc_content(&server, &doc_id);
    let spans = super::critic_markup::parse(&raw);
    assert_eq!(super::critic_markup::accepted_view(&spans),
        "The fast brown fox jumps over the happy dog.");
    assert_eq!(super::critic_markup::base_view(&spans),
        "The quick brown fox jumps over the lazy dog.");
}

#[tokio::test]
async fn e02_triple_supersede_preserves_original_base() {
    let server = build_test_server(&[("/Doc.md", "uuid-doc", "Say hello today.")]).await;
    let doc_id = format!("{}-uuid-doc", RELAY_ID);
    let sid = setup_session_with_read(&server, &doc_id);

    for (old, new) in [("hello", "world"), ("world", "earth"), ("earth", "mars")] {
        execute(&server, &sid, &json!({
            "file_path": "Lens/Doc.md", "old_string": old, "new_string": new, "session_id": sid,
        })).await.unwrap();
        super::read::execute(&server, &sid, &json!({
            "file_path": "Lens/Doc.md", "session_id": sid,
        })).await.unwrap();
    }

    let raw = read_doc_content(&server, &doc_id);
    let spans = super::critic_markup::parse(&raw);
    assert_eq!(super::critic_markup::accepted_view(&spans), "Say mars today.");
    assert_eq!(super::critic_markup::base_view(&spans), "Say hello today.");
}

#[tokio::test]
async fn e03_expanding_edit_supersedes_prior() {
    let server = build_test_server(&[(
        "/Doc.md", "uuid-doc", "The quick brown fox jumps over.",
    )]).await;
    let doc_id = format!("{}-uuid-doc", RELAY_ID);
    let sid = setup_session_with_read(&server, &doc_id);

    execute(&server, &sid, &json!({
        "file_path": "Lens/Doc.md", "old_string": "brown", "new_string": "red", "session_id": sid,
    })).await.unwrap();

    super::read::execute(&server, &sid, &json!({
        "file_path": "Lens/Doc.md", "session_id": sid,
    })).await.unwrap();

    execute(&server, &sid, &json!({
        "file_path": "Lens/Doc.md", "old_string": "quick red fox", "new_string": "slow blue cat", "session_id": sid,
    })).await.unwrap();

    let raw = read_doc_content(&server, &doc_id);
    let spans = super::critic_markup::parse(&raw);
    assert_eq!(super::critic_markup::accepted_view(&spans), "The slow blue cat jumps over.");
    assert_eq!(super::critic_markup::base_view(&spans), "The quick brown fox jumps over.");
}
```

- [ ] **Step 2: Run tests, verify they pass**

- [ ] **Step 3: Run full test suite**

```bash
CARGO_TARGET_DIR=~/code/lens-relay/.cargo-target cargo test --manifest-path=crates/Cargo.toml
```

- [ ] **Step 4: Commit**

```
test(mcp): add multi-step integration tests for CriticMarkup smart merge
```

### Task 10: Manual verification

- [ ] **Step 1:** Start local relay: `cd lens-editor && npm run relay:start`
- [ ] **Step 2:** Run setup: `cd lens-editor && npm run relay:setup`
- [ ] **Step 3:** Generate share link: `cd lens-editor && npx tsx scripts/generate-share-link.ts --role edit --folder b0000001-0000-4000-8000-000000000001 --base-url http://dev.vps:5173`
- [ ] **Step 4:** Test via MCP tools: read → edit → read → edit same region → verify no nesting
