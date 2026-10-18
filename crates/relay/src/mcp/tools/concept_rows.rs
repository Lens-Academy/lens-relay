//! Concept relationships ("concept rows") in `read` output.
//!
//! What the team knows about a concept and a source is stored once, in the
//! concept file (`Lens Edu/Concepts/<name>.md`): under its `## Relationships`
//! heading, each level-3 heading that is exactly one wikilink is a row about
//! the linked file, and runs until the next heading of level ≤ 3:
//!
//! ```text
//! ## Relationships
//!
//! ### [[../articles/ai-control-redwood]]
//! Best intro we have. §2 is the explanation.
//! ```
//!
//! A row means "we have information about this pair", not "this is a match".
//! The Lens Editor shows a file's rows in a panel at the top of the file; an
//! MCP `read` of an article, video transcript or lens gets the same rows as a
//! labelled block before the file's text (first chunk only); a lens also gets
//! the rows about the articles and videos it uses as `source::`. The rows
//! stay in the concept files: grep, search and glob see them only there, and
//! edits go to the concept file. See `docs/concept-relationships.md`.
//!
//! The parser follows the canonical concept-row rules v1, shared with the
//! editor (`lens-editor/src/lib/concept-rows.ts`) and the platform validator
//! (`content_processor/src/concepts.ts`); the tests tagged "canonical
//! concept-row rules v1 #N" use the editor's inputs so the three agree.

use super::{critic_markup, get_links};
use crate::server::Server;
use futures::StreamExt;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock};
use y_sweet_core::link_indexer::{self, without_terminal_md, VirtualEntry, VirtualTreeIndex};
use yrs::{GetString, ReadTxn, Transact};

/// "For a file in `opened_in`, show the rows about it from the files in
/// `rows_in`": the editor's `CONCEPT_ROW_RULES`.
struct ConceptRowRule {
    /// Shared folder the rule applies in.
    shared_folder: &'static str,
    /// Folder of the opened file, relative to the shared folder.
    opened_in: &'static str,
    /// Folder whose files hold the rows, relative to the shared folder.
    rows_in: &'static str,
    /// Heading (level 2) of the sections that hold the rows.
    section: &'static str,
    /// What a file in `opened_in` is called: "article", "video", "lens".
    kind: &'static str,
    /// Also show the rows of the files the opened file uses as `source::`
    /// (lenses). The files of the other rules are the sources that count.
    source_context: bool,
}

const fn relationships_rule(
    opened_in: &'static str,
    kind: &'static str,
    source_context: bool,
) -> ConceptRowRule {
    ConceptRowRule {
        shared_folder: "Lens Edu",
        opened_in,
        rows_in: "Concepts",
        section: "Relationships",
        kind,
        source_context,
    }
}

const CONCEPT_ROW_RULES: &[ConceptRowRule] = &[
    relationships_rule("articles", "article", false),
    relationships_rule("video_transcripts", "video", false),
    relationships_rule("Lenses", "lens", true),
];

/// Longest row text shown in full, in characters.
const MAX_ROW_CHARS: usize = 1500;
/// Longest block, in characters (before the header and end marker).
const MAX_BLOCK_CHARS: usize = 20_000;
/// Concept files read per target file (an article, video or lens).
const MAX_CONCEPT_FILES_PER_TARGET: usize = 40;
/// Concept files read per `read` call in all.
const MAX_CONCEPT_FILES_TOTAL: usize = 80;
/// Sources of a lens whose rows are shown (rule #8 lets the relay cap them).
const MAX_LENS_SOURCES: usize = 8;
/// Concept files loaded at once.
pub(super) const LOAD_CONCURRENCY: usize = 4;

pub(super) fn is_md(path: &str) -> bool {
    without_terminal_md(path).len() != path.len()
}

/// The shared folders that have concept rows, for the session intro.
pub(crate) fn rows_shared_folders() -> Vec<&'static str> {
    let mut folders: Vec<&'static str> =
        CONCEPT_ROW_RULES.iter().map(|r| r.shared_folder).collect();
    folders.dedup();
    folders
}

/// The rule for the file at `path` (a resolver path such as
/// `Lens Edu/articles/x.md`), or None.
fn match_rule(path: &str) -> Option<&'static ConceptRowRule> {
    if !is_md(path) {
        return None;
    }
    CONCEPT_ROW_RULES
        .iter()
        .find(|r| path.starts_with(&format!("{}/{}/", r.shared_folder, r.opened_in)))
}

/// What a lens source at resolver path `path` is ("article", "video"), or
/// None for a file that has no rows of its own (a widget, say): the folders
/// of the rules without source context.
fn source_kind(path: &str) -> Option<&'static str> {
    CONCEPT_ROW_RULES
        .iter()
        .filter(|r| !r.source_context)
        .find(|r| path.starts_with(&format!("{}/{}/", r.shared_folder, r.opened_in)))
        .map(|r| r.kind)
}

/// Resolver-path prefix (with trailing slash) of the files holding the rule's rows.
fn rows_folder(rule: &ConceptRowRule) -> String {
    format!("{}/{}/", rule.shared_folder, rule.rows_in)
}

// ---------------------------------------------------------------------------
// Parsing (port of the editor's concept-rows.ts)
// ---------------------------------------------------------------------------

/// One row: a `### [[target]]` heading in a `## Relationships` section.
/// Offsets are byte offsets into the parsed text.
#[derive(Debug, Clone, PartialEq)]
struct ConceptRow {
    /// The heading's link target, without `|alias` or `#heading`.
    target: String,
    /// 1-based line of the heading.
    line: usize,
    /// The free text: from the line after the heading to the next heading of
    /// level ≤ 3 (or the section's end), trailing whitespace left out.
    body_from: usize,
    body_to: usize,
}

struct Heading {
    level: usize,
    text: String,
    from: usize,
    to: usize,
    line: usize,
}

fn regex(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("static pattern"))
}

/// An ATX heading: up to 3 spaces of indent, 1–6 `#`, then space or the end.
fn heading_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(&RE, r"^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$")
}

/// The opening `---` of frontmatter, as the editor reads it.
fn frontmatter_open_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(&RE, r"^---[ \t]*\r?(\n|$)")
}

/// A line that is `---` with optional trailing whitespace.
fn frontmatter_close_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(&RE, r"^---[ \t]*$")
}

/// A wikilink's page part: `a/b#H|Alias` → `a/b`.
fn link_page(inner: &str) -> &str {
    let page = inner.split('|').next().unwrap_or("");
    page.split('#').next().unwrap_or("").trim()
}

/// A heading's text without its closing run of `#`s: `[[x]] ###` → `[[x]]`
/// (the hashes must follow a space; `[[x]]#` keeps its `#`).
fn strip_closing_hashes(text: &str) -> &str {
    static RE: OnceLock<Regex> = OnceLock::new();
    match regex(&RE, r"(?:^|[ \t]+)#+$").find(text) {
        Some(m) => &text[..m.start()],
        None => text,
    }
}

/// ATX headings of `text`, by the canonical concept-row rules v1 (#3, #5): up
/// to 3 spaces of indent; a closing run of `#`s is not part of the text; none
/// inside frontmatter (closing `---` may have trailing whitespace), fenced
/// code (CommonMark opening and closing), `%% %%` comments, list items or
/// block quotes. Setext headings and HTML blocks are not handled. A line by
/// line port of the editor's `headingsOf`.
fn headings_of(text: &str) -> Vec<Heading> {
    static FENCE_OPEN: OnceLock<Regex> = OnceLock::new();
    static FENCE_CLOSE: OnceLock<Regex> = OnceLock::new();
    static LIST_ITEM: OnceLock<Regex> = OnceLock::new();
    let fence_open = regex(&FENCE_OPEN, r"^ {0,3}(`{3,}|~{3,})(.*)$");
    let fence_close = regex(&FENCE_CLOSE, r"^ {0,3}(`{3,}|~{3,})[ \t]*$");
    let list_item = regex(&LIST_ITEM, r"^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)");
    let indented = |line: &str| line.starts_with([' ', '\t']);

    let mut out = Vec::new();
    let mut pos = 0usize;
    let mut line = 0usize;
    let mut fence: Option<(char, usize)> = None;
    let mut in_comment = false;
    let mut in_list = false;
    let mut in_frontmatter = frontmatter_open_re().is_match(text);
    loop {
        let nl = text[pos..].find('\n').map(|i| pos + i);
        let end = nl.unwrap_or(text.len());
        let full = &text[pos..end];
        let raw = full.strip_suffix('\r').unwrap_or(full);
        line += 1;
        if in_frontmatter {
            if line > 1 && frontmatter_close_re().is_match(raw) {
                in_frontmatter = false;
            }
        } else if let Some((c, len)) = fence {
            if let Some(close) = fence_close.captures(raw) {
                let run = &close[1];
                if run.starts_with(c) && run.len() >= len {
                    fence = None;
                }
            }
        } else {
            let open = fence_open.captures(raw);
            let comment_at_start = in_comment;
            // `%%` toggles an Obsidian comment, inline or across lines.
            if raw.matches("%%").count() % 2 == 1 {
                in_comment = !in_comment;
            }
            let opener = open.as_ref().and_then(|m| {
                let run = &m[1];
                let c = run.chars().next()?;
                (!(c == '`' && m[2].contains('`'))).then_some((c, run.len()))
            });
            if let (Some(opener), false) = (opener, comment_at_start) {
                fence = Some(opener);
            } else if !comment_at_start {
                if list_item.is_match(raw) {
                    in_list = true;
                } else if !raw.trim().is_empty() && !indented(raw) {
                    in_list = false;
                }
                // An indented heading under a list item belongs to the item.
                let in_item = in_list && indented(raw);
                if let (Some(m), false) = (heading_re().captures(raw), in_item) {
                    out.push(Heading {
                        level: m[1].len(),
                        text: strip_closing_hashes(m.get(2).map_or("", |g| g.as_str()))
                            .trim()
                            .to_string(),
                        from: pos,
                        to: pos + raw.len(),
                        line,
                    });
                }
            }
        }
        match nl {
            Some(nl) => pos = nl + 1,
            None => break,
        }
    }
    out
}

