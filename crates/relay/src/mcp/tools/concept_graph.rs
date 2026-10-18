//! The concept graph in `read` output.
//!
//! Each concept file (`Lens Edu/Concepts/<name>.md`) names its broader
//! concepts in a `parent:` frontmatter list of wikilinks; the first is the
//! primary one. "Part of" goes upward only, and the graph should be a DAG
//! (shortcut edges are fine; cycles are invalid content, which the platform
//! validator reports):
//!
//! ```text
//! ---
//! parent:
//!   - "[[Control protocols]]"
//!   - "[[Monitoring and interpretability]]"
//! ---
//! ```
//!
//! An MCP `read` of a concept file starts (first chunk only) with a short
//! block: the main path upward (first parents), the other paths, the direct
//! parents and the direct children (concept files whose `parent:` resolves to
//! this one). The rules and caps are the editor's
//! (`lens-editor/src/lib/concept-graph.ts`); see
//! `docs/concept-relationships.md`, "Concept graph".

use super::concept_rows::{by_concept_name, file_name, is_md, load_text, resolver_entries};
use super::get_links;
use crate::server::Server;
use futures::StreamExt;
use regex::Regex;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, OnceLock};
use y_sweet_core::link_indexer::VirtualTreeIndex;

/// Resolver-path prefix of concept files.
const CONCEPTS_FOLDER: &str = "Lens Edu/Concepts/";
/// Levels followed upward.
const MAX_DEPTH: usize = 20;
/// Concept files visited by one walk (ancestors; children), besides the read one.
const MAX_NODES: usize = 200;
/// Ancestor paths enumerated (main path included).
const MAX_PATHS: usize = 50;
/// Other paths listed in the block.
const MAX_OTHER_PATHS_SHOWN: usize = 5;
/// Concept files loaded at once.
const LOAD_CONCURRENCY: usize = 4;

/// Whether the file at resolver path `path` is a concept file.
pub(crate) fn is_concept_path(path: &str) -> bool {
    path.starts_with(CONCEPTS_FOLDER) && is_md(path)
}

// ---------------------------------------------------------------------------
// Parsing (port of the editor's concept-graph.ts)
// ---------------------------------------------------------------------------

/// One `parent:` entry: the wikilink page (`link`), or None when the entry is
/// not a single wikilink (`raw` is then what was written).
#[derive(Debug, Clone, PartialEq)]
struct ParentEntry {
    raw: String,
    link: Option<String>,
}

fn regex(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).unwrap())
}

fn unquote(value: &str) -> &str {
    let v = value.trim();
    let quoted = v.len() >= 2
        && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')));
    if quoted {
        v[1..v.len() - 1].trim()
    } else {
        v
    }
}

fn entry_of(value: &str) -> Option<ParentEntry> {
    static WIKILINK: OnceLock<Regex> = OnceLock::new();
    let raw = unquote(value);
    if raw.is_empty() {
        return None;
    }
    let link = regex(&WIKILINK, r"^\[\[([^\[\]\n]+)\]\]$")
        .captures(raw)
        .map(|c| {
            let inner = c.get(1).unwrap().as_str();
            let page = inner.split('|').next().unwrap_or("");
            page.split('#').next().unwrap_or("").trim().to_string()
        })
        .filter(|l| !l.is_empty());
    Some(ParentEntry {
        raw: raw.to_string(),
        link,
    })
}

