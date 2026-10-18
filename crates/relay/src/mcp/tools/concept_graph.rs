//! The concept graph in `read` output.
//!
//! Each concept file (`Lens Edu/Concepts/<name>.md`) names its broader
//! concepts in a `parent-concepts:` frontmatter list of wikilinks; the first
//! is the primary one. "Part of" goes upward only, and the graph should be a
//! DAG (shortcut edges are fine; cycles are invalid content, which the
//! platform validator reports):
//!
//! ```text
//! ---
//! parent-concepts:
//!   - "[[Control protocols]]"
//!   - "[[Monitoring and interpretability]]"
//! ---
//! ```
//!
//! An MCP `read` of a concept file starts (first chunk only) with a short
//! block: its parent concepts, each with its main path up to the top, and its
//! child concepts (concept files whose parents include this one) with how
//! many concepts are below each. The parsing rules ("concept graph rules v1
//! #N") and caps are the editor's (`lens-editor/src/lib/concept-graph.ts`);
//! see `docs/concept-relationships.md`, "Concept graph".

use super::concept_rows::{concepts_linking_to, load_text, resolver_entries, LOAD_CONCURRENCY};
use crate::server::Server;
use futures::StreamExt;
use regex::Regex;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, OnceLock};
use y_sweet_core::link_indexer::{without_terminal_md, VirtualTreeIndex};

/// Resolver-path prefix of concept files.
const CONCEPTS_FOLDER: &str = "Lens Edu/Concepts/";
/// The frontmatter key that lists a concept's parents.
const PARENTS_KEY: &str = "parent-concepts";
/// Levels followed upward or downward.
const MAX_DEPTH: usize = 20;
/// Ancestors walked.
const MAX_ANCESTORS: usize = 30;
/// Concepts visited by the walk below (for the "+N below" counts).
const MAX_NODES: usize = 200;
/// Backlinkers of one concept read when looking for its children.
const MAX_CHILD_CANDIDATES: usize = 80;
/// Concept files loaded by one `read` in all (ancestors and below).
const MAX_FILES_PER_READ: usize = 200;

/// Whether the file at resolver path `path` is a concept file.
pub(crate) fn is_concept_path(path: &str) -> bool {
    path.starts_with(CONCEPTS_FOLDER) && without_terminal_md(path).len() != path.len()
}

// ---------------------------------------------------------------------------
// Parsing (concept graph rules v1, as in the editor's concept-graph.ts)
// ---------------------------------------------------------------------------

/// One parent entry: the wikilink page (`link`), or None when the entry is
/// not a single wikilink (`raw` is then what was written).
#[derive(Debug, Clone, PartialEq)]
struct ParentEntry {
    raw: String,
    link: Option<String>,
}

fn regex(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).unwrap())
}

/// A value with a trailing YAML comment removed and its quotes taken off
/// (rules #4, #5). A `#` inside quotes is kept.
fn scalar(value: &str) -> String {
    static COMMENT: OnceLock<Regex> = OnceLock::new();
    let v = value.trim();
    if let Some(q) = v.chars().next().filter(|c| *c == '"' || *c == '\'') {
        if let Some(close) = v[1..].find(q) {
            return v[1..1 + close].trim().to_string();
        }
    }
    regex(&COMMENT, r"[ \t]+#.*$")
        .replace(v, "")
        .trim()
        .to_string()
}

fn entry_of(value: &str) -> Option<ParentEntry> {
    static WIKILINK: OnceLock<Regex> = OnceLock::new();
    let raw = scalar(value);
    if raw.is_empty() {
        return None;
    }
    let link = regex(&WIKILINK, r"^\[\[([^\[\]\n]+)\]\]$")
        .captures(&raw)
        .map(|c| {
            let inner = c.get(1).unwrap().as_str();
            let page = inner.split('|').next().unwrap_or("");
            page.split('#').next().unwrap_or("").trim().to_string()
        })
        .filter(|l| !l.is_empty());
    Some(ParentEntry { raw, link })
}

