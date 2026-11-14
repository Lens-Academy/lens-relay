//! The note `create` and `edit` end with when a Markdown page gains links to
//! sources: agents should offer to import them, as the editor's offer bar does
//! for people (docs/plans/2026-11-02-import-and-link-sources.md, "Agents").
//!
//! Pure: the tools pass in the text they already hold. Advisory: it never
//! changes what was written.

use super::import_source::MAX_URLS;
use std::collections::HashSet;
use y_sweet_core::external_links::{classify, page_offers_source_links, scan, url_key};
use y_sweet_core::share_token::{McpAccess, ShareRole};

/// As many links as the note lists. The page itself has the rest.
const MAX_SHOWN: usize = 25;

/// Whether a session could act on the note: importing forwards its share
/// token to the editor, needs Admin or Edit, and writes into `Lens Edu`.
pub fn session_can_import(access: &McpAccess) -> bool {
    access.raw_token.is_some()
        && matches!(access.role, ShareRole::Admin | ShareRole::Edit)
        && access
            .folder_name
            .as_deref()
            .is_none_or(|folder| folder == "Lens Edu")
}

/// The note for a new page, or `None` when it has nothing to say.
pub fn create_note(path: &str, content: &str) -> Option<String> {
    note(path, content, None)
}

/// The note for an edit, listing only links the edit added. `before` and
/// `after` are the texts the tool compared, so `line` numbers are the ones a
/// `read` shows. Call it for a direct edit only: the swap leaves pending text
/// alone.
pub fn edit_note(path: &str, before: &str, after: &str) -> Option<String> {
    note(path, after, Some(before))
}

