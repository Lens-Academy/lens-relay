/**
 * The concept map as a tree: every concept once, to the right of the one
 * concept it builds on most directly, joined to it by a square line. Read
 * like a table of contents: a concept, then what it opens up.
 *
 * A concept that requires several others hangs under one of them (the one
 * furthest along; of equals, one of its own topic); its other links are
 * quiet: drawn only while one of their ends is pointed at or selected. A
 * concept that requires nothing but has a "helpful first" hangs under that,
 * by a dashed line. What then has nothing above it starts a tree of its own.
 *
 * Pure: same concepts, links and heights, same drawing.
 */
import type { IdeaGraph, IdeaNode } from './idea-map';
import type { MapBox, MapEdge, MapLine, MapSizes } from './idea-map-layout';
import { boxGrid, cornered, gridColumns, joinParts, packRows, type MapPart } from './idea-map-layered';

/** Between a concept and the ones that hang under it: room for the line to turn. */
const BRANCH_GAP = 44;
/** Between two concepts that hang under the same one. */
const SIBLING_GAP = 10;
/** Between the families of two neighbours, so each family reads as one. */
const FAMILY_GAP = 22;
/** Between two trees. */
const TREE_GAP = 64;

export interface TreeParent {
  parent: string;
  /** The link it hangs by is a "helpful first". */
  helpful: boolean;
}

/**
 * For each concept, the one it hangs under in the tree; a concept with none
 * is the start of a tree. Never a circle: a concept does not hang under one
 * that already hangs (however far down) under it.
 */
export function treeParents(graph: IdeaGraph, edges: readonly MapEdge[]): Map<string, TreeParent> {
  const into = new Map<string, MapEdge[]>();
  for (const edge of edges) {
    if (edge.from === edge.to || !graph.byKey.has(edge.from) || !graph.byKey.has(edge.to)) continue;
    if (!into.has(edge.to)) into.set(edge.to, []);
    into.get(edge.to)!.push(edge);
  }
  const topic = (node: IdeaNode) => node.idea?.topic ?? '';
  const parents = new Map<string, TreeParent>();
  const under = (key: string, top: string) => {
    for (let at: string | undefined = key; at !== undefined; at = parents.get(at)?.parent) if (at === top) return true;
    return false;
  };
  // Step by step, so a concept's own place is known before anything hangs under it
  for (const node of [...graph.nodes].sort((p, q) => p.step - q.step)) {
    const links = into.get(node.key) ?? [];
    for (const helpful of [false, true]) {
      const best = links
        .filter((edge) => edge.helpful === helpful && !under(edge.from, node.key))
        .map((edge) => graph.byKey.get(edge.from)!)
        .sort((p, q) => q.step - p.step || Number(topic(q) === topic(node)) - Number(topic(p) === topic(node)) || p.name.localeCompare(q.name))[0];
      if (!best) continue;
      parents.set(node.key, { parent: best.key, helpful });
      break;
    }
  }
  return parents;
}

/** One tree, its top left corner at 0,0. */
function drawTree(root: string, children: ReadonlyMap<string, readonly string[]>, parents: ReadonlyMap<string, TreeParent>, heightOf: (key: string) => number, sizes: MapSizes): MapPart {
  const wide = sizes.nodeWidth;
  const kids = (key: string) => children.get(key) ?? [];
  /** The room above the i-th of `below`: more when it or the one above has a family of its own. */
  const gapBefore = (below: readonly string[], i: number) => (i === 0 ? 0 : kids(below[i]).length > 0 || kids(below[i - 1]).length > 0 ? FAMILY_GAP : Math.max(SIBLING_GAP, sizes.gapY));
  // How tall everything under and including a concept is
  const tall = new Map<string, number>();
  const measure = (key: string): number => {
    const below = kids(key);
    const stack = below.reduce((sum, kid, i) => sum + measure(kid) + gapBefore(below, i), 0);
    tall.set(key, Math.max(heightOf(key), stack));
    return tall.get(key)!;
  };
  measure(root);
  const boxes: MapBox[] = [];
  const lines: MapLine[] = [];
  let depth = 0;
  const place = (key: string, column: number, top: number) => {
    depth = Math.max(depth, column);
    const below = kids(key);
    const height = heightOf(key);
    const x = column * (wide + BRANCH_GAP);
    const room = tall.get(key)!;
    // Beside the middle of what hangs under it
    const y = top + (room - height) / 2;
    boxes.push({ key, column, x, y, height });
    const stack = below.reduce((sum, kid, i) => sum + tall.get(kid)! + gapBefore(below, i), 0);
    let at = top + (room - stack) / 2;
    below.forEach((kid, i) => {
      at += gapBefore(below, i);
      const kidY = at + (tall.get(kid)! - heightOf(kid)) / 2 + heightOf(kid) / 2;
      const turn = x + wide + BRANCH_GAP / 2 - 4;
      const from = y + height / 2;
      lines.push({
        from: key, to: kid, helpful: parents.get(kid)!.helpful,
        d: Math.abs(kidY - from) < 0.5
          ? cornered([[x + wide, from], [x + wide + BRANCH_GAP, from]])
          : cornered([[x + wide, from], [turn, from], [turn, kidY], [x + wide + BRANCH_GAP, kidY]]),
      });
      place(kid, column + 1, at);
      at += tall.get(kid)!;
    });
  };
  place(root, 0, 0);
  return { boxes, lines, width: (depth + 1) * (wide + BRANCH_GAP) - BRANCH_GAP, height: tall.get(root)! };
}

