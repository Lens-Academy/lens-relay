//! Concept relationships ("concept rows", "junction rows") in `read` output.
//!
//! What the team knows about a concept and a source is stored once, in the
//! concept file (`Lens Edu/Concepts/<name>.md`): under its `## Relationships`
//! heading, each level-3 heading that is exactly one wikilink is a "row"
//! about the linked file, and runs until the next heading of level ≤ 3:
//!
//! ```text
//! ## Relationships
//!
//! ### [[../articles/ai-control-redwood]]
//! Best intro we have. §2 is the explanation.
//! ```
//!
//! A row means "we have information about this pair", not "this is a match".
//! The Lens Editor shows a file's rows in a panel at the top of the file; this
//! module gives an MCP `read` of the same file (an article, video transcript
//! or lens) the same rows, as a labelled "concept relationships" block before
//! the file's text (first chunk only); a lens also gets the rows about the
//! articles and videos it uses as `source::`. The rows stay in the
//! concept files: grep, search and glob see them only there, and edits go to
//! the concept file.
//!
//! The parser mirrors the editor's `lens-editor/src/lib/concept-rows.ts` and
//! the platform validator's `content_processor/src/concepts.ts` (including
//! CommonMark closing hashes on headings); their test cases are ported below
//! so the three agree. Rows are matched by the
//! document their heading link resolves to (the link indexer's resolution),
//! not by name.

use super::{critic_markup, get_links};
use crate::server::Server;
use futures::StreamExt;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock};
use y_sweet_core::link_indexer::{self, VirtualEntry, VirtualTreeIndex};
use yrs::{GetString, ReadTxn, Transact};

/// "For a file in `opened_in`, show the rows about it from the files in
/// `rows_in`" — the editor's `CONCEPT_ROW_RULES`.
#[derive(Debug)]
pub struct ConceptRowRule {
    /// Shared folder the rule applies in.
    pub shared_folder: &'static str,
    /// Folder of the opened file, relative to the shared folder.
    pub opened_in: &'static str,
    /// Folder whose files hold the rows, relative to the shared folder.
    pub rows_in: &'static str,
    /// Heading (level 2) of the section that holds the rows.
    pub section: &'static str,
    /// What the opened file is called in the output ("this article").
    pub opened_label: &'static str,
    /// Placeholder name for the opened file in the add-a-note instruction.
    pub file_kind: &'static str,
    /// Also show the rows of the articles and video transcripts the opened
    /// file uses as `source::` (lenses).
    pub source_context: bool,
}

pub const CONCEPT_ROW_RULES: &[ConceptRowRule] = &[
    ConceptRowRule {
        shared_folder: "Lens Edu",
        opened_in: "articles",
        rows_in: "Concepts",
        section: "Relationships",
        opened_label: "this article",
        file_kind: "this-article",
        source_context: false,
    },
    ConceptRowRule {
        shared_folder: "Lens Edu",
        opened_in: "video_transcripts",
        rows_in: "Concepts",
        section: "Relationships",
        opened_label: "this video",
        file_kind: "this-video",
        source_context: false,
    },
    ConceptRowRule {
        shared_folder: "Lens Edu",
        opened_in: "Lenses",
        rows_in: "Concepts",
        section: "Relationships",
        opened_label: "this lens",
        file_kind: "this-lens",
        source_context: true,
    },
];

/// Longest row text shown in full, in characters.
const MAX_ROW_CHARS: usize = 1500;
/// Concept files read per target file (an article or lens).
const MAX_CONCEPT_FILES_PER_TARGET: usize = 40;
/// Concept files read per `read` call in all.
const MAX_CONCEPT_FILES_TOTAL: usize = 80;
/// Sources (articles, video transcripts) of a lens whose rows are shown
/// (canonical concept-row rules v1 #8 allows R to cap them).
const MAX_LENS_SOURCES: usize = 8;
/// Concept files loaded at once.
const LOAD_CONCURRENCY: usize = 4;

fn ends_with_md(path: &str) -> bool {
    path.len() >= 3
        && path
            .get(path.len() - 3..)
            .is_some_and(|ext| ext.eq_ignore_ascii_case(".md"))
}

/// The rule for the file at `path` (a resolver path such as
/// `Lens Edu/articles/x.md`), or None.
pub fn match_rule(path: &str) -> Option<&'static ConceptRowRule> {
    if !ends_with_md(path) {
        return None;
    }
    CONCEPT_ROW_RULES
        .iter()
        .find(|r| path.starts_with(&format!("{}/{}/", r.shared_folder, r.opened_in)))
}

/// Resolver-path prefix (with trailing slash) of the files holding the rule's rows.
fn rows_folder(rule: &ConceptRowRule) -> String {
    format!("{}/{}/", rule.shared_folder, rule.rows_in)
}

// ---------------------------------------------------------------------------
// Parsing (port of concept-rows.ts)
// ---------------------------------------------------------------------------

/// One row: a `### [[target]]` heading under `## Relationships`. Offsets are
/// byte offsets into the parsed text.
#[derive(Debug, Clone, PartialEq)]
pub struct ConceptRow {
    /// The heading's link target, without `|alias` or `#heading`.
    pub target: String,
    /// 1-based line of the heading.
    pub line: usize,
    pub heading_from: usize,
    /// End of the heading line (before its newline).
    pub heading_to: usize,
    /// The free text: from the line after the heading, trailing whitespace left out.
    pub body_from: usize,
    pub body_to: usize,
    /// Where the row ends: the next heading of level ≤ 3, or the section's end.
    pub to: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedConceptFile {
    /// Each rows section: `(heading_from, to)`, `to` being the next heading
    /// of level ≤ 2 or the end of the text. Every `## Relationships` counts.
    pub sections: Vec<(usize, usize)>,
    pub rows: Vec<ConceptRow>,
}

struct Heading {
    level: usize,
    text: String,
    from: usize,
    to: usize,
    line: usize,
}

/// An ATX heading: up to 3 spaces of indent, 1–6 `#`, then space or the end.
fn heading_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$").expect("static pattern")
    })
}

/// A fence opener: up to 3 spaces of indent, then 3+ backticks or tildes.
fn fence_open_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^ {0,3}(`{3,}|~{3,})(.*)$").expect("static pattern"))
}

fn single_link_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\[\[([^\[\]\n]+)\]\]$").expect("static pattern"))
}

/// A wikilink's page part: `a/b#H|Alias` → `a/b`.
pub fn link_page(inner: &str) -> &str {
    let page = inner.split('|').next().unwrap_or("");
    page.split('#').next().unwrap_or("").trim()
}

/// A heading's text without its CommonMark closing sequence: `[[x]] ###` →
/// `[[x]]` (the hashes must follow a space; `[[x]]#` keeps its `#`).
fn strip_closing_hashes(text: &str) -> &str {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?:^|[ \t]+)#+$").expect("static pattern"));
    match re.find(text) {
        Some(m) => &text[..m.start()],
        None => text,
    }
}

/// The fence a line opens: its character and length. A backtick fence's
/// info string may not contain a backtick (CommonMark).
fn fence_opener(line: &str) -> Option<(char, usize)> {
    let m = fence_open_re().captures(line)?;
    let run = m.get(1)?.as_str();
    let c = run.chars().next()?;
    if c == '`' && m.get(2).is_some_and(|g| g.as_str().contains('`')) {
        return None;
    }
    Some((c, run.len()))
}

