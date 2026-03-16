# CriticMarkup Smart Merge for MCP Edit Tool

**Date:** 2026-03-16
**Status:** Design approved, pending implementation

## Problem

The MCP `edit` tool wraps all AI changes in CriticMarkup (`{--old--}{++new++}`) for human review. This works for single edits, but when the AI revises its own prior edits — or edits regions that overlap existing suggestions — we get nested CriticMarkup wrappers (`{++{--old--}{++new++}++}`), which is unreadable and breaks the review workflow.

## Design Overview

Make CriticMarkup invisible to the AI at edit time. The AI sees and edits against an "accepted" view of the document (all suggestions resolved). The edit tool maps the AI's plain-text edits back onto the markup-laden raw document, merging and superseding existing suggestions as needed. The AI never produces or targets CriticMarkup directly.

## Terminology

- **Raw content**: the Y.Doc text as stored, including CriticMarkup syntax and metadata
- **Accepted view**: raw content with all suggestions resolved as accepted (insertions kept, deletions removed)
- **Base text**: the text before any suggestions — what you get by rejecting all suggestions (deletions kept, insertions removed). When a suggestion is superseded, its base text is carried forward into the new suggestion's deletion side.
- **`old_string` / `new_string`**: the AI's edit parameters, targeting the accepted view

## Section 1: Read Tool — Accepted View + Pending Summary

When the AI calls `read`, it receives:

**Primary content:** The accepted view — all CriticMarkup resolved as accepted. Line numbers and `old_string` targeting use this view.

**Pending suggestions footer:** Only present if the document contains CriticMarkup. Lists affected lines (using accepted-view line numbers) with:

- Truncated CriticMarkup: sides longer than 10 words become "first three words ... last three words"
- Relative timestamps: "10m ago", "2d ago", etc.
- Author tag: "AI" or "Human"

Example output:

```
     1  The fast brown fox
     2  jumps over the lazy dog
     3  This line has no suggestions

[Pending suggestions]
     1  The {--quick--}{++fast++} brown fox  (AI, 10m ago)
     2  jumps over the {++lazy ++}dog  (Human, 2d ago)
```

The accepted view is what gets recorded for the read-before-edit check.

## Section 2: Edit Tool — Per-Change-Region Suggestion Merging

The edit tool receives `old_string` and `new_string` targeting the accepted view. Processing:

1. Parse the raw document into CriticMarkup spans
2. Build the accepted view and a span-index position map
3. Find `old_string` in the accepted view (existing uniqueness check)
4. **Diff `old_string` vs `new_string` at word level** (existing `similar` crate diffing)
5. For each **change region** in the diff, independently map it back to the raw document and handle suggestion merging. Adjacent changed words separated only by whitespace are merged into a single change region (single-space absorption, carried forward from `critic_diff.rs`). Equal regions of actual words (not just whitespace) are NOT absorbed.
6. **Equal regions** between change regions pass through unchanged, preserving any existing suggestions within them

Per-change-region merging rules:

- **Plain text only:** Wrap as `{--old--}{++new++}` with metadata (current behavior)
- **Entirely inside one existing suggestion:** Supersede it — the deletion side uses the base text (from the existing suggestion's deletion side), the insertion side uses the AI's new text. The superseded suggestion is discarded.
- **Partially overlapping a suggestion + plain text:** Collapse into one new suggestion spanning the full change region. The deletion side is the base text for the entire range (existing suggestion contributes its deletion side, plain text contributes itself). The insertion side is the AI's new text for the entire range.
- **Spanning multiple suggestions within one change region:** Same as above — all overlapped suggestions and intervening plain text are collapsed into one new suggestion. Suggestions that fall within equal regions of the diff are preserved untouched.

Example of partial overlap:
```
Raw:      Hello {--world--}{++earth++} and goodbye
Accepted: Hello earth and goodbye
AI edit:  old_string="earth and", new_string="mars or"
Result:   Hello {--world and--}{++mars or++} goodbye
```

The existing suggestion (`world→earth`) and the plain text "and" are collapsed into one new suggestion because they fall within one change region of the diff.

This ensures an edit that replaces a large block but only changes a few words still produces small, targeted suggestions — not one giant suggestion spanning the whole replacement.

Author metadata on new/merged suggestions is "AI" with the current timestamp. Superseded suggestions lose their individual metadata.

### TOCTOU re-verification

The current edit tool re-reads raw content under a write lock and verifies `old_string` is still at the expected offset (lines 116-124 of `edit.rs`). Under the new model, the re-verify must:

1. Re-parse raw content → spans → accepted view (under write lock)
2. Verify `old_string` still matches at the expected accepted-view offset
3. If the accepted view changed (e.g., a human accepted/rejected a suggestion between read and edit), return the existing "Document changed since last read" error

## Section 3: CriticMarkup Parsing Utilities (New Module)

A new module `critic_markup.rs` in `crates/relay/src/mcp/tools/` providing:

### Data types

```rust
enum Span {
    Plain(String),
    Suggestion {
        deleted: String,   // base text (what gets restored on reject)
        inserted: String,  // suggested text (what's shown on accept). Empty for pure deletions.
        author: String,    // "AI", "Human", or "Unknown"
        timestamp: Option<u64>,  // milliseconds since epoch, if present
    },
}
```

Standalone deletions (`{--text--}` without `{++...++}`) are parsed as `Suggestion { deleted: "text", inserted: "", ... }`. Standalone insertions (`{++text++}` without preceding `{--...--}`) are parsed as `Suggestion { deleted: "", inserted: "text", ... }`.

### Functions

- `parse(raw: &str) -> Vec<Span>` — parse raw text into spans. Malformed CriticMarkup (unclosed delimiters, nested delimiters) is treated as plain text. CriticMarkup delimiters inside fenced code blocks (`` ``` ``) are treated as plain text.
- `accepted_view(spans: &[Span]) -> String` — resolve all suggestions as accepted
- `base_view(spans: &[Span]) -> String` — resolve all suggestions as rejected (base text)
- `render_pending_summary(spans: &[Span], accepted_content: &str) -> String` — produce the truncated footer for `read` output

### Position mapping

Rather than a character-offset-based `PositionMap`, the algorithm operates on span indices. Given a byte range in the accepted view, the edit tool identifies which spans contribute to that range and how much of each span is covered. This avoids the complexity of mapping individual character positions through metadata-laden raw content.

The mapping works because each span contributes a known number of characters to the accepted view:
- `Plain(text)` contributes `text.len()` characters
- `Suggestion { inserted, .. }` contributes `inserted.len()` characters (the accepted text)

Walking spans and accumulating accepted-view offsets gives the correspondence.

### Metadata format

The existing metadata format is preserved in raw documents:

```
{--{"author":"AI","timestamp":1707600000}@@old text--}
{++{"author":"AI","timestamp":1707600000}@@new text++}
```

The parser extracts `author` and `timestamp` from the JSON prefix (delimited by `@@`). Spans without metadata get `author: "Unknown"` and no timestamp.

## Section 4: Smart Merge Algorithm

The core algorithm combining word-level diffing with CriticMarkup-aware document manipulation:

1. Parse raw document content → `Vec<Span>`
2. Build accepted view by walking spans
3. Find `old_string` in accepted view (uniqueness check, byte offset)
4. Identify which spans are covered by the matched range (span-index-based, using the accumulated offset approach from Section 3)
5. Diff `old_string` vs `new_string` at word level (`similar` crate)
6. Walk the diff output. For each change region:
   a. Map the change region's offset within `old_string` to the corresponding raw spans (using the same span-walking approach)
   b. Collect base text for the deletion side: `Plain` spans contribute their text, `Suggestion` spans contribute their `deleted` field
   c. The insertion side is the corresponding segment of `new_string`
   d. Emit: `{--<metadata>@@<base text>--}{++<metadata>@@<new text>++}`
7. For equal regions in the diff: emit the corresponding raw spans as-is, preserving any untouched suggestions within them
8. For spans outside the matched range entirely: emit as-is
9. Concatenate and write back to Y.Doc

Note: `smart_critic_markup()` from `critic_diff.rs` is **not** reused in the new flow. The word-level diffing (step 5) uses the `similar` crate directly, and the CriticMarkup wrapping (step 6d) is done inline with awareness of existing spans. The existing `smart_critic_markup()` function remains available for any non-MCP uses.

## Section 5: Testing Strategy

Two layers of tests:

**Acceptance tests** (primary correctness): Parse the result of an edit, build the accepted view, verify it matches the expected output. These validate that the document is correct regardless of exact markup formatting.

**Exact markup tests** (key cases): Verify specific CriticMarkup output for important scenarios. These ensure suggestions are clean, minimal, and reviewable.

### Test scenarios

Parser:
- Round-trip: parse → accepted view → matches expected plain text
- Round-trip: parse → base view → matches expected base text
- Metadata extraction: author and timestamp parsed correctly
- Standalone deletion: `{--text--}` → `Suggestion { deleted: "text", inserted: "" }`
- Standalone insertion: `{++text++}` → `Suggestion { deleted: "", inserted: "text" }`
- Malformed/unclosed CriticMarkup: treated as plain text
- CriticMarkup inside fenced code blocks: treated as plain text

Core edit behavior:
- Edit touching only plain text (no existing suggestions) — current behavior preserved
- Edit entirely within an existing suggestion — supersedes it
- Edit overlapping the boundary of a suggestion + plain text — collapses into one new suggestion
- Edit spanning multiple suggestions with plain text between — each change region handles its overlapping suggestions independently; suggestions in equal regions preserved
- Edit that doesn't touch any suggestion — leaves them all untouched

Iterative editing:
- Sequential AI edits on the same region — each supersedes the last
- AI edits a region, then edits a larger region that includes it
- Human suggestion gets re-edited by AI — superseded with AI authorship

Whole-document edits:
- Replace entire document content, but diff produces only small word-level changes — existing suggestions in unchanged regions preserved
- Replace entire document, changing everything — all suggestions superseded

Read tool:
- Document with no suggestions: no footer, output identical to current behavior
- Document with suggestions: footer shows affected lines with truncated markup
- Truncation: sides >10 words shortened to "first three ... last three"
- Relative timestamps render correctly

## Section 6: What Doesn't Change

- `create` tool: no CriticMarkup (immediate file creation)
- `move` tool: no CriticMarkup (immediate operation)
- `grep` tool: searches raw content including CriticMarkup. This means grep results may include CriticMarkup syntax. This is acceptable because grep is used for discovery (finding which documents match), not for constructing `old_string` — the AI should `read` a document before editing it, and the read output provides the accepted view for targeting.
- CriticMarkup metadata format in raw documents stays the same
- Frontend rendering/accept/reject UI is unchanged
