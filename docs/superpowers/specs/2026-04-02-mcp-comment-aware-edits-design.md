# MCP Comment-Aware Edits

## Problem

The MCP edit tool cannot handle documents containing CriticMarkup comments (`{>>...<<}`). Comments are treated as plain text by the Rust parser, so they appear verbatim in `accepted_view`. But `reject_if_contains_markup` blocks `{>>` and `<<}` in edit parameters, making it impossible for the AI to edit text that spans a comment or add its own comments.

## Design

### Changes

**1. Relax delimiter rejection** (`critic_markup.rs`)

`reject_if_contains_markup` stops blocking `{>>` and `<<}`. Only suggestion delimiters (`{--`, `--}`, `{++`, `++}`, `{~~`, `~~}`, `{==`, `==}`) remain rejected. This allows AI to include comment markup in `old_string` and `new_string`.

**2. Comment preservation validation** (`critic_markup.rs`)

New function `validate_comment_preservation(old_str, new_str) -> Result<(), String>`:
- Extracts all `{>>...<<}` blocks from both strings
- Each comment's metadata is parsed to determine authorship
- Every non-AI comment in `old_str` must appear in `new_str` unchanged (same content)
- AI-authored comments can be modified or removed
- New comments in `new_str` are allowed (AI adding comments)
- Comments with no metadata are treated as non-AI (protected)

Helper: `extract_comments(text) -> Vec<CommentInfo>` where `CommentInfo` has `{ content: String, author: String, from: usize, to: usize, full_match: String }`.

**3. Updated edit flow** (`edit.rs`)

In `execute()`, after the existing `reject_if_contains_markup` call (now relaxed for comments):
1. Call `validate_comment_preservation(old_string, new_string)`
2. Pass through to `merge_edit` as normal

`merge_edit` already handles this correctly for the common case: when comments appear identically in both `old_string` and `new_string`, the word-level diff sees them as equal text and preserves the raw bytes.

When the AI adds a new comment, it ends up inside suggestion markup (e.g., `{++meta@@text {>>AI comment<<}++}`). This nested markup is acceptable.

### What's NOT changing

- `Span` enum: no `Comment` variant — comments stay as plain text
- `accepted_view`: still includes comment markup (AI sees comments inline)
- `read` tool: output unchanged
- Frontend rendering: unchanged
- `merge_edit`: unchanged

### Edge cases

| Case | Behavior |
|------|----------|
| Comment with no metadata | Treated as non-AI, protected |
| Multiple comments in one edit | Each validated independently |
| AI modifies non-AI comment content | Rejected with error |
| AI removes non-AI comment | Rejected with error |
| AI removes its own comment | Allowed |
| AI adds new comment | Allowed, may nest inside suggestion markup |
| Comment inside code block | Already handled — parser skips code blocks |

### Validation examples

```
# OK: editing around preserved comment
old: "Hello {>>nice<<} world"
new: "Goodbye {>>nice<<} world"

# OK: AI adds comment
old: "Hello world"
new: "Hello world{>>{"author":"AI"}@@observation<<}"

# OK: AI removes own comment
old: "Hello {>>{"author":"AI"}@@note<<} world"
new: "Hello world"

# REJECTED: removing non-AI comment
old: "Hello {>>{"author":"human"}@@note<<} world"
new: "Hello world"

# REJECTED: modifying non-AI comment
old: "Hello {>>{"author":"human"}@@note<<} world"
new: "Hello {>>{"author":"human"}@@different<<} world"
```