/// Whether `line` closes a fence of `len` × `c`: up to 3 spaces of indent,
/// at least `len` of the same character, then only whitespace.
fn closes_fence(line: &str, c: char, len: usize) -> bool {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return false;
    }
    let rest = &line[indent..];
    let run = rest.len() - rest.trim_start_matches(c).len();
    run >= len && rest[run..].trim_matches([' ', '\t']).is_empty()
}

/// Headings of `text` outside the regions where none count: frontmatter
/// (closed by `---` with optional trailing whitespace), fenced code, and
/// Obsidian `%% … %%` comments. Only a `#` after at most 3 spaces makes a
/// heading, so headings in list items and block quotes do not count.
fn headings_of(text: &str) -> Vec<Heading> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    let mut line = 0usize;
    let mut fence: Option<(char, usize)> = None;
    let mut in_comment = false;
    let mut in_frontmatter = text.starts_with("---\n") || text.starts_with("---\r\n");
    loop {
        let nl = text[pos..].find('\n').map(|i| pos + i);
        let end = nl.unwrap_or(text.len());
        let full = &text[pos..end];
        let raw = full.strip_suffix('\r').unwrap_or(full);
        line += 1;
        let toggles_comment = raw.matches("%%").count() % 2 == 1;
        if in_frontmatter {
            if line > 1 && raw.trim_end() == "---" {
                in_frontmatter = false;
            }
        } else if let Some((c, len)) = fence {
            if closes_fence(raw, c, len) {
                fence = None;
            }
        } else if in_comment {
            if toggles_comment {
                in_comment = false;
            }
        } else if let Some(opener) = fence_opener(raw) {
            fence = Some(opener);
        } else {
            if let Some(m) = heading_re().captures(raw) {
                out.push(Heading {
                    level: m[1].len(),
                    text: strip_closing_hashes(m.get(2).map_or("", |g| g.as_str()).trim())
                        .to_string(),
                    from: pos,
                    to: pos + raw.len(),
                    line,
                });
            }
            if toggles_comment {
                in_comment = true;
            }
        }
        match nl {
            Some(nl) => pos = nl + 1,
            None => break,
        }
    }
    out
}

/// The rows sections and their rows, by the canonical concept-row rules v1
/// (shared with the editor and the platform validator): every level-2
/// heading whose text is exactly `section` opens a rows section, which ends
/// at the next heading of level ≤ 2; a row is a level-3 heading in one whose
/// text is exactly one wikilink (`|alias` and `#anchor` allowed, closing
/// hashes allowed, nothing else; `![[…]]` is not a row) and runs to the next
/// heading of level ≤ 3.
pub fn parse_concept_file(text: &str, section: &str) -> ParsedConceptFile {
    let headings = headings_of(text);
    let mut sections: Vec<(usize, usize)> = Vec::new();
    let mut in_section = false;
    let mut rows = Vec::new();
    for (i, h) in headings.iter().enumerate() {
        if h.level <= 2 {
            if in_section {
                if let Some(last) = sections.last_mut() {
                    last.1 = h.from;
                }
            }
            in_section = h.level == 2 && h.text == section;
            if in_section {
                sections.push((h.from, text.len()));
            }
            continue;
        }
        if !in_section || h.level != 3 {
            continue;
        }
        let Some(link) = single_link_re().captures(&h.text) else {
            continue;
        };
        let target = link_page(&link[1]);
        if target.is_empty() {
            continue;
        }
        let to = headings[i + 1..]
            .iter()
            .find(|n| n.level <= 3)
            .map_or(text.len(), |n| n.from);
        let body_from = (h.to + 1).min(to);
        let body_to = body_from + text[body_from..to].trim_end().len();
        rows.push(ConceptRow {
            target: target.to_string(),
            line: h.line,
            heading_from: h.from,
            heading_to: h.to,
            body_from,
            body_to,
            to,
        });
    }
    ParsedConceptFile { sections, rows }
}

/// The link targets of every `source::` field of a lens, in order, without
/// repeats: any section (also before the first heading) except `#### Text`
/// sections, several per section, the first wikilink of each value.
/// Sections and fields are read as the editor's `parseSections` +
/// `parseFields` read them: a heading is `^#{1,4}\s+.+$` outside the
/// frontmatter, and a field's value runs on until the next field or heading.
/// Which targets count (articles and video transcripts, not widgets) is
/// decided once they are resolved (canonical concept-row rules v1 #8).
pub fn lens_source_targets(text: &str) -> Vec<String> {
    static HEADER: OnceLock<Regex> = OnceLock::new();
    static FIELD: OnceLock<Regex> = OnceLock::new();
    static LINK: OnceLock<Regex> = OnceLock::new();
    // `\s` as in the editor's pattern (JavaScript's `\s` also matches a newline).
    let header =
        HEADER.get_or_init(|| Regex::new(r"(?m)^(#{1,4})\s+(.+)$").expect("static pattern"));
    let field = FIELD.get_or_init(|| {
        Regex::new(r"^([A-Za-z0-9_][A-Za-z0-9_-]*)::(?:\s(.*))?$").expect("static pattern")
    });
    let link = LINK.get_or_init(|| Regex::new(r"\[\[([^\[\]\n]+)\]\]").expect("static pattern"));

    // Skip frontmatter, as parseSections does.
    let mut start = 0;
    if text.starts_with("---\n") || text.starts_with("---\r\n") {
        if let Some(end_marker) = text[3..].find("\n---").map(|i| i + 3) {
            start = text[end_marker + 4..]
                .find('\n')
                .map_or(text.len(), |i| end_marker + 4 + i + 1);
        }
    }
    // Sections: (from, whether it is a Text section); the body before the
    // first heading is one too.
    let mut sections: Vec<(usize, bool)> = vec![(start, false)];
    for c in header.captures_iter(text) {
        let Some(m) = c.get(0) else { continue };
        if m.start() <= start {
            continue;
        }
        let lower = c[2].trim().to_lowercase();
        let is_text = lower.strip_suffix(':').unwrap_or(&lower).trim() == "text";
        sections.push((m.start(), is_text));
    }

    let mut targets: Vec<String> = Vec::new();
    let mut push = |key: &str, lines: &[String]| {
        if key != "source" {
            return;
        }
        let value = lines.join("\n");
        let target = link
            .captures(&value)
            .map(|c| link_page(c.get(1).map_or("", |g| g.as_str())).to_string())
            .unwrap_or_default();
        if !target.is_empty() && !targets.contains(&target) {
            targets.push(target);
        }
    };
    for (i, &(from, is_text)) in sections.iter().enumerate() {
        if is_text {
            continue;
        }
        let to = sections.get(i + 1).map_or(text.len(), |s| s.0);
        let mut current: Option<(String, Vec<String>)> = None;
        for line in text[from..to].split('\n') {
            let line = line.strip_suffix('\r').unwrap_or(line);
            if let Some(c) = field.captures(line) {
                if let Some((key, lines)) = current.take() {
                    push(&key, &lines);
                }
                let rest = c.get(2).map_or("", |g| g.as_str()).trim();
                let lines = if rest.is_empty() {
                    Vec::new()
                } else {
                    vec![rest.to_string()]
                };
                current = Some((c[1].to_string(), lines));
            } else if let Some((_, lines)) = current.as_mut() {
                lines.push(line.to_string());
            }
        }
        if let Some((key, lines)) = current.take() {
            push(&key, &lines);
        }
    }
    targets
}