/// The `parent:` entries of a file's frontmatter, in order: a block list
/// (`- "[[A]]"`, quoted or not), one value, or a flow list
/// (`["[[A]]", "[[B]]"]`). Line-based, as in the editor.
fn parse_parents(text: &str) -> Vec<ParentEntry> {
    static DELIM: OnceLock<Regex> = OnceLock::new();
    static KEY: OnceLock<Regex> = OnceLock::new();
    static COMMENT: OnceLock<Regex> = OnceLock::new();
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
    let mut out = Vec::new();
    let mut push = |value: &str| {
        if let Some(entry) = entry_of(value) {
            out.push(entry);
        }
    };
    for i in 1..end {
        let Some(key) = regex(&KEY, r"^parent[ \t]*:(.*)$").captures(lines[i]) else {
            continue;
        };
        let inline = regex(&COMMENT, r"[ \t]+#.*$").replace(key.get(1).unwrap().as_str(), "");
        let inline = inline.trim();
        if inline.starts_with('[') && !inline.starts_with("[[") {
            let inner = inline.strip_prefix('[').unwrap_or(inline);
            let inner = inner.strip_suffix(']').unwrap_or(inner);
            for part in
                regex(&FLOW_PART, r#""[^"]*"|'[^']*'|\[\[[^\]]*\]\]|[^,]+"#).find_iter(inner)
            {
                push(part.as_str());
            }
        } else if !inline.is_empty() {
            push(inline);
        }
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
        break; // the first `parent:` key counts
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
/// like the link indexer resolves, kept when it is a concept file.
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
// Graph walks (pure; the editor's buildAncestors)
// ---------------------------------------------------------------------------

#[derive(Debug, Default, PartialEq)]
struct Ancestors {
    /// First parents followed upward, top-level concept first, the direct
    /// parent last (the read file left out).
    main: Vec<String>,
    /// Every other path from a top-level concept down to a direct parent.
    others: Vec<Vec<String>>,
    paths_cut: bool,
    nodes: Vec<String>,
    /// A cycle through `parent:` links, first id repeated at the end.
    cycle: Option<Vec<String>>,
    /// A cap (depth or files) cut the walk.
    cut: bool,
    /// Files still to load to finish the walk.
    pending: Vec<String>,
}

/// Ancestors of `start`, breadth-first through `parents_of` (None: not
/// loaded yet) within [`MAX_DEPTH`] levels and [`MAX_NODES`] files.
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
            if d + 1 > MAX_DEPTH || depth.len() > MAX_NODES {
                out.cut = true;
                continue;
            }
            depth.insert(p.clone(), d + 1);
            order.push(p.clone());
            queue.push_back(p.clone());
        }
    }
    let parents = |id: &str| -> Vec<String> {
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

    let mut seen: HashSet<String> = HashSet::from([start.to_string()]);
    let mut cur = start.to_string();
    while let Some(first) = parents_of(&cur).and_then(|i| i.parents.first()) {
        if seen.contains(first) || !depth.contains_key(first) {
            break;
        }
        out.main.push(first.clone());
        seen.insert(first.clone());
        cur = first.clone();
    }
    out.main.reverse();

    // All simple paths upward, depth first, first parents first.
    struct Walk<'p, F: Fn(&str) -> Vec<String>> {
        parents: &'p F,
        stack: Vec<String>,
        paths: Vec<Vec<String>>,
        cut: bool,
        steps: usize,
    }
    fn walk<F: Fn(&str) -> Vec<String>>(w: &mut Walk<'_, F>, id: &str) {
        if w.cut {
            return;
        }
        w.steps += 1;
        if w.steps > MAX_NODES * MAX_PATHS {
            w.cut = true;
            return;
        }
        let next: Vec<String> = (w.parents)(id)
            .into_iter()
            .filter(|p| !w.stack.contains(p))
            .collect();
        if next.is_empty() {
            if w.stack.len() > 1 {
                if w.paths.len() >= MAX_PATHS {
                    w.cut = true;
                } else {
                    w.paths.push(w.stack[1..].iter().rev().cloned().collect());
                }
            }
            return;
        }
        for p in next {
            w.stack.push(p.clone());
            walk(w, &p);
            w.stack.pop();
        }
    }
    let mut w = Walk {
        parents: &parents,
        stack: vec![start.to_string()],
        paths: Vec::new(),
        cut: false,
        steps: 0,
    };
    walk(&mut w, start);
    out.paths_cut = w.cut;
    out.others = w.paths.into_iter().filter(|p| *p != out.main).collect();
    out.cycle = find_cycle(&order, &parents);
    out.nodes = order.into_iter().filter(|id| id != start).collect();
    out
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

// ---------------------------------------------------------------------------
// Loading and rendering
// ---------------------------------------------------------------------------

const BLOCK_START: &str = "── Concept graph (context — NOT part of this file's text) ──";
const BLOCK_END: &str = "── end of concept graph ──";
const PREAMBLE: &str = "Broader concepts are this file's `parent:` frontmatter (wikilinks; the first is the main one), and \"part of\" goes upward only. Line numbers below the end marker are this file's own.";

/// Loads concept files and resolves their parents, each once per `read`.
struct GraphLoader<'a> {
    server: &'a Arc<Server>,
    index: &'a VirtualTreeIndex<'a>,
    parents: HashMap<String, ResolvedParents>,
    failed: usize,
}

