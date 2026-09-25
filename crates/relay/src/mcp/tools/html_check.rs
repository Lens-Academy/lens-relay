//! Static page check for `.html` documents, run after MCP `create`/`edit`,
//! plus the edit-time guard that keeps collaborators' comment blocks intact.
//!
//! The Lens Editor renders HTML documents in a sandboxed iframe with a fixed
//! runtime contract (modelled on Claude artifacts): scripts only from a few
//! CDNs, a shared import map for bare module imports, no modal dialogs, and
//! the page must fit a phone. Agents cannot see the preview, so this check
//! spells out, in the tool result, what will not work there. It is advisory:
//! the document is always saved as written.
//!
//! Mirrors `lens-editor/src/components/HtmlEditor/runtime/page-runtime.ts`
//! (SCRIPT_HOSTS, STYLE_HOSTS, FONT_HOSTS, IMPORT_MAP keys); keep them in
//! sync. The author guide is `Lens/AI Guide/HTML Pages.md`.

use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

pub const GUIDE_PATH: &str = "Lens/AI Guide/HTML Pages.md";

const SCRIPT_HOSTS: &[&str] = &[
    "esm.sh",
    "esm.run",
    "ga.jspm.io",
    "cdn.jsdelivr.net",
    "cdnjs.cloudflare.com",
    "unpkg.com",
    "cdn.tailwindcss.com",
    "code.jquery.com",
];

const STYLE_HOSTS: &[&str] = &[
    "fonts.googleapis.com",
    "cdn.jsdelivr.net",
    "cdnjs.cloudflare.com",
    "unpkg.com",
];

const FONT_HOSTS: &[&str] = &[
    "fonts.gstatic.com",
    "cdn.jsdelivr.net",
    "cdnjs.cloudflare.com",
    "unpkg.com",
];

/// Bare specifiers the editor's import map resolves (`three/addons/` is a
/// prefix entry).
const IMPORT_MAP_KEYS: &[&str] = &[
    "react",
    "react/jsx-runtime",
    "react-dom",
    "react-dom/client",
    "htm",
    "htm/react",
    "recharts",
    "lucide-react",
    "d3",
    "chart.js",
    "chart.js/auto",
    "three",
    "lodash-es",
    "mathjs",
    "papaparse",
    "marked",
    "katex",
    "mermaid",
];
const IMPORT_MAP_PREFIXES: &[&str] = &["three/addons/"];

/// Widest fixed size (CSS px) that still fits the phone preview (390px) with
/// some room for the page's own gutters.
const PHONE_SAFE_PX: u32 = 480;
/// Notes shown per result; the header always gives the full count.
const MAX_SHOWN: usize = 25;

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).unwrap()
}

