/**
 * The concept graph: each concept file (`Lens Edu/Concepts/<name>.md`) names
 * its broader concepts in a `parent:` frontmatter list of wikilinks. The
 * first parent is the primary one. "Part of" goes upward only, and the graph
 * should be acyclic (a DAG); shortcut edges (A ⊂ B ⊂ D plus A ⊂ D) are fine.
 *
 *     ---
 *     parent:
 *       - "[[Control protocols]]"
 *       - "[[Monitoring and interpretability]]"
 *     ---
 *
 * This file holds the parsing and the graph walks, all pure; the panel is
 * `components/ConceptGraphPanel`. The relay's MCP `read` has the same rules
 * (`crates/relay/src/mcp/tools/concept_graph.rs`). Format and rules:
 * docs/concept-relationships.md, "Concept graph".
 *
 * Every walk is capped (MAX_DEPTH levels, MAX_NODES files) and stops at a
 * file already on its path, so cycles (invalid content) never hang it.
 */
import type { FolderMetadata } from '../hooks/useFolderMetadata';
import { resolvePageName } from './document-resolver';

/** Concept files: the opened file gets the graph header when it is in here. */
export const CONCEPTS_FOLDER = '/Lens Edu/Concepts/';
/** Levels followed upward (ancestors) or downward (descendants). */
export const MAX_DEPTH = 20;
/** Concept files visited by one walk, besides the opened one. */
export const MAX_NODES = 200;
/** Ancestor paths listed (main path included). */
export const MAX_PATHS = 50;

/** Whether the file at `path` (merged path) is a concept file. */
export function isConceptPath(path: string | undefined): boolean {
  return !!path && path.startsWith(CONCEPTS_FOLDER) && /\.md$/i.test(path);
}

/** One `parent:` entry: a wikilink page (`link`), or the raw text when the
 *  entry is not a single wikilink. */
export interface ParentEntry {
  raw: string;
  link: string | null;
}

const WIKILINK = /^\[\[([^[\]\n]+)\]\]$/;

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1).trim();
  }
  return v;
}

function entryOf(value: string): ParentEntry | null {
  const raw = unquote(value);
  if (!raw) return null;
  const m = WIKILINK.exec(raw);
  const link = m ? m[1].split('|')[0].split('#')[0].trim() : '';
  return { raw, link: link || null };
}

/**
 * The `parent:` entries of a file's frontmatter, in order. Accepted forms: a
 * block list (`- "[[A]]"`, quoted or not), one value (`parent: "[[A]]"`), or a
 * flow list (`parent: ["[[A]]", "[[B]]"]`). A frontmatter is a first line
 * `---` up to the next `---` line (trailing whitespace allowed). Line-based
 * on purpose, as in the relay, so the two agree on unquoted `- [[A]]`
 * (which a YAML parser would read as a nested list).
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
  for (let i = 1; i < end; i++) {
    const key = /^parent[ \t]*:(.*)$/.exec(lines[i]);
    if (!key) continue;
    const inline = key[1].replace(/[ \t]+#.*$/, '').trim();
    if (inline.startsWith('[') && !inline.startsWith('[[')) {
      // Flow list: commas inside [[...]] are not separators.
      const inner = inline.replace(/^\[/, '').replace(/\]$/, '');
      for (const part of inner.match(/"[^"]*"|'[^']*'|\[\[[^\]]*\]\]|[^,]+/g) ?? []) push(part);
    } else if (inline) {
      push(inline);
    }
    // Block list items: until the next key (a line at column 0 that is not `-`).
    for (let j = i + 1; j < end; j++) {
      const line = lines[j];
      if (!line.trim()) continue;
      const item = /^[ \t]*-[ \t]+(.*)$/.exec(line) ?? /^[ \t]*-()$/.exec(line);
      if (item) {
        push(item[1]);
        continue;
      }
      if (!/^[ \t]/.test(line)) break;
    }
    break; // the first `parent:` key counts
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
 *  resolves (lib/document-resolver), kept when it is a concept file. */
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

/** A concept file's parents (ids), or undefined while it is not read yet. */
export type ParentsOf = (id: string) => ResolvedParents | undefined;

