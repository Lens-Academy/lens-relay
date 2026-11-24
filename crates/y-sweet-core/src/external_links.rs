//! External link rules v1: which links a Markdown page holds, which of them are
//! sources, which pages get the import-and-link offer, and what a link becomes
//! when it is swapped for a wikilink.
//!
//! A port of `lens-editor/shared/external-links.ts`. Both run
//! `lens-editor/shared/external-link-cases.json`, and the numbers below are the
//! rules in docs/plans/2026-11-02-import-and-link-sources.md, so a change to one
//! is a change to both. The TypeScript counts UTF-16 units and this counts UTF-8
//! bytes; everything the rules compare is ASCII, so the two walks agree, and
//! offsets here are bytes (the same offsets Y.Text uses in these docs).

use crate::link_parser::TextEdit;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;
use url::Url;

/// `shared/external-link-rules.json`, here because the production Docker build
/// cannot see `lens-editor/`. A test locks the two together.
pub const SKIP_HOSTS: [&str; 42] = [
    "airtable.com",
    "amazon.com",
    "asana.com",
    "bit.ly",
    "bsky.app",
    "calendly.com",
    "canva.com",
    "cap.so",
    "chat.openai.com",
    "chatgpt.com",
    "claude.ai",
    "discord.com",
    "discord.gg",
    "dropbox.com",
    "eventbrite.com",
    "facebook.com",
    "figma.com",
    "forms.gle",
    "github.com",
    "gitlab.com",
    "google.com",
    "instagram.com",
    "lensacademy.org",
    "linkedin.com",
    "localhost",
    "loom.com",
    "lu.ma",
    "miro.com",
    "notion.so",
    "slack.com",
    "spotify.com",
    "t.me",
    "tiktok.com",
    "tinyurl.com",
    "trello.com",
    "twitter.com",
    "typeform.com",
    "vimeo.com",
    "wa.me",
    "x.com",
    "zcal.co",
    "zoom.us",
];

pub const SKIP_EXTENSIONS: [&str; 13] = [
    ".csv", ".docx", ".gif", ".jpeg", ".jpg", ".mp3", ".mp4", ".png", ".pptx", ".svg", ".webp",
    ".xlsx", ".zip",
];

/// How far the TypeScript looks for the end of an autolink or an HTML tag, in
/// UTF-16 units.
const TAG_WINDOW_UTF16: usize = 2048;

const CRITIC_CLOSERS: [(&[u8], &str); 5] = [
    (b"{++", "++}"),
    (b"{--", "--}"),
    (b"{~~", "~~}"),
    (b"{==", "==}"),
    (b"{>>", "<<}"),
];

static FRONTMATTER_CLOSE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\n---[ \t]*(?:\r?\n|\z)").unwrap());

static LETTER_OR_NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\p{L}\p{N}]$").unwrap());

static RAW_TEXT_OPEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^<(?:pre|code|script|style)[ \t\r\n>]").unwrap());

static RAW_TEXT_CLOSE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)</(?:pre|code|script|style)[ \t\r\n]*>").unwrap());

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkForm {
    Inline,
    Autolink,
    Bare,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalLink {
    pub url: String,
    /// The link text of an inline link; `None` for an autolink or bare URL.
    pub label: Option<String>,
    pub form: LinkForm,
    /// Byte offsets of the whole link in the text.
    pub start: usize,
    pub end: usize,
    pub in_table: bool,
    /// Whether it can become a wikilink without losing anything.
    pub swappable: bool,
}

/// What kind of source a URL is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Article,
    Video,
}

/// JavaScript's `\s`, which `char::is_whitespace` is not: it has U+FEFF and
/// lacks U+0085.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{B}' | '\u{C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// The length of a case-insensitive `http://` or `https://` at the start.
fn scheme_len(bytes: &[u8]) -> Option<usize> {
    [b"https://".as_slice(), b"http://".as_slice()]
        .iter()
        .find(|scheme| {
            bytes
                .get(..scheme.len())
                .is_some_and(|start| start.eq_ignore_ascii_case(scheme))
        })
        .map(|scheme| scheme.len())
}

fn find_from(text: &str, needle: &str, from: usize) -> Option<usize> {
    text.get(from..)?.find(needle).map(|at| from + at)
}

/// The offset past the closing fence's line of the leading frontmatter.
fn frontmatter_end(text: &str) -> Option<usize> {
    if !text.starts_with("---\n") && !text.starts_with("---\r\n") {
        return None;
    }
    FRONTMATTER_CLOSE
        .find(&text[3..])
        .map(|close| 3 + close.end())
}

/// The page's leading frontmatter block, both fences included, or "".
pub fn frontmatter_of(text: &str) -> &str {
    frontmatter_end(text).map_or("", |end| &text[..end])
}