/// The rows of a concept file, by the canonical concept-row rules v1
/// (#1–#4): every level-2 heading that is exactly `section` starts a section,
/// which ends at the next heading of level ≤ 2; a row is a level-3 heading in
/// it that is exactly one wikilink (`|alias` and `#anchor` allowed; an
/// `![[embed]]` or an empty page is not a row); its body runs to the next
/// heading of level ≤ 3.
fn parse_concept_file(text: &str, section: &str) -> Vec<ConceptRow> {
    static SINGLE_LINK: OnceLock<Regex> = OnceLock::new();
    let single_link = regex(&SINGLE_LINK, r"^\[\[([^\[\]\n]+)\]\]$");
    let headings = headings_of(text);
    let mut rows = Vec::new();
    for (start, h) in headings.iter().enumerate() {
        if h.level != 2 || h.text != section {
            continue;
        }
        let end_index = headings
            .iter()
            .enumerate()
            .position(|(i, n)| i > start && n.level <= 2);
        let section_to = end_index.map_or(text.len(), |i| headings[i].from);
        let inside = &headings[start + 1..end_index.unwrap_or(headings.len())];
        for (i, r) in inside.iter().enumerate() {
            if r.level != 3 {
                continue;
            }
            let Some(link) = single_link.captures(&r.text) else {
                continue;
            };
            let target = link_page(&link[1]);
            if target.is_empty() {
                continue;
            }
            let to = inside[i + 1..]
                .iter()
                .find(|n| n.level <= 3)
                .map_or(section_to, |n| n.from);
            let body_from = (r.to + 1).min(to);
            let body_to = body_from + text[body_from..to].trim_end().len();
            rows.push(ConceptRow {
                target: target.to_string(),
                line: r.line,
                body_from,
                body_to,
            });
        }
    }
    rows
}

/// The link targets of every `source::` field in a lens (canonical
/// concept-row rules v1 #8): several per section, before the first heading,
/// in CRLF files too, but not inside `#### Text` sections; the first
/// wikilink of each value. A line by line port of the editor's
/// `lensSourceTargets`; [`source_kind`] then keeps articles and videos.
fn lens_source_targets(text: &str) -> Vec<String> {
    static FIELD: OnceLock<Regex> = OnceLock::new();
    static LINK: OnceLock<Regex> = OnceLock::new();
    let field = regex(&FIELD, r"^source::(.*)$");
    let link = regex(&LINK, r"\[\[([^\[\]\n]+)\]\]");
    let mut targets: Vec<String> = Vec::new();
    let mut in_text = false;
    let mut in_frontmatter = frontmatter_open_re().is_match(text);
    for (i, raw) in text.split('\n').enumerate() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if in_frontmatter {
            if i > 0 && frontmatter_close_re().is_match(line) {
                in_frontmatter = false;
            }
            continue;
        }
        if let Some(h) = heading_re().captures(line) {
            in_text = h[1].len() == 4
                && h.get(2).map_or("", |g| g.as_str()).trim().to_lowercase() == "text";
            continue;
        }
        if in_text {
            continue;
        }
        let target = field
            .captures(line)
            .and_then(|f| {
                link.captures(f.get(1).map_or("", |g| g.as_str()))
                    .map(|l| l[1].to_string())
            })
            .map(|inner| link_page(&inner).to_string())
            .unwrap_or_default();
        if !target.is_empty() && !targets.contains(&target) {
            targets.push(target);
        }
    }
    targets
}

// ---------------------------------------------------------------------------
// Collecting rows
// ---------------------------------------------------------------------------

/// One row about a target, ready to print.
#[derive(Debug, Clone)]
struct RowEntry {
    /// Concept file uuid.
    concept_id: String,
    /// Resolver path, e.g. `Lens Edu/Concepts/Low-stakes control.md`.
    concept_path: String,
    concept_name: String,
    /// 1-based line of the row heading in the concept file (its `read` view).
    line: usize,
    body: String,
}

/// The rows about one target file.
#[derive(Debug, Default)]
struct CollectedRows {
    rows: Vec<RowEntry>,
    /// Concept files that link the target only outside a row heading.
    mentions: Vec<String>,
    /// Concept files linking the target that were not read: over a cap, or
    /// they could not be loaded.
    skipped: usize,
}

/// The rows about one of a lens's sources (an article or a video).
#[derive(Debug, Clone)]
struct SourceRows {
    source_path: String,
    /// "article" or "video".
    kind: &'static str,
    rows: Vec<RowEntry>,
}

#[derive(Debug)]
struct LensRowGroups {
    /// One per lens row, with its concept's rows about the sources (only on
    /// the concept's first lens row, and only sources that have a row there).
    lens: Vec<(RowEntry, Vec<SourceRows>)>,
    /// One per concept with rows about the sources but none about the lens:
    /// its concept file and those rows per source, by concept name.
    source_only: Vec<(String, Vec<SourceRows>)>,
}

/// A lens's rows grouped by concept, as the editor's `groupLensRows`: a
/// concept with a lens row shows once, its source rows under the lens row; a
/// concept with only source rows also shows once, however many of the
/// sources it has rows for. Lens rows keep their order; the others go by
/// concept name.
fn group_lens_rows(own: &[RowEntry], sources: &[SourceRows]) -> LensRowGroups {
    let for_concept = |concept_id: &str| -> Vec<SourceRows> {
        sources
            .iter()
            .map(|s| SourceRows {
                source_path: s.source_path.clone(),
                kind: s.kind,
                rows: s
                    .rows
                    .iter()
                    .filter(|r| r.concept_id == concept_id)
                    .cloned()
                    .collect(),
            })
            .filter(|s| !s.rows.is_empty())
            .collect()
    };
    let mut seen: HashSet<&str> = HashSet::new();
    let lens = own
        .iter()
        .map(|entry| {
            let source_rows = if seen.insert(entry.concept_id.as_str()) {
                for_concept(&entry.concept_id)
            } else {
                Vec::new()
            };
            (entry.clone(), source_rows)
        })
        .collect();
    // Concepts with source rows only: (id, name, path), once each.
    let mut others: Vec<(&str, &str, &str)> = Vec::new();
    for row in sources.iter().flat_map(|s| &s.rows) {
        let id = row.concept_id.as_str();
        if !seen.contains(id) && !others.iter().any(|o| o.0 == id) {
            others.push((id, &row.concept_name, &row.concept_path));
        }
    }
    others.sort_by(|a, b| by_concept_name(a.1, b.1).then_with(|| a.2.cmp(b.2)));
    let source_only = others
        .into_iter()
        .map(|(id, _, path)| (path.to_string(), for_concept(id)))
        .collect();
    LensRowGroups { lens, source_only }
}

/// `Concepts/Low-stakes control.md` → `Low-stakes control`.
pub(super) fn file_name(path: &str) -> String {
    without_terminal_md(path.rsplit('/').next().unwrap_or(path)).to_string()
}

/// Concept names in display order: lower case first (rule #9), then as written.
pub(super) fn by_concept_name(a: &str, b: &str) -> std::cmp::Ordering {
    // Names equal but for case: lower case first, as the editor's
    // `localeCompare` orders them. Non-ASCII names may sort slightly
    // differently from the editor (cosmetic).
    a.to_lowercase()
        .cmp(&b.to_lowercase())
        .then_with(|| b.cmp(a))
}

/// A row of a concept file, its heading link resolved once per `read`.
struct ResolvedRow {
    /// The uuid of the document the heading link resolves to, if any.
    target_id: Option<String>,
    line: usize,
    body: String,
}

/// A concept file parsed and resolved once per `read`. The text parsed is
/// the file's `read` view (pending suggestions accepted, canonical
/// concept-row rules v1 #6), so row line numbers match a `read` of the
/// concept file. A heading that exists only inside a pending suggestion is
/// therefore a row in the editor (which parses the raw text) but not here:
/// an accepted divergence.
struct ParsedConcept {
    path: String,
    name: String,
    rows: Vec<ResolvedRow>,
}

/// Loads, parses and resolves concept files once per `read`, within
/// [`MAX_CONCEPT_FILES_TOTAL`]; per-target collection then only filters. A
/// file that could not be loaded is kept as `None`.
struct ConceptLoader<'a> {
    server: &'a Arc<Server>,
    index: &'a VirtualTreeIndex<'a>,
    section: &'static str,
    loaded: HashMap<String, Option<ParsedConcept>>,
}

impl<'a> ConceptLoader<'a> {
    fn new(
        server: &'a Arc<Server>,
        index: &'a VirtualTreeIndex<'a>,
        section: &'static str,
    ) -> Self {
        Self {
            server,
            index,
            section,
            loaded: HashMap::new(),
        }
    }

