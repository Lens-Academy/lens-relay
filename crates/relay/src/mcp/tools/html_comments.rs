//! Comment threads on HTML pages, stored out of band in the content doc's
//! `comments_v0` map (the editor's shape, `lens-editor/src/components/
//! HtmlEditor/comments/thread-store.ts`):
//!
//! ```text
//! comments_v0: thread id → Y.Map {
//!   anchor: { v, kind: "text", quote, prefix, suffix, position: {start, end, total}, … }
//!   status: "open" | "resolved", createdAt, createdBy, resolvedAt?, resolvedBy?,
//!   seen?: { state, at }, originalQuote?,
//!   messages: Y.Map<id, { id, author, authorId?, ts, body, editedAt? }>
//! }
//! ```
//!
//! Anchors describe text in the rendered page, so the editor re-finds them
//! after edits and reflow. The relay only sees the source, so it works on the
//! page's *static* visible text ([`static_text`]): good enough to place an
//! agent's comment on text the HTML contains, and to warn when an edit removes
//! text an open thread quotes.

use serde_json::{json, Map as JsonMap, Value};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use yrs::{Any, Map, MapPrelim, MapRef, Out, ReadTxn, Transact, TransactionMut, WriteTxn};

use crate::server::Server;

pub const COMMENTS_MAP: &str = "comments_v0";
const CONTEXT_CHARS: usize = 32;
const MAX_BODY_CHARS: usize = 10_000;
const MAX_QUOTE_CHARS: usize = 2_000;

// ---------------------------------------------------------------------------
// Static visible text
// ---------------------------------------------------------------------------

/// Elements whose content is never page text. Each gets its own pattern:
/// the regex crate has no backreferences, and one alternation would close a
/// `<script>` at a `</select>` inside its htm template.
const HIDDEN_TAGS: &[&str] = &[
    "script", "style", "template", "noscript", "textarea", "select", "title", "iframe", "object",
    "head",
];
static HIDDEN_RES: LazyLock<Vec<regex::Regex>> = LazyLock::new(|| {
    HIDDEN_TAGS
        .iter()
        .map(|t| regex::Regex::new(&format!(r"(?is)<{t}\b[^>]*>.*?</{t}\s*>")).unwrap())
        .collect()
});
static MARKUP_NOISE_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?s)<!--.*?-->|<![^>]*>|<\?[^>]*>|\[\[@comment:[^\]\s]+\]\]").unwrap()
});
static INLINE_SCRIPT_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?is)<script\b[^>]*>\s*[^<\s]").unwrap());

/// The HTML without scripts, styles, comments and other content that never
/// shows as text. Scripts go first: they may contain anything.
fn drop_hidden(html: &str) -> String {
    let mut out = HIDDEN_RES[0].replace_all(html, " ").into_owned();
    out = MARKUP_NOISE_RE.replace_all(&out, " ").into_owned();
    for re in &HIDDEN_RES[1..] {
        out = re.replace_all(&out, " ").into_owned();
    }
    out
}

/// Typographic variants people type plainly: curly quotes, primes, dashes.
fn fold_char(c: char) -> char {
    match c {
        '\u{2018}' | '\u{2019}' | '\u{201a}' | '\u{2032}' | '`' | '\u{b4}' => '\'',
        '\u{201c}' | '\u{201d}' | '\u{201e}' | '\u{2033}' => '"',
        '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2212}' => '-',
        _ => c,
    }
}

/// Byte spans of `quote` in `text`: exact matches, or, when there are none,
/// matches that differ only in quote marks and dashes.
fn find_quote(text: &str, quote: &str) -> Vec<(usize, usize)> {
    let exact: Vec<(usize, usize)> = occurrences(text, quote)
        .into_iter()
        .map(|at| (at, at + quote.len()))
        .collect();
    if !exact.is_empty() {
        return exact;
    }
    let mut folded = String::with_capacity(text.len());
    let mut map = Vec::with_capacity(text.len() + 1); // folded byte -> original byte
    for (i, c) in text.char_indices() {
        let f = fold_char(c);
        for _ in 0..f.len_utf8() {
            map.push(i);
        }
        folded.push(f);
    }
    map.push(text.len());
    let needle: String = quote.chars().map(fold_char).collect();
    occurrences(&folded, &needle)
        .into_iter()
        .map(|f| (map[f], map[f + needle.len()]))
        .collect()
}

/// Does the source contain `quote` anywhere, script code included (text a
/// script puts on the page)?
fn in_source(html: &str, quote: &str) -> bool {
    let decoded = ENTITY_RE.replace_all(html, |caps: &regex::Captures| {
        decode_entity(&caps[1]).unwrap_or_else(|| caps[0].to_string())
    });
    !find_quote(&normalize(&decoded), quote).is_empty()
}

static TAG_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?s)</?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>").unwrap());
static ENTITY_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);").unwrap()
});

/// Tags that separate text visually (mirrors the editor's text index).
const BLOCK_TAGS: &[&str] = &[
    "address",
    "article",
    "aside",
    "blockquote",
    "body",
    "br",
    "caption",
    "dd",
    "details",
    "dialog",
    "div",
    "dl",
    "dt",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hgroup",
    "hr",
    "li",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "summary",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "ul",
    "legend",
    "button",
    "label",
    "svg",
    "img",
    "canvas",
    "video",
    "audio",
    "input",
];

fn decode_entity(name: &str) -> Option<String> {
    if let Some(num) = name.strip_prefix('#') {
        let code = if let Some(hex) = num.strip_prefix(['x', 'X']) {
            u32::from_str_radix(hex, 16).ok()?
        } else {
            num.parse().ok()?
        };
        return char::from_u32(code).map(String::from);
    }
    let s = match name {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => " ",
        "mdash" => "—",
        "ndash" => "–",
        "hellip" => "…",
        "lsquo" => "‘",
        "rsquo" => "’",
        "ldquo" => "“",
        "rdquo" => "”",
        "copy" => "©",
        "reg" => "®",
        "euro" => "€",
        "pound" => "£",
        "times" => "×",
        "middot" => "·",
        "bull" => "•",
        "rarr" => "→",
        "larr" => "←",
        "uarr" => "↑",
        "darr" => "↓",
        "harr" => "↔",
        "trade" => "™",
        "deg" => "°",
        "plusmn" => "±",
        "minus" => "−",
        "le" => "≤",
        "ge" => "≥",
        "ne" => "≠",
        "asymp" => "≈",
        "infin" => "∞",
        "frac12" => "½",
        "frac14" => "¼",
        "frac34" => "¾",
        "sup2" => "²",
        "sup3" => "³",
        "micro" => "µ",
        "para" => "¶",
        "sect" => "§",
        "laquo" => "«",
        "raquo" => "»",
        "sbquo" => "‚",
        "bdquo" => "„",
        "prime" => "′",
        "Prime" => "″",
        "yen" => "¥",
        "cent" => "¢",
        "iexcl" => "¡",
        "iquest" => "¿",
        "thinsp" => "\u{2009}",
        "ensp" => "\u{2002}",
        "emsp" => "\u{2003}",
        "zwj" | "zwnj" | "shy" => "",
        _ => return accented(name),
    };
    Some(s.to_string())
}