/// The `parent-concepts:` entries of a file's frontmatter, in order: a block
/// list (#1), one value (#2) or a flow list (#3); quoted or unquoted `[[X]]`
/// (#4); trailing comments (#5); only the frontmatter and its first such key
/// (#6). Line-based, as in the editor.
fn parse_parents(text: &str) -> Vec<ParentEntry> {
    static DELIM: OnceLock<Regex> = OnceLock::new();
    static KEY: OnceLock<Regex> = OnceLock::new();
    static FLOW_PART: OnceLock<Regex> = OnceLock::new();
    static ITEM: OnceLock<Regex> = OnceLock::new();
    let delim = regex(&DELIM, r"^---[ \t]*$");
    let lines: Vec<&str> = text
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect();
    if !lines.first().is_some_and(|l| delim.is_match(l)) {
        return Vec::new();
    }
    let Some(end) = lines
        .iter()
        .skip(1)
        .position(|l| delim.is_match(l))
        .map(|i| i + 1)
    else {
        return Vec::new();
    };
    let key = regex(&KEY, &format!(r"^{PARENTS_KEY}[ \t]*:(.*)$"));
    let mut out = Vec::new();
    let mut push = |value: &str| {
        if let Some(entry) = entry_of(value) {
            out.push(entry);
        }
    };
    for i in 1..end {
        let Some(m) = key.captures(lines[i]) else {
            continue;
        };
        let inline = m.get(1).unwrap().as_str().trim();
        if inline.starts_with('[') && !inline.starts_with("[[") {
            // Flow list (#3): up to its closing `]`.
            let inner = match inline.rfind(']') {
                Some(close) if close > 0 => &inline[1..close],
                _ => &inline[1..],
            };
            let parts = regex(&FLOW_PART, r#""[^"]*"|'[^']*'|\[\[[^\]]*\]\]|[^,]+"#);
            for part in parts.find_iter(inner) {
                push(part.as_str());
            }
        } else if !inline.is_empty() && !inline.starts_with('#') {
            push(inline);
        }
        // Block list items (#1): until the next key.
        for line in &lines[i + 1..end] {
            if line.trim().is_empty() {
                continue;
            }
            if let Some(item) = regex(&ITEM, r"^[ \t]*-(?:[ \t]+(.*))?$").captures(line) {
                push(item.get(1).map_or("", |m| m.as_str()));
                continue;
            }
            if !line.starts_with([' ', '\t']) {
                break;
            }
        }
        break; // only the first key counts (#6)
    }
    out
}

/// A concept file's parents resolved to concept files (uuids, in order,
/// without repeats), and the entries that do not resolve to one.
#[derive(Debug, Clone, Default, PartialEq)]
struct ResolvedParents {
    parents: Vec<String>,
    unresolved: Vec<String>,
}

/// [`parse_parents`] of the file at resolver path `path`, each link resolved
/// like the link indexer resolves (#7), kept when it is a concept file.
fn resolve_parents(text: &str, path: &str, index: &VirtualTreeIndex<'_>) -> ResolvedParents {
    let source_virtual = format!("/{path}");
    let mut out = ResolvedParents::default();
    for entry in parse_parents(text) {
        let resolved = entry.link.as_deref().and_then(|link| {
            index
                .resolve(link, Some(&source_virtual))
                .filter(|e| is_concept_path(&e.virtual_path[1..]))
        });
        match resolved {
            Some(e) if !out.parents.contains(&e.id) => out.parents.push(e.id.clone()),
            Some(_) => {}
            None => out.unresolved.push(entry.raw),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Graph walks (pure; the editor's buildAncestors, mainPath, countBelow)
// ---------------------------------------------------------------------------

#[derive(Debug, Default, PartialEq)]
struct Ancestors {
    nodes: Vec<String>,
    /// A cycle through parent links, first id repeated at the end.
    cycle: Option<Vec<String>>,
    /// A cap (depth or files) cut the walk.
    cut: bool,
    /// Files still to load to finish the walk.
    pending: Vec<String>,
}

/// Ancestors of `start`, breadth-first through `parents_of` (None: not
/// loaded yet) within [`MAX_DEPTH`] levels and [`MAX_ANCESTORS`] files.
fn build_ancestors<'a>(
    start: &str,
    parents_of: impl Fn(&str) -> Option<&'a ResolvedParents>,
) -> Ancestors {
    let mut depth: HashMap<String, usize> = HashMap::from([(start.to_string(), 0)]);
    let mut order = vec![start.to_string()];
    let mut queue = VecDeque::from([start.to_string()]);
    let mut out = Ancestors::default();
    while let Some(id) = queue.pop_front() {
        let Some(info) = parents_of(&id) else {
            out.pending.push(id);
            continue;
        };
        let d = depth[&id];
        for p in &info.parents {
            if depth.contains_key(p) {
                continue;
            }
            if d + 1 > MAX_DEPTH || depth.len() > MAX_ANCESTORS {
                out.cut = true;
                continue;
            }
            depth.insert(p.clone(), d + 1);
            order.push(p.clone());
            queue.push_back(p.clone());
        }
    }
    let next = |id: &str| -> Vec<String> {
        parents_of(id)
            .map(|i| {
                i.parents
                    .iter()
                    .filter(|p| depth.contains_key(*p))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    };
    out.cycle = find_cycle(&order, &next);
    out.nodes = order.into_iter().filter(|id| id != start).collect();
    out
}

/// First parents followed upward from `start`, top-level concept first, the
/// direct parent last (`start` left out); stops at a repeat.
fn main_path<'a>(
    start: &str,
    parents_of: impl Fn(&str) -> Option<&'a ResolvedParents>,
) -> Vec<String> {
    let mut path = Vec::new();
    let mut seen: HashSet<String> = HashSet::from([start.to_string()]);
    let mut cur = start.to_string();
    while path.len() < MAX_DEPTH {
        let Some(first) = parents_of(&cur).and_then(|i| i.parents.first()) else {
            break;
        };
        if !seen.insert(first.clone()) {
            break;
        }
        path.push(first.clone());
        cur = first.clone();
    }
    path.reverse();
    path
}

/// A cycle among `nodes` through `next`, first id repeated at the end.
fn find_cycle(nodes: &[String], next: &impl Fn(&str) -> Vec<String>) -> Option<Vec<String>> {
    #[derive(PartialEq)]
    enum State {
        Open,
        Done,
    }
    fn visit(
        id: &str,
        next: &impl Fn(&str) -> Vec<String>,
        state: &mut HashMap<String, State>,
        stack: &mut Vec<String>,
    ) -> Option<Vec<String>> {
        state.insert(id.to_string(), State::Open);
        stack.push(id.to_string());
        for n in next(id) {
            match state.get(&n) {
                Some(State::Open) => {
                    let at = stack.iter().position(|s| *s == n).unwrap_or(0);
                    let mut cycle = stack[at..].to_vec();
                    cycle.push(n);
                    return Some(cycle);
                }
                Some(State::Done) => {}
                None => {
                    if let Some(found) = visit(&n, next, state, stack) {
                        return Some(found);
                    }
                }
            }
        }
        stack.pop();
        state.insert(id.to_string(), State::Done);
        None
    }
    let mut state = HashMap::new();
    let mut stack = Vec::new();
    for id in nodes {
        if !state.contains_key(id) {
            if let Some(found) = visit(id, next, &mut state, &mut stack) {
                return Some(found);
            }
        }
    }
    None
}

/// Distinct concepts below `id` in `kids` (`start` left out); `cut` when the
/// walk did not expand all of them.
fn count_below(id: &str, kids: &HashMap<String, Vec<String>>, start: &str) -> (usize, bool) {
    let mut seen: HashSet<&str> = HashSet::from([id, start]);
    let mut queue = VecDeque::from([id]);
    let mut cut = false;
    while let Some(cur) = queue.pop_front() {
        let Some(next) = kids.get(cur) else {
            if cur != id {
                cut = true;
            }
            continue;
        };
        for k in next {
            if seen.insert(k.as_str()) {
                queue.push_back(k.as_str());
            }
        }
    }
    (seen.len() - if id == start { 1 } else { 2 }, cut)
}

// ---------------------------------------------------------------------------
// Loading and rendering
// ---------------------------------------------------------------------------

const BLOCK_START: &str = "── Concept graph (context — NOT part of this file's text) ──";
const BLOCK_END: &str = "── end of concept graph ──";
const EDIT_HINT: &str = "Edit this file's parents in its `parent-concepts:` frontmatter (the first is the primary one); each child lists this file in its own. \"Part of\" goes upward only. Line numbers below the end marker are this file's own.";

/// Loads concept files and resolves their parents, each once per `read`,
/// at most [`MAX_FILES_PER_READ`] in all.
struct GraphLoader<'a> {
    server: &'a Arc<Server>,
    index: &'a VirtualTreeIndex<'a>,
    parents: HashMap<String, ResolvedParents>,
    loaded: usize,
    failed: usize,
    /// Files passed over because the per-read total was reached.
    unread: usize,
}

impl GraphLoader<'_> {
    async fn load(&mut self, ids: &[String]) {
        let server = self.server;
        let mut wanted: Vec<(String, Option<String>)> = Vec::new();
        for id in ids {
            if self.parents.contains_key(id) || wanted.iter().any(|(w, _)| w == id) {
                continue;
            }
            if self.loaded + wanted.len() >= MAX_FILES_PER_READ {
                // Over the total: counted as having no parents.
                self.unread += 1;
                self.parents.insert(id.clone(), ResolvedParents::default());
                continue;
            }
            wanted.push((id.clone(), server.doc_resolver().path_for_uuid(id)));
        }
        self.loaded += wanted.len();
        let loaded: Vec<(String, Option<(String, String)>)> = futures::stream::iter(wanted)
            .map(|(id, path)| async move {
                let Some(path) = path else {
                    return (id, None);
                };
                let text = load_text(server, &path).await;
                (id, text.map(|t| (path, t)))
            })
            .buffer_unordered(LOAD_CONCURRENCY)
            .collect()
            .await;
        for (id, found) in loaded {
            let parents = match found {
                Some((path, text)) => resolve_parents(&text, &path, self.index),
                None => {
                    self.failed += 1;
                    ResolvedParents::default()
                }
            };
            self.parents.insert(id, parents);
        }
    }
}

/// Everything below the read file: the children of each concept reached.
struct Below {
    kids: HashMap<String, Vec<String>>,
    cut: bool,
    cycle: bool,
    /// Concept files linking to the read file that were not read (over
    /// [`MAX_CHILD_CANDIDATES`]).
    candidates_over_cap: usize,
}

/// Breadth-first below `start`: each concept's backlinkers in the concepts
/// folder ([`MAX_CHILD_CANDIDATES`] at most), kept when their parents
/// include it, within [`MAX_DEPTH`] levels and [`MAX_NODES`] concepts.
async fn walk_below(
    server: &Arc<Server>,
    loader: &mut GraphLoader<'_>,
    folder_doc_id: &str,
    start: &str,
) -> Below {
    let mut out = Below {
        kids: HashMap::new(),
        cut: false,
        cycle: false,
        candidates_over_cap: 0,
    };
    let mut depth: HashMap<String, usize> = HashMap::from([(start.to_string(), 0)]);
    let mut queue = VecDeque::from([start.to_string()]);
    while let Some(id) = queue.pop_front() {
        let mut candidates: Vec<String> = concepts_linking_to(server, folder_doc_id, &id)
            .await
            .into_iter()
            .map(|(c, _)| c)
            .collect();
        let over = candidates.len().saturating_sub(MAX_CHILD_CANDIDATES);
        if over > 0 {
            if id == start {
                out.candidates_over_cap = over;
            } else {
                out.cut = true;
            }
        }
        candidates.truncate(MAX_CHILD_CANDIDATES);
        let unread_before = loader.unread;
        loader.load(&candidates).await;
        if loader.unread > unread_before {
            out.cut = true;
        }
        let mut kids: Vec<String> = Vec::new();
        for c in candidates {
            if !loader
                .parents
                .get(&c)
                .is_some_and(|p| p.parents.contains(&id))
            {
                continue;
            }
            if c == start {
                out.cycle = true;
                continue;
            }
            kids.push(c);
        }
        for k in &kids {
            if depth.contains_key(k) {
                continue;
            }
            if depth[&id] + 1 > MAX_DEPTH || depth.len() > MAX_NODES {
                out.cut = true;
                continue;
            }
            depth.insert(k.clone(), depth[&id] + 1);
            queue.push_back(k.clone());
        }
        out.kids.insert(id, kids);
    }
    out
}

/// Resolver path of `id`, or the id itself.
fn path_of(server: &Arc<Server>, id: &str) -> String {
    server
        .doc_resolver()
        .path_for_uuid(id)
        .unwrap_or_else(|| id.to_string())
}

/// The concept-graph block for the concept file at resolver path `path`
/// (uuid `uuid`, in folder doc `folder_doc_id`) whose `read` text is `text`;
/// None for any other file.
pub(crate) async fn concept_graph_block(
    server: &Arc<Server>,
    path: &str,
    uuid: &str,
    folder_doc_id: &str,
    text: &str,
) -> Option<String> {
    if !is_concept_path(path) {
        return None;
    }
    let entries = resolver_entries(server);
    let index = VirtualTreeIndex::new(&entries);
    let mut loader = GraphLoader {
        server,
        index: &index,
        parents: HashMap::new(),
        loaded: 0,
        failed: 0,
        unread: 0,
    };
    let own = resolve_parents(text, path, &index);
    loader.parents.insert(uuid.to_string(), own.clone());

    // Ancestors: load each level the walk reaches (at most MAX_DEPTH rounds).
    let ancestors = loop {
        let a = build_ancestors(uuid, |id| loader.parents.get(id));
        if a.pending.is_empty() {
            break a;
        }
        loader.load(&a.pending).await;
    };
    let below = walk_below(server, &mut loader, folder_doc_id, uuid).await;

    let mut out = String::new();
    if own.parents.is_empty() {
        out.push_str(if own.unresolved.is_empty() {
            "Parent concepts: none (top-level concept)\n"
        } else {
            "Parent concepts: none resolved\n"
        });
    } else {
        out.push_str("Parent concepts:\n");
        for (i, p) in own.parents.iter().enumerate() {
            let mut up = main_path(p, |id| loader.parents.get(id));
            up.reverse();
            let up: Vec<String> = up.iter().map(|id| path_of(server, id)).collect();
            out.push_str(&format!(
                "  - {}{}{}\n",
                path_of(server, p),
                if i == 0 && own.parents.len() > 1 {
                    " (primary)"
                } else {
                    ""
                },
                if up.is_empty() {
                    " — top-level".to_string()
                } else {
                    format!(" — up: {}", up.join(" › "))
                }
            ));
        }
    }
    for raw in &own.unresolved {
        out.push_str(&format!(
            "Parent not found: {raw} (not a wikilink to a file in {})\n",
            CONCEPTS_FOLDER.trim_end_matches('/')
        ));
    }
    let mut children: Vec<(String, usize, bool)> = below
        .kids
        .get(uuid)
        .map(|kids| {
            kids.iter()
                .map(|k| {
                    let (n, cut) = count_below(k, &below.kids, uuid);
                    (path_of(server, k), n, cut || below.cut)
                })
                .collect()
        })
        .unwrap_or_default();
    children.sort_by_key(|(p, _, _)| p.to_lowercase());
    if !children.is_empty() {
        out.push_str("Child concepts:\n");
        for (p, n, cut) in &children {
            let count = match (*n, *cut) {
                (0, false) => String::new(),
                (n, cut) => format!(" (+{n}{} below)", if cut { "+" } else { "" }),
            };
            out.push_str(&format!("  - {p}{count}\n"));
        }
    }
    if below.candidates_over_cap > 0 {
        out.push_str(&format!(
            "({} more concept file(s) link here but were not read; use get_links to list them.)\n",
            below.candidates_over_cap
        ));
    }
    let through_self = below.cycle
        || ancestors
            .cycle
            .as_ref()
            .is_some_and(|c| c.iter().any(|id| id == uuid));
    if let Some(cycle) = &ancestors.cycle {
        let names: Vec<String> = cycle.iter().map(|id| path_of(server, id)).collect();
        out.push_str(&format!(
            "A cycle runs {} this file (invalid — a concept cannot be part of itself): {}\n",
            if through_self { "through" } else { "above" },
            names.join(" › ")
        ));
    } else if through_self {
        out.push_str(
            "A cycle runs through this file (invalid — a concept cannot be part of itself).\n",
        );
    }
    if ancestors.cut {
        out.push_str(&format!(
            "(Ancestors cut at {MAX_DEPTH} levels or {MAX_ANCESTORS} concepts.)\n"
        ));
    }
    if loader.unread > 0 {
        out.push_str(&format!(
            "({} concept file(s) not read: at most {MAX_FILES_PER_READ} per read; counts marked + may be higher.)\n",
            loader.unread
        ));
    }
    if loader.failed > 0 {
        out.push_str(&format!(
            "({} concept file(s) could not be read.)\n",
            loader.failed
        ));
    }
    Some(format!("{BLOCK_START}\n{out}{EDIT_HINT}\n{BLOCK_END}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use y_sweet_core::link_indexer::VirtualEntry;

    fn links(text: &str) -> Vec<Option<String>> {
        parse_parents(text).into_iter().map(|e| e.link).collect()
    }

    fn some(v: &[&str]) -> Vec<Option<String>> {
        v.iter().map(|s| Some(s.to_string())).collect()
    }

    // The inputs below are the editor's (concept-graph.test.ts), so the two agree.

    #[test]
    fn concept_graph_rules_v1_1_block_list_until_the_next_key() {
        let text =
            "---\nparent-concepts:\n  - \"[[A]]\"\n  - \"[[B]]\"\ntags:\n  - \"[[C]]\"\n---\n";
        assert_eq!(links(text), some(&["A", "B"]));
    }

    #[test]
    fn concept_graph_rules_v1_2_single_value() {
        assert_eq!(
            links("---\nparent-concepts: \"[[A]]\"\n---\n"),
            some(&["A"])
        );
    }

    #[test]
    fn concept_graph_rules_v1_3_flow_list() {
        assert_eq!(
            links("---\nparent-concepts: [\"[[A]]\", '[[B]]']\n---\n"),
            some(&["A", "B"])
        );
    }

    #[test]
    fn concept_graph_rules_v1_4_quoted_and_unquoted_links() {
        let text =
            "---\nparent-concepts:\n- [[A|alias]]\n- '[[B#h]]'\n- \"[[../Concepts/C]]\"\n---\n";
        assert_eq!(links(text), some(&["A", "B", "../Concepts/C"]));
        assert_eq!(links("---\nparent-concepts: [[A]]\n---\n"), some(&["A"]));
    }

    #[test]
    fn concept_graph_rules_v1_5_trailing_comments() {
        let text = "---\nparent-concepts:\n  - \"[[A]]\" # main\n  - [[B]]  # second\n  - \"[[C #x]]\"\n---\n";
        assert_eq!(links(text), some(&["A", "B", "C"]));
        assert_eq!(
            links("---\nparent-concepts: \"[[A]]\" # only one\n---\n"),
            some(&["A"])
        );
    }

    #[test]
    fn concept_graph_rules_v1_6_frontmatter_only_first_key_raw_non_links() {
        let text = "---\nparent-concepts:\n  - Plain text\n  - \"\"\nparent-concepts: \"[[Z]]\"\n---\nparent-concepts: \"[[Y]]\"\n";
        assert_eq!(
            parse_parents(text),
            vec![ParentEntry {
                raw: "Plain text".into(),
                link: None
            }]
        );
        assert!(parse_parents("# T\nparent-concepts: \"[[A]]\"\n").is_empty());
        assert!(parse_parents("---\nparent-concepts: \"[[A]]\"\n").is_empty());
        assert!(parse_parents("---\nparent: \"[[A]]\"\n---\n").is_empty());
        assert_eq!(
            links("---\r\nparent-concepts:\r\n  - \"[[A]]\"\r\n---  \r\nx"),
            some(&["A"])
        );
    }

    #[test]
    fn concept_graph_rules_v1_7_resolution_like_the_link_indexer() {
        let entry = |path: &str, id: &str| VirtualEntry {
            entry_type: "markdown".into(),
            virtual_path: path.into(),
            id: id.into(),
            folder_idx: 0,
        };
        let entries = vec![
            entry("/Lens Edu/Concepts/AI Control.md", "control"),
            entry("/Lens Edu/Concepts/Monitoring.md", "mon"),
            entry("/Lens Edu/articles/X.md", "art"),
        ];
        let index = VirtualTreeIndex::new(&entries);
        let text = "---\nparent-concepts:\n  - \"[[ai control]]\"\n  - \"[[Lens Edu/Concepts/Monitoring]]\"\n  - \"[[AI Control]]\"\n  - \"[[../articles/X]]\"\n  - \"[[Missing]]\"\n---\n";
        assert_eq!(
            resolve_parents(text, "Lens Edu/Concepts/Low-stakes control.md", &index),
            ResolvedParents {
                parents: vec!["control".into(), "mon".into()],
                unresolved: vec!["[[../articles/X]]".into(), "[[Missing]]".into()],
            }
        );
    }

    fn graph(edges: &[(&str, &[&str])]) -> HashMap<String, ResolvedParents> {
        edges
            .iter()
            .map(|(id, ps)| {
                (
                    id.to_string(),
                    ResolvedParents {
                        parents: ps.iter().map(|s| s.to_string()).collect(),
                        unresolved: vec![],
                    },
                )
            })
            .collect()
    }

    fn ancestors(start: &str, g: &HashMap<String, ResolvedParents>) -> Ancestors {
        static EMPTY: OnceLock<ResolvedParents> = OnceLock::new();
        let empty = EMPTY.get_or_init(ResolvedParents::default);
        build_ancestors(start, |id| Some(g.get(id).unwrap_or(empty)))
    }

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn multiple_parents_and_shortcut_edges() {
        let g = graph(&[
            ("tm", &["low", "mon", "protocols"]),
            ("low", &["protocols"]),
            ("protocols", &["control"]),
        ]);
        let a = ancestors("tm", &g);
        let mut nodes = a.nodes.clone();
        nodes.sort();
        assert_eq!(nodes, ids(&["control", "low", "mon", "protocols"]));
        assert_eq!(a.cycle, None);
        assert_eq!(
            main_path("tm", |id| g.get(id)),
            ids(&["control", "protocols", "low"])
        );
    }

    #[test]
    fn cycles_are_reported_and_never_hang() {
        let g = graph(&[("A", &["B"]), ("B", &["C"]), ("C", &["A"])]);
        assert_eq!(ancestors("A", &g).cycle, Some(ids(&["A", "B", "C", "A"])));
        assert_eq!(main_path("A", |id| g.get(id)), ids(&["C", "B"]));
        let g = graph(&[("A", &["A", "B"])]);
        assert_eq!(ancestors("A", &g).cycle, Some(ids(&["A", "A"])));
    }

    #[test]
    fn caps_depth_and_files() {
        let g: HashMap<String, ResolvedParents> = (0..30)
            .map(|i| {
                (
                    format!("n{i}"),
                    ResolvedParents {
                        parents: vec![format!("n{}", i + 1)],
                        unresolved: vec![],
                    },
                )
            })
            .collect();
        let a = ancestors("n0", &g);
        assert!(a.cut);
        assert_eq!(a.nodes.len(), MAX_DEPTH);

        let wide: Vec<String> = (0..MAX_ANCESTORS + 10).map(|i| format!("p{i}")).collect();
        let g = HashMap::from([(
            "A".to_string(),
            ResolvedParents {
                parents: wide,
                unresolved: vec![],
            },
        )]);
        let a = ancestors("A", &g);
        assert!(a.cut);
        assert!(a.nodes.len() <= MAX_ANCESTORS);
    }

    #[test]
    fn unloaded_files_are_pending() {
        let g = graph(&[("A", &["B"])]);
        assert_eq!(build_ancestors("A", |id| g.get(id)).pending, ids(&["B"]));
    }

    #[test]
    fn counts_distinct_concepts_below() {
        let kids: HashMap<String, Vec<String>> = [
            ("start", vec!["b", "c"]),
            ("b", vec!["d"]),
            ("c", vec!["d"]),
            ("d", vec![]),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.into_iter().map(String::from).collect()))
        .collect();
        assert_eq!(count_below("start", &kids, "start"), (3, false));
        assert_eq!(count_below("b", &kids, "start"), (1, false));
        // "e" was never expanded: the count may be higher.
        let mut cut = kids.clone();
        cut.insert("d".into(), vec!["e".into()]);
        assert_eq!(count_below("b", &cut, "start"), (2, true));
    }
}

#[cfg(test)]
mod read_tests {
    //! `read` of concept files, on a server whose backlinks the link indexer built.
    use super::*;
    use crate::mcp::tools::read;
    use crate::mcp::tools::test_helpers::*;
    use serde_json::json;

    fn fm(parents: &[&str], body: &str) -> String {
        let mut s = String::from("---\nparent-concepts:\n");
        for p in parents {
            s.push_str(&format!("  - \"[[{p}]]\"\n"));
        }
        s.push_str("---\n");
        s.push_str(body);
        s
    }

    fn c(n: u32) -> String {
        format!("c0000000-0000-4000-8000-{n:012}")
    }

    fn fixture() -> Vec<(String, String, String)> {
        vec![
            (
                "/Concepts/AI Control.md".into(),
                c(1),
                "---\nskill-tree: domain\n---\n# AI Control\n".into(),
            ),
            (
                "/Concepts/Control protocols.md".into(),
                c(2),
                fm(&["AI Control"], "# Control protocols\n"),
            ),
            (
                "/Concepts/Low-stakes control.md".into(),
                c(3),
                fm(
                    &["Control protocols"],
                    "# Low-stakes control\n\nContrast [[High-stakes control]].\n",
                ),
            ),
            (
                "/Concepts/High-stakes control.md".into(),
                c(4),
                fm(&["Control protocols"], "# High-stakes control\n"),
            ),
            (
                "/Concepts/Monitoring and interpretability.md".into(),
                c(5),
                "# Monitoring and interpretability\n".into(),
            ),
            (
                "/Concepts/Trusted monitoring.md".into(),
                c(6),
                fm(
                    &[
                        "Low-stakes control",
                        "Monitoring and interpretability",
                        "Control protocols",
                        "Missing concept",
                    ],
                    "# Trusted monitoring\n\nBody line.\n",
                ),
            ),
            (
                "/Concepts/Cycle A.md".into(),
                c(7),
                fm(&["Cycle B"], "# A\n"),
            ),
            (
                "/Concepts/Cycle B.md".into(),
                c(8),
                fm(&["Cycle A"], "# B\n"),
            ),
            (
                "/Concepts/Only broken.md".into(),
                c(9),
                fm(&["Nowhere"], "# Only broken\n"),
            ),
            (
                "/articles/Some article.md".into(),
                "a0000000-0000-4000-8000-000000000001".into(),
                "# Art\n\n[[../Concepts/Low-stakes control]]\n".into(),
            ),
        ]
    }

    async fn server_with(files: &[(String, String, String)]) -> Arc<Server> {
        let entries: Vec<(&str, &str, &str)> = files
            .iter()
            .map(|(p, i, t)| (p.as_str(), i.as_str(), t.as_str()))
            .collect();
        build_indexed_test_server_in("Lens Edu", &entries).await
    }

    async fn read(server: &Arc<Server>, path: &str, offset: Option<u64>) -> String {
        let sid = setup_session_no_reads(server);
        let mut args = json!({ "file_path": path, "session_id": sid });
        if let Some(offset) = offset {
            args["offset"] = json!(offset);
        }
        read::execute(server, &sid, &args).await.unwrap()
    }

    fn block(out: &str) -> &str {
        out.split_once(&format!("{BLOCK_END}\n\n"))
            .map_or("", |(b, _)| b)
    }

    #[tokio::test]
    async fn concept_read_starts_with_the_graph() {
        let server = server_with(&fixture()).await;
        let out = read(&server, "Lens Edu/Concepts/Trusted monitoring.md", None).await;
        assert!(
            out.starts_with(&format!("{BLOCK_START}\nParent concepts:\n")),
            "got: {out}"
        );
        let b = block(&out);
        assert!(
            b.contains(
                "Parent concepts:\n  - Lens Edu/Concepts/Low-stakes control.md (primary) — up: Lens Edu/Concepts/Control protocols.md › Lens Edu/Concepts/AI Control.md\n  - Lens Edu/Concepts/Monitoring and interpretability.md — top-level\n  - Lens Edu/Concepts/Control protocols.md — up: Lens Edu/Concepts/AI Control.md\n"
            ),
            "got: {b}"
        );
        assert!(
            b.contains("Parent not found: [[Missing concept]] (not a wikilink to a file in Lens Edu/Concepts)"),
            "got: {b}"
        );
        assert!(!b.contains("Child concepts"), "got: {b}");
        assert!(
            out.contains(&format!("{EDIT_HINT}\n{BLOCK_END}")),
            "got: {out}"
        );
        // The file's own lines are numbered as without the block.
        assert!(
            out.contains(&format!("{BLOCK_END}\n\n     1\t---\n")),
            "got: {out}"
        );
    }

    #[tokio::test]
    async fn children_are_backlinkers_that_name_it_as_parent_with_counts() {
        let server = server_with(&fixture()).await;
        let out = read(&server, "Lens Edu/Concepts/Control protocols.md", None).await;
        // Low-stakes links High-stakes in its text, which does not make it a child there.
        assert!(
            block(&out).contains(
                "Child concepts:\n  - Lens Edu/Concepts/High-stakes control.md\n  - Lens Edu/Concepts/Low-stakes control.md (+1 below)\n  - Lens Edu/Concepts/Trusted monitoring.md\n"
            ),
            "got: {out}"
        );
        let out = read(&server, "Lens Edu/Concepts/AI Control.md", None).await;
        let b = block(&out);
        assert!(
            b.contains("Parent concepts: none (top-level concept)\n"),
            "got: {b}"
        );
        assert!(
            b.contains("Child concepts:\n  - Lens Edu/Concepts/Control protocols.md (+3 below)\n"),
            "got: {b}"
        );
        // An article linking a concept is not its child.
        let out = read(&server, "Lens Edu/Concepts/Low-stakes control.md", None).await;
        assert!(
            block(&out).contains("Child concepts:\n  - Lens Edu/Concepts/Trusted monitoring.md\n"),
            "got: {out}"
        );
    }

    #[tokio::test]
    async fn only_unresolved_parents_is_not_top_level() {
        let server = server_with(&fixture()).await;
        let b = read(&server, "Lens Edu/Concepts/Only broken.md", None).await;
        assert!(
            b.contains("Parent concepts: none resolved\nParent not found: [[Nowhere]]"),
            "got: {b}"
        );
        assert!(!b.contains("top-level"), "got: {b}");
    }

    #[tokio::test]
    async fn cycle_is_shown_not_followed() {
        let server = server_with(&fixture()).await;
        let out = read(&server, "Lens Edu/Concepts/Cycle A.md", None).await;
        let b = block(&out);
        assert!(
            b.contains("A cycle runs through this file (invalid — a concept cannot be part of itself): Lens Edu/Concepts/Cycle A.md › Lens Edu/Concepts/Cycle B.md › Lens Edu/Concepts/Cycle A.md\n"),
            "got: {b}"
        );
        assert!(
            b.contains("  - Lens Edu/Concepts/Cycle B.md — up: Lens Edu/Concepts/Cycle A.md\n"),
            "got: {b}"
        );
    }

    #[tokio::test]
    async fn child_candidates_are_capped_with_a_note() {
        let mut files = vec![(
            "/Concepts/Hub.md".to_string(),
            c(100),
            "# Hub\n".to_string(),
        )];
        for i in 0..MAX_CHILD_CANDIDATES + 5 {
            files.push((
                format!("/Concepts/Spoke {i:03}.md"),
                c(200 + i as u32),
                fm(&["Hub"], "# Spoke\n"),
            ));
        }
        let server = server_with(&files).await;
        let out = read(&server, "Lens Edu/Concepts/Hub.md", None).await;
        let b = block(&out);
        assert!(
            b.contains(
                "(5 more concept file(s) link here but were not read; use get_links to list them.)"
            ),
            "got: {b}"
        );
        assert_eq!(
            b.matches("  - Lens Edu/Concepts/Spoke").count(),
            MAX_CHILD_CANDIDATES
        );
    }

    #[tokio::test]
    async fn only_first_chunk_and_only_concept_files() {
        let server = server_with(&fixture()).await;
        let out = read(&server, "Lens Edu/Concepts/Trusted monitoring.md", Some(3)).await;
        assert!(!out.contains(BLOCK_START), "got: {out}");
        let out = read(&server, "Lens Edu/articles/Some article.md", None).await;
        assert!(!out.contains(BLOCK_START), "got: {out}");
    }
}