    /// Load the given concept files that are not loaded yet, as many as the
    /// total cap leaves room for.
    async fn load(&mut self, concepts: &[(String, String)]) {
        let room = MAX_CONCEPT_FILES_TOTAL.saturating_sub(self.loaded.len());
        let wanted: Vec<(String, String)> = concepts
            .iter()
            .filter(|(id, _)| !self.loaded.contains_key(id))
            .take(room)
            .cloned()
            .collect();
        let server = self.server;
        let texts: Vec<(String, String, Option<String>)> = futures::stream::iter(wanted)
            .map(|(id, path)| async move {
                let text = load_text(server, &path).await;
                (id, path, text)
            })
            .buffer_unordered(LOAD_CONCURRENCY)
            .collect()
            .await;
        for (id, path, text) in texts {
            let parsed = text.map(|text| self.parse(path, &text));
            self.loaded.insert(id, parsed);
        }
    }

    fn parse(&self, path: String, text: &str) -> ParsedConcept {
        let source_virtual = format!("/{}", path);
        let rows = parse_concept_file(text, self.section)
            .into_iter()
            .map(|row| ResolvedRow {
                target_id: self
                    .index
                    .resolve(&row.target, Some(&source_virtual))
                    .map(|e| e.id.clone()),
                line: row.line,
                body: text[row.body_from..row.body_to].to_string(),
            })
            .collect();
        ParsedConcept {
            name: file_name(&path),
            path,
            rows,
        }
    }
}

/// The accepted view of the Markdown document at resolver path `path`, loaded
/// as `read` loads it (reloaded from storage after GC eviction); None if it
/// could not be loaded.
pub(super) async fn load_text(server: &Arc<Server>, path: &str) -> Option<String> {
    let info = server.doc_resolver().resolve_path(path)?;
    if let Err(e) = server.ensure_doc_loaded(&info.doc_id).await {
        tracing::warn!("concept rows: failed to load {}: {}", path, e);
        return None;
    }
    let awareness = server.docs().get(&info.doc_id).map(|d| d.awareness())?;
    let raw = {
        let guard = awareness.read().unwrap_or_else(|e| e.into_inner());
        let txn = guard.doc.transact();
        txn.get_text("contents")
            .map(|t| t.get_string(&txn))
            .unwrap_or_default()
    };
    let spans = critic_markup::parse(&raw);
    Some(critic_markup::accepted_view(&spans))
}

/// The concept files (uuid, resolver path) among the documents linking to
/// `target_uuid`, from the backlinks index, sorted by path.
async fn concept_backlinkers(
    server: &Arc<Server>,
    rule: &ConceptRowRule,
    folder_doc_id: &str,
    target_uuid: &str,
) -> Vec<(String, String)> {
    let folder = rows_folder(rule);
    let resolver = server.doc_resolver();
    let mut candidates: Vec<(String, String)> =
        get_links::read_backlink_uuids(server, folder_doc_id, target_uuid)
            .await
            .into_iter()
            .filter(|id| id != target_uuid)
            .filter_map(|id| {
                let path = resolver.path_for_uuid(&id)?;
                (path.starts_with(&folder) && is_md(&path)).then_some((id, path))
            })
            .collect();
    candidates.sort_by(|a, b| a.1.cmp(&b.1));
    candidates.dedup();
    candidates
}

/// The concept files (uuid, resolver path) linking to `target_uuid`, sorted
/// by path: [`concept_backlinkers`] for the concepts folder.
pub(super) async fn concepts_linking_to(
    server: &Arc<Server>,
    folder_doc_id: &str,
    target_uuid: &str,
) -> Vec<(String, String)> {
    concept_backlinkers(server, &CONCEPT_ROW_RULES[0], folder_doc_id, target_uuid).await
}

/// The rows about the file `target_uuid` among its concept backlinkers
/// `candidates`, loading those not loaded yet.
async fn collect_rows(
    loader: &mut ConceptLoader<'_>,
    mut candidates: Vec<(String, String)>,
    target_uuid: &str,
) -> CollectedRows {
    let mut out = CollectedRows {
        skipped: candidates
            .len()
            .saturating_sub(MAX_CONCEPT_FILES_PER_TARGET),
        ..Default::default()
    };
    candidates.truncate(MAX_CONCEPT_FILES_PER_TARGET);
    loader.load(&candidates).await;

    for (id, _) in &candidates {
        // Over the total cap, or it could not be loaded: say so.
        let Some(Some(concept)) = loader.loaded.get(id) else {
            out.skipped += 1;
            continue;
        };
        let mut found = false;
        for row in &concept.rows {
            if row.target_id.as_deref() != Some(target_uuid) {
                continue;
            }
            found = true;
            out.rows.push(RowEntry {
                concept_id: id.clone(),
                concept_path: concept.path.clone(),
                concept_name: concept.name.clone(),
                line: row.line,
                body: row.body.clone(),
            });
        }
        if !found {
            out.mentions.push(concept.path.clone());
        }
    }
    // Stable: a concept's rows keep their order in the file.
    out.rows
        .sort_by(|a, b| by_concept_name(&a.concept_name, &b.concept_name));
    out.mentions.sort_by(|a, b| by_concept_name(a, b));
    out
}