/// Latin letters with an accent, e.g. `eacute`, `Uuml`, `ccedil`, `aring`.
fn accented(name: &str) -> Option<String> {
    let (letter, mark) = name.split_at(name.char_indices().nth(1)?.0);
    let base = letter.chars().next()?;
    let table: &[(&str, &str, &str)] = &[
        ("acute", "aeiouyAEIOUY", "áéíóúýÁÉÍÓÚÝ"),
        ("grave", "aeiouAEIOU", "àèìòùÀÈÌÒÙ"),
        ("circ", "aeiouAEIOU", "âêîôûÂÊÎÔÛ"),
        ("uml", "aeiouyAEIOUY", "äëïöüÿÄËÏÖÜŸ"),
        ("tilde", "anoANO", "ãñõÃÑÕ"),
        ("cedil", "cC", "çÇ"),
        ("ring", "aA", "åÅ"),
        ("slash", "oO", "øØ"),
    ];
    for (suffix, bases, accents) in table {
        if mark == *suffix {
            let i = bases.chars().position(|c| c == base)?;
            return accents.chars().nth(i).map(String::from);
        }
    }
    match name {
        "szlig" => Some("ß".into()),
        "aelig" => Some("æ".into()),
        "AElig" => Some("Æ".into()),
        "oelig" => Some("œ".into()),
        "OElig" => Some("Œ".into()),
        _ => None,
    }
}

/// Collapse whitespace runs to one space and drop zero-width characters, as
/// the editor's `normalizeText` does.
pub fn normalize(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut pending_space = false;
    for ch in input.chars() {
        if matches!(
            ch,
            '\u{200b}' | '\u{200c}' | '\u{200d}' | '\u{feff}' | '\u{ad}'
        ) {
            continue;
        }
        if ch.is_whitespace() {
            pending_space = !out.is_empty();
            continue;
        }
        if pending_space {
            out.push(' ');
        }
        pending_space = false;
        out.push(ch);
    }
    out
}

/// The text a reader would see in the page's HTML before any script runs.
pub fn static_text(html: &str) -> String {
    let without_hidden = drop_hidden(html);
    let without_tags = TAG_RE.replace_all(&without_hidden, |caps: &regex::Captures| {
        let tag = caps[1].to_ascii_lowercase();
        if BLOCK_TAGS.contains(&tag.as_str()) {
            " ".to_string()
        } else {
            String::new()
        }
    });
    let decoded = ENTITY_RE.replace_all(&without_tags, |caps: &regex::Captures| {
        decode_entity(&caps[1]).unwrap_or_else(|| caps[0].to_string())
    });
    normalize(&decoded)
}

static HEADING_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?is)<h[1-6]\b[^>]*>(.*?)</h[1-6]\s*>").unwrap());

/// Text of the last heading before byte offset `at` of the page's static
/// text, located by finding each heading's text in order. None when the
/// target is itself inside a heading.
fn section_before(html: &str, text: &str, at: usize) -> Option<String> {
    let visible = drop_hidden(html);
    let mut from = 0;
    let mut found = None;
    for caps in HEADING_RE.captures_iter(&visible) {
        let heading = static_text(&caps[1]);
        if heading.is_empty() {
            continue;
        }
        let Some(pos) = text[from..].find(&heading).map(|p| from + p) else {
            continue;
        };
        if pos > at {
            break;
        }
        if at < pos + heading.len() {
            return None;
        }
        found = Some(heading.clone());
        from = pos + heading.len();
    }
    found.map(|h| clip(&h, 120))
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Byte offsets of every occurrence of `needle` (overlapping).
fn occurrences(text: &str, needle: &str) -> Vec<usize> {
    let mut out = Vec::new();
    if needle.is_empty() {
        return out;
    }
    let mut from = 0;
    while let Some(at) = text[from..].find(needle) {
        out.push(from + at);
        from += at + text[from + at..].chars().next().map_or(1, |c| c.len_utf8());
        if out.len() >= 1000 {
            break;
        }
    }
    out
}

fn slice_chars_before(text: &str, end: usize, n: usize) -> &str {
    let start = text[..end]
        .char_indices()
        .rev()
        .nth(n.saturating_sub(1))
        .map_or(0, |(i, _)| i);
    &text[start..end]
}

fn slice_chars_after(text: &str, start: usize, n: usize) -> &str {
    let end = text[start..]
        .char_indices()
        .nth(n)
        .map_or(text.len(), |(i, _)| start + i);
    &text[start..end]
}

/// Where a quote was placed: the anchor, a snippet showing the spot, and a
/// note for the agent.
#[derive(Debug)]
pub struct Placement {
    pub anchor: Value,
    pub snippet: String,
    pub note: Option<String>,
}

fn times(n: usize) -> &'static str {
    if n == 1 {
        "time"
    } else {
        "times"
    }
}