/// A fence line's character, run length and the text after the run. A fence
/// may be indented any amount and sit in a quote or callout: inside a list
/// item or a callout it still is one.
fn fence_line(line: &str) -> Option<(u8, usize, &str)> {
    let rest = line.trim_start_matches([' ', '\t', '>']);
    let fence = *rest.as_bytes().first()?;
    if fence != b'`' && fence != b'~' {
        return None;
    }
    let run = rest.bytes().take_while(|b| *b == fence).count();
    let tail = &rest[run..];
    // The TypeScript's `.` stops at these, so such a line is no fence there.
    if run < 3 || tail.contains(['\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    Some((fence, run, tail))
}

/// `[id]: ` at the start of a line.
fn is_reference_definition(line: &str) -> bool {
    let indent = line.bytes().take_while(|b| *b == b' ').count();
    if indent > 3 {
        return false;
    }
    let Some(rest) = line[indent..].strip_prefix('[') else {
        return false;
    };
    match rest.find(']') {
        Some(close) if close > 0 => rest[close..]
            .strip_prefix("]:")
            .and_then(|after| after.chars().next())
            .is_some_and(is_js_space),
        _ => false,
    }
}

/// Four spaces or a tab at the start of a line.
fn is_indented(line: &str) -> bool {
    let spaces = line.bytes().take_while(|b| *b == b' ').count();
    spaces >= 4 || line.as_bytes().get(spaces) == Some(&b'\t')
}

/// `- `, `* `, `+ ` or `1. ` after the indent: a nested list, not code.
fn starts_list_item(line: &str) -> bool {
    let rest = line.trim_start_matches([' ', '\t']);
    let marker = match rest.as_bytes().first() {
        Some(b'-' | b'*' | b'+') => 1,
        Some(b'0'..=b'9') => {
            let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
            if !matches!(rest.as_bytes().get(digits), Some(b'.' | b')')) {
                return false;
            }
            digits + 1
        }
        _ => return false,
    };
    matches!(rest.as_bytes().get(marker), Some(b' ' | b'\t'))
}

/// A GFM delimiter row (`--- | ---`, `|:--|--:|`), in a quote or not.
fn is_delimiter_row(line: &str) -> bool {
    let row = line.trim_start_matches([' ', '\t', '>']);
    row.contains('|')
        && row.contains('-')
        && row.chars().all(|c| matches!(c, '|' | '-' | ':' | ' ' | '\t'))
}

/// What the line-by-line pass found: the skipped regions, by where they start
/// (rule 3), and the starts of table lines, outer pipes or not (rule 8).
struct Blocks {
    regions: HashMap<usize, usize>,
    table_lines: HashSet<usize>,
}

fn block_regions(text: &str) -> Blocks {
    let mut regions = HashMap::new();
    let mut table_lines = HashSet::new();
    let mut in_table = false;
    let mut pipe_line: Option<usize> = None;
    let mut offset = 0;
    if let Some(end) = frontmatter_end(text) {
        offset = end;
        regions.insert(0, end);
    }

    let mut open_fence: Option<(u8, usize, usize)> = None;
    let mut open_indent: Option<usize> = None;
    let mut after_blank = true;
    while offset < text.len() {
        let end = find_from(text, "\n", offset).map_or(text.len(), |newline| newline + 1);
        let with_newline = &text[offset..end];
        let line = with_newline
            .strip_suffix('\n')
            .map(|line| line.strip_suffix('\r').unwrap_or(line))
            .unwrap_or(with_newline);
        let blank = line.chars().all(is_js_space);
        if open_indent.is_some() && !blank && !is_indented(line) {
            regions.insert(open_indent.take().unwrap_or(offset), offset);
        }
        let fence = fence_line(line);
        if open_indent.is_some() {
            // Still in the indented block.
        } else if let Some((character, length, from)) = open_fence {
            let closes = fence.is_some_and(|(c, run, tail)| {
                c == character && run >= length && tail.chars().all(is_js_space)
            });
            if closes {
                regions.insert(from, end);
                open_fence = None;
            }
        } else if let Some((c, run, _)) =
            fence.filter(|(c, _, tail)| !(*c == b'`' && tail.contains('`')))
        {
            open_fence = Some((c, run, offset));
        } else if is_reference_definition(line) {
            regions.insert(offset, end);
        } else if after_blank && !blank && is_indented(line) && !starts_list_item(line) {
            open_indent = Some(offset);
        } else {
            let has_pipe = line.contains('|');
            if in_table && (blank || !has_pipe) {
                in_table = false;
            }
            if in_table {
                table_lines.insert(offset);
            } else if let (true, Some(header)) = (is_delimiter_row(line), pipe_line) {
                table_lines.insert(header);
                table_lines.insert(offset);
                in_table = true;
            }
            pipe_line = (!blank && has_pipe).then_some(offset);
            after_blank = blank;
            offset = end;
            continue;
        }
        in_table = false;
        pipe_line = None;
        after_blank = blank;
        offset = end;
    }
    if let Some((_, _, from)) = open_fence {
        regions.insert(from, text.len());
    }
    if let Some(from) = open_indent {
        regions.insert(from, text.len());
    }
    Blocks {
        regions,
        table_lines,
    }
}

/// The offset just past a `[…]` label that starts at `open`, on one line.
fn label_end(bytes: &[u8], open: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut i = open;
    while i < bytes.len() {
        match bytes[i] {
            b'\n' => return None,
            b'\\' => i += 1,
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// The URL of the `(…)` at `open`, the offset past it, and whether it has a
/// title (rule 4).
fn destination(text: &str, open: usize) -> Option<(&str, usize, bool)> {
    let bytes = text.as_bytes();
    let skip_blanks = |mut i: usize| {
        while matches!(bytes.get(i), Some(b' ' | b'\t')) {
            i += 1;
        }
        i
    };

    let mut i = skip_blanks(open + 1);
    let url;
    if bytes.get(i) == Some(&b'<') {
        let close = find_from(text, ">", i)?;
        url = &text[i + 1..close];
        i = close + 1;
    } else {
        let from = i;
        let mut depth = 0usize;
        while let Some(c) = text[i..].chars().next() {
            if is_js_space(c) {
                break;
            }
            if c == ')' && depth == 0 {
                break;
            }
            i += c.len_utf8();
            match c {
                '\\' => i += text[i..].chars().next().map_or(0, char::len_utf8),
                '(' => depth += 1,
                ')' => depth -= 1,
                _ => {}
            }
        }
        url = &text[from..i];
    }

    i = skip_blanks(i);
    let titled = matches!(bytes.get(i), Some(b'"' | b'\'' | b'('));
    if titled {
        let closer = if bytes[i] == b'(' { ")" } else { &text[i..i + 1] };
        i = skip_blanks(find_from(text, closer, i + 1)? + 1);
    }
    (bytes.get(i) == Some(&b')')).then_some((url, i + 1, titled))
}

/// A bare URL's end after rule 5's stops and trims.
fn bare_end(text: &str, start: usize) -> usize {
    let bytes = text.as_bytes();
    let mut end = text[start..]
        .find(|c| {
            is_js_space(c)
                || matches!(
                    c,
                    '<' | '>'
                        | '"'
                        | '`'
                        | '|'
                        | '['
                        | ']'
                        | '{'
                        | '}'
                        | '“'
                        | '”'
                        | '‘'
                        | '’'
                        | '«'
                        | '»'
                        | '。'
                        | '，'
                        | '、'
                        | '—'
                        | '–'
                )
        })
        .map_or(text.len(), |stop| start + stop);
    loop {
        match bytes[end - 1] {
            b'.' | b',' | b';' | b':' | b'!' | b'?' | b'\'' | b'*' | b'_' | b'~' => end -= 1,
            b')' => {
                let count = |wanted: u8| bytes[start..end].iter().filter(|b| **b == wanted).count();
                if count(b')') <= count(b'(') {
                    break;
                }
                end -= 1;
            }
            _ => break,
        }
    }
    end
}

fn is_in_table(text: &str, table_lines: &HashSet<usize>, offset: usize) -> bool {
    let line_start = text[..offset].rfind('\n').map_or(0, |newline| newline + 1);
    table_lines.contains(&line_start)
        || text[line_start..offset]
            .trim_start_matches(|c| is_js_space(c) || c == '>')
            .starts_with('|')
}

/// Whether `offset` is where a link's destination starts: the end of a label
/// that ran over a line, so the scanner never saw it as a label (rule 6).
fn follows_label(text: &str, offset: usize) -> bool {
    text[..offset].trim_end_matches([' ', '\t']).ends_with("](")
}

/// Past a code span whose opening run of `run` backticks starts at `open`, or
/// past the run alone when nothing closes it before a blank line.
fn code_span_end(text: &str, open: usize, run: usize) -> usize {
    let bytes = text.as_bytes();
    let limit = find_from(text, "\n\n", open).unwrap_or(text.len());
    let mut i = open + run;
    while i < limit {
        if bytes[i] != b'`' {
            i += 1;
            continue;
        }
        let mut close = i;
        while bytes.get(close) == Some(&b'`') {
            close += 1;
        }
        if close - i == run {
            return close;
        }
        i = close;
    }
    open + run
}

/// `text` from `start`, cut to the TypeScript's window.
fn tag_window(text: &str, start: usize) -> &str {
    let mut units = 0;
    for (at, c) in text[start..].char_indices() {
        units += c.len_utf16();
        if units > TAG_WINDOW_UTF16 {
            return &text[start..start + at];
        }
    }
    &text[start..]
}

/// The length of the `<https://…>` that `window` starts with.
fn autolink_len(window: &str) -> Option<usize> {
    let body = &window[1..];
    let scheme = scheme_len(body.as_bytes())?;
    let tail = &body[scheme..];
    let stop = tail.find(|c| is_js_space(c) || c == '<' || c == '>')?;
    (stop > 0 && tail.as_bytes()[stop] == b'>').then_some(1 + scheme + stop + 1)
}

/// The length of the raw HTML tag that `window` starts with.
fn html_tag_len(window: &str) -> Option<usize> {
    let bytes = window.as_bytes();
    let name = if bytes.get(1) == Some(&b'/') { 2 } else { 1 };
    if !bytes.get(name)?.is_ascii_alphabetic() {
        return None;
    }
    let attrs = name + 1;
    let stop = attrs + window[attrs..].find(['<', '>'])?;
    (bytes[stop] == b'>').then_some(stop + 1)
}

/// Whether a letter or number sits just before `offset`. The TypeScript reads
/// one UTF-16 unit there, so a character outside the BMP never counts.
fn follows_word(text: &str, offset: usize) -> bool {
    text[..offset].chars().next_back().is_some_and(|c| {
        let mut utf8 = [0; 4];
        c.len_utf16() == 1 && LETTER_OR_NUMBER.is_match(c.encode_utf8(&mut utf8))
    })
}

/// Every external link in a page, in document order.
pub fn scan(text: &str) -> Vec<ExternalLink> {
    let bytes = text.as_bytes();
    let Blocks {
        regions,
        table_lines,
    } = block_regions(text);
    let mut links = Vec::new();
    let add = |links: &mut Vec<ExternalLink>,
               url: &str,
               label: Option<&str>,
               form: LinkForm,
               start: usize,
               end: usize,
               swappable: bool| {
        links.push(ExternalLink {
            url: url.to_string(),
            label: label.map(str::to_string),
            form,
            start,
            end,
            in_table: is_in_table(text, &table_lines, start),
            // A link to a part of a page would lose the part (rule 7).
            swappable: swappable && !url.contains('#'),
        })
    };

    let mut i = 0;
    while i < bytes.len() {
        if let Some(&region_end) = regions.get(&i) {
            i = region_end;
            continue;
        }
        let byte = bytes[i];
        let rest = &bytes[i..];
        if byte == b'\\' {
            i += 2;
            continue;
        }
        if byte == b'`' {
            let run = rest.iter().take_while(|b| **b == b'`').count();
            i = code_span_end(text, i, run);
            continue;
        }
        if rest.starts_with(b"%%") {
            i = find_from(text, "%%", i + 2).map_or(text.len(), |close| close + 2);
            continue;
        }
        if let Some((_, closer)) = CRITIC_CLOSERS
            .iter()
            .find(|(opener, _)| rest.starts_with(opener))
        {
            i = find_from(text, closer, i + 3).map_or(i + 3, |close| close + 3);
            continue;
        }
        if rest.starts_with(b"<!--") {
            i = find_from(text, "-->", i + 4).map_or(text.len(), |close| close + 3);
            continue;
        }
        if rest.starts_with(b"[[") {
            if let Some(close) = find_from(text, "]]", i + 2) {
                if find_from(text, "\n", i).is_none_or(|newline| close < newline) {
                    i = close + 2;
                    continue;
                }
            }
        }
        if byte == b'!' && rest.get(1) == Some(&b'[') {
            let dest = label_end(bytes, i + 1)
                .filter(|after| bytes.get(*after) == Some(&b'('))
                .and_then(|after| destination(text, after));
            i = dest.map_or(i + 2, |(_, end, _)| end);
            continue;
        }
        if byte == b'<' {
            let window = tag_window(text, i);
            if let Some(len) = autolink_len(window) {
                let url = &text[i + 1..i + len - 1];
                let swappable = !follows_label(text, i);
                add(
                    &mut links,
                    url,
                    None,
                    LinkForm::Autolink,
                    i,
                    i + len,
                    swappable,
                );
                i += len;
            } else if RAW_TEXT_OPEN.is_match(window) {
                i = RAW_TEXT_CLOSE
                    .find_at(text, i)
                    .map_or(text.len(), |close| close.end());
            } else {
                i += html_tag_len(window).unwrap_or(1);
            }
            continue;
        }
        if byte == b'[' {
            let dest = label_end(bytes, i)
                .filter(|after| bytes.get(*after) == Some(&b'('))
                .and_then(|after| destination(text, after).map(|dest| (after, dest)));
            if let Some((after, (url, end, titled))) = dest {
                if scheme_len(url.as_bytes()).is_some() {
                    let label = &text[i + 1..after - 1];
                    // A label a wikilink alias would show as typed (rule 7).
                    let swappable = !titled
                        && !label.contains(['[', ']', '|', '*', '`', '_', '~', '$', '<', '>'])
                        && !label.contains("==");
                    add(
                        &mut links,
                        url,
                        Some(label),
                        LinkForm::Inline,
                        i,
                        end,
                        swappable,
                    );
                }
                i = end;
            } else {
                i += 1;
            }
            continue;
        }
        if (byte == b'h' || byte == b'H') && scheme_len(rest).is_some() && !follows_word(text, i) {
            let end = bare_end(text, i);
            let swappable = !follows_label(text, i);
            add(
                &mut links,
                &text[i..end],
                None,
                LinkForm::Bare,
                i,
                end,
                swappable,
            );
            i = end;
            continue;
        }
        i += 1;
    }
    links
}

fn is_youtube_host(host: &str) -> bool {
    host == "youtu.be"
        || host == "youtube.com"
        || host.ends_with(".youtube.com")
        || host == "youtube-nocookie.com"
        || host.ends_with(".youtube-nocookie.com")
}

/// The shape of a YouTube video id, as `server/add-video/video-url.ts` reads it.
fn is_video_id(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Whether a YouTube URL names one video the importer can take. This follows
/// `extractVideoInput`, which the editor's classifier calls, so it is a little
/// wider than the plan's list: `v=` counts on any path.
fn is_single_video(url: &Url, host: &str) -> bool {
    let v = url.query_pairs().find(|(name, _)| name == "v");
    if v.is_some_and(|(_, id)| is_video_id(&id)) {
        return true;
    }
    let segments: Vec<&str> = url.path().split('/').skip(1).collect();
    match segments.as_slice() {
        [id, ..] if host == "youtu.be" => is_video_id(id),
        ["shorts" | "live" | "embed", id, ..] => is_video_id(id),
        _ => false,
    }
}

/// Whether a URL is a source, and of what kind. First match wins. The editor's
/// half is `classifySourceLink` in `server/add-article/link-classify.ts`.
pub fn classify(url: &str) -> Option<Kind> {
    let url = Url::parse(url).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let host = url.host_str()?;
    let host = host.strip_suffix('.').unwrap_or(host);
    let site = host.strip_prefix("www.").unwrap_or(host);
    let skipped = |skip: &&str| {
        site == *skip
            || site
                .strip_suffix(*skip)
                .is_some_and(|sub| sub.ends_with('.'))
    };
    if SKIP_HOSTS.iter().any(skipped) {
        return None;
    }
    if is_youtube_host(host) {
        return is_single_video(&url, host).then_some(Kind::Video);
    }
    let path = url.path().to_ascii_lowercase();
    if SKIP_EXTENSIONS.iter().any(|ext| path.ends_with(ext)) {
        return None;
    }
    if path == "/" && url.query().is_none_or(str::is_empty) {
        return None;
    }
    Some(Kind::Article)
}

/// Whether a page gets the import-and-link offer. `path` is the full relay path
/// ("Lens/Notes/a.md"). Course pages are out: the platform leaves a wikilink to
/// an article as literal text, so a swap there would break the link.
pub fn page_offers_source_links(path: &str, text: &str) -> bool {
    if !path.to_lowercase().ends_with(".md") {
        return false;
    }
    if path.starts_with("Lens Edu/") || path.contains("/_trash/") {
        return false;
    }
    !frontmatter_of(text)
        .split(['\n', '\r', '\u{2028}', '\u{2029}'])
        .any(|line| line.starts_with("source_url:") || line.starts_with("synced_from:"))
}

/// A URL as the swap compares it: exact, but for one trailing slash.
pub fn url_key(url: &str) -> &str {
    url.strip_suffix('/').unwrap_or(url)
}

/// `title` as a wikilink alias, or the file stem at the end of `rel` when
/// nothing is left of it.
/// Braces go because every CriticMarkup delimiter has one, and a run of `%`
/// becomes one so it can't open an Obsidian comment: the title comes from
/// the source page, and an alias is inserted as written.
fn alias_from_title(title: Option<&str>, rel: &str) -> String {
    let clean = |text: &str| -> String {
        let mut out = String::with_capacity(text.len());
        for c in text.chars() {
            if matches!(c, '[' | ']' | '|' | '{' | '}' | '\n' | '\r')
                || (c == '%' && out.ends_with('%'))
            {
                continue;
            }
            out.push(c);
        }
        out.trim().to_string()
    };
    match clean(title.unwrap_or("")) {
        alias if alias.is_empty() => clean(rel.rsplit('/').next().unwrap_or(rel)),
        alias => alias,
    }
}

/// One link to replace, with offsets into the text it was found in.
#[derive(Debug, PartialEq, Eq)]
pub struct LinkSwap {
    pub start: usize,
    pub end: usize,
    /// What the link becomes, whole.
    pub replacement: String,
    /// The same change as the smallest edits, front to back: a label stays put
    /// so it keeps its author, and only the markup around it changes.
    pub edits: Vec<TextEdit>,
}

/// What swapping `urls` for a wikilink does to a text.
#[derive(Debug, PartialEq, Eq, Default)]
pub struct LinkSwaps {
    /// In document order.
    pub swaps: Vec<LinkSwap>,
    /// Links to these URLs that have to stay as they are.
    pub unswappable: usize,
}

/// The replacements that turn every link to `urls` into a wikilink to `rel`.
/// Links are found in `text` itself, so hold whatever keeps it current until
/// the edits are applied. `title` is the alias of a link that has no label.
pub fn swap_links(text: &str, urls: &[String], rel: &str, title: Option<&str>) -> LinkSwaps {
    let wanted: Vec<&str> = urls.iter().map(|url| url_key(url)).collect();
    let alias = alias_from_title(title, rel);
    let mut result = LinkSwaps::default();
    for link in scan(text) {
        if !wanted.contains(&url_key(&link.url)) {
            continue;
        }
        if !link.swappable {
            result.unswappable += 1;
            continue;
        }
        let separator = if link.in_table { "\\|" } else { "|" };
        let open = format!("[[{rel}{separator}");
        let label = link
            .label
            .as_deref()
            .filter(|label| !label.trim().is_empty());
        let (replacement, edits) = match label {
            Some(label) => {
                let label_end = link.start + 1 + label.len();
                (
                    format!("{open}{label}]]"),
                    vec![
                        TextEdit {
                            offset: link.start,
                            remove_len: 1,
                            insert_text: open,
                        },
                        TextEdit {
                            offset: label_end,
                            remove_len: link.end - label_end,
                            insert_text: "]]".to_string(),
                        },
                    ],
                )
            }
            None => {
                let replacement = format!("{open}{alias}]]");
                (
                    replacement.clone(),
                    vec![TextEdit {
                        offset: link.start,
                        remove_len: link.end - link.start,
                        insert_text: replacement,
                    }],
                )
            }
        };
        result.swaps.push(LinkSwap {
            start: link.start,
            end: link.end,
            replacement,
            edits,
        });
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const CASES: &str = include_str!("../../../lens-editor/shared/external-link-cases.json");
    const RULES: &str = include_str!("../../../lens-editor/shared/external-link-rules.json");

    fn cases(section: &str) -> Vec<Value> {
        let cases: Value = serde_json::from_str(CASES).expect("cases must be valid JSON");
        cases[section]
            .as_array()
            .unwrap_or_else(|| panic!("{section} must be an array"))
            .clone()
    }

    fn form_name(form: LinkForm) -> &'static str {
        match form {
            LinkForm::Inline => "inline",
            LinkForm::Autolink => "autolink",
            LinkForm::Bare => "bare",
        }
    }

    // Prevents: the scanner drifting from the TypeScript one, which runs the
    // same cases
    #[test]
    fn scan_cases() {
        let scan_cases = cases("scan");
        assert!(!scan_cases.is_empty());
        for case in scan_cases {
            let name = case["name"].as_str().unwrap();
            let text = case["text"].as_str().unwrap();
            let found: Vec<Value> = scan(text)
                .into_iter()
                .map(|link| {
                    serde_json::json!({
                        "url": link.url,
                        "form": form_name(link.form),
                        "label": link.label,
                        "in_table": link.in_table,
                        "swappable": link.swappable,
                    })
                })
                .collect();
            let expected: Vec<Value> = case["links"]
                .as_array()
                .unwrap()
                .iter()
                .map(|link| {
                    serde_json::json!({
                        "url": link["url"],
                        "form": link["form"],
                        "label": link["label"],
                        "in_table": link["in_table"].as_bool().unwrap_or(false),
                        "swappable": link["swappable"].as_bool().unwrap_or(true),
                    })
                })
                .collect();
            assert_eq!(found, expected, "{name}");
        }
    }

    // Prevents: classification drifting from the rules the editor offers on
    #[test]
    fn classify_cases() {
        let classify_cases = cases("classify");
        assert!(!classify_cases.is_empty());
        for case in classify_cases {
            let url = case["url"].as_str().unwrap();
            let kind = match classify(url) {
                Some(Kind::Article) => Some("article"),
                Some(Kind::Video) => Some("video"),
                None => None,
            };
            assert_eq!(kind, case["kind"].as_str(), "{url}");
        }
    }

    fn apply(text: &str, edits: &[&TextEdit]) -> String {
        let mut out = text.to_string();
        for edit in edits.iter().rev() {
            out.replace_range(
                edit.offset..edit.offset + edit.remove_len,
                &edit.insert_text,
            );
        }
        out
    }

    // Prevents: a swap writing something other than the plan's table, or the
    // small edits and the whole replacement disagreeing
    #[test]
    fn swap_cases() {
        let swap_cases = cases("swap");
        assert!(!swap_cases.is_empty());
        for case in swap_cases {
            let name = case["name"].as_str().unwrap();
            let text = case["text"].as_str().unwrap();
            let urls = vec![case["url"].as_str().unwrap().to_string()];
            let rel = case["rel"].as_str().unwrap();
            let title = case["title"].as_str();
            let expected = case["expected"].as_str().unwrap();

            let swapped = swap_links(text, &urls, rel, title);
            let edits: Vec<&TextEdit> = swapped.swaps.iter().flat_map(|swap| &swap.edits).collect();
            assert_eq!(apply(text, &edits), expected, "{name}: edits");

            let whole: Vec<TextEdit> = swapped
                .swaps
                .iter()
                .map(|swap| TextEdit {
                    offset: swap.start,
                    remove_len: swap.end - swap.start,
                    insert_text: swap.replacement.clone(),
                })
                .collect();
            assert_eq!(
                apply(text, &whole.iter().collect::<Vec<_>>()),
                expected,
                "{name}: replacements"
            );
        }
    }

    // Prevents: the Rust skip lists going stale against the JSON the editor
    // reads (the production build cannot read that file)
    #[test]
    fn skip_lists_match_the_shared_rules() {
        let rules: Value = serde_json::from_str(RULES).expect("rules must be valid JSON");
        let list = |key: &str| -> Vec<&str> {
            let mut list: Vec<&str> = rules[key]
                .as_array()
                .unwrap_or_else(|| panic!("{key} must be an array"))
                .iter()
                .map(|value| value.as_str().unwrap())
                .collect();
            list.sort_unstable();
            list
        };
        let sorted = |consts: &[&'static str]| -> Vec<&'static str> {
            let mut consts = consts.to_vec();
            consts.sort_unstable();
            consts
        };
        assert_eq!(sorted(&SKIP_HOSTS), list("skip_hosts"));
        assert_eq!(sorted(&SKIP_EXTENSIONS), list("skip_extensions"));
    }

    // Prevents: offsets counted in chars or UTF-16 units, which land in the
    // wrong place in the byte-indexed Y.Text
    #[test]
    fn offsets_are_utf8_bytes_of_the_whole_link() {
        let text = "é 🚀 [a](https://example.com/a) https://example.com/b.";
        let links = scan(text);
        assert_eq!(
            &text[links[0].start..links[0].end],
            "[a](https://example.com/a)"
        );
        assert_eq!(&text[links[1].start..links[1].end], "https://example.com/b");
    }

    // Prevents: a panic on a slice inside a multi-byte character
    #[test]
    fn non_ascii_text_around_every_kind_of_syntax_scans() {
        let text = "\\é ![é](é) [é](é \"é\") <é> `é` %%é%% {++é++} <!--é--> [[é]] [é]: é\n\
                    | é https://é.example/é，x https://é.example/é)é\n<https://é.example/é>";
        let urls: Vec<String> = scan(text).into_iter().map(|link| link.url).collect();
        assert_eq!(
            urls,
            [
                "https://é.example/é",
                "https://é.example/é)é",
                "https://é.example/é"
            ]
        );
    }

    // Prevents: a URL glued to a word reading as a link in one language only:
    // the TypeScript sees half of a character outside the BMP
    #[test]
    fn a_word_before_the_scheme_means_no_link() {
        assert!(scan("xhttps://example.com/a").is_empty());
        assert!(scan("éhttps://example.com/a").is_empty());
        assert_eq!(scan("🚀https://example.com/a").len(), 1);
    }

    // Prevents: whitespace that JavaScript and Rust define differently
    // splitting a URL in one and not the other
    #[test]
    fn whitespace_is_javascripts() {
        assert_eq!(
            scan("https://example.com/a\u{FEFF}b")[0].url,
            "https://example.com/a"
        );
        assert_eq!(
            scan("https://example.com/a\u{85}b")[0].url,
            "https://example.com/a\u{85}b"
        );
    }

    // Prevents: a stray tail of the file reading as a closed autolink
    #[test]
    fn a_very_long_autolink_is_a_bare_url() {
        let url = format!("https://example.com/{}", "a".repeat(3000));
        let links = scan(&format!("<{url}>"));
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].form, LinkForm::Bare);
        assert_eq!(links[0].url, url);
    }

    // Prevents: `POST /doc/frontmatters` handing the editor a block it can't parse
    #[test]
    fn frontmatter_block_is_the_raw_text_with_both_fences() {
        assert_eq!(frontmatter_of("---\na: 1\n---\nBody"), "---\na: 1\n---\n");
        assert_eq!(
            frontmatter_of("---\r\na: 1\r\n--- \r\nBody"),
            "---\r\na: 1\r\n--- \r\n"
        );
        assert_eq!(frontmatter_of("---\na: 1\n---"), "---\na: 1\n---");
        assert_eq!(frontmatter_of("Body"), "");
        assert_eq!(frontmatter_of("---\nnever closed"), "");
    }

    // Prevents: the offer's page rule drifting from the TypeScript one (these
    // four mirror its tests)
    #[test]
    fn page_offers_on_a_markdown_page_outside_lens_edu() {
        assert!(page_offers_source_links("Lens/Notes/a.md", "text"));
        assert!(page_offers_source_links("Lens/Notes/A.MD", "text"));
    }

    // Prevents: a swap in a lens, which breaks a working link for learners
    #[test]
    fn page_leaves_course_pages_other_file_types_and_the_trash_alone() {
        assert!(!page_offers_source_links("Lens Edu/Lenses/a.md", "text"));
        assert!(!page_offers_source_links("Lens/page.html", "text"));
        assert!(!page_offers_source_links("Lens/_trash/a.md", "text"));
    }

    // Prevents: a swap the next sync overwrites
    #[test]
    fn page_leaves_imported_and_synced_files_alone() {
        assert!(!page_offers_source_links(
            "Lens/a.md",
            "---\nsource_url: https://example.com/a\n---\nBody"
        ));
        assert!(!page_offers_source_links(
            "Lens/a.md",
            "---\nsynced_from:\n  source: google-doc\n---\nBody"
        ));
    }

    // Prevents: a page losing the offer over a line of body text
    #[test]
    fn page_rule_only_reads_the_frontmatter() {
        assert!(page_offers_source_links(
            "Lens/a.md",
            "---\ntitle: a\n---\nsource_url: nothing"
        ));
    }

    // Prevents: a skip that catches a host only ending alike, or misses a
    // subdomain
    #[test]
    fn classify_handles_hosts_as_the_rules_say() {
        // A subdomain of a skipped host, and hosts that only end alike.
        assert_eq!(classify("https://gist.github.com/a/b"), None);
        assert_eq!(classify("https://www.discord.gg/abc"), None);
        assert_eq!(classify("https://notdiscord.gg/abc"), Some(Kind::Article));
        assert_eq!(
            classify("https://youtube.com.example.org/a"),
            Some(Kind::Article)
        );
        // The editor's check is on the host as written.
        assert_eq!(
            classify("https://www.youtu.be/abcdefghijk"),
            Some(Kind::Article)
        );
        assert_eq!(classify("not a url"), None);
        assert_eq!(classify("https://example.com/?"), None);
        assert_eq!(classify("https://example.com/#top"), None);
    }

    // Prevents: an offer for a YouTube link the importer then refuses
    #[test]
    fn classify_takes_only_single_videos_the_importer_reads() {
        for url in [
            "https://www.youtube.com/watch?v=abcdefghijk&t=30",
            "https://m.youtube.com/watch?t=30&v=abcdefghijk",
            "https://www.youtube.com/live/abcdefghijk",
            "https://www.youtube.com/embed/abcdefghijk/",
            "https://www.youtube-nocookie.com/embed/abcdefghijk",
            "https://youtu.be/abcdefghijk?si=x",
            "https://www.youtube.com/shorts/abcdefghijk/extra",
            // `v=` counts wherever it is, as in the importer's reader.
            "https://www.youtube.com/playlist?list=PL1&v=abcdefghijk",
        ] {
            assert_eq!(classify(url), Some(Kind::Video), "{url}");
        }
        for url in [
            "https://www.youtube.com/",
            "https://www.youtube.com/watch",
            "https://www.youtube.com/watch?v=short",
            "https://www.youtube.com/results?search_query=a",
            "https://youtu.be/",
            "https://youtu.be/short",
        ] {
            assert_eq!(classify(url), None, "{url}");
        }
    }

    // Prevents: a swap reaching a different page of the same site
    #[test]
    fn urls_match_exactly_but_for_one_trailing_slash() {
        let text = "https://example.com/a/ https://example.com/a https://example.com/a// https://example.com/A";
        let swapped = swap_links(text, &["https://example.com/a".to_string()], "x", Some("T"));
        assert_eq!(swapped.swaps.len(), 2);
    }

    // Prevents: a spelling left behind when the page has more than one
    #[test]
    fn several_spellings_all_change() {
        let text = "[a](https://example.com/a?utm=1) and https://www.example.com/a";
        let urls = vec![
            "https://example.com/a?utm=1".to_string(),
            "https://www.example.com/a".to_string(),
        ];
        assert_eq!(swap_links(text, &urls, "x", Some("T")).swaps.len(), 2);
    }

    // Prevents: a link that had to stay reading as a link that was not there
    #[test]
    fn unswappable_links_are_counted() {
        let text =
            "[a|b](https://example.com/a) [![i](https://example.com/i.png)](https://example.com/a)";
        let swapped = swap_links(text, &["https://example.com/a".to_string()], "x", Some("T"));
        assert!(swapped.swaps.is_empty());
        assert_eq!(swapped.unswappable, 2);
    }

    // Prevents: `[[x|]]`, a link with nothing to show
    #[test]
    fn an_empty_title_falls_back_to_the_file_stem() {
        let urls = vec!["https://example.com/a".to_string()];
        for title in [None, Some(""), Some(" [|] ")] {
            let swapped = swap_links("https://example.com/a", &urls, "../articles/x", title);
            assert_eq!(swapped.swaps[0].replacement, "[[../articles/x|x]]");
        }
    }

    // Prevents: a blank label making a link that shows nothing
    #[test]
    fn a_blank_label_takes_the_title() {
        let urls = vec!["https://example.com/a".to_string()];
        let swapped = swap_links("[ ](https://example.com/a)", &urls, "x", Some("T"));
        assert_eq!(swapped.swaps[0].replacement, "[[x|T]]");
    }

    // Prevents: a direct swap rewriting the label, which would hand it to
    // whoever asked for the swap
    #[test]
    fn a_label_is_left_out_of_the_edits() {
        let text = "See [The paper](https://example.com/a) now";
        let urls = vec!["https://example.com/a".to_string()];
        let swap = &swap_links(text, &urls, "x", Some("T")).swaps[0];
        assert_eq!(swap.edits.len(), 2);
        assert!(swap
            .edits
            .iter()
            .all(|edit| !edit.insert_text.contains("The paper")));
        assert_eq!(&text[swap.edits[0].offset..swap.edits[0].offset + 1], "[");
        assert!(text[swap.edits[1].offset..].starts_with("](https"));
    }
}