/// Every Markdown document and HTML page the resolver knows, as the tree
/// wikilinks resolve in. Built from the resolver's path map, so it takes no
/// document locks. A Markdown document is a `.md` path without a blob hash,
/// as filemeta's "markdown" entries are; sorted by path, so that of two paths
/// differing only in case the same one always wins.
pub(super) fn resolver_entries(server: &Arc<Server>) -> Vec<VirtualEntry> {
    let mut entries: Vec<VirtualEntry> = server
        .doc_resolver()
        .entries_under("")
        .into_iter()
        .map(|(path, info)| VirtualEntry {
            entry_type: if info.hash.is_none() && is_md(&path) {
                "markdown"
            } else {
                "file"
            }
            .to_string(),
            virtual_path: format!("/{path}"),
            id: info.uuid,
            folder_idx: 0,
        })
        .collect();
    entries.sort_by(|a, b| a.virtual_path.cmp(&b.virtual_path));
    entries
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const BLOCK_START: &str =
    "── Concept relationships for this file (context — NOT part of this file's text) ──";
const BLOCK_END: &str = "── end of concept relationships ──";
const PREAMBLE: &str = "Each row lives in the named concept file under ## Relationships; edit it there, never here. Line numbers below the end marker are this file's own.";

/// A row's text indented by `indent`, cut at [`MAX_ROW_CHARS`].
fn render_body(out: &mut String, entry: &RowEntry, indent: &str) {
    // Leading blank lines and trailing whitespace go; the first line keeps
    // its indentation.
    let body = entry.body.trim_end();
    let body = match body.find(|c: char| !c.is_whitespace()) {
        Some(first) => &body[body[..first].rfind('\n').map_or(0, |i| i + 1)..],
        None => "",
    };
    if body.is_empty() {
        out.push_str(indent);
        out.push_str("(empty)\n");
        return;
    }
    let (shown, cut) = match body.char_indices().nth(MAX_ROW_CHARS) {
        Some((i, _)) => (&body[..i], true),
        None => (body, false),
    };
    for line in shown.lines() {
        if !line.is_empty() {
            out.push_str(indent);
            out.push_str(line);
        }
        out.push('\n');
    }
    if cut {
        out.push_str(&format!(
            "{indent}[… cut at {MAX_ROW_CHARS} characters — read {} from line {} for the rest]\n",
            entry.concept_path, entry.line
        ));
    }
}

fn render_skipped(out: &mut String, skipped: usize, what: &str) {
    if skipped > 0 {
        out.push_str(&format!(
            "({skipped} more concept file(s) link to {what} but were not read; use get_links to list them.)\n"
        ));
    }
}

fn render_mentions(out: &mut String, mentions: &[String], opened_label: &str) {
    if !mentions.is_empty() {
        out.push_str(&format!(
            "\nAlso mentioned (a link to {opened_label} outside any row) in: {}\n",
            mentions.join(", ")
        ));
    }
}

/// The block for a file without source context (an article or video).
fn render_simple(own: &CollectedRows, opened_label: &str) -> String {
    let mut out = String::new();
    for entry in &own.rows {
        out.push_str(&format!(
            "\n[Concept] {} (row at line {})\n",
            entry.concept_path, entry.line
        ));
        render_body(&mut out, entry, "  ");
    }
    render_mentions(&mut out, &own.mentions, opened_label);
    render_skipped(&mut out, own.skipped, opened_label);
    out
}

/// A row about one of a lens's sources, as a sub-entry under its concept.
fn render_source_row(out: &mut String, source: &SourceRows, row: &RowEntry) {
    out.push_str(&format!(
        "  ▸ Row about its {} {} (line {}) — context, not about this lens:\n",
        source.kind, source.source_path, row.line
    ));
    render_body(out, row, "    ");
}

/// The block for a lens: per concept its lens row, then its rows about the
/// lens's sources; then, once each, the concepts that have rows only about
/// the lens's sources.
fn render_lens(
    own: &CollectedRows,
    sources: &[(SourceRows, usize)],
    sources_over_cap: usize,
    opened_label: &str,
) -> String {
    let source_rows: Vec<SourceRows> = sources.iter().map(|(s, _)| s.clone()).collect();
    let groups = group_lens_rows(&own.rows, &source_rows);
    let mut out = String::new();
    for (entry, source_rows) in &groups.lens {
        if source_rows.is_empty() {
            out.push_str(&format!(
                "\n[Concept] {} (row at line {})\n",
                entry.concept_path, entry.line
            ));
            render_body(&mut out, entry, "  ");
            continue;
        }
        out.push_str(&format!("\n[Concept] {}\n", entry.concept_path));
        out.push_str(&format!(
            "  ▸ Row about {opened_label} (line {}):\n",
            entry.line
        ));
        render_body(&mut out, entry, "    ");
        for source in source_rows {
            for row in &source.rows {
                render_source_row(&mut out, source, row);
            }
        }
    }
    render_mentions(&mut out, &own.mentions, opened_label);
    render_skipped(&mut out, own.skipped, opened_label);

    if !groups.source_only.is_empty() {
        out.push_str(
            "\nConcepts linked only via this lens's sources (rows about a source — context, not about this lens; no row for this lens yet):\n",
        );
    }
    for (concept_path, source_rows) in &groups.source_only {
        out.push_str(&format!("\n[Concept] {concept_path}\n"));
        for source in source_rows {
            for row in &source.rows {
                render_source_row(&mut out, source, row);
            }
        }
    }
    for (source, skipped) in sources {
        render_skipped(&mut out, *skipped, &source.source_path);
    }
    if sources_over_cap > 0 {
        out.push_str(&format!(
            "({sources_over_cap} more source(s) of this lens not shown; at most {MAX_LENS_SOURCES} are followed.)\n"
        ));
    }
    out
}

/// `body` cut at a line end within [`MAX_BLOCK_CHARS`], with a note.
fn cap_block(body: String) -> String {
    let Some((limit, _)) = body.char_indices().nth(MAX_BLOCK_CHARS) else {
        return body;
    };
    let cut = body[..limit].rfind('\n').map_or(limit, |i| i + 1);
    format!(
        "{}\n(… truncated at {MAX_BLOCK_CHARS} characters — read the concept files listed above, or use get_links, for the rest.)\n",
        &body[..cut]
    )
}

/// Whether a concept file may link to one of a lens's sources, found before
/// the link index is built: each source is looked up by its exact path
/// (relative to the lens, then from the folder root) in the resolver's path
/// map, and widgets and other files without rows are passed over. A source
/// not found that way (other case, or missing) is left to the index. Only a
/// file whose name differs from a found one by case alone could be missed.
async fn sources_may_have_rows(
    server: &Arc<Server>,
    rule: &ConceptRowRule,
    lens_virtual: &str,
    targets: &[String],
) -> bool {
    let resolver = server.doc_resolver();
    for target in targets {
        let paths = [
            link_indexer::resolve_relative(lens_virtual, target),
            format!("/{}.md", without_terminal_md(target)),
        ];
        let found = paths.iter().find_map(|p| {
            let p = p.trim_start_matches('/');
            resolver.resolve_path(p).map(|info| (p.to_string(), info))
        });
        let Some((path, info)) = found else {
            return true;
        };
        if source_kind(&path).is_some()
            && !concept_backlinkers(server, rule, &info.folder_doc_id, &info.uuid)
                .await
                .is_empty()
        {
            return true;
        }
    }
    false
}

/// A lens source (an article or video) and its concept backlinkers.
struct Source {
    path: String,
    kind: &'static str,
    id: String,
    candidates: Vec<(String, String)>,
}

/// The concept-relationships block for the Markdown file `path` (resolver
/// path) with uuid `uuid` in folder doc `folder_doc_id`, whose `read` text is
/// `text`; None when no rule covers the file or no concept file links to it
/// (or, for a lens, to one of its articles and videos).
pub(crate) async fn concept_rows_block(
    server: &Arc<Server>,
    path: &str,
    uuid: &str,
    folder_doc_id: &str,
    text: &str,
) -> Option<String> {
    let rule = match_rule(path)?;
    let own_candidates = concept_backlinkers(server, rule, folder_doc_id, uuid).await;
    let source_targets = if rule.source_context {
        lens_source_targets(text)
    } else {
        Vec::new()
    };
    let lens_virtual = format!("/{}", path);
    if own_candidates.is_empty()
        && !sources_may_have_rows(server, rule, &lens_virtual, &source_targets).await
    {
        return None;
    }

    // The lens's articles and videos, each with its concept backlinkers.
    let resolver = server.doc_resolver();
    let entries = resolver_entries(server);
    let index = VirtualTreeIndex::new(&entries);
    let mut sources: Vec<Source> = Vec::new();
    let mut sources_over_cap = 0;
    for target in &source_targets {
        let Some(entry) = index.resolve(target, Some(&lens_virtual)) else {
            continue;
        };
        let source_path = entry.virtual_path[1..].to_string();
        let Some(kind) = source_kind(&source_path) else {
            continue; // a widget, or anything else without rows of its own
        };
        if entry.id == uuid || sources.iter().any(|s| s.id == entry.id) {
            continue;
        }
        if sources.len() >= MAX_LENS_SOURCES {
            sources_over_cap += 1;
            continue;
        }
        let Some(info) = resolver.resolve_path(&source_path) else {
            continue;
        };
        let candidates = concept_backlinkers(server, rule, &info.folder_doc_id, &entry.id).await;
        sources.push(Source {
            path: source_path,
            kind,
            id: entry.id.clone(),
            candidates,
        });
    }
    // No concept file links here or to a source: nothing to load.
    if own_candidates.is_empty() && sources.iter().all(|s| s.candidates.is_empty()) {
        return None;
    }

    let mut loader = ConceptLoader::new(server, &index, rule.section);
    let own = collect_rows(&mut loader, own_candidates, uuid).await;
    let mut source_rows: Vec<(SourceRows, usize)> = Vec::new();
    for source in sources {
        let rows = collect_rows(&mut loader, source.candidates, &source.id).await;
        source_rows.push((
            SourceRows {
                source_path: source.path,
                kind: source.kind,
                rows: rows.rows,
            },
            rows.skipped,
        ));
    }

    let any_source_rows = source_rows
        .iter()
        .any(|(s, n)| !s.rows.is_empty() || *n > 0);
    if own.rows.is_empty() && own.mentions.is_empty() && own.skipped == 0 && !any_source_rows {
        return None;
    }
    let opened_label = format!("this {}", rule.kind);
    let body = if rule.source_context {
        render_lens(&own, &source_rows, sources_over_cap, &opened_label)
    } else {
        render_simple(&own, &opened_label)
    };
    Some(format!(
        "{BLOCK_START}\n{PREAMBLE}\n{}\n{BLOCK_END}",
        cap_block(body)
    ))
}

#[cfg(test)]
mod parser_tests {
    //! Ported from lens-editor/src/lib/concept-rows.test.ts and
    //! lens-platform content_processor/src/concepts.test.ts.
    use super::*;

    const CONCEPT: &str = "---
topic:
  - \"[[../Domains and Topics/7 AI Control/Control protocols]]\"
# not a heading: inside frontmatter
---
# Low-stakes control

Control where no single bad action is catastrophic. Contrast [[../articles/lw-post-on-monitoring]].

## Relationships

### [[../articles/ai-control-redwood]]
Best intro we have. §2 is the explanation; §4 drifts into high-stakes.

#### A sub-heading stays in the row
More notes.

### [[../articles/lw-post-on-monitoring|the LW post]]
Uses the term once in passing.

### [[../Lenses/Low-stakes control intro]]
Uses §1–3 of the Redwood article.

## See also
### [[../articles/ai-control-redwood]]
Not a row: outside the Relationships section.
";

    fn targets(text: &str) -> Vec<String> {
        parse_concept_file(text, "Relationships")
            .into_iter()
            .map(|r| r.target)
            .collect()
    }

    #[test]
    fn finds_level3_link_headings_under_relationships() {
        assert_eq!(
            targets(CONCEPT),
            vec![
                "../articles/ai-control-redwood",
                "../articles/lw-post-on-monitoring",
                "../Lenses/Low-stakes control intro",
            ]
        );
    }

    #[test]
    fn row_runs_to_next_heading_of_level_3_or_less_keeping_deeper_headings() {
        let rows = parse_concept_file(CONCEPT, "Relationships");
        let (first, last) = (&rows[0], &rows[2]);
        assert_eq!(
            &CONCEPT[first.body_from..first.body_to],
            "Best intro we have. §2 is the explanation; §4 drifts into high-stakes.\n\n#### A sub-heading stays in the row\nMore notes."
        );
        assert_eq!(
            &CONCEPT[last.body_from..last.body_to],
            "Uses §1–3 of the Redwood article."
        );
    }

    #[test]
    fn records_the_heading_line() {
        let first = &parse_concept_file(CONCEPT, "Relationships")[0];
        assert_eq!(
            CONCEPT.split('\n').nth(first.line - 1),
            Some("### [[../articles/ai-control-redwood]]")
        );
    }

    #[test]
    fn ignores_headings_that_are_not_a_single_link_and_headings_in_code() {
        let text =
            "## Relationships\n\n### About [[x]]\nno\n\n```\n### [[y]]\n```\n### [[z#Part]]\nyes\n";
        assert_eq!(targets(text), vec!["z"]);
    }

    #[test]
    fn matches_the_relationships_heading_case_sensitively() {
        assert!(targets("## relationships\n\n### [[x]]\n").is_empty());
    }

    #[test]
    fn no_rows_without_a_relationships_section() {
        assert!(parse_concept_file("# C\n\n### [[x]]\n", "Relationships").is_empty());
    }

    #[test]
    fn an_empty_row_has_an_empty_body() {
        let text = "## Relationships\n\n### [[x]]\n\n### [[y]]";
        let rows = parse_concept_file(text, "Relationships");
        let (x, y) = (&rows[0], &rows[1]);
        assert_eq!(x.body_from, x.body_to);
        assert_eq!(y.body_from, text.len());
    }

    // From the platform validator: only level-3 headings in the section count,
    // and an underscore in a path survives.
    #[test]
    fn counts_only_level3_headings_under_relationships() {
        let text = "# C\n\n### [[../articles/ai_control_redwood]]\nbefore\n\n## Relationships\n\n### [[../articles/ai_control_redwood]]\nNotes.\n\n#### [[../articles/ai_control_redwood]]\nDeeper.\n\n### [[../articles/ai_control_redwood]]\nAgain.\n\n## See also\n\n### [[../articles/ai_control_redwood]]\n";
        let rows = parse_concept_file(text, "Relationships");
        assert_eq!(rows.iter().map(|r| r.line).collect::<Vec<_>>(), vec![8, 14]);
        assert_eq!(rows[0].target, "../articles/ai_control_redwood");
    }

    #[test]
    fn crlf_line_endings() {
        let text = "## Relationships\r\n\r\n### [[a]]\r\nNote.\r\n";
        let rows = parse_concept_file(text, "Relationships");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].target, "a");
        // As in the editor, the body starts after the heading's `\r`; the
        // block trims it.
        assert_eq!(text[rows[0].body_from..rows[0].body_to].trim(), "Note.");
    }

    #[test]
    fn link_page_strips_alias_and_anchor() {
        assert_eq!(link_page("a/b#H|Alias"), "a/b");
        assert_eq!(link_page(" x |y"), "x");
        assert_eq!(link_page("|y"), "");
    }

    #[test]
    fn match_rule_matches_articles_videos_and_lenses_in_lens_edu_only() {
        assert_eq!(
            match_rule("Lens Edu/articles/x.md").map(|r| r.kind),
            Some("article")
        );
        assert_eq!(
            match_rule("Lens Edu/video_transcripts/x.md").map(|r| r.kind),
            Some("video")
        );
        assert!(match_rule("Lens Edu/Lenses/x.md").is_some_and(|r| r.source_context));
        assert!(match_rule("Lens Edu/Concepts/x.md").is_none());
        assert!(match_rule("Lens Edu/widgets/x.md").is_none());
        assert!(match_rule("Lens/articles/x.md").is_none());
        assert!(match_rule("Lens Edu/articles/x.html").is_none());
        assert_eq!(rows_shared_folders(), vec!["Lens Edu"]);
    }

    #[test]
    fn source_kinds_come_from_the_rules() {
        assert_eq!(source_kind("Lens Edu/articles/a.md"), Some("article"));
        assert_eq!(
            source_kind("Lens Edu/video_transcripts/v.md"),
            Some("video")
        );
        assert_eq!(source_kind("Lens Edu/Lenses/l.md"), None);
        assert_eq!(source_kind("Lens Edu/widgets/quiz.html"), None);
    }

    #[test]
    fn lens_source_targets_editor_line_scanner_details() {
        // No space after `::`; a link on the next line is ignored; only a
        // level-4 "Text" heading marks a text section; frontmatter whose
        // opening `---` has trailing whitespace is skipped.
        let lens = "--- \nsource:: [[../articles/in-frontmatter]]\n---\nsource::[[../articles/no-space]]\nsource::\n[[../articles/next-line]]\n### Text\nsource:: [[../articles/level-3-text-is-not-text]]\n#### Text:\nsource:: [[../articles/text-colon-is-not-text]]\n#### Text\nsource:: [[../articles/in-text]]\n";
        assert_eq!(
            lens_source_targets(lens),
            vec![
                "../articles/no-space",
                "../articles/level-3-text-is-not-text",
                "../articles/text-colon-is-not-text"
            ]
        );
    }

    #[test]
    fn closing_hashes_end_a_heading() {
        let text =
            "## Relationships ##\n\n### [[a]] ###\nA\n### [[b]]#\nnot a row\n### [[c|C]] #  \nC\n";
        assert_eq!(targets(text), vec!["a", "c"]);
        assert_eq!(strip_closing_hashes("###"), "");
        assert_eq!(strip_closing_hashes("[[x]]#"), "[[x]]#");
    }

    // canonical concept-row rules v1 #1
    #[test]
    fn canonical_1_every_relationships_section_counts() {
        let text = "## Relationships\n### [[a]]\n## Notes\n### [[x]]\n## Relationships ##\n### [[b]]\n## *Relationships*\n### [[y]]\n";
        assert_eq!(targets(text), vec!["a", "b"]);
    }

    // canonical concept-row rules v1 #2
    #[test]
    fn canonical_2_section_ends_at_next_level_1_or_2_heading() {
        assert_eq!(
            targets("## Relationships\n#### deep\n### [[a]]\n# Top\n### [[b]]\n"),
            vec!["a"]
        );
    }

    // canonical concept-row rules v1 #3
    #[test]
    fn canonical_3_row_is_a_level3_single_link_heading() {
        let text = "## Relationships\n   ### [[a|A]] ###\n    ### [[indented-code]]\n### ![[embed]]\n### [[#heading]]\n### [[b#Part]]\n### [[c]] notes\n";
        assert_eq!(targets(text), vec!["a", "b"]);
    }

    // canonical concept-row rules v1 #4
    #[test]
    fn canonical_4_row_body_runs_to_next_heading_of_level_3_or_less() {
        let text = "## Relationships\n### [[a]]\nOne\n#### Sub\nTwo\n### [[b]]\nThree\n";
        let a = &parse_concept_file(text, "Relationships")[0];
        assert_eq!(&text[a.body_from..a.body_to], "One\n#### Sub\nTwo");
    }

    // canonical concept-row rules v1 #5
    #[test]
    fn canonical_5_no_headings_in_ignored_regions() {
        let text = [
            "---",
            "title: x",
            "### [[fm]]",
            "---  ",
            "## Relationships",
            "````",
            "### [[f1]]",
            "```",
            "### [[f2]]",
            "```` x",
            "### [[f3]]",
            "````", // only a bare, long-enough fence closes
            "    ```",
            "### [[after-indented-fence]]",
            "%% a comment",
            "### [[c1]]",
            "%%",
            "Inline %%### [[c2]]%% text",
            "- item",
            "  ### [[in-list]]",
            "> ### [[quoted]]",
            "~~~ js",
            "### [[t1]]",
            "~~~",
            "### [[real]]",
        ]
        .join("\n");
        assert_eq!(targets(&text), vec!["after-indented-fence", "real"]);
    }

    // canonical concept-row rules v1 #6: the relay parses the read view, with
    // pending suggestions accepted, so a heading that a pending deletion
    // removes is not a row here (the editor, parsing raw text, keeps it: an
    // accepted divergence).
    #[test]
    fn canonical_6_rows_come_from_the_accepted_view() {
        let text = "## Relationships\n{--\n### [[deleted-but-pending]]\n--}\n";
        let accepted = critic_markup::accepted_view(&critic_markup::parse(text));
        assert!(targets(&accepted).is_empty());
        assert_eq!(targets(text), vec!["deleted-but-pending"]);
    }

    // canonical concept-row rules v1 #7
    #[test]
    fn canonical_7_rows_match_by_resolved_document() {
        let entry = |path: &str, id: &str| VirtualEntry {
            virtual_path: path.into(),
            entry_type: "markdown".into(),
            id: id.into(),
            folder_idx: 0,
        };
        let entries = vec![
            entry("/Lens Edu/Concepts/Low-stakes control.md", "c1"),
            entry("/Lens Edu/articles/ai-control-redwood.md", "a1"),
            entry("/Lens Edu/articles/lw-post-on-monitoring.md", "a2"),
        ];
        let index = VirtualTreeIndex::new(&entries);
        let text = "## Relationships\n### [[../ARTICLES/Ai-Control-Redwood]]\n### [[Lens Edu/articles/lw-post-on-monitoring]]\n";
        let ids: Vec<Option<String>> = parse_concept_file(text, "Relationships")
            .iter()
            .map(|r| {
                index
                    .resolve(&r.target, Some("/Lens Edu/Concepts/Low-stakes control.md"))
                    .map(|e| e.id.clone())
            })
            .collect();
        assert_eq!(ids, vec![Some("a1".to_string()), Some("a2".to_string())]);
    }

    // canonical concept-row rules v1 #8
    #[test]
    fn canonical_8_lens_sources() {
        let lens = [
            "source:: [[../articles/before-heading]]",
            "#### Article",
            "source:: [[../articles/one.md|One]]",
            "source:: [[../video_transcripts/talk]] and [[../articles/second-link-ignored]]",
            "#### Text",
            "content::",
            "source:: [[../articles/prose]]",
            "#### Widget",
            "source:: [[../widgets/quiz]]",
        ]
        .join("\r\n");
        assert_eq!(
            lens_source_targets(&lens),
            vec![
                "../articles/before-heading",
                "../articles/one.md",
                "../video_transcripts/talk",
                "../widgets/quiz"
            ]
        );
        assert_eq!(source_kind("Lens Edu/widgets/quiz.html"), None);
    }

    // canonical concept-row rules v1 #9
    #[test]
    fn canonical_9_rows_sort_case_insensitively_by_concept_name() {
        let mut names = vec!["beta", "Alpha"];
        names.sort_by(|a, b| by_concept_name(a, b));
        assert_eq!(names, vec!["Alpha", "beta"]);
        // Equal but for case: lower case first, as localeCompare.
        let mut names = vec!["Alpha", "alpha"];
        names.sort_by(|a, b| by_concept_name(a, b));
        assert_eq!(names, vec!["alpha", "Alpha"]);
    }

    fn entry(concept_id: &str, body: &str) -> RowEntry {
        RowEntry {
            concept_id: concept_id.to_string(),
            concept_path: format!("Lens Edu/Concepts/{concept_id}.md"),
            concept_name: concept_id.to_string(),
            line: 1,
            body: body.to_string(),
        }
    }

    fn source(name: &str, rows: Vec<RowEntry>) -> SourceRows {
        SourceRows {
            source_path: name.to_string(),
            kind: "article",
            rows,
        }
    }

    #[test]
    fn group_puts_concept_with_lens_and_source_rows_once() {
        let own = vec![
            entry("Feedback", "Feedback"),
            entry("Low-stakes", "Low-stakes"),
        ];
        let sources = vec![
            source(
                "One",
                vec![
                    entry("Corrigibility", "c"),
                    entry("Feedback", "article note"),
                ],
            ),
            source("Two", vec![entry("Feedback", "second article")]),
        ];
        let groups = group_lens_rows(&own, &sources);
        type Grouped = Vec<(String, Vec<(String, Vec<String>)>)>;
        let lens: Grouped = groups
            .lens
            .iter()
            .map(|(e, a)| {
                let a = a
                    .iter()
                    .map(|a| {
                        (
                            a.source_path.clone(),
                            a.rows.iter().map(|r| r.body.clone()).collect(),
                        )
                    })
                    .collect();
                (e.concept_id.clone(), a)
            })
            .collect();
        assert_eq!(
            lens,
            vec![
                (
                    "Feedback".to_string(),
                    vec![
                        ("One".to_string(), vec!["article note".to_string()]),
                        ("Two".to_string(), vec!["second article".to_string()]),
                    ]
                ),
                ("Low-stakes".to_string(), vec![]),
            ]
        );
        assert_eq!(groups.source_only.len(), 1);
        assert_eq!(
            groups.source_only[0].0,
            "Lens Edu/Concepts/Corrigibility.md"
        );
    }

    #[test]
    fn group_attaches_source_rows_to_the_first_of_several_lens_rows_only() {
        let groups = group_lens_rows(
            &[entry("C", ""), entry("C", "")],
            &[source("A", vec![entry("C", "")])],
        );
        let counts: Vec<usize> = groups.lens.iter().map(|(_, a)| a.len()).collect();
        assert_eq!(counts, vec![1, 0]);
    }

    #[test]
    fn group_shows_each_source_only_concept_once_by_name() {
        let groups = group_lens_rows(
            &[],
            &[
                source("S1", vec![entry("b", "1"), entry("A", "2")]),
                source("S2", vec![entry("b", "3")]),
            ],
        );
        assert!(groups.lens.is_empty());
        let shape: Vec<(&str, Vec<&str>)> = groups
            .source_only
            .iter()
            .map(|(path, sources)| {
                (
                    path.as_str(),
                    sources.iter().map(|s| s.source_path.as_str()).collect(),
                )
            })
            .collect();
        assert_eq!(
            shape,
            vec![
                ("Lens Edu/Concepts/A.md", vec!["S1"]),
                ("Lens Edu/Concepts/b.md", vec!["S1", "S2"]),
            ]
        );
    }

    #[test]
    fn row_text_keeps_the_first_lines_indentation() {
        let e = entry("C", "\n\n    code line\nnext\n\n");
        let mut out = String::new();
        render_body(&mut out, &e, "  ");
        assert_eq!(out, "      code line\n  next\n");
    }

    #[test]
    fn long_row_text_is_cut_with_a_pointer() {
        let mut e = entry("C", &"é".repeat(MAX_ROW_CHARS + 50));
        e.line = 7;
        let mut out = String::new();
        render_body(&mut out, &e, "  ");
        assert!(out.contains(&"é".repeat(MAX_ROW_CHARS)));
        assert!(!out.contains(&"é".repeat(MAX_ROW_CHARS + 1)));
        assert!(out.contains("read Lens Edu/Concepts/C.md from line 7"));
    }

    #[test]
    fn block_is_cut_at_a_line_end_within_the_cap() {
        let line = format!("{}\n", "x".repeat(99));
        let body = line.repeat(MAX_BLOCK_CHARS / 100 + 10);
        let out = cap_block(body);
        let (kept, note) = out.split_once("\n(… truncated").expect("note");
        assert!(kept.chars().count() <= MAX_BLOCK_CHARS);
        assert!(kept.ends_with(&line));
        assert!(note.contains("use get_links"));
        assert_eq!(cap_block("short\n".to_string()), "short\n");
    }
}