/// A text anchor for `quote` in the page. The quote is read as a person sees
/// it: tags and entities an agent copied from the source are removed first,
/// and straight quotes match curly ones. `occurrence` (1-based) picks among
/// repeats.
pub fn anchor_for_quote(
    html: &str,
    quote: &str,
    occurrence: Option<usize>,
) -> Result<Placement, String> {
    let quote = static_text(quote);
    if quote.is_empty() {
        return Err(
            "Error: quote is empty. Quote the exact visible text the comment is about.".into(),
        );
    }
    if quote.chars().count() > MAX_QUOTE_CHARS {
        return Err(format!(
            "Error: quote is longer than {} characters; quote a shorter passage.",
            MAX_QUOTE_CHARS
        ));
    }
    let text = static_text(html);
    let found = find_quote(&text, &quote);
    let total = utf16_len(&text);
    if found.is_empty() {
        let script_text = in_source(html, &quote);
        if !script_text && !INLINE_SCRIPT_RE.is_match(html) {
            return Err(format!(
                "Error: \"{}\" is not on the page. Quote the text exactly as a reader sees it (the words between the tags in `read`, without markup); straight and curly quotes both match.",
                clip(&quote, 80)
            ));
        }
        // Text a script puts on the page (React, htm, d3…) is placed by the
        // editor once the page renders.
        let anchor = json!({
            "v": 1, "kind": "text", "quote": quote, "prefix": "", "suffix": "",
            "position": { "start": 0, "end": utf16_len(&quote), "total": 0 },
        });
        let note = if script_text {
            "The quote is only inside the page's script, so the editor places it once the page renders it."
        } else {
            "The quote is not in the page source. That is fine only for text a script computes (e.g. \"Week 3\" from `Week ${n}`); otherwise fix the quote, or the comment shows as not found."
        };
        return Ok(Placement {
            anchor,
            snippet: format!("\"{}\"", clip(&quote, 120)),
            note: Some(note.into()),
        });
    }
    let index = match (found.len(), occurrence) {
        (1, None) => 0,
        (n, Some(k)) if k >= 1 && k <= n => k - 1,
        (n, Some(k)) => {
            return Err(format!(
                "Error: occurrence {} is out of range; the quote appears {} {}.",
                k,
                n,
                times(n)
            ))
        }
        (n, None) => {
            let samples: Vec<String> = found
                .iter()
                .take(5)
                .enumerate()
                .map(|(i, &(at, end))| format!("  {}: {}", i + 1, snippet(&text, at, end)))
                .collect();
            return Err(format!(
                "Error: the quote appears {} times on the page. Quote a longer, unique passage, or pass `occurrence` (1-based):\n{}",
                n,
                samples.join("\n")
            ));
        }
    };
    let (at, end) = found[index];
    let quote = &text[at..end];
    let start16 = utf16_len(&text[..at]);
    let mut anchor = json!({
        "v": 1,
        "kind": "text",
        "quote": quote,
        "prefix": slice_chars_before(&text, at, CONTEXT_CHARS),
        "suffix": slice_chars_after(&text, end, CONTEXT_CHARS),
        "position": { "start": start16, "end": start16 + utf16_len(quote), "total": total },
    });
    let section = section_before(html, &text, at);
    if let Some(section) = &section {
        anchor["section"] = json!(section);
    }
    let mut placed = snippet(&text, at, end);
    if let Some(section) = section {
        placed.push_str(&format!(" (under heading \"{}\")", section));
    }
    Ok(Placement {
        anchor,
        snippet: placed,
        note: None,
    })
}

fn snippet(text: &str, at: usize, end: usize) -> String {
    format!(
        "…{}[{}]{}…",
        slice_chars_before(text, at, 30),
        clip(&text[at..end], 120),
        slice_chars_after(text, end, 30)
    )
}

// ---------------------------------------------------------------------------
// Y.Map <-> JSON
// ---------------------------------------------------------------------------

fn any_to_json(any: &Any) -> Value {
    match any {
        Any::Null | Any::Undefined => Value::Null,
        Any::Bool(b) => Value::Bool(*b),
        Any::Number(n) => serde_json::Number::from_f64(*n).map_or(Value::Null, Value::Number),
        Any::BigInt(n) => Value::Number((*n).into()),
        Any::String(s) => Value::String(s.to_string()),
        Any::Buffer(_) => Value::Null,
        Any::Array(items) => Value::Array(items.iter().map(any_to_json).collect()),
        Any::Map(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), any_to_json(v)))
                .collect::<JsonMap<_, _>>(),
        ),
    }
}