static SCRIPT_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?is)<script\b([^>]*)>(.*?)</script\s*>"));
static LINK_RE: LazyLock<Regex> = LazyLock::new(|| re(r"(?is)<link\b([^>]*)>"));
static IMG_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?is)<(?:img|source|video|audio)\b([^>]*)>"));
static STYLE_RE: LazyLock<Regex> = LazyLock::new(|| re(r"(?is)<style\b[^>]*>(.*?)</style\s*>"));
static STYLE_ATTR_RE: LazyLock<Regex> = LazyLock::new(|| re(r#"(?is)\sstyle\s*=\s*"([^"]*)""#));
static CSS_COMMENT_RE: LazyLock<Regex> = LazyLock::new(|| re(r"(?s)/\*.*?\*/"));
static CSS_IMPORT_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r#"(?i)@import\s+(?:url\(\s*)?["']?([^"')\s;]+)"#));
static CSS_URL_RE: LazyLock<Regex> = LazyLock::new(|| re(r#"(?i)url\(\s*["']?([^"')\s]+)"#));
static FIXED_WIDTH_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)(?:^|[;{\s])((?:min-)?width)\s*:\s*(\d{3,5})px"));
static WIDE_OK_SELECTOR_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)\b(?:table|thead|tbody|tr|td|th|pre|code|svg|canvas)\b"));
static BODY_NO_GUTTER_RE: LazyLock<Regex> = LazyLock::new(|| {
    // padding: 0 | Y 0 | Y 0 Z | Y 0 Z 0 — any form with zero side padding.
    re(concat!(
        r"(?i)(?:^|[\s,}])(?:html\s*,\s*)?body\s*\{[^}]*(?:^|[;{\s])padding\s*:\s*",
        r"(?:0(?:px)?|[^\s;}]+\s+0(?:px)?(?:\s+[^\s;}]+)?|[^\s;}]+\s+0(?:px)?\s+[^\s;}]+\s+0(?:px)?)",
        r"\s*(?:[;}]|!)"
    ))
});
static ATTR_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r#"(?is)([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#));
static STATIC_IMPORT_RE: LazyLock<Regex> = LazyLock::new(|| {
    re(r#"(?m)(?:^|[;}\n])\s*(?:import|export)\s+(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"']+)["']"#)
});
static DYNAMIC_IMPORT_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r#"\bimport\(\s*["']([^"']+)["']\s*\)"#));
static CLASSIC_IMPORT_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r#"(?m)^\s*import\s+(?:[\w*{}\s,$]+\s+from\s+)?["']"#));
static REACT_IMPORT_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r#"(?m)^\s*import\s+React\b[^;\n]*from\s+["']react["']"#));
static JSX_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?:return|=>|render\()\s*\(?\s*<(?:[A-Za-z][\w.]*[\s/>]|>)"));
static MODAL_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?:^|[^.\w$])(?:window\.)?(alert|confirm|prompt|print)\s*\("));
static FETCH_RE: LazyLock<Regex> = LazyLock::new(|| re(r#"\bfetch\(\s*["'`]([^"'`]+)["'`]"#));
static WORKER_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r#"\bnew\s+(?:Shared)?Worker\(\s*["'`](https?:[^"'`]+)["'`]"#));
static RELATIVE_WORKER_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r#"\bnew\s+(?:Shared)?Worker\(\s*["'`]([^"'`:]+)["'`]"#));
static NAVIGATION_RE: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?:^|[^.\w$])(?:window\.|document\.|self\.)?location(?:\.href)?\s*=[^=]|\blocation\.(?:assign|replace)\(",
    )
});
static DOCTYPE_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?is)^\s*(?:<!--.*?-->\s*)*<!doctype\s"));
static IMPORTMAP_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r#"(?i)<script\b[^>]*\btype\s*=\s*["']?importmap\b"#));
static TITLE_RE: LazyLock<Regex> = LazyLock::new(|| re(r"(?is)<title\b[^>]*>\s*\S"));
static VIEWPORT_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r#"(?i)<meta\b[^>]*name\s*=\s*["']?viewport"#));
static HEAD_RE: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)<head\b"));
static JSON_URL_RE: LazyLock<Regex> = LazyLock::new(|| re(r#""((?:https?:)?//[^"]+)""#));
static COMMENT_BLOCK_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?s)<!--lens-(?:comment|reply)\b.*?-->"));
static VERSION_RE: LazyLock<Regex> = LazyLock::new(|| re(r"@\d+(?:\.\d+)*|/\d+\.\d+(?:\.\d+)?/"));

fn attrs(tag_attrs: &str) -> Vec<(String, String)> {
    ATTR_RE
        .captures_iter(tag_attrs)
        .map(|c| {
            let value = c
                .get(2)
                .or_else(|| c.get(3))
                .or_else(|| c.get(4))
                .map(|m| m.as_str())
                .unwrap_or("");
            (c[1].to_ascii_lowercase(), value.to_string())
        })
        .collect()
}

fn attr<'a>(list: &'a [(String, String)], name: &str) -> Option<&'a str> {
    list.iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
}

/// Scheme and host of an absolute or protocol-relative http(s) URL.
fn url_parts(url: &str) -> Option<(String, String)> {
    let absolute = if url.starts_with("//") {
        format!("https:{}", url)
    } else {
        url.to_string()
    };
    let parsed = url::Url::parse(&absolute).ok()?;
    match parsed.scheme() {
        "http" | "https" => Some((
            parsed.scheme().to_string(),
            parsed.host_str()?.to_ascii_lowercase(),
        )),
        _ => None,
    }
}

fn is_relative(url: &str) -> bool {
    !(url.contains(':') || url.starts_with("//") || url.starts_with('#') || url.is_empty())
}

/// Hosts that serve npm packages at a version in the path, where a missing
/// version means "latest" and the page changes under its authors.
fn needs_version(host: &str) -> bool {
    matches!(
        host,
        "esm.sh" | "esm.run" | "cdn.jsdelivr.net" | "unpkg.com" | "cdnjs.cloudflare.com"
    )
}

#[derive(Default)]
struct Notes {
    list: Vec<String>,
    seen: HashSet<String>,
    bare_imports: Vec<String>,
    wide: Vec<String>,
}

impl Notes {
    fn push(&mut self, note: String) {
        if self.seen.insert(note.clone()) {
            self.list.push(note);
        }
    }
}

/// A URL that loads code (script or module import).
fn check_code_url(url: &str, what: &str, notes: &mut Notes) {
    match url_parts(url) {
        Some((scheme, host)) => {
            if !SCRIPT_HOSTS.contains(&host.as_str()) {
                notes.push(format!(
                    "{} from {} will be blocked: scripts load only from {}.",
                    what,
                    url,
                    SCRIPT_HOSTS.join(", ")
                ));
            } else if scheme == "http" {
                notes.push(format!(
                    "{} {} uses http://, which the page rules block; use https://.",
                    what, url
                ));
            } else if needs_version(&host) && !VERSION_RE.is_match(url) {
                notes.push(format!(
                    "{} {} has no version, so it changes whenever the package does; pin an exact version (e.g. pkg@1.2.3).",
                    what, url
                ));
            } else if host == "esm.sh"
                && url.contains("react")
                && !url.contains("esm.sh/react@")
                && !url.contains("esm.sh/react-dom@")
                && !url.contains("external=")
                && !url.contains("deps=")
            {
                notes.push(format!(
                    "{} {} may bundle its own copy of React (two Reacts break hooks); add ?external=react,react-dom.",
                    what, url
                ));
            } else if url.contains("+esm") && url.contains("react") {
                notes.push(format!(
                    "{} {} is a jsDelivr +esm build, which pulls in its own React; use esm.sh with ?external=react,react-dom.",
                    what, url
                ));
            }
        }
        None if is_relative(url) => notes.push(format!(
            "Relative {} '{}' resolves against the editor's address, which the page rules block. Use a CDN URL or inline the code.",
            what.to_lowercase(),
            url
        )),
        None => {}
    }
}

/// Keys of the page's own import map(s), if it has any; `None` means the
/// editor's shared map applies.
fn own_import_map_keys(source: &str) -> Option<Vec<String>> {
    if !IMPORTMAP_RE.is_match(source) {
        return None;
    }
    let mut keys = Vec::new();
    for c in SCRIPT_RE.captures_iter(source) {
        let list = attrs(&c[1]);
        if !attr(&list, "type").is_some_and(|t| t.eq_ignore_ascii_case("importmap")) {
            continue;
        }
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&c[2]) {
            if let Some(imports) = json.get("imports").and_then(|v| v.as_object()) {
                keys.extend(imports.keys().cloned());
            }
        }
    }
    Some(keys)
}