#[cfg(test)]
mod read_tests {
    //! `read` with concept rows, on a server whose backlinks the link indexer built.
    use super::*;
    use crate::mcp::tools::test_helpers::*;
    use crate::mcp::tools::{edit, read};
    use serde_json::json;

    const C_LOW: &str = "---
topic:
  - \"[[../Domains and Topics/7 AI Control/Control protocols]]\"
---
# Low-stakes control

Mentions [[../articles/lw-post-on-monitoring]] in passing.

## Relationships

### [[../articles/ai-control-redwood]]
Best intro we have.

### [[../Lenses/Low-stakes control intro|the lens]]
Lens uses §1–3.

### [[../video_transcripts/control-talk]] ###
The talk covers low-stakes control at 12:00.
";

    const C_FEEDBACK: &str = "# Feedback

## Relationships

### [[../Lenses/Low-stakes control intro]]
FEEDBACK-LENS-ROW: the chat prompt asks for feedback.

### [[../articles/ai-control-redwood.md]]
Feedback is discussed in §3.
";

    const C_CORRIGIBILITY: &str = "# Corrigibility

## Relationships

### [[../articles/ai-control-redwood]]
Only mentions the term once. Not an explanation.

### [[../video_transcripts/control-talk|talk]]
The talk defines corrigibility briefly.

### [[../widgets/quiz]]
WIDGET-ROW: must not show.
";