fn json_to_any(value: &Value) -> Any {
    match value {
        Value::Null => Any::Null,
        Value::Bool(b) => Any::Bool(*b),
        Value::Number(n) => Any::Number(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => Any::String(s.as_str().into()),
        Value::Array(items) => Any::Array(items.iter().map(json_to_any).collect::<Vec<_>>().into()),
        Value::Object(map) => Any::Map(Arc::new(
            map.iter()
                .map(|(k, v)| (k.clone(), json_to_any(v)))
                .collect::<HashMap<_, _>>(),
        )),
    }
}

fn out_json<T: ReadTxn>(txn: &T, map: &MapRef, key: &str) -> Value {
    match map.get(txn, key) {
        Some(Out::Any(any)) => any_to_json(&any),
        _ => Value::Null,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    pub id: String,
    pub author: String,
    pub author_id: Option<String>,
    pub ts: f64,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Thread {
    pub id: String,
    pub status: String,
    pub created_at: f64,
    pub resolved_by: Option<String>,
    pub anchor: Value,
    pub seen_state: Option<String>,
    pub original_quote: Option<String>,
    pub messages: Vec<Message>,
}

impl Thread {
    pub fn is_open(&self) -> bool {
        self.status != "resolved"
    }

    pub fn quote(&self) -> Option<&str> {
        self.anchor.get("quote").and_then(Value::as_str)
    }

    fn start(&self) -> f64 {
        self.anchor
            .pointer("/position/start")
            .and_then(Value::as_f64)
            .unwrap_or(f64::MAX)
    }
}

fn read_message(value: &Value) -> Option<Message> {
    Some(Message {
        id: value.get("id")?.as_str()?.to_string(),
        author: value
            .get("author")
            .and_then(Value::as_str)
            .unwrap_or("Unknown")
            .to_string(),
        author_id: value
            .get("authorId")
            .and_then(Value::as_str)
            .map(String::from),
        ts: value.get("ts").and_then(Value::as_f64).unwrap_or(0.0),
        body: value.get("body")?.as_str()?.to_string(),
    })
}

pub fn read_threads<T: ReadTxn>(txn: &T) -> Vec<Thread> {
    let Some(map) = txn.get_map(COMMENTS_MAP) else {
        return Vec::new();
    };
    let mut threads: Vec<Thread> = map
        .iter(txn)
        .filter_map(|(id, value)| {
            let Out::YMap(thread) = value else {
                return None;
            };
            let Some(Out::YMap(messages_map)) = thread.get(txn, "messages") else {
                return None;
            };
            let mut messages: Vec<Message> = messages_map
                .iter(txn)
                .filter_map(|(_, m)| match m {
                    Out::Any(any) => read_message(&any_to_json(&any)),
                    _ => None,
                })
                .collect();
            if messages.is_empty() {
                return None;
            }
            messages.sort_by(|a, b| a.ts.total_cmp(&b.ts).then_with(|| a.id.cmp(&b.id)));
            let str_field = |key: &str| out_json(txn, &thread, key).as_str().map(String::from);
            Some(Thread {
                id: id.to_string(),
                status: str_field("status").unwrap_or_else(|| "open".into()),
                created_at: out_json(txn, &thread, "createdAt")
                    .as_f64()
                    .unwrap_or(messages[0].ts),
                resolved_by: str_field("resolvedBy"),
                anchor: out_json(txn, &thread, "anchor"),
                seen_state: out_json(txn, &thread, "seen")
                    .get("state")
                    .and_then(Value::as_str)
                    .map(String::from),
                original_quote: str_field("originalQuote"),
                messages,
            })
        })
        .collect();
    threads.sort_by(|a, b| {
        a.start()
            .total_cmp(&b.start())
            .then_with(|| a.created_at.total_cmp(&b.created_at))
    });
    threads
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

fn clip(text: &str, max_chars: usize) -> String {
    match text.char_indices().nth(max_chars) {
        Some((i, _)) => text[..i].to_string(),
        None => text.to_string(),
    }
}

fn message_any(author: &str, author_id: &str, body: &str, ts: f64) -> (String, Any) {
    let id = uuid::Uuid::new_v4().to_string();
    let value = json!({
        "id": id, "author": author, "authorId": author_id, "ts": ts, "body": clip(body, MAX_BODY_CHARS),
    });
    (id, json_to_any(&value))
}

fn thread_map(txn: &TransactionMut, thread_id: &str) -> Result<MapRef, String> {
    let map = txn
        .get_map(COMMENTS_MAP)
        .ok_or_else(|| "Error: this page has no comments yet.".to_string())?;
    match map.get(txn, thread_id) {
        Some(Out::YMap(thread)) => Ok(thread),
        _ => Err(format!(
            "Error: no comment thread with id {}. The `read` output lists the page's threads.",
            thread_id
        )),
    }
}

pub fn create_thread(
    txn: &mut TransactionMut,
    anchor: &Value,
    author: &str,
    author_id: &str,
    body: &str,
) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let ts = now_ms();
    let (message_id, message) = message_any(author, author_id, body, ts);
    let map = txn.get_or_insert_map(COMMENTS_MAP);
    let prelim = MapPrelim::from([
        ("anchor".to_string(), yrs::In::Any(json_to_any(anchor))),
        ("status".to_string(), yrs::In::Any(Any::from("open"))),
        ("createdAt".to_string(), yrs::In::Any(Any::Number(ts))),
        ("createdBy".to_string(), yrs::In::Any(Any::from(author))),
        (
            "messages".to_string(),
            yrs::In::Map(MapPrelim::from([(message_id, yrs::In::Any(message))])),
        ),
    ]);
    map.insert(txn, id.as_str(), prelim);
    id
}

pub fn add_message(
    txn: &mut TransactionMut,
    thread_id: &str,
    author: &str,
    author_id: &str,
    body: &str,
) -> Result<(), String> {
    let thread = thread_map(txn, thread_id)?;
    let Some(Out::YMap(messages)) = thread.get(txn, "messages") else {
        return Err(format!("Error: thread {} is malformed.", thread_id));
    };
    // Messages sort by time; keep a reply after everything before it even
    // within the same millisecond.
    let latest = messages
        .iter(txn)
        .filter_map(|(_, m)| match m {
            Out::Any(any) => any_to_json(&any).get("ts").and_then(Value::as_f64),
            _ => None,
        })
        .fold(0.0, f64::max);
    let (message_id, message) = message_any(author, author_id, body, now_ms().max(latest + 1.0));
    messages.insert(txn, message_id, message);
    // A reply reopens a resolved thread, as in the editor.
    if matches!(thread.get(txn, "status"), Some(Out::Any(Any::String(s))) if &*s == "resolved") {
        set_status(txn, thread_id, "open", author)?;
    }
    Ok(())
}

pub fn set_status(
    txn: &mut TransactionMut,
    thread_id: &str,
    status: &str,
    by: &str,
) -> Result<(), String> {
    let thread = thread_map(txn, thread_id)?;
    thread.insert(txn, "status", Any::from(status));
    if status == "resolved" {
        thread.insert(txn, "resolvedAt", Any::Number(now_ms()));
        thread.insert(txn, "resolvedBy", Any::from(by));
    } else {
        thread.remove(txn, "resolvedAt");
        thread.remove(txn, "resolvedBy");
    }
    Ok(())
}

pub fn set_anchor(txn: &mut TransactionMut, thread_id: &str, anchor: &Value) -> Result<(), String> {
    let thread = thread_map(txn, thread_id)?;
    let previous = out_json(txn, &thread, "anchor");
    if let Some(old) = previous.get("quote").and_then(Value::as_str) {
        let has_original = matches!(
            thread.get(txn, "originalQuote"),
            Some(Out::Any(Any::String(_)))
        );
        if !has_original && anchor.get("quote").and_then(Value::as_str) != Some(old) {
            thread.insert(txn, "originalQuote", Any::from(old));
        }
    }
    thread.insert(txn, "anchor", json_to_any(anchor));
    thread.remove(txn, "seen");
    Ok(())
}

// ---------------------------------------------------------------------------
// Rendering for agents
// ---------------------------------------------------------------------------

fn format_ts(ms: f64) -> String {
    let secs = (ms / 1000.0) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02} UTC",
        y,
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60
    )
}

fn target_of(thread: &Thread) -> String {
    match thread.anchor.get("kind").and_then(Value::as_str) {
        Some("element") => {
            let tag = thread
                .anchor
                .get("tag")
                .and_then(Value::as_str)
                .unwrap_or("element");
            match thread.anchor.get("label").and_then(Value::as_str) {
                Some(label) if !label.is_empty() => format!("<{}> \"{}\"", tag, clip(label, 80)),
                _ => format!("<{}>", tag),
            }
        }
        _ => match thread.quote() {
            Some(q) => format!("\"{}\"", clip(q, 160)),
            None => "an unknown spot (migrated comment)".into(),
        },
    }
}

/// One line of plain text: names and ids come from other clients (and, for
/// migrated comments, from the page source), so they must not be able to
/// fake lines of the listing.
fn one_line(text: &str, max_chars: usize) -> String {
    clip(&text.replace(|c: char| c.is_control(), " "), max_chars)
}

fn seen_label(state: Option<&str>) -> Option<&'static str> {
    match state {
        Some("orphaned") => Some("the editor could NOT FIND it on the page"),
        Some("guessed") => Some("the editor could not find it exactly (it may have moved)"),
        _ => None,
    }
}