/**
 * The trees, biggest first, in rows; the concepts with nothing above or
 * under them in a block at the end. Returns the links of the tree as lines;
 * the other links are the caller's to draw.
 */
export function layoutTree(graph: IdeaGraph, edges: readonly MapEdge[], heightOf: (key: string) => number, sizes: MapSizes): MapPart & { parents: Map<string, TreeParent> } {
  const parents = treeParents(graph, edges);
  const children = new Map<string, string[]>();
  for (const node of graph.nodes) {
    const parent = parents.get(node.key)?.parent;
    if (parent === undefined) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push(node.key);
  }
  // How many concepts a concept has under it, itself included
  const size = new Map<string, number>();
  const count = (key: string): number => {
    const total = 1 + (children.get(key) ?? []).reduce((sum, kid) => sum + count(kid), 0);
    size.set(key, total);
    return total;
  };
  const roots = graph.nodes.filter((node) => !parents.has(node.key));
  roots.forEach((node) => count(node.key));
  for (const list of children.values()) {
    // Those with something under them first (biggest first), then the rest by name
    list.sort((p, q) => Number(size.get(q)! > 1) - Number(size.get(p)! > 1) || size.get(q)! - size.get(p)! || graph.byKey.get(p)!.name.localeCompare(graph.byKey.get(q)!.name));
  }
  const trees = roots.filter((node) => size.get(node.key)! > 1).sort((p, q) => size.get(q.key)! - size.get(p.key)! || p.name.localeCompare(q.name));
  const alone = roots.filter((node) => size.get(node.key) === 1).map((node) => node.key);
  const drawn = trees.map((node) => drawTree(node.key, children, parents, heightOf, sizes));

  const area = drawn.reduce((sum, part) => sum + (part.width + TREE_GAP) * (part.height + TREE_GAP), 0);
  const fits = (packed: { width: number; height: number }) => Math.min(16 / packed.width, 10 / packed.height);
  const packed = [1, 1.3, 1.6, 2, 2.5, 3.2]
    .map((ratio) => packColumns(drawn, Math.max(Math.max(0, ...drawn.map((part) => part.height)), Math.sqrt(area / ratio))))
    .reduce((best, next) => (fits(next) > fits(best) + 1e-9 ? next : best));
  const parts = [...drawn];
  const at = [...packed.at];
  let { width, height } = packed;
  if (alone.length > 0) {
    const mean = alone.reduce((sum, key) => sum + heightOf(key), 0) / alone.length;
    const perRow = drawn.length > 0 ? Math.max(1, Math.floor((width + sizes.gapY) / (sizes.nodeWidth + sizes.gapY))) : gridColumns(alone.length, mean, sizes);
    const grid = boxGrid(alone, heightOf, sizes, perRow);
    parts.push(grid);
    at.push({ x: 0, y: drawn.length > 0 ? height + TREE_GAP : 0 });
    width = Math.max(width, grid.width);
    height = (drawn.length > 0 ? height + TREE_GAP : 0) + grid.height;
  }
  return { ...joinParts(parts, at), width, height, parents };
}

/**
 * Where to put the trees: in columns from the left, each column filled from
 * the top down to `limit` tall, in the order given. (Trees are taller than
 * wide; stacked in columns they leave less of the page empty than in rows.)
 */
function packColumns(items: ReadonlyArray<{ width: number; height: number }>, limit: number): { at: Array<{ x: number; y: number }>; width: number; height: number } {
  const turned = packRows(items.map((item) => ({ width: item.height, height: item.width })), limit, TREE_GAP, TREE_GAP);
  return { at: turned.at.map((at) => ({ x: at.y, y: at.x })), width: turned.height, height: turned.width };
}