    const ARTICLE: &str = "# Redwood\n\nArticle body line.\n";
    const LENS: &str = "---\nid: x\n---\n#### Article\nsource:: [[../articles/ai-control-redwood]]\n\n#### Text\ncontent:: Intro words.\n\n#### Video\nsource:: [[../video_transcripts/control-talk]]\n\n#### Widget\nsource:: [[../widgets/quiz]]\n";

    const C_FEEDBACK_ID: &str = "c0000000-0000-4000-8000-000000000002";

    fn fixture() -> Vec<(&'static str, &'static str, &'static str)> {
        vec![
            (
                "/Concepts/Low-stakes control.md",
                "c0000000-0000-4000-8000-000000000001",
                C_LOW,
            ),
            ("/Concepts/Feedback.md", C_FEEDBACK_ID, C_FEEDBACK),
            (
                "/Concepts/Corrigibility.md",
                "c0000000-0000-4000-8000-000000000003",
                C_CORRIGIBILITY,
            ),
            (
                "/articles/ai-control-redwood.md",
                "a0000000-0000-4000-8000-000000000001",
                ARTICLE,
            ),
            (
                "/articles/lw-post-on-monitoring.md",
                "a0000000-0000-4000-8000-000000000002",
                "# LW post\n",
            ),
            (
                "/Lenses/Low-stakes control intro.md",
                "l0000000-0000-4000-8000-000000000001",
                LENS,
            ),
            (
                "/video_transcripts/control-talk.md",
                "v0000000-0000-4000-8000-000000000001",
                "Transcript line one.\n",
            ),
            (
                "/widgets/quiz.md",
                "w0000000-0000-4000-8000-000000000001",
                "Quiz.\n",
            ),
            (
                "/Lenses/Lonely lens.md",
                "l0000000-0000-4000-8000-000000000002",
                "#### Article\nsource:: [[../articles/missing]]\n\nLonely text.\n",
            ),
            (
                "/Lenses/Quiet lens.md",
                "l0000000-0000-4000-8000-000000000004",
                "#### Article\nsource:: [[../articles/quiet]]\n#### Widget\nsource:: [[../widgets/quiz]]\n",
            ),
            (
                "/articles/quiet.md",
                "a0000000-0000-4000-8000-000000000004",
                "Nobody links here.\n",
            ),
            (
                "/Lenses/Corrigible lens.md",
                "l0000000-0000-4000-8000-000000000003",
                "#### Article\nsource:: [[../articles/ai-control-redwood]]\n",
            ),
        ]
    }

    async fn server() -> Arc<Server> {
        build_indexed_test_server_in("Lens Edu", &fixture()).await
    }

    async fn read_at(server: &Arc<Server>, sid: &str, path: &str, offset: Option<u64>) -> String {
        let mut args = json!({ "file_path": path, "session_id": sid });
        if let Some(offset) = offset {
            args["offset"] = json!(offset);
        }
        read::execute(server, sid, &args).await.unwrap()
    }

    async fn read(server: &Arc<Server>, path: &str) -> String {
        let sid = setup_session_no_reads(server);
        read_at(server, &sid, path, None).await
    }

    /// The text after the block: the file's own cat -n lines.
    fn file_part(output: &str) -> &str {
        match output.split_once(&format!("{BLOCK_END}\n\n")) {
            Some((_, rest)) => rest,
            None => output,
        }
    }