/// What a lens source is called in the output, by its folder; None for a
/// file that is not a source whose rows are shown (e.g. a widget).
fn source_kind(path: &str) -> Option<&'static str> {
    SOURCE_KINDS
        .iter()
        .find(|(prefix, _)| path.starts_with(prefix) && ends_with_md(path))
        .map(|(_, kind)| *kind)
}

/// Folders of the sources a lens's context rows come from, and their names.
const SOURCE_KINDS: &[(&str, &str)] = &[
    ("Lens Edu/articles/", "article"),
    ("Lens Edu/video_transcripts/", "video"),
];

// ---------------------------------------------------------------------------
// Collecting rows
// ---------------------------------------------------------------------------

/// One row about a target, ready to print.
#[derive(Debug, Clone)]
pub struct RowEntry {
    /// Concept file uuid.
    pub concept_id: String,
    /// Resolver path, e.g. `Lens Edu/Concepts/Low-stakes control.md`.
    pub concept_path: String,
    pub concept_name: String,
    /// 1-based line of the row heading in the concept file (its `read` view).
    pub line: usize,
    pub index: usize,
    pub body: String,
}

/// The rows about one target file.
#[derive(Debug, Default)]
pub struct CollectedRows {
    pub rows: Vec<RowEntry>,
    /// Concept files that link the target only outside a row heading.
    pub mentions: Vec<String>,
    /// Concept files linking the target that were not read (over the cap).
    pub skipped: usize,
}

/// The rows about one of a lens's sources (an article or video transcript).
#[derive(Debug, Clone)]
pub struct SourceRows {
    pub source_path: String,
    /// "article" or "video".
    pub kind: &'static str,
    pub rows: Vec<RowEntry>,
}

#[derive(Debug)]
pub struct LensRowGroups {
    /// One per lens row, with its concept's article rows (only on the
    /// concept's first lens row, and only articles that have a row there).
    pub lens: Vec<(RowEntry, Vec<SourceRows>)>,
    /// Per article, the rows of concepts with no lens row; articles left with
    /// none are dropped.
    pub source_only: Vec<SourceRows>,
}

/// A lens's rows grouped by concept, as the editor's `groupLensRows`: a
/// concept with a lens row shows once, its article rows under the lens row;
/// the rest of the article rows stay apart. Both keep the order they come in.
pub fn group_lens_rows(own: &[RowEntry], articles: &[SourceRows]) -> LensRowGroups {
    let with_lens_row: HashSet<&str> = own.iter().map(|r| r.concept_id.as_str()).collect();
    let mut seen: HashSet<&str> = HashSet::new();
    let lens = own
        .iter()
        .map(|entry| {
            let first = seen.insert(entry.concept_id.as_str());
            let article_rows = if first {
                articles
                    .iter()
                    .map(|a| SourceRows {
                        source_path: a.source_path.clone(),
                        kind: a.kind,
                        rows: a
                            .rows
                            .iter()
                            .filter(|r| r.concept_id == entry.concept_id)
                            .cloned()
                            .collect(),
                    })
                    .filter(|a| !a.rows.is_empty())
                    .collect()
            } else {
                Vec::new()
            };
            (entry.clone(), article_rows)
        })
        .collect();
    let source_only = articles
        .iter()
        .map(|a| SourceRows {
            source_path: a.source_path.clone(),
            kind: a.kind,
            rows: a
                .rows
                .iter()
                .filter(|r| !with_lens_row.contains(r.concept_id.as_str()))
                .cloned()
                .collect(),
        })
        .filter(|a| !a.rows.is_empty())
        .collect();
    LensRowGroups { lens, source_only }
}

/// `Concepts/Low-stakes control.md` → `Low-stakes control`.
fn file_name(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    if ends_with_md(name) {
        name[..name.len() - 3].to_string()
    } else {
        name.to_string()
    }
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
/// therefore a row here but not in the editor, which parses the raw text: an
/// accepted divergence.
struct ParsedConcept {
    path: String,
    name: String,
    rows: Vec<ResolvedRow>,
}

/// Loads, parses and resolves concept files once per `read`, within
/// [`MAX_CONCEPT_FILES_TOTAL`]; per-target collection then only filters.
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

    /// Load the given concept files (those not loaded yet) and return how
    /// many of them could not be read because the total cap was reached.
    async fn load(&mut self, concepts: &[(String, String)]) -> usize {
        let room = MAX_CONCEPT_FILES_TOTAL.saturating_sub(self.loaded.len());
        let wanted: Vec<(String, String)> = concepts
            .iter()
            .filter(|(id, _)| !self.loaded.contains_key(id))
            .cloned()
            .collect();
        let over = wanted.len().saturating_sub(room);
        let server = self.server;
        let texts: Vec<(String, String, Option<String>)> =
            futures::stream::iter(wanted.into_iter().take(room))
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
        over
    }

    fn parse(&self, path: String, text: &str) -> ParsedConcept {
        let source_virtual = format!("/{}", path);
        let rows = parse_concept_file(text, self.section)
            .rows
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
/// as `read` loads it (reloaded from storage after GC eviction).
async fn load_text(server: &Arc<Server>, path: &str) -> Option<String> {
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
                (path.starts_with(&folder) && ends_with_md(&path)).then_some((id, path))
            })
            .collect();
    candidates.sort_by(|a, b| a.1.cmp(&b.1));
    candidates.dedup();
    candidates
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
    out.skipped += loader.load(&candidates).await;

    for (id, _) in &candidates {
        let Some(Some(concept)) = loader.loaded.get(id) else {
            continue;
        };
        let rows: Vec<&ResolvedRow> = concept
            .rows
            .iter()
            .filter(|row| row.target_id.as_deref() == Some(target_uuid))
            .collect();
        if rows.is_empty() {
            out.mentions.push(concept.path.clone());
        }
        for (index, row) in rows.into_iter().enumerate() {
            out.rows.push(RowEntry {
                concept_id: id.clone(),
                concept_path: concept.path.clone(),
                concept_name: concept.name.clone(),
                line: row.line,
                index,
                body: row.body.clone(),
            });
        }
    }
    out.rows.sort_by(|a, b| {
        a.concept_name
            .to_lowercase()
            .cmp(&b.concept_name.to_lowercase())
            .then_with(|| a.concept_name.cmp(&b.concept_name))
            .then(a.index.cmp(&b.index))
    });
    out.mentions.sort_by_key(|p| p.to_lowercase());
    out
}

