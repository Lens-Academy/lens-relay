/**
 * The concept graph: each concept file (`Lens Edu/Concepts/<name>.md`) names
 * its broader concepts in a `parent-concepts:` frontmatter list of wikilinks.
 * The first is the primary one. "Part of" goes upward only, and the graph
 * should be acyclic (a DAG); shortcut edges (A ⊂ B ⊂ D plus A ⊂ D) are fine.
 *
 *     ---
 *     parent-concepts:
 *       - "[[Control protocols]]"
 *       - "[[Monitoring and interpretability]]"
 *     ---
 *
 * This file holds the parsing and the graph walks, all pure; the header is
 * `components/ConceptGraphPanel`. The relay's MCP `read` follows the same
 * rules (`crates/relay/src/mcp/tools/concept_graph.rs`); both have one test
 * per "concept graph rules v1 #N". Format and rules:
 * docs/concept-relationships.md, "Concept graph".
 *
 * Every walk is capped (MAX_DEPTH levels, MAX_NODES files) and never visits a
 * file twice, so cycles (invalid content) never hang it.
 */
import type { FolderMetadata } from '../hooks/useFolderMetadata';
import { resolvePageName } from './document-resolver';

/** Concept files: the opened file gets the graph header when it is in here. */
export const CONCEPTS_FOLDER = '/Lens Edu/Concepts/';
/** The frontmatter key that lists a concept's parents. */
export const PARENTS_KEY = 'parent-concepts';
/** Levels followed upward (ancestors) or downward (descendants). */
export const MAX_DEPTH = 20;
/** Concept files visited by the walk below (for "+N" counts), besides the opened one. */
export const MAX_NODES = 200;
/** Ancestors walked and drawn. */
export const MAX_ANCESTORS = 30;
/** Children drawn (the lists show them all). */
export const MAX_CHILDREN_DRAWN = 20;

/** Whether the file at `path` (merged path) is a concept file. */
export function isConceptPath(path: string | undefined): boolean {
  return !!path && path.startsWith(CONCEPTS_FOLDER) && /\.md$/i.test(path);
}

/** One parent entry: a wikilink page (`link`), or the raw text when the
 *  entry is not a single wikilink. */
export interface ParentEntry {
  raw: string;
  link: string | null;
}

const WIKILINK = /^\[\[([^[\]\n]+)\]\]$/;

/** A value with a trailing YAML comment (whitespace, then `#`) removed and
 *  its quotes taken off (rules #4, #5). A `#` inside quotes is kept. */