fn check_specifier(spec: &str, own_map: Option<&[String]>, notes: &mut Notes) {
    if spec.starts_with("data:") || spec.starts_with("blob:") {
        return;
    }
    if spec.starts_with("http:") || spec.starts_with("https:") || spec.starts_with("//") {
        check_code_url(spec, "Module import", notes);
        return;
    }
    if spec.starts_with("./") || spec.starts_with("../") || spec.starts_with('/') {
        check_code_url(spec, "Module import", notes);
        return;
    }
    match own_map {
        None => {
            let mapped = IMPORT_MAP_KEYS.contains(&spec)
                || IMPORT_MAP_PREFIXES.iter().any(|p| spec.starts_with(p));
            if !mapped {
                notes.bare_imports.push(spec.to_string());
            }
        }
        Some(keys) => {
            let mapped = keys
                .iter()
                .any(|k| k == spec || (k.ends_with('/') && spec.starts_with(k.as_str())));
            if !mapped {
                notes.push(format!(
                    "Bare import '{}' is not in the page's own import map, which replaces the editor's; add it to that map.",
                    spec
                ));
            }
        }
    }
}

/// Split CSS into (selector-or-at-rule prelude, block body) pairs at nesting
/// depth 0, returning at-rule blocks whole (their content is not recursed).
fn css_blocks(css: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut prelude_start = 0usize;
    let mut body_start = 0usize;
    let mut prelude = String::new();
    for (i, ch) in css.char_indices() {
        match ch {
            '{' => {
                if depth == 0 {
                    prelude = css[prelude_start..i].trim().to_string();
                    body_start = i + 1;
                }
                depth += 1;
            }
            '}' if depth > 0 => {
                depth -= 1;
                if depth == 0 {
                    out.push((std::mem::take(&mut prelude), css[body_start..i].to_string()));
                    prelude_start = i + 1;
                }
            }
            ';' if depth == 0 => prelude_start = i + 1,
            _ => {}
        }
    }
    out
}

fn check_css(css: &str, inline_attr: bool, notes: &mut Notes) {
    let css = CSS_COMMENT_RE.replace_all(css, " ");
    for c in CSS_IMPORT_RE.captures_iter(&css) {
        let url = &c[1];
        match url_parts(url) {
            Some((_, host)) if !STYLE_HOSTS.contains(&host.as_str()) => notes.push(format!(
                "Stylesheet @import from {} will be blocked: stylesheets load only from {}; inline the CSS instead.",
                url,
                STYLE_HOSTS.join(", ")
            )),
            None if is_relative(url) => notes.push(format!(
                "Relative stylesheet @import '{}' resolves against the editor's address, which the page rules block; inline the CSS instead.",
                url
            )),
            _ => {}
        }
    }
    let mut scan_widths = |selector: &str, decls: &str, notes: &mut Notes| {
        if WIDE_OK_SELECTOR_RE.is_match(selector) {
            return;
        }
        for c in FIXED_WIDTH_RE.captures_iter(decls) {
            if let Ok(px) = c[2].parse::<u32>() {
                if px > PHONE_SAFE_PX {
                    notes.wide.push(format!("{}: {}px", &c[1], px));
                }
            }
        }
    };
    if inline_attr {
        scan_widths("", &css, notes);
        return;
    }
    for (prelude, body) in css_blocks(&css) {
        let lower = prelude.to_ascii_lowercase();
        if lower.starts_with("@font-face") {
            for c in CSS_URL_RE.captures_iter(&body) {
                let url = &c[1];
                if let Some((_, host)) = url_parts(url) {
                    if !FONT_HOSTS.contains(&host.as_str()) {
                        notes.push(format!(
                            "Font file from {} will be blocked: fonts load only from {} or data: URIs.",
                            url,
                            FONT_HOSTS.join(", ")
                        ));
                    }
                }
            }
        } else if lower.starts_with('@') {
            // @media/@supports/@container blocks are responsive by design.
        } else {
            scan_widths(&prelude, &body, notes);
        }
    }
    if BODY_NO_GUTTER_RE.is_match(&css) {
        notes.push(
            "body sets padding: 0, which removes the side gutter; keep at least 16px with padding-inline (use padding-block for vertical padding)."
                .to_string(),
        );
    }
}