export interface Ancestors {
  /** Main path: first parents followed upward, top-level concept first,
   *  the direct parent last (the opened file left out). */
  main: string[];
  /** Every other path from a top-level concept down to a direct parent. */
  others: string[][];
  /** More paths exist than MAX_PATHS. */
  pathsCut: boolean;
  /** Every ancestor found. */
  nodes: string[];
  /** A cycle through `parent:` links (ids in order, first repeated at the
   *  end), or null. Invalid content; shown, not followed. */
  cycle: string[] | null;
  /** A cap (depth or files) cut the walk. */
  cut: boolean;
  /** Files still to read to finish the walk. */
  pending: string[];
}

/**
 * Ancestors of `start`, read breadth-first through `parentsOf` within
 * MAX_DEPTH levels and MAX_NODES files.
 */
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
      if (d + 1 > MAX_DEPTH || depth.size > MAX_NODES) {
        cut = true;
        continue;
      }
      depth.set(p, d + 1);
      queue.push(p);
    }
  }
  const known = (id: string) => depth.has(id);
  const parents = (id: string) => (parentsOf(id)?.parents ?? []).filter(known);

  // Main path: first parents, stopping at a repeat (a cycle) or the cut.
  const main: string[] = [];
  const seen = new Set([start]);
  for (let cur = start; ;) {
    const first = parentsOf(cur)?.parents[0];
    if (!first || seen.has(first) || !known(first)) break;
    main.push(first);
    seen.add(first);
    cur = first;
  }
  main.reverse();

  // All simple paths upward, depth first, first parents first.
  const paths: string[][] = [];
  let pathsCut = false;
  let steps = 0;
  const stack: string[] = [start];
  const walk = (id: string) => {
    if (pathsCut) return;
    if (++steps > MAX_NODES * MAX_PATHS) {
      pathsCut = true;
      return;
    }
    const next = parents(id).filter((p) => !stack.includes(p));
    if (next.length === 0) {
      if (stack.length > 1) {
        if (paths.length >= MAX_PATHS) pathsCut = true;
        else paths.push(stack.slice(1).reverse());
      }
      return;
    }
    for (const p of next) {
      stack.push(p);
      walk(p);
      stack.pop();
    }
  };
  walk(start);
  const mainKey = main.join('\n');
  const others = paths.filter((p) => p.join('\n') !== mainKey);

  return {
    main,
    others,
    pathsCut,
    nodes: [...depth.keys()].filter((id) => id !== start),
    cycle: findCycle([...depth.keys()], parents),
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
  /** Concept files whose `parent:` resolves to the opened file. */
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

export interface TreeNode {
  id: string;
  children: TreeNode[];
  /** Placed (expanded) elsewhere in the tree, under another parent; not expanded again. */
  repeat?: boolean;
}

export interface Descendants {
  tree: TreeNode[];
  /** Distinct concepts below the opened file. */
  count: number;
  cut: boolean;
  /** Reached the opened file again (a cycle). */
  cycle: boolean;
  pending: string[];
}

/**
 * Everything below `start`, breadth-first over `candidatesOf` (backlinkers in
 * the concepts folder) filtered by `parentsOf`, within MAX_DEPTH levels and
 * MAX_NODES files. Each concept is expanded once, at its first (shallowest)
 * place; elsewhere it is a `repeat` leaf. Children sort by `nameOf`.
 */
export function buildDescendants(
  start: string,
  candidatesOf: (id: string) => readonly string[],
  parentsOf: ParentsOf,
  nameOf: (id: string) => string,
): Descendants {
  const out: Descendants = { tree: [], count: 0, cut: false, cycle: false, pending: [] };
  const placed = new Set<string>([start]);
  const byName = (a: string, b: string) => nameOf(a).localeCompare(nameOf(b));
  let level: Array<{ id: string; into: TreeNode[]; depth: number }> = [{ id: start, into: out.tree, depth: 0 }];
  while (level.length) {
    const next: typeof level = [];
    for (const { id, into, depth } of level) {
      const kids = childrenOf(id, candidatesOf(id), parentsOf);
      out.pending.push(...kids.pending);
      for (const kid of kids.ids.sort(byName)) {
        if (kid === start) {
          out.cycle = true;
          continue;
        }
        if (placed.has(kid)) {
          into.push({ id: kid, children: [], repeat: true });
          continue;
        }
        if (depth + 1 > MAX_DEPTH || placed.size > MAX_NODES) {
          out.cut = true;
          continue;
        }
        placed.add(kid);
        const node: TreeNode = { id: kid, children: [] };
        into.push(node);
        next.push({ id: kid, into: node.children, depth: depth + 1 });
      }
    }
    level = next;
  }
  out.count = placed.size - 1;
  return out;
}