function scalar(value: string): string {
  const v = value.trim();
  if (v[0] === '"' || v[0] === "'") {
    const close = v.indexOf(v[0], 1);
    if (close > 0) return v.slice(1, close).trim();
  }
  return v.replace(/[ \t]+#.*$/, '').trim();
}

function entryOf(value: string): ParentEntry | null {
  const raw = scalar(value);
  if (!raw) return null;
  const m = WIKILINK.exec(raw);
  const link = m ? m[1].split('|')[0].split('#')[0].trim() : '';
  return { raw, link: link || null };
}

/**
 * The `parent-concepts:` entries of a file's frontmatter, in order, by the
 * concept graph rules v1 (docs/concept-relationships.md): a block list
 * (#1), one value (#2) or a flow list (#3); quoted or unquoted `[[X]]`
 * (#4, so unquoted `- [[A]]`, which YAML reads as a nested list, counts);
 * trailing comments (#5); only the frontmatter and its first such key (#6).
 * Line-based on purpose, so the editor and the relay agree.
 */
export function parseParents(text: string): ParentEntry[] {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  if (!/^---[ \t]*$/.test(lines[0] ?? '')) return [];
  const end = lines.findIndex((l, i) => i > 0 && /^---[ \t]*$/.test(l));
  if (end === -1) return [];
  const out: ParentEntry[] = [];
  const push = (value: string) => {
    const entry = entryOf(value);
    if (entry) out.push(entry);
  };
  const key = new RegExp(`^${PARENTS_KEY}[ \\t]*:(.*)$`);
  for (let i = 1; i < end; i++) {
    const m = key.exec(lines[i]);
    if (!m) continue;
    const inline = m[1].trim();
    if (inline.startsWith('[') && !inline.startsWith('[[')) {
      // Flow list (#3): up to its closing `]`; commas inside [[...]] or quotes do not split.
      const inner = inline.slice(1, inline.lastIndexOf(']') > 0 ? inline.lastIndexOf(']') : undefined);
      for (const part of inner.match(/"[^"]*"|'[^']*'|\[\[[^\]]*\]\]|[^,]+/g) ?? []) push(part);
    } else if (inline && !inline.startsWith('#')) {
      push(inline);
    }
    // Block list items (#1): until the next key (a line at column 0 that is not `-`).
    for (let j = i + 1; j < end; j++) {
      const line = lines[j];
      if (!line.trim()) continue;
      const item = /^[ \t]*-(?:[ \t]+(.*))?$/.exec(line);
      if (item) {
        push(item[1] ?? '');
        continue;
      }
      if (!/^[ \t]/.test(line)) break;
    }
    break; // only the first key counts (#6)
  }
  return out;
}

/** A concept file's parents, resolved to concept files (ids, in order,
 *  without repeats), and the entries that do not resolve to one. */
export interface ResolvedParents {
  parents: string[];
  unresolved: string[];
}

/** `parseParents`, each link resolved from `path` like the link indexer
 *  resolves (#7: relative to the file, then from the folder root,
 *  case-insensitive), kept when it is a concept file. */
export function resolveParents(text: string, path: string, metadata: FolderMetadata): ResolvedParents {
  const out: ResolvedParents = { parents: [], unresolved: [] };
  for (const entry of parseParents(text)) {
    const resolved = entry.link ? resolvePageName(entry.link, metadata, path) : null;
    if (!resolved || !isConceptPath(resolved.path)) {
      out.unresolved.push(entry.raw);
      continue;
    }
    if (!out.parents.includes(resolved.docId)) out.parents.push(resolved.docId);
  }
  return out;
}

/** Equal parent lists (the graph recomputes only when they change). */
export function sameParents(a: ResolvedParents, b: ResolvedParents): boolean {
  return a.parents.join('\n') === b.parents.join('\n') && a.unresolved.join('\n') === b.unresolved.join('\n');
}

/** A concept file's parents (ids), or undefined while it is not read yet. */
export type ParentsOf = (id: string) => ResolvedParents | undefined;

/** First parents followed upward from `start`, top-level concept first, the
 *  direct parent last (`start` left out); stops at a repeat or at a file
 *  `allowed` rejects. */
export function mainPath(start: string, parentsOf: ParentsOf, allowed: (id: string) => boolean = () => true): string[] {
  const path: string[] = [];
  const seen = new Set([start]);
  for (let cur = start; path.length < MAX_DEPTH;) {
    const first = parentsOf(cur)?.parents[0];
    if (!first || seen.has(first) || !allowed(first)) break;
    path.push(first);
    seen.add(first);
    cur = first;
  }
  return path.reverse();
}

export interface Ancestors {
  /** Main path: see `mainPath`. */
  main: string[];
  /** Every ancestor found. */
  nodes: string[];
  /** A cycle through parent links (ids in order, first repeated at the end),
   *  or null. Invalid content; shown, not followed. */
  cycle: string[] | null;
  /** A cap (depth or files) cut the walk. */
  cut: boolean;
  /** Files still to read to finish the walk. */
  pending: string[];
}

/** Ancestors of `start`, read breadth-first through `parentsOf` within
 *  MAX_DEPTH levels and MAX_ANCESTORS files. */
export function buildAncestors(start: string, parentsOf: ParentsOf): Ancestors {
  const depth = new Map<string, number>([[start, 0]]);
  const queue = [start];
  const pending: string[] = [];
  let cut = false;
  while (queue.length) {
    const id = queue.shift()!;
    const info = parentsOf(id);
    if (!info) {
      pending.push(id);
      continue;
    }
    const d = depth.get(id)!;
    for (const p of info.parents) {
      if (depth.has(p)) continue;
      if (d + 1 > MAX_DEPTH || depth.size > MAX_ANCESTORS) {
        cut = true;
        continue;
      }
      depth.set(p, d + 1);
      queue.push(p);
    }
  }
  const known = (id: string) => depth.has(id);
  return {
    main: mainPath(start, parentsOf, known),
    nodes: [...depth.keys()].filter((id) => id !== start),
    cycle: findCycle([...depth.keys()], (id) => (parentsOf(id)?.parents ?? []).filter(known)),
    cut,
    pending,
  };
}

/** A cycle among `nodes` through `next`, as ids with the first repeated at
 *  the end, or null. */
export function findCycle(nodes: readonly string[], next: (id: string) => readonly string[]): string[] | null {
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, 'open');
    stack.push(id);
    for (const n of next(id)) {
      if (state.get(n) === 'open') return [...stack.slice(stack.indexOf(n)), n];
      if (!state.has(n)) {
        const found = visit(n);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };
  for (const id of nodes) {
    if (state.has(id)) continue;
    const found = visit(id);
    if (found) return found;
  }
  return null;
}

export interface Children {
  /** Concept files whose parents include the file. */
  ids: string[];
  /** Candidates not read yet. */
  pending: string[];
}

/**
 * The children of `id` among `candidates` (its backlinkers in the concepts
 * folder): those whose parents include it. A link elsewhere in a file (a
 * row, the text) does not make it a child.
 */
export function childrenOf(id: string, candidates: readonly string[], parentsOf: ParentsOf): Children {
  const out: Children = { ids: [], pending: [] };
  for (const c of candidates) {
    if (c === id) continue;
    const info = parentsOf(c);
    if (!info) out.pending.push(c);
    else if (info.parents.includes(id)) out.ids.push(c);
  }
  return out;
}

export interface Below {
  /** Children (sorted by name) of every concept the walk expanded. */
  kids: Map<string, string[]>;
  /** A cap (depth or files) cut the walk. */
  cut: boolean;
  /** Reached the opened file again (a cycle through it). */
  cycle: boolean;
  /** Files still to read. */
  pending: string[];
}

/**
 * Everything below `start`, breadth-first over `candidatesOf` (backlinkers in
 * the concepts folder) filtered by `parentsOf`, within MAX_DEPTH levels and
 * MAX_NODES files. Each concept is expanded once.
 */
export function walkBelow(
  start: string,
  candidatesOf: (id: string) => readonly string[],
  parentsOf: ParentsOf,
  nameOf: (id: string) => string,
): Below {
  const out: Below = { kids: new Map(), cut: false, cycle: false, pending: [] };
  const depth = new Map<string, number>([[start, 0]]);
  const queue = [start];
  while (queue.length) {
    const id = queue.shift()!;
    const found = childrenOf(id, candidatesOf(id), parentsOf);
    out.pending.push(...found.pending);
    const kids = found.ids.filter((k) => {
      if (k === start) out.cycle = true;
      return k !== start;
    });
    kids.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    out.kids.set(id, kids);
    for (const k of kids) {
      if (depth.has(k)) continue;
      if (depth.get(id)! + 1 > MAX_DEPTH || depth.size > MAX_NODES) {
        out.cut = true;
        continue;
      }
      depth.set(k, depth.get(id)! + 1);
      queue.push(k);
    }
  }
  return out;
}

/** Distinct concepts below `id` in `kids` (the opened file `start` left out);
 *  `cut` when the walk did not expand all of them. */
export function countBelow(id: string, kids: ReadonlyMap<string, readonly string[]>, start: string): { count: number; cut: boolean } {
  const seen = new Set<string>([id, start]);
  const queue = [id];
  let cut = false;
  while (queue.length) {
    const cur = queue.shift()!;
    const next = kids.get(cur);
    if (!next) {
      if (cur !== id) cut = true;
      continue;
    }
    for (const k of next) {
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push(k);
    }
  }
  return { count: seen.size - (id === start ? 1 : 2), cut };
}

/** A node of the drawn graph. */
export interface GraphNode {
  id: string;
  kind: 'ancestor' | 'self' | 'child' | 'more';
  /** Distinct concepts below a child (`countBelow`), for its "+N". */
  count?: number;
  countCut?: boolean;
  /** For the 'more' node: children not drawn. */
  more?: number;
}

/** An edge, from the broader concept to the narrower one. */
export interface GraphEdge {
  from: string;
  to: string;
}

export const MORE_NODE = 'more-children';

/**
 * What the header draws: every ancestor found and the edges between them (all
 * parent links, so several parents and shortcut edges show), the opened
 * concept, and its direct children (at most MAX_CHILDREN_DRAWN, then a "more"
 * node). A cycle is drawn as far as the edges go; the layout breaks it.
 */
export function graphData(
  start: string,
  ancestors: Ancestors,
  parentsOf: ParentsOf,
  below: Below,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const up = new Set([start, ...ancestors.nodes]);
  const nodes: GraphNode[] = ancestors.nodes.map((id) => ({ id, kind: 'ancestor' as const }));
  nodes.push({ id: start, kind: 'self' });
  const edges: GraphEdge[] = [];
  for (const id of up) {
    for (const p of parentsOf(id)?.parents ?? []) if (up.has(p)) edges.push({ from: p, to: id });
  }
  const kids = (below.kids.get(start) ?? []).filter((k) => !up.has(k));
  for (const k of kids.slice(0, MAX_CHILDREN_DRAWN)) {
    const { count, cut } = countBelow(k, below.kids, start);
    nodes.push({ id: k, kind: 'child', count, countCut: cut || below.cut });
    edges.push({ from: start, to: k });
  }
  if (kids.length > MAX_CHILDREN_DRAWN) {
    nodes.push({ id: MORE_NODE, kind: 'more', more: kids.length - MAX_CHILDREN_DRAWN });
    edges.push({ from: start, to: MORE_NODE });
  }
  return { nodes, edges };
}