    #[tokio::test]
    async fn article_read_starts_with_its_concept_rows() {
        let server = server().await;
        let out = read(&server, "Lens Edu/articles/ai-control-redwood.md").await;
        assert!(
            out.starts_with(&format!("{BLOCK_START}\n{PREAMBLE}\n")),
            "got: {out}"
        );
        // Sorted by concept name; line numbers are the concept files' own.
        let corr = out
            .find("[Concept] Lens Edu/Concepts/Corrigibility.md (row at line 5)\n  Only mentions the term once.")
            .expect("corrigibility row");
        let feedback = out
            .find("[Concept] Lens Edu/Concepts/Feedback.md (row at line 8)\n  Feedback is discussed in §3.")
            .expect("feedback row (link with .md)");
        let low = out
            .find("[Concept] Lens Edu/Concepts/Low-stakes control.md (row at line 11)\n  Best intro we have.")
            .expect("low-stakes row (file with frontmatter)");
        assert!(corr < feedback && feedback < low);
        assert!(!out.contains("FEEDBACK-LENS-ROW"));
        assert!(!out.contains("Lens uses"));
        assert_eq!(
            file_part(&out),
            "     1\t# Redwood\n     2\t\n     3\tArticle body line."
        );
    }

    #[tokio::test]
    async fn lens_read_groups_its_rows_with_its_sources_rows() {
        let server = server().await;
        let out = read(&server, "Lens Edu/Lenses/Low-stakes control intro.md").await;
        let expected = format!(
            "{BLOCK_START}
{PREAMBLE}

[Concept] Lens Edu/Concepts/Feedback.md
  ▸ Row about this lens (line 5):
    FEEDBACK-LENS-ROW: the chat prompt asks for feedback.
  ▸ Row about its article Lens Edu/articles/ai-control-redwood.md (line 8) — context, not about this lens:
    Feedback is discussed in §3.

[Concept] Lens Edu/Concepts/Low-stakes control.md
  ▸ Row about this lens (line 14):
    Lens uses §1–3.
  ▸ Row about its article Lens Edu/articles/ai-control-redwood.md (line 11) — context, not about this lens:
    Best intro we have.
  ▸ Row about its video Lens Edu/video_transcripts/control-talk.md (line 17) — context, not about this lens:
    The talk covers low-stakes control at 12:00.

Concepts linked only via this lens's sources (rows about a source — context, not about this lens; no row for this lens yet):

[Concept] Lens Edu/Concepts/Corrigibility.md
  ▸ Row about its article Lens Edu/articles/ai-control-redwood.md (line 5) — context, not about this lens:
    Only mentions the term once. Not an explanation.
  ▸ Row about its video Lens Edu/video_transcripts/control-talk.md (line 8) — context, not about this lens:
    The talk defines corrigibility briefly.

{BLOCK_END}

     1\t---
     2\tid: x
"
        );
        assert!(out.starts_with(&expected), "got:\n{out}");
        assert!(!out.contains("WIDGET-ROW"));
    }

    #[tokio::test]
    async fn lens_without_own_rows_shows_only_the_source_group() {
        let server = server().await;
        let out = read(&server, "Lens Edu/Lenses/Corrigible lens.md").await;
        assert!(out.starts_with(BLOCK_START), "got: {out}");
        assert!(out.contains("Concepts linked only via this lens's sources"));
        for concept in ["Corrigibility", "Feedback", "Low-stakes control"] {
            assert!(
                out.contains(&format!("[Concept] Lens Edu/Concepts/{concept}.md\n")),
                "missing {concept}: {out}"
            );
        }
        assert!(!out.contains("Row about this lens"));
    }

    #[tokio::test]
    async fn file_without_rows_has_no_block() {
        let server = server().await;
        let out = read(&server, "Lens Edu/Lenses/Lonely lens.md").await;
        assert!(out.starts_with("     1\t#### Article"), "got: {out}");
        // A concept file gets the concept graph block (concept_graph.rs), not rows.
        let out = read(&server, "Lens Edu/Concepts/Feedback.md").await;
        assert!(!out.contains(BLOCK_START), "got: {out}");
        assert!(out.starts_with("── Concept graph"), "got: {out}");
    }

    #[tokio::test]
    async fn plain_mention_only_lists_the_concept_file() {
        let server = server().await;
        let out = read(&server, "Lens Edu/articles/lw-post-on-monitoring.md").await;
        assert!(out.contains(
            "Also mentioned (a link to this article outside any row) in: Lens Edu/Concepts/Low-stakes control.md"
        ), "got: {out}");
        assert!(!out.contains("[Concept]"));
    }

    #[tokio::test]
    async fn second_chunk_of_a_paged_read_has_no_block() {
        let server = server().await;
        let sid = setup_session_no_reads(&server);
        let path = "Lens Edu/articles/ai-control-redwood.md";
        assert!(read_at(&server, &sid, path, Some(1))
            .await
            .starts_with(BLOCK_START));
        let second = read_at(&server, &sid, path, Some(2)).await;
        assert_eq!(second, "     2\t\n     3\tArticle body line.");
    }

    #[tokio::test]
    async fn video_transcript_read_shows_its_rows() {
        let server = server().await;
        let out = read(&server, "Lens Edu/video_transcripts/control-talk.md").await;
        assert!(out.contains(
            "[Concept] Lens Edu/Concepts/Corrigibility.md (row at line 8)\n  The talk defines corrigibility briefly."
        ), "got: {out}");
        // The row heading with closing hashes counts.
        assert!(out.contains(
            "[Concept] Lens Edu/Concepts/Low-stakes control.md (row at line 17)\n  The talk covers low-stakes control at 12:00."
        ));
        assert_eq!(file_part(&out), "     1\tTranscript line one.");
    }

    #[tokio::test]
    async fn edit_after_read_applies_only_to_the_files_own_text() {
        let server = server().await;
        let sid = setup_session_no_reads(&server);
        let lens = "Lens Edu/Lenses/Low-stakes control intro.md";
        let concept = "Lens Edu/Concepts/Feedback.md";
        let concept_doc = format!("{RELAY_ID}-{C_FEEDBACK_ID}");
        let edit_args = |path: &str, old: &str, new: &str| json!({"file_path": path, "session_id": sid, "old_string": old, "new_string": new});
        assert!(read_at(&server, &sid, lens, None)
            .await
            .contains("FEEDBACK-LENS-ROW"));

        // Reading the lens does not count as reading the concept files.
        let err = edit::execute(&server, &sid, &edit_args(concept, "FEEDBACK-LENS-ROW", "X"))
            .await
            .expect_err("concept file was not read");
        assert!(err.contains("must read this document"), "got: {err}");

        // Text shown in the block is not part of the lens.
        for old in [
            "FEEDBACK-LENS-ROW",
            "end of concept relationships",
            "[Concept]",
        ] {
            let err = edit::execute(&server, &sid, &edit_args(lens, old, "X"))
                .await
                .expect_err("block text must not match the lens");
            assert!(err.contains("not found"), "got: {err}");
        }
        assert_eq!(read_doc_content(&server, &concept_doc), C_FEEDBACK);

        // The lens's own text edits as usual, and its lines are unchanged.
        edit::execute(
            &server,
            &sid,
            &edit_args(lens, "Intro words.", "Intro words, now longer."),
        )
        .await
        .expect("edit of the lens's own text");
        let after = read_at(&server, &sid, lens, None).await;
        assert!(file_part(&after).contains("     8\tcontent:: Intro words, now longer."));

        // Editing the row goes through the concept file at the given line.
        let concept_out = read_at(&server, &sid, concept, None).await;
        assert!(concept_out.contains("     6\tFEEDBACK-LENS-ROW"));
        edit::execute(
            &server,
            &sid,
            &edit_args(
                concept,
                "asks for feedback.",
                "asks for feedback. Checked again.",
            ),
        )
        .await
        .expect("edit of the concept file");
        let after = read_at(&server, &sid, lens, None).await;
        assert!(
            after.contains("asks for feedback. Checked again."),
            "got: {after}"
        );
    }

    // canonical concept-row rules v1 #6
    #[tokio::test]
    async fn rows_follow_the_concept_files_pending_suggestions_as_read_does() {
        let server = build_indexed_test_server_in(
            "Lens Edu",
            &[
                (
                    "/Concepts/C.md",
                    "c0000000-0000-4000-8000-000000000009",
                    "# C\n\n## Relationships\n\n### [[../articles/a]]\n{--Old--}{++New++} row.\n",
                ),
                (
                    "/articles/a.md",
                    "a0000000-0000-4000-8000-000000000009",
                    "A\n",
                ),
            ],
        )
        .await;
        let out = read(&server, "Lens Edu/articles/a.md").await;
        assert!(
            out.contains("[Concept] Lens Edu/Concepts/C.md (row at line 5)\n  New row."),
            "got: {out}"
        );
    }

    // canonical concept-row rules v1 #9
    #[tokio::test]
    async fn canonical_9_rows_sort_case_insensitively_in_read() {
        let row = "## Relationships\n### [[../articles/x]]\n";
        let server = build_indexed_test_server_in(
            "Lens Edu",
            &[
                (
                    "/Concepts/beta.md",
                    "c0000000-0000-4000-8000-0000000000cb",
                    row,
                ),
                (
                    "/Concepts/Alpha.md",
                    "c0000000-0000-4000-8000-0000000000ca",
                    row,
                ),
                (
                    "/articles/x.md",
                    "a0000000-0000-4000-8000-0000000000ax",
                    "X\n",
                ),
            ],
        )
        .await;
        let out = read(&server, "Lens Edu/articles/x.md").await;
        let alpha = out.find("Concepts/Alpha.md").expect("Alpha");
        let beta = out.find("Concepts/beta.md").expect("beta");
        assert!(alpha < beta, "got: {out}");
    }