impl GraphLoader<'_> {
    async fn load(&mut self, ids: &[String]) {
        let server = self.server;
        let wanted: Vec<(String, Option<String>)> = ids
            .iter()
            .filter(|id| !self.parents.contains_key(*id))
            .map(|id| (id.clone(), server.doc_resolver().path_for_uuid(id)))
            .collect();
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

/// Resolver path of `id`, or the id itself.
fn path_of(server: &Arc<Server>, id: &str) -> String {
    server
        .doc_resolver()
        .path_for_uuid(id)
        .unwrap_or_else(|| id.to_string())
}

/// `Lens Edu/Concepts/AI Control.md` → `…/AI Control.md` after the first.
fn render_path(server: &Arc<Server>, path: &[String]) -> String {
    let mut parts: Vec<String> = path
        .iter()
        .enumerate()
        .map(|(i, id)| {
            let p = path_of(server, id);
            match p.strip_prefix(CONCEPTS_FOLDER) {
                Some(rest) if i > 0 => format!("…/{rest}"),
                _ => p,
            }
        })
        .collect();
    parts.push("this".to_string());
    parts.join(" › ")
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
        failed: 0,
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

    // Children: backlinkers in the concepts folder that name this file in `parent:`.
    let mut candidates: Vec<String> = get_links::read_backlink_uuids(server, folder_doc_id, uuid)
        .await
        .into_iter()
        .filter(|id| id != uuid)
        .filter(|id| {
            server
                .doc_resolver()
                .path_for_uuid(id)
                .is_some_and(|p| is_concept_path(&p))
        })
        .collect();
    candidates.sort();
    candidates.dedup();
    let candidates_over_cap = candidates.len().saturating_sub(MAX_NODES);
    candidates.truncate(MAX_NODES);
    loader.load(&candidates).await;
    let mut children: Vec<String> = candidates
        .iter()
        .filter(|c| {
            loader
                .parents
                .get(*c)
                .is_some_and(|p| p.parents.iter().any(|x| x == uuid))
        })
        .map(|c| path_of(server, c))
        .collect();
    children.sort_by(|a, b| by_concept_name(&file_name(a), &file_name(b)));

    let mut out = String::new();
    if own.parents.is_empty() {
        out.push_str("Part of: nothing — a top-level concept (no `parent:` entries).\n");
    } else {
        out.push_str(&format!(
            "Part of (main path): {}{}\n",
            render_path(server, &ancestors.main),
            if ancestors.cut { " (… cut)" } else { "" }
        ));
    }
    if !ancestors.others.is_empty() {
        out.push_str("Other paths:\n");
        for p in ancestors.others.iter().take(MAX_OTHER_PATHS_SHOWN) {
            out.push_str(&format!("  {}\n", render_path(server, p)));
        }
        let more = ancestors.others.len().saturating_sub(MAX_OTHER_PATHS_SHOWN);
        if more > 0 || ancestors.paths_cut {
            out.push_str(&format!(
                "  (+{more}{} more)\n",
                if ancestors.paths_cut { "+" } else { "" }
            ));
        }
    }
    if !own.parents.is_empty() {
        let parents: Vec<String> = own.parents.iter().map(|id| path_of(server, id)).collect();
        out.push_str(&format!(
            "Direct parents: {} (edit them in this file's `parent:` frontmatter)\n",
            parents.join(", ")
        ));
    }
    if !own.unresolved.is_empty() {
        let quoted: Vec<String> = own.unresolved.iter().map(|r| format!("\"{r}\"")).collect();
        out.push_str(&format!(
            "Unresolved `parent:` entries (not a wikilink to a file in {}): {}\n",
            CONCEPTS_FOLDER.trim_end_matches('/'),
            quoted.join(", ")
        ));
    }
    if children.is_empty() {
        out.push_str("Direct children: none\n");
    } else {
        out.push_str(&format!(
            "Direct children: {} (each child lists this file in its own `parent:`)\n",
            children.join(", ")
        ));
    }
    if candidates_over_cap > 0 {
        out.push_str(&format!(
            "({candidates_over_cap} more concept file(s) link here but were not read; use get_links to list them.)\n"
        ));
    }
    if let Some(cycle) = &ancestors.cycle {
        let names: Vec<String> = cycle.iter().map(|id| path_of(server, id)).collect();
        out.push_str(&format!(
            "Cycle in `parent:` links (invalid — a concept cannot be part of itself): {}\n",
            names.join(" › ")
        ));
    }
    if ancestors.cut {
        out.push_str(&format!(
            "(Walk cut at {MAX_DEPTH} levels or {MAX_NODES} concept files.)\n"
        ));
    }
    if loader.failed > 0 {
        out.push_str(&format!(
            "({} concept file(s) could not be read.)\n",
            loader.failed
        ));
    }
    Some(format!("{BLOCK_START}\n{PREAMBLE}\n{out}{BLOCK_END}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn links(text: &str) -> Vec<Option<String>> {
        parse_parents(text).into_iter().map(|e| e.link).collect()
    }

    fn some(v: &[&str]) -> Vec<Option<String>> {
        v.iter().map(|s| Some(s.to_string())).collect()
    }

    #[test]
    fn parses_block_list_quoted_or_not() {
        let text =
            "---\nparent:\n  - \"[[A]]\"\n  - [[B|alias]]\n  - '[[../Concepts/C#x]]'\n---\n# T\n";
        assert_eq!(links(text), some(&["A", "B", "../Concepts/C"]));
    }

    #[test]
    fn parses_single_value_and_flow_list() {
        assert_eq!(links("---\nparent: \"[[A]]\"\n---\n"), some(&["A"]));
        assert_eq!(links("---\nparent: [[A]]\n---\n"), some(&["A"]));
        assert_eq!(
            links("---\nparent: [\"[[A]]\", \"[[B]]\"]\n---\n"),
            some(&["A", "B"])
        );
    }

    #[test]
    fn stops_at_next_key_and_keeps_non_links_raw() {
        let text = "---\ntitle: x\nparent:\n- \"[[A]]\"\n- Effective altruism\nskill-tree: topic\ntags:\n  - \"[[Not a parent]]\"\n---\n";
        assert_eq!(
            parse_parents(text),
            vec![
                ParentEntry {
                    raw: "[[A]]".into(),
                    link: Some("A".into())
                },
                ParentEntry {
                    raw: "Effective altruism".into(),
                    link: None
                },
            ]
        );
    }

    #[test]
    fn only_frontmatter_counts() {
        assert!(parse_parents("# T\nparent: \"[[A]]\"\n").is_empty());
        assert!(parse_parents("---\nparent: \"[[A]]\"\n").is_empty());
        assert_eq!(
            links("---\r\nparent:\r\n  - \"[[A]]\"\r\n---  \r\nx"),
            some(&["A"])
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
    fn multiple_parents_main_path_and_other_paths() {
        let g = graph(&[
            ("tm", &["low", "mon"]),
            ("low", &["protocols"]),
            ("protocols", &["control"]),
        ]);
        let a = ancestors("tm", &g);
        assert_eq!(a.main, ids(&["control", "protocols", "low"]));
        assert_eq!(a.others, vec![ids(&["mon"])]);
        assert_eq!(a.cycle, None);
        assert!(!a.cut);
    }

    #[test]
    fn shortcut_edge_is_a_second_path() {
        let g = graph(&[("A", &["B", "D"]), ("B", &["D"])]);
        let a = ancestors("A", &g);
        assert_eq!(a.main, ids(&["D", "B"]));
        assert_eq!(a.others, vec![ids(&["D"])]);
        assert_eq!(a.cycle, None);
    }

    #[test]
    fn cycles_are_reported_and_never_hang() {
        let g = graph(&[("A", &["B"]), ("B", &["C"]), ("C", &["A"])]);
        let a = ancestors("A", &g);
        assert_eq!(a.main, ids(&["C", "B"]));
        assert_eq!(a.cycle, Some(ids(&["A", "B", "C", "A"])));

        let g = graph(&[("A", &["A", "B"])]);
        let a = ancestors("A", &g);
        assert_eq!(a.main, Vec::<String>::new());
        assert_eq!(a.cycle, Some(ids(&["A", "A"])));
    }

    #[test]
    fn caps_depth_and_files() {
        let chain: Vec<(String, Vec<String>)> = (0..30)
            .map(|i| (format!("n{i}"), vec![format!("n{}", i + 1)]))
            .collect();
        let g: HashMap<String, ResolvedParents> = chain
            .into_iter()
            .map(|(id, ps)| {
                (
                    id,
                    ResolvedParents {
                        parents: ps,
                        unresolved: vec![],
                    },
                )
            })
            .collect();
        let a = ancestors("n0", &g);
        assert!(a.cut);
        assert_eq!(a.main.len(), MAX_DEPTH);

        let wide: Vec<String> = (0..MAX_NODES + 50).map(|i| format!("p{i}")).collect();
        let g = HashMap::from([(
            "A".to_string(),
            ResolvedParents {
                parents: wide,
                unresolved: vec![],
            },
        )]);
        let a = ancestors("A", &g);
        assert!(a.cut);
        assert!(a.nodes.len() <= MAX_NODES);
        assert!(a.paths_cut);
    }

    #[test]
    fn unloaded_files_are_pending() {
        let g = graph(&[("A", &["B"])]);
        let a = build_ancestors("A", |id| g.get(id));
        assert_eq!(a.pending, ids(&["B"]));
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
        let mut s = String::from("---\nparent:\n");
        for p in parents {
            s.push_str(&format!("  - \"[[{p}]]\"\n"));
        }
        s.push_str("---\n");
        s.push_str(body);
        s
    }

    fn fixture() -> Vec<(String, String, String)> {
        let c = |n: u32| format!("c0000000-0000-4000-8000-0000000000{n:02}");
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
                "/articles/Some article.md".into(),
                "a0000000-0000-4000-8000-000000000001".into(),
                "# Art\n\n[[../Concepts/Low-stakes control]]\n".into(),
            ),
        ]
    }

    async fn server() -> Arc<Server> {
        let files = fixture();
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
        let server = server().await;
        let out = read(&server, "Lens Edu/Concepts/Trusted monitoring.md", None).await;
        assert!(
            out.starts_with(&format!("{BLOCK_START}\n{PREAMBLE}\n")),
            "got: {out}"
        );
        let b = block(&out);
        assert!(
            b.contains("Part of (main path): Lens Edu/Concepts/AI Control.md › …/Control protocols.md › …/Low-stakes control.md › this\n"),
            "got: {b}"
        );
        // The second parent (top-level) and the shortcut to Control protocols.
        assert!(b.contains("Other paths:\n  Lens Edu/Concepts/Monitoring and interpretability.md › this\n  Lens Edu/Concepts/AI Control.md › …/Control protocols.md › this\n"), "got: {b}");
        assert!(b.contains("Direct parents: Lens Edu/Concepts/Low-stakes control.md, Lens Edu/Concepts/Monitoring and interpretability.md, Lens Edu/Concepts/Control protocols.md (edit them"), "got: {b}");
        assert!(b.contains("Unresolved `parent:` entries (not a wikilink to a file in Lens Edu/Concepts): \"[[Missing concept]]\""), "got: {b}");
        assert!(b.contains("Direct children: none\n"));
        assert!(b.ends_with(BLOCK_END) || out.contains(&format!("{BLOCK_END}\n\n     1\t---")));
        // The file's own lines are numbered as without the block.
        assert!(
            out.contains(&format!("{BLOCK_END}\n\n     1\t---\n")),
            "got: {out}"
        );
    }

    #[tokio::test]
    async fn children_are_backlinkers_that_name_it_as_parent() {
        let server = server().await;
        let out = read(&server, "Lens Edu/Concepts/Control protocols.md", None).await;
        let b = block(&out);
        // Sorted by name; Low-stakes links High-stakes in its text, which does not make it a child there.
        assert!(
            b.contains("Direct children: Lens Edu/Concepts/High-stakes control.md, Lens Edu/Concepts/Low-stakes control.md, Lens Edu/Concepts/Trusted monitoring.md (each child"),
            "got: {b}"
        );
        let out = read(&server, "Lens Edu/Concepts/High-stakes control.md", None).await;
        assert!(
            block(&out).contains("Direct children: none\n"),
            "got: {out}"
        );
        // An article linking a concept is not its child.
        let out = read(&server, "Lens Edu/Concepts/Low-stakes control.md", None).await;
        assert!(
            block(&out).contains("Direct children: Lens Edu/Concepts/Trusted monitoring.md ("),
            "got: {out}"
        );
    }

    #[tokio::test]
    async fn top_level_concept() {
        let server = server().await;
        let out = read(&server, "Lens Edu/Concepts/AI Control.md", None).await;
        let b = block(&out);
        assert!(
            b.contains("Part of: nothing — a top-level concept"),
            "got: {b}"
        );
        assert!(!b.contains("Direct parents"));
        assert!(b.contains("Direct children: Lens Edu/Concepts/Control protocols.md ("));
    }

    #[tokio::test]
    async fn cycle_is_shown_not_followed() {
        let server = server().await;
        let out = read(&server, "Lens Edu/Concepts/Cycle A.md", None).await;
        let b = block(&out);
        assert!(b.contains("Cycle in `parent:` links (invalid"), "got: {b}");
        assert!(b.contains("Lens Edu/Concepts/Cycle A.md › Lens Edu/Concepts/Cycle B.md › Lens Edu/Concepts/Cycle A.md"), "got: {b}");
        assert!(
            b.contains("Part of (main path): Lens Edu/Concepts/Cycle B.md › this\n"),
            "got: {b}"
        );
    }

    #[tokio::test]
    async fn only_first_chunk_and_only_concept_files() {
        let server = server().await;
        let out = read(&server, "Lens Edu/Concepts/Trusted monitoring.md", Some(3)).await;
        assert!(!out.contains(BLOCK_START), "got: {out}");
        let out = read(&server, "Lens Edu/articles/Some article.md", None).await;
        assert!(!out.contains(BLOCK_START), "got: {out}");
    }
}