#[cfg(test)]
thread_local! {
    /// How often this thread walked the folder trees (tests run on one thread).
    static TREE_WALKS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Every file of every folder as a [`VirtualEntry`]: the tree links resolve in.
fn tree_entries(server: &Arc<Server>) -> Vec<VirtualEntry> {
    #[cfg(test)]
    TREE_WALKS.with(|c| c.set(c.get() + 1));
    get_links::all_virtual_entries(server)
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

pub const BLOCK_START: &str =
    "── Concept relationships for this file (context — NOT part of this file's text) ──";
pub const BLOCK_END: &str = "── end of concept relationships ──";

fn preamble(file_kind: &str) -> String {
    format!(
        "Each concept relationship below is a row in a concept file: a \"### [[...]]\" heading under \"## Relationships\", followed by free text. An entry means \"we have information about this pair\" (which may be a negative judgment, such as \"considered, but not a match\"), not that they match. To edit a relationship, read and edit the concept file at the given line, never this file. To add one, add a \"### [[relative/path/to/{file_kind}]]\" row (followed by free text) under \"## Relationships\" in the concept file. The line numbers below the end marker are this file's own."
    )
}

/// A row's text indented by `indent`, cut at [`MAX_ROW_CHARS`].
fn render_body(out: &mut String, entry: &RowEntry, indent: &str) {
    let body = entry.body.trim();
    if body.is_empty() {
        out.push_str(indent);
        out.push_str("(empty relationship)\n");
        return;
    }
    let (shown, cut) = match body.char_indices().nth(MAX_ROW_CHARS) {
        Some((i, _)) => (&body[..i], true),
        None => (body, false),
    };
    for line in shown.lines() {
        if line.is_empty() {
            out.push('\n');
        } else {
            out.push_str(indent);
            out.push_str(line);
            out.push('\n');
        }
    }
    if cut {
        out.push_str(&format!(
            "{indent}[… relationship text cut at {MAX_ROW_CHARS} characters — read {} from line {} for the rest]\n",
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

fn render_mentions(out: &mut String, mentions: &[String], opened_label: &str) {
    if !mentions.is_empty() {
        out.push_str(&format!(
            "\nAlso mentioned (a link to {opened_label} outside any row) in: {}\n",
            mentions.join(", ")
        ));
    }
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
fn render_lens(own: &CollectedRows, sources: &[(SourceRows, usize)], opened_label: &str) -> String {
    let source_rows: Vec<SourceRows> = sources.iter().map(|(a, _)| a.clone()).collect();
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

    // One entry per concept, with a sub-entry per source it has a row about;
    // concepts by name, sub-entries in source order.
    let mut only: Vec<(&SourceRows, &RowEntry)> = groups
        .source_only
        .iter()
        .flat_map(|source| source.rows.iter().map(move |row| (source, row)))
        .collect();
    only.sort_by(|a, b| {
        let (a, b) = (&a.1.concept_name, &b.1.concept_name);
        a.to_lowercase()
            .cmp(&b.to_lowercase())
            .then_with(|| a.cmp(b))
    });
    if !only.is_empty() {
        out.push_str(
            "\nConcepts linked only via this lens's sources (rows about a source — context, not about this lens; no row for this lens yet):\n",
        );
    }
    let mut previous: Option<&str> = None;
    for (source, row) in only {
        if previous != Some(row.concept_id.as_str()) {
            out.push_str(&format!("\n[Concept] {}\n", row.concept_path));
            previous = Some(row.concept_id.as_str());
        }
        render_source_row(&mut out, source, row);
    }
    for (source, skipped) in sources {
        render_skipped(&mut out, *skipped, &source.source_path);
    }
    out
}

/// The concept-notes block for the Markdown file `path` (resolver path) with
/// uuid `uuid` in folder doc `folder_doc_id`, whose `read` text is `text`;
/// None when no rule covers the file or nothing links to it from a concept.
pub async fn concept_notes_block(
    server: &Arc<Server>,
    path: &str,
    uuid: &str,
    folder_doc_id: &str,
    text: &str,
) -> Option<String> {
    let rule = match_rule(path)?;
    let source_targets = if rule.source_context {
        lens_source_targets(text)
    } else {
        Vec::new()
    };
    let resolver = server.doc_resolver();
    let lens_virtual = format!("/{}", path);

    // First, without walking the folder trees: is there any concept file
    // linking to this file or (as far as a plain lookup can tell) to one of
    // its sources? Backlinks are a map lookup; a source is looked up by its
    // relative path, and only a source that lookup cannot find (other case,
    // root fallback, missing) needs the tree to be sure.
    let own_candidates = concept_backlinkers(server, rule, folder_doc_id, uuid).await;
    let mut maybe_rows = !own_candidates.is_empty();
    for target in source_targets.iter().take(MAX_LENS_SOURCES * 2) {
        if maybe_rows {
            break;
        }
        let relative = link_indexer::resolve_relative(&lens_virtual, target);
        match resolver.resolve_path(relative.trim_start_matches('/')) {
            Some(info) => {
                if !concept_backlinkers(server, rule, &info.folder_doc_id, &info.uuid)
                    .await
                    .is_empty()
                {
                    maybe_rows = true;
                }
            }
            None => maybe_rows = true,
        }
    }
    if !maybe_rows {
        return None;
    }

    let entries = tree_entries(server);
    let index = VirtualTreeIndex::new(&entries);
    let mut loader = ConceptLoader::new(server, &index, rule.section);
    let own = collect_rows(&mut loader, own_candidates, uuid).await;

    let mut sources: Vec<(SourceRows, usize)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for target in source_targets {
        if seen.len() >= MAX_LENS_SOURCES {
            break;
        }
        let Some(entry) = index.resolve(&target, Some(&lens_virtual)) else {
            continue;
        };
        if entry.id == uuid || seen.contains(&entry.id) {
            continue;
        }
        let Some(source_path) = resolver.path_for_uuid(&entry.id) else {
            continue;
        };
        // Articles and video transcripts; widgets and the rest are skipped.
        let Some(kind) = source_kind(&source_path) else {
            continue;
        };
        let Some(source_info) = resolver.resolve_path(&source_path) else {
            continue;
        };
        seen.insert(entry.id.clone());
        let candidates =
            concept_backlinkers(server, rule, &source_info.folder_doc_id, &entry.id).await;
        let rows = collect_rows(&mut loader, candidates, &entry.id).await;
        sources.push((
            SourceRows {
                source_path,
                kind,
                rows: rows.rows,
            },
            rows.skipped,
        ));
    }

    let any_source_rows = sources.iter().any(|(a, _)| !a.rows.is_empty());
    if own.rows.is_empty() && own.mentions.is_empty() && !any_source_rows {
        return None;
    }
    let body = if rule.source_context {
        render_lens(&own, &sources, rule.opened_label)
    } else {
        render_simple(&own, rule.opened_label)
    };
    Some(format!(
        "{BLOCK_START}\n{}\n{}\n{BLOCK_END}",
        preamble(rule.file_kind),
        body
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
            .rows
            .into_iter()
            .map(|r| r.target)
            .collect()
    }

    #[test]
    fn finds_level3_link_headings_under_relationships() {
        let parsed = parse_concept_file(CONCEPT, "Relationships");
        assert_eq!(parsed.sections.len(), 1);
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
        let rows = parse_concept_file(CONCEPT, "Relationships").rows;
        let (first, last) = (&rows[0], &rows[2]);
        assert_eq!(
            &CONCEPT[first.body_from..first.body_to],
            "Best intro we have. §2 is the explanation; §4 drifts into high-stakes.\n\n#### A sub-heading stays in the row\nMore notes."
        );
        assert_eq!(
            &CONCEPT[last.body_from..last.body_to],
            "Uses §1–3 of the Redwood article."
        );
        assert!(CONCEPT[last.to..].starts_with("## See also"));
    }

    #[test]
    fn records_the_heading_line() {
        let first = &parse_concept_file(CONCEPT, "Relationships").rows[0];
        assert_eq!(
            CONCEPT.split('\n').nth(first.line - 1),
            Some("### [[../articles/ai-control-redwood]]")
        );
        assert_eq!(
            &CONCEPT[first.heading_from..first.heading_to],
            "### [[../articles/ai-control-redwood]]"
        );
    }

    #[test]
    fn ignores_headings_that_are_not_a_single_link_and_headings_in_code() {
        let text =
            "## Relationships\n\n### About [[x]]\nno\n\n```\n### [[y]]\n```\n### [[z#Part]]\nyes\n";
        assert_eq!(targets(text), vec!["z"]);
    }

    #[test]
    fn tilde_fences_and_mismatched_fence_markers() {
        // A ``` line inside a ~~~ fence does not close it.
        let text = "## Relationships\n\n~~~\n```\n### [[y]]\n~~~\n### [[z]]\n";
        assert_eq!(targets(text), vec!["z"]);
    }

    #[test]
    fn matches_the_relationships_heading_case_sensitively() {
        assert!(
            parse_concept_file("## relationships\n\n### [[x]]\n", "Relationships")
                .sections
                .is_empty()
        );
    }

    #[test]
    fn takes_only_a_heading_that_is_exactly_one_link_outside_lists_and_quotes() {
        let text =
            "## Relationships\n\n### [[a]] (draft)\n\n- ### [[b]]\n> ### [[c]]\n### [[d|D]]\n";
        assert_eq!(targets(text), vec!["d"]);
    }

    #[test]
    fn no_rows_without_a_relationships_section() {
        assert_eq!(
            parse_concept_file("# C\n\n### [[x]]\n", "Relationships"),
            ParsedConceptFile {
                sections: vec![],
                rows: vec![]
            }
        );
    }

    #[test]
    fn an_empty_row_has_an_empty_body() {
        let text = "## Relationships\n\n### [[x]]\n\n### [[y]]";
        let rows = parse_concept_file(text, "Relationships").rows;
        let (x, y) = (&rows[0], &rows[1]);
        assert_eq!(x.body_from, x.body_to);
        assert_eq!(&text[x.heading_from..x.heading_to], "### [[x]]");
        assert_eq!(y.body_from, text.len());
    }

    #[test]
    fn section_ends_at_a_level_1_heading_too() {
        let text = "## Relationships\n\n### [[a]]\nA\n# Next\n### [[b]]\n";
        let parsed = parse_concept_file(text, "Relationships");
        assert_eq!(targets(text), vec!["a"]);
        assert!(text[parsed.sections[0].1..].starts_with("# Next"));
    }

    // From the platform validator: only level-3 headings under ## Relationships count.
    #[test]
    fn counts_only_level3_headings_under_relationships() {
        let text = "# C\n\n### [[../articles/ai_control_redwood]]\nbefore\n\n## Relationships\n\n### [[../articles/ai_control_redwood]]\nNotes.\n\n#### [[../articles/ai_control_redwood]]\nDeeper.\n\n### [[../articles/ai_control_redwood]]\nAgain.\n\n## See also\n\n### [[../articles/ai_control_redwood]]\n";
        let rows = parse_concept_file(text, "Relationships").rows;
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].line, 8);
        assert_eq!(rows[1].line, 14);
        // Underscores survive (the platform reads the source text, not the rendered text).
        assert_eq!(rows[0].target, "../articles/ai_control_redwood");
    }

    #[test]
    fn crlf_line_endings() {
        let text = "## Relationships\r\n\r\n### [[a]]\r\nNote.\r\n";
        let rows = parse_concept_file(text, "Relationships").rows;
        assert_eq!(rows.len(), 1);
        // As in the editor, the body starts after the heading's `\r`; the
        // block trims it.
        assert_eq!(text[rows[0].body_from..rows[0].body_to].trim(), "Note.");
        assert_eq!(rows[0].target, "a");
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
            match_rule("Lens Edu/articles/x.md").map(|r| r.opened_in),
            Some("articles")
        );
        assert!(match_rule("Lens Edu/Lenses/x.md").is_some_and(|r| r.source_context));
        assert_eq!(
            match_rule("Lens Edu/video_transcripts/x.md").map(|r| r.opened_label),
            Some("this video")
        );
        assert!(match_rule("Lens Edu/Concepts/x.md").is_none());
        assert!(match_rule("Lens Edu/widgets/x.md").is_none());
        assert!(match_rule("Lens/articles/x.md").is_none());
        assert!(match_rule("Lens Edu/articles/x.html").is_none());
    }

    #[test]
    fn lens_source_targets_reads_every_source_field_outside_text_sections() {
        let lens = "---
title: Demo
---

#### Article
source:: [[../articles/one|One]]
from:: \"Start\"

#### Text
content::
source:: [[../articles/not-an-article]]

#### Article
source:: [[../articles/two]]

#### Article
source:: [[../articles/one]]
";
        assert_eq!(
            lens_source_targets(lens),
            vec!["../articles/one", "../articles/two"]
        );
    }

    #[test]
    fn lens_source_targets_ignores_frontmatter() {
        let lens = "---\n#### Article\nsource:: [[../articles/fm]]\n---\n#### Article\nsource:: \"[[../articles/real]]\"\n";
        assert_eq!(lens_source_targets(lens), vec!["../articles/real"]);
    }

    #[test]
    fn lens_source_targets_reads_video_and_widget_sources() {
        let lens = "#### Video\nsource:: [[../video_transcripts/talk]]\nfrom:: 0:00\n\n#### Widget\nsource:: [[../widgets/quiz]]\n";
        assert_eq!(
            lens_source_targets(lens),
            vec!["../video_transcripts/talk", "../widgets/quiz"]
        );
        assert_eq!(
            source_kind("Lens Edu/video_transcripts/talk.md"),
            Some("video")
        );
        assert_eq!(source_kind("Lens Edu/articles/a.md"), Some("article"));
        assert_eq!(source_kind("Lens Edu/widgets/quiz.md"), None);
        assert_eq!(source_kind("Lens Edu/widgets/quiz.html"), None);
    }

    #[test]
    fn lens_source_value_runs_until_the_next_field_or_heading() {
        // A value on the next line still counts; a heading ends the field.
        let lens = "#### Article\nsource::\n[[../articles/next-line]]\n#### Text\n[[../articles/not-a-source]]\n";
        assert_eq!(lens_source_targets(lens), vec!["../articles/next-line"]);
    }

    #[test]
    fn closing_hashes_end_a_heading_as_in_commonmark() {
        let text =
            "## Relationships ##\n\n### [[a]] ###\nA\n### [[b]]#\nnot a row\n### [[c|C]] #  \nC\n";
        assert_eq!(targets(text), vec!["a", "c"]);
        assert_eq!(strip_closing_hashes("###"), "");
        assert_eq!(strip_closing_hashes("[[x]]#"), "[[x]]#");
        assert_eq!(strip_closing_hashes("[[x]] \t##"), "[[x]]");
    }

    // canonical concept-row rules v1 #1
    #[test]
    fn canonical_1_every_exact_relationships_level2_heading_is_a_section() {
        let text =
            "## Relationships\n### [[a]]\n## Other\n### [[x]]\n## Relationships ##\n### [[b]]\n";
        let parsed = parse_concept_file(text, "Relationships");
        assert_eq!(parsed.sections.len(), 2);
        assert_eq!(targets(text), vec!["a", "b"]);
        // No setext headings, no emphasis, exact text.
        assert!(targets("Relationships\n---\n### [[a]]\n").is_empty());
        assert!(targets("## *Relationships*\n### [[a]]\n").is_empty());
        assert!(targets("## Relationships:\n### [[a]]\n").is_empty());
    }

    // canonical concept-row rules v1 #2
    #[test]
    fn canonical_2_section_ends_at_next_level_1_or_2_heading() {
        assert_eq!(
            targets("## Relationships\n### [[a]]\n# Top\n### [[b]]\n"),
            vec!["a"]
        );
        assert_eq!(
            targets("## Relationships\n### [[a]]\n## Next\n### [[b]]\n"),
            vec!["a"]
        );
        assert_eq!(
            targets("## Relationships\n### [[a]]\n#### Deeper\n### [[b]]\n"),
            vec!["a", "b"]
        );
    }

    // canonical concept-row rules v1 #3
    #[test]
    fn canonical_3_row_is_an_indented_up_to_3_level3_single_link_heading() {
        let text = "## Relationships\n   ### [[a]]\n    ### [[four-spaces]]\n### [[b|B]] ##\n### ![[embed]]\n### [[#only-anchor]]\n### [[x[y]]\n### [[c#Part]]\n### [[d]] extra\n";
        assert_eq!(targets(text), vec!["a", "b", "c"]);
    }

    // canonical concept-row rules v1 #4
    #[test]
    fn canonical_4_row_body_runs_to_next_heading_of_level_3_or_less() {
        let text = "## Relationships\n### [[a]]\nA1\n#### Sub\nA2\n### [[b]]\nB\n## End\n";
        let rows = parse_concept_file(text, "Relationships").rows;
        assert_eq!(
            &text[rows[0].body_from..rows[0].body_to],
            "A1\n#### Sub\nA2"
        );
        assert_eq!(&text[rows[1].body_from..rows[1].body_to], "B");
        assert!(text[rows[1].to..].starts_with("## End"));
    }

    // canonical concept-row rules v1 #5
    #[test]
    fn canonical_5_ignored_regions() {
        // A fence closes only on the same character, at least as long, with
        // only whitespace after it.
        let fences = "## Relationships\n````\n```\n### [[in-fence-1]]\n```` info\n### [[in-fence-2]]\n````  \n### [[a]]\n";
        assert_eq!(targets(fences), vec!["a"]);
        // A fence line indented 4+ spaces is not a fence.
        assert_eq!(targets("## Relationships\n    ```\n### [[b]]\n"), vec!["b"]);
        // A backtick fence opener cannot have a backtick in its info string.
        assert_eq!(targets("## Relationships\n``` a`b\n### [[c]]\n"), vec!["c"]);
        // Obsidian comments, inline and over several lines.
        let comments =
            "## Relationships\n%%\n### [[hidden]]\n%%\n### [[d]]\n%% note %%\n### [[e]]\n";
        assert_eq!(targets(comments), vec!["d", "e"]);
        // List items and block quotes.
        assert!(targets("## Relationships\n- ### [[l]]\n> ### [[q]]\n1. ### [[n]]\n").is_empty());
        // Frontmatter, whose closing --- may have trailing whitespace.
        let fm =
            "---\ntopic: x\n## Relationships\n### [[in-fm]]\n--- \t\n## Relationships\n### [[f]]\n";
        assert_eq!(targets(fm), vec!["f"]);
    }

    // canonical concept-row rules v1 #8
    #[test]
    fn canonical_8_lens_sources_every_source_field_except_text_sections() {
        let lens = "---\ntitle: x\n---\nsource:: [[../articles/before-heading]]\r\n#### Article\r\nsource:: [[../articles/a.md]]\r\nsource:: [[../video_transcripts/v]]\r\n#### Text\r\nsource:: [[../articles/in-text]]\r\n#### Widget\r\nsource:: [[../widgets/w]] and [[../articles/second-link]]\r\n";
        assert_eq!(
            lens_source_targets(lens),
            vec![
                "../articles/before-heading",
                "../articles/a.md",
                "../video_transcripts/v",
                "../widgets/w"
            ]
        );
        // Widgets are dropped once resolved; .md or not, sources are kept.
        assert_eq!(source_kind("Lens Edu/widgets/w.md"), None);
        assert_eq!(source_kind("Lens Edu/articles/a.md"), Some("article"));
    }

    fn entry(concept_id: &str, index: usize, body: &str) -> RowEntry {
        RowEntry {
            concept_id: concept_id.to_string(),
            concept_path: format!("Lens Edu/Concepts/{concept_id}.md"),
            concept_name: concept_id.to_string(),
            line: 1,
            index,
            body: body.to_string(),
        }
    }

    fn article(name: &str, rows: Vec<RowEntry>) -> SourceRows {
        SourceRows {
            source_path: name.to_string(),
            kind: "article",
            rows,
        }
    }

    #[test]
    fn group_puts_concept_with_lens_and_article_rows_once() {
        let own = vec![
            entry("Feedback", 0, "Feedback"),
            entry("Low-stakes", 0, "Low-stakes"),
        ];
        let articles = vec![
            article(
                "One",
                vec![
                    entry("Corrigibility", 0, "c"),
                    entry("Feedback", 0, "article note"),
                ],
            ),
            article("Two", vec![entry("Feedback", 0, "second article")]),
        ];
        let groups = group_lens_rows(&own, &articles);
        type Grouped = Vec<(String, Vec<(String, Vec<String>)>)>;
        let lens: Grouped = groups
            .lens
            .iter()
            .map(|(e, a)| {
                (
                    e.concept_id.clone(),
                    a.iter()
                        .map(|a| {
                            (
                                a.source_path.clone(),
                                a.rows.iter().map(|r| r.body.clone()).collect(),
                            )
                        })
                        .collect(),
                )
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
        let only: Vec<(String, Vec<String>)> = groups
            .source_only
            .iter()
            .map(|a| {
                (
                    a.source_path.clone(),
                    a.rows.iter().map(|r| r.concept_id.clone()).collect(),
                )
            })
            .collect();
        assert_eq!(
            only,
            vec![("One".to_string(), vec!["Corrigibility".to_string()])]
        );
    }

    #[test]
    fn group_attaches_article_rows_to_the_first_of_several_lens_rows_only() {
        let groups = group_lens_rows(
            &[entry("C", 0, ""), entry("C", 1, "")],
            &[article("A", vec![entry("C", 0, "")])],
        );
        let counts: Vec<usize> = groups.lens.iter().map(|(_, a)| a.len()).collect();
        assert_eq!(counts, vec![1, 0]);
    }

    #[test]
    fn group_keeps_every_article_row_apart_when_the_lens_has_none() {
        let articles = vec![article("A", vec![entry("B", 0, ""), entry("A", 0, "")])];
        let groups = group_lens_rows(&[], &articles);
        assert!(groups.lens.is_empty());
        assert_eq!(groups.source_only.len(), 1);
        let ids: Vec<&str> = groups.source_only[0]
            .rows
            .iter()
            .map(|r| r.concept_id.as_str())
            .collect();
        assert_eq!(ids, vec!["B", "A"]);
    }

    #[test]
    fn long_row_text_is_cut_with_a_pointer() {
        let mut e = entry("C", 0, &"é".repeat(MAX_ROW_CHARS + 50));
        e.concept_path = "Lens Edu/Concepts/C.md".into();
        e.line = 7;
        let mut out = String::new();
        render_body(&mut out, &e, "  ");
        assert!(out.contains(&"é".repeat(MAX_ROW_CHARS)));
        assert!(!out.contains(&"é".repeat(MAX_ROW_CHARS + 1)));
        assert!(out.contains("read Lens Edu/Concepts/C.md from line 7"));
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
FEEDBACK-LENS-NOTE: the chat prompt asks for feedback.

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
WIDGET-NOTE: must not show.
";

    const ARTICLE: &str = "# Redwood\n\nArticle body line.\n";
    const LENS: &str = "---\nid: x\n---\n#### Article\nsource:: [[../articles/ai-control-redwood]]\n\n#### Text\ncontent:: Intro words.\n\n#### Video\nsource:: [[../video_transcripts/control-talk]]\n\n#### Widget\nsource:: [[../widgets/quiz]]\n";

    const C_LOW_ID: &str = "c0000000-0000-4000-8000-000000000001";
    const LENS_ID: &str = "l0000000-0000-4000-8000-000000000001";

    async fn server() -> Arc<Server> {
        build_indexed_test_server_in(
            "Lens Edu",
            &[
                ("/Concepts/Low-stakes control.md", C_LOW_ID, C_LOW),
                (
                    "/Concepts/Feedback.md",
                    "c0000000-0000-4000-8000-000000000002",
                    C_FEEDBACK,
                ),
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
                ("/Lenses/Low-stakes control intro.md", LENS_ID, LENS),
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
                    "#### Article\nsource:: [[../articles/quiet]]\n",
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
            ],
        )
        .await
    }

    async fn read_at(server: &Arc<Server>, sid: &str, path: &str, offset: Option<u64>) -> String {
        let mut args = json!({ "file_path": path, "session_id": sid });
        if let Some(offset) = offset {
            args["offset"] = json!(offset);
        }
        read::execute(server, sid, &args).await.unwrap()
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
        let sid = setup_session_no_reads(&server);
        let out = read_at(
            &server,
            &sid,
            "Lens Edu/articles/ai-control-redwood.md",
            None,
        )
        .await;
        println!("{out}");

        assert!(out.starts_with(BLOCK_START), "got: {out}");
        assert!(out.contains("NOT part of this file's text"));
        assert!(out
            .contains("\"we have information about this pair\" (which may be a negative judgment"));
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
        // Rows about other files stay out.
        assert!(!out.contains("FEEDBACK-LENS-NOTE"));
        assert!(!out.contains("Lens uses"));
        // The file's own text keeps its numbering.
        assert_eq!(
            file_part(&out),
            "     1\t# Redwood\n     2\t\n     3\tArticle body line."
        );
    }

    #[tokio::test]
    async fn lens_read_groups_its_rows_with_its_articles_rows() {
        let server = server().await;
        let sid = setup_session_no_reads(&server);
        let out = read_at(
            &server,
            &sid,
            "Lens Edu/Lenses/Low-stakes control intro.md",
            None,
        )
        .await;
        println!("{out}");

        let expected_body = "
[Concept] Lens Edu/Concepts/Feedback.md
  ▸ Row about this lens (line 5):
    FEEDBACK-LENS-NOTE: the chat prompt asks for feedback.
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

── end of concept relationships ──";
        assert!(out.contains(expected_body), "got:\n{out}");
        assert!(out.contains("[[relative/path/to/this-lens]]"));
        assert!(out.contains("under \"## Relationships\""));
        // A widget source is not followed; Corrigibility shows once.
        assert!(!out.contains("WIDGET-NOTE"));
        assert_eq!(out.matches("Corrigibility.md").count(), 1);
        assert!(file_part(&out).starts_with("     1\t---\n     2\tid: x\n"));
    }

    #[tokio::test]
    async fn lens_without_own_rows_shows_only_the_article_group() {
        let server = server().await;
        let sid = setup_session_no_reads(&server);
        let out = read_at(&server, &sid, "Lens Edu/Lenses/Corrigible lens.md", None).await;
        assert!(out.starts_with(BLOCK_START), "got: {out}");
        assert!(out.contains("Concepts linked only via this lens's sources"));
        assert!(out.contains(
            "  ▸ Row about its article Lens Edu/articles/ai-control-redwood.md (line 5)"
        ));
        for concept in ["Corrigibility", "Feedback", "Low-stakes control"] {
            assert!(
                out.contains(&format!("[Concept] Lens Edu/Concepts/{concept}.md\n")),
                "missing {concept}: {out}"
            );
        }
        assert!(!out.contains("Row about this lens"));
        assert!(!out.contains("FEEDBACK-LENS-NOTE"));
    }

    #[tokio::test]
    async fn file_without_rows_has_no_block() {
        let server = server().await;
        let sid = setup_session_no_reads(&server);
        let out = read_at(&server, &sid, "Lens Edu/Lenses/Lonely lens.md", None).await;
        assert!(out.starts_with("     1\t#### Article"), "got: {out}");
        assert!(!out.contains("Concept relationships"));
        // A concept file itself gets no block.
        let out = read_at(&server, &sid, "Lens Edu/Concepts/Feedback.md", None).await;
        assert!(out.starts_with("     1\t# Feedback"), "got: {out}");
    }

    #[tokio::test]
    async fn plain_mention_only_lists_the_concept_file() {
        let server = server().await;
        let sid = setup_session_no_reads(&server);
        let out = read_at(
            &server,
            &sid,
            "Lens Edu/articles/lw-post-on-monitoring.md",
            None,
        )
        .await;
        assert!(out.starts_with(BLOCK_START), "got: {out}");
        assert!(out.contains(
            "Also mentioned (a link to this article outside any row) in: Lens Edu/Concepts/Low-stakes control.md"
        ));
        assert!(!out.contains("[Concept]"));
    }

    #[tokio::test]
    async fn second_chunk_of_a_paged_read_has_no_block() {
        let server = server().await;
        let sid = setup_session_no_reads(&server);
        let path = "Lens Edu/articles/ai-control-redwood.md";
        let first = read_at(&server, &sid, path, Some(1)).await;
        assert!(first.starts_with(BLOCK_START));
        let second = read_at(&server, &sid, path, Some(2)).await;
        assert_eq!(second, "     2\t\n     3\tArticle body line.");
    }

    #[tokio::test]
    async fn edit_after_read_applies_only_to_the_files_own_text() {
        let server = server().await;
        let sid = setup_session_no_reads(&server);
        let lens = "Lens Edu/Lenses/Low-stakes control intro.md";
        let concept = "Lens Edu/Concepts/Feedback.md";
        let concept_doc = format!("{RELAY_ID}-c0000000-0000-4000-8000-000000000002");
        let out = read_at(&server, &sid, lens, None).await;
        assert!(out.contains("FEEDBACK-LENS-NOTE"));

        // Reading the lens does not count as reading the concept files.
        let err = edit::execute(
            &server,
            &sid,
            &json!({
                "file_path": concept, "session_id": sid,
                "old_string": "FEEDBACK-LENS-NOTE", "new_string": "CHANGED",
            }),
        )
        .await
        .expect_err("concept file was not read");
        assert!(err.contains("must read this document"), "got: {err}");

        // Text shown in the block is not part of the lens.
        for old in [
            "FEEDBACK-LENS-NOTE",
            "end of concept relationships",
            "[Concept]",
        ] {
            let err = edit::execute(
                &server,
                &sid,
                &json!({
                    "file_path": lens, "session_id": sid,
                    "old_string": old, "new_string": "X",
                }),
            )
            .await
            .expect_err("block text must not match the lens");
            assert!(err.contains("not found"), "got: {err}");
        }
        assert_eq!(read_doc_content(&server, &concept_doc), C_FEEDBACK);

        // The lens's own text edits as usual, and its lines are unchanged.
        edit::execute(
            &server,
            &sid,
            &json!({
                "file_path": lens, "session_id": sid,
                "old_string": "Intro words.", "new_string": "Intro words, now longer.",
            }),
        )
        .await
        .expect("edit of the lens's own text");
        let after = read_at(&server, &sid, lens, None).await;
        assert!(
            file_part(&after).contains("     8\tcontent:: Intro words, now longer."),
            "got: {after}"
        );
        assert!(after.contains("FEEDBACK-LENS-NOTE"));

        // Editing the note goes through the concept file at the given line.
        let concept_out = read_at(&server, &sid, concept, None).await;
        assert!(concept_out.contains("     6\tFEEDBACK-LENS-NOTE"));
        edit::execute(
            &server,
            &sid,
            &json!({
                "file_path": concept, "session_id": sid,
                "old_string": "the chat prompt asks for feedback.",
                "new_string": "the chat prompt asks for feedback. Checked again.",
            }),
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
        // The concept file's read view (pending suggestions applied) decides
        // the row text and line numbers.
        let server = build_indexed_test_server_in(
            "Lens Edu",
            &[
                (
                    "/Concepts/C.md",
                    "c0000000-0000-4000-8000-000000000009",
                    "# C\n\n## Relationships\n\n### [[../articles/a]]\n{--Old--}{++New++} note.\n",
                ),
                (
                    "/articles/a.md",
                    "a0000000-0000-4000-8000-000000000009",
                    "A\n",
                ),
            ],
        )
        .await;
        let sid = setup_session_no_reads(&server);
        let out = read_at(&server, &sid, "Lens Edu/articles/a.md", None).await;
        assert!(
            out.contains("[Concept] Lens Edu/Concepts/C.md (row at line 5)\n  New note."),
            "got: {out}"
        );
    }

    #[tokio::test]
    async fn many_backlinking_concepts_are_capped_and_counted() {
        let n = MAX_CONCEPT_FILES_PER_TARGET + 3;
        let concepts: Vec<(String, String, String)> = (0..n)
            .map(|i| {
                (
                    format!("/Concepts/C{i:02}.md"),
                    format!("c0000000-0000-4000-8000-{i:012}"),
                    format!("## Relationships\n\n### [[../articles/a]]\nNote {i}.\n"),
                )
            })
            .collect();
        let mut entries: Vec<(&str, &str, &str)> = concepts
            .iter()
            .map(|(p, u, t)| (p.as_str(), u.as_str(), t.as_str()))
            .collect();
        entries.push((
            "/articles/a.md",
            "a0000000-0000-4000-8000-000000000009",
            "A\n",
        ));
        let server = build_indexed_test_server_in("Lens Edu", &entries).await;
        let sid = setup_session_no_reads(&server);
        let out = read_at(&server, &sid, "Lens Edu/articles/a.md", None).await;
        assert_eq!(
            out.matches("[Concept]").count(),
            MAX_CONCEPT_FILES_PER_TARGET
        );
        assert!(
            out.contains("(3 more concept file(s) link to this article but were not read; use get_links to list them.)"),
            "got: {out}"
        );
    }

    #[tokio::test]
    async fn video_transcript_read_shows_its_rows() {
        let server = server().await;
        let sid = setup_session_no_reads(&server);
        let out = read_at(
            &server,
            &sid,
            "Lens Edu/video_transcripts/control-talk.md",
            None,
        )
        .await;
        assert!(out.starts_with(BLOCK_START), "got: {out}");
        assert!(out.contains("[[relative/path/to/this-video]]"));
        assert!(out.contains(
            "[Concept] Lens Edu/Concepts/Corrigibility.md (row at line 8)\n  The talk defines corrigibility briefly."
        ));
        // The row heading with closing hashes counts.
        assert!(out.contains(
            "[Concept] Lens Edu/Concepts/Low-stakes control.md (row at line 17)\n  The talk covers low-stakes control at 12:00."
        ));
        assert_eq!(file_part(&out), "     1\tTranscript line one.");
    }

    #[tokio::test]
    async fn lens_without_concept_backlinkers_skips_the_tree_walk() {
        let server = server().await;
        let sid = setup_session_no_reads(&server);
        let before = TREE_WALKS.with(|c| c.get());
        let out = read_at(&server, &sid, "Lens Edu/Lenses/Quiet lens.md", None).await;
        assert!(out.starts_with("     1\t#### Article"), "got: {out}");
        let out = read_at(&server, &sid, "Lens Edu/articles/quiet.md", None).await;
        assert!(out.starts_with("     1\tNobody links here."), "got: {out}");
        assert_eq!(
            TREE_WALKS.with(|c| c.get()),
            before,
            "no tree walk expected"
        );
        // A lens with rows does walk it, once.
        read_at(
            &server,
            &sid,
            "Lens Edu/Lenses/Low-stakes control intro.md",
            None,
        )
        .await;
        assert_eq!(TREE_WALKS.with(|c| c.get()), before + 1);
    }

    async fn small_server() -> Arc<Server> {
        build_indexed_test_server_in(
            "Lens Edu",
            &[
                // Root fallback, other case (rule #7); lower-case name (rule #9).
                (
                    "/Concepts/alpha.md",
                    "c0000000-0000-4000-8000-000000000011",
                    "## Relationships\n### [[Lens Edu/articles/AI-CONTROL-REDWOOD]]\nAlpha note.\n",
                ),
                (
                    "/Concepts/Beta.md",
                    "c0000000-0000-4000-8000-000000000012",
                    "## Relationships\n### [[../articles/ai-control-redwood.md]]\nBeta note.\n",
                ),
                (
                    "/articles/ai-control-redwood.md",
                    "a0000000-0000-4000-8000-000000000011",
                    "A\n",
                ),
                (
                    "/Lenses/L.md",
                    "l0000000-0000-4000-8000-000000000011",
                    "#### Article\nsource:: [[../articles/ai-control-redwood.md]]\n",
                ),
            ],
        )
        .await
    }

    // canonical concept-row rules v1 #7
    #[tokio::test]
    async fn canonical_7_rows_match_by_resolved_document_case_insensitive_root_fallback() {
        let server = small_server().await;
        let sid = setup_session_no_reads(&server);
        let out = read_at(
            &server,
            &sid,
            "Lens Edu/articles/ai-control-redwood.md",
            None,
        )
        .await;
        assert!(
            out.contains("[Concept] Lens Edu/Concepts/alpha.md (row at line 2)\n  Alpha note."),
            "got: {out}"
        );
        assert!(out.contains("[Concept] Lens Edu/Concepts/Beta.md (row at line 2)"));
        // A source link with .md is followed too.
        let out = read_at(&server, &sid, "Lens Edu/Lenses/L.md", None).await;
        assert!(
            out.contains("Row about its article Lens Edu/articles/ai-control-redwood.md"),
            "got: {out}"
        );
    }

    // canonical concept-row rules v1 #9
    #[tokio::test]
    async fn canonical_9_rows_sort_by_lower_case_concept_name() {
        let server = small_server().await;
        let sid = setup_session_no_reads(&server);
        let out = read_at(
            &server,
            &sid,
            "Lens Edu/articles/ai-control-redwood.md",
            None,
        )
        .await;
        let alpha = out.find("Concepts/alpha.md").expect("alpha");
        let beta = out.find("Concepts/Beta.md").expect("Beta");
        assert!(alpha < beta, "got: {out}");
    }
}