    /// Concept files `C000.md`… each with a row about every target in
    /// `about` (paths relative to Concepts/), plus the given other files.
    fn many_concepts(n: usize, offset: usize, about: &[&str]) -> Vec<(String, String, String)> {
        (0..n)
            .map(|i| {
                let i = i + offset;
                let rows: String = about
                    .iter()
                    .map(|t| format!("### [[{t}]]\nRow {i}.\n"))
                    .collect();
                (
                    format!("/Concepts/C{i:03}.md"),
                    format!("c0000000-0000-4000-8000-{i:012}"),
                    format!("## Relationships\n\n{rows}"),
                )
            })
            .collect()
    }

    fn as_entries(files: &[(String, String, String)]) -> Vec<(&str, &str, &str)> {
        files
            .iter()
            .map(|(p, u, t)| (p.as_str(), u.as_str(), t.as_str()))
            .collect()
    }

    #[tokio::test]
    async fn many_backlinking_concepts_are_capped_per_target_and_counted() {
        let mut files = many_concepts(MAX_CONCEPT_FILES_PER_TARGET + 3, 0, &["../articles/a"]);
        files.push((
            "/articles/a.md".into(),
            "a0000000-0000-4000-8000-0000000000aa".into(),
            "A\n".into(),
        ));
        let server = build_indexed_test_server_in("Lens Edu", &as_entries(&files)).await;
        let out = read(&server, "Lens Edu/articles/a.md").await;
        assert_eq!(
            out.matches("[Concept]").count(),
            MAX_CONCEPT_FILES_PER_TARGET
        );
        assert!(out.contains(
            "(3 more concept file(s) link to this article but were not read; use get_links to list them.)"
        ), "got: {out}");
    }

    #[tokio::test]
    async fn concept_files_are_capped_per_read_in_all() {
        // Three sources with 30 concept files each: 80 are read, the last
        // source's other 10 are counted.
        let mut files = Vec::new();
        for (k, name) in ["s1", "s2", "s3"].iter().enumerate() {
            files.extend(many_concepts(30, k * 30, &[&format!("../articles/{name}")]));
            files.push((
                format!("/articles/{name}.md"),
                format!("a0000000-0000-4000-8000-0000000000{k:02}"),
                "S\n".into(),
            ));
        }
        files.push((
            "/Lenses/L.md".into(),
            "l0000000-0000-4000-8000-0000000000ff".into(),
            "source:: [[../articles/s1]]\nsource:: [[../articles/s2]]\nsource:: [[../articles/s3]]\n".into(),
        ));
        let server = build_indexed_test_server_in("Lens Edu", &as_entries(&files)).await;
        let out = read(&server, "Lens Edu/Lenses/L.md").await;
        assert!(out.contains(
            "(10 more concept file(s) link to Lens Edu/articles/s3.md but were not read; use get_links to list them.)"
        ), "got: {out}");
        assert_eq!(
            out.matches("  ▸ Row about its article").count(),
            MAX_CONCEPT_FILES_TOTAL
        );
    }

    #[tokio::test]
    async fn sources_over_the_cap_are_counted() {
        let n = MAX_LENS_SOURCES + 2;
        let mut files: Vec<(String, String, String)> = (0..n)
            .map(|i| {
                (
                    format!("/articles/s{i:02}.md"),
                    format!("a0000000-0000-4000-8000-0000000001{i:02}"),
                    "S\n".to_string(),
                )
            })
            .collect();
        let about: Vec<String> = (0..n).map(|i| format!("../articles/s{i:02}")).collect();
        let about: Vec<&str> = about.iter().map(String::as_str).collect();
        files.extend(many_concepts(1, 0, &about));
        let lens: String = about
            .iter()
            .map(|t| format!("source:: [[{t}]]\n"))
            .collect();
        files.push((
            "/Lenses/L.md".into(),
            "l0000000-0000-4000-8000-0000000000ff".into(),
            lens,
        ));
        let server = build_indexed_test_server_in("Lens Edu", &as_entries(&files)).await;
        let out = read(&server, "Lens Edu/Lenses/L.md").await;
        assert_eq!(
            out.matches("  ▸ Row about its article").count(),
            MAX_LENS_SOURCES
        );
        assert!(
            out.contains("(2 more source(s) of this lens not shown; at most 8 are followed.)"),
            "got: {out}"
        );
    }

    #[tokio::test]
    async fn block_is_capped_in_size() {
        let long = "y".repeat(MAX_ROW_CHARS);
        let files: Vec<(String, String, String)> = (0..20)
            .map(|i| {
                (
                    format!("/Concepts/C{i:02}.md"),
                    format!("c0000000-0000-4000-8000-{i:012}"),
                    format!("## Relationships\n### [[../articles/a]]\n{long}\n"),
                )
            })
            .chain(std::iter::once((
                "/articles/a.md".to_string(),
                "a0000000-0000-4000-8000-0000000000aa".to_string(),
                "A\n".to_string(),
            )))
            .collect();
        let server = build_indexed_test_server_in("Lens Edu", &as_entries(&files)).await;
        let out = read(&server, "Lens Edu/articles/a.md").await;
        let block = out.split_once(BLOCK_END).expect("block").0;
        assert!(block.chars().count() < MAX_BLOCK_CHARS + 1000);
        assert!(
            block.contains("(… truncated at 20000 characters"),
            "got: {block}"
        );
        assert!(file_part(&out).starts_with("     1\tA"));
    }

    #[tokio::test]
    async fn read_without_concept_backlinkers_loads_no_concept_file() {
        // Concept files evicted from memory stay evicted: a read that no
        // concept file links to (nor to its article; the widget source is
        // not followed) loads none of them.
        let server = build_indexed_store_test_server_in("Lens Edu", &fixture()).await;
        let concept_ids: Vec<String> = fixture()
            .iter()
            .filter(|(p, _, _)| p.starts_with("/Concepts/"))
            .map(|(_, u, _)| format!("{RELAY_ID}-{u}"))
            .collect();
        for id in &concept_ids {
            server.docs().remove(id);
        }
        let out = read(&server, "Lens Edu/Lenses/Quiet lens.md").await;
        assert!(out.starts_with("     1\t#### Article"), "got: {out}");
        let out = read(&server, "Lens Edu/articles/quiet.md").await;
        assert!(out.starts_with("     1\tNobody links here."), "got: {out}");
        for id in &concept_ids {
            assert!(server.docs().get(id).is_none(), "{id} was loaded");
        }
    }

    #[tokio::test]
    async fn gc_evicted_concept_files_are_reloaded() {
        let server = build_indexed_store_test_server_in("Lens Edu", &fixture()).await;
        let feedback = format!("{RELAY_ID}-{C_FEEDBACK_ID}");
        server.docs().remove(&feedback);
        let out = read(&server, "Lens Edu/articles/ai-control-redwood.md").await;
        assert!(out.contains(
            "[Concept] Lens Edu/Concepts/Feedback.md (row at line 8)\n  Feedback is discussed in §3."
        ), "got: {out}");
        assert!(server.docs().get(&feedback).is_some());
    }

    #[tokio::test]
    async fn a_concept_file_that_cannot_be_loaded_is_counted() {
        let server = server().await;
        let entries = resolver_entries(&server);
        let index = VirtualTreeIndex::new(&entries);
        let mut loader = ConceptLoader::new(&server, &index, "Relationships");
        // As load leaves a file whose load failed.
        loader.loaded.insert(C_FEEDBACK_ID.to_string(), None);
        let rule = match_rule("Lens Edu/articles/x.md").unwrap();
        let info = server
            .doc_resolver()
            .resolve_path("Lens Edu/articles/ai-control-redwood.md")
            .unwrap();
        let candidates = concept_backlinkers(&server, rule, &info.folder_doc_id, &info.uuid).await;
        assert_eq!(candidates.len(), 3);
        let rows = collect_rows(&mut loader, candidates, &info.uuid).await;
        assert_eq!(rows.rows.len(), 2);
        assert_eq!(rows.skipped, 1);
        let out = render_simple(&rows, "this article");
        assert!(out.contains("(1 more concept file(s) link to this article but were not read"));
    }

    #[tokio::test]
    async fn resolver_entries_match_the_link_indexer_tree() {
        // The resolver-built tree resolves every fixture link as the
        // folder-doc tree does.
        let server = server().await;
        let ours = resolver_entries(&server);
        let theirs = get_links::all_virtual_entries(&server);
        let (ours, theirs) = (VirtualTreeIndex::new(&ours), VirtualTreeIndex::new(&theirs));
        let from = Some("/Lens Edu/Concepts/Feedback.md");
        for link in [
            "../articles/ai-control-redwood",
            "../articles/AI-control-redwood.md",
            "Lens Edu/Lenses/Low-stakes control intro",
            "../widgets/quiz",
            "../articles/missing",
            "../articles",
        ] {
            assert_eq!(
                ours.resolve(link, from).map(|e| &e.id),
                theirs.resolve(link, from).map(|e| &e.id),
                "{link}"
            );
        }
    }
}