/// Strip JS comments. Keeps `//` that follows a quote, colon or backslash, so
/// URL strings ("https://…", "//cdn…") survive.
fn strip_js_comments(code: &str) -> String {
    static COMMENT_RE: LazyLock<Regex> =
        LazyLock::new(|| re(r#"(?s)/\*.*?\*/|(?m)(?:^|[^:\\"'`])//[^\n]*"#));
    COMMENT_RE.replace_all(code, " ").into_owned()
}

fn modal_calls(code: &str) -> Vec<&str> {
    let mut calls: Vec<&str> = Vec::new();
    for c in MODAL_RE.captures_iter(code) {
        let whole = c.get(0).unwrap();
        let before = code[..whole.start()].trim_end();
        // `function print(`, or a method definition `print() {`.
        if before.ends_with("function") {
            continue;
        }
        let rest = &code[whole.end()..];
        if let Some(close) = rest.find(')') {
            if rest[close + 1..].trim_start().starts_with('{') {
                continue;
            }
        }
        let name = c.get(1).unwrap().as_str();
        if !calls.contains(&name) {
            calls.push(name);
        }
    }
    calls.sort_unstable();
    calls
}

/// Notes about what will not work in the editor preview. Empty when the page
/// follows the contract.
pub fn check(source: &str) -> Vec<String> {
    let mut notes = Notes::default();
    let own_map = own_import_map_keys(source);
    let own_map = own_map.as_deref();
    let mut all_code = String::new();
    let mut babel_scripts = false;
    let mut babel_loaded = false;

    if !DOCTYPE_RE.is_match(source) {
        notes.push("Start the page with <!doctype html>.".to_string());
    }

    let has_head = HEAD_RE.is_match(source);
    if !TITLE_RE.is_match(source) {
        notes.push(
            "The page has no <title>. Add one naming the page (2–4 words, matching the file name)."
                .to_string(),
        );
    }
    if has_head && !VIEWPORT_RE.is_match(source) {
        notes.push(
            "The <head> has no viewport meta; add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"> so the page fits phones when opened on its own."
                .to_string(),
        );
    }

    for c in SCRIPT_RE.captures_iter(source) {
        let list = attrs(&c[1]);
        let raw_body = &c[2];
        if COMMENT_BLOCK_RE.is_match(raw_body) {
            notes.push(
                "A lens-comment block sits inside a <script>, so it never reaches the page and the comment shows as orphaned. Keep commented text in static HTML."
                    .to_string(),
            );
        }
        let body = strip_js_comments(raw_body);
        let ty = attr(&list, "type").unwrap_or("").to_ascii_lowercase();
        if let Some(src) = attr(&list, "src") {
            check_code_url(src, "Script", &mut notes);
            if src.contains("babel") {
                babel_loaded = true;
            }
        }
        if ty == "importmap" {
            for u in JSON_URL_RE.captures_iter(&body) {
                check_code_url(&u[1], "Import map entry", &mut notes);
            }
            continue;
        }
        if ty == "application/json" || ty == "application/ld+json" {
            continue;
        }
        let babel = ty == "text/babel" || ty == "text/jsx";
        babel_scripts |= babel;
        let module = ty == "module"
            || (babel
                && attr(&list, "data-type").is_some_and(|t| t.eq_ignore_ascii_case("module")));
        if module {
            for s in STATIC_IMPORT_RE.captures_iter(&body) {
                check_specifier(&s[1], own_map, &mut notes);
            }
        } else if (ty.is_empty() || ty.contains("javascript")) && CLASSIC_IMPORT_RE.is_match(&body)
        {
            notes.push(
                "A classic <script> uses an import statement, which throws a SyntaxError. Use <script type=\"module\">."
                    .to_string(),
            );
        }
        if babel {
            if JSX_RE.is_match(&body) && module && !REACT_IMPORT_RE.is_match(&body) {
                notes.push(
                    "A text/babel script uses JSX without `import React from 'react'`; Babel's JSX calls React.createElement, so add that import."
                        .to_string(),
                );
            }
        } else if JSX_RE.is_match(&body) {
            notes.push(
                "A script appears to contain JSX, which browsers cannot run as is. Use htm (import { html } from 'htm/react'), or the Babel recipe in the guide."
                    .to_string(),
            );
        }
        for s in DYNAMIC_IMPORT_RE.captures_iter(&body) {
            check_specifier(&s[1], own_map, &mut notes);
        }
        for f in FETCH_RE.captures_iter(&body) {
            if is_relative(&f[1]) && !f[1].contains("${") {
                notes.push(format!(
                    "fetch('{}') is relative, so it goes to the editor's address and fails. Use an absolute https URL.",
                    &f[1]
                ));
            }
        }
        for w in WORKER_RE.captures_iter(&body) {
            notes.push(format!(
                "new Worker('{}') throws in the preview; create workers from a Blob URL (new Worker(URL.createObjectURL(new Blob([code]))))."
                ,
                &w[1]
            ));
        }
        for w in RELATIVE_WORKER_RE.captures_iter(&body) {
            notes.push(format!(
                "new Worker('{}') is relative and cannot load; create workers from a Blob URL (new Worker(URL.createObjectURL(new Blob([code])))).",
                &w[1]
            ));
        }
        if NAVIGATION_RE.is_match(&body) {
            notes.push(
                "The script sets location (or calls location.assign/replace), which would load another page inside the preview. Link out with <a href> instead; links open in a new tab."
                    .to_string(),
            );
        }
        all_code.push_str(&body);
        all_code.push('\n');
    }
    if babel_scripts && !babel_loaded {
        notes.push(
            "The page has text/babel scripts but never loads Babel, so they never run. Add the Babel <script> from the guide before them."
                .to_string(),
        );
    }

    for c in LINK_RE.captures_iter(source) {
        let list = attrs(&c[1]);
        let rel = attr(&list, "rel").unwrap_or("").to_ascii_lowercase();
        let Some(href) = attr(&list, "href") else {
            continue;
        };
        if rel.split_whitespace().any(|r| r == "modulepreload") {
            check_code_url(href, "Module preload", &mut notes);
            continue;
        }
        if !rel.split_whitespace().any(|r| r == "stylesheet") {
            continue;
        }
        match url_parts(href) {
            Some((_, host)) if !STYLE_HOSTS.contains(&host.as_str()) => notes.push(format!(
                "Stylesheet from {} will be blocked: stylesheets load only from {}; inline the CSS instead.",
                href,
                STYLE_HOSTS.join(", ")
            )),
            None if is_relative(href) => notes.push(format!(
                "Relative stylesheet '{}' resolves against the editor's address, which the page rules block; inline the CSS instead.",
                href
            )),
            Some((_, host)) if needs_version(&host) && !VERSION_RE.is_match(href) => {
                notes.push(format!(
                    "Stylesheet {} has no version, so it changes whenever the package does; pin an exact version.",
                    href
                ))
            }
            _ => {}
        }
    }

    for c in IMG_RE.captures_iter(source) {
        let list = attrs(&c[1]);
        if let Some(src) = attr(&list, "src") {
            if is_relative(src) {
                notes.push(format!(
                    "Relative media src '{}' resolves against the editor's address and will not load; use an absolute https URL or a data: URI.",
                    src
                ));
            }
        }
    }

    for c in STYLE_RE.captures_iter(source) {
        check_css(&c[1], false, &mut notes);
    }
    for c in STYLE_ATTR_RE.captures_iter(source) {
        check_css(&c[1], true, &mut notes);
    }

    if !notes.bare_imports.is_empty() {
        let mut names = std::mem::take(&mut notes.bare_imports);
        names.dedup();
        let mut seen = HashSet::new();
        names.retain(|n| seen.insert(n.clone()));
        notes.push(format!(
            "Bare import{} {} {} not in the editor's import map ({}{}). Import {} by full, pinned URL, e.g. https://esm.sh/{}@<version> (add ?external=react,react-dom for React libraries).",
            if names.len() == 1 { "" } else { "s" },
            names.iter().map(|n| format!("'{}'", n)).collect::<Vec<_>>().join(", "),
            if names.len() == 1 { "is" } else { "are" },
            IMPORT_MAP_KEYS.join(", "),
            IMPORT_MAP_PREFIXES.iter().map(|p| format!(", {}…", p)).collect::<String>(),
            if names.len() == 1 { "it" } else { "them" },
            names[0]
        ));
    }

    if !notes.wide.is_empty() {
        let mut seen = HashSet::new();
        let wide: Vec<String> = std::mem::take(&mut notes.wide)
            .into_iter()
            .filter(|w| seen.insert(w.clone()))
            .collect();
        let shown: Vec<&str> = wide.iter().take(3).map(|s| s.as_str()).collect();
        notes.push(format!(
            "Fixed sizes wider than a phone ({}{}) will overflow at 390px. Use max-width, %, or a @media query; wide tables and code go in an overflow-x: auto wrapper.",
            shown.join(", "),
            if wide.len() > 3 { ", …" } else { "" }
        ));
    }

    let calls = modal_calls(&all_code);
    if !calls.is_empty() {
        notes.push(format!(
            "{}() {} nothing in the preview (no dialogs, no printing). Build messages and confirmations into the page itself.",
            calls.join("(), "),
            if calls.len() == 1 { "does" } else { "do" }
        ));
    }

    notes.list
}

fn render(header: &str, notes: &[String]) -> String {
    let mut out = format!("\n\n{}", header);
    for note in notes.iter().take(MAX_SHOWN) {
        out.push_str("\n- ");
        out.push_str(note);
    }
    if notes.len() > MAX_SHOWN {
        out.push_str(&format!(
            "\n- …and {} more; they show once these are fixed.",
            notes.len() - MAX_SHOWN
        ));
    }
    out
}

/// Suffix for a create result: always says whether the check found anything.
pub fn result_suffix(source: &str) -> String {
    let notes = check(source);
    if notes.is_empty() {
        return "\n\nPage check: nothing found that would break in the editor preview.".to_string();
    }
    render(
        &format!(
            "Page check ({} note{} for the editor preview; the file was saved as written. Rules: read {}):",
            notes.len(),
            if notes.len() == 1 { "" } else { "s" },
            GUIDE_PATH
        ),
        &notes,
    )
}

/// Suffix for an edit result: only notes the edit introduced, so repeated
/// edits don't repeat the same list.
pub fn edit_suffix(before: &str, after: &str) -> String {
    let old: HashSet<String> = check(before).into_iter().collect();
    let now = check(after);
    let new: Vec<String> = now.iter().filter(|n| !old.contains(*n)).cloned().collect();
    let remaining = now.len() - new.len();
    if new.is_empty() {
        return match remaining {
            0 => {
                "\n\nPage check: nothing found that would break in the editor preview.".to_string()
            }
            n => format!(
                "\n\nPage check: this edit added no problems ({} earlier note{} still appl{}).",
                n,
                if n == 1 { "" } else { "s" },
                if n == 1 { "ies" } else { "y" }
            ),
        };
    }
    render(
        &format!(
            "Page check ({} new note{} from this edit{}; rules: read {}):",
            new.len(),
            if new.len() == 1 { "" } else { "s" },
            if remaining > 0 {
                format!(", {} earlier still apply", remaining)
            } else {
                String::new()
            },
            GUIDE_PATH
        ),
        &new,
    )
}

static COMMENT_ANCHOR_RE: LazyLock<Regex> = LazyLock::new(|| re(r"\[\[@comment:[^\]\s]+\]\]"));
static COMMENT_ID_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r#"^<!--lens-(comment|reply)\s*\{\s*"id"\s*:\s*"((?:[^"\\]|\\.)*)""#));

/// Items of `before` missing from `after`, counted as multisets.
fn missing(before: &[&str], after: &[&str]) -> usize {
    let mut remaining: Vec<&str> = after.to_vec();
    let mut lost = 0;
    for item in before {
        match remaining.iter().position(|b| b == item) {
            Some(i) => {
                remaining.swap_remove(i);
            }
            None => lost += 1,
        }
    }
    lost
}

/// Collaborators' comments must survive an agent's edit byte for byte: every
/// `<!--lens-comment …-->` / `<!--lens-reply …-->` block and every
/// `[[@comment:id]]` anchor in the document before the edit is still there
/// after it, and new blocks may not reuse an id. Comments are resolved by
/// people in the editor. Compares whole documents, so an edit whose
/// `old_string` covers only part of a block cannot slip past.
pub fn preserve_comment_blocks(before: &str, after: &str) -> Result<(), String> {
    let old_blocks: Vec<&str> = COMMENT_BLOCK_RE
        .find_iter(before)
        .map(|m| m.as_str())
        .collect();
    let new_blocks: Vec<&str> = COMMENT_BLOCK_RE
        .find_iter(after)
        .map(|m| m.as_str())
        .collect();
    let lost_blocks = missing(&old_blocks, &new_blocks);
    let old_anchors: Vec<&str> = COMMENT_ANCHOR_RE
        .find_iter(before)
        .map(|m| m.as_str())
        .collect();
    let new_anchors: Vec<&str> = COMMENT_ANCHOR_RE
        .find_iter(after)
        .map(|m| m.as_str())
        .collect();
    let lost_anchors = missing(&old_anchors, &new_anchors);

    if lost_blocks > 0 || lost_anchors > 0 {
        let mut what = Vec::new();
        if lost_blocks > 0 {
            what.push(format!(
                "{} comment block{} (<!--lens-comment …--> / <!--lens-reply …-->)",
                lost_blocks,
                if lost_blocks == 1 { "" } else { "s" }
            ));
        }
        if lost_anchors > 0 {
            what.push(format!(
                "{} comment anchor{} ([[@comment:…]])",
                lost_anchors,
                if lost_anchors == 1 { "" } else { "s" }
            ));
        }
        return Err(format!(
            "Error: this edit would remove or change {} left by collaborators. Keep them byte for byte (you may move them along with the text they belong to); people resolve comments in the editor. To respond to one, add a <!--lens-reply …--> block instead.",
            what.join(" and ")
        ));
    }

    let ids = |list: &[&str]| -> Vec<(String, String)> {
        list.iter()
            .filter_map(|b| COMMENT_ID_RE.captures(b))
            .map(|c| (c[1].to_string(), c[2].to_string()))
            .collect()
    };
    let old_ids = ids(&old_blocks);
    let mut seen = HashSet::new();
    for id in ids(&new_blocks) {
        let already_duplicated = old_ids.iter().filter(|o| **o == id).count() > 1;
        if !seen.insert(id.clone()) && !already_duplicated {
            return Err(format!(
                "Error: a {} block with id \"{}\" already exists; give the new one a unique id.",
                id.0, id.1
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEAD: &str = r#"<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Test Page</title>"#;

    fn page(body: &str) -> String {
        format!("{HEAD}</head><body>{body}</body></html>")
    }

    #[test]
    fn contract_following_page_has_no_notes() {
        let page = r#"<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Team timezones</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader&display=swap">
<link rel="icon" href="favicon.png">
<style>
  /* width: 2000px in a comment */
  body { max-width: 1100px; margin: 0 auto; padding-inline: 16px; }
  @media (min-width: 900px) { .grid { grid-template-columns: 1fr 1fr; width: 1000px; } }
  @media print { .sheet { width: 800px } }
  table.data { min-width: 720px; }
  @font-face { font-family: X; src: url(data:font/woff2;base64,AAAA) format("woff2"); }
</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>
</head><body><div id="root"></div>
<img src="https://example.com/a.png"><img src="data:image/png;base64,AAAA">
<script type="module">
import React, { useState } from 'react';
import { createRoot } from "react-dom/client";
import { html } from 'htm/react';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import confetti from 'https://esm.sh/canvas-confetti@1.9.4';
const { LineChart } = await import('recharts');
const data = await fetch('https://api.example.com/x.json');
// alert("not a real call")
function print(x) { return x; }
class Doc { print() { return 1; } }
createRoot(document.getElementById('root')).render(html`<p>hi</p>`);
</script>
<form id="f"></form>
</body></html>"#;
        assert_eq!(check(page), Vec::<String>::new());
    }

    #[test]
    fn flags_disallowed_hosts_relative_urls_http_and_unpinned() {
        let page = page(
            r#"<script src="https://example.com/lib.js"></script>
<script src="app.js"></script>
<script src="http://cdn.jsdelivr.net/npm/x@1.0.0/x.js"></script>
<script src="https://cdn.jsdelivr.net/npm/lodash/lodash.min.js"></script>
<link rel="stylesheet" href="https://example.com/site.css">
<style>@import url("https://example.com/more.css");
@font-face { font-family: Y; src: url(https://example.com/y.woff2); }</style>
<img src="logo.png">
<script type="module">import x from "https://example.com/x.js"; import y from './y.js';
import Motion from 'https://esm.sh/framer-motion-react@1.0.0';
const r = await fetch('data/points.json'); new Worker('https://cdn.jsdelivr.net/npm/w@1.0.0/w.js');</script>"#,
        );
        let notes = check(&page).join("\n");
        assert!(notes.contains("Script from https://example.com/lib.js will be blocked"));
        assert!(notes.contains("Relative script 'app.js'"));
        assert!(notes.contains("uses http://"));
        assert!(notes.contains("lodash/lodash.min.js has no version"));
        assert!(notes.contains("Stylesheet from https://example.com/site.css will be blocked"));
        assert!(notes.contains("@import from https://example.com/more.css"));
        assert!(notes.contains("Font file from https://example.com/y.woff2"));
        assert!(notes.contains("Relative media src 'logo.png'"));
        assert!(notes.contains("Module import from https://example.com/x.js"));
        assert!(notes.contains("Relative module import './y.js'"));
        assert!(notes.contains("may bundle its own copy of React"));
        assert!(notes.contains("fetch('data/points.json') is relative"));
        assert!(notes.contains("new Worker('https://cdn.jsdelivr.net/npm/w@1.0.0/w.js') throws"));
    }

    #[test]
    fn lists_unmapped_bare_imports_once_unless_page_has_its_own_map() {
        let notes = check(&page(
            r#"<script type="module">import { motion } from 'framer-motion'; import dayjs from 'dayjs';</script>"#,
        ));
        let joined = notes.join("\n");
        assert!(joined
            .contains("Bare imports 'framer-motion', 'dayjs' are not in the editor's import map"));
        assert_eq!(joined.matches("import map (").count(), 1);
        let own = page(
            r#"<script type="importmap">{"imports":{"framer-motion":"https://esm.sh/framer-motion@12.0.0","x":"https://example.com/x.js"}}</script>
<script type="module">import { motion } from 'framer-motion';</script>"#,
        );
        assert_eq!(
            check(&own),
            vec!["Import map entry from https://example.com/x.js will be blocked: scripts load only from esm.sh, esm.run, ga.jspm.io, cdn.jsdelivr.net, cdnjs.cloudflare.com, unpkg.com, cdn.tailwindcss.com, code.jquery.com.".to_string()]
        );
    }

    #[test]
    fn flags_import_in_classic_script_and_jsx_but_accepts_the_babel_recipe() {
        let notes = check(&page(
            r#"<script>
import React from 'react';
function App() { return <div className="x">hi</div>; }
</script>"#,
        ))
        .join("\n");
        assert!(notes.contains("classic <script> uses an import statement"));
        assert!(notes.contains("appears to contain JSX"));
        let babel = page(
            r#"<script src="https://cdn.jsdelivr.net/npm/@babel/standalone@7.29.9/babel.min.js"></script>
<script type="text/babel" data-type="module" data-presets="react">
import React, { useState } from 'react';
function App() { return <div/>; }
</script>"#,
        );
        assert_eq!(check(&babel), Vec::<String>::new());
        let no_react = babel.replace("import React, { useState }", "import { useState }");
        assert!(check(&no_react)
            .join("\n")
            .contains("without `import React from 'react'`"));
    }

    #[test]
    fn flags_modals_wide_sizes_missing_head_bits_gutter_and_script_comments() {
        let notes = check(
            r#"<html><head></head><body><style>.board { width: 1200px } .col { min-width: 640px; } .ok { max-width: 900px; width: 320px }
body { margin: 0; padding: 0; }</style>
<div style="width: 800px">x</div>
<script>if (confirm('Sure?')) window.print(); alert('x'); doc.print();
const t = `<h1>x</h1><!--lens-comment {"id":"c1"}-->`;</script></body></html>"#,
        )
        .join("\n");
        assert!(notes.contains("no <title>"));
        assert!(notes.contains("no viewport meta"));
        assert!(
            notes.contains("width: 1200px, min-width: 640px, width: 800px"),
            "{notes}"
        );
        assert!(!notes.contains("900px"));
        assert!(notes.contains("alert(), confirm(), print() do nothing"));
        assert!(notes.contains("padding: 0, which removes the side gutter"));
        assert!(notes.contains("lens-comment block sits inside a <script>"));
        let single = check(&page("<script>alert(1)</script>")).join("\n");
        assert!(single.contains("alert() does nothing"));
    }

    #[test]
    fn result_suffix_always_reports_and_names_the_guide() {
        assert_eq!(
            result_suffix(&page("<h1>Hi</h1>")),
            "\n\nPage check: nothing found that would break in the editor preview."
        );
        let suffix = result_suffix(&page(r#"<script src="https://example.com/a.js"></script>"#));
        assert!(suffix.starts_with("\n\nPage check (1 note for the editor preview"));
        assert!(suffix.contains("Lens/AI Guide/HTML Pages.md"));
    }

    #[test]
    fn edit_suffix_reports_only_new_notes() {
        let before = page(r#"<script src="https://example.com/a.js"></script>"#);
        let same = before.replace("<body>", "<body><p>more</p>");
        assert_eq!(
            edit_suffix(&before, &same),
            "\n\nPage check: this edit added no problems (1 earlier note still applies)."
        );
        let worse = same.replace("<p>more</p>", "<p>more</p><script>alert(1)</script>");
        let suffix = edit_suffix(&before, &worse);
        assert!(suffix.contains("1 new note from this edit, 1 earlier still apply"));
        assert!(suffix.contains("alert() does nothing"));
        assert!(!suffix.contains("example.com/a.js"));
    }

    #[test]
    fn shows_a_capped_list_under_the_full_count() {
        let body: String = (0..30)
            .map(|i| format!(r#"<script src="https://bad{i}.example.com/x.js"></script>"#))
            .collect();
        let page = page(&body);
        assert_eq!(check(&page).len(), 30);
        let suffix = result_suffix(&page);
        assert!(suffix.contains("Page check (30 notes"), "{suffix}");
        assert_eq!(suffix.matches("\n- ").count(), MAX_SHOWN + 1);
        assert!(suffix.ends_with("…and 5 more; they show once these are fixed."));
    }

    #[test]
    fn flags_round_two_gaps() {
        let notes = check(
            r#"<html><head><meta name="viewport" content="width=device-width"><title>T</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap/dist/css/bootstrap.min.css">
<style>body { padding: 24px 0; }</style>
<script type="importmap">{"imports":{"lodash":"https://esm.sh/lodash-es@4.18.1"}}</script>
</head><body>
<script type="text/babel">function A() { return <p/>; }</script>
<script type="module">import d3 from 'd3'; import _ from 'lodash';
new Worker('worker.js'); if (x) window.location.href = 'https://example.com';</script>
</body></html>"#,
        )
        .join("\n");
        assert!(
            notes.contains("Start the page with <!doctype html>"),
            "{notes}"
        );
        assert!(notes.contains("bootstrap.min.css has no version"));
        assert!(notes.contains("removes the side gutter"));
        assert!(notes.contains("never loads Babel"));
        assert!(notes.contains("Bare import 'd3' is not in the page's own import map"));
        assert!(!notes.contains("'lodash' is not"));
        assert!(notes.contains("new Worker('worker.js') is relative"));
        assert!(notes.contains("sets location"));
        assert!(
            !check(&page("<script>if (location.href === 'x') {}</script>"))
                .join("")
                .contains("sets location")
        );
    }

    #[test]
    fn comment_blocks_must_survive_an_edit() {
        let block = r#"<!--lens-comment {"id":"c1","author":"Sam","body":"hi"}-->"#;
        let reply = r#"<!--lens-reply {"id":"r1","parent":"c1"}-->"#;
        let old = format!("<h1>Title[[@comment:c1]]</h1>{block}{reply}");
        let check_after = |after: String| preserve_comment_blocks(&old, &after);
        assert!(check_after(format!("<h1>New[[@comment:c1]]</h1>{block}{reply}")).is_ok());
        assert!(check_after(format!(
            "<h2>[[@comment:c1]]Moved</h2><p>{reply}</p>{block}"
        ))
        .is_ok());
        let err = check_after("<h1>New</h1>".to_string()).unwrap_err();
        assert!(
            err.contains("2 comment blocks") && err.contains("1 comment anchor"),
            "{err}"
        );
        // Partial edits inside a block: body, author, or breaking the prefix.
        assert!(check_after(old.replace("\"hi\"", "\"done\"")).is_err());
        assert!(check_after(old.replace("\"Sam\"", "\"Luc\"")).is_err());
        assert!(check_after(old.replace("<!--lens-comment", "<!--x")).is_err());
        // Adding a reply is fine; reusing an id is not.
        let new_reply = r#"<!--lens-reply {"id":"r2","parent":"c1"}-->"#;
        assert!(check_after(format!("{old}{new_reply}")).is_ok());
        let dup = r#"<!--lens-comment {"id":"c1","author":"AI","body":"again"}-->"#;
        let err = check_after(format!("{old}{dup}")).unwrap_err();
        assert!(err.contains("id \"c1\" already exists"), "{err}");
        assert!(preserve_comment_blocks("<p>x</p>", "<p>y</p>").is_ok());
    }
}
