#[cfg(test)]
mod tests {
    use super::*;

    // === extract_wikilinks tests (existing) ===

    #[test]
    fn extracts_simple_wikilink() {
        let result = extract_wikilinks("[[Note]]");
        assert_eq!(result, vec!["Note"]);
    }

    #[test]
    fn returns_empty_for_no_links() {
        let result = extract_wikilinks("plain text");
        assert_eq!(result, Vec::<String>::new());
    }

    #[test]
    fn extracts_multiple_wikilinks() {
        let result = extract_wikilinks("[[One]] and [[Two]]");
        assert_eq!(result, vec!["One", "Two"]);
    }

    #[test]
    fn strips_anchor_from_link() {
        let result = extract_wikilinks("[[Note#Section]]");
        assert_eq!(result, vec!["Note"]);
    }

    #[test]
    fn strips_alias_from_link() {
        let result = extract_wikilinks("[[Note|Display Text]]");
        assert_eq!(result, vec!["Note"]);
    }

    #[test]
    fn handles_anchor_and_alias() {
        let result = extract_wikilinks("[[Note#Section|Display]]");
        assert_eq!(result, vec!["Note"]);
    }

    #[test]
    fn ignores_empty_brackets() {
        let result = extract_wikilinks("[[]]");
        assert_eq!(result, Vec::<String>::new());
    }

    #[test]
    fn ignores_links_in_code_blocks() {
        let markdown = "```\n[[CodeLink]]\n```\nOutside [[RealLink]]";
        let result = extract_wikilinks(markdown);
        assert_eq!(result, vec!["RealLink"]);
    }

    #[test]
    fn ignores_links_in_inline_code() {
        let result = extract_wikilinks("See `[[Fake]]` but [[Real]]");
        assert_eq!(result, vec!["Real"]);
    }

    #[test]
    fn preserves_relative_parent_segments() {
        let result = extract_wikilinks("[[../Ideas]]");
        assert_eq!(result, vec!["../Ideas"]);
    }

    #[test]
    fn preserves_relative_dot_segments() {
        let result = extract_wikilinks("[[./Sub/Ideas]]");
        assert_eq!(result, vec!["./Sub/Ideas"]);
    }

    // === extract_wikilink_occurrences tests ===