fn note(path: &str, text: &str, before: Option<&str>) -> Option<String> {
    if !page_offers_source_links(path, text) {
        return None;
    }
    let had = before.map(scan).unwrap_or_default();
    let mut seen: HashSet<&str> = had.iter().map(|link| url_key(&link.url)).collect();
    let links = scan(text);
    let sources: Vec<_> = links
        .iter()
        // A link that can't become a wikilink would be imported and left as
        // it is, so the note's promise would not hold.
        .filter(|link| {
            link.swappable && classify(&link.url).is_some() && seen.insert(url_key(&link.url))
        })
        .collect();

    let count = sources.len();
    let (noun, them, these_urls, each) = match count {
        0 => return None,
        1 => ("1 source".to_string(), "it", "this url", "it"),
        n => (format!("{n} sources"), "them", "these urls", "each one"),
    };
    let subject = match before {
        Some(_) => "this edit adds",
        None => "this page links to",
    };

    let mut out = format!("\n\nExternal links: {subject} {noun} that could live in the library:");
    for link in sources.iter().take(MAX_SHOWN) {
        let line = text[..link.start].matches('\n').count() + 1;
        out.push_str(&format!("\n- {} (line {})", link.url, line));
    }
    if count > MAX_SHOWN {
        out.push_str(&format!("\n- …and {} more.", count - MAX_SHOWN));
    }
    out.push_str(&format!(
        "\nOffer to import {them}, unless the user has already said what they want: import_source with {these_urls} and link_from \"{path}\" imports {each} and replaces its link with a wikilink when it is ready. Sources already in the library are linked at once. You don't need to wait, poll or edit the page. Each new import takes a few minutes and a Claude review, so leave out links the page only mentions in passing."
    ));
    if count > MAX_URLS {
        out.push_str(&format!(
            " import_source takes at most {MAX_URLS} urls per call, so split them over several calls."
        ));
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = "Lens/Reading list.md";

    fn access(token: bool, role: ShareRole, folder: Option<&str>) -> McpAccess {
        McpAccess {
            writable: role != ShareRole::View,
            folder_uuid: None,
            folder_name: folder.map(str::to_string),
            raw_token: token.then(|| "tok".to_string()),
            role,
        }
    }

    // Prevents: an agent told to call a tool the session cannot use, which
    // reads as a broken feature and costs a user-facing round trip
    #[test]
    fn eligibility_table() {
        use ShareRole::{Admin, Edit, Suggest, View};
        let cases = [
            (true, Admin, None, true),
            (true, Edit, None, true),
            (true, Admin, Some("Lens Edu"), true),
            (true, Edit, Some("Lens Edu"), true),
            // A folder that is not the library's.
            (true, Admin, Some("Lens"), false),
            (true, Edit, Some("Lens"), false),
            // Roles that cannot import.
            (true, Suggest, None, false),
            (true, View, None, false),
            (true, Suggest, Some("Lens Edu"), false),
            // No token to forward to the importer.
            (false, Admin, None, false),
            (false, Edit, Some("Lens Edu"), false),
        ];
        for (token, role, folder, expected) in cases {
            assert_eq!(
                session_can_import(&access(token, role, folder)),
                expected,
                "token={token} role={role:?} folder={folder:?}"
            );
        }
    }

    // Prevents: promising a swap for a link that can't become a wikilink
    #[test]
    fn leaves_out_links_that_cannot_be_swapped() {
        assert_eq!(create_note(PAGE, "[a|b](https://example.com/post)"), None);
        let note = create_note(
            PAGE,
            "[a|b](https://example.com/post) [c](https://example.com/post)",
        )
        .unwrap();
        assert!(note.contains("1 source that could"), "{note}");
    }

    // Prevents: an agent unable to find the links it is told about
    #[test]
    fn create_lists_sources_by_line() {
        let content = "# Reading\n\n\n[Post](https://example.com/post-a)\n\n\n\n\nhttps://www.lesswrong.com/posts/abc/title\n\n\nhttps://youtu.be/abcdefghijk\n";
        let note = create_note(PAGE, content).unwrap();
        assert!(note.starts_with("\n\nExternal links: this page links to 3 sources that could live in the library:\n"), "{note}");
        assert!(
            note.contains("\n- https://example.com/post-a (line 4)\n"),
            "{note}"
        );
        assert!(
            note.contains("\n- https://www.lesswrong.com/posts/abc/title (line 9)\n"),
            "{note}"
        );
        assert!(
            note.contains("\n- https://youtu.be/abcdefghijk (line 12)\n"),
            "{note}"
        );
        assert!(note.contains("\nOffer to import them, unless the user has already said what they want: import_source with these urls and link_from \"Lens/Reading list.md\" imports each one"), "{note}");
        assert!(
            note.ends_with("so leave out links the page only mentions in passing."),
            "{note}"
        );
    }

    // Prevents: "import them" for a single link
    #[test]
    fn one_source_reads_as_one() {
        let note = create_note(PAGE, "https://example.com/a").unwrap();
        assert!(
            note.contains("this page links to 1 source that could"),
            "{note}"
        );
        assert!(note.contains("Offer to import it,"), "{note}");
        assert!(note.contains("with this url and link_from"), "{note}");
    }

    // Prevents: a nudge to import a GitHub repo or a home page
    #[test]
    fn links_that_are_not_sources_say_nothing() {
        for content in [
            "No links here.",
            "[home](https://example.com/) https://github.com/a/b <https://discord.com/channels/1/2>",
            "![figure](https://example.com/a.png)",
            "`https://example.com/a`",
        ] {
            assert_eq!(create_note(PAGE, content), None, "{content}");
        }
    }

    // Prevents: a note nudging an agent toward a refusal
    #[test]
    fn pages_that_refuse_link_from_say_nothing() {
        let links = "https://example.com/a";
        assert_eq!(create_note("Lens Edu/Lenses/a.md", links), None);
        assert_eq!(create_note("Lens/_trash/a.md", links), None);
        assert_eq!(create_note("Lens/a.html", links), None);
        assert_eq!(
            create_note(PAGE, &format!("---\nsource_url: x\n---\n{links}")),
            None
        );
        assert_eq!(edit_note("Lens Edu/Lenses/a.md", "", links), None);
    }

    // Prevents: one source repeated in the note and sent to import_source twice
    #[test]
    fn each_url_is_listed_once_at_its_first_line() {
        let content =
            "https://example.com/a\n[again](https://example.com/a)\nhttps://example.com/a/\n";
        let note = create_note(PAGE, content).unwrap();
        assert!(note.contains("1 source"), "{note}");
        assert!(note.contains("(line 1)"), "{note}");
    }

    // Prevents: every edit of a page repeating the same list
    #[test]
    fn edit_lists_only_links_it_added() {
        let before = "[Old](https://example.com/old)\n";
        let after = "[Old](https://example.com/old)\n[New](https://example.com/new)\nhttps://example.com/old\n";
        let note = edit_note(PAGE, before, after).unwrap();
        assert!(
            note.starts_with(
                "\n\nExternal links: this edit adds 1 source that could live in the library:\n"
            ),
            "{note}"
        );
        assert!(
            note.contains("- https://example.com/new (line 2)"),
            "{note}"
        );
        assert!(!note.contains("/old"), "{note}");
        assert_eq!(edit_note(PAGE, before, before), None);
        assert_eq!(edit_note(PAGE, after, before), None);
    }

    // Prevents: a link-heavy page flooding the tool result, or a cut list
    // reading as the whole list
    #[test]
    fn long_lists_are_cut_and_say_how_many_more() {
        let content: String = (0..30)
            .map(|i| format!("https://example.com/{i}\n"))
            .collect();
        let note = create_note(PAGE, &content).unwrap();
        assert!(note.contains("this page links to 30 sources"), "{note}");
        assert_eq!(note.matches("(line ").count(), MAX_SHOWN, "{note}");
        assert!(note.contains("\n- …and 5 more.\n"), "{note}");
    }

    // Prevents: an agent pasting every URL into one call and getting a refusal
    #[test]
    fn says_so_when_there_are_more_than_one_call_takes() {
        let urls = |n: usize| -> String {
            (0..n)
                .map(|i| format!("https://example.com/{i}\n"))
                .collect()
        };
        let over = create_note(PAGE, &urls(MAX_URLS + 1)).unwrap();
        assert!(over.contains("at most 20 urls per call"), "{over}");
        assert!(!create_note(PAGE, &urls(MAX_URLS))
            .unwrap()
            .contains("per call"));
    }
}