/// Whether a thread's quoted text is still anywhere in the page source.
fn quote_present(html: &str, text: &str, quote: &str) -> bool {
    let quote = normalize(quote);
    quote.is_empty() || !find_quote(text, &quote).is_empty() || in_source(html, &quote)
}

fn render_thread(out: &mut String, thread: &Thread, html: Option<(&str, &str)>) {
    let mut line = format!(
        "\n[{}] on {}",
        one_line(&thread.id, 80),
        one_line(&target_of(thread), 200)
    );
    if let Some(section) = thread.anchor.get("section").and_then(Value::as_str) {
        line.push_str(&format!(" (under heading \"{}\")", one_line(section, 60)));
    }
    let missing = match (html, thread.quote()) {
        (Some((source, text)), Some(quote)) => !quote_present(source, text, quote),
        _ => false,
    };
    if missing {
        line.push_str(
            " · its text is NOT in the page source any more (reanchor it, or resolve it)",
        );
    } else if let Some(label) = seen_label(thread.seen_state.as_deref()) {
        line.push_str(&format!(" · {}", label));
    }
    out.push_str(&line);
    for message in &thread.messages {
        out.push_str(&format!(
            "\n  {} ({}): {}",
            one_line(&message.author, 80),
            format_ts(message.ts),
            clip(&message.body, 1000).replace('\n', "\n    ")
        ));
    }
}

/// The page's threads for `read` (open ones) or `list` (with
/// `include_resolved`), or None when it has none. `html` (the page source)
/// lets the listing flag threads whose text is gone.
pub fn render_threads(
    threads: &[Thread],
    html: Option<&str>,
    include_resolved: bool,
) -> Option<String> {
    if threads.is_empty() {
        return None;
    }
    let text = html.map(static_text);
    let page = html.zip(text.as_deref());
    let open: Vec<&Thread> = threads.iter().filter(|t| t.is_open()).collect();
    let resolved: Vec<&Thread> = threads.iter().filter(|t| !t.is_open()).collect();
    let mut out = format!(
        "--- Comments: {} open, {} resolved (they live beside the page, not in its source; use the comments tool to reply, resolve or re-anchor{}) ---",
        open.len(),
        resolved.len(),
        if include_resolved || resolved.is_empty() { "" } else { "; its list action shows resolved ones" }
    );
    for thread in open {
        render_thread(&mut out, thread, page);
    }
    if include_resolved && !resolved.is_empty() {
        out.push_str("\n--- Resolved ---");
        for thread in resolved {
            out.push_str(&format!(
                "\n[{}] on {} · resolved by {}",
                one_line(&thread.id, 80),
                one_line(&target_of(thread), 200),
                one_line(thread.resolved_by.as_deref().unwrap_or("someone"), 80)
            ));
        }
    }
    Some(out)
}

/// Open threads whose quote the edit removed from the page's static text.
pub fn removed_quote_notes(
    before_html: &str,
    after_html: &str,
    threads: &[Thread],
) -> Option<String> {
    let open: Vec<&Thread> = threads
        .iter()
        .filter(|t| t.is_open() && t.quote().is_some())
        .collect();
    if open.is_empty() {
        return None;
    }
    // Text a script renders counts too: it is in the source, only not as markup.
    let before = static_text(before_html);
    let after = static_text(after_html);
    let lost: Vec<String> = open
        .iter()
        .filter(|t| {
            let quote = normalize(t.quote().unwrap_or_default());
            !quote.is_empty()
                && quote_present(before_html, &before, &quote)
                && !quote_present(after_html, &after, &quote)
        })
        .map(|t| {
            format!(
                "  [{}] {}",
                one_line(&t.id, 80),
                one_line(&target_of(t), 200)
            )
        })
        .collect();
    if lost.is_empty() {
        return None;
    }
    Some(format!(
        "\n\nComments: this edit removed text that {} open comment thread{} point{} at:\n{}\nIf you moved or reworded that text, call comments with action \"reanchor\" (thread_id, quote) so the comment follows it; if the edit addresses the comment, reply and resolve it.",
        lost.len(),
        if lost.len() == 1 { "" } else { "s" },
        if lost.len() == 1 { "s" } else { "" },
        lost.join("\n")
    ))
}

// ---------------------------------------------------------------------------
// The `comments` MCP tool
// ---------------------------------------------------------------------------

fn arg<'a>(arguments: &'a Value, key: &str) -> Option<&'a str> {
    arguments.get(key).and_then(Value::as_str)
}

fn required<'a>(arguments: &'a Value, key: &str, action: &str) -> Result<&'a str, String> {
    arg(arguments, key)
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| format!("Error: action \"{}\" needs `{}`.", action, key))
}