    #[test]
    fn returns_byte_positions_of_page_name() {
        // "See [[Foo]] here" -> name="Foo", name_start=6, name_len=3
        let result = extract_wikilink_occurrences("See [[Foo]] here");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "Foo");
        assert_eq!(result[0].name_start, 6);
        assert_eq!(result[0].name_len, 3);
    }

    #[test]
    fn positions_with_anchor() {
        // "[[Foo#Section]]" -> name="Foo", name_start=2, name_len=3
        let result = extract_wikilink_occurrences("[[Foo#Section]]");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "Foo");
        assert_eq!(result[0].name_start, 2);
        assert_eq!(result[0].name_len, 3);
    }

    #[test]
    fn positions_with_alias() {
        // "[[Foo|Display]]" -> name="Foo", name_start=2, name_len=3
        let result = extract_wikilink_occurrences("[[Foo|Display]]");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "Foo");
        assert_eq!(result[0].name_start, 2);
        assert_eq!(result[0].name_len, 3);
    }

    #[test]
    fn positions_with_anchor_and_alias() {
        // "[[Foo#Sec|Display]]" -> name="Foo", name_start=2, name_len=3
        let result = extract_wikilink_occurrences("[[Foo#Sec|Display]]");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "Foo");
        assert_eq!(result[0].name_start, 2);
        assert_eq!(result[0].name_len, 3);
    }

    #[test]
    fn skips_occurrences_inside_fenced_code() {
        // "```\n[[Foo]]\n```\n[[Bar]]" -> only Bar returned
        let result = extract_wikilink_occurrences("```\n[[Foo]]\n```\n[[Bar]]");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "Bar");
    }

    #[test]
    fn skips_occurrences_inside_inline_code() {
        // "`[[Foo]]` and [[Bar]]" -> only Bar returned
        let result = extract_wikilink_occurrences("`[[Foo]]` and [[Bar]]");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "Bar");
    }

    #[test]
    fn multiple_occurrences_positions() {
        // "[[A]] then [[B]]" -> two entries with correct positions
        let result = extract_wikilink_occurrences("[[A]] then [[B]]");
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].name, "A");
        assert_eq!(result[0].name_start, 2);
        assert_eq!(result[0].name_len, 1);
        assert_eq!(result[1].name, "B");
        assert_eq!(result[1].name_start, 13);
        assert_eq!(result[1].name_len, 1);
    }

    // === compute_wikilink_rename_edits tests ===

    #[test]
    fn simple_rename_edit() {
        // "See [[Foo]] here", old="Foo", new="Bar"
        // -> 1 edit: offset=6, remove_len=3, insert="Bar"
        let edits = compute_wikilink_rename_edits("See [[Foo]] here", "Foo", "Bar");
        assert_eq!(edits.len(), 1);
        assert_eq!(edits[0].offset, 6);
        assert_eq!(edits[0].remove_len, 3);
        assert_eq!(edits[0].insert_text, "Bar");
    }

    #[test]
    fn preserves_anchor_in_rename() {
        // "[[Foo#Section]]", old="Foo", new="Bar"
        // -> edit replaces only "Foo", result: "[[Bar#Section]]"
        let edits = compute_wikilink_rename_edits("[[Foo#Section]]", "Foo", "Bar");
        assert_eq!(edits.len(), 1);
        assert_eq!(edits[0].offset, 2);
        assert_eq!(edits[0].remove_len, 3);
        assert_eq!(edits[0].insert_text, "Bar");
        // Verify application produces correct result
        let mut text = "[[Foo#Section]]".to_string();
        apply_edits(&mut text, &edits);
        assert_eq!(text, "[[Bar#Section]]");
    }

    #[test]
    fn preserves_alias_in_rename() {
        // "[[Foo|Display]]", old="Foo", new="Bar"
        // -> edit replaces only "Foo", result: "[[Bar|Display]]"
        let edits = compute_wikilink_rename_edits("[[Foo|Display]]", "Foo", "Bar");
        assert_eq!(edits.len(), 1);
        assert_eq!(edits[0].offset, 2);
        assert_eq!(edits[0].remove_len, 3);
        assert_eq!(edits[0].insert_text, "Bar");
        let mut text = "[[Foo|Display]]".to_string();
        apply_edits(&mut text, &edits);
        assert_eq!(text, "[[Bar|Display]]");
    }

    #[test]
    fn case_insensitive_rename() {
        // "[[foo]] and [[FOO]]", old="Foo", new="Bar"
        // -> 2 edits
        let edits = compute_wikilink_rename_edits("[[foo]] and [[FOO]]", "Foo", "Bar");
        assert_eq!(edits.len(), 2);
    }

    #[test]
    fn no_edits_for_non_matching() {
        // "[[Other]]", old="Foo", new="Bar" -> 0 edits
        let edits = compute_wikilink_rename_edits("[[Other]]", "Foo", "Bar");
        assert_eq!(edits.len(), 0);
    }

    #[test]
    fn skips_code_blocks_in_rename() {
        // "```\n[[Foo]]\n```\n[[Foo]]", old="Foo", new="Bar"
        // -> 1 edit (only the one outside code block)
        let edits = compute_wikilink_rename_edits("```\n[[Foo]]\n```\n[[Foo]]", "Foo", "Bar");
        assert_eq!(edits.len(), 1);
    }

    #[test]
    fn edits_in_reverse_offset_order() {
        // "[[Foo]] and [[Foo]]" -> second edit has higher offset
        // verify edits[0].offset > edits[1].offset (reverse sorted)
        let edits = compute_wikilink_rename_edits("[[Foo]] and [[Foo]]", "Foo", "Bar");
        assert_eq!(edits.len(), 2);
        assert!(edits[0].offset > edits[1].offset, "edits should be in reverse offset order");
    }

    #[test]
    fn multiple_rename_with_different_formats() {
        // "[[Foo]] and [[Foo#Sec]] and [[Foo|Alias]]"
        // -> 3 edits, each replacing only "Foo"
        let markdown = "[[Foo]] and [[Foo#Sec]] and [[Foo|Alias]]";
        let edits = compute_wikilink_rename_edits(markdown, "Foo", "Bar");
        assert_eq!(edits.len(), 3);
        // All edits should replace "Foo" (3 bytes)
        for edit in &edits {
            assert_eq!(edit.remove_len, 3);
            assert_eq!(edit.insert_text, "Bar");
        }
        // Verify application produces correct result
        let mut text = markdown.to_string();
        apply_edits(&mut text, &edits);
        assert_eq!(text, "[[Bar]] and [[Bar#Sec]] and [[Bar|Alias]]");
    }

    #[test]
    fn rename_edits_match_path_qualified_wikilink() {
        // Cross-folder link: [[Relay Folder 2/Foo]] should match rename of "Foo"
        let md = "See [[Relay Folder 2/Foo]] for details";
        let edits = compute_wikilink_rename_edits(md, "Foo", "Qux");

        // Should find one edit — the "Foo" portion of "Relay Folder 2/Foo"
        assert_eq!(edits.len(), 1, "path-qualified link should match basename rename");

        let edit = &edits[0];
        assert_eq!(edit.insert_text, "Qux");
        // After applying: "See [[Relay Folder 2/Qux]] for details"
    }

    /// Helper to apply edits to a string (edits must be in reverse offset order)
    fn apply_edits(text: &mut String, edits: &[TextEdit]) {
        for edit in edits {
            text.replace_range(edit.offset..edit.offset + edit.remove_len, &edit.insert_text);
        }
    }
}