pub async fn execute(
    server: &Arc<Server>,
    session_id: &str,
    arguments: &Value,
) -> Result<String, String> {
    let file_path = arg(arguments, "file_path").ok_or("Missing required parameter: file_path")?;
    let action = arg(arguments, "action").ok_or("Missing required parameter: action")?;
    if !file_path.to_ascii_lowercase().ends_with(".html") {
        return Err(format!(
            "Error: {} is not an HTML page. The comments tool is for .html pages; in Markdown, comments are CriticMarkup ({{>>…<<}}) written with edit.",
            file_path
        ));
    }
    let doc_info = server
        .doc_resolver()
        .resolve_path(file_path)
        .ok_or_else(|| format!("Error: Document not found: {}", file_path))?;
    let (author, author_id) = {
        let session = server
            .mcp_sessions
            .get_session(session_id)
            .ok_or_else(|| "Error: Session not found".to_string())?;
        (
            session.author_name.clone(),
            format!("ai:{}", session.ai_actor),
        )
    };
    server
        .ensure_doc_loaded(&doc_info.doc_id)
        .await
        .map_err(|e| format!("Error: Failed to load document {}: {}", file_path, e))?;

    let occurrence = match arguments.get("occurrence") {
        None | Some(Value::Null) => None,
        Some(v) => match v.as_f64() {
            Some(n) if n >= 1.0 && n.fract() == 0.0 => Some(n as usize),
            _ => return Err("Error: occurrence must be a whole number, 1 or more.".into()),
        },
    };

    let (result, wrote) = {
        let awareness = server
            .docs()
            .get(&doc_info.doc_id)
            .map(|doc_ref| doc_ref.awareness())
            .ok_or_else(|| format!("Error: Document data not loaded: {}", file_path))?;
        let guard = awareness.write().unwrap_or_else(|e| e.into_inner());
        let source = {
            let txn = guard.doc.transact();
            match txn.get_text("contents") {
                Some(text) => yrs::GetString::get_string(&text, &txn),
                None => String::new(),
            }
        };
        match action {
            "list" => {
                let txn = guard.doc.transact();
                let threads = read_threads(&txn);
                let listing = render_threads(&threads, Some(&source), true)
                    .unwrap_or_else(|| format!("{} has no comments.", file_path));
                (listing, false)
            }
            "add" => {
                let quote = required(arguments, "quote", action)?;
                let body = required(arguments, "body", action)?;
                let placed = anchor_for_quote(&source, quote, occurrence)?;
                let mut txn = guard.doc.transact_mut();
                let id = create_thread(&mut txn, &placed.anchor, &author, &author_id, body);
                let mut text = format!(
                    "Added comment thread {} in {} on {}.",
                    id, file_path, placed.snippet
                );
                if let Some(note) = placed.note {
                    text.push_str(&format!("\nNote: {}", note));
                }
                (text, true)
            }
            "reply" => {
                let thread_id = required(arguments, "thread_id", action)?;
                let body = required(arguments, "body", action)?;
                let mut txn = guard.doc.transact_mut();
                add_message(&mut txn, thread_id, &author, &author_id, body)?;
                (format!("Replied to thread {}.", thread_id), true)
            }
            "resolve" | "reopen" => {
                let thread_id = required(arguments, "thread_id", action)?;
                let status = if action == "resolve" {
                    "resolved"
                } else {
                    "open"
                };
                let current = read_threads(&guard.doc.transact())
                    .into_iter()
                    .find(|t| t.id == thread_id)
                    .map(|t| t.status);
                if current.as_deref() == Some(status) {
                    (
                        format!(
                            "Thread {} is already {}; nothing changed.",
                            thread_id, status
                        ),
                        false,
                    )
                } else {
                    let mut txn = guard.doc.transact_mut();
                    if let Some(body) = arg(arguments, "body").filter(|b| !b.trim().is_empty()) {
                        add_message(&mut txn, thread_id, &author, &author_id, body)?;
                    }
                    set_status(&mut txn, thread_id, status, &author)?;
                    (format!("Thread {} is now {}.", thread_id, status), true)
                }
            }
            "reanchor" => {
                let thread_id = required(arguments, "thread_id", action)?;
                let quote = required(arguments, "quote", action)?;
                let placed = anchor_for_quote(&source, quote, occurrence)?;
                let mut txn = guard.doc.transact_mut();
                set_anchor(&mut txn, thread_id, &placed.anchor)?;
                let mut text = format!("Thread {} now points at {}.", thread_id, placed.snippet);
                if let Some(note) = placed.note {
                    text.push_str(&format!("\nNote: {}", note));
                }
                (text, true)
            }
            other => {
                return Err(format!(
                "Error: unknown action \"{}\". Use list, add, reply, resolve, reopen or reanchor.",
                other
            ))
            }
        }
    };

    if wrote {
        // Clone the store handle out so no map guard is held across the await.
        let sync_kv = server
            .docs()
            .get(&doc_info.doc_id)
            .map(|doc_ref| doc_ref.sync_kv())
            .ok_or_else(|| format!("Error: Document data not loaded: {}", file_path))?;
        if let Err(e) = sync_kv.persist().await {
            tracing::error!(
                "Failed to persist comments for {}: {:?}",
                doc_info.doc_id,
                e
            );
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::Doc;

    #[test]
    fn static_text_reads_like_a_person_sees_it() {
        let html = "<!doctype html><html><head><title>T</title><style>p{}</style></head><body>\
            <h1>Title</h1>\n<ul><li>One</li><li>Two &amp; <b>bold</b></li></ul><!-- note -->\
            <p>A&nbsp;b &mdash; c</p><script>var x = '<p>no</p>';</script></body></html>";
        assert_eq!(static_text(html), "Title One Two & bold A b — c");
    }

    #[test]
    fn anchors_a_unique_quote_with_context() {
        let html = "<h2>Pricing</h2><p>The basic plan costs ten euros a month.</p>";
        let Placement {
            anchor,
            note,
            snippet,
        } = anchor_for_quote(html, "ten  euros", None).unwrap();
        assert!(note.is_none());
        assert!(
            snippet.contains("[ten euros]") && snippet.ends_with("(under heading \"Pricing\")"),
            "{}",
            snippet
        );
        assert_eq!(anchor["quote"], "ten euros");
        assert_eq!(anchor["prefix"], "Pricing The basic plan costs ");
        assert_eq!(anchor["suffix"], " a month.");
        assert_eq!(anchor["position"]["start"], 29);
    }

    #[test]
    fn repeated_quotes_need_an_occurrence() {
        let html = "<p>Read more</p><p>Other</p><p>Read more</p>";
        let err = anchor_for_quote(html, "Read more", None).unwrap_err();
        assert!(err.contains("appears 2 times"), "{}", err);
        let anchor = anchor_for_quote(html, "Read more", Some(2)).unwrap().anchor;
        assert_eq!(anchor["prefix"], "Read more Other ");
        assert!(anchor_for_quote(html, "Read more", Some(3)).is_err());
    }

    #[test]
    fn script_rendered_quotes_are_accepted_with_a_note() {
        let page = "<div id=root></div><script type=\"module\">render(html`<p>Rendered by React</p>`)</script>";
        let placed = anchor_for_quote(page, "Rendered by React", None).unwrap();
        assert_eq!(placed.anchor["position"]["total"], 0);
        assert!(placed
            .note
            .unwrap()
            .contains("only inside the page's script"));
        let computed = anchor_for_quote(page, "Week 3", None).unwrap();
        assert!(computed.note.unwrap().contains("a script computes"));
    }

    #[test]
    fn quotes_are_read_as_a_person_sees_them() {
        let page = "<p>Grok 3’s run used <strong>linear</strong> scale &amp; more.</p>";
        // Tags and entities copied from the source, straight for curly quotes.
        let placed = anchor_for_quote(
            page,
            "Grok 3's run used <strong>linear</strong> scale &amp; more",
            None,
        )
        .unwrap();
        assert_eq!(
            placed.anchor["quote"],
            "Grok 3’s run used linear scale & more"
        );
        // A static page refuses text that is not on it.
        let err = anchor_for_quote(page, "nonexistent phrase xyz", None)
            .map(|_| ())
            .unwrap_err();
        assert!(err.contains("is not on the page"), "{}", err);
    }

    #[test]
    fn template_text_inside_scripts_is_not_static_text() {
        let page = "<head><title>T</title><style>p{}</style></head><body><h1>Real</h1><script type=\"module\">\
            html`<select><option>A</option></select><h2>Week ${g.week}</h2>`</script><p>After</p></body>";
        assert_eq!(static_text(page), "Real After");
        let placed = anchor_for_quote(page, "After", None).unwrap();
        assert_eq!(placed.anchor["section"], "Real");
        // A heading is not "under" itself.
        assert!(anchor_for_quote(page, "Real", None)
            .unwrap()
            .anchor
            .get("section")
            .is_none());
    }

    #[test]
    fn threads_round_trip_through_the_doc() {
        let doc = Doc::new();
        let anchor = anchor_for_quote("<p>Hello brave new world</p>", "brave new", None)
            .unwrap()
            .anchor;
        let id = {
            let mut txn = doc.transact_mut();
            let id = create_thread(&mut txn, &anchor, "Luc's AI", "ai:x", "Is this right?");
            add_message(&mut txn, &id, "Ann", "a1", "Yes.").unwrap();
            set_status(&mut txn, &id, "resolved", "Ann").unwrap();
            id
        };
        let threads = read_threads(&doc.transact());
        assert_eq!(threads.len(), 1);
        let t = &threads[0];
        assert_eq!(t.id, id);
        assert_eq!(t.status, "resolved");
        assert_eq!(t.resolved_by.as_deref(), Some("Ann"));
        assert_eq!(t.quote(), Some("brave new"));
        assert_eq!(
            t.messages
                .iter()
                .map(|m| m.body.as_str())
                .collect::<Vec<_>>(),
            ["Is this right?", "Yes."]
        );

        // A reply reopens it; a new anchor keeps the original quote.
        {
            let mut txn = doc.transact_mut();
            add_message(&mut txn, &id, "Luc's AI", "ai:x", "Reopening").unwrap();
            let moved = anchor_for_quote("<p>Hello bold new world</p>", "bold new", None)
                .unwrap()
                .anchor;
            set_anchor(&mut txn, &id, &moved).unwrap();
        }
        let t = &read_threads(&doc.transact())[0];
        assert!(t.is_open());
        assert_eq!(t.quote(), Some("bold new"));
        assert_eq!(t.original_quote.as_deref(), Some("brave new"));
    }

    #[test]
    fn reads_threads_written_by_the_editor() {
        // Integers from JS arrive as BigInt; nested messages map; unknown fields ignored.
        let doc = Doc::new();
        {
            let mut txn = doc.transact_mut();
            let map = txn.get_or_insert_map(COMMENTS_MAP);
            let message =
                json_to_any(&json!({ "id": "m1", "author": "Ann", "ts": 5, "body": "Hi" }));
            map.insert(
                &mut txn,
                "t1",
                MapPrelim::from([
                    (
                        "anchor".to_string(),
                        yrs::In::Any(json_to_any(
                            &json!({ "kind": "element", "tag": "img", "label": "Chart" }),
                        )),
                    ),
                    ("createdAt".to_string(), yrs::In::Any(Any::BigInt(5))),
                    (
                        "seen".to_string(),
                        yrs::In::Any(json_to_any(&json!({ "state": "orphaned", "at": 9 }))),
                    ),
                    (
                        "messages".to_string(),
                        yrs::In::Map(MapPrelim::from([("m1".to_string(), yrs::In::Any(message))])),
                    ),
                ]),
            );
            map.insert(&mut txn, "junk", Any::from("not a thread"));
        }
        let threads = read_threads(&doc.transact());
        assert_eq!(threads.len(), 1);
        let listing = render_threads(&threads, None, false).unwrap();
        assert!(listing.contains("1 open, 0 resolved"), "{}", listing);
        assert!(listing.contains("[t1] on <img> \"Chart\""), "{}", listing);
        assert!(listing.contains("NOT FIND"), "{}", listing);
        assert!(
            listing.contains("Ann (1970-01-01 00:00 UTC): Hi"),
            "{}",
            listing
        );
    }

    #[test]
    fn notes_edits_that_remove_quoted_text() {
        let doc = Doc::new();
        let before = "<p>Keep this.</p><p>The llama paragraph.</p>";
        let anchor = anchor_for_quote(before, "llama paragraph", None)
            .unwrap()
            .anchor;
        {
            let mut txn = doc.transact_mut();
            create_thread(&mut txn, &anchor, "Ann", "a1", "Too long");
        }
        let threads = read_threads(&doc.transact());
        let note = removed_quote_notes(before, "<p>Keep this.</p>", &threads).unwrap();
        assert!(
            note.contains("removed text that 1 open comment thread points at"),
            "{}",
            note
        );
        assert!(note.contains("\"llama paragraph\""));
        assert!(
            removed_quote_notes(before, "<div><p>The llama paragraph.</p></div>", &threads)
                .is_none()
        );
    }

    #[test]
    fn static_text_decodes_accents_and_skips_embedded_documents() {
        let html = "<p>Caf&eacute; &Uuml;ber na&iuml;ve 3&times;4 &frac12;</p><iframe>fallback text</iframe>[[@comment:x1]]<p>end</p>";
        assert_eq!(static_text(html), "Café Über naïve 3×4 ½ end");
    }

    #[test]
    fn listing_cannot_be_spoofed_by_names_or_ids() {
        let doc = Doc::new();
        let anchor = anchor_for_quote("<p>Hello world</p>", "Hello", None)
            .unwrap()
            .anchor;
        {
            let mut txn = doc.transact_mut();
            create_thread(&mut txn, &anchor, "Eve\n--- Comments: 0 open", "e", "hi");
        }
        let listing = render_threads(&read_threads(&doc.transact()), None, false).unwrap();
        let fake_lines = listing
            .lines()
            .skip(1)
            .filter(|l| l.trim_start().starts_with("---"))
            .count();
        assert_eq!(fake_lines, 0, "{}", listing);
    }

    #[test]
    fn formats_timestamps() {
        assert_eq!(format_ts(1_758_800_000_000.0), "2025-09-25 11:33 UTC");
    }

    mod tool {
        use super::super::super::test_helpers::*;
        use super::super::*;
        use serde_json::json;

        const PAGE: &str = "<h1>Plan</h1><p>We launch in March with three pilot schools.</p><p>Read more</p><p>Read more</p>";

        async fn call(server: &Arc<Server>, sid: &str, args: Value) -> Result<String, String> {
            let mut args = args;
            args["session_id"] = json!(sid);
            execute(server, sid, &args).await
        }

        fn thread_id(result: &str) -> String {
            result.split_whitespace().nth(3).unwrap().to_string()
        }

        #[tokio::test]
        async fn add_reply_resolve_and_read_list_threads() {
            let server = build_test_server(&[("/Plan.html", "uuid-plan", PAGE)]).await;
            let sid = setup_session_no_reads(&server);

            let added = call(
                &server,
                &sid,
                json!({
                    "action": "add", "file_path": "Lens/Plan.html",
                    "quote": "three pilot schools", "body": "Which three?",
                }),
            )
            .await
            .unwrap();
            assert!(added.starts_with("Added comment thread "), "{}", added);
            let id = thread_id(&added);

            let ambiguous = call(&server, &sid, json!({
                "action": "add", "file_path": "Lens/Plan.html", "quote": "Read more", "body": "x",
            })).await.unwrap_err();
            assert!(ambiguous.contains("appears 2 times"), "{}", ambiguous);

            call(&server, &sid, json!({
                "action": "reply", "file_path": "Lens/Plan.html", "thread_id": id, "body": "Listed below.",
            })).await.unwrap();

            let read = super::super::super::read::execute(
                &server,
                &sid,
                &json!({ "file_path": "Lens/Plan.html", "session_id": sid }),
            )
            .await
            .unwrap();
            assert!(
                read.contains("--- Comments: 1 open, 0 resolved"),
                "{}",
                read
            );
            assert!(
                read.contains(&format!(
                    "[{}] on \"three pilot schools\" (under heading \"Plan\")",
                    id
                )),
                "{}",
                read
            );
            assert!(
                read.contains("Which three?") && read.contains("Listed below."),
                "{}",
                read
            );

            let resolved = call(&server, &sid, json!({
                "action": "resolve", "file_path": "Lens/Plan.html", "thread_id": id, "body": "Done.",
            })).await.unwrap();
            assert!(resolved.contains("is now resolved"));
            let listed = call(
                &server,
                &sid,
                json!({ "action": "list", "file_path": "Lens/Plan.html" }),
            )
            .await
            .unwrap();
            assert!(listed.contains("0 open, 1 resolved"), "{}", listed);

            // Comments never touch the source.
            assert_eq!(
                read_doc_content(&server, &format!("{}-uuid-plan", RELAY_ID)),
                PAGE
            );
        }

        #[tokio::test]
        async fn edit_warns_when_it_removes_quoted_text_and_reanchor_follows_it() {
            let server = build_test_server(&[("/Plan.html", "uuid-plan", PAGE)]).await;
            let doc_id = format!("{}-uuid-plan", RELAY_ID);
            let sid = setup_session_with_read(&server, &doc_id);
            let id = thread_id(
                &call(
                    &server,
                    &sid,
                    json!({
                        "action": "add", "file_path": "Lens/Plan.html",
                        "quote": "three pilot schools", "body": "Which three?",
                    }),
                )
                .await
                .unwrap(),
            );

            let edited = super::super::super::edit::execute(
                &server,
                &sid,
                &json!({
                    "file_path": "Lens/Plan.html",
                    "old_string": "three pilot schools",
                    "new_string": "four partner schools",
                    "session_id": sid,
                }),
            )
            .await
            .unwrap();
            assert!(
                edited.contains("removed text that 1 open comment thread points at"),
                "{}",
                edited
            );
            assert!(edited.contains(&id), "{}", edited);

            let moved = call(&server, &sid, json!({
                "action": "reanchor", "file_path": "Lens/Plan.html", "thread_id": id, "quote": "four partner schools",
            })).await.unwrap();
            assert!(
                moved.contains("[four partner schools]"),
                "{}",
                moved
            );
            let listed = call(
                &server,
                &sid,
                json!({ "action": "list", "file_path": "Lens/Plan.html" }),
            )
            .await
            .unwrap();
            assert!(listed.contains("on \"four partner schools\""), "{}", listed);
        }

        #[tokio::test]
        async fn refuses_markdown_and_unknown_threads() {
            let server = build_test_server(&[
                ("/Plan.html", "uuid-plan", PAGE),
                ("/Doc.md", "uuid-doc", "Hi"),
            ])
            .await;
            let sid = setup_session_no_reads(&server);
            let md = call(
                &server,
                &sid,
                json!({ "action": "list", "file_path": "Lens/Doc.md" }),
            )
            .await
            .unwrap_err();
            assert!(md.contains("not an HTML page"), "{}", md);
            let missing = call(&server, &sid, json!({
                "action": "reply", "file_path": "Lens/Plan.html", "thread_id": "nope", "body": "x",
            })).await.unwrap_err();
            assert!(
                missing.contains("no comments yet") || missing.contains("no comment thread"),
                "{}",
                missing
            );
        }
    }
}