use regex::Regex;
use std::sync::LazyLock;

// Compile regex once, reuse across calls
static WIKILINK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\[\[([^\]]+)\]\]").unwrap()
});

static FENCED_CODE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)```[^\n]*\n.*?```|~~~[^\n]*\n.*?~~~").unwrap()
});

static INLINE_CODE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"`[^`]*`").unwrap()
});

/// Extract wikilink targets from markdown text.
/// Returns page names only (strips anchors and aliases).
/// Ignores links inside code blocks and inline code.
pub fn extract_wikilinks(markdown: &str) -> Vec<String> {
    // Strip code blocks first
    let without_fenced = FENCED_CODE_RE.replace_all(markdown, "");
    let without_code = INLINE_CODE_RE.replace_all(&without_fenced, "");

    let mut links = Vec::new();

    for cap in WIKILINK_RE.captures_iter(&without_code) {
        let mut content = cap[1].to_string();

        // Skip empty
        if content.trim().is_empty() {
            continue;
        }

        // Strip alias (|) - take only the part before |
        if let Some(pipe_idx) = content.find('|') {
            content = content[..pipe_idx].to_string();
        }

        // Strip anchor (#) - take only the part before #
        if let Some(hash_idx) = content.find('#') {
            content = content[..hash_idx].to_string();
        }

        let trimmed = content.trim().to_string();
        if !trimmed.is_empty() {
            links.push(trimmed);
        }
    }

    links
}

/// A wikilink occurrence with byte positions of the replaceable page-name span.
///
/// `name_start` and `name_len` describe the byte span from `[[` to the first
/// `#`, `|`, or `]]` — i.e. the portion to replace during a rename.
/// `name` is the trimmed page name extracted from that span.
#[derive(Debug, PartialEq, Eq)]
pub struct WikilinkOccurrence {
    /// Trimmed page name, e.g. "Foo" from `[[Foo#Section|Alias]]`
    pub name: String,
    /// Byte offset of the replaceable span (starts right after "[[")
    pub name_start: usize,
    /// Byte length of the replaceable span (up to `#`, `|`, or `]]`)
    pub name_len: usize,
}

/// Build a set of byte ranges that are inside code blocks or inline code.
fn build_excluded_ranges(markdown: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    for m in FENCED_CODE_RE.find_iter(markdown) {
        ranges.push((m.start(), m.end()));
    }
    for m in INLINE_CODE_RE.find_iter(markdown) {
        ranges.push((m.start(), m.end()));
    }
    ranges
}

/// Returns true if the byte offset falls within any excluded range.
fn is_excluded(offset: usize, excluded: &[(usize, usize)]) -> bool {
    excluded.iter().any(|&(start, end)| offset >= start && offset < end)
}

/// Extract wikilink occurrences with byte positions of the page-name portion.
/// Unlike `extract_wikilinks()`, this preserves byte positions by using excluded
/// ranges instead of stripping code blocks.
pub fn extract_wikilink_occurrences(markdown: &str) -> Vec<WikilinkOccurrence> {
    let excluded = build_excluded_ranges(markdown);
    let mut occurrences = Vec::new();

    for cap in WIKILINK_RE.captures_iter(markdown) {
        let full_match = cap.get(0).unwrap();
        // Skip if this match starts inside an excluded range
        if is_excluded(full_match.start(), &excluded) {
            continue;
        }

        let content = &cap[1];

        // Skip empty
        if content.trim().is_empty() {
            continue;
        }

        // The page name is the part before any '#' or '|'
        let name_end_in_content = content
            .find('#')
            .unwrap_or(content.len())
            .min(content.find('|').unwrap_or(content.len()));

        let name = content[..name_end_in_content].trim();
        if name.is_empty() {
            continue;
        }

        // name_start is the byte offset of group 1 in the original string
        let group1_start = cap.get(1).unwrap().start();

        occurrences.push(WikilinkOccurrence {
            name: name.to_string(),
            name_start: group1_start,
            name_len: name_end_in_content,
        });
    }

    occurrences
}

/// A text edit: replace `remove_len` bytes at `offset` with `insert_text`.
#[derive(Debug, PartialEq, Eq)]
pub struct TextEdit {
    /// Byte offset in source
    pub offset: usize,
    /// Number of bytes to remove
    pub remove_len: usize,
    /// Replacement text
    pub insert_text: String,
}

/// Find all wikilinks matching `old_name` (case-insensitive) and return text edits
/// to replace the page-name portion with `new_name`. Preserves anchors and aliases.
/// Returns edits in reverse offset order for safe sequential application.
pub fn compute_wikilink_rename_edits(
    markdown: &str,
    old_name: &str,
    new_name: &str,
) -> Vec<TextEdit> {
    let occurrences = extract_wikilink_occurrences(markdown);
    let old_lower = old_name.to_lowercase();

    let mut edits: Vec<TextEdit> = occurrences
        .into_iter()
        .filter_map(|occ| {
            // Extract basename: last component after '/'
            let basename = occ.name.rsplit('/').next().unwrap_or(&occ.name);
            if basename.to_lowercase() != old_lower {
                return None;
            }

            // Compute offset/len targeting only the basename portion
            let basename_offset_in_name = occ.name.len() - basename.len();
            Some(TextEdit {
                offset: occ.name_start + basename_offset_in_name,
                remove_len: basename.len(),
                insert_text: new_name.to_string(),
            })
        })
        .collect();

    // Sort in reverse offset order for safe sequential application
    edits.sort_by(|a, b| b.offset.cmp(&a.offset));

    edits
}

/// Like `compute_wikilink_rename_edits`, but with a resolution filter.
///
/// For each wikilink whose basename matches `old_name` (case-insensitive),
/// calls `should_edit(link_name)` to confirm this link actually points to
/// the renamed file. Only produces edits for links where `should_edit` returns true.
pub fn compute_wikilink_rename_edits_resolved<F>(
    markdown: &str,
    old_name: &str,
    new_name: &str,
    should_edit: F,
) -> Vec<TextEdit>
where
    F: Fn(&str) -> bool,
{
    let occurrences = extract_wikilink_occurrences(markdown);
    let old_lower = old_name.to_lowercase();

    let mut edits: Vec<TextEdit> = occurrences
        .into_iter()
        .filter_map(|occ| {
            let basename = occ.name.rsplit('/').next().unwrap_or(&occ.name);
            if basename.to_lowercase() != old_lower {
                return None;
            }

            if !should_edit(&occ.name) {
                return None;
            }

            let basename_offset_in_name = occ.name.len() - basename.len();
            Some(TextEdit {
                offset: occ.name_start + basename_offset_in_name,
                remove_len: basename.len(),
                insert_text: new_name.to_string(),
            })
        })
        .collect();

    edits.sort_by(|a, b| b.offset.cmp(&a.offset));
    edits
}
